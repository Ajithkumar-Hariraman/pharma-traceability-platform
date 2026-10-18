const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const {
  validateAuthEnvironment,
  validateGatewayEnvironment,
} = require('../packages/config/dist');
const {
  ConfigService,
} = require('../services/auth-service/node_modules/@nestjs/config');
const {
  PrismaService,
} = require('../services/auth-service/dist/persistence/prisma.service');
const {
  UserRepository,
} = require('../services/auth-service/dist/users/user.repository');
const {
  UserService,
} = require('../services/auth-service/dist/users/user.service');
const {
  DatabaseRepository,
} = require('../services/auth-service/dist/persistence/database.repository');
const {
  ReadinessService,
} = require('../services/auth-service/dist/readiness.service');
const databaseEnv = process.env.DATABASE_URL
  ? process.env
  : parseEnv(
      readFileSync(
        path.resolve(__dirname, '../services/auth-service/.env'),
        'utf8',
      ),
    );
const passwordHash = '$2b$12$' + 'a'.repeat(53);

test('service configuration requires valid database and upstream settings', () => {
  const database = 'postgresql://owner:example@127.0.0.1:5432/auth';
  assert.equal(
    validateAuthEnvironment({
      DATABASE_URL: database,
      JWT_SECRET: 'test-only-configuration-secret-32-bytes',
    }).DATABASE_URL,
    database,
  );
  for (const value of [
    undefined,
    '',
    'invalid',
    'http://host/auth',
    'postgresql://host/',
  ])
    assert.throws(() => validateAuthEnvironment({ DATABASE_URL: value }));
  const valid = { AUTH_SERVICE_URL: 'http://127.0.0.1:3001/' };
  assert.equal(
    validateGatewayEnvironment(valid).AUTH_SERVICE_URL,
    'http://127.0.0.1:3001',
  );
  assert.equal(validateGatewayEnvironment(valid).AUTH_SERVICE_TIMEOUT_MS, 2000);
  for (const value of [
    undefined,
    '',
    'ftp://host',
    'http://user:secret@host',
    'http://host?key=secret',
  ])
    assert.throws(() =>
      validateGatewayEnvironment({ AUTH_SERVICE_URL: value }),
    );
  for (const value of [0, -1, 30001, '1.5', '', false])
    assert.throws(() =>
      validateGatewayEnvironment({ ...valid, AUTH_SERVICE_TIMEOUT_MS: value }),
    );
});

test('user service normalizes emails and rejects plaintext before persistence', async () => {
  const calls = [];
  const users = new UserService({
    create: async (input) => {
      calls.push(input);
      return { email: input.email };
    },
    findByEmail: async (email) => ({ email }),
  });
  assert.equal(
    (await users.create({ email: ' Alice@Example.COM ', passwordHash })).email,
    'alice@example.com',
  );
  assert.equal(
    (await users.findByEmail(' ALICE@example.com ')).email,
    'alice@example.com',
  );
  assert.throws(
    () =>
      users.create({ email: 'alice@example.com', passwordHash: 'plaintext' }),
    /encoded password hash/,
  );
  assert.throws(
    () => users.create({ email: 'invalid', passwordHash }),
    /valid email/,
  );
  assert.equal(calls.length, 1);
});

test('readiness returns sanitized 503 on database failure or timeout', async () => {
  assert.deepEqual(
    await new ReadinessService({ ping: async () => {} }).check(),
    { service: 'auth-service', status: 'ok', database: 'ok' },
  );
  for (const ping of [
    async () => {
      throw new Error('postgresql://secret:secret@internal-host/auth');
    },
    () => new Promise(() => {}),
  ]) {
    await assert.rejects(new ReadinessService({ ping }).check(), (error) => {
      assert.equal(error.getStatus(), 503);
      assert.deepEqual(error.getResponse(), {
        service: 'auth-service',
        status: 'unavailable',
        database: 'unavailable',
      });
      return true;
    });
  }
});

