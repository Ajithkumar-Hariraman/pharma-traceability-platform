/* global window, document, Response, Request, URL */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');
const web = path.resolve(__dirname, '../apps/web');
const webRequire = createRequire(path.join(web, 'package.json'));
const React = webRequire('react');
const { act } = React;
const { JSDOM } = webRequire('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:5173',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Event: dom.window.Event,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
});
const { createRoot } = webRequire('react-dom/client');
let root, container;
const cleanups = [];
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  container?.remove();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function load(name, mocks = {}, cache = new Map()) {
  const filename = path.resolve(web, 'src', name);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const localRequire = (spec) => {
    if (Object.hasOwn(mocks, spec)) return mocks[spec];
    if (spec === 'next/link')
      return {
        __esModule: true,
        default: ({ children, ...props }) =>
          React.createElement('a', props, children),
      };
    if (spec.startsWith('.')) {
      const base = path.resolve(path.dirname(filename), spec);
      for (const extension of ['.ts', '.tsx'])
        if (existsSync(base + extension))
          return load(
            path.relative(path.join(web, 'src'), base + extension),
            mocks,
            cache,
          );
    }
    return webRequire(spec);
  };
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  new Function('require', 'module', 'exports', code)(
    localRequire,
    module,
    module.exports,
  );
  return module.exports;
}
async function render(Component, props = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(React.createElement(Component, props)));
  return container;
}
async function click(element) {
  assert.ok(element, 'Expected an interactive element');
  await act(async () =>
    element.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }),
    ),
  );
}
async function input(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
const user = { id: 'user-1', email: 'operator@example.test', status: 'ACTIVE' };
const router = { push: () => {}, replace: () => {} };
const navigation = (params = {}, pathname = '/organizations') => ({
  useRouter: () => router,
  usePathname: () => pathname,
  useParams: () => params,
});
function session(value = {}) {
  return {
    './SessionProvider': {
      useSession: () => ({
        user,
        loading: false,
        error: '',
        retry: () => {},
        setUser: () => {},
        ...value,
      }),
    },
  };
}

test('Phase 17 App Router preserves domain, GTIN and batch-serial routes; Vite is removed', () => {
  const routes = [
    'login',
    'register',
    'organizations',
    'organizations/[organizationId]',
    'organizations/[organizationId]/facilities',
    'organizations/[organizationId]/products/[productId]',
    'organizations/[organizationId]/products/[productId]/gtins/[gtinId]/batches',
    'organizations/[organizationId]/batches/[batchId]',
    'organizations/[organizationId]/batches/[batchId]/serials',
    'organizations/[organizationId]/serials/[serialId]',
    'organizations/[organizationId]/aggregates/[aggregateId]',
    'organizations/[organizationId]/shipments/[shipmentId]',
    'organizations/[organizationId]/trace',
    'organizations/[organizationId]/recalls/[recallId]',
    'verify',
  ];
  for (const route of routes)
    assert.ok(existsSync(path.join(web, 'src/app', route, 'page.tsx')), route);
  for (const name of ['vite.config.ts', 'index.html', 'src/main.tsx'])
    assert.equal(existsSync(path.join(web, name)), false);
  for (const name of ['loading.tsx', 'error.tsx', 'not-found.tsx'])
    assert.ok(existsSync(path.join(web, 'src/app', name)));
});

test('protected navigation redirects guests and does not mount operational content', async () => {
  const calls = [];
  const old = router.replace;
  router.replace = (value) => calls.push(value);
  cleanups.push(() => (router.replace = old));
  const { ProtectedShell } = load('ProtectedShell.tsx', {
    ...session({ user: null }),
    'next/navigation': navigation(),
  });
  await render(ProtectedShell, {
    children: React.createElement('p', null, 'Private organization'),
  });
  assert.deepEqual(calls, ['/login']);
  assert.doesNotMatch(container.textContent, /Private organization/);
});

test('authenticated shell exposes domains, active route, mobile controls and logout', async () => {
  let signedOut = false;
  const calls = [];
  const { ProtectedShell } = load('ProtectedShell.tsx', {
    ...session({
      setUser: (value) => {
        signedOut = value === null;
      },
    }),
    'next/navigation': navigation(
      { organizationId: 'org' },
      '/organizations/org/products',
    ),
    './auth': { logout: async () => calls.push('logout') },
  });
  await render(ProtectedShell, {
    children: React.createElement('h1', null, 'Products'),
  });
  assert.equal(
    container.querySelector('[aria-current="page"]').textContent,
    'Products',
  );
  for (const title of [
    'Overview',
    'Facilities',
    'Serialization',
    'Aggregation',
    'Shipments',
    'Traceability',
    'Recalls',
    'Verification',
  ])
    assert.ok(
      [...container.querySelectorAll('a')].some((a) => a.textContent === title),
    );
  await click(
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Menu',
    ),
  );
  assert.equal(
    container.querySelector('[aria-controls]').getAttribute('aria-expanded'),
    'true',
  );
  await click(
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Sign out',
    ),
  );
  assert.equal(signedOut, true);
  assert.deepEqual(calls, ['logout']);
});

