const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;
const FRONTEND_ADMIN = path.join(__dirname, '../../frontend/admin');
const APP_JS = path.join(__dirname, '../src/app.js');

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;

function extractSessionCookie(setCookie) {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    if (raw.startsWith('fh_session=')) {
      const nameValue = raw.split(';')[0];
      if (nameValue !== 'fh_session=' && nameValue !== 'fh_session') {
        return nameValue;
      }
    }
  }
  return null;
}

async function api(pathSuffix, options = {}) {
  const response = await fetch(`${API}${pathSuffix}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    body = null;
  }
  return { response, body };
}

function postJson(pathSuffix, payload, headers = {}) {
  return api(pathSuffix, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

async function fetchNoFollow(url, init = {}) {
  return fetch(url, { ...init, redirect: 'manual' });
}

async function registerUser() {
  const email = `admin-ord-${unique()}@example.com`;
  const password = validPassword();
  const { response } = await postJson('/auth/register', {
    firstName: 'Ord',
    lastName: 'Admin',
    email,
    password,
  });
  assert.equal(response.status, 201);
  return { email, password };
}

async function loginUser(email, password) {
  return postJson('/auth/login', { email, password });
}

let pool;

before(async () => {
  const { runUp } = require('../src/services/migrator');
  await runUp();
  const db = require('../src/config/database');
  pool = db;
});

after(async () => {
  if (pool) {
    await pool.closePool().catch(() => {});
  }
});

async function promoteAdmin(email) {
  await pool.query(
    `UPDATE users SET role = 'admin', status = 'active' WHERE email = $1`,
    [email.toLowerCase()]
  );
}

async function demote(email) {
  await pool.query(
    `UPDATE users SET role = 'customer', status = 'active' WHERE email = $1`,
    [email.toLowerCase()]
  );
}

async function adminSession() {
  const { email, password } = await registerUser();
  await promoteAdmin(email);
  const login = await loginUser(email, password);
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);
  return { email, password, cookie };
}

async function customerSession() {
  const { email, password } = await registerUser();
  const login = await loginUser(email, password);
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);
  return { email, password, cookie };
}

async function createHostingOrder(cookie) {
  const { body: plans } = await api('/plans/hosting');
  const list = Array.isArray(plans.data)
    ? plans.data
    : (plans.data && plans.data.plans) || [];
  const plan = list[0];
  assert.ok(plan, 'need a seeded hosting plan');
  const { response, body } = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: plan.slug },
    { Cookie: cookie }
  );
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
}

test('admin dashboard: anonymous → 401, customer → 403, admin → 200 numeric metrics', async () => {
  const anon = await api('/admin/dashboard');
  assert.equal(anon.response.status, 401);
  assert.equal(anon.body.error.code, 'UNAUTHORIZED');

  const cust = await customerSession();
  const asCustomer = await api('/admin/dashboard', {
    headers: { Cookie: cust.cookie },
  });
  assert.equal(asCustomer.response.status, 403);
  assert.equal(asCustomer.body.error.code, 'FORBIDDEN');

  const admin = await adminSession();
  const ok = await api('/admin/dashboard', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.body.success, true);
  const m = ok.body.data.metrics;
  const keys = [
    'customers',
    'orders',
    'awaitingPayment',
    'paid',
    'failedOrders',
    'activeServices',
    'provisioningServices',
    'failedServices',
  ];
  for (const k of keys) {
    assert.equal(typeof m[k], 'number', `${k} must be number`);
    assert.ok(Number.isInteger(m[k]) && m[k] >= 0, `${k} non-negative int`);
  }

  const raw = JSON.stringify(ok.body);
  for (const leak of [
    'password',
    'argon2',
    'session',
    'DATABASE_',
    'SSLCOMMERZ',
    'store_password',
    'api_key',
    'secret',
  ]) {
    assert.equal(raw.toLowerCase().includes(leak.toLowerCase()), false, `leak ${leak}`);
  }

  await demote(admin.email);
});

test('admin dashboard: GET rejects request body', async () => {
  const admin = await adminSession();
  const http = require('node:http');
  const withBody = await new Promise((resolve, reject) => {
    const payload = '{"x":1}';
    const req = http.request(
      `${API}/admin/dashboard`,
      {
        method: 'GET',
        headers: {
          Cookie: admin.cookie,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d) });
          } catch {
            resolve({ status: res.statusCode, body: null });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  assert.equal(withBody.status, 400);
  assert.equal(withBody.body.error.code, 'VALIDATION_ERROR');
  await demote(admin.email);
});

test('admin orders: anonymous 401, customer 403, admin 200 with shape', async () => {
  const anon = await api('/admin/orders');
  assert.equal(anon.response.status, 401);

  const cust = await customerSession();
  const asCustomer = await api('/admin/orders', {
    headers: { Cookie: cust.cookie },
  });
  assert.equal(asCustomer.response.status, 403);

  const admin = await adminSession();
  const ok = await api('/admin/orders', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.body.success, true);
  assert.ok(Array.isArray(ok.body.data.orders));
  const p = ok.body.data.pagination;
  assert.equal(typeof p.page, 'number');
  assert.equal(typeof p.limit, 'number');
  assert.equal(typeof p.total, 'number');
  assert.equal(p.limit <= 50, true);

  if (ok.body.data.orders.length > 0) {
    const o = ok.body.data.orders[0];
    assert.ok(o.id && o.orderNumber);
    assert.ok(o.customer && o.customer.email);
    assert.ok(o.amount !== undefined && o.currency);
    assert.ok(o.status);
    assert.ok(o.createdAt);
    const raw = JSON.stringify(ok.body);
    assert.equal(raw.includes('password_hash'), false);
    assert.equal(raw.includes('$argon2'), false);
    assert.equal(raw.includes('session_hash'), false);
    assert.equal(raw.includes('metadata'), false);
  }

  await demote(admin.email);
});

test('admin orders: pagination + limit cap at 50', async () => {
  const admin = await adminSession();

  const capped = await api('/admin/orders?limit=51', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(capped.response.status, 400);
  assert.equal(capped.body.error.code, 'VALIDATION_ERROR');

  const page1 = await api('/admin/orders?page=1&limit=5', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(page1.response.status, 200);
  assert.equal(page1.body.data.pagination.page, 1);
  assert.equal(page1.body.data.pagination.limit, 5);
  assert.ok(page1.body.data.orders.length <= 5);

  const defaultRes = await api('/admin/orders', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(defaultRes.body.data.pagination.limit, 20);
  assert.equal(defaultRes.body.data.pagination.page, 1);

  await demote(admin.email);
});

test('admin orders: invalid status/productType → 400; unexpected query → 400', async () => {
  const admin = await adminSession();

  const badStatus = await api('/admin/orders?status=hacked', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badStatus.response.status, 400);
  assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');

  const badProduct = await api('/admin/orders?productType=game', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badProduct.response.status, 400);
  assert.equal(badProduct.body.error.code, 'VALIDATION_ERROR');

  const unexpected = await api('/admin/orders?userId=x', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(unexpected.response.status, 400);
  assert.equal(unexpected.body.error.code, 'VALIDATION_ERROR');

  const badPage = await api('/admin/orders?page=abc', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badPage.response.status, 400);

  await demote(admin.email);
});

test('admin orders: filters + search + deterministic ordering', async () => {
  const admin = await adminSession();
  const cust = await customerSession();
  const order = await createHostingOrder(cust.cookie);

  const byStatus = await api('/admin/orders?status=awaiting_payment', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(byStatus.response.status, 200);
  assert.ok(
    byStatus.body.data.orders.every((o) => o.status === 'awaiting_payment')
  );

  const byProduct = await api('/admin/orders?productType=hosting', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(byProduct.response.status, 200);
  assert.ok(byProduct.body.data.orders.every((o) => o.productType === 'hosting'));

  const searchRes = await api(
    `/admin/orders?search=${encodeURIComponent(order.orderNumber)}`,
    { headers: { Cookie: admin.cookie } }
  );
  assert.equal(searchRes.response.status, 200);
  assert.ok(
    searchRes.body.data.orders.some((o) => o.id === order.id),
    'search by order number finds the order'
  );

  const emailSearch = await api(
    `/admin/orders?search=${encodeURIComponent(cust.email)}`,
    { headers: { Cookie: admin.cookie } }
  );
  assert.equal(emailSearch.response.status, 200);
  assert.ok(emailSearch.body.data.orders.some((o) => o.id === order.id));

  const all = await api('/admin/orders?limit=50', {
    headers: { Cookie: admin.cookie },
  });
  const ids = all.body.data.orders.map((o) => o.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, 'no duplicate rows');

  // Deterministic: created_at DESC, id DESC
  const times = all.body.data.orders.map((o) => ({
    t: new Date(o.createdAt).getTime(),
    id: o.id,
  }));
  for (let i = 1; i < times.length; i++) {
    const prev = times[i - 1];
    const cur = times[i];
    assert.ok(
      prev.t > cur.t || (prev.t === cur.t && prev.id >= cur.id),
      'ordering must be created_at DESC, id DESC'
    );
  }

  await demote(admin.email);
  await demote(cust.email);
});

test('admin order detail: 200 shape, 404 unknown, customer 403, no secrets', async () => {
  const admin = await adminSession();
  const cust = await customerSession();
  const order = await createHostingOrder(cust.cookie);

  const detail = await api(`/admin/orders/${order.id}`, {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.success, true);
  const d = detail.body.data;
  assert.equal(d.order.id, order.id);
  assert.equal(d.order.orderNumber, order.orderNumber);
  assert.equal(d.customer.email, cust.email);
  assert.ok(Array.isArray(d.payments));
  assert.ok('service' in d);

  const raw = JSON.stringify(detail.body);
  for (const leak of [
    'password_hash',
    '$argon2',
    'session_hash',
    'store_password',
    'SSLCOMMERZ_STORE',
    'TEXTBEE',
    'api_key',
    'metadata',
    'credentials_ref',
    'external_id',
    'sessionToken',
  ]) {
    assert.equal(raw.includes(leak), false, `must not expose ${leak}`);
  }

  // customer cannot access admin detail
  const asCustomer = await api(`/admin/orders/${order.id}`, {
    headers: { Cookie: cust.cookie },
  });
  assert.equal(asCustomer.response.status, 403);

  // unknown order → 404
  const missing = await api(
    '/admin/orders/00000000-0000-4000-8000-000000000000',
    { headers: { Cookie: admin.cookie } }
  );
  assert.equal(missing.response.status, 404);

  // invalid uuid → 400
  const badId = await api('/admin/orders/not-a-uuid', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badId.response.status, 400);

  // anonymous → 401
  const anon = await api(`/admin/orders/${order.id}`);
  assert.equal(anon.response.status, 401);

  await demote(admin.email);
  await demote(cust.email);
});

test('admin orders UI: clean routes + CSP markup + sidebar nav', async () => {
  const list = await fetch(`${BASE_URL}/admin/orders`);
  assert.equal(list.status, 200);
  assert.match(list.headers.get('content-type') || '', /text\/html/);

  const detailRes = await fetch(
    `${BASE_URL}/admin/orders/00000000-0000-4000-8000-000000000001`
  );
  assert.equal(detailRes.status, 200);
  assert.match(detailRes.headers.get('content-type') || '', /text\/html/);

  const legacy = await fetchNoFollow(`${BASE_URL}/admin/orders.html`);
  assert.equal(legacy.status, 301);
  const loc = legacy.headers.get('location') || '';
  assert.ok(loc === '/admin/orders' || loc.endsWith('/admin/orders'), loc);

  for (const file of ['orders.html', 'order-detail.html', 'dashboard.html']) {
    const html = fs.readFileSync(path.join(FRONTEND_ADMIN, file), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, `${file} inline script`);
    assert.doesNotMatch(html, /<style\b/i, `${file} style block`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${file} style attr`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${file} event handler`);
    assert.match(html, /href="\/admin\/css\/admin\.css"/, `${file} css`);
    assert.match(html, /name="robots" content="noindex, nofollow"/, `${file} noindex`);
  }

  const ordersHtml = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'orders.html'),
    'utf8'
  );
  assert.match(ordersHtml, /href="\/admin\/dashboard"/);
  assert.match(ordersHtml, /href="\/admin\/orders"/);
  assert.match(ordersHtml, /id="admin-orders-tbody"/);
  assert.match(ordersHtml, /id="filter-status"/);
  assert.match(ordersHtml, /Customers/);
  assert.match(ordersHtml, /Settings/);

  const dashHtml = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'dashboard.html'),
    'utf8'
  );
  assert.match(dashHtml, /id="metric-customers"/);
  assert.match(dashHtml, /href="\/admin\/orders"/);
});

test('admin JS: clean paths, no .html nav, no innerHTML', () => {
  for (const file of [
    'admin-dashboard.js',
    'admin-orders.js',
    'admin-order-detail.js',
    'admin-auth.js',
  ]) {
    const src = fs.readFileSync(path.join(FRONTEND_ADMIN, 'js', file), 'utf8');
    assert.doesNotMatch(src, /innerHTML\s*=/, `${file} innerHTML`);
    assert.doesNotMatch(
      src,
      /["'](login|dashboard|orders|index)\.html/,
      `${file} .html navigation`
    );
    assert.match(src, /credentials:\s*["']include["']|FlareAdmin/, file);
  }

  const ordersJs = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js/admin-orders.js'),
    'utf8'
  );
  assert.match(ordersJs, /\/api\/admin\/orders/);
  assert.match(ordersJs, /params\.set\("status"/);
  assert.match(ordersJs, /params\.set\("productType"/);
  assert.match(ordersJs, /params\.set\("search"/);

  const detailJs = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js/admin-order-detail.js'),
    'utf8'
  );
  assert.match(detailJs, /\/api\/admin\/orders\//);
  assert.match(detailJs, /providerTransactionId/);
  assert.doesNotMatch(detailJs, /metadata/, 'detail must not render metadata');
});

test('app.js: admin order routes registered; API still before static', () => {
  const src = fs.readFileSync(APP_JS, 'utf8');
  assert.match(src, /ADMIN_ORDER_DETAIL_PATTERN/);
  assert.match(src, /'\/admin\/orders'/);
  assert.match(src, /admin\/orders\/:id/);
  assert.match(src, /admin\/order-detail\.html/);
  const apiIdx = src.indexOf('app.use(config.apiPrefix, apiRoutes)');
  const staticIdx = src.indexOf('app.use(express.static');
  assert.ok(apiIdx !== -1 && staticIdx !== -1 && apiIdx < staticIdx);
  assert.doesNotMatch(src, /sendFile\(\s*req\.path/);
});

test('no migration required for admin dashboard/orders (schema reuse)', async () => {
  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM schema_migrations`
  );
  assert.equal(count.rows[0].n, 18, '18 migrations after 018 admin product catalog');
});