test('Auth-owned repository persists users and enforces database constraints', async (t) => {
  const prisma = new PrismaService(
    new ConfigService(validateAuthEnvironment(databaseEnv)),
  );
  await prisma.onModuleInit();
  const email = `phase2-${randomUUID()}@example.com`;
  t.after(async () => {
    try {
      await prisma.user.deleteMany({ where: { email } });
    } finally {
      await prisma.onModuleDestroy();
    }
  });
  const repository = new UserRepository(prisma);
  const users = new UserService(repository);
  const created = await users.create({
    email: ` ${email.toUpperCase()} `,
    passwordHash,
  });
  assert.match(
    created.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(created.email, email);
  assert.equal(created.status, 'ACTIVE');
  assert.ok(created.createdAt instanceof Date);
  assert.ok(created.updatedAt instanceof Date);
  assert.equal('passwordHash' in created, false);
  assert.equal((await users.findByEmail(email.toUpperCase())).id, created.id);
  assert.equal(
    await users.findByEmail(`absent-${randomUUID()}@example.com`),
    null,
  );
  assert.equal(
    (await prisma.user.findUnique({ where: { id: created.id } })).passwordHash,
    passwordHash,
  );
  await assert.rejects(
    users.create({ email: email.toUpperCase(), passwordHash }),
    (error) => error.code === 'P2002',
  );
  await assert.rejects(
    repository.create({ email: email.toUpperCase(), passwordHash }),
    (error) => /User_email_normalized_check/.test(error.message),
  );
  await assert.rejects(
    repository.create({ email, passwordHash: 'plaintext' }),
    (error) => /User_password_hash_check/.test(error.message),
  );
  const updated = await prisma.user.update({
    where: { id: created.id },
    data: { status: 'INACTIVE' },
  });
  assert.equal(updated.status, 'INACTIVE');
  assert.ok(updated.updatedAt >= created.updatedAt);
  assert.equal(updated.createdAt.getTime(), created.createdAt.getTime());
  assert.deepEqual(
    await new ReadinessService(new DatabaseRepository(prisma)).check(),
    { service: 'auth-service', status: 'ok', database: 'ok' },
  );
});

async function startApp(t, folder, port, extraEnv = {}) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: path.resolve(__dirname, '..', folder),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'silent',
      ...extraEnv,
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
      child.kill('SIGKILL');
      await exited;
    }
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, output);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return child;
    } catch {
      /* Wait for startup. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(output || 'Service did not become ready');
}

test(
  'gateway forwards real Auth health and handles upstream failures',
  { timeout: 15000 },
  async (t) => {
    const auth = await startApp(t, 'services/auth-service', 13003, {
      DATABASE_URL: databaseEnv.DATABASE_URL,
    });
    await startApp(t, 'apps/api-gateway', 13002, {
      AUTH_SERVICE_URL: 'http://127.0.0.1:13003',
      AUTH_SERVICE_TIMEOUT_MS: '250',
    });
    const ready = await fetch('http://127.0.0.1:13003/ready');
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      service: 'auth-service',
      status: 'ok',
      database: 'ok',
    });
    const forwarded = await fetch('http://127.0.0.1:13002/api/auth/health');
    assert.equal(forwarded.status, 200);
    assert.deepEqual(await forwarded.json(), {
      service: 'auth-service',
      status: 'ok',
    });
    const exited = once(auth, 'exit');
    auth.kill('SIGTERM');
    await exited;
    assert.equal(
      (await fetch('http://127.0.0.1:13002/api/auth/health')).status,
      503,
    );
    let mode = 'error';
    const upstream = createServer((req, res) => {
      assert.equal(req.url, '/health');
      if (mode === 'timeout') return;
      if (mode === 'body-timeout') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
        return;
      }
      if (mode === 'error') {
        res.writeHead(500);
        res.end('secret database credentials');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        mode === 'invalid'
          ? JSON.stringify({ status: 'ok', service: 'unexpected' })
          : '{broken-json',
      );
    });
    await new Promise((resolve) =>
      upstream.listen(13003, '127.0.0.1', resolve),
    );
    t.after(async () => {
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    });
    for (const [value, expected] of [
      ['error', 502],
      ['invalid', 502],
      ['json', 502],
      ['timeout', 504],
      ['body-timeout', 504],
    ]) {
      mode = value;
      const response = await fetch('http://127.0.0.1:13002/api/auth/health');
      assert.equal(response.status, expected, value);
      assert.doesNotMatch(
        await response.text(),
        /secret|credentials|internal-host/,
      );
    }
  },
);