test('login validates credentials, uses existing login API and navigates to organizations', async () => {
  const calls = [];
  const old = router.push;
  router.push = (value) => calls.push(value);
  cleanups.push(() => (router.push = old));
  const auth = load('auth.ts');
  const { AuthPage } = load('AuthPage.tsx', {
    ...session({ user: null }),
    'next/navigation': navigation(),
    './auth': {
      ...auth,
      login: async (values) => {
        calls.push(values);
        return user;
      },
    },
  });
  await render(AuthPage, { page: 'login' });
  await input(container.querySelector('#email'), 'operator@example.test');
  await input(container.querySelector('#password'), 'long-password-123');
  await act(async () =>
    container
      .querySelector('form')
      .dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(calls[0].email, 'operator@example.test');
  assert.equal(calls[1], '/organizations');
});

test('organization navigation renders the requested product/batch/serial/aggregation/shipment/trace/recall workspace', async (t) => {
  for (const [section, heading] of [
    ['products', 'Products'],
    ['batches', 'Batches'],
    ['serials', 'Serials'],
    ['aggregates', 'Containers'],
    ['shipments', 'Shipments'],
    ['trace', 'Traceability'],
    ['recalls', 'Recalls'],
  ]) {
    await t.test(section, async () => {
      const requests = [];
      const request = async (url) => {
        requests.push(url);
        if (url === '/organizations/org')
          return { id: 'org', legalName: 'Acme Pharma', status: 'ACTIVE' };
        if (url.endsWith('/memberships'))
          return [{ id: 'member', userId: user.id, role: 'ORG_ADMIN' }];
        if (
          url.includes('/trace/') ||
          url.includes('/shipments?') ||
          url.includes('/recalls?')
        )
          return { items: [], page: 1, pageSize: 25, total: 0 };
        return [];
      };
      const { OrganizationWorkspace } = load('OrganizationWorkspace.tsx', {
        'next/navigation': navigation({ organizationId: 'org' }),
        './auth': { authenticatedRequest: request },
      });
      await render(OrganizationWorkspace, { userId: user.id, section });
      assert.match(
        container.querySelector('h1').textContent,
        new RegExp(heading, 'i'),
      );
      assert.ok(
        requests.some((url) =>
          url.includes(section === 'serials' ? '/batches' : `/${section}`),
        ),
      );
      await act(async () => root.unmount());
      root = null;
      container.remove();
    });
  }
});

test('dashboard uses real API totals, partial errors and latest trace events', async () => {
  const calls = [];
  const { OrganizationDashboard } = load('OrganizationDashboard.tsx', {
    './auth': {
      authenticatedRequest: async (url) => {
        calls.push(url);
        if (url.includes('trace')) return { items: [], total: 0 };
        if (url.includes('shipments')) return { total: 17 };
        if (url.includes('recalls')) return { total: 2 };
        return [{ id: '1' }, { id: '2' }];
      },
    },
  });
  await render(OrganizationDashboard, {
    organizationId: 'org',
    name: 'Acme Pharma',
  });
  assert.match(container.textContent, /Acme Pharma/);
  assert.match(container.textContent, /17/);
  assert.ok(calls.some((url) => url.includes('status=ACTIVE')));
  assert.match(container.textContent, /Records returned by list API/);
});

test('verification validates GTIN/serial and presents all five service result states', async (t) => {
  for (const state of [
    'VALID',
    'RECALLED',
    'QUARANTINED',
    'DECOMMISSIONED',
    'UNKNOWN',
  ])
    await t.test(state, async () => {
      let called = 0;
      const { VerificationWorkspace } = load('VerificationWorkspace.tsx', {
        './auth': {
          authenticatedRequest: async (url, method, body) => {
            called++;
            assert.equal(url, '/organizations/org/verification');
            assert.equal(method, 'POST');
            return {
              ...body,
              result: state,
              explanation: 'Recorded status',
              verifiedAt: '2026-01-01T00:00:00Z',
            };
          },
        },
      });
      await render(VerificationWorkspace, { organizationId: 'org' });
      await act(async () =>
        container
          .querySelector('form')
          .dispatchEvent(
            new window.Event('submit', { bubbles: true, cancelable: true }),
          ),
      );
      assert.equal(called, 0);
      assert.match(
        container.querySelector('[role="alert"]').textContent,
        /valid GS1 GTIN/,
      );
      await input(container.querySelector('#verify-gtin'), '09506000134352');
      await input(container.querySelector('#verify-serial'), 'PACK-001');
      await act(async () =>
        container
          .querySelector('form')
          .dispatchEvent(
            new window.Event('submit', { bubbles: true, cancelable: true }),
          ),
      );
      assert.equal(called, 1);
      assert.equal(
        container
          .querySelector('.verification-status')
          .textContent.includes(state),
        true,
      );
      await act(async () => root.unmount());
      root = null;
      container.remove();
    });
});

test('public verification shows authentication boundary before exposing pack lookup', async () => {
  const { PublicVerification } = load(
    'PublicVerification.tsx',
    session({ user: null }),
  );
  await render(PublicVerification);
  assert.match(
    container.textContent,
    /requires authorized organization access/,
  );
  assert.equal(container.querySelector('a').getAttribute('href'), '/login');
  assert.equal(container.querySelector('form'), null);
});

test('status and lifecycle presentation highlights current state without implying transitions', async () => {
  const { Lifecycle } = load('ui.tsx');
  await render(Lifecycle, {
    states: ['CREATED', 'COMMISSIONED', 'QUARANTINED', 'DECOMMISSIONED'],
    current: 'QUARANTINED',
  });
  assert.equal(
    container
      .querySelector('[aria-current="step"] [data-status]')
      .getAttribute('data-status'),
    'QUARANTINED',
  );
});

test('document UI lists evidence, exposes upload controls and preserves admin delete APIs', async () => {
  const calls = [];
  const confirm = window.confirm;
  window.confirm = () => true;
  cleanups.push(() => (window.confirm = confirm));
  const { DocumentAttachments } = load('DocumentAttachments.tsx', {
    './auth': {
      authenticatedRequest: async (url, method) => {
        calls.push([url, method]);
        return method === 'DELETE'
          ? {}
          : [
              {
                id: 'doc',
                originalFileName: 'recall.pdf',
                category: 'RECALL_NOTICE',
                createdAt: '2026-01-01',
                status: 'READY',
              },
            ];
      },
    },
  });
  await render(DocumentAttachments, {
    base: '/organizations/org/recalls/recall',
    domain: 'RECALL',
    write: true,
    admin: true,
  });
  assert.match(container.textContent, /recall.pdf/);
  assert.ok(container.querySelector('input[type="file"]'));
  const deletion = [...container.querySelectorAll('button')].find((b) =>
    /Delete/i.test(b.textContent),
  );
  await click(deletion);
  assert.ok(
    calls.some(
      ([url, method]) => url.endsWith('/documents/doc') && method === 'DELETE',
    ),
  );
});

test('auth retries a 401 with a single shared refresh, keeps tokens in memory and sends same-origin credentials', async () => {
  const old = globalThis.fetch;
  const calls = [];
  let attempts = 0;
  globalThis.fetch = async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('/refresh'))
      return Response.json({ accessToken: 'rotated' });
    if (++attempts === 1)
      return Response.json({ message: 'Expired' }, { status: 401 });
    return Response.json({ ok: true });
  };
  cleanups.push(() => (globalThis.fetch = old));
  const auth = load('auth.ts');
  assert.deepEqual(await auth.authenticatedRequest('/organizations'), {
    ok: true,
  });
  assert.equal(calls.filter(([url]) => url.endsWith('/refresh')).length, 1);
  assert.equal(calls.at(-1)[1].headers.Authorization, 'Bearer rotated');
  assert.ok(
    calls.every(([, options]) => options.credentials === 'same-origin'),
  );
});

