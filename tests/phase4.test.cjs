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
  OrganizationRepository,
} = require('../services/organization-service/dist/organization.repository');
const {
  validateOrganizationEnvironment,
  validateAuthEnvironment,
} = require('../packages/config/dist');
const { identityPayload } = require('../packages/contracts/dist');
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
test('Organization configuration validates ownership URL and internal secret', () => {
  assert.equal(validateOrganizationEnvironment(env).PORT, 3002);
  for (const input of [
    { ...env, INTERNAL_IDENTITY_SECRET: '' },
    { ...env, DATABASE_URL: 'https://example.com' },
  ])
    assert.throws(() => validateOrganizationEnvironment(input));
});
test(
  'real organization flow enforces membership, scoped roles, facility isolation and gateway boundary',
  { timeout: 30000 },
  async (t) => {
    const prisma = new PrismaService(
      new ConfigService(validateOrganizationEnvironment(env)),
    );
    const auth = new AuthPrisma(
      new ConfigService(validateAuthEnvironment(authEnv)),
    );
    await prisma.onModuleInit();
    await auth.onModuleInit();
    const suffix = randomUUID();
    const ids = [];
    const emails = [
      `phase4-admin-${suffix}@example.com`,
      `phase4-viewer-${suffix}@example.com`,
    ];
    t.after(async () => {
      try {
        await prisma.organization.deleteMany({ where: { id: { in: ids } } });
        await auth.user.deleteMany({ where: { email: { in: emails } } });
      } finally {
        await prisma.onModuleDestroy();
        await auth.onModuleDestroy();
      }
    });
    await start(t, 'services/auth-service', 13007, authEnv);
    const service = await start(t, 'services/organization-service', 13008, env);
    await start(t, 'apps/api-gateway', 13006, {
      AUTH_SERVICE_URL: 'http://127.0.0.1:13007',
      ORGANIZATION_SERVICE_URL: 'http://127.0.0.1:13008',
      INTERNAL_IDENTITY_SECRET: env.INTERNAL_IDENTITY_SECRET,
      AUTH_SERVICE_TIMEOUT_MS: '2000',
    });
    const call = (route, method = 'GET', body, token, extra = {}) =>
      fetch(`http://127.0.0.1:13006/api${route}`, {
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
        password: 'secure phase four password',
      });
      assert.equal(registered.status, 201);
      const user = await registered.json();
      const response = await call('/auth/login', 'POST', {
        email,
        password: 'secure phase four password',
      });
      assert.equal(response.status, 200);
      return { user, token: (await response.json()).accessToken };
    };
    const admin = await login(emails[0]);
    const viewer = await login(emails[1]);
    assert.equal((await call('/organizations')).status, 401);
    assert.equal(
      (
        await fetch('http://127.0.0.1:13008/organizations', {
          headers: { 'x-identity-user': admin.user.id },
        })
      ).status,
      401,
    );
    const timestamp = String(Date.now() - 60000);
    const signature = createHmac('sha256', env.INTERNAL_IDENTITY_SECRET)
      .update(
        identityPayload('GET', '/organizations', timestamp, admin.user.id, ''),
      )
      .digest('hex');
    assert.equal(
      (
        await fetch('http://127.0.0.1:13008/organizations', {
          headers: {
            'x-identity-user': admin.user.id,
            'x-identity-time': timestamp,
            'x-identity-signature': signature,
          },
        })
      ).status,
      401,
    );
    const validTime = String(Date.now());
    const validSignature = createHmac('sha256', env.INTERNAL_IDENTITY_SECRET)
      .update(
        identityPayload(
          'POST',
          '/organizations',
          validTime,
          admin.user.id,
          '{"legalName":"Original"}',
        ),
      )
      .digest('hex');
    assert.equal(
      (
        await fetch('http://127.0.0.1:13008/organizations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-identity-user': admin.user.id,
            'x-identity-time': validTime,
            'x-identity-signature': validSignature,
          },
          body: '{"legalName":"Tampered"}',
        })
      ).status,
      401,
    );
    assert.equal(
      (await call('/organizations', 'POST', { legalName: '' }, admin.token))
        .status,
      400,
    );
    const created = await call(
      '/organizations',
      'POST',
      { legalName: 'Learning Pharma' },
      admin.token,
    );
    assert.equal(created.status, 201);
    const org = await created.json();
    ids.push(org.id);
    const owner = await prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: admin.user.id,
          organizationId: org.id,
        },
      },
    });
    assert.equal(owner.role, 'ORG_ADMIN');
    const list = await call('/organizations', 'GET', undefined, admin.token);
    assert.deepEqual(
      (await list.json()).map((row) => row.id),
      [org.id],
    );
    const otherList = await call(
      '/organizations',
      'GET',
      undefined,
      viewer.token,
    );
    assert.deepEqual(await otherList.json(), []);
    const base = `/organizations/${org.id}`;
    assert.equal(
      (
        await call(base, 'GET', undefined, viewer.token, {
          'x-identity-user': admin.user.id,
          'x-identity-signature': 'a'.repeat(64),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          `/organizations/${randomUUID()}`,
          'GET',
          undefined,
          admin.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (await call(base, 'PATCH', { legalName: 'Updated Pharma' }, admin.token))
        .status,
      200,
    );
    await prisma.membership.create({
      data: { organizationId: org.id, userId: viewer.user.id, role: 'VIEWER' },
    });
    await assert.rejects(
      prisma.membership.create({
        data: {
          organizationId: org.id,
          userId: viewer.user.id,
          role: 'VIEWER',
        },
      }),
      (error) => error.code === 'P2002',
    );
    assert.equal(
      (await call(base, 'GET', undefined, viewer.token)).status,
      200,
    );
    assert.equal(
      (await call(base, 'PATCH', { legalName: 'Denied' }, viewer.token)).status,
      403,
    );
    assert.equal(
      (
        await call(
          `${base}/facilities`,
          'POST',
          { name: 'Denied', type: 'MANUFACTURER' },
          viewer.token,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          `${base}/facilities`,
          'POST',
          { name: 'Invalid GLN', type: 'MANUFACTURER', gln: '123' },
          admin.token,
        )
      ).status,
      400,
    );
    const gln = String(
      BigInt('0x' + suffix.replaceAll('-', '').slice(0, 12)) % 10000000000000n,
    ).padStart(13, '0');
    const facilityResponse = await call(
      `${base}/facilities`,
      'POST',
      { name: 'Primary site', type: 'MANUFACTURER', gln },
      admin.token,
    );
    assert.equal(facilityResponse.status, 201);
    const facility = await facilityResponse.json();
    assert.equal(facility.organizationId, org.id);
    assert.equal(
      (
        await call(
          `${base}/facilities`,
          'POST',
          { name: 'Duplicate', type: 'DISTRIBUTOR', gln },
          admin.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (await call(`${base}/facilities`, 'GET', undefined, viewer.token)).status,
      200,
    );
    assert.equal(
      (
        await call(
          `${base}/facilities/${facility.id}`,
          'GET',
          undefined,
          viewer.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          `${base}/facilities/${facility.id}`,
          'PATCH',
          { name: 'Denied' },
          viewer.token,
        )
      ).status,
      403,
    );
    const updated = await call(
      `${base}/facilities/${facility.id}`,
      'PATCH',
      { name: 'Updated site', gln: null, status: 'INACTIVE' },
      admin.token,
    );
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).name, 'Updated site');
    const members = await call(
      `${base}/memberships`,
      'GET',
      undefined,
      viewer.token,
    );
    assert.equal(members.status, 200);
    assert.deepEqual(
      (await members.json()).map((row) => row.role),
      ['ORG_ADMIN', 'VIEWER'],
    );
    await prisma.membership.update({
      where: {
        userId_organizationId: {
          userId: viewer.user.id,
          organizationId: org.id,
        },
      },
      data: { role: 'OPERATOR' },
    });
    assert.equal(
      (await call(base, 'GET', undefined, viewer.token)).status,
      200,
    );
    assert.equal(
      (await call(base, 'PATCH', { status: 'INACTIVE' }, viewer.token)).status,
      403,
    );
    const second = await call(
      '/organizations',
      'POST',
      { legalName: 'Second Org' },
      admin.token,
    );
    const org2 = await second.json();
    ids.push(org2.id);
    assert.equal(
      (
        await call(
          `/organizations/${org2.id}/facilities/${facility.id}`,
          'GET',
          undefined,
          admin.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          `/organizations/${org2.id}/facilities/${facility.id}`,
          'PATCH',
          { name: 'Wrong org' },
          admin.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (await call(`/organizations/${org2.id}`, 'GET', undefined, viewer.token))
        .status,
      403,
    );
    // Membership insertion fails after organization insertion; the transaction rolls both back.
    const repository = new OrganizationRepository(prisma);
    const rollbackName = `Rollback ${suffix}`;
    await assert.rejects(repository.create(rollbackName, 'invalid-user-uuid'));
    assert.equal(
      await prisma.organization.count({ where: { legalName: rollbackName } }),
      0,
    );
    // Organization credentials cannot connect to the Auth-owned database.
    const {
      PrismaClient,
    } = require('../services/organization-service/generated/client');
    const authUrl = new URL(env.DATABASE_URL);
    authUrl.pathname = '/auth';
    const forbidden = new PrismaClient({
      datasources: { db: { url: authUrl.toString() } },
    });
    try {
      await assert.rejects(forbidden.$connect());
    } finally {
      await forbidden.$disconnect();
    }
    const exited = once(service, 'exit');
    service.kill('SIGTERM');
    await exited;
    const unavailable = await call(
      '/organizations',
      'GET',
      undefined,
      admin.token,
    );
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(
      await unavailable.text(),
      /password|postgresql|INTERNAL_IDENTITY_SECRET/,
    );
  },
);
test('organization gateway sanitizes errors, validates upstream responses, signs identity and handles timeouts', async () => {
  const {
    OrganizationProxy,
  } = require('../apps/api-gateway/dist/organizations/organization-proxy');
  const { createServer } = require('node:http');
  let mode = 'error';
  const userId = randomUUID();
  const server = createServer((req, res) => {
    assert.equal(req.url, '/organizations');
    assert.equal(req.headers['x-identity-user'], userId);
    const expected = createHmac('sha256', env.INTERNAL_IDENTITY_SECRET)
      .update(
        identityPayload(
          'GET',
          '/organizations',
          req.headers['x-identity-time'],
          userId,
          '',
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
    const proxy = new OrganizationProxy(
      new ConfigService({
        ORGANIZATION_SERVICE_URL: `http://127.0.0.1:${server.address().port}`,
        INTERNAL_IDENTITY_SECRET: env.INTERNAL_IDENTITY_SECRET,
        AUTH_SERVICE_TIMEOUT_MS: 100,
      }),
    );
    for (const [next, status] of [
      ['error', 502],
      ['forbidden', 403],
      ['invalid', 502],
      ['timeout', 504],
      ['body-timeout', 504],
    ]) {
      mode = next;
      await assert.rejects(
        proxy.forward('GET', '/organizations', userId),
        (error) => {
          assert.equal(error.getStatus(), status);
          assert.doesNotMatch(
            JSON.stringify(error.getResponse()),
            /secret|database/,
          );
          return true;
        },
      );
    }
    mode = 'valid';
    assert.deepEqual(await proxy.forward('GET', '/organizations', userId), []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('frontend organization and facility forms validate aligned inputs', () => {
  const ts = require('typescript');
  const Module = require('node:module');
  const filename = path.resolve(
    __dirname,
    '../apps/web/src/organization-forms.ts',
  );
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
  const { organizationSchema, facilitySchema } = module.exports;
  assert.equal(organizationSchema.safeParse({ legalName: '' }).success, false);
  assert.equal(
    organizationSchema.parse({ legalName: ' Pharma ' }).legalName,
    'Pharma',
  );
  assert.equal(
    facilitySchema.safeParse({ name: 'Site', type: 'MANUFACTURER', gln: '' })
      .success,
    true,
  );
  assert.equal(
    facilitySchema.safeParse({
      name: 'Site',
      type: 'MANUFACTURER',
      gln: '1234567890123',
    }).success,
    true,
  );
  assert.equal(
    facilitySchema.safeParse({ name: 'Site', type: 'MANUFACTURER', gln: '123' })
      .success,
    false,
  );
  assert.equal(
    facilitySchema.safeParse({ name: 'Site', type: 'UNKNOWN', gln: '' })
      .success,
    false,
  );
});
