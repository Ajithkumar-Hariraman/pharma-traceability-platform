const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const { URL } = require('node:url');
const { randomUUID, createHmac } = require('node:crypto');
const path = require('node:path');
const {
  ConfigService,
} = require('../services/organization-service/node_modules/@nestjs/config');
const {
  PrismaService,
} = require('../services/organization-service/dist/persistence/prisma.service');
const {
  PrismaService: AuthPrisma,
} = require('../services/auth-service/dist/persistence/prisma.service');
const {
  PrismaService: ProductPrisma,
} = require('../services/product-service/dist/persistence/prisma.service');
const productEnv = parseEnv(
  readFileSync(
    path.resolve(__dirname, '../services/product-service/.env'),
    'utf8',
  ),
);
const {
  PrismaService: BatchPrisma,
} = require('../services/batch-service/dist/persistence/prisma.service');
const batchEnv = parseEnv(
  readFileSync(
    path.resolve(__dirname, '../services/batch-service/.env'),
    'utf8',
  ),
);
const {
  validateBatchEnvironment,
  validateSerializationEnvironment,
  validateOrganizationEnvironment,
  validateAuthEnvironment,
} = require('../packages/config/dist');
const env = parseEnv(
  readFileSync(
    path.resolve(__dirname, '../services/organization-service/.env'),
    'utf8',
  ),
);
const authEnv = parseEnv(
  readFileSync(
    path.resolve(__dirname, '../services/auth-service/.env'),
    'utf8',
  ),
);
async function start(t, folder, port, extra) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: path.resolve(__dirname, '..', folder),
    env: {
      ...process.env,
      ...extra,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  });
  for (let i = 0; i < 200; i++) {
    assert.equal(child.exitCode, null, output);
    try {
      if (
        (
          await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      )
        return child;
    } catch {
      /* Starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(output || 'Startup timed out');
}

const {
  PrismaService: SerialPrisma,
} = require('../services/serialization-service/dist/persistence/prisma.service');
const serialEnv = parseEnv(
  readFileSync(
    path.resolve(__dirname, '../services/serialization-service/.env'),
    'utf8',
  ),
);

test('serialization configuration requires owned DB, Batch service origin and bounded timeout', () => {
  assert.equal(validateSerializationEnvironment(serialEnv).PORT, 3005);
  for (const input of [
    { ...serialEnv, BATCH_SERVICE_TIMEOUT_MS: '0' },
    { ...serialEnv, BATCH_SERVICE_TIMEOUT_MS: '30001' },
    { ...serialEnv, BATCH_SERVICE_URL: 'http://user:secret@example.com' },
    { ...serialEnv, BATCH_SERVICE_URL: 'http://example.com/path' },
    { ...serialEnv, DATABASE_URL: 'http://example.com' },
  ])
    assert.throws(() => validateSerializationEnvironment(input));
});
test(
  'real serialization flow derives references, creates atomically and enforces roles, lifecycle and isolation',
  { timeout: 60000 },
  async (t) => {
    const org = new PrismaService(
      new ConfigService(validateOrganizationEnvironment(env)),
    );
    const auth = new AuthPrisma(
      new ConfigService(validateAuthEnvironment(authEnv)),
    );
    const product = new ProductPrisma(new ConfigService(productEnv));
    const batch = new BatchPrisma(
      new ConfigService(validateBatchEnvironment(batchEnv)),
    );
    const serial = new SerialPrisma(
      new ConfigService(validateSerializationEnvironment(serialEnv)),
    );
    await Promise.all([
      org.onModuleInit(),
      auth.onModuleInit(),
      product.onModuleInit(),
      batch.onModuleInit(),
      serial.onModuleInit(),
    ]);
    const ids = [];
    const suffix = randomUUID();
    const emails = ['admin', 'operator', 'viewer'].map(
      (role) => `phase7-${role}-${suffix}@example.com`,
    );
    t.after(async () => {
      try {
        await serial.serializedItem.deleteMany({
          where: { organizationId: { in: ids } },
        });
        await batch.batch.deleteMany({
          where: { organizationId: { in: ids } },
        });
        await product.gTIN.deleteMany({
          where: { organizationId: { in: ids } },
        });
        await product.product.deleteMany({
          where: { organizationId: { in: ids } },
        });
        await org.organization.deleteMany({ where: { id: { in: ids } } });
        await auth.user.deleteMany({ where: { email: { in: emails } } });
      } finally {
        await Promise.all([
          org.onModuleDestroy(),
          auth.onModuleDestroy(),
          product.onModuleDestroy(),
          batch.onModuleDestroy(),
          serial.onModuleDestroy(),
        ]);
      }
    });
    await start(t, 'services/auth-service', 13301, authEnv);
    await start(t, 'services/organization-service', 13302, env);
    await start(t, 'services/product-service', 13303, productEnv);
    const batchChild = await start(t, 'services/batch-service', 13304, {
      ...batchEnv,
      PRODUCT_SERVICE_URL: 'http://127.0.0.1:13303',
    });
    const traceEnv = parseEnv(
      readFileSync(
        path.resolve(__dirname, '../services/traceability-service/.env'),
        'utf8',
      ),
    );
    await start(t, 'services/traceability-service', 13307, traceEnv);
    const serialChild = await start(
      t,
      'services/serialization-service',
      13305,
      {
        ...serialEnv,
        BATCH_SERVICE_URL: 'http://127.0.0.1:13304',
        TRACEABILITY_SERVICE_URL: 'http://127.0.0.1:13307',
        TRACE_CAPTURE_SECRET: traceEnv.TRACE_CAPTURE_SECRET,
      },
    );
    await start(t, 'apps/api-gateway', 13300, {
      AUTH_SERVICE_URL: 'http://127.0.0.1:13301',
      ORGANIZATION_SERVICE_URL: 'http://127.0.0.1:13302',
      PRODUCT_SERVICE_URL: 'http://127.0.0.1:13303',
      BATCH_SERVICE_URL: 'http://127.0.0.1:13304',
      SERIALIZATION_SERVICE_URL: 'http://127.0.0.1:13305',
      TRACEABILITY_SERVICE_URL: 'http://127.0.0.1:13307',
      INTERNAL_IDENTITY_SECRET: env.INTERNAL_IDENTITY_SECRET,
      AUTH_SERVICE_TIMEOUT_MS: '5000',
    });
    const call = (route, method = 'GET', body, token, extra = {}) =>
      fetch(`http://127.0.0.1:13300/api${route}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const login = async (email) => {
      const registered = await call('/auth/register', 'POST', {
        email,
        password: 'secure phase seven password',
      });
      assert.equal(registered.status, 201);
      const user = await registered.json();
      const logged = await call('/auth/login', 'POST', {
        email,
        password: 'secure phase seven password',
      });
      assert.equal(logged.status, 200);
      return { user, token: (await logged.json()).accessToken };
    };
    const [admin, operator, viewer] = await Promise.all(emails.map(login));
    for (const name of [
      'Serialization pharma',
      'Foreign serialization pharma',
    ]) {
      const res = await call(
        '/organizations',
        'POST',
        { legalName: name },
        admin.token,
      );
      assert.equal(res.status, 201);
      ids.push((await res.json()).id);
    }
    for (const [user, role] of [
      [operator, 'OPERATOR'],
      [viewer, 'VIEWER'],
    ])
      await org.membership.create({
        data: { organizationId: ids[0], userId: user.user.id, role },
      });
    const base = `/organizations/${ids[0]}`,
      other = `/organizations/${ids[1]}`;
    const makeProduct = async (base) => {
      const res = await call(
        `${base}/products`,
        'POST',
        { name: 'Serialized medicine' },
        admin.token,
      );
      assert.equal(res.status, 201);
      return res.json();
    };
    const p = await makeProduct(base),
      fp = await makeProduct(other);
    let sequence = 0;
    const makeGtin = async (base, p) => {
      const digits = (
        BigInt('0x' + suffix.replaceAll('-', '').slice(0, 12)) +
        BigInt(sequence++)
      )
        .toString()
        .padStart(13, '0')
        .slice(-13);
      let sum = 0;
      for (let i = 12, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3)
        sum += Number(digits[i]) * w;
      const gtin = digits + ((10 - (sum % 10)) % 10);
      const res = await call(
        `${base}/products/${p.id}/gtins`,
        'POST',
        { gtin, packagingLevel: 'EACH' },
        admin.token,
      );
      assert.equal(res.status, 201);
      return res.json();
    };
    const g = await makeGtin(base, p),
      g2 = await makeGtin(base, p),
      fg = await makeGtin(other, fp);
    const makeBatch = async (base, p, g, lotNumber) => {
      const res = await call(
        `${base}/products/${p.id}/gtins/${g.id}/batches`,
        'POST',
        { lotNumber },
        admin.token,
      );
      assert.equal(res.status, 201);
      return res.json();
    };
    const b = await makeBatch(base, p, g, 'Serial lot'),
      b2 = await makeBatch(base, p, g, 'Second lot same GTIN'),
      b3 = await makeBatch(base, p, g2, 'Other GTIN lot'),
      fb = await makeBatch(other, fp, fg, 'Foreign lot');
    const nested = `${base}/batches/${b.id}/serials`,
      nested2 = `${base}/batches/${b2.id}/serials`,
      nested3 = `${base}/batches/${b3.id}/serials`;
    const itemPath = (id) => `${base}/serials/${id}`;
    assert.equal((await call(nested)).status, 401);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:13305${nested}`, {
          headers: {
            'x-identity-user': admin.user.id,
            'x-identity-organization': ids[0],
            'x-identity-role': 'ORG_ADMIN',
          },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call(nested, 'POST', { serialNumber: 'Denied' }, viewer.token, {
          'x-identity-role': 'ORG_ADMIN',
        })
      ).status,
      403,
    );
    for (const input of [
      { serialNumber: '' },
      { serialNumber: ' ' },
      { serialNumber: 'x'.repeat(101) },
      { serialNumber: 123 },
      { serialNumber: 'bad\u0000value' },
      { serialNumber: 'S', productId: fp.id },
      { serialNumber: 'S', gtinId: fg.id },
      { serialNumber: 'S', status: 'COMMISSIONED' },
    ])
      assert.equal(
        (await call(nested, 'POST', input, admin.token)).status,
        400,
      );
    const created = await call(
      nested,
      'POST',
      { serialNumber: '  000123Ab  ' },
      admin.token,
    );
    assert.equal(created.status, 201);
    const item = await created.json();
    assert.equal(item.serialNumber, '000123Ab');
    assert.equal(item.status, 'CREATED');
    assert.equal(item.organizationId, ids[0]);
    assert.equal(item.productId, p.id);
    assert.equal(item.gtinId, g.id);
    assert.equal(item.batchId, b.id);
    assert.equal(item.commissionedAt, null);
    assert.equal(item.decommissionedAt, null);
    assert.equal(
      (
        await call(
          nested2,
          'POST',
          { serialNumber: '000123Ab' },
          operator.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          nested3,
          'POST',
          { serialNumber: '000123Ab' },
          operator.token,
        )
      ).status,
      201,
    );
    // Case is preserved and distinct within a GTIN.
    assert.equal(
      (await call(nested, 'POST', { serialNumber: '000123ab' }, operator.token))
        .status,
      201,
    );
    const bulk = await call(
      `${nested}/bulk`,
      'POST',
      { serialNumbers: ['BULK-001', '  BULK-002  ', 'BULK-003'] },
      operator.token,
    );
    assert.equal(bulk.status, 201);
    const bulkRows = await bulk.json();
    assert.equal(bulkRows.length, 3);
    assert.ok(
      bulkRows.every((row) => row.status === 'CREATED' && row.batchId === b.id),
    );
    assert.ok(bulkRows.some((row) => row.serialNumber === 'BULK-002'));
    const before = await serial.serializedItem.count({
      where: { organizationId: ids[0] },
    });
    for (const input of [
      { serialNumbers: [] },
      { serialNumbers: Array.from({ length: 101 }, (_, i) => `MAX-${i}`) },
      { serialNumbers: [1] },
      { serialNumbers: 'bad' },
      { serialNumbers: ['ok', ' '] },
      { serialNumbers: ['ok'], batchId: fb.id },
    ])
      assert.equal(
        (await call(`${nested}/bulk`, 'POST', input, operator.token)).status,
        400,
      );
    assert.equal(
      (
        await call(
          `${nested}/bulk`,
          'POST',
          { serialNumbers: ['DUP', ' DUP '] },
          admin.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          `${nested}/bulk`,
          'POST',
          { serialNumbers: ['ROLLBACK-NEW', '000123Ab', 'ROLLBACK-NEW-2'] },
          admin.token,
        )
      ).status,
      409,
    );
    assert.equal(
      await serial.serializedItem.count({ where: { organizationId: ids[0] } }),
      before,
    );
    assert.equal(
      await serial.serializedItem.count({
        where: {
          serialNumber: { startsWith: 'ROLLBACK' },
          organizationId: ids[0],
        },
      }),
      0,
    );
    for (const user of [admin, operator, viewer]) {
      const list = await call(nested, 'GET', undefined, user.token);
      assert.equal(list.status, 200);
      assert.equal((await list.json()).length, 5);
      assert.equal(
        (await call(itemPath(item.id), 'GET', undefined, user.token)).status,
        200,
      );
    }
    assert.deepEqual(
      await (await call(nested2, 'GET', undefined, admin.token)).json(),
      [],
    );
    for (const route of [
      `${base}/batches/${randomUUID()}/serials`,
      `${base}/batches/${fb.id}/serials`,
    ]) {
      assert.equal(
        (await call(route, 'POST', { serialNumber: 'Missing' }, operator.token))
          .status,
        404,
      );
      assert.equal(
        (await call(route, 'GET', undefined, viewer.token)).status,
        404,
      );
    }
    assert.equal(
      (await call(`${other}/serials/${item.id}`, 'GET', undefined, admin.token))
        .status,
      404,
    );
    assert.equal(
      (
        await call(
          `${other}/serials/${item.id}/commission`,
          'POST',
          {},
          admin.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          `${other}/batches/${b.id}/serials`,
          'POST',
          { serialNumber: 'Cross' },
          admin.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          `${other}/batches/${fb.id}/serials`,
          'GET',
          undefined,
          operator.token,
        )
      ).status,
      403,
    );
    assert.equal(
      (await call(itemPath(randomUUID()), 'GET', undefined, admin.token))
        .status,
      404,
    );
    for (const user of [admin, operator])
      assert.equal(
        (
          await call(
            itemPath(item.id),
            'PATCH',
            { status: 'COMMISSIONED' },
            user.token,
          )
        ).status,
        400,
      );
    for (const route of [
      nested,
      `${nested}/bulk`,
      `${itemPath(item.id)}/commission`,
      `${itemPath(item.id)}/decommission`,
      `${itemPath(item.id)}/quarantine`,
    ])
      assert.equal(
        (
          await call(
            route,
            'POST',
            route === nested
              ? { serialNumber: 'Denied' }
              : route.endsWith('bulk')
                ? { serialNumbers: ['Denied'] }
                : {},
            viewer.token,
          )
        ).status,
        403,
      );
    assert.equal(
      (
        await call(
          itemPath(item.id),
          'PATCH',
          { serialNumber: 'Denied' },
          viewer.token,
        )
      ).status,
      403,
    );
    assert.equal(
      (await call(`${itemPath(item.id)}/decommission`, 'POST', {}, admin.token))
        .status,
      409,
    );
    assert.equal(
      (
        await call(
          `${itemPath(item.id)}/commission`,
          'POST',
          { status: 'QUARANTINED' },
          operator.token,
        )
      ).status,
      400,
    );
    // Batch status is checked from its owning API, including for commissioning.
    for (const status of ['QUARANTINED', 'EXPIRED', 'RECALLED', 'CLOSED']) {
      assert.equal(
        (
          await call(
            `${base}/batches/${b.id}`,
            'PATCH',
            { status },
            admin.token,
          )
        ).status,
        200,
      );
      for (const [route, body] of [
        [nested, { serialNumber: `Blocked-${status}` }],
        [`${nested}/bulk`, { serialNumbers: [`Bulk-blocked-${status}`] }],
        [`${itemPath(item.id)}/commission`, {}],
      ])
        assert.equal(
          (await call(route, 'POST', body, operator.token)).status,
          409,
        );
      assert.equal(
        (await call(nested, 'GET', undefined, viewer.token)).status,
        200,
      );
    }
    assert.equal(
      (
        await call(
          `${base}/batches/${b.id}`,
          'PATCH',
          { status: 'ACTIVE' },
          admin.token,
        )
      ).status,
      200,
    );
    const concurrent = await Promise.all([
      call(`${itemPath(item.id)}/commission`, 'POST', {}, operator.token),
      call(`${itemPath(item.id)}/commission`, 'POST', {}, admin.token),
    ]);
    assert.deepEqual(concurrent.map((res) => res.status).sort(), [201, 409]);
    const commissioned = await (
      await call(itemPath(item.id), 'GET', undefined, viewer.token)
    ).json();
    assert.equal(commissioned.status, 'COMMISSIONED');
    assert.ok(commissioned.commissionedAt);
    assert.equal(commissioned.decommissionedAt, null);
    assert.equal(
      (await call(`${itemPath(item.id)}/commission`, 'POST', {}, admin.token))
        .status,
      409,
    );
    assert.equal(
      (
        await call(
          `${itemPath(item.id)}/decommission`,
          'POST',
          {},
          operator.token,
        )
      ).status,
      403,
    );
    const decommissionedRes = await call(
      `${itemPath(item.id)}/decommission`,
      'POST',
      {},
      admin.token,
    );
    assert.equal(decommissionedRes.status, 201);
    const decommissioned = await decommissionedRes.json();
    assert.equal(decommissioned.status, 'DECOMMISSIONED');
    assert.equal(decommissioned.commissionedAt, commissioned.commissionedAt);
    assert.ok(decommissioned.decommissionedAt);
    assert.ok(decommissioned.decommissionedAt >= decommissioned.commissionedAt);
    for (const command of ['commission', 'decommission', 'quarantine'])
      assert.equal(
        (await call(`${itemPath(item.id)}/${command}`, 'POST', {}, admin.token))
          .status,
        409,
      );
    // Quarantine is a dedicated operational command and retains commissioning history.
    const q = bulkRows[0];
    const quarantined = await call(
      `${itemPath(q.id)}/quarantine`,
      'POST',
      {},
      operator.token,
    );
    assert.equal(quarantined.status, 201);
    assert.equal((await quarantined.json()).status, 'QUARANTINED');
    assert.equal(
      (await call(`${itemPath(q.id)}/commission`, 'POST', {}, admin.token))
        .status,
      409,
    );
    const q2 = bulkRows[1];
    assert.equal(
      (await call(`${itemPath(q2.id)}/commission`, 'POST', {}, admin.token))
        .status,
      201,
    );
    const q2response = await call(
      `${itemPath(q2.id)}/quarantine`,
      'POST',
      {},
      admin.token,
    );
    assert.equal(q2response.status, 201);
    const quarantined2 = await q2response.json();
    assert.ok(quarantined2.commissionedAt);
    assert.equal(quarantined2.decommissionedAt, null);
    // Operational commands synchronously create tenant-scoped trace history through Gateway.
    for (const member of [admin, operator, viewer]) {
      const historyResponse = await call(
        `${base}/trace/serials/${item.id}`,
        'GET',
        undefined,
        member.token,
      );
      assert.equal(historyResponse.status, 200);
      const history = await historyResponse.json();
      assert.deepEqual(
        history.items.map((event) => event.businessStep),
        ['commissioning', 'decommissioning'],
      );
      assert(
        history.items.every(
          (event) => event.batchId === b.id && event.organizationId === ids[0],
        ),
      );
    }
    const quarantineHistory = await (
      await call(
        `${base}/trace/serials/${q.id}`,
        'GET',
        undefined,
        viewer.token,
      )
    ).json();
    assert.equal(quarantineHistory.items[0].businessStep, 'holding');
    assert.equal(quarantineHistory.items[0].disposition, 'quarantined');
    // No cross-service database access is possible with serialization credentials.
    const {
      PrismaClient,
    } = require('../services/serialization-service/generated/client');
    for (const db of ['auth', 'organization', 'product', 'batch']) {
      const url = new URL(serialEnv.DATABASE_URL);
      url.pathname = `/${db}`;
      const denied = new PrismaClient({
        datasources: { db: { url: url.toString() } },
      });
      try {
        await assert.rejects(denied.$connect());
      } finally {
        await denied.$disconnect();
      }
    }
    const batchExit = once(batchChild, 'exit');
    batchChild.kill('SIGTERM');
    await batchExit;
    for (const [route, body] of [
      [nested, { serialNumber: 'Downstream-failed' }],
      [`${nested}/bulk`, { serialNumbers: ['Downstream-bulk'] }],
      [`${itemPath(bulkRows[2].id)}/commission`, {}],
    ]) {
      const res = await call(route, 'POST', body, operator.token);
      assert.equal(res.status, 503);
      assert.doesNotMatch(await res.text(), /password|postgresql|SECRET/);
    }
    assert.equal(
      (await call(nested, 'GET', undefined, viewer.token)).status,
      503,
    );
    assert.equal(
      (await call(itemPath(item.id), 'GET', undefined, viewer.token)).status,
      200,
    );
    assert.equal(
      await serial.serializedItem.count({
        where: {
          organizationId: ids[0],
          serialNumber: { startsWith: 'Downstream' },
        },
      }),
      0,
    );
    const serialExit = once(serialChild, 'exit');
    serialChild.kill('SIGTERM');
    await serialExit;
    assert.equal(
      (await call(itemPath(item.id), 'GET', undefined, admin.token)).status,
      503,
    );
  },
);
test('serialization gateway sanitizes errors, validates upstream responses, signs identity and handles timeouts', async () => {
  const {
    SerializationProxy,
  } = require('../apps/api-gateway/dist/serialization/serialization-proxy');
  const { productIdentityPayload } = require('../packages/contracts/dist');
  const organizationId = randomUUID();
  const route = `/organizations/${organizationId}/batches/${randomUUID()}/serials`;
  const { createServer } = require('node:http');
  let mode = 'error';
  const userId = randomUUID();
  const server = createServer((req, res) => {
    assert.equal(req.url, route);
    assert.equal(req.headers['x-identity-organization'], organizationId);
    assert.equal(req.headers['x-identity-role'], 'ORG_ADMIN');
    assert.equal(req.headers['x-identity-user'], userId);
    const expected = createHmac('sha256', env.INTERNAL_IDENTITY_SECRET)
      .update(
        productIdentityPayload(
          'GET',
          route,
          req.headers['x-identity-time'],
          userId,
          '',
          organizationId,
          'ORG_ADMIN',
        ),
      )
      .digest('hex');
    assert.equal(req.headers['x-identity-signature'], expected);
    if (mode === 'timeout') return;
    if (mode === 'body-timeout') {
      res.writeHead(200);
      res.write('[');
      return;
    }
    if (mode === 'invalid') {
      res.end('{"secret":"credentials"}');
      return;
    }
    if (mode === 'valid') {
      res.end('[]');
      return;
    }
    res.writeHead(mode === 'forbidden' ? 403 : 500);
    res.end('secret database credentials');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const proxy = new SerializationProxy(
      new ConfigService({
        SERIALIZATION_SERVICE_URL: `http://127.0.0.1:${server.address().port}`,
        INTERNAL_IDENTITY_SECRET: env.INTERNAL_IDENTITY_SECRET,
        AUTH_SERVICE_TIMEOUT_MS: 100,
      }),
      { forward: async () => ({ organizationId, userId, role: 'ORG_ADMIN' }) },
    );
    for (const [next, status] of [
      ['error', 502],
      ['forbidden', 403],
      ['invalid', 502],
      ['timeout', 504],
      ['body-timeout', 504],
    ]) {
      mode = next;
      await assert.rejects(proxy.forward('GET', route, userId), (error) => {
        assert.equal(error.getStatus(), status);
        assert.doesNotMatch(
          JSON.stringify(error.getResponse()),
          /secret|database/,
        );
        return true;
      });
    }
    mode = 'valid';
    assert.deepEqual(await proxy.forward('GET', route, userId), []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('Batch validation client signs requests, verifies ownership and bounds downstream failures', async () => {
  const {
    BatchValidationClient,
  } = require('../services/serialization-service/dist/batch-validation.client');
  const { productIdentityPayload } = require('../packages/contracts/dist');
  const { createServer } = require('node:http');
  const organizationId = randomUUID(),
    batchId = randomUUID(),
    productId = randomUUID(),
    gtinId = randomUUID(),
    userId = randomUUID();
  let mode = 'valid';
  const server = createServer((req, res) => {
    const route = `/internal/organizations/${organizationId}/batches/${batchId}/validation`;
    assert.equal(req.url, route);
    assert.equal(req.headers['x-identity-role'], 'OPERATOR');
    const expected = createHmac('sha256', serialEnv.INTERNAL_IDENTITY_SECRET)
      .update(
        productIdentityPayload(
          'GET',
          route,
          req.headers['x-identity-time'],
          userId,
          '',
          organizationId,
          'OPERATOR',
        ),
      )
      .digest('hex');
    assert.equal(req.headers['x-identity-signature'], expected);
    if (mode === 'timeout') return;
    if (mode === 'body-timeout') {
      res.writeHead(200);
      res.write('{');
      return;
    }
    if (mode === 'error' || mode === 'missing') {
      res.writeHead(mode === 'missing' ? 404 : 500);
      res.end('secret database credentials');
      return;
    }
    if (mode === 'invalid') {
      res.end('{"secret":"password"}');
      return;
    }
    res.end(
      JSON.stringify({
        organizationId: mode === 'cross-org' ? randomUUID() : organizationId,
        batchId: mode === 'mismatch' ? randomUUID() : batchId,
        productId,
        gtinId,
        status: 'ACTIVE',
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new BatchValidationClient(
    new ConfigService({
      ...serialEnv,
      BATCH_SERVICE_URL: `http://127.0.0.1:${server.address().port}`,
      BATCH_SERVICE_TIMEOUT_MS: 100,
    }),
  );
  try {
    const reference = await client.validate(
      organizationId,
      batchId,
      userId,
      'OPERATOR',
    );
    assert.equal(reference.productId, productId);
    assert.equal(reference.gtinId, gtinId);
    for (const [next, status] of [
      ['error', 503],
      ['missing', 404],
      ['invalid', 502],
      ['mismatch', 502],
      ['cross-org', 502],
      ['timeout', 504],
      ['body-timeout', 504],
    ]) {
      mode = next;
      await assert.rejects(
        client.validate(organizationId, batchId, userId, 'OPERATOR'),
        (error) => {
          assert.equal(error.getStatus(), status);
          assert.doesNotMatch(
            JSON.stringify(error.getResponse()),
            /password|secret|credentials/,
          );
          return true;
        },
      );
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await assert.rejects(
    client.validate(organizationId, batchId, userId, 'OPERATOR'),
    (error) => error.getStatus() === 503,
  );
});
test('serialization signed context and centralized command permissions prevent spoofing', () => {
  const { Buffer } = require('node:buffer');
  const {
    InternalIdentityGuard,
  } = require('../services/serialization-service/dist/authorization');
  const { productIdentityPayload } = require('../packages/contracts/dist');
  const organizationId = randomUUID(),
    userId = randomUUID(),
    serialId = randomUUID();
  const make = (role, command = 'commission') => {
    const path = `/organizations/${organizationId}/serials/${serialId}/${command}`;
    const time = String(Date.now());
    return {
      method: 'POST',
      originalUrl: path,
      rawBody: Buffer.from('{}'),
      params: { organizationId },
      headers: {
        'x-identity-user': userId,
        'x-identity-organization': organizationId,
        'x-identity-role': role,
        'x-identity-time': time,
        'x-identity-signature': createHmac(
          'sha256',
          serialEnv.INTERNAL_IDENTITY_SECRET,
        )
          .update(
            productIdentityPayload(
              'POST',
              path,
              time,
              userId,
              '{}',
              organizationId,
              role,
            ),
          )
          .digest('hex'),
      },
    };
  };
  const context = (req) => ({
    switchToHttp: () => ({ getRequest: () => req }),
  });
  const guard = new InternalIdentityGuard(new ConfigService(serialEnv));
  assert.equal(guard.canActivate(context(make('OPERATOR'))), true);
  assert.equal(
    guard.canActivate(context(make('ORG_ADMIN', 'decommission'))),
    true,
  );
  assert.throws(
    () => guard.canActivate(context(make('OPERATOR', 'decommission'))),
    (error) => error.getStatus() === 403,
  );
  assert.throws(
    () => guard.canActivate(context(make('VIEWER'))),
    (error) => error.getStatus() === 403,
  );
  for (const mutate of [
    (req) => {
      req.headers['x-identity-role'] = 'ORG_ADMIN';
    },
    (req) => {
      req.headers['x-identity-organization'] = randomUUID();
    },
    (req) => {
      req.rawBody = Buffer.from('{"status":"COMMISSIONED"}');
    },
    (req) => {
      req.headers['x-identity-time'] = String(Date.now() - 60000);
    },
  ]) {
    const req = make('OPERATOR');
    mutate(req);
    assert.throws(
      () => guard.canActivate(context(req)),
      (error) => error.getStatus() === 401,
    );
  }
});
test('serial forms preserve string identity and validate bounded distinct bulk lines', () => {
  const ts = require('typescript');
  const Module = require('node:module');
  const filename = path.resolve(__dirname, '../apps/web/src/serial-forms.ts');
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  module._compile(compiled, filename);
  const { serialSchema, bulkSerialSchema, serialLines } = module.exports;
  assert.equal(
    serialSchema.safeParse({ serialNumber: '000AbC' }).success,
    true,
  );
  for (const input of ['', ' ', 'x'.repeat(101), 123])
    assert.equal(
      serialSchema.safeParse({ serialNumber: input }).success,
      false,
    );
  assert.deepEqual(serialLines(' 000AbC \r\n\r\n abc\n'), ['000AbC', 'abc']);
  assert.equal(bulkSerialSchema.safeParse({ lines: 'A\nB\n' }).success, true);
  for (const lines of [
    '',
    'A\n A ',
    Array.from({ length: 101 }, (_, i) => `S-${i}`).join('\n'),
  ])
    assert.equal(bulkSerialSchema.safeParse({ lines }).success, false);
});
