const { test } = require('node:test');
const { Buffer } = require('node:buffer');
const { Response } = globalThis;
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const path = require('node:path');
const {
  ConfigService,
} = require('../services/auth-service/node_modules/@nestjs/config');
const {
  PrismaService,
} = require('../services/auth-service/dist/persistence/prisma.service');
const {
  PasswordService,
} = require('../services/auth-service/dist/auth/password.service');
const { validateAuthEnvironment } = require('../packages/config/dist');
const env = parseEnv(
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
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(output || 'Startup timed out');
}
test('secrets are required and password hashing uses salted Argon2id', async () => {
  for (const secret of [undefined, '', 'short'])
    assert.throws(
      () =>
        validateAuthEnvironment({
          DATABASE_URL: env.DATABASE_URL,
          JWT_SECRET: secret,
        }),
      /JWT_SECRET/,
    );
  const passwords = new PasswordService();
  const hash = await passwords.hash('a strong test password');
  assert.match(hash, /^\$argon2id\$v=19\$m=65536,(?:t=3,p=1|p=1,t=3)\$/);
  assert.equal(await passwords.verify(hash, 'a strong test password'), true);
  assert.equal(await passwords.verify(hash, 'wrong password'), false);
  assert.equal(await passwords.verify('malformed', 'anything'), false);
  assert.notEqual(await passwords.hash('a strong test password'), hash);
});
test(
  'complete authentication flow through gateway with persistent rotation and logout',
  { timeout: 25000 },
  async (t) => {
    const prisma = new PrismaService(
      new ConfigService(validateAuthEnvironment(env)),
    );
    await prisma.onModuleInit();
    const email = `phase3-${randomUUID()}@example.com`;
    t.after(async () => {
      await prisma.user.deleteMany({ where: { email } });
      await prisma.onModuleDestroy();
    });
    await start(t, 'services/auth-service', 13005, env);
    await start(t, 'apps/api-gateway', 13004, {
      AUTH_SERVICE_URL: 'http://127.0.0.1:13005',
      AUTH_SERVICE_TIMEOUT_MS: '2000',
    });
    const call = (action, body, headers = {}) =>
      fetch(`http://127.0.0.1:13004/api/auth/${action}`, {
        method: action === 'me' ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(action !== 'me' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    const password = 'correct horse battery staple';
    assert.equal(
      (await call('register', { email, password: 'short' })).status,
      400,
    );
    const registered = await call('register', {
      email: ` ${email.toUpperCase()} `,
      password,
    });
    assert.equal(registered.status, 201);
    const user = await registered.json();
    assert.equal(user.email, email);
    assert.equal('passwordHash' in user, false);
    const stored = await prisma.user.findUnique({ where: { email } });
    assert.notEqual(stored.passwordHash, password);
    assert.equal(
      await new PasswordService().verify(stored.passwordHash, password),
      true,
    );
    assert.equal((await call('register', { email, password })).status, 409);
    for (const credentials of [
      { email, password: 'wrong password test' },
      { email: `absent-${randomUUID()}@example.com`, password },
    ]) {
      const response = await call('login', credentials);
      assert.equal(response.status, 401);
      assert.equal(
        (await response.json()).message,
        'Invalid email or password',
      );
    }
    await prisma.user.update({
      where: { email },
      data: { status: 'INACTIVE' },
    });
    assert.equal((await call('login', { email, password })).status, 401);
    await prisma.user.update({ where: { email }, data: { status: 'ACTIVE' } });
    assert.equal((await call('me')).status, 401);
    assert.equal(
      (await call('me', undefined, { Authorization: 'Bearer malformed' }))
        .status,
      401,
    );
    const logged = await call('login', { email, password });
    assert.equal(logged.status, 200);
    const cookie = logged.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api\/auth/);
    const session = await logged.json();
    assert.deepEqual(Object.keys(session), ['accessToken']);
    const authorization = `Bearer ${session.accessToken}`;
    const claims = JSON.parse(
      Buffer.from(session.accessToken.split('.')[1], 'base64url').toString(),
    );
    assert.equal(claims.exp - claims.iat, 900);
    const me = await call('me', undefined, { Authorization: authorization });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).email, email);
    const oldCookie = cookie.split(';')[0];
    const raw = oldCookie.slice('pharma_refresh='.length);
    const row = await prisma.refreshSession.findFirst({
      where: { userId: user.id },
    });
    assert.equal(row.tokenHash, createHash('sha256').update(raw).digest('hex'));
    assert.notEqual(row.tokenHash, raw);
    assert.equal(
      (
        await call(
          'refresh',
          {},
          { Cookie: oldCookie, Origin: 'https://evil.example' },
        )
      ).status,
      403,
    );
    const rotated = await call('refresh', {}, { Cookie: oldCookie });
    assert.equal(rotated.status, 200);
    const newCookie = rotated.headers.get('set-cookie').split(';')[0];
    assert.notEqual(newCookie, oldCookie);
    assert.equal(
      (await call('refresh', {}, { Cookie: oldCookie })).status,
      401,
    );
    const newSession = await rotated.json();
    assert.equal(
      (
        await call('me', undefined, {
          Authorization: `Bearer ${newSession.accessToken}`,
        })
      ).status,
      200,
    );
    // Concurrent refresh must have exactly one winner.
    const race = await Promise.all([
      call('refresh', {}, { Cookie: newCookie }),
      call('refresh', {}, { Cookie: newCookie }),
    ]);
    assert.deepEqual(
      race.map((response) => response.status).sort(),
      [200, 401],
    );
    const winnerCookie = race
      .find((response) => response.status === 200)
      .headers.get('set-cookie')
      .split(';')[0];
    const signedOut = await call('logout', {}, { Cookie: winnerCookie });
    assert.equal(signedOut.status, 200);
    assert.match(
      signedOut.headers.get('set-cookie'),
      /Expires=Thu, 01 Jan 1970/,
    );
    assert.equal(
      (await call('refresh', {}, { Cookie: winnerCookie })).status,
      401,
    );
    assert.equal((await call('logout')).status, 200);
    // Expired and revoked tokens cannot be refreshed.
    const expired = randomBytes(32).toString('base64url');
    await prisma.refreshSession.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(expired).digest('hex'),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    assert.equal(
      (await call('refresh', {}, { Cookie: `pharma_refresh=${expired}` }))
        .status,
      401,
    );
    await prisma.user.update({
      where: { email },
      data: { status: 'INACTIVE' },
    });
    assert.equal(
      (await call('me', undefined, { Authorization: authorization })).status,
      401,
    );
  },
);
test('gateway auth proxy sanitizes upstream failures and enforces deadlines', async () => {
  const {
    AuthProxyService,
  } = require('../apps/api-gateway/dist/auth/auth-proxy.service');
  const { createServer } = require('node:http');
  let mode = 'error';
  const server = createServer((req, res) => {
    assert.equal(req.url, '/auth/login');
    assert.equal(req.method, 'POST');
    if (mode === 'timeout') return;
    if (mode === 'body-timeout') {
      res.writeHead(200);
      res.write('{');
      return;
    }
    if (mode === 'invalid') {
      res.end('{"passwordHash":"secret"}');
      return;
    }
    res.writeHead(mode === 'credentials' ? 401 : 500);
    res.end('secret database credentials');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const proxy = new AuthProxyService(
      new ConfigService({
        AUTH_SERVICE_URL: `http://127.0.0.1:${server.address().port}`,
        AUTH_SERVICE_TIMEOUT_MS: 100,
      }),
    );
    for (const [next, status] of [
      ['error', 502],
      ['credentials', 401],
      ['invalid', 502],
      ['timeout', 504],
      ['body-timeout', 504],
    ]) {
      mode = next;
      await assert.rejects(
        proxy.forward('login', {
          email: 'test@example.com',
          password: 'test password',
        }),
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
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('frontend validates forms, restores session, refreshes once, and keeps tokens in memory', async () => {
  const ts = require('typescript');
  const Module = require('node:module');
  const filename = path.resolve(__dirname, '../apps/web/src/auth.ts');
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
  const auth = module.exports;
  assert.equal(
    auth.credentialsSchema.safeParse({ email: 'invalid', password: 'short' })
      .success,
    false,
  );
  assert.equal(
    auth.credentialsSchema.parse({
      email: ' ALICE@example.com ',
      password: 'long enough password',
    }).email,
    'alice@example.com',
  );
  const original = globalThis.fetch;
  const requests = [];
  let failMe = true;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/me') && failMe) {
      failMe = false;
      return Response.json({ message: 'Expired' }, { status: 401 });
    }
    return Response.json(
      url.endsWith('/me')
        ? { id: 'user', email: 'test@example.com', status: 'ACTIVE' }
        : { accessToken: 'memory-token' },
    );
  };
  try {
    await Promise.all([auth.refreshSession(), auth.refreshSession()]);
    assert.equal(requests.length, 1);
    assert.equal((await auth.currentUser()).email, 'test@example.com');
    assert.equal(
      requests.filter((request) => request.url.endsWith('/refresh')).length,
      2,
    );
    assert.equal(
      requests.at(-1).options.headers.Authorization,
      'Bearer memory-token',
    );
    await auth.register({
      email: 'test@example.com',
      password: 'long enough password',
    });
    await auth.login({
      email: 'test@example.com',
      password: 'long enough password',
    });
    await auth.logout();
    await auth.currentUser();
    assert.equal(requests.at(-1).options.headers.Authorization, undefined);
    assert.equal(
      requests.every(
        (request) =>
          request.url.startsWith('/api/auth/') &&
          request.options.credentials === 'same-origin',
      ),
      true,
    );
  } finally {
    globalThis.fetch = original;
  }
});
