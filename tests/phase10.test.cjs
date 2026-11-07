const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const { Buffer } = require('node:buffer');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const {
  ConfigService,
} = require('../services/shipment-service/node_modules/@nestjs/config');
const {
  PrismaService,
} = require('../services/shipment-service/dist/persistence/prisma.service');
const {
  PrismaService: TraceDatabase,
} = require('../services/traceability-service/dist/persistence/prisma.service');
const {
  TraceService,
} = require('../services/traceability-service/dist/trace.service');
const {
  TraceGuard,
} = require('../services/traceability-service/dist/trace.guard');
const {
  identityPayload,
  productIdentityPayload,
} = require('../packages/contracts/dist');
const env = parseEnv(readFileSync('services/shipment-service/.env', 'utf8'));
const traceEnv = parseEnv(
  readFileSync('services/traceability-service/.env', 'utf8'),
);
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function start(t, cwd, config) {
  const probe = createServer();
  await listen(probe);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd,
    env: {
      ...process.env,
      ...config,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGTERM');
      await done;
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null, output);
    try {
      if (
        (
          await fetch(
            base + (cwd === 'apps/api-gateway' ? '/health' : '/ready'),
          )
        ).ok
      )
        return base;
    } catch {
      /* Startup poll. */
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(output);
}
test('Phase 10: Shipment PostgreSQL, signed HTTP service and Gateway integration', async (t) => {
  const org = randomUUID(),
    other = randomUUID(),
    user = randomUUID(),
    viewer = randomUUID(),
    admin = randomUUID();
  const source = randomUUID(),
    destination = randomUUID(),
    serial = randomUUID(),
    container = randomUUID(),
    bad = randomUUID(),
    foreign = randomUUID(),
    inactive = randomUUID();
  const references = new Map([
    [source, { id: source, organizationId: org, status: 'ACTIVE' }],
    [destination, { id: destination, organizationId: org, status: 'ACTIVE' }],
    [serial, { id: serial, organizationId: org, status: 'COMMISSIONED' }],
    [container, { id: container, organizationId: org, status: 'ACTIVE' }],
    [foreign, { id: foreign, organizationId: other, status: 'COMMISSIONED' }],
    [inactive, { id: inactive, organizationId: org, status: 'DECOMMISSIONED' }],
  ]);
  const db = new PrismaService(new ConfigService(env));
  const traceDb = new TraceDatabase(new ConfigService(traceEnv));
  const trace = new TraceService(traceDb);
  const guard = new TraceGuard(
    new ConfigService({
      ...traceEnv,
      TRACE_CAPTURE_SECRET: env.TRACE_CAPTURE_SECRET,
    }),
  );
  let failTrace = false;
  const signatures = [];
  const boundaryErrors = [];
  const mock = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.url === '/auth/me') {
        const token = req.headers.authorization?.split(' ')[1];
        if (!['operator', 'viewer', 'admin'].includes(token)) {
          res.statusCode = 401;
          res.end('{}');
          return;
        }
        res.end(
          JSON.stringify({
            id: token === 'viewer' ? viewer : token === 'admin' ? admin : user,
            email: 'shipment@example.com',
            status: 'ACTIVE',
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const request = {
          method: 'POST',
          originalUrl: req.url,
          rawBody: Buffer.from(raw),
          headers: req.headers,
          params: { organizationId: org },
        };
        guard.canActivate({
          switchToHttp: () => ({ getRequest: () => request }),
        });
        if (failTrace) {
          res.statusCode = 503;
          res.end(JSON.stringify({ message: 'private downstream failure' }));
          return;
        }
        const result = await trace.capture(
          org,
          JSON.parse(raw),
          request.caller,
        );
        res.statusCode = 201;
        res.end(JSON.stringify(result));
        return;
      }
      const identityUser = req.headers['x-identity-user'];
      const facility = req.url.includes('/facilities/');
      const access = req.url.endsWith('/access');
      const payload =
        facility || access
          ? identityPayload(
              'GET',
              req.url,
              req.headers['x-identity-time'],
              identityUser,
              '',
            )
          : productIdentityPayload(
              'GET',
              req.url,
              req.headers['x-identity-time'],
              identityUser,
              '',
              org,
              req.headers['x-identity-role'],
            );
      assert.equal(
        req.headers['x-identity-signature'],
        createHmac('sha256', env.INTERNAL_IDENTITY_SECRET)
          .update(payload)
          .digest('hex'),
      );
      signatures.push(req.url);
      if (access) {
        if (req.url !== `/organizations/${org}/access`) {
          res.statusCode = 403;
          res.end('{}');
          return;
        }
        res.end(
          JSON.stringify({
            organizationId: org,
            userId: identityUser,
            role:
              identityUser === viewer
                ? 'VIEWER'
                : identityUser === admin
                  ? 'ORG_ADMIN'
                  : 'OPERATOR',
          }),
        );
        return;
      }
      const id = req.url
        .split('/')
        .filter(Boolean)
        .filter((v) => v !== 'validation')
        .at(-1);
      const reference = references.get(id);
      if (!reference) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'private database details' }));
        return;
      }
      res.end(JSON.stringify(reference));
    } catch (e) {
      boundaryErrors.push(e);
      res.statusCode = e.getStatus?.() ?? 500;
      res.end(JSON.stringify({ message: 'Boundary validation failed' }));
    }
  });
  const mockBase = await listen(mock);
  t.after(
    () =>
      new Promise((resolve) => {
        mock.closeAllConnections();
        mock.close(resolve);
      }),
  );
  t.after(async () => {
    await db.shipmentContent.deleteMany({ where: { organizationId: org } });
    await db.shipment.deleteMany({ where: { organizationId: org } });
    await db.$disconnect();
    await traceDb.$disconnect();
  });
  const shipmentBase = await start(t, 'services/shipment-service', {
    ...env,
    ORGANIZATION_SERVICE_URL: mockBase,
    SERIALIZATION_SERVICE_URL: mockBase,
    AGGREGATION_SERVICE_URL: mockBase,
    TRACEABILITY_SERVICE_URL: mockBase,
  });
  const gateway = await start(t, 'apps/api-gateway', {
    AUTH_SERVICE_URL: mockBase,
    ORGANIZATION_SERVICE_URL: mockBase,
    SHIPMENT_SERVICE_URL: shipmentBase,
    SHIPMENT_SERVICE_TIMEOUT_MS: '30000',
    AUTH_SERVICE_TIMEOUT_MS: '2000',
    INTERNAL_IDENTITY_SECRET: env.INTERNAL_IDENTITY_SECRET,
  });
  const collection = `/api/organizations/${org}/shipments`;
  async function request(method, path, body, token = 'operator') {
    const response = await fetch(gateway + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  async function expect(method, path, body, status = 201, token) {
    const result = await request(method, path, body, token);
    assert.equal(result.status, status, JSON.stringify(result.data));
    return result.data;
  }
  const input = {
    shipmentNumber: 'SHIP-001',
    sourceFacilityId: source,
    destinationFacilityId: destination,
  };
  let shipment;
  await t.test(
    'migration is deployed with isolated owner and shipment tables',
    async () => {
      const migrations =
        await db.$queryRaw`SELECT migration_name, finished_at FROM _prisma_migrations WHERE rolled_back_at IS NULL`;
      assert.equal(migrations.length, 1);
      assert.ok(migrations[0].finished_at);
      const [owner] = await db.$queryRaw`SELECT current_user AS owner`;
      assert.equal(owner.owner, 'shipment_owner');
      await db.shipmentContent.count();
    },
  );
  await t.test('create shipment as OPERATOR', async () => {
    shipment = await expect('POST', collection, input);
    assert.equal(shipment.status, 'CREATED');
    assert.deepEqual(shipment.contents, []);
  });
  const detail = () => `${collection}/${shipment.id}`;
  await t.test('organization-scoped shipment number uniqueness', () =>
    expect('POST', collection, input, 409),
  );
  await t.test('list and get shipment', async () => {
    const list = await expect('GET', collection, undefined, 200);
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, shipment.id);
    assert.equal(
      (await expect('GET', detail(), undefined, 200)).id,
      shipment.id,
    );
  });
  await t.test('same source and destination rejected', () =>
    expect(
      'POST',
      collection,
      { ...input, shipmentNumber: 'same', destinationFacilityId: source },
      400,
    ),
  );
  await t.test(
    'missing facility rejected through signed Organization HTTP',
    () =>
      expect(
        'POST',
        collection,
        { ...input, shipmentNumber: 'missing', sourceFacilityId: bad },
        404,
      ),
  );
  await t.test('cross-organization facility response rejected', () =>
    expect(
      'POST',
      collection,
      { ...input, shipmentNumber: 'foreign', sourceFacilityId: foreign },
      502,
    ),
  );
  await t.test(
    'VIEWER can read and cannot write any operational route',
    async () => {
      await expect('GET', detail(), undefined, 200, 'viewer');
      for (const command of [
        'items',
        'containers',
        'ready',
        'dispatch',
        'in-transit',
        'receive',
        'cancel',
      ])
        await expect(
          'POST',
          `${detail()}/${command}`,
          { referenceId: serial },
          403,
          'viewer',
        );
      await expect(
        'POST',
        collection,
        { ...input, shipmentNumber: 'viewer' },
        403,
        'viewer',
      );
      await expect(
        'DELETE',
        `${detail()}/items/${serial}`,
        undefined,
        403,
        'viewer',
      );
    },
  );
  await t.test('ORG_ADMIN can create and cancel', async () => {
    const row = await expect(
      'POST',
      collection,
      { ...input, shipmentNumber: 'admin' },
      201,
      'admin',
    );
    const cancelled = await expect(
      'POST',
      `${collection}/${row.id}/cancel`,
      {},
      201,
      'admin',
    );
    assert.equal(cancelled.status, 'CANCELLED');
    assert.ok(cancelled.cancelledAt);
    await expect('POST', `${collection}/${row.id}/ready`, {}, 409, 'admin');
  });
  await t.test(
    'Gateway authentication and organization membership enforced',
    async () => {
      await expect('GET', collection, undefined, 401, null);
      await expect(
        'GET',
        `/api/organizations/${other}/shipments/${shipment.id}`,
        undefined,
        403,
      );
    },
  );
  await t.test(
    'signed service requests remain organization scoped and signature bound',
    async () => {
      const path = `/organizations/${other}/shipments/${shipment.id}`,
        time = String(Date.now());
      const headers = {
        'x-identity-user': user,
        'x-identity-time': time,
        'x-identity-organization': other,
        'x-identity-role': 'OPERATOR',
        'x-identity-signature': createHmac(
          'sha256',
          env.INTERNAL_IDENTITY_SECRET,
        )
          .update(
            productIdentityPayload(
              'GET',
              path,
              time,
              user,
              '',
              other,
              'OPERATOR',
            ),
          )
          .digest('hex'),
      };
      assert.equal((await fetch(shipmentBase + path, { headers })).status, 404);
      headers['x-identity-organization'] = org;
      assert.equal((await fetch(shipmentBase + path, { headers })).status, 401);
    },
  );
  await t.test(
    'service itself rejects unsigned and VIEWER mutation requests',
    async () => {
      const path = `/organizations/${org}/shipments/${shipment.id}/cancel`;
      assert.equal(
        (await fetch(shipmentBase + path, { method: 'POST' })).status,
        401,
      );
      const time = String(Date.now()),
        raw = '{}';
      const signature = createHmac('sha256', env.INTERNAL_IDENTITY_SECRET)
        .update(
          productIdentityPayload(
            'POST',
            path,
            time,
            viewer,
            raw,
            org,
            'VIEWER',
          ),
        )
        .digest('hex');
      const response = await fetch(shipmentBase + path, {
        method: 'POST',
        body: raw,
        headers: {
          'Content-Type': 'application/json',
          'x-identity-user': viewer,
          'x-identity-organization': org,
          'x-identity-role': 'VIEWER',
          'x-identity-time': time,
          'x-identity-signature': signature,
        },
      });
      assert.equal(response.status, 403);
    },
  );
  await t.test('empty shipment cannot ready, dispatch or receive', async () => {
    for (const command of ['ready', 'dispatch', 'receive'])
      await expect('POST', `${detail()}/${command}`, {}, 409);
  });
  await t.test('add and remove serialized item', async () => {
    const row = await expect('POST', `${detail()}/items`, {
      referenceId: serial,
    });
    assert.equal(row.referenceId, serial);
    await expect('DELETE', `${detail()}/items/${serial}`, undefined, 200);
    await expect('DELETE', `${detail()}/items/${serial}`, undefined, 404);
  });
  await t.test('add and remove aggregate container', async () => {
    await expect('POST', `${detail()}/containers`, { referenceId: container });
    await expect(
      'DELETE',
      `${detail()}/containers/${container}`,
      undefined,
      200,
    );
  });
  await t.test(
    'invalid serial/container IDs and statuses rejected',
    async () => {
      for (const kind of ['items', 'containers']) {
        await expect('POST', `${detail()}/${kind}`, { referenceId: bad }, 404);
        await expect(
          'POST',
          `${detail()}/${kind}`,
          { referenceId: inactive },
          409,
        );
        await expect(
          'POST',
          `${detail()}/${kind}`,
          { referenceId: foreign },
          502,
        );
        await expect(
          'POST',
          `${detail()}/${kind}`,
          { referenceId: 'invalid' },
          400,
        );
      }
    },
  );
  await t.test('quarantined serial rejected', async () => {
    references.set(inactive, {
      id: inactive,
      organizationId: org,
      status: 'QUARANTINED',
    });
    await expect('POST', `${detail()}/items`, { referenceId: inactive }, 409);
  });
  await t.test('concurrent duplicate additions allow one winner', async () => {
    const results = await Promise.all([
      request('POST', `${detail()}/items`, { referenceId: serial }),
      request('POST', `${detail()}/items`, { referenceId: serial }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(
      await db.shipmentContent.count({ where: { shipmentId: shipment.id } }),
      1,
    );
  });
  let second;
  await t.test(
    'same direct reference cannot occupy two open shipments',
    async () => {
      second = await expect('POST', collection, {
        ...input,
        shipmentNumber: 'SHIP-002',
      });
      await expect(
        'POST',
        `${collection}/${second.id}/items`,
        { referenceId: serial },
        409,
      );
      await expect('POST', `${detail()}/containers`, {
        referenceId: container,
      });
      await expect(
        'POST',
        `${detail()}/containers`,
        { referenceId: container },
        409,
      );
    },
  );
  await t.test(
    'bounded pagination and source/destination/status filters',
    async () => {
      const list = await expect(
        'GET',
        `${collection}?status=CREATED&sourceFacilityId=${source}&destinationFacilityId=${destination}&pageSize=1&page=2`,
        undefined,
        200,
      );
      assert.equal(list.total, 2);
      assert.equal(list.items.length, 1);
      assert.equal(list.page, 2);
      for (const query of [
        'page=0',
        'pageSize=101',
        'status=BAD',
        'unknown=value',
      ])
        await expect('GET', `${collection}?${query}`, undefined, 400);
    },
  );
  await t.test('ready freezes membership', async () => {
    assert.equal(
      (await expect('POST', `${detail()}/ready`, {})).status,
      'READY',
    );
    await expect('DELETE', `${detail()}/items/${serial}`, undefined, 409);
    await expect(
      'POST',
      `${detail()}/containers`,
      { referenceId: container },
      409,
    );
  });
  await t.test('dispatch revalidates references before commit', async () => {
    references.set(serial, {
      id: serial,
      organizationId: org,
      status: 'QUARANTINED',
    });
    await expect('POST', `${detail()}/dispatch`, {}, 409);
    assert.equal(
      (await db.shipment.findUnique({ where: { id: shipment.id } })).status,
      'READY',
    );
    references.set(serial, {
      id: serial,
      organizationId: org,
      status: 'COMMISSIONED',
    });
  });
  await t.test(
    'concurrent dispatch commits once and emits shipping trace',
    async () => {
      const results = await Promise.all([
        request('POST', `${detail()}/dispatch`, {}),
        request('POST', `${detail()}/dispatch`, {}),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      const event = await trace.get(org, `shipment:${shipment.id}:dispatch`);
      assert.equal(event.eventType, 'TRANSACTION');
      assert.equal(event.businessStep, 'shipping');
      assert.equal(event.facilityId, source);
      assert.equal(event.metadata.contents.length, 2);
      assert.equal(event.metadata.shipmentId, shipment.id);
    },
  );
  await t.test(
    'in transit, receiving, and terminal transition rules',
    async () => {
      await expect('POST', `${detail()}/cancel`, {}, 409);
      assert.equal(
        (await expect('POST', `${detail()}/in-transit`, {})).status,
        'IN_TRANSIT',
      );
      const received = await expect('POST', `${detail()}/receive`, {});
      assert.equal(received.status, 'RECEIVED');
      assert.ok(received.dispatchedAt);
      assert.ok(received.receivedAt);
      for (const command of ['dispatch', 'ready', 'receive', 'cancel'])
        await expect('POST', `${detail()}/${command}`, {}, 409);
      const event = await trace.get(org, `shipment:${shipment.id}:receive`);
      assert.equal(event.businessStep, 'receiving');
      assert.equal(event.facilityId, destination);
    },
  );
  await t.test('received shipments release direct reservations', () =>
    expect('POST', `${collection}/${second.id}/items`, { referenceId: serial }),
  );
  let recovery;
  await t.test(
    'synchronous trace failure preserves committed state and Gateway reconciliation payload',
    async () => {
      await expect('POST', `${collection}/${second.id}/ready`, {});
      failTrace = true;
      recovery = await expect(
        'POST',
        `${collection}/${second.id}/dispatch`,
        {},
        503,
      );
      assert.equal(recovery.code, 'TRACE_CAPTURE_FAILED');
      assert.equal(recovery.businessStateChanged, true);
      assert.equal(recovery.event.organizationId, org);
      assert.equal(recovery.event.eventType, 'TRANSACTION');
      assert.equal(
        (await db.shipment.findUnique({ where: { id: second.id } })).status,
        'DISPATCHED',
      );
      assert.ok(!JSON.stringify(recovery).includes('private downstream'));
      await expect('POST', `${collection}/${second.id}/dispatch`, {}, 409);
      failTrace = false;
    },
  );
  await t.test(
    'exact reconciliation payload can be captured idempotently',
    async () => {
      const event = await trace.capture(
        org,
        recovery.event,
        'shipment-service',
      );
      const repeat = await trace.capture(
        org,
        recovery.event,
        'shipment-service',
      );
      assert.equal(event.id, repeat.id);
    },
  );
  await t.test(
    'receive failure also commits and provides reconciliation',
    async () => {
      failTrace = true;
      const result = await expect(
        'POST',
        `${collection}/${second.id}/receive`,
        {},
        503,
      );
      failTrace = false;
      assert.equal(result.businessStateChanged, true);
      assert.equal(result.event.businessStep, 'receiving');
      assert.equal(
        (await db.shipment.findUnique({ where: { id: second.id } })).status,
        'RECEIVED',
      );
      await trace.capture(org, result.event, 'shipment-service');
    },
  );
  await t.test('cancel READY shipment releases references', async () => {
    const row = await expect('POST', collection, {
      ...input,
      shipmentNumber: 'cancel-ready',
    });
    await expect('POST', `${collection}/${row.id}/items`, {
      referenceId: serial,
    });
    await expect('POST', `${collection}/${row.id}/ready`, {});
    const result = await expect('POST', `${collection}/${row.id}/cancel`, {});
    assert.equal(result.status, 'CANCELLED');
    await expect('POST', `${collection}/${row.id}/receive`, {}, 409);
  });
  await t.test(
    'all external reference calls used expected signed paths',
    () => {
      assert.ok(
        signatures.includes(`/organizations/${org}/facilities/${source}`),
      );
      assert.ok(
        signatures.includes(
          `/internal/organizations/${org}/serials/${serial}/validation`,
        ),
      );
      assert.ok(
        signatures.includes(`/organizations/${org}/aggregates/${container}`),
      );
      assert.deepEqual(boundaryErrors, []);
    },
  );
});
