const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const {
  ConfigService,
} = require('../services/aggregation-service/node_modules/@nestjs/config');
const {
  PrismaService,
} = require('../services/aggregation-service/dist/persistence/prisma.service');
const {
  AggregationService,
} = require('../services/aggregation-service/dist/aggregation.service');
const {
  InternalIdentityGuard,
} = require('../services/aggregation-service/dist/authorization');
const {
  SerialValidationClient,
} = require('../services/aggregation-service/dist/serial-validation.client');
const {
  AggregationProxy,
} = require('../apps/api-gateway/dist/aggregation/aggregation-proxy');
const { productIdentityPayload } = require('../packages/contracts/dist');
const env = parseEnv(readFileSync('services/aggregation-service/.env', 'utf8'));
test('aggregation database operations, hierarchy, tenant isolation and races', async (t) => {
  const db = new PrismaService(new ConfigService(env));
  await db.$connect();
  const org = randomUUID(),
    user = randomUUID(),
    other = randomUUID();
  t.after(async () => {
    await db.aggregationRelation.deleteMany({ where: { organizationId: org } });
    await db.aggregateContainer.deleteMany({ where: { organizationId: org } });
    await db.$disconnect();
  });
  let status = 'COMMISSIONED',
    unavailable = false;
  const service = new AggregationService(db, {
    validate: async (o, id) => {
      if (unavailable)
        throw Object.assign(new Error('Unavailable'), { status: 503 });
      if (o !== org)
        throw Object.assign(new Error('Not found'), { status: 404 });
      return {
        id,
        organizationId: o,
        productId: randomUUID(),
        gtinId: randomUUID(),
        batchId: randomUUID(),
        serialNumber: '00001',
        status,
      };
    },
  });
  const make = (level) =>
    service.create(org, {
      containerCode: `000-${level}`,
      packagingLevel: level,
    });
  const inner = await make('INNER'),
    box = await make('CASE'),
    pallet = await make('PALLET');
  await assert.rejects(make('INNER'), (e) => e.status === 409);
  await assert.rejects(
    service.create(org, { containerCode: ' ', packagingLevel: 'INNER' }),
    (e) => e.status === 400,
  );
  const item = randomUUID();
  const change = (parent, kind, id, remove = false) =>
    service.change(org, parent.id, kind, id, remove, user, 'OPERATOR');
  await change(inner, 'items', item);
  await assert.rejects(change(box, 'items', item), (e) => e.status === 409);
  assert.equal((await service.parent(org, item)).id, inner.id);
  await change(inner, 'items', item, true);
  await change(box, 'items', item);
  await change(box, 'items', item, true);
  await change(inner, 'items', item);
  await change(box, 'containers', inner.id);
  await change(pallet, 'containers', box.id);
  await assert.rejects(
    change(inner, 'containers', box.id),
    (e) => e.status === 409,
  );
  await assert.rejects(
    change(box, 'containers', pallet.id),
    (e) => e.status === 409,
  );
  await assert.rejects(
    change(inner, 'containers', inner.id),
    (e) => e.status === 409,
  );
  await assert.rejects(
    change(pallet, 'containers', inner.id),
    (e) => e.status === 409,
  );
  await assert.rejects(service.get(other, inner.id), (e) => e.status === 404);
  await assert.rejects(
    service.change(
      other,
      box.id,
      'containers',
      inner.id,
      false,
      user,
      'OPERATOR',
    ),
    (e) => e.status === 404,
  );
  const tree = await service.hierarchy(org, pallet.id, user, 'VIEWER');
  assert.equal(tree.children[0].children[0].items[0].id, item);
  status = 'QUARANTINED';
  await assert.rejects(
    change(box, 'items', randomUUID()),
    (e) => e.status === 409,
  );
  status = 'COMMISSIONED';
  await db.aggregateContainer.update({
    where: { id: box.id },
    data: { status: 'CLOSED' },
  });
  await assert.rejects(
    change(box, 'items', randomUUID()),
    (e) => e.status === 409,
  );
  await db.aggregateContainer.update({
    where: { id: box.id },
    data: { status: 'ACTIVE' },
  });
  const racing = randomUUID();
  const results = await Promise.allSettled([
    change(inner, 'items', racing),
    change(box, 'items', racing),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    await db.aggregationRelation.count({
      where: { childSerializedItemId: racing },
    }),
    1,
  );
  unavailable = true;
  await assert.rejects(
    change(inner, 'items', randomUUID()),
    (e) => e.status === 503,
  );
  await assert.rejects(
    db.aggregationRelation.create({
      data: {
        organizationId: org,
        parentContainerId: inner.id,
        childType: 'SERIALIZED_ITEM',
      },
    }),
  );
});
test('signed role authorization and tampering', () => {
  const secret = 'x'.repeat(40),
    user = randomUUID(),
    org = randomUUID();
  const guard = new InternalIdentityGuard(
    new ConfigService({ INTERNAL_IDENTITY_SECRET: secret }),
  );
  for (const role of ['ORG_ADMIN', 'OPERATOR', 'VIEWER'])
    for (const method of ['POST', 'GET']) {
      const timestamp = String(Date.now()),
        url = `/organizations/${org}/aggregates`;
      const signature = createHmac('sha256', secret)
        .update(
          productIdentityPayload(method, url, timestamp, user, '', org, role),
        )
        .digest('hex');
      const req = {
        method,
        originalUrl: url,
        params: { organizationId: org },
        headers: {
          'x-identity-user': user,
          'x-identity-organization': org,
          'x-identity-role': role,
          'x-identity-time': timestamp,
          'x-identity-signature': signature,
        },
      };
      const ctx = { switchToHttp: () => ({ getRequest: () => req }) };
      if (role === 'VIEWER' && method === 'POST')
        assert.throws(
          () => guard.canActivate(ctx),
          (e) => e.status === 403,
        );
      else assert.equal(guard.canActivate(ctx), true);
      req.params.organizationId = randomUUID();
      assert.throws(
        () => guard.canActivate(ctx),
        (e) => e.status === 401,
      );
    }
});
test('gateway forwards signed aggregation commands and sanitizes downstream failures', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const org = randomUUID(),
    user = randomUUID(),
    secret = 's'.repeat(40);
  const proxy = new AggregationProxy(
    new ConfigService({
      AGGREGATION_SERVICE_URL: 'http://aggregation',
      INTERNAL_IDENTITY_SECRET: secret,
      AUTH_SERVICE_TIMEOUT_MS: 100,
    }),
    {
      forward: async () => ({
        organizationId: org,
        userId: user,
        role: 'OPERATOR',
      }),
    },
  );
  const path = `/organizations/${org}/aggregates`,
    body = { containerCode: '0001', packagingLevel: 'INNER' };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `http://aggregation${path}`);
    assert.equal(
      options.headers['x-identity-signature'],
      createHmac('sha256', secret)
        .update(
          productIdentityPayload(
            'POST',
            path,
            options.headers['x-identity-time'],
            user,
            JSON.stringify(body),
            org,
            'OPERATOR',
          ),
        )
        .digest('hex'),
    );
    return globalThis.Response.json({
      id: randomUUID(),
      organizationId: org,
      ...body,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };
  assert.equal(
    (await proxy.forward('POST', path, user, body)).containerCode,
    '0001',
  );
  globalThis.fetch = async () => {
    throw new Error('secret downstream details');
  };
  await assert.rejects(
    proxy.forward('GET', path, user),
    (e) => e.status === 503 && !e.message.includes('secret'),
  );
  const client = new SerialValidationClient(
    new ConfigService({
      SERIALIZATION_SERVICE_URL: 'http://serialization',
      SERIALIZATION_SERVICE_TIMEOUT_MS: 100,
      INTERNAL_IDENTITY_SECRET: secret,
    }),
  );
  await assert.rejects(
    client.validate(org, randomUUID(), user, 'OPERATOR'),
    (e) => e.status === 503,
  );
});

