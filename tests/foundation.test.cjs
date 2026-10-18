const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { validateEnvironment } = require('../packages/config/dist');
test('environment validation applies defaults and rejects invalid settings', () => {
  assert.deepEqual(validateEnvironment({}, 3000), {
    NODE_ENV: 'development',
    PORT: 3000,
    HOST: '0.0.0.0',
    LOG_LEVEL: 'info',
  });
  assert.equal(validateEnvironment({ PORT: '4000' }, 3000).PORT, 4000);
  for (const input of [
    { PORT: '' },
    { PORT: 0 },
    { PORT: 65536 },
    { PORT: '1.5' },
    { NODE_ENV: 'invalid' },
    { HOST: ' ' },
    { LOG_LEVEL: 'invalid' },
  ])
    assert.throws(() => validateEnvironment(input, 3000));
});
for (const [folder, service, port] of [
  ['apps/api-gateway', 'api-gateway', 13000],
  ['services/auth-service', 'auth-service', 13001],
]) {
  test(
    `${service} serves health and shuts down on SIGTERM`,
    { timeout: 15000 },
    async (t) => {
      const child = spawn(process.execPath, ['dist/main.js'], {
        cwd: path.resolve(__dirname, '..', folder),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          HOST: '127.0.0.1',
          PORT: String(port),
          LOG_LEVEL: 'silent',
          AUTH_SERVICE_URL: 'http://127.0.0.1:13001',
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
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      });
      let response;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(child.exitCode, null, output);
        try {
          response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(500),
          });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.ok(response, output || 'Service did not become ready');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { service, status: 'ok' });
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const [code, signal] = await exited;
      assert.ok(code === 0 || signal === 'SIGTERM', output);
    },
  );
}
