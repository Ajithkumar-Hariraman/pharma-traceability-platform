const { Buffer } = require('node:buffer');
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
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, output);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child;
    } catch {
      /* Starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(output || 'Startup timed out');
}

const { normalizeGtin } = require('../packages/contracts/dist');
for (const [length, code] of [
  [8, '96385074'],
  [12, '036000291452'],
  [13, '4006381333931'],
  [14, '10012345000017'],
]) {
  test(`valid GTIN-${length} normalizes and checks digit`, () =>
    assert.equal(normalizeGtin(code), code.padStart(14, '0')));
}
test('invalid GTIN inputs are rejected without losing leading zeroes', () => {
  for (const value of [
    '123',
    '123456789',
    '96385075',
    'abc85074',
    '036000291453',
    '4006381333932',
    '10012345000018',
  ])
    assert.equal(normalizeGtin(value), null);
  assert.equal(normalizeGtin(' 036000291452 '), '00036000291452');
});
test(
  'product and GTIN real gateway/database flow enforces organization ownership and roles',
  { timeout: 30000 },
  async (t) => {
    const org = new PrismaService(
      new ConfigService(validateOrganizationEnvironment(env)),
    );
    const auth = new AuthPrisma(
      new ConfigService(validateAuthEnvironment(authEnv)),
    );
    const product = new ProductPrisma(new ConfigService(productEnv));
    await Promise.all([
      org.onModuleInit(),
      auth.onModuleInit(),
      product.onModuleInit(),
    ]);
    const ids = [];
    const suffix = randomUUID();
    const emails = [
      `phase5-admin-${suffix}@example.com`,
      `phase5-reader-${suffix}@example.com`,
    ];
    t.after(async () => {
      try {
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
        ]);
      }
    });
    await start(t, 'services/auth-service', 13101, authEnv);
    await start(t, 'services/organization-service', 13102, env);
    const child = await start(t, 'services/product-service', 13103, productEnv);
    await start(t, 'apps/api-gateway', 13100, {
      AUTH_SERVICE_URL: 'http://127.0.0.1:13101',
      ORGANIZATION_SERVICE_URL: 'http://127.0.0.1:13102',
      PRODUCT_SERVICE_URL: 'http://127.0.0.1:13103',
      INTERNAL_IDENTITY_SECRET: env.INTERNAL_IDENTITY_SECRET,
      AUTH_SERVICE_TIMEOUT_MS: '2000',
    });
    const call = (route, method = 'GET', body, token, extra = {}) =>
      fetch(`http://127.0.0.1:13100/api${route}`, {
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
        password: 'secure phase five password',
      });
      assert.equal(registered.status, 201);
      const user = await registered.json();
      const res = await call('/auth/login', 'POST', {
        email,
        password: 'secure phase five password',
      });
      return { user, token: (await res.json()).accessToken };
    };
    const admin = await login(emails[0]);
    const reader = await login(emails[1]);
    for (const name of ['First pharma', 'Second pharma']) {
      const res = await call(
        '/organizations',
        'POST',
        { legalName: name },
        admin.token,
      );
      assert.equal(res.status, 201);
      ids.push((await res.json()).id);
    }
    const base = `/organizations/${ids[0]}/products`;
    const other = `/organizations/${ids[1]}/products`;
    assert.equal((await call(base)).status, 401);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:13103${base}`, {
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
        await call(base, 'GET', undefined, reader.token, {
          'x-identity-user': admin.user.id,
          'x-identity-role': 'ORG_ADMIN',
        })
      ).status,
      403,
    );
    assert.equal(
      (await call(base, 'POST', { name: '' }, admin.token)).status,
      400,
    );
    const created = await call(
      base,
      'POST',
      { name: 'Medicine', manufacturerName: 'Pharma', description: 'Tablet' },
      admin.token,
    );
    assert.equal(created.status, 201);
    const p = await created.json();
    assert.equal(p.organizationId, ids[0]);
    assert.deepEqual(
      (await (await call(base, 'GET', undefined, admin.token)).json()).map(
        (row) => row.id,
      ),
      [p.id],
    );
    assert.deepEqual(
      await (await call(other, 'GET', undefined, admin.token)).json(),
      [],
    );
    for (const method of ['GET', 'PATCH'])
      assert.equal(
        (
          await call(
            `${other}/${p.id}`,
            method,
            method === 'PATCH' ? { name: 'Denied' } : undefined,
            admin.token,
          )
        ).status,
        404,
      );
    assert.equal(
      (
        await call(
          `${other}/${p.id}/gtins`,
          'POST',
          { gtin: '96385074', packagingLevel: 'EACH' },
          admin.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (await call(`${base}/${randomUUID()}`, 'GET', undefined, admin.token))
        .status,
      404,
    );
    const update = await call(
      `${base}/${p.id}`,
      'PATCH',
      { status: 'INACTIVE' },
      admin.token,
    );
    assert.equal(update.status, 200);
    assert.equal((await update.json()).status, 'INACTIVE');
    const codes = [];
    for (const code of [
      '96385074',
      '036000291452',
      '4006381333931',
      '10012345000017',
    ]) {
      const res = await call(
        `${base}/${p.id}/gtins`,
        'POST',
        { gtin: code, packagingLevel: 'EACH' },
        admin.token,
      );
      assert.equal(res.status, 201);
      const g = await res.json();
      codes.push(g);
      assert.equal(g.gtin, code.padStart(14, '0'));
      assert.equal(g.organizationId, ids[0]);
      assert.equal(g.productId, p.id);
    }
    for (const input of [
      { gtin: '123', packagingLevel: 'EACH' },
      { gtin: '96385075', packagingLevel: 'EACH' },
      { gtin: '96385074', packagingLevel: 'UNKNOWN' },
    ])
      assert.equal(
        (await call(`${base}/${p.id}/gtins`, 'POST', input, admin.token))
          .status,
        400,
      );
    const second = await (
      await call(other, 'POST', { name: 'Other product' }, admin.token)
    ).json();
    assert.equal(
      (
        await call(
          `${other}/${second.id}/gtins`,
          'POST',
          { gtin: codes[0].gtin, packagingLevel: 'CASE' },
          admin.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          `${other}/${second.id}/gtins/${codes[0].id}`,
          'GET',
          undefined,
          admin.token,
        )
      ).status,
      404,
    );
    await assert.rejects(
      product.gTIN.create({
        data: {
          organizationId: ids[1],
          productId: p.id,
          gtin: '00000000000000',
          packagingLevel: 'EACH',
        },
      }),
      (error) => error.code === 'P2003',
    );
    const member = await org.membership.create({
      data: { organizationId: ids[0], userId: reader.user.id, role: 'VIEWER' },
    });
    for (const role of ['VIEWER', 'OPERATOR']) {
      await org.membership.update({ where: { id: member.id }, data: { role } });
      for (const route of [
        base,
        `${base}/${p.id}`,
        `${base}/${p.id}/gtins`,
        `${base}/${p.id}/gtins/${codes[0].id}`,
      ])
        assert.equal(
          (await call(route, 'GET', undefined, reader.token)).status,
          200,
        );
      for (const [route, method, input] of [
        [base, 'POST', { name: 'Denied' }],
        [`${base}/${p.id}`, 'PATCH', { name: 'Denied' }],
        [
          `${base}/${p.id}/gtins`,
          'POST',
          { gtin: '96385074', packagingLevel: 'EACH' },
        ],
        [
          `${base}/${p.id}/gtins/${codes[0].id}`,
          'PATCH',
          { status: 'INACTIVE' },
        ],
      ])
        assert.equal(
          (await call(route, method, input, reader.token)).status,
          403,
        );
    }
    const patched = await call(
      `${base}/${p.id}/gtins/${codes[0].id}`,
      'PATCH',
      { packagingLevel: 'PALLET', status: 'INACTIVE' },
      admin.token,
    );
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).packagingLevel, 'PALLET');
    // Product-owned credentials cannot open either other service's database.
    const {
      PrismaClient,
    } = require('../services/product-service/generated/client');
    for (const db of ['auth', 'organization']) {
      const url = new URL(productEnv.DATABASE_URL);
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
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    const unavailable = await call(base, 'GET', undefined, admin.token);
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /password|postgresql|SECRET/);
  },
);
test('product gateway sanitizes errors, validates upstream responses, signs identity and handles timeouts', async () => {
  const {
    ProductProxy,
  } = require('../apps/api-gateway/dist/products/product-proxy');
  const { productIdentityPayload } = require('../packages/contracts/dist');
  const organizationId = randomUUID();
  const route = `/organizations/${organizationId}/products`;
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
    const proxy = new ProductProxy(
      new ConfigService({
        PRODUCT_SERVICE_URL: `http://127.0.0.1:${server.address().port}`,
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
test('product internal context rejects changed organization, role, body and stale identity', () => {
  const {
    InternalIdentityGuard,
  } = require('../services/product-service/dist/authorization');
  const { productIdentityPayload } = require('../packages/contracts/dist');
  const guard = new InternalIdentityGuard(new ConfigService(productEnv));
  const organizationId = randomUUID();
  const userId = randomUUID();
  const path = `/organizations/${organizationId}/products`;
  const time = String(Date.now());
  const raw = '{"name":"Original"}';
  const signature = createHmac('sha256', productEnv.INTERNAL_IDENTITY_SECRET)
    .update(
      productIdentityPayload(
        'POST',
        path,
        time,
        userId,
        raw,
        organizationId,
        'ORG_ADMIN',
      ),
    )
    .digest('hex');
  const request = () => ({
    method: 'POST',
    originalUrl: path,
    rawBody: Buffer.from(raw),
    params: { organizationId },
    headers: {
      'x-identity-user': userId,
      'x-identity-organization': organizationId,
      'x-identity-role': 'ORG_ADMIN',
      'x-identity-time': time,
      'x-identity-signature': signature,
    },
  });
  const context = (req) => ({
    switchToHttp: () => ({ getRequest: () => req }),
  });
  assert.equal(guard.canActivate(context(request())), true);
  for (const mutate of [
    (req) => {
      req.headers['x-identity-role'] = 'VIEWER';
    },
    (req) => {
      req.headers['x-identity-organization'] = randomUUID();
    },
    (req) => {
      req.rawBody = Buffer.from('{"name":"Tampered"}');
    },
    (req) => {
      req.headers['x-identity-time'] = String(Date.now() - 60000);
    },
  ]) {
    const req = request();
    mutate(req);
    assert.throws(
      () => guard.canActivate(context(req)),
      (error) => error.getStatus() === 401,
    );
  }
});