test('aggregation HTTP routes execute signed requests against PostgreSQL', async (t) => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { createServer } = require('node:http');
  const org = randomUUID(),
    user = randomUUID(),
    item = randomUUID();
  const mock = createServer((req, res) => {
    if (req.url === '/auth/me') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: user,
          email: 'operator@example.com',
          status: 'ACTIVE',
        }),
      );
      return;
    }
    if (req.url === `/organizations/${org}/access`) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ organizationId: org, userId: user, role: 'OPERATOR' }),
      );
      return;
    }
    const timestamp = req.headers['x-identity-time'];
    assert.equal(
      req.headers['x-identity-signature'],
      createHmac('sha256', env.INTERNAL_IDENTITY_SECRET)
        .update(
          productIdentityPayload(
            'GET',
            req.url,
            timestamp,
            user,
            '',
            org,
            'OPERATOR',
          ),
        )
        .digest('hex'),
    );
    res.setHeader('Content-Type', 'application/json');
    if (!req.url.endsWith(`/${item}/validation`)) {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    res.end(
      JSON.stringify({
        id: item,
        organizationId: org,
        productId: randomUUID(),
        gtinId: randomUUID(),
        batchId: randomUUID(),
        serialNumber: '000099',
        status: 'COMMISSIONED',
        commissionedAt: new Date().toISOString(),
        decommissionedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => new Promise((resolve) => mock.close(resolve)));
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: 'services/aggregation-service',
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      SERIALIZATION_SERVICE_URL: `http://127.0.0.1:${mock.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk) => (output += chunk));
  child.stdout.on('data', (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGTERM');
      await done;
    }
  });
  const db = new PrismaService(new ConfigService(env));
  t.after(async () => {
    await db.aggregationRelation.deleteMany({ where: { organizationId: org } });
    await db.aggregateContainer.deleteMany({ where: { organizationId: org } });
    await db.$disconnect();
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, output);
    try {
      if ((await globalThis.fetch(`http://127.0.0.1:${port}/ready`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for the test service to listen. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  async function request(method, path, body, role = 'OPERATOR') {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {}),
      timestamp = String(Date.now());
    return globalThis.fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-identity-user': user,
        'x-identity-organization': org,
        'x-identity-role': role,
        'x-identity-time': timestamp,
        'x-identity-signature': createHmac(
          'sha256',
          env.INTERNAL_IDENTITY_SECRET,
        )
          .update(
            productIdentityPayload(
              method,
              path,
              timestamp,
              user,
              raw,
              org,
              role,
            ),
          )
          .digest('hex'),
      },
      ...(method === 'GET' ? {} : { body: raw }),
    });
  }
  const base = `/organizations/${org}/aggregates`;
  let response = await request('POST', base, {
    containerCode: '000-http',
    packagingLevel: 'INNER',
  });
  assert.equal(response.status, 201);
  const inner = await response.json();
  response = await request('POST', `${base}/${inner.id}/items`, {
    serializedItemId: item,
  });
  assert.equal(response.status, 201, await response.text());
  response = await request('GET', `${base}/${inner.id}/hierarchy`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items[0].serialNumber, '000099');
  response = await request(
    'POST',
    base,
    { containerCode: 'viewer', packagingLevel: 'CASE' },
    'VIEWER',
  );
  assert.equal(response.status, 403);
  response = await request('POST', `${base}/${inner.id}/items`, {
    serializedItemId: randomUUID(),
  });
  assert.equal(response.status, 404);
  response = await request('DELETE', `${base}/${inner.id}/items/${item}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: true });
  // Exercise the actual gateway controller, authentication and organization proxy boundary.
  const gatewayListener = createServer();
  gatewayListener.listen(0, '127.0.0.1');
  await once(gatewayListener, 'listening');
  const gatewayPort = gatewayListener.address().port;
  await new Promise((resolve) => gatewayListener.close(resolve));
  const gateway = spawn(process.execPath, ['dist/main.js'], {
    cwd: 'apps/api-gateway',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(gatewayPort),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      AUTH_SERVICE_URL: `http://127.0.0.1:${mock.address().port}`,
      ORGANIZATION_SERVICE_URL: `http://127.0.0.1:${mock.address().port}`,
      AGGREGATION_SERVICE_URL: `http://127.0.0.1:${port}`,
      INTERNAL_IDENTITY_SECRET: env.INTERNAL_IDENTITY_SECRET,
      AUTH_SERVICE_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let gatewayOutput = '';
  gateway.stderr.on('data', (chunk) => (gatewayOutput += chunk));
  gateway.stdout.on('data', (chunk) => (gatewayOutput += chunk));
  t.after(async () => {
    if (gateway.exitCode === null) {
      const done = once(gateway, 'exit');
      gateway.kill('SIGTERM');
      await done;
    }
  });
  let gatewayReady = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(gateway.exitCode, null, gatewayOutput);
    try {
      if (
        (await globalThis.fetch(`http://127.0.0.1:${gatewayPort}/health`)).ok
      ) {
        gatewayReady = true;
        break;
      }
    } catch {
      /* Wait for the gateway listener. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(gatewayReady, gatewayOutput);
  const gatewayBase = `http://127.0.0.1:${gatewayPort}/api${base}`;
  response = await globalThis.fetch(gatewayBase, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].id, inner.id);
  response = await globalThis.fetch(`${gatewayBase}/${inner.id}/items`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ serializedItemId: item }),
  });
  assert.equal(response.status, 201, await response.text());
  response = await globalThis.fetch(`${gatewayBase}/${inner.id}/hierarchy`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items[0].id, item);
  response = await globalThis.fetch(
    `${gatewayBase}/${inner.id}/items/${item}`,
    { method: 'DELETE', headers: { Authorization: 'Bearer test-token' } },
  );
  assert.equal(response.status, 200);
});
