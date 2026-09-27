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
const uniqueSlug = (prefix) => `ap45-${prefix || 'p'}-${unique()}`;

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

function json(method, pathSuffix, payload, cookie) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return api(pathSuffix, { method, headers, body: JSON.stringify(payload) });
}

async function fetchNoFollow(url, init = {}) {
  return fetch(url, { ...init, redirect: 'manual' });
}

async function registerUser(lastName = 'Prod') {
  const email = `admin-prod-${unique()}@example.com`;
  const password = validPassword();
  const { response } = await json('POST', '/auth/register', {
    firstName: 'Rahim',
    lastName,
    email,
    password,
  });
  assert.equal(response.status, 201);
  return { email, password };
}

async function loginUser(email, password) {
  return json('POST', '/auth/login', { email, password });
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

function hostingBody(slug, overrides = {}) {
  return {
    productType: 'hosting',
    name: 'AP45 Test Hosting',
    slug,
    price: '432.10',
    billingCycle: 'monthly',
    category: 'web',
    status: 'active',
    ...overrides,
  };
}

function vpsBody(slug, overrides = {}) {
  return {
    productType: 'vps',
    name: 'AP45 Test VPS',
    slug,
    price: '799',
    billingCycle: 'monthly',
    cpuCores: '2',
    ramMb: '2048',
    storageGb: '40',
    bandwidthGb: '1000',
    ipv4Addresses: '1',
    status: 'active',
    ...overrides,
  };
}

async function publicPlans(type, query = '') {
  const res = await fetch(`${BASE_URL}/api/plans/${type}${query}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const list = Array.isArray(body.data)
    ? body.data
    : (body.data && body.data.plans) || [];
  return list;
}

test('admin products API: 401 for anonymous, 403 for customers', async () => {
  const anonGet = await api('/admin/plans');
  assert.equal(anonGet.response.status, 401);
  assert.equal(anonGet.body.error.code, 'UNAUTHORIZED');

  const anonPost = await json('POST', '/admin/plans', hostingBody(uniqueSlug('a')));
  assert.equal(anonPost.response.status, 401);

  const slug = uniqueSlug('b');
  const anonPatch = await json('PATCH', '/admin/plans/hosting/00000000-0000-4000-8000-000000000001', {
    status: 'inactive',
  });
  assert.equal(anonPatch.response.status, 401);

  const anonDelete = await api(
    '/admin/plans/hosting/00000000-0000-4000-8000-000000000001',
    { method: 'DELETE' }
  );
  assert.equal(anonDelete.response.status, 401);

  const customer = await customerSession();
  const custGet = await api('/admin/plans', { headers: { Cookie: customer.cookie } });
  assert.equal(custGet.response.status, 403);
  assert.equal(custGet.body.error.code, 'FORBIDDEN');

  const custPost = await json(
    'POST',
    '/admin/plans',
    hostingBody(slug),
    customer.cookie
  );
  assert.equal(custPost.response.status, 403);

  const custDelete = await api('/admin/plans/hosting/00000000-0000-4000-8000-000000000001', {
    method: 'DELETE',
    headers: { Cookie: customer.cookie },
  });
  assert.equal(custDelete.response.status, 403);
});

test('admin products list: shape, filters, bad query', async () => {
  const admin = await adminSession();
  const { response, body } = await api('/admin/plans?page=1&limit=5', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.data.products));
  const p = body.data.pagination;
  assert.equal(p.page, 1);
  assert.equal(p.limit, 5);
  assert.equal(typeof p.total, 'number');
  assert.equal(typeof p.totalPages, 'number');
  assert.equal(typeof p.hasNext, 'boolean');
  assert.equal(typeof p.hasPrev, 'boolean');
  for (const item of body.data.products) {
    assert.ok(item.id);
    assert.ok(item.productType === 'hosting' || item.productType === 'vps');
    assert.equal(typeof item.price, 'string');
    assert.equal(typeof item.orderCount, 'number');
    assert.ok(['active', 'inactive', 'archived'].includes(item.status));
  }

  const vpsOnly = await api('/admin/plans?productType=vps', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(vpsOnly.response.status, 200);
  assert.ok(
    vpsOnly.body.data.products.every((item) => item.productType === 'vps')
  );

  const webOnly = await api('/admin/plans?productType=hosting&category=web', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(webOnly.response.status, 200);
  assert.ok(
    webOnly.body.data.products.every(
      (item) => item.productType === 'hosting' && item.category === 'web'
    )
  );

  const bad = await api('/admin/plans?nope=1', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(bad.response.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

  const badCategory = await api('/admin/plans?category=blog', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badCategory.response.status, 400);

  const badPage = await api('/admin/plans?page=abc', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badPage.response.status, 400);

  const badLimit = await api('/admin/plans?limit=999', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badLimit.response.status, 400);

  const inactiveOnly = await api('/admin/plans?status=inactive', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(inactiveOnly.response.status, 200);
  assert.ok(
    inactiveOnly.body.data.products.every((item) => item.status === 'inactive')
  );

  const searchSlug = uniqueSlug('find');
  const made = await json('POST', '/admin/plans', hostingBody(searchSlug), admin.cookie);
  assert.equal(made.response.status, 201);
  const searched = await api(`/admin/plans?search=${encodeURIComponent(searchSlug)}`, {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(searched.response.status, 200);
  assert.ok(
    searched.body.data.products.some((item) => item.slug === searchSlug),
    'search must find the created product'
  );
});

test('create product: 201, public list shows DB price, order amount from DB', async () => {
  const admin = await adminSession();
  const customer = await customerSession();
  const slug = uniqueSlug('host');

  const created = await json('POST', '/admin/plans', hostingBody(slug), admin.cookie);
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const product = created.body.data.product;
  assert.equal(product.slug, slug);
  assert.equal(product.price, '432.10');
  assert.equal(product.status, 'active');
  assert.equal(product.category, 'web');
  assert.equal(product.productType, 'hosting');
  assert.equal(product.popular, false);

  const list = await publicPlans('hosting', '?category=web');
  const publicRow = list.find((item) => item.slug === slug);
  assert.ok(publicRow, 'created product must be publicly visible');
  assert.equal(publicRow.price, '432.10');
  assert.equal('status' in publicRow, false, 'public payload must not leak status');

  const tamper = await json(
    'POST',
    '/orders',
    { productType: 'hosting', planSlug: slug, amount: '1' },
    customer.cookie
  );
  assert.equal(tamper.response.status, 400);
  assert.match(JSON.stringify(tamper.body), /Unexpected field: amount/);

  const orderRes = await json(
    'POST',
    '/orders',
    { productType: 'hosting', planSlug: slug },
    customer.cookie
  );
  assert.equal(orderRes.response.status, 201, JSON.stringify(orderRes.body));
  assert.equal(orderRes.body.data.amount, '432.10', 'order amount comes from the DB');

  const detail = await api(`/orders/${orderRes.body.data.id}`, {
    headers: { Cookie: customer.cookie },
  });
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.amount, '432.10');
});

test('inactive product: hidden from public list and not orderable', async () => {
  const admin = await adminSession();
  const customer = await customerSession();
  const slug = uniqueSlug('inactive');

  const created = await json('POST', '/admin/plans', hostingBody(slug), admin.cookie);
  assert.equal(created.response.status, 201);
  const id = created.body.data.product.id;

  const deactivate = await json(
    'PATCH',
    `/admin/plans/hosting/${id}`,
    { status: 'inactive' },
    admin.cookie
  );
  assert.equal(deactivate.response.status, 200);
  assert.equal(deactivate.body.data.product.status, 'inactive');

  const list = await publicPlans('hosting', '?category=web');
  assert.equal(
    list.find((item) => item.slug === slug),
    undefined,
    'inactive product must not be publicly listed'
  );

  const orderRes = await json(
    'POST',
    '/orders',
    { productType: 'hosting', planSlug: slug },
    customer.cookie
  );
  assert.equal(orderRes.response.status, 404);
  assert.equal(orderRes.body.error.code, 'PLAN_NOT_FOUND');

  const activate = await json(
    'PATCH',
    `/admin/plans/hosting/${id}`,
    { status: 'active' },
    admin.cookie
  );
  assert.equal(activate.response.status, 200);
  const relisted = await publicPlans('hosting', '?category=web');
  assert.ok(relisted.find((item) => item.slug === slug), 'relisted after activate');
});

test('create validation: bad price/slug/enum/field rejected with 400', async () => {
  const admin = await adminSession();

  const negative = await json(
    'POST',
    '/admin/plans',
    hostingBody(uniqueSlug('neg'), { price: '-5' }),
    admin.cookie
  );
  assert.equal(negative.response.status, 400);
  assert.equal(negative.body.error.code, 'VALIDATION_ERROR');
  assert.match(JSON.stringify(negative.body), /Price/);

  const junk = await json(
    'POST',
    '/admin/plans',
    hostingBody(uniqueSlug('junk'), { price: '12abc' }),
    admin.cookie
  );
  assert.equal(junk.response.status, 400);

  const badSlug = await json(
    'POST',
    '/admin/plans',
    hostingBody('Bad Slug Value'),
    admin.cookie
  );
  assert.equal(badSlug.response.status, 400);
  assert.match(JSON.stringify(badSlug.body), /Slug/);

  const missingName = await json(
    'POST',
    '/admin/plans',
    { productType: 'hosting', slug: uniqueSlug('nn'), price: '10' },
    admin.cookie
  );
  assert.equal(missingName.response.status, 400);

  const badCycle = await json(
    'POST',
    '/admin/plans',
    hostingBody(uniqueSlug('cyc'), { billingCycle: 'weekly' }),
    admin.cookie
  );
  assert.equal(badCycle.response.status, 400);

  const badCategory = await json(
    'POST',
    '/admin/plans',
    hostingBody(uniqueSlug('cat'), { category: 'blog' }),
    admin.cookie
  );
  assert.equal(badCategory.response.status, 400);

  const unknownField = await json(
    'POST',
    '/admin/plans',
    hostingBody(uniqueSlug('evil'), { evil: 'yes' }),
    admin.cookie
  );
  assert.equal(unknownField.response.status, 400);
  assert.match(JSON.stringify(unknownField.body), /Unexpected field/);

  const negativeStorage = await json(
    'POST',
    '/admin/plans',
    hostingBody(uniqueSlug('sto'), { storageGb: '-1' }),
    admin.cookie
  );
  assert.equal(negativeStorage.response.status, 400);
});

test('duplicate slug: 409 SLUG_TAKEN on create and update', async () => {
  const admin = await adminSession();
  const slug = uniqueSlug('dup');

  const created = await json('POST', '/admin/plans', hostingBody(slug), admin.cookie);
  assert.equal(created.response.status, 201);

  const dup = await json('POST', '/admin/plans', hostingBody(slug), admin.cookie);
  assert.equal(dup.response.status, 409);
  assert.equal(dup.body.error.code, 'SLUG_TAKEN');

  const other = await json('POST', '/admin/plans', hostingBody(uniqueSlug('x')), admin.cookie);
  assert.equal(other.response.status, 201);

  const clash = await json(
    'PATCH',
    `/admin/plans/hosting/${other.body.data.product.id}`,
    { slug },
    admin.cookie
  );
  assert.equal(clash.response.status, 409);
  assert.equal(clash.body.error.code, 'SLUG_TAKEN');
});

test('VPS product: create, public list, delete when unreferenced', async () => {
  const admin = await adminSession();
  const slug = uniqueSlug('vps');

  const created = await json('POST', '/admin/plans', vpsBody(slug), admin.cookie);
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const product = created.body.data.product;
  assert.equal(product.productType, 'vps');
  assert.equal(product.cpuCores, 2);
  assert.equal(product.ipv4Addresses, 1);

  const list = await publicPlans('vps');
  const publicRow = list.find((item) => item.slug === slug);
  assert.ok(publicRow, 'vps product must be publicly visible');
  assert.equal(publicRow.price, '799.00');

  const badUpdate = await json(
    'PATCH',
    `/admin/plans/vps/${product.id}`,
    { productType: 'hosting' },
    admin.cookie
  );
  assert.equal(badUpdate.response.status, 400);
  assert.match(JSON.stringify(badUpdate.body), /productType cannot be changed/);

  const deleted = await api(`/admin/plans/vps/${product.id}`, {
    method: 'DELETE',
    headers: { Cookie: admin.cookie },
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.data.deleted, true);

  const gone = await api(`/admin/plans/vps/${product.id}`, {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(gone.response.status, 404);

  const afterList = await publicPlans('vps');
  assert.equal(afterList.find((item) => item.slug === slug), undefined);
});

test('delete guard: referenced product → 409 PLAN_IN_USE', async () => {
  const admin = await adminSession();
  const customer = await customerSession();
  const slug = uniqueSlug('guard');

  const created = await json('POST', '/admin/plans', hostingBody(slug), admin.cookie);
  assert.equal(created.response.status, 201);
  const id = created.body.data.product.id;

  const orderRes = await json(
    'POST',
    '/orders',
    { productType: 'hosting', planSlug: slug },
    customer.cookie
  );
  assert.equal(orderRes.response.status, 201);

  const blocked = await api(`/admin/plans/hosting/${id}`, {
    method: 'DELETE',
    headers: { Cookie: admin.cookie },
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, 'PLAN_IN_USE');
  assert.match(JSON.stringify(blocked.body), /order/);

  const still = await api(`/admin/plans/hosting/${id}`, {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(still.response.status, 200);

  const setInactive = await json(
    'PATCH',
    `/admin/plans/hosting/${id}`,
    { status: 'inactive' },
    admin.cookie
  );
  assert.equal(setInactive.response.status, 200);
});

test('minecraft product: visible only under category=minecraft', async () => {
  const admin = await adminSession();
  const slug = uniqueSlug('mc');

  const created = await json(
    'POST',
    '/admin/plans',
    hostingBody(slug, { category: 'minecraft', name: 'AP45 MC Plan' }),
    admin.cookie
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.product.category, 'minecraft');

  const mcList = await publicPlans('hosting', '?category=minecraft');
  assert.ok(mcList.find((item) => item.slug === slug), 'visible under minecraft');

  const webList = await publicPlans('hosting', '?category=web');
  assert.equal(
    webList.find((item) => item.slug === slug),
    undefined,
    'minecraft product must not appear under web'
  );

  const fullList = await publicPlans('hosting');
  assert.ok(fullList.find((item) => item.slug === slug), 'unfiltered list includes it');

  const deleted = await api(`/admin/plans/hosting/${created.body.data.product.id}`, {
    method: 'DELETE',
    headers: { Cookie: admin.cookie },
  });
  assert.equal(deleted.response.status, 200, 'unreferenced minecraft product deletable');
});

test('method surface: no PUT on admin plans, public plan routes stay GET-only', async () => {
  const admin = await adminSession();
  const id = '00000000-0000-4000-8000-000000000001';

  const put = await fetch(`${API}/admin/plans/hosting/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: '{}',
  });
  assert.ok(
    put.status === 404 || put.status === 405,
    `PUT must not exist (got ${put.status})`
  );

  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const res = await fetch(`${API}/plans/hosting`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    assert.ok(
      res.status === 404 || res.status === 405,
      `public /api/plans/hosting ${method} must not exist (got ${res.status})`
    );
  }
});

