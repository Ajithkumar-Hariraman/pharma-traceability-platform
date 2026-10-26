const { test } = require('node:test');
const { Buffer } = require('node:buffer');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const { spawn } = require('node:child_process');
const {
  ConfigService,
} = require('../services/traceability-service/node_modules/@nestjs/config');
const {
  PrismaService,
} = require('../services/traceability-service/dist/persistence/prisma.service');
const {
  TraceService,
} = require('../services/traceability-service/dist/trace.service');
const {
  TraceGuard,
} = require('../services/traceability-service/dist/trace.guard');
const {
  traceCapturePayload,
  productIdentityPayload,
} = require('../packages/contracts/dist');
const env = parseEnv(
  readFileSync('services/traceability-service/.env', 'utf8'),
);
const org = randomUUID(),
  serial = randomUUID(),
  batch = randomUUID(),
  aggregate = randomUUID(),
  child = randomUUID();
function object(overrides = {}) {
  return {
    organizationId: org,
    eventId: randomUUID(),
    eventType: 'OBJECT',
    action: 'ADD',
    businessStep: 'commissioning',
    eventTime: '2026-10-01T01:00:00.000Z',
    serializedItemId: serial,
    batchId: batch,
    productId: randomUUID(),
    gtinId: randomUUID(),
    ...overrides,
  };
}
function context(req) {
  return { switchToHttp: () => ({ getRequest: () => req }) };
}
async function rejectsStatus(promise, status) {
  await assert.rejects(promise, (e) => e.getStatus() === status);
}
test('trace capture and query use PostgreSQL: idempotency, immutability, tenant isolation, timelines and filters', async (t) => {
  const db = new PrismaService(new ConfigService(env));
  await db.onModuleInit();
  t.after(() => db.onModuleDestroy());
  const service = new TraceService(db);
  const event = object({ metadata: { b: 2, a: { y: 2, x: 1 } } });
  const first = await service.capture(org, event, 'serialization-service');
  await t.test('commission trace event', () =>
    assert.equal(first.businessStep, 'commissioning'),
  );
  await t.test(
    'duplicate eventId is idempotent with canonical metadata',
    async () => {
      const repeated = await service.capture(
        org,
        { ...event, metadata: { a: { x: 1, y: 2 }, b: 2 } },
        'serialization-service',
      );
      assert.equal(first.id, repeated.id);
    },
  );
  await t.test('conflicting duplicate rejected', () =>
    rejectsStatus(
      service.capture(
        org,
        { ...event, action: 'DELETE' },
        'serialization-service',
      ),
      409,
    ),
  );
  for (const [name, action, step] of [
    ['quarantine', 'OBSERVE', 'holding'],
    ['decommission', 'DELETE', 'decommissioning'],
  ])
    await t.test(`${name} trace event`, async () => {
      const result = await service.capture(
        org,
        object({
          action,
          businessStep: step,
          eventTime: `2026-10-0${action === 'OBSERVE' ? 2 : 3}T01:00:00.000Z`,
        }),
        'serialization-service',
      );
      assert.equal(result.action, action);
    });
  for (const type of ['item', 'container'])
    for (const action of ['ADD', 'DELETE'])
      await t.test(
        `${type} ${action === 'ADD' ? 'aggregation' : 'disaggregation'} event`,
        async () => {
          const input = {
            organizationId: org,
            eventId: randomUUID(),
            eventType: 'AGGREGATION',
            action,
            eventTime: '2026-10-04T01:00:00.000Z',
            aggregateContainerId: aggregate,
            ...(type === 'item'
              ? {
                  serializedItemId: serial,
                  batchId: batch,
                  productId: randomUUID(),
                  gtinId: randomUUID(),
                }
              : { childContainerId: child }),
          };
          assert.equal(
            (await service.capture(org, input, 'aggregation-service')).action,
            action,
          );
        },
      );
  await t.test('concurrent duplicate captures create one event', async () => {
    const tenant = randomUUID();
    const input = object({ organizationId: tenant });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.capture(tenant, input, 'serialization-service'),
      ),
    );
    assert.equal(new Set(results.map((row) => row.id)).size, 1);
    assert.equal(
      await db.traceEvent.count({ where: { organizationId: tenant } }),
      1,
    );
  });
  await t.test('immutable database behavior', async () => {
    await assert.rejects(
      db.traceEvent.update({
        where: { id: first.id },
        data: { action: 'DELETE' },
      }),
      /append-only/,
    );
    await assert.rejects(
      db.traceEvent.delete({ where: { id: first.id } }),
      /append-only/,
    );
    await assert.rejects(
      db.$executeRawUnsafe('TRUNCATE TABLE "TraceEvent"'),
      /append-only/,
    );
  });
  await t.test('tenant isolation', async () => {
    assert.equal((await service.list(randomUUID(), {})).total, 0);
    await rejectsStatus(service.get(randomUUID(), event.eventId), 404);
    await rejectsStatus(
      service.capture(randomUUID(), event, 'serialization-service'),
      400,
    );
  });
  await t.test('serial timeline ordering', async () => {
    const result = await service.list(org, {}, { serializedItemId: serial });
    assert.equal(result.total, 5);
    assert.deepEqual(
      result.items.map((v) => v.eventTime.getTime()),
      result.items.map((v) => v.eventTime.getTime()).sort((a, b) => a - b),
    );
  });
  await t.test('batch timeline', async () =>
    assert.equal((await service.list(org, {}, { batchId: batch })).total, 5),
  );
  await t.test('aggregate timelines include parent and child', async () => {
    assert.equal(
      (await service.list(org, {}, { aggregateId: aggregate })).total,
      4,
    );
    assert.equal(
      (await service.list(org, {}, { aggregateId: child })).total,
      2,
    );
  });
  await t.test('pagination is bounded and stable', async () => {
    const a = await service.list(org, { page: 1, pageSize: 2 }),
      b = await service.list(org, { page: 2, pageSize: 2 });
    assert.equal(a.items.length, 2);
    assert.equal(a.total, 7);
    assert(!a.items.some((x) => b.items.some((y) => x.id === y.id)));
    await rejectsStatus(service.list(org, { pageSize: 101 }), 400);
  });
  await t.test('date and type/action filters', async () => {
    assert.equal(
      (
        await service.list(org, {
          from: '2026-10-02T00:00:00Z',
          to: '2026-10-03T23:59:59Z',
        })
      ).total,
      2,
    );
    assert.equal(
      (await service.list(org, { eventType: 'AGGREGATION', action: 'DELETE' }))
        .total,
      2,
    );
    await rejectsStatus(
      service.list(org, {
        from: '2026-10-03T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
      }),
      400,
    );
  });
  await t.test('untrusted schema and mismatched caller rejected', async () => {
    await rejectsStatus(
      service.capture(
        org,
        object({ productId: undefined }),
        'serialization-service',
      ),
      400,
    );
    await rejectsStatus(
      service.capture(org, event, 'aggregation-service'),
      400,
    );
  });
});
test('signed capture rejects unauthorized callers, tampering and read identities', () => {
  const config = new ConfigService(env),
    guard = new TraceGuard(config);
  const path = `/internal/organizations/${org}/trace/events`,
    time = String(Date.now()),
    body = JSON.stringify(object());
  const headers = {
    'x-identity-organization': org,
    'x-identity-time': time,
    'x-trace-caller': 'serialization-service',
    'x-identity-signature': createHmac('sha256', env.TRACE_CAPTURE_SECRET)
      .update(
        traceCapturePayload(
          'POST',
          path,
          time,
          'serialization-service',
          org,
          body,
        ),
      )
      .digest('hex'),
  };
  const req = {
    method: 'POST',
    originalUrl: path,
    params: { organizationId: org },
    rawBody: Buffer.from(body),
    headers,
  };
  assert.equal(guard.canActivate(context(req)), true);
  for (const change of [
    { headers: {} },
    { rawBody: Buffer.from('{}') },
    { headers: { ...headers, 'x-trace-caller': 'browser' } },
    { headers: { ...headers, 'x-identity-organization': randomUUID() } },
    { headers: { ...headers, 'x-identity-time': '1000000000000' } },
  ])
    assert.throws(
      () => guard.canActivate(context({ ...req, ...change })),
      (e) => e.getStatus() === 401,
    );
});
test('serialization post-commit trace failure is controlled and carries reconciliation payload', async () => {
  const {
    SerializationService,
  } = require('../services/serialization-service/dist/serialization.service');
  const {
    TraceCaptureClient,
  } = require('../services/serialization-service/dist/trace-capture.client');
  const row = {
    id: serial,
    organizationId: org,
    batchId: batch,
    productId: randomUUID(),
    gtinId: randomUUID(),
    status: 'CREATED',
  };
  let mutated = false;
  const client = new TraceCaptureClient(
    new ConfigService({
      ...env,
      TRACEABILITY_SERVICE_URL: 'http://127.0.0.1:1',
    }),
  );
  const service = new SerializationService(
    {
      find: async () => row,
      transition: async () => {
        mutated = true;
        return { ...row, status: 'COMMISSIONED', updatedAt: new Date() };
      },
    },
    { validate: async () => ({ ...row, status: 'ACTIVE' }) },
    client,
  );
  await assert.rejects(
    service.command(org, serial, 'commission', {}, randomUUID(), 'ORG_ADMIN'),
    (e) => {
      assert(mutated);
      assert.equal(e.getStatus(), 503);
      const failure = e.getResponse();
      assert.equal(failure.code, 'TRACE_CAPTURE_FAILED');
      assert.equal(failure.businessStateChanged, true);
      assert.equal(failure.event.serializedItemId, serial);
      return true;
    },
  );
});
test('HTTP capture and gateway query forwarding preserve signatures, filters, tenant and read roles', async (t) => {
  const port = 14307;
  const childProcess = spawn(process.execPath, ['dist/main.js'], {
    cwd: 'services/traceability-service',
    env: { ...process.env, ...env, PORT: String(port), LOG_LEVEL: 'silent' },
    stdio: 'ignore',
  });
  t.after(() => childProcess.kill());
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/ready`)).ok) break;
    } catch {
      // Wait until the test HTTP server is listening.
    }
    if (i === 99) throw new Error('Trace service did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  const event = object();
  const path = `/internal/organizations/${org}/trace/events`,
    raw = JSON.stringify(event),
    time = String(Date.now());
  const headers = {
    'Content-Type': 'application/json',
    'x-identity-organization': org,
    'x-identity-time': time,
    'x-trace-caller': 'serialization-service',
    'x-identity-signature': createHmac('sha256', env.TRACE_CAPTURE_SECRET)
      .update(
        traceCapturePayload(
          'POST',
          path,
          time,
          'serialization-service',
          org,
          raw,
        ),
      )
      .digest('hex'),
  };
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        body: raw,
      })
    ).status,
    401,
  );
  const captured = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers,
    body: raw,
  });
  assert.equal(captured.status, 201);
  const { TraceProxy } = require('../apps/api-gateway/dist/trace/trace-proxy');
  for (const role of ['ORG_ADMIN', 'OPERATOR', 'VIEWER']) {
    const userId = randomUUID();
    const proxy = new TraceProxy(
      new ConfigService({
        ...env,
        TRACEABILITY_SERVICE_URL: `http://127.0.0.1:${port}`,
        AUTH_SERVICE_TIMEOUT_MS: 2000,
      }),
      { forward: async () => ({ organizationId: org, userId, role }) },
    );
    const result = await proxy.forward(
      `/organizations/${org}/trace/serials/${serial}?eventType=OBJECT&pageSize=1`,
      userId,
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].organizationId, org);
    const detail = await proxy.forward(
      `/organizations/${org}/trace/events/${event.eventId}`,
      userId,
    );
    assert.equal(detail.eventId, event.eventId);
  }
  const readTime = String(Date.now()),
    user = randomUUID();
  const signature = createHmac('sha256', env.INTERNAL_IDENTITY_SECRET)
    .update(
      productIdentityPayload(
        'POST',
        path,
        readTime,
        user,
        raw,
        org,
        'ORG_ADMIN',
      ),
    )
    .digest('hex');
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        body: raw,
        headers: {
          ...headers,
          'x-identity-time': readTime,
          'x-identity-signature': signature,
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${port}/organizations/${org}/trace/events/${event.eventId}`,
        { method: 'DELETE' },
      )
    ).status,
    404,
  );
});
test('gateway rejects mismatched trace scope, strips unknown response fields and sanitizes upstream failures', async () => {
  const { TraceProxy } = require('../apps/api-gateway/dist/trace/trace-proxy');
  const { Response } = globalThis;
  const userId = randomUUID();
  const proxy = new TraceProxy(
    new ConfigService({
      ...env,
      TRACEABILITY_SERVICE_URL: 'http://trace.test',
      AUTH_SERVICE_TIMEOUT_MS: 100,
    }),
    { forward: async () => ({ organizationId: org, userId, role: 'VIEWER' }) },
  );
  const record = {
    ...object(),
    id: randomUUID(),
    recordTime: '2026-10-01T01:00:00.000Z',
    createdAt: '2026-10-01T01:00:00.000Z',
    facilityId: null,
    aggregateContainerId: null,
    childContainerId: null,
    parentEventId: null,
    metadata: null,
    disposition: null,
    secret: 'must be removed',
  };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ items: [record], page: 1, pageSize: 25, total: 1 }),
      );
    const route = `/organizations/${org}/trace/serials/${serial}`;
    const result = await proxy.forward(route, userId);
    assert.equal('secret' in result.items[0], false);
    for (const invalid of [
      { ...record, organizationId: randomUUID() },
      { ...record, serializedItemId: randomUUID() },
      { ...record, eventType: 'SHIPPING' },
    ]) {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({ items: [invalid], page: 1, pageSize: 25, total: 1 }),
        );
      await rejectsStatus(proxy.forward(route, userId), 502);
    }
    globalThis.fetch = async () =>
      new Response('private database diagnostics', { status: 500 });
    await assert.rejects(
      proxy.forward(route, userId),
      (error) =>
        error.getStatus() === 502 &&
        !JSON.stringify(error.getResponse()).includes('private'),
    );
    globalThis.fetch = async () => {
      throw new Error('private socket diagnostics');
    };
    await rejectsStatus(proxy.forward(route, userId), 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