test('frontend forwarding uses native HTTP to preserve original Host, Origin and refresh cookies', async () => {
  const { PassThrough } = require('node:stream');
  const { EventEmitter } = require('node:events');
  const calls = [];
  const transport = (url, options, callback) => {
    calls.push([url, options]);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = {
        'content-type': 'application/json',
        'set-cookie': [
          'pharma_refresh=opaque; HttpOnly; SameSite=Strict; Path=/api/auth',
        ],
      };
      callback(response);
      response.end('{"ok":true}');
    };
    return request;
  };
  const { POST } = load('app/api/[...path]/route.ts', {
    'node:http': { request: transport },
    'node:https': { request: transport },
  });
  const request = new Request('http://localhost:5173/api/auth/login', {
    method: 'POST',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  request.nextUrl = new URL(request.url);
  const response = await POST(request);
  assert.equal(calls[0][0].pathname, '/api/auth/login');
  assert.equal(calls[0][1].headers.host, 'localhost:5173');
  assert.equal(calls[0][1].headers.origin, 'http://localhost:5173');
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true });
});

test('document upload sends binary directly to storage, then finalizes through Gateway', async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(['binary', url, options]);
    return new Response(null, { status: 200 });
  };
  cleanups.push(() => (globalThis.fetch = oldFetch));
  const { DocumentAttachments } = load('DocumentAttachments.tsx', {
    './auth': {
      authenticatedRequest: async (url, method, body) => {
        calls.push([method ?? 'GET', url, body]);
        if (url.endsWith('/uploads'))
          return {
            document: { id: 'doc' },
            url: 'https://storage.invalid/presigned',
            headers: { 'Content-Type': 'application/pdf' },
          };
        return [];
      },
    },
  });
  await render(DocumentAttachments, {
    base: '/organizations/org/products/product',
    domain: 'PRODUCT',
    write: true,
    admin: false,
  });
  const file = {
    name: 'certificate.pdf',
    type: 'application/pdf',
    size: 4,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  };
  const selection = container.querySelector('input[type="file"]');
  Object.defineProperty(selection, 'files', {
    value: [file],
    configurable: true,
  });
  await act(async () => {
    selection.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const binary = calls.find(([method]) => method === 'binary');
  assert.ok(binary);
  assert.equal(binary[1], 'https://storage.invalid/presigned');
  assert.equal(binary[2].method, 'PUT');
  assert.equal(binary[2].body, file);
  assert.equal(binary[2].credentials, 'omit');
  assert.ok(
    calls.some(
      ([method, url]) =>
        method === 'POST' && url.endsWith('/documents/doc/finalize'),
    ),
  );
});