test('canonical fixture plans survive every admin CRUD test', async () => {
  const hosting = await publicPlans('hosting');
  for (const slug of ['starter', 'business', 'pro']) {
    const row = hosting.find((item) => item.slug === slug);
    assert.ok(row, `canonical hosting plan ${slug} must survive tests`);
  }
  const vps = await publicPlans('vps');
  for (const slug of ['vps-1', 'vps-2']) {
    const row = vps.find((item) => item.slug === slug);
    assert.ok(row, `canonical vps plan ${slug} must survive tests`);
  }
});

test('admin products UI: served clean, nav enabled, app.js wired', async () => {
  const response = await fetch(`${BASE_URL}/admin/products`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  const html = await response.text();

  assert.ok(html.includes('id="admin-products-tbody"'));
  assert.ok(html.includes('id="filter-status"'));
  assert.ok(html.includes('id="filter-search"'));
  assert.ok(html.includes('id="admin-products-add"'));
  assert.ok(html.includes('href="/admin/css/admin.css"'));
  assert.ok(html.includes('name="robots" content="noindex, nofollow"'));
  assert.ok(html.includes('href="/admin/products?category=web"'));
  assert.ok(html.includes('href="/admin/products?category=vps"'));
  assert.ok(html.includes('href="/admin/products?category=minecraft"'));
  assert.ok(html.includes('href="/admin/dashboard"'));
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, 'no inline script');
  assert.equal(/<style\b/i.test(html), false, 'no style block');
  assert.equal(/\sstyle\s*=/i.test(html), false, 'no style attribute');
  assert.equal(/\son[a-z]+\s*=\s*["']/i.test(html), false, 'no inline handlers');
  assert.equal(
    (html.match(/class="admin-nav-item is-disabled" aria-disabled="true"/g) || [])
      .length,
    3,
    'Services/Support/Settings remain disabled on the products page'
  );

  const legacy = await fetchNoFollow(`${BASE_URL}/admin/products.html`);
  assert.equal(legacy.status, 301);
  const loc = legacy.headers.get('location') || '';
  assert.ok(loc === '/admin/products' || loc.endsWith('/admin/products'), loc);

  for (const file of [
    'dashboard.html',
    'orders.html',
    'order-detail.html',
    'customers.html',
    'customer-detail.html',
    'payments.html',
  ]) {
    const page = fs.readFileSync(path.join(FRONTEND_ADMIN, file), 'utf8');
    assert.ok(
      page.includes('href="/admin/products?category=web"'),
      `${file} hosting nav`
    );
    assert.ok(
      page.includes('href="/admin/products?category=vps"'),
      `${file} vps nav`
    );
    assert.ok(
      page.includes('href="/admin/products?category=minecraft"'),
      `${file} minecraft nav`
    );
    assert.equal(
      (page.match(/class="admin-nav-item is-disabled" aria-disabled="true"/g) ||
        []).length,
      3,
      `${file} disabled nav count`
    );
    assert.equal(/<script(?![^>]*\bsrc=)/i.test(page), false, file);
    assert.equal(/\sstyle\s*=/i.test(page), false, file);
  }

  const adminJs = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js', 'admin-products.js'),
    'utf8'
  );
  assert.ok(adminJs.includes('/api/admin/plans'));
  assert.ok(adminJs.includes('FlareAdmin'));
  assert.equal(/innerHTML\s*=/.test(adminJs), false, 'no innerHTML');
  assert.equal(
    /["'](login|dashboard|orders|customers|index)\.html/.test(adminJs),
    false
  );

  const appSrc = fs.readFileSync(APP_JS, 'utf8');
  assert.ok(appSrc.includes("'/admin/products': 'admin/products.html'"));
  assert.ok(appSrc.includes("'/admin/products.html': '/admin/products'"));

  const productsHtml = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'products.html'),
    'utf8'
  );
  assert.match(productsHtml, /id="admin-products-tbody"/);
  assert.match(productsHtml, /id="admin-products-form"/);
});

