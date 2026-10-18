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

test('batch environment validates Product origin, timeout and owned database', () => {
  assert.equal(validateBatchEnvironment(batchEnv).PORT, 3004);
  for (const input of [
    { ...batchEnv, PRODUCT_SERVICE_TIMEOUT_MS: '0' },
    { ...batchEnv, PRODUCT_SERVICE_TIMEOUT_MS: '30001' },
    { ...batchEnv, PRODUCT_SERVICE_URL: 'https://user:secret@example.com' },
    { ...batchEnv, PRODUCT_SERVICE_URL: 'https://example.com/path' },
    { ...batchEnv, DATABASE_URL: 'http://example.com' },
  ])
    assert.throws(() => validateBatchEnvironment(input));
});
test(
  'real batch gateway flow validates references, dates, uniqueness, role writes and scoped reads',
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
    await Promise.all([
      org.onModuleInit(),
      auth.onModuleInit(),
      product.onModuleInit(),
      batch.onModuleInit(),
    ]);
    const ids = [];
    const suffix = randomUUID();
    const emails = ['admin', 'operator', 'viewer'].map(
      (role) => `phase6-${role}-${suffix}@example.com`,
    );
    t.after(async () => {
      try {
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
        ]);
      }
    });
    await start(t, 'services/auth-service', 13201, authEnv);
    await start(t, 'services/organization-service', 13202, env);
    const productChild = await start(
      t,
      'services/product-service',
      13203,
      productEnv,
    );
    const batchChild = await start(t, 'services/batch-service', 13204, {
      ...batchEnv,
      PRODUCT_SERVICE_URL: 'http://127.0.0.1:13203',
    });
    await start(t, 'apps/api-gateway', 13200, {
      AUTH_SERVICE_URL: 'http://127.0.0.1:13201',
      ORGANIZATION_SERVICE_URL: 'http://127.0.0.1:13202',
      PRODUCT_SERVICE_URL: 'http://127.0.0.1:13203',
      BATCH_SERVICE_URL: 'http://127.0.0.1:13204',
      INTERNAL_IDENTITY_SECRET: env.INTERNAL_IDENTITY_SECRET,
      AUTH_SERVICE_TIMEOUT_MS: '5000',
    });
    const call = (route, method = 'GET', body, token, extra = {}) =>
      fetch(`http://127.0.0.1:13200/api${route}`, {
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
        password: 'secure phase six password',
      });
      assert.equal(registered.status, 201);
      const user = await registered.json();
      const logged = await call('/auth/login', 'POST', {
        email,
        password: 'secure phase six password',
      });
      assert.equal(logged.status, 200);
      return { user, token: (await logged.json()).accessToken };
    };
    const [admin, operator, viewer] = await Promise.all(emails.map(login));
    for (const name of ['Batch pharma', 'Other pharma']) {
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
    const base = `/organizations/${ids[0]}`;
    const other = `/organizations/${ids[1]}`;
    const createProduct = async (base, name) => {
      const res = await call(`${base}/products`, 'POST', { name }, admin.token);
      assert.equal(res.status, 201);
      return res.json();
    };
    const p = await createProduct(base, 'Medicine');
    const p2 = await createProduct(base, 'Other medicine');
    const foreign = await createProduct(other, 'Foreign medicine');
    let sequence = 0;
    const createGtin = async (base, p) => {
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
      const code = digits + ((10 - (sum % 10)) % 10);
      const res = await call(
        `${base}/products/${p.id}/gtins`,
        'POST',
        { gtin: code, packagingLevel: 'EACH' },
        admin.token,
      );
      assert.equal(res.status, 201);
      return res.json();
    };
    const g = await createGtin(base, p);
    const g2 = await createGtin(base, p);
    const fg = await createGtin(other, foreign);
    const nested = `${base}/products/${p.id}/gtins/${g.id}/batches`;
    assert.equal((await call(nested)).status, 401);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:13204${nested}`, {
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
        await call(nested, 'POST', { lotNumber: 'Spoof' }, viewer.token, {
          'x-identity-role': 'ORG_ADMIN',
          'x-identity-user': admin.user.id,
        })
      ).status,
      403,
    );
    for (const input of [
      { lotNumber: ' ' },
      { lotNumber: 'Bad date', manufactureDate: '2026-02-30' },
      { lotNumber: 'Bad date', expiryDate: 'garbage' },
      {
        lotNumber: 'Bad range',
        manufactureDate: '2026-10-06',
        expiryDate: '2026-10-06',
      },
      {
        lotNumber: 'Bad range',
        manufactureDate: '2026-10-06',
        expiryDate: '2026-10-05',
      },
      { lotNumber: 'Bad status', status: 'INVALID' },
      { lotNumber: 'Tampered reference', organizationId: ids[1] },
    ])
      assert.equal(
        (await call(nested, 'POST', input, admin.token)).status,
        400,
      );
    const created = await call(
      nested,
      'POST',
      {
        lotNumber: '  LOT-001  ',
        manufactureDate: '2026-01-01',
        expiryDate: '2027-01-01',
      },
      admin.token,
    );
    assert.equal(created.status, 201);
    const b = await created.json();
    assert.equal(b.lotNumber, 'LOT-001');
    assert.equal(b.status, 'ACTIVE');
    assert.equal(b.manufactureDate, '2026-01-01');
    assert.equal(b.expiryDate, '2027-01-01');
    assert.equal(b.organizationId, ids[0]);
    assert.equal(b.productId, p.id);
    assert.equal(b.gtinId, g.id);
    assert.equal(
      (await call(nested, 'POST', { lotNumber: 'LOT-001' }, admin.token))
        .status,
      409,
    );
    const nested2 = `${base}/products/${p.id}/gtins/${g2.id}/batches`;
    const sameLot = await call(
      nested2,
      'POST',
      { lotNumber: 'LOT-001' },
      operator.token,
    );
    assert.equal(sameLot.status, 201);
    const b2 = await sameLot.json();
    assert.equal(b2.manufactureDate, null);
    const operatorCreate = await call(
      nested,
      'POST',
      { lotNumber: 'Operator lot' },
      operator.token,
    );
    assert.equal(operatorCreate.status, 201);
    const opBatch = await operatorCreate.json();
    for (const route of [
      `${base}/products/${p2.id}/gtins/${g.id}/batches`,
      `${base}/products/${p.id}/gtins/${fg.id}/batches`,
      `${base}/products/${foreign.id}/gtins/${fg.id}/batches`,
      `${base}/products/${randomUUID()}/gtins/${g.id}/batches`,
      `${base}/products/${p.id}/gtins/${randomUUID()}/batches`,
    ]) {
      assert.equal(
        (
          await call(
            route,
            'POST',
            { lotNumber: 'Invalid reference' },
            admin.token,
          )
        ).status,
        404,
      );
      assert.equal(
        (await call(route, 'GET', undefined, admin.token)).status,
        404,
      );
    }
    assert.equal(
      (await call(`${other}/batches/${b.id}`, 'GET', undefined, admin.token))
        .status,
      404,
    );
    assert.equal(
      (
        await call(
          `${other}/batches/${b.id}`,
          'PATCH',
          { status: 'CLOSED' },
          admin.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (await call(`${other}/batches`, 'GET', undefined, viewer.token)).status,
      403,
    );
    assert.deepEqual(
      await (
        await call(`${other}/batches`, 'GET', undefined, admin.token)
      ).json(),
      [],
    );
    for (const user of [admin, operator, viewer]) {
      const list = await call(nested, 'GET', undefined, user.token);
      assert.equal(list.status, 200);
      assert.deepEqual(
        (await list.json()).map((row) => row.id),
        [b.id, opBatch.id],
      );
      const all = await call(`${base}/batches`, 'GET', undefined, user.token);
      assert.equal(all.status, 200);
      assert.equal((await all.json()).length, 3);
      assert.equal(
        (await call(`${base}/batches/${b.id}`, 'GET', undefined, user.token))
          .status,
        200,
      );
    }
    assert.equal(
      (await call(nested, 'POST', { lotNumber: 'Denied' }, viewer.token))
        .status,
      403,
    );
    assert.equal(
      (
        await call(
          `${base}/batches/${b.id}`,
          'PATCH',
          { status: 'CLOSED' },
          viewer.token,
        )
      ).status,
      403,
    );
    for (const [user, status] of [
      [operator, 'QUARANTINED'],
      [admin, 'EXPIRED'],
      [operator, 'RECALLED'],
      [admin, 'CLOSED'],
      [operator, 'ACTIVE'],
    ]) {
      const res = await call(
        `${base}/batches/${b.id}`,
        'PATCH',
        { status },
        user.token,
      );
      assert.equal(res.status, 200);
      assert.equal((await res.json()).status, status);
    }
    assert.equal(
      (
        await call(
          `${base}/batches/${b.id}`,
          'PATCH',
          { manufactureDate: '2028-01-01' },
          operator.token,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          `${base}/batches/${b.id}`,
          'PATCH',
          { expiryDate: '2025-01-01' },
          admin.token,
        )
      ).status,
      400,
    );
    assert.equal(
      (await call(`${base}/batches/${b.id}`, 'PATCH', {}, admin.token)).status,
      400,
    );
    assert.equal(
      (
        await call(
          `${base}/batches/${b.id}`,
          'PATCH',
          { productId: p2.id },
          admin.token,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          `${base}/batches/${opBatch.id}`,
          'PATCH',
          { lotNumber: 'LOT-001' },
          operator.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          `${base}/batches/${randomUUID()}`,
          'GET',
          undefined,
          admin.token,
        )
      ).status,
      404,
    );
    const cleared = await call(
      `${base}/batches/${b.id}`,
      'PATCH',
      { manufactureDate: null, expiryDate: null },
      operator.token,
    );
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).expiryDate, null);
    // Calendar checks persist independently of API validation.
    await assert.rejects(
      batch.batch.create({
        data: {
          organizationId: ids[0],
          productId: p.id,
          gtinId: g.id,
          lotNumber: 'DB invalid',
          manufactureDate: new Date('2026-10-06'),
          expiryDate: new Date('2026-10-05'),
        },
      }),
    );
    const {
      PrismaClient,
    } = require('../services/batch-service/generated/client');
    for (const db of ['auth', 'organization', 'product']) {
      const url = new URL(batchEnv.DATABASE_URL);
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
    const productExit = once(productChild, 'exit');
    productChild.kill('SIGTERM');
    await productExit;
    for (const [route, method, input] of [
      [nested, 'POST', { lotNumber: 'Unavailable' }],
      [nested, 'GET', undefined],
      [`${base}/batches/${b.id}`, 'PATCH', { status: 'CLOSED' }],
    ]) {
      const res = await call(route, method, input, operator.token);
      assert.equal(res.status, 503);
      assert.doesNotMatch(
        await res.text(),
        /postgresql|password|INTERNAL_IDENTITY_SECRET/,
      );
    }
    assert.equal(
      await batch.batch.count({
        where: { lotNumber: 'Unavailable', organizationId: ids[0] },
      }),
      0,
    );
    assert.equal(
      (await call(`${base}/batches/${b.id}`, 'GET', undefined, viewer.token))
        .status,
      200,
    );
    const batchExit = once(batchChild, 'exit');
    batchChild.kill('SIGTERM');
    await batchExit;
    assert.equal(
      (await call(`${base}/batches`, 'GET', undefined, admin.token)).status,
      503,
    );
  },
);
test('batch gateway sanitizes errors, validates upstream responses, signs identity and handles timeouts', async () => {
  const {
    BatchProxy,
  } = require('../apps/api-gateway/dist/batches/batch-proxy');
  const { productIdentityPayload } = require('../packages/contracts/dist');
  const organizationId = randomUUID();
  const route = `/organizations/${organizationId}/batches`;
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
    const proxy = new BatchProxy(
      new ConfigService({
        BATCH_SERVICE_URL: `http://127.0.0.1:${server.address().port}`,
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
test('Product validation client signs reference context and sanitizes failures with bounded deadlines', async () => {
  const {
    ProductValidationClient,
  } = require('../services/batch-service/dist/product-validation.client');
  const { productIdentityPayload } = require('../packages/contracts/dist');
  const { createServer } = require('node:http');
  const organizationId = randomUUID(),
    productId = randomUUID(),
    gtinId = randomUUID(),
    userId = randomUUID();
  let mode = 'valid';
  const server = createServer((req, res) => {
    const path = `/internal/organizations/${organizationId}/products/${productId}/gtins/${gtinId}/validation`;
    assert.equal(req.url, path);
    assert.equal(req.headers['x-identity-role'], 'OPERATOR');
    const expected = createHmac('sha256', batchEnv.INTERNAL_IDENTITY_SECRET)
      .update(
        productIdentityPayload(
          'GET',
          path,
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
    if (mode === 'error' || mode === 'missing' || mode === 'denied') {
      res.writeHead(mode === 'missing' ? 404 : mode === 'denied' ? 403 : 500);
      res.end('secret database credentials');
      return;
    }
    if (mode === 'invalid') {
      res.end('{"secret":"password"}');
      return;
    }
    res.end(
      JSON.stringify({
        organizationId,
        productId,
        gtinId: mode === 'mismatch' ? randomUUID() : gtinId,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new ProductValidationClient(
    new ConfigService({
      ...batchEnv,
      PRODUCT_SERVICE_URL: `http://127.0.0.1:${server.address().port}`,
      PRODUCT_SERVICE_TIMEOUT_MS: 100,
    }),
  );
  try {
    await client.validate(
      organizationId,
      productId,
      gtinId,
      userId,
      'OPERATOR',
    );
    for (const [next, status] of [
      ['error', 503],
      ['missing', 404],
      ['denied', 503],
      ['invalid', 502],
      ['mismatch', 502],
      ['timeout', 504],
      ['body-timeout', 504],
    ]) {
      mode = next;
      await assert.rejects(
        client.validate(organizationId, productId, gtinId, userId, 'OPERATOR'),
        (error) => {
          assert.equal(error.getStatus(), status);
          assert.doesNotMatch(
            JSON.stringify(error.getResponse()),
            /password|credentials|secret/,
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
    client.validate(organizationId, productId, gtinId, userId, 'OPERATOR'),
    (error) => error.getStatus() === 503,
  );
});
test('batch internal signature binds role, organization, path and body; operator writes are permitted', () => {
  const { Buffer } = require('node:buffer');
  const {
    InternalIdentityGuard,
  } = require('../services/batch-service/dist/authorization');
  const { productIdentityPayload } = require('../packages/contracts/dist');
  const organizationId = randomUUID(),
    userId = randomUUID();
  const path = `/organizations/${organizationId}/batches/${randomUUID()}`;
  const raw = '{"status":"QUARANTINED"}';
  const time = String(Date.now());
  const make = (role) => ({
    method: 'PATCH',
    originalUrl: path,
    rawBody: Buffer.from(raw),
    params: { organizationId },
    headers: {
      'x-identity-user': userId,
      'x-identity-organization': organizationId,
      'x-identity-role': role,
      'x-identity-time': time,
      'x-identity-signature': createHmac(
        'sha256',
        batchEnv.INTERNAL_IDENTITY_SECRET,
      )
        .update(
          productIdentityPayload(
            'PATCH',
            path,
            time,
            userId,
            raw,
            organizationId,
            role,
          ),
        )
        .digest('hex'),
    },
  });
  const context = (req) => ({
    switchToHttp: () => ({ getRequest: () => req }),
  });
  const guard = new InternalIdentityGuard(new ConfigService(batchEnv));
  for (const role of ['ORG_ADMIN', 'OPERATOR'])
    assert.equal(guard.canActivate(context(make(role))), true);
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
      req.rawBody = Buffer.from('{}');
    },
    (req) => {
      req.originalUrl = '/tampered';
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
test('batch form validates trimmed lots, calendar dates and strict chronology', () => {
  const ts = require('typescript');
  const Module = require('node:module');
  const filename = path.resolve(__dirname, '../apps/web/src/batch-forms.ts');
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
  const { batchSchema } = module.exports;
  const valid = {
    lotNumber: ' Lot 01 ',
    manufactureDate: '2026-01-01',
    expiryDate: '2027-01-01',
    status: 'ACTIVE',
  };
  assert.equal(batchSchema.parse(valid).lotNumber, 'Lot 01');
  assert.equal(
    batchSchema.safeParse({ ...valid, manufactureDate: '', expiryDate: '' })
      .success,
    true,
  );
  for (const input of [
    { ...valid, lotNumber: ' ' },
    { ...valid, manufactureDate: '2026-02-30' },
    { ...valid, expiryDate: '2026-01-01' },
    { ...valid, expiryDate: '2025-12-31' },
    { ...valid, status: 'INVALID' },
  ])
    assert.equal(batchSchema.safeParse(input).success, false);
});