test('failed verification remains an error and never renders VALID', async () => {
  const { VerificationWorkspace } = load('VerificationWorkspace.tsx', {
    './auth': {
      authenticatedRequest: async () => {
        throw new Error('Verification unavailable');
      },
    },
  });
  await render(VerificationWorkspace, { organizationId: 'org' });
  await input(container.querySelector('#verify-gtin'), '09506000134352');
  await input(container.querySelector('#verify-serial'), 'PACK-001');
  await act(async () =>
    container
      .querySelector('form')
      .dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
      ),
  );
  assert.match(
    container.querySelector('[role="alert"]').textContent,
    /Verification unavailable/,
  );
  assert.equal(
    container
      .querySelector('.verification-status')
      .textContent.includes('VALID'),
    false,
  );
});

test('expired refresh clears the session through the shared expiration event', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ message: 'Expired' }, { status: 401 });
  cleanups.push(() => (globalThis.fetch = old));
  let expired = 0;
  const listener = () => expired++;
  window.addEventListener('pharma:session-expired', listener);
  cleanups.push(() =>
    window.removeEventListener('pharma:session-expired', listener),
  );
  const auth = load('auth.ts');
  await assert.rejects(auth.authenticatedRequest('/organizations'), /Expired/);
  assert.equal(expired, 1);
});