test('customer catalog: demo copy removed from public pages', async () => {
  const web = await fetch(`${BASE_URL}/web-hosting`);
  assert.equal(web.status, 200);
  const webHtml = await web.text();
  assert.equal(/sample\/demo/i.test(webHtml), false, 'web-hosting demo copy');
  assert.ok(webHtml.includes('data-category="web"'));

  const mc = await fetch(`${BASE_URL}/minecraft-hosting`);
  assert.equal(mc.status, 200);
  const mcJs = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/minecraft-page.js'),
    'utf8'
  );
  assert.ok(mcJs.includes('category=minecraft'));
  assert.ok(mcJs.includes('"minecraft"'));

  const faq = await fetch(`${BASE_URL}/faq`);
  assert.equal(faq.status, 200);
  const faqHtml = await faq.text();
  assert.equal(/sample\/demo/i.test(faqHtml), false, 'faq demo copy');

  const dashboardJs = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/dashboard.js'),
    'utf8'
  );
  assert.equal(/Sample\/demo/i.test(dashboardJs), false);
  const checkoutJs = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/checkout.js'),
    'utf8'
  );
  assert.equal(/Sample\/demo/i.test(checkoutJs), false);
});

test('migration 018 present; schema supports product catalog', async () => {
  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM schema_migrations`
  );
  assert.equal(count.rows[0].n, 18, '18 migrations after 018 admin product catalog');

  const hostingCols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'hosting_plans' AND column_name IN
       ('category', 'display_order', 'popular', 'cpu_cores', 'ram_mb')`
  );
  const hostingNames = hostingCols.rows.map((r) => r.column_name).sort();
  assert.deepEqual(hostingNames, [
    'category',
    'cpu_cores',
    'display_order',
    'popular',
    'ram_mb',
  ]);

  const vpsCols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'vps_plans' AND column_name IN
       ('display_order', 'popular')`
  );
  assert.equal(vpsCols.rows.length, 2);
});
