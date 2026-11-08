const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { parseEnv } = require('node:util');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { Buffer } = require('node:buffer');
const { URL } = require('node:url');
const {
  ConfigService,
} = require('../services/recall-service/node_modules/@nestjs/config');
const {
  RecallService,
} = require('../services/recall-service/dist/recall.service');
const {
  VerificationService,
} = require('../services/recall-service/dist/verification.service');
const {
  ReferenceClient,
} = require('../services/recall-service/dist/reference.client');
const {
  InternalIdentityGuard,
} = require('../services/recall-service/dist/authorization');
const {
  TraceService,
} = require('../services/traceability-service/dist/trace.service');
const {
  TraceConsumer,
} = require('../services/traceability-service/dist/trace-consumer');
const {
  Messaging,
  OutboxPublisher,
  PostgresOutboxStore,
  eventSchema,
  toTrace,
} = require('../packages/messaging/dist');
const {
  validateOutboxEnvironment,
  validateRecallEnvironment,
  validateGatewayEnvironment,
} = require('../packages/config/dist');
const {
  productIdentityPayload,
  identityPayload,
} = require('../packages/contracts/dist');
const env = (name) =>
  parseEnv(readFileSync(`services/${name}-service/.env`, 'utf8'));
const DB = (name) =>
  require(`../services/${name}-service/dist/persistence/prisma.service`)
    .PrismaService;