test('Serial Detail renders commission for a CREATED serial without a parent', async () => {
  const item = {
    id: 'serial-1',
    batchId: 'batch-1',
    serialNumber: 'SN-1',
    status: 'CREATED',
    commissionedAt: null,
    decommissionedAt: null,
  };
  const { SerialWorkspace } = load('SerialWorkspace.tsx', {
    './auth': {
      authenticatedRequest: async (path) => {
        if (path.endsWith('/parent')) return { parent: null };
        if (path.endsWith('/serials/serial-1')) return item;
        if (path.endsWith('/batches/batch-1'))
          return {
            id: 'batch-1',
            productId: 'product-1',
            gtinId: 'gtin-1',
            status: 'ACTIVE',
          };
        if (path.endsWith('/gtins/gtin-1')) return { id: 'gtin-1' };
        if (path.endsWith('/products/product-1')) return { id: 'product-1' };
        throw new Error(`Unexpected request ${path}`);
      },
    },
  });
  const view = await render(SerialWorkspace, {
    organizationId: 'org-1',
    serialId: item.id,
    role: 'OPERATOR',
    navigate: () => {},
  });
  assert.match(view.textContent, /Unaggregated/);
  assert.match(view.textContent, /SN-1/);
  const commission = [...view.querySelectorAll('button')].find(
    (button) => button.textContent === 'commission serial',
  );
  assert.ok(commission);
  assert.equal(commission.disabled, false);
});

test('PALLET Traceability UI requests the exact aggregate UUID and displays packing, dispatch and receipt', async () => {
  const org = '1200838a-1441-4b95-a524-296fbb7f9e2b';
  const pallet = '63b493e3-c8ee-453d-b06a-2a1f10800f0f';
  const requests = [];
  const { TraceWorkspace } = load('TraceWorkspace.tsx', {
    './auth': {
      authenticatedRequest: async (url) => {
        requests.push(url);
        return {
          total: 3,
          page: 1,
          pageSize: 25,
          items: ['packing', 'shipping', 'receiving'].map(
            (businessStep, i) => ({
              id: `event-${i}`,
              eventId: `event-${i}`,
              eventType: i ? 'TRANSACTION' : 'AGGREGATION',
              action: i ? 'OBSERVE' : 'ADD',
              businessStep,
              eventTime: '2026-11-10T00:00:00Z',
              recordTime: '2026-11-10T00:00:00Z',
              aggregateContainerId: i ? null : pallet,
            }),
          ),
        };
      },
    },
  });
  await render(TraceWorkspace, {
    organizationId: org,
    scope: 'aggregates',
    referenceId: pallet,
  });
  assert.deepEqual(requests, [
    `/organizations/${org}/trace/aggregates/${pallet}?page=1&pageSize=25`,
  ]);
  assert.match(container.textContent, /3 events/);
  for (const step of ['packing', 'shipping', 'receiving'])
    assert.match(container.textContent, new RegExp(step));
});
