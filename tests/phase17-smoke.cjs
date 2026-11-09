/* global console */
// HTTP smoke against a real production Next.js server and a transport-only Gateway fixture.
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');
const web = path.resolve(__dirname, '../apps/web');
const webRequire = createRequire(path.join(web, 'package.json'));
const requests = [];
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
(async () => {
  const gateway = http.createServer((req, res) => {
    requests.push({
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie':
        'pharma_refresh=fixture; HttpOnly; SameSite=Strict; Path=/api/auth',
    });
    res.end(JSON.stringify({ ok: true }));
  });
  const gatewayPort = await listen(gateway);
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  let output = '';
  const child = spawn(
    process.execPath,
    [
      webRequire.resolve('next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: web,
      env: {
        ...process.env,
        API_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`${base}/login`)).ok) {
          ready = true;
          break;
        }
      } catch {
        // Wait for the production server to finish starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, output);
    for (const route of [
      '/login',
      '/register',
      '/organizations',
      '/organizations/org',
      '/organizations/org/products',
      '/organizations/org/products/product',
      '/organizations/org/products/product/gtins/gtin/batches',
      '/organizations/org/batches/batch',
      '/organizations/org/serials/serial',
      '/organizations/org/aggregates/aggregate',
      '/organizations/org/shipments/shipment',
      '/organizations/org/trace',
      '/organizations/org/recalls/recall',
      '/organizations/org/verification',
      '/verify',
    ]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      const html = await response.text();
      assert.match(html, /Pharma/, route);
      if (route === '/verify') {
        assert.match(html, /Verify a pharmaceutical pack/);
        assert.match(html, /<meta name="description"/);
      }
      if (route.startsWith('/organizations')) {
        assert.match(html, /Verifying your session/);
        assert.doesNotMatch(html, /operator@example/);
      }
    }
    const missing = await fetch(`${base}/unrecognized-route`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Page not found/);
    const unsupported = await fetch(
      `${base}/organizations/org/trace/unsupported/reference`,
    );
    assert.match(await unsupported.text(), /Page not found/);
    const origin = base;
    const response = await fetch(`${base}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: 'pharma_refresh=old',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(requests.at(-1).host, `127.0.0.1:${port}`);
    assert.equal(requests.at(-1).origin, origin);
    assert.equal(requests.at(-1).cookie, 'pharma_refresh=old');
    assert.equal(requests.at(-1).url, '/api/auth/refresh');
    console.log(
      'Phase 17 production HTTP smoke passed: 15 routes, 404s, metadata, protected SSR, and Gateway transport.',
    );
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
    await new Promise((resolve) => gateway.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