async function isolated(name, t) {
  const owner = new (DB(name))(new ConfigService(env(name)));
  await owner.$connect();
  const schema = `p13_${randomUUID().replaceAll('-', '')}`;
  await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(env(name).DATABASE_URL);
  url.searchParams.set('schema', schema);
  const db = new (DB(name))(
    new ConfigService({ ...env(name), DATABASE_URL: url.toString() }),
  );
  db.testUrl = url.toString();
  t.after(async () => {
    await db.beforeCleanup?.();
    await db.$disconnect();
    await owner.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await owner.$disconnect();
  });
  for (const folder of readdirSync(`services/${name}-service/prisma/migrations`)
    .filter((v) => /^\d/.test(v))
    .sort())
    for (const sql of readFileSync(
      `services/${name}-service/prisma/migrations/${folder}/migration.sql`,
      'utf8',
    )
      .replace(/--[^\n]*/g, '')
      .match(/(?:[^;$]|\$(?!\$)|\$\$[\s\S]*?\$\$)+/g)
      .filter((v) => v.replace(/--[^\n]*/g, '').trim()))
      await db.$executeRawUnsafe(sql);
  return db;
}
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
const identity = () => ({
  organizationId: randomUUID(),
  userId: randomUUID(),
  role: 'OPERATOR',
});
const scope = () => ({
  productId: randomUUID(),
  gtinId: randomUUID(),
  batchId: randomUUID(),
});
const draft = (s = scope()) => ({
  ...s,
  recallNumber: randomUUID(),
  title: 'Lot quality recall',
  reason: 'Quality investigation',
  severity: 'CLASS_II',
});
const statusError = (code) => (e) => e.getStatus?.() === code;
test('Phase 13: Recall persistence, lifecycle, scope integrity, pagination and concurrency', async (t) => {
  const db = await isolated('recall', t);
  const who = identity();
  const calls = [];
  const refs = { scope: async (s, i) => calls.push({ s, i }) };
  const service = new RecallService(db, refs);
  const input = draft();
  let row;
  await t.test('create draft and preserve references and actor', async () => {
    row = await service.create(who, input);
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.createdBy, who.userId);
    assert.equal(row.batchId, input.batchId);
    assert.equal(await db.outboxEvent.count(), 0);
  });
  await t.test('organization isolation', async () => {
    await assert.rejects(service.get(randomUUID(), row.id), statusError(404));
    assert.equal((await service.list(randomUUID(), {})).total, 0);
  });
  await t.test('unique recall number and strict input', async () => {
    await assert.rejects(service.create(who, input), statusError(409));
    await assert.rejects(
      service.create(who, { ...draft(), status: 'ACTIVE' }),
      statusError(400),
    );
  });
  await t.test('bounded pagination and filters', async () => {
    await service.create(who, draft());
    const page = await service.list(who.organizationId, {
      page: '1',
      pageSize: '1',
      status: 'DRAFT',
      productId: input.productId,
    });
    assert.equal(page.total, 1);
    assert.equal(page.items.length, 1);
    assert.equal(
      (await service.list(who.organizationId, { page: 2, pageSize: 1 })).items
        .length,
      1,
    );
    await assert.rejects(
      service.list(who.organizationId, { pageSize: 101 }),
      statusError(400),
    );
    await assert.rejects(
      service.list(who.organizationId, {
        from: '2027-01-01T00:00:00Z',
        to: '2026-01-01T00:00:00Z',
      }),
      statusError(400),
    );
  });
  await t.test(
    'activation validates again, atomically stores versioned Outbox event',
    async () => {
      const count = calls.length;
      row = await service.command(who, row.id, 'activate', {});
      assert.equal(calls.length, count + 1);
      assert.equal(row.status, 'ACTIVE');
      assert.ok(row.initiatedAt);
      const out = await db.outboxEvent.findFirstOrThrow({
        where: { aggregateId: row.id },
      });
      const event = eventSchema.parse(out.envelope);
      assert.equal(event.eventType, 'recall.activated');
      assert.equal(event.organizationId, who.organizationId);
      assert.equal(event.payload.batchId, input.batchId);
      assert.equal(out.status, 'PENDING');
      assert.equal(toTrace(event).businessStep, 'recalling');
    },
  );
  await t.test(
    'duplicate activation and exact active scope prevented',
    async () => {
      await assert.rejects(
        service.command(who, row.id, 'activate', {}),
        statusError(409),
      );
      const other = await service.create(who, {
        ...input,
        recallNumber: randomUUID(),
        gtinId: undefined,
      });
      await assert.rejects(
        service.command(who, other.id, 'activate', {}),
        statusError(409),
      );
      assert.equal(
        (await service.get(who.organizationId, other.id)).status,
        'DRAFT',
      );
      assert.equal(
        await db.outboxEvent.count({ where: { aggregateId: other.id } }),
        0,
      );
    },
  );
  await t.test(
    'close active recall; terminal states cannot reactivate',
    async () => {
      row = await service.command(who, row.id, 'close', {});
      assert.ok(row.closedAt);
      assert.equal(row.status, 'CLOSED');
      await assert.rejects(
        service.command(who, row.id, 'activate', {}),
        statusError(409),
      );
      await assert.rejects(
        service.command(who, row.id, 'cancel', {}),
        statusError(409),
      );
      assert.equal(
        await db.outboxEvent.count({ where: { eventType: 'recall.closed' } }),
        1,
      );
    },
  );
  await t.test('cancel draft only', async () => {
    const d = await service.create(who, draft());
    await assert.rejects(
      service.command(who, d.id, 'close', {}),
      statusError(409),
    );
    assert.equal(
      (await service.command(who, d.id, 'cancel', {})).status,
      'CANCELLED',
    );
    await assert.rejects(
      service.command(who, d.id, 'activate', {}),
      statusError(409),
    );
    assert.equal(
      await db.outboxEvent.count({ where: { eventType: 'recall.cancelled' } }),
      1,
    );
  });
  await t.test(
    'concurrent transition has one winner and one event',
    async () => {
      const d = await service.create(who, draft());
      const results = await Promise.allSettled([
        service.command(who, d.id, 'activate', {}),
        service.command(who, d.id, 'activate', {}),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        await db.outboxEvent.count({ where: { aggregateId: d.id } }),
        1,
      );
    },
  );
  await t.test(
    'concurrent distinct drafts for same scope have one active definition',
    async () => {
      const s = scope();
      const a = await service.create(who, draft(s));
      const b = await service.create(who, draft(s));
      const results = await Promise.allSettled([
        service.command(who, a.id, 'activate', {}),
        service.command(who, b.id, 'activate', {}),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    },
  );
  await t.test('Outbox failure rolls back lifecycle change', async () => {
    const d = await service.create(who, draft());
    await db.$executeRawUnsafe(
      'ALTER TABLE "OutboxEvent" ADD CONSTRAINT "p13_fail" CHECK (false) NOT VALID',
    );
    await assert.rejects(service.command(who, d.id, 'activate', {}));
    await db.$executeRawUnsafe(
      'ALTER TABLE "OutboxEvent" DROP CONSTRAINT "p13_fail"',
    );
    assert.equal((await service.get(who.organizationId, d.id)).status, 'DRAFT');
  });
});
test('Phase 13: organization guard permits reads and verification, limits recall writes', () => {
  const secret = 'a'.repeat(40),
    who = identity();
  const guard = new InternalIdentityGuard(
    new ConfigService({ INTERNAL_IDENTITY_SECRET: secret }),
  );
  const check = (role, method, path, org = who.organizationId) => {
    const time = String(Date.now()),
      raw = method === 'POST' ? '{}' : '';
    const req = {
      method,
      originalUrl: path,
      rawBody: Buffer.from(raw),
      params: { organizationId: org },
      headers: {
        'x-identity-user': who.userId,
        'x-identity-organization': who.organizationId,
        'x-identity-role': role,
        'x-identity-time': time,
        'x-identity-signature': createHmac('sha256', secret)
          .update(
            productIdentityPayload(
              method,
              path,
              time,
              who.userId,
              raw,
              who.organizationId,
              role,
            ),
          )
          .digest('hex'),
      },
    };
    return guard.canActivate({
      switchToHttp: () => ({ getRequest: () => req }),
    });
  };
  for (const role of ['ORG_ADMIN', 'OPERATOR', 'VIEWER']) {
    assert.equal(
      check(role, 'GET', `/organizations/${who.organizationId}/recalls`),
      true,
    );
    assert.equal(
      check(role, 'POST', `/organizations/${who.organizationId}/verification`),
      true,
    );
  }
  for (const role of ['ORG_ADMIN', 'OPERATOR'])
    assert.equal(
      check(role, 'POST', `/organizations/${who.organizationId}/recalls`),
      true,
    );
  assert.throws(
    () =>
      check('VIEWER', 'POST', `/organizations/${who.organizationId}/recalls`),
    statusError(403),
  );
  assert.throws(
    () =>
      check(
        'OPERATOR',
        'GET',
        `/organizations/${who.organizationId}/recalls`,
        randomUUID(),
      ),
    statusError(401),
  );
});
test('Phase 13: Verification decisions query owning services and current active scopes', async (t) => {
  const db = await isolated('recall', t);
  const who = identity(),
    s = scope();
  const gtin = {
    id: s.gtinId,
    organizationId: who.organizationId,
    productId: s.productId,
    gtin: '00012345600012',
    status: 'ACTIVE',
    product: {
      id: s.productId,
      organizationId: who.organizationId,
      name: 'Medicine',
      status: 'ACTIVE',
    },
  };
  const serial = {
    ...s,
    id: randomUUID(),
    organizationId: who.organizationId,
    serialNumber: 'PACK-13',
    status: 'COMMISSIONED',
  };
  const batch = {
    id: s.batchId,
    ...s,
    organizationId: who.organizationId,
    lotNumber: 'LOT-13',
    expiryDate: '2099-01-01',
    status: 'ACTIVE',
  };
  let missing = false,
    fail = false;
  const {
    NotFoundException,
    ServiceUnavailableException,
  } = require('../services/recall-service/node_modules/@nestjs/common');
  const refs = {
    get: async (service, path, i) => {
      assert.equal(i.organizationId, who.organizationId);
      if (fail) throw new ServiceUnavailableException();
      if (missing) throw new NotFoundException();
      return service === 'PRODUCT'
        ? gtin
        : service === 'BATCH'
          ? batch
          : serial;
    },
    scope: async () => {},
  };
  const verification = new VerificationService(db, refs),
    recalls = new RecallService(db, refs),
    input = { gtin: gtin.gtin, serialNumber: serial.serialNumber };
  const result = async () => (await verification.verify(who, input)).result;
  await t.test(
    'commissioned normal serial → VALID, sanitized result',
    async () => {
      const r = await verification.verify(who, input);
      assert.equal(r.result, 'VALID');
      assert.equal(r.productName, 'Medicine');
      for (const k of [
        'id',
        'organizationId',
        'userId',
        'batchId',
        'productId',
        'gtinId',
        'createdBy',
      ])
        assert.equal(k in r, false);
    },
  );
  await t.test('unknown identity → UNKNOWN', async () => {
    missing = true;
    assert.equal(await result(), 'UNKNOWN');
    missing = false;
  });
  await t.test('decommissioned → DECOMMISSIONED', async () => {
    serial.status = 'DECOMMISSIONED';
    assert.equal(await result(), 'DECOMMISSIONED');
  });
  await t.test('quarantined → QUARANTINED', async () => {
    serial.status = 'QUARANTINED';
    assert.equal(await result(), 'QUARANTINED');
  });
  await t.test('uncommissioned → UNKNOWN', async () => {
    serial.status = 'CREATED';
    assert.equal(await result(), 'UNKNOWN');
    serial.status = 'COMMISSIONED';
  });
  await t.test(
    'inactive product/GTIN, expired or closed batch never valid',
    async () => {
      gtin.status = 'INACTIVE';
      assert.equal(await result(), 'UNKNOWN');
      gtin.status = 'ACTIVE';
      gtin.product.status = 'INACTIVE';
      assert.equal(await result(), 'UNKNOWN');
      gtin.product.status = 'ACTIVE';
      batch.expiryDate = '2000-01-01';
      assert.equal(await result(), 'UNKNOWN');
      batch.expiryDate = '2099-01-01';
      batch.status = 'CLOSED';
      assert.equal(await result(), 'UNKNOWN');
      batch.status = 'QUARANTINED';
      assert.equal(await result(), 'QUARANTINED');
      batch.status = 'ACTIVE';
    },
  );
  for (const level of ['batch', 'gtin', 'product'])
    await t.test(
      `active ${level} recall → RECALLED; closed recall no longer matches`,
      async () => {
        const d = await recalls.create(
          who,
          draft(
            level === 'batch'
              ? s
              : level === 'gtin'
                ? { productId: s.productId, gtinId: s.gtinId }
                : { productId: s.productId },
          ),
        );
        await recalls.command(who, d.id, 'activate', {});
        serial.status = 'DECOMMISSIONED';
        assert.equal(await result(), 'RECALLED');
        serial.status = 'COMMISSIONED';
        assert.equal(
          (await verification.verify(who, input)).recall.recallNumber,
          d.recallNumber,
        );
        await recalls.command(who, d.id, 'close', {});
        assert.equal(await result(), 'VALID');
      },
    );
  await t.test('other organization active recall cannot match', async () => {
    const d = await recalls.create(identity(), draft(s));
    await recalls.command(
      {
        organizationId: d.organizationId,
        userId: who.userId,
        role: 'OPERATOR',
      },
      d.id,
      'activate',
      {},
    );
    assert.equal(await result(), 'VALID');
  });
  await t.test('GTIN mismatch fails closed', async () => {
    serial.gtinId = randomUUID();
    await assert.rejects(result(), statusError(502));
    serial.gtinId = s.gtinId;
  });
  await t.test('downstream failure returns error, never VALID', async () => {
    fail = true;
    await assert.rejects(result(), statusError(503));
    fail = false;
  });
  await t.test('strict GTIN and serial validation', async () => {
    await assert.rejects(
      verification.verify(who, { ...input, gtin: '123' }),
      statusError(400),
    );
    await assert.rejects(
      verification.verify(who, { ...input, serialNumber: '' }),
      statusError(400),
    );
  });
});
test(
  'Phase 13: signed HTTP owning-service references, Recall API and Gateway RBAC',
  { timeout: 90000 },
  async (t) => {
    const who = identity(),
      other = identity(),
      viewer = randomUUID();
    const s = scope();
    const productDb = await isolated('product', t),
      batchDb = await isolated('batch', t),
      serialDb = await isolated('serialization', t),
      recallDb = await isolated('recall', t);
    const config = (name, db) => ({
      ...env(name),
      DATABASE_URL: db.testUrl,
      EVENT_TRANSPORT: 'http',
    });
    await productDb.product.create({
      data: {
        id: s.productId,
        organizationId: who.organizationId,
        name: 'Phase 13 medicine',
      },
    });
    await productDb.gTIN.create({
      data: {
        id: s.gtinId,
        organizationId: who.organizationId,
        productId: s.productId,
        gtin: '00012345600012',
        packagingLevel: 'EACH',
      },
    });
    await batchDb.batch.create({
      data: {
        id: s.batchId,
        organizationId: who.organizationId,
        productId: s.productId,
        gtinId: s.gtinId,
        lotNumber: 'P13-LOT',
        expiryDate: new Date('2099-01-01'),
      },
    });
    await serialDb.serializedItem.create({
      data: {
        ...s,
        organizationId: who.organizationId,
        serialNumber: 'HTTP-PACK',
        status: 'COMMISSIONED',
        commissionedAt: new Date(),
      },
    });
    const productUrl = await start(
      t,
      'services/product-service',
      config('product', productDb),
    );
    const batchUrl = await start(t, 'services/batch-service', {
      ...config('batch', batchDb),
      PRODUCT_SERVICE_URL: productUrl,
    });
    const serialUrl = await start(t, 'services/serialization-service', {
      ...config('serialization', serialDb),
      BATCH_SERVICE_URL: batchUrl,
    });
    const recallUrl = await start(t, 'services/recall-service', {
      ...config('recall', recallDb),
      PRODUCT_SERVICE_URL: productUrl,
      BATCH_SERVICE_URL: batchUrl,
      SERIALIZATION_SERVICE_URL: serialUrl,
      EVENT_TRANSPORT: 'kafka',
    });
    const secret = env('recall').INTERNAL_IDENTITY_SECRET;
    const auth = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const user = req.headers['x-identity-user'];
      if (req.url === '/auth/me') {
        const token = req.headers.authorization?.split(' ')[1];
        if (!['operator', 'viewer', 'admin', 'foreign'].includes(token)) {
          res.statusCode = 401;
          res.end('{}');
          return;
        }
        res.end(
          JSON.stringify({
            id:
              token === 'viewer'
                ? viewer
                : token === 'foreign'
                  ? other.userId
                  : who.userId,
            email: 'p13@example.com',
            status: 'ACTIVE',
          }),
        );
        return;
      }
      const org = req.url.split('/')[2];
      const time = req.headers['x-identity-time'];
      const sig = createHmac('sha256', secret)
        .update(identityPayload('GET', req.url, time, user, ''))
        .digest('hex');
      if (
        sig !== req.headers['x-identity-signature'] ||
        ((org !== who.organizationId || user === other.userId) &&
          !(org === other.organizationId && user === other.userId))
      ) {
        res.statusCode = 403;
        res.end('{}');
        return;
      }
      res.end(
        JSON.stringify({
          organizationId: org,
          userId: user,
          role: user === viewer ? 'VIEWER' : 'OPERATOR',
        }),
      );
    });
    const authUrl = await listen(auth);
    t.after(
      () =>
        new Promise((resolve) => {
          auth.closeAllConnections();
          auth.close(resolve);
        }),
    );
    const gateway = await start(t, 'apps/api-gateway', {
      ...env('recall'),
      AUTH_SERVICE_URL: authUrl,
      ORGANIZATION_SERVICE_URL: authUrl,
      RECALL_SERVICE_URL: recallUrl,
    });
    const request = async (method, path, body, token = 'operator') => {
      const response = await fetch(
        `${gateway}/api/organizations/${who.organizationId}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      return {
        status: response.status,
        data: await response.json(),
        cache: response.headers.get('cache-control'),
      };
    };
    let recall;
    await t.test('create via Gateway with real scope validation', async () => {
      const response = await request('POST', '/recalls', draft(s));
      assert.equal(response.status, 201, JSON.stringify(response.data));
      assert.equal(response.cache, 'no-store');
      recall = response.data;
    });
    await t.test(
      'invalid product/GTIN/batch rejected by owning APIs',
      async () => {
        for (const field of ['productId', 'gtinId', 'batchId']) {
          const response = await request('POST', '/recalls', {
            ...draft(s),
            [field]: randomUUID(),
          });
          assert.equal(response.status, 404, JSON.stringify(response.data));
        }
      },
    );
    await t.test('inconsistent scope rejected', async () => {
      const another = await productDb.product.create({
        data: { organizationId: who.organizationId, name: 'Other product' },
      });
      const response = await request('POST', '/recalls', {
        ...draft(s),
        productId: another.id,
        gtinId: undefined,
      });
      assert.equal(response.status, 409);
    });
    await t.test('viewer reads and verifies but cannot mutate', async () => {
      assert.equal(
        (await request('GET', '/recalls', undefined, 'viewer')).status,
        200,
      );
      for (const path of [
        '/recalls',
        `/recalls/${recall.id}/activate`,
        `/recalls/${recall.id}/cancel`,
      ])
        assert.equal(
          (
            await request(
              'POST',
              path,
              path === '/recalls' ? draft(s) : {},
              'viewer',
            )
          ).status,
          403,
        );
      const r = await request(
        'POST',
        '/verification',
        { gtin: '00012345600012', serialNumber: 'HTTP-PACK' },
        'viewer',
      );
      assert.equal(r.status, 201);
      assert.equal(r.data.result, 'VALID');
    });
    await t.test(
      'unauthenticated and foreign organization rejected',
      async () => {
        assert.equal(
          (await request('GET', '/recalls', undefined, 'bad')).status,
          401,
        );
        assert.equal(
          (await request('GET', '/recalls', undefined, 'foreign')).status,
          403,
        );
      },
    );
    await t.test(
      'verification in another authorized tenant does not find the pack',
      async () => {
        const response = await fetch(
          `${gateway}/api/organizations/${other.organizationId}/verification`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer foreign',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              gtin: '00012345600012',
              serialNumber: 'HTTP-PACK',
            }),
          },
        );
        assert.equal(response.status, 201);
        const result = await response.json();
        assert.equal(result.result, 'UNKNOWN');
        assert.equal(result.productName, undefined);
      },
    );
    await t.test(
      'activation changes verification; close removes active scope',
      async () => {
        assert.equal(
          (await request('POST', `/recalls/${recall.id}/activate`, {})).status,
          201,
        );
        const r = await request('POST', '/verification', {
          gtin: '00012345600012',
          serialNumber: 'HTTP-PACK',
        });
        assert.equal(r.data.result, 'RECALLED');
        assert.equal(r.data.organizationId, undefined);
        assert.equal(
          (await request('POST', `/recalls/${recall.id}/activate`, {})).status,
          409,
        );
        assert.equal(
          (await request('POST', `/recalls/${recall.id}/close`, {})).status,
          201,
        );
        assert.equal(
          (
            await request('POST', '/verification', {
              gtin: '00012345600012',
              serialNumber: 'HTTP-PACK',
            })
          ).data.result,
          'VALID',
        );
      },
    );
    await t.test(
      'bounded pagination, filters and invalid query handling via Gateway',
      async () => {
        const r = await request('GET', '/recalls?status=CLOSED&pageSize=1');
        assert.equal(r.status, 200);
        assert.equal(r.data.total, 1);
        assert.equal(r.data.items[0].id, recall.id);
        assert.equal(
          (await request('GET', '/recalls?pageSize=1000')).status,
          400,
        );
      },
    );
    await t.test(
      'exact identity lookup never substitutes serial from another GTIN',
      async () => {
        const gtin = await productDb.gTIN.create({
          data: {
            organizationId: who.organizationId,
            productId: s.productId,
            gtin: '00012345600029',
            packagingLevel: 'EACH',
          },
        });
        assert.ok(gtin);
        assert.equal(
          (
            await request('POST', '/verification', {
              gtin: '00012345600029',
              serialNumber: 'HTTP-PACK',
            })
          ).data.result,
          'UNKNOWN',
        );
      },
    );
    await t.test(
      'serial lookup preserves dot segments, slashes and punctuation',
      async () => {
        for (const serialNumber of ['..', 'PACK/A?B#C%', 'Medicine + 13']) {
          await serialDb.serializedItem.create({
            data: {
              ...s,
              organizationId: who.organizationId,
              serialNumber,
              status: 'COMMISSIONED',
              commissionedAt: new Date(),
            },
          });
          const response = await request('POST', '/verification', {
            gtin: '00012345600012',
            serialNumber,
          });
          assert.equal(response.status, 201, JSON.stringify(response.data));
          assert.equal(response.data.result, 'VALID');
          assert.equal(response.data.serialNumber, serialNumber);
        }
      },
    );
    await t.test('internal API rejects unsigned requests', async () => {
      assert.equal(
        (
          await fetch(
            `${recallUrl}/organizations/${who.organizationId}/recalls`,
          )
        ).status,
        401,
      );
    });
  },
);
test(
  'Phase 13: Recall Outbox → real Kafka → durable idempotent Traceability',
  { timeout: 90000 },
  async (t) => {
    const db = await isolated('recall', t),
      traceDb = await isolated('traceability', t),
      who = identity();
    const service = new RecallService(db, { scope: async () => {} });
    const trace = new TraceService(traceDb);
    const messaging = new Messaging(
      new ConfigService({
        EVENT_TRANSPORT: 'kafka',
        KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
        KAFKA_CLIENT_ID: `phase13-${randomUUID()}`,
        KAFKA_CONSUMER_GROUP_ID: `phase13-${randomUUID()}`,
      }),
    );
    traceDb.beforeCleanup = () => messaging.onModuleDestroy();
    await messaging.onModuleInit();
    await new TraceConsumer(messaging, trace).onApplicationBootstrap();
    const row = await service.create(who, draft());
    await service.command(who, row.id, 'activate', {});
    await service.command(who, row.id, 'close', {});
    const cancelled = await service.create(who, draft());
    await service.command(who, cancelled.id, 'cancel', {});
    const events = await db.outboxEvent.findMany({
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(events.length, 3);
    const worker = new OutboxPublisher(
      new PostgresOutboxStore(db),
      messaging,
      validateOutboxEnvironment({}),
      'recall-service',
    );
    await worker.runOnce();
    assert.equal(
      await db.outboxEvent.count({ where: { status: 'PUBLISHED' } }),
      3,
    );
    const deadline = Date.now() + 45000;
    while (
      (await traceDb.processedEvent.count({
        where: { eventId: { in: events.map((e) => e.eventId) } },
      })) < 3
    ) {
      if (Date.now() > deadline) assert.fail('Recall Kafka consumer timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const e of events) {
      await messaging.publish(e.envelope);
      await Promise.all([trace.consume(e.envelope), trace.consume(e.envelope)]);
      assert.equal(
        await traceDb.traceEvent.count({ where: { eventId: e.eventId } }),
        1,
      );
      const captured = await traceDb.traceEvent.findUniqueOrThrow({
        where: { eventId: e.eventId },
      });
      assert.equal(captured.organizationId, who.organizationId);
      assert.equal(captured.metadata.recallId, e.aggregateId);
      assert.equal(captured.productId, e.envelope.payload.productId);
      assert.equal(captured.eventType, 'TRANSACTION');
    }
    assert.equal((await trace.list(randomUUID(), {})).total, 0);
    const invalid = JSON.parse(JSON.stringify(events[0].envelope));
    invalid.payload.metadata.recallId = randomUUID();
    assert.equal(eventSchema.safeParse(invalid).success, false);
  },
);
test('Phase 13: reference client rejects cross-tenant responses, failures and malformed references', async (t) => {
  const who = identity(),
    s = scope();
  let mode = 'wrong-org';
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'timeout') return;
    if (mode === 'failure') {
      res.statusCode = 500;
      res.end('{"private":"secret"}');
      return;
    }
    if (mode === 'missing') {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    res.end(
      JSON.stringify(
        mode === 'malformed'
          ? {}
          : {
              id: s.productId,
              organizationId: randomUUID(),
              name: 'Other tenant',
              status: 'ACTIVE',
            },
      ),
    );
  });
  const url = await listen(server);
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const refs = new ReferenceClient(
    new ConfigService({
      PRODUCT_SERVICE_URL: url,
      INTERNAL_IDENTITY_SECRET: 'x'.repeat(40),
      REFERENCE_TIMEOUT_MS: 1000,
    }),
  );
  for (const [m, status] of [
    ['wrong-org', 502],
    ['malformed', 502],
    ['missing', 404],
    ['failure', 503],
    ['timeout', 504],
  ]) {
    mode = m;
    await assert.rejects(refs.scope(s, who), statusError(status));
  }
});
test('Phase 13: Recall configuration enforces Kafka and required reference origins', () => {
  const settings = { ...env('recall') };
  assert.equal(validateRecallEnvironment(settings).PORT, 3009);
  assert.throws(() =>
    validateRecallEnvironment({ ...settings, EVENT_TRANSPORT: 'http' }),
  );
  assert.throws(() =>
    validateRecallEnvironment({
      ...settings,
      PRODUCT_SERVICE_URL: 'ftp://example.com',
    }),
  );
  assert.throws(() =>
    validateGatewayEnvironment({
      AUTH_SERVICE_URL: 'http://localhost:3001',
      RECALL_SERVICE_URL: 'http://localhost:3009',
    }),
  );
});
