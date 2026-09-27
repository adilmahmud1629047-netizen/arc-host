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

async function registerUser(lastName = 'Cust') {
  const email = `admin-cust-${unique()}@example.com`;
  const password = validPassword();
  const { response } = await postJson('/auth/register', {
    firstName: 'Rahim',
    lastName,
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
  const { email, password } = await registerUser('Admin');
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

const SECRET_LEAKS = [
  'password_hash',
  '$argon2',
  'session_hash',
  'store_password',
  'SSLCOMMERZ_STORE',
  'TEXTBEE',
  'api_key',
  'metadata',
  'credentials_ref',
  'sessionToken',
];

function assertNoSecrets(raw) {
  for (const leak of SECRET_LEAKS) {
    assert.equal(raw.includes(leak), false, `must not expose ${leak}`);
  }
}

test('admin customers authz: anonymous 401, customer 403, admin 200 list+detail', async () => {
  const anonList = await api('/admin/customers');
  assert.equal(anonList.response.status, 401);
  assert.equal(anonList.body.error.code, 'UNAUTHORIZED');

  const anonDetail = await api('/admin/customers/00000000-0000-4000-8000-000000000001');
  assert.equal(anonDetail.response.status, 401);

  const cust = await customerSession();
  const asCustList = await api('/admin/customers', {
    headers: { Cookie: cust.cookie },
  });
  assert.equal(asCustList.response.status, 403);
  assert.equal(asCustList.body.error.code, 'FORBIDDEN');

  const asCustDetail = await api(
    '/admin/customers/00000000-0000-4000-8000-000000000001',
    { headers: { Cookie: cust.cookie } }
  );
  assert.equal(asCustDetail.response.status, 403);

  const admin = await adminSession();
  const okList = await api('/admin/customers', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(okList.response.status, 200);
  assert.equal(okList.body.success, true);
  assert.ok(Array.isArray(okList.body.data.customers));

  // admin detail of their own account works
  const meRes = await api('/admin/me', { headers: { Cookie: admin.cookie } });
  assert.equal(meRes.response.status, 200);
  const adminId = meRes.body.data.admin.id;
  const okDetail = await api(`/admin/customers/${adminId}`, {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(okDetail.response.status, 200);
  assert.equal(okDetail.body.data.customer.id, adminId);

  assertNoSecrets(JSON.stringify(okList.body));
  assertNoSecrets(JSON.stringify(okDetail.body));

  await demote(admin.email);
  await demote(cust.email);
});

test('admin customers validation: bad page/limit/status/unknown query/ids', async () => {
  const admin = await adminSession();

  const badPage = await api('/admin/customers?page=abc', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badPage.response.status, 400);
  assert.equal(badPage.body.error.code, 'VALIDATION_ERROR');

  const badLimit = await api('/admin/customers?limit=0', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badLimit.response.status, 400);

  const capLimit = await api('/admin/customers?limit=51', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(capLimit.response.status, 400);
  assert.equal(capLimit.body.error.code, 'VALIDATION_ERROR');

  const badStatus = await api('/admin/customers?status=deleted', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badStatus.response.status, 400);
  assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');

  const unexpected = await api('/admin/customers?role=admin', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(unexpected.response.status, 400);
  assert.equal(unexpected.body.error.code, 'VALIDATION_ERROR');

  const longSearch = await api(
    `/admin/customers?search=${'a'.repeat(101)}`,
    { headers: { Cookie: admin.cookie } }
  );
  assert.equal(longSearch.response.status, 400);

  const badId = await api('/admin/customers/not-a-uuid', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badId.response.status, 400);
  assert.equal(badId.body.error.code, 'VALIDATION_ERROR');

  const unknownId = await api(
    '/admin/customers/00000000-0000-4000-8000-000000000099',
    { headers: { Cookie: admin.cookie } }
  );
  assert.equal(unknownId.response.status, 404);

  await demote(admin.email);
});

test('admin customers pagination defaults, cap 50, deterministic ordering', async () => {
  const admin = await adminSession();

  const defaults = await api('/admin/customers', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(defaults.response.status, 200);
  const p = defaults.body.data.pagination;
  assert.equal(p.page, 1);
  assert.equal(p.limit, 20);
  assert.equal(typeof p.total, 'number');
  assert.ok(p.totalPages >= 1);
  assert.equal(typeof p.hasNext, 'boolean');
  assert.equal(typeof p.hasPrev, 'boolean');
  assert.equal(p.hasPrev, false);

  const capped = await api('/admin/customers?limit=50', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(capped.response.status, 200);
  assert.equal(capped.body.data.pagination.limit, 50);
  assert.ok(capped.body.data.customers.length <= 50);

  const rows = capped.body.data.customers;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const pt = new Date(prev.createdAt).getTime();
    const ct = new Date(cur.createdAt).getTime();
    assert.ok(
      pt > ct || (pt === ct && prev.id >= cur.id),
      'ordering must be created_at DESC, id DESC'
    );
  }
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate rows');

  // page 2 structure
  const page2 = await api('/admin/customers?page=2&limit=5', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(page2.response.status, 200);
  assert.equal(page2.body.data.pagination.page, 2);
  assert.equal(page2.body.data.pagination.limit, 5);
  assert.equal(page2.body.data.pagination.hasPrev, true);

  await demote(admin.email);
});

test('admin customers search: email, name, LIKE escape, SQL injection safe', async () => {
  const admin = await adminSession();
  const cust = await customerSession();

  // resolve registered name from detail after finding by email search
  const byEmail = await api(
    `/admin/customers?search=${encodeURIComponent(cust.email)}`,
    { headers: { Cookie: admin.cookie } }
  );
  assert.equal(byEmail.response.status, 200);
  assert.ok(
    byEmail.body.data.customers.some((c) => c.email === cust.email),
    'email search finds customer'
  );

  const found = byEmail.body.data.customers.find(
    (c) => c.email === cust.email
  );
  assert.ok(found);
  // registered as Rahim Cust — name search
  const byName = await api('/admin/customers?search=Rahim', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(byName.response.status, 200);
  assert.ok(
    byName.body.data.customers.some((c) => c.id === found.id),
    'name search finds customer'
  );

  // LIKE wildcards must not match everything
  const wild = await api('/admin/customers?search=%25', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(wild.response.status, 200);
  // escaped % is literal — should not return every user unless email contains %
  const wildEmails = wild.body.data.customers.map((c) => c.email);
  assert.ok(
    wildEmails.every((e) => e.includes('%')) || wildEmails.length === 0,
    'escaped % is literal, not a wildcard'
  );

  const underscore = await api('/admin/customers?search=%5F', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(underscore.response.status, 200);

  // SQL injection payload — must not 500 and must not dump
  const inj = await api(
    `/admin/customers?search=${encodeURIComponent("'; DROP TABLE users;--")}`,
    { headers: { Cookie: admin.cookie } }
  );
  assert.equal(inj.response.status, 200);
  assert.ok(Array.isArray(inj.body.data.customers));
  assertNoSecrets(JSON.stringify(inj.body));

  // table still exists
  const still = await pool.query(`SELECT COUNT(*)::int AS n FROM users`);
  assert.ok(still.rows[0].n > 0);

  await demote(admin.email);
  await demote(cust.email);
});

test('admin customer detail: shape, counts, recent orders ≤10, services, no secrets', async () => {
  const admin = await adminSession();
  const cust = await customerSession();
  await createHostingOrder(cust.cookie);

  const find = await api(
    `/admin/customers?search=${encodeURIComponent(cust.email)}`,
    { headers: { Cookie: admin.cookie } }
  );
  assert.equal(find.response.status, 200);
  const row = find.body.data.customers.find((c) => c.email === cust.email);
  assert.ok(row, 'customer in list');
  assert.equal(typeof row.orderCount, 'number');
  assert.equal(typeof row.serviceCount, 'number');
  assert.ok(row.orderCount >= 1);
  assert.equal(row.role, 'customer');
  assert.equal(row.status, 'active');

  const detail = await api(`/admin/customers/${row.id}`, {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(detail.response.status, 200);
  const d = detail.body.data;
  assert.equal(d.customer.id, row.id);
  assert.equal(d.customer.email, cust.email);
  assert.equal(d.customer.role, 'customer');
  assert.equal(d.customer.status, 'active');
  assert.ok(d.customer.createdAt);
  assert.equal(typeof d.summary.orders, 'number');
  assert.equal(typeof d.summary.paidOrders, 'number');
  assert.equal(typeof d.summary.services, 'number');
  assert.ok(d.summary.orders >= 1);
  assert.equal(d.summary.paidOrders, 0, 'awaiting_payment is not paid');
  assert.ok(Array.isArray(d.recentOrders));
  assert.ok(d.recentOrders.length <= 10, 'recent orders capped at 10');
  assert.ok(Array.isArray(d.services));
  assert.ok(d.services.length <= 10);

  if (d.recentOrders.length > 0) {
    const o = d.recentOrders[0];
    assert.ok(o.id && o.orderNumber);
    assert.ok(o.productType);
    assert.ok(o.amount !== undefined && o.currency);
    assert.ok(o.status);
    assert.ok(o.createdAt);
    assert.equal('metadata' in o, false);
  }

  if (d.services.length > 0) {
    const s = d.services[0];
    assert.ok(s.id && s.serviceType && s.status);
    assert.equal('externalId' in s, false);
    assert.equal('provider' in s, false);
    assert.equal('hostname' in s, false);
    assert.equal('credentialsRef' in s, false);
  }

  assertNoSecrets(JSON.stringify(detail.body));

  await demote(admin.email);
  await demote(cust.email);
});

test('admin customers UI: clean routes + CSP + sidebar + functional Customers nav', async () => {
  const list = await fetch(`${BASE_URL}/admin/customers`);
  assert.equal(list.status, 200);
  assert.match(list.headers.get('content-type') || '', /text\/html/);

  const detailRes = await fetch(
    `${BASE_URL}/admin/customers/00000000-0000-4000-8000-000000000002`
  );
  assert.equal(detailRes.status, 200);
  assert.match(detailRes.headers.get('content-type') || '', /text\/html/);

  const legacy = await fetchNoFollow(`${BASE_URL}/admin/customers.html`);
  assert.equal(legacy.status, 301);
  const loc = legacy.headers.get('location') || '';
  assert.ok(loc === '/admin/customers' || loc.endsWith('/admin/customers'), loc);

  for (const file of [
    'customers.html',
    'customer-detail.html',
    'dashboard.html',
    'orders.html',
    'order-detail.html',
  ]) {
    const html = fs.readFileSync(path.join(FRONTEND_ADMIN, file), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, `${file} inline script`);
    assert.doesNotMatch(html, /<style\b/i, `${file} style block`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${file} style attr`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${file} event handler`);
    assert.match(html, /href="\/admin\/css\/admin\.css"/, `${file} css`);
    assert.match(html, /name="robots" content="noindex, nofollow"/, `${file} noindex`);
    assert.match(html, /href="\/admin\/customers"/, `${file} customers nav`);
    assert.doesNotMatch(
      html,
      /<span class="admin-nav-item is-disabled"[^>]*>\s*Customers/,
      `${file} Customers must be enabled`
    );
  }

  const customersHtml = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'customers.html'),
    'utf8'
  );
  assert.match(customersHtml, /id="admin-customers-tbody"/);
  assert.match(customersHtml, /id="filter-status"/);
  assert.match(customersHtml, /id="filter-search"/);
  assert.match(customersHtml, /href="\/admin\/dashboard"/);
  assert.match(customersHtml, /href="\/admin\/orders"/);

  const detailHtml = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'customer-detail.html'),
    'utf8'
  );
  assert.match(detailHtml, /id="detail-customer-email"/);
  assert.match(detailHtml, /id="detail-summary-orders"/);
  assert.match(detailHtml, /id="admin-customer-orders-tbody"/);
  assert.match(detailHtml, /id="admin-customer-services-tbody"/);
  // STEP 48: account controls are present; destructive controls stay absent
  assert.match(detailHtml, /id="customer-suspend-action"/);
  assert.match(detailHtml, /id="customer-reactivate-action"/);
  assert.match(detailHtml, /id="customer-reset-action"/);
  assert.doesNotMatch(detailHtml, /Delete customer|Change role/i);
});

test('admin customers JS: clean paths, no .html nav, no innerHTML', () => {
  for (const file of ['admin-customers.js', 'admin-customer-detail.js']) {
    const src = fs.readFileSync(path.join(FRONTEND_ADMIN, 'js', file), 'utf8');
    assert.doesNotMatch(src, /innerHTML\s*=/, `${file} innerHTML`);
    assert.doesNotMatch(
      src,
      /["'](login|dashboard|orders|customers|index)\.html/,
      `${file} .html navigation`
    );
    assert.match(src, /credentials:\s*["']include["']|FlareAdmin/, file);
  }

  const listJs = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js/admin-customers.js'),
    'utf8'
  );
  assert.match(listJs, /\/api\/admin\/customers/);
  assert.match(listJs, /params\.set\("status"/);
  assert.match(listJs, /params\.set\("search"/);

  const detailJs = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js/admin-customer-detail.js'),
    'utf8'
  );
  assert.match(detailJs, /\/api\/admin\/customers\//);
  assert.doesNotMatch(detailJs, /password_hash|argon2|session_hash/);
});

test('app.js: admin customer routes registered; API still before static', () => {
  const src = fs.readFileSync(APP_JS, 'utf8');
  assert.match(src, /ADMIN_CUSTOMER_DETAIL_PATTERN/);
  assert.match(src, /'\/admin\/customers'/);
  assert.match(src, /admin\/customers\/:id/);
  assert.match(src, /admin\/customer-detail\.html/);
  const apiIdx = src.indexOf('app.use(config.apiPrefix, apiRoutes)');
  const staticIdx = src.indexOf('app.use(express.static');
  assert.ok(apiIdx !== -1 && staticIdx !== -1 && apiIdx < staticIdx);
  assert.doesNotMatch(src, /sendFile\(\s*req\.path/);
});

test('admin customers mutation surface: account controls only, no CRUD/delete/role', async () => {
  const admin = await adminSession();
  const id = '00000000-0000-4000-8000-000000000001';

  for (const [method, path] of [
    ['POST', `/admin/customers`],
    ['PUT', `/admin/customers/${id}`],
    ['PATCH', `/admin/customers/${id}`],
    ['DELETE', `/admin/customers/${id}`],
    ['POST', `/admin/customers/${id}/role`],
    ['POST', `/admin/customers/${id}/delete`],
  ]) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Cookie: admin.cookie,
        'Content-Type': 'application/json',
      },
      body: method === 'GET' ? undefined : '{}',
    });
    assert.ok(
      res.status === 404 || res.status === 405,
      `${method} ${path} must not exist (got ${res.status})`
    );
  }

  // STEP 48: the account-control routes ARE registered — prove it with a
  // real (reversible) round trip on a fixture customer.
  const cust = await customerSession();
  const find = await api(
    `/admin/customers?search=${encodeURIComponent(cust.email)}`,
    { headers: { Cookie: admin.cookie } }
  );
  assert.equal(find.response.status, 200);
  const row = find.body.data.customers.find((c) => c.email === cust.email);
  assert.ok(row, 'fixture customer in list');

  const sus = await postJson(
    `/admin/customers/${row.id}/suspend`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(sus.response.status, 200, JSON.stringify(sus.body));
  assert.equal(sus.body.data.customer.status, 'suspended');

  const re = await postJson(
    `/admin/customers/${row.id}/reactivate`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(re.response.status, 200, JSON.stringify(re.body));
  assert.equal(re.body.data.customer.status, 'active');

  await demote(admin.email);
  await demote(cust.email);
});

test('no migration required for admin customers (schema reuse)', async () => {
  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM schema_migrations`
  );
  assert.equal(
    count.rows[0].n,
    18,
    '18 migrations after 018 admin product catalog'
  );
});
