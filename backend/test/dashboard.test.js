const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;

function extractFullSessionCookie(setCookie) {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    if (raw.startsWith('fh_session=')) return raw;
  }
  return null;
}

function extractSessionCookie(setCookie) {
  const full = extractFullSessionCookie(setCookie);
  if (!full) return null;
  const nameValue = full.split(';')[0];
  if (nameValue === 'fh_session=' || nameValue === 'fh_session') return null;
  return nameValue;
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    body = null;
  }
  return { response, body };
}

function postJson(path, payload, headers = {}) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

async function registerAndLogin() {
  const email = `dash-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Dash',
    lastName: 'Board',
    email,
    password,
  });
  assert.equal(reg.response.status, 201);

  const login = await postJson('/auth/login', { email, password });
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie, 'expected session cookie');
  return { email, password, cookie };
}

async function fetchPage(path) {
  return fetch(`${BASE_URL}${path}`);
}

let pool;

before(async () => {
  const { runUp } = require('../src/services/migrator');
  await runUp();
  const db = require('../src/config/database');
  pool = db;
  const { runSeed } = require('../src/services/seed');
  await runSeed();
});

after(async () => {
  if (pool) await pool.closePool().catch(() => {});
});

// ---------- Authentication ----------

test('unauthenticated /auth/me returns 401 (dashboard gate)', async () => {
  const { response, body } = await api('/auth/me');
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('authenticated user data loads for dashboard account section', async () => {
  const { cookie } = await registerAndLogin();
  const { response, body } = await api('/auth/me', {
    headers: { Cookie: cookie },
  });

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  const user = body.data.user;
  assert.equal(typeof user.firstName, 'string');
  assert.equal(typeof user.lastName, 'string');
  assert.match(user.email, /@example\.com$/);
  assert.equal(user.status, 'active');
  assert.equal(typeof user.emailVerified, 'boolean');
  assert.ok(user.createdAt);

  // must not expose internals
  const raw = JSON.stringify(body);
  assert.equal(raw.includes('password_hash'), false);
  assert.equal(raw.includes('$argon2'), false);
  assert.equal(raw.includes('session_hash'), false);
  assert.equal(raw.includes('session'), false);
  assert.equal(user.password, undefined);
});

test('logout works and subsequent /auth/me is 401', async () => {
  const { cookie } = await registerAndLogin();
  const logout = await postJson('/auth/logout', {}, { Cookie: cookie });
  assert.equal(logout.response.status, 200);

  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 401);
});

test('dashboard static page serves and references dashboard.js', async () => {
  const response = await fetchPage('/dashboard');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('js/dashboard.js'));
  assert.ok(html.includes('id="dashboard-root"'));
  assert.ok(html.includes('data-section="overview"'));
  assert.ok(html.includes('data-section="hosting"'));
  assert.ok(html.includes('data-section="vps"'));
  assert.ok(html.includes('data-section="account"'));
  assert.ok(html.includes('data-section="orders"'));
  assert.ok(html.includes('data-section="billing"'));
  assert.ok(html.includes('data-section="support"'));
  assert.ok(html.includes('data-section="services"'));
  // dashboard must not rely on inline scripts (CSP script-src 'self')
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
});

// ---------- Plan selection ----------

test('hosting plan selection resolves via public API', async () => {
  const list = await api('/plans/hosting');
  assert.equal(list.response.status, 200);
  assert.ok(Array.isArray(list.body.data));
  assert.ok(list.body.data.length >= 1);

  const slug = list.body.data[0].slug;
  const single = await api(`/plans/hosting/${encodeURIComponent(slug)}`);
  assert.equal(single.response.status, 200);
  assert.equal(single.body.data.slug, slug);
  assert.equal(typeof single.body.data.price, 'string');
});

test('VPS plan selection resolves via public API', async () => {
  const list = await api('/plans/vps');
  assert.equal(list.response.status, 200);
  assert.ok(list.body.data.length >= 1);

  const slug = list.body.data[0].slug;
  const single = await api(`/plans/vps/${encodeURIComponent(slug)}`);
  assert.equal(single.response.status, 200);
  assert.equal(single.body.data.slug, slug);
  assert.equal(typeof single.body.data.cpuCores, 'number');
});

test('invalid plan type has no API route (404 NOT_FOUND)', async () => {
  for (const path of [
    '/plans/invalid/starter',
    '/plans/domain/starter',
    '/plans/hosting/starter/extra',
  ]) {
    const { response, body } = await api(path);
    assert.equal(response.status, 404, path);
    assert.equal(body.error.code, 'NOT_FOUND');
  }
});

test('invalid slug shows safe error (400, no leak)', async () => {
  const evil = "x' OR 1=1--";
  const response = await fetch(
    `${API}/plans/hosting/${encodeURIComponent(evil)}`
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  const raw = JSON.stringify(body).toLowerCase();
  assert.equal(raw.includes('sql'), false);
  assert.equal(raw.includes('syntax'), false);
  assert.equal(raw.includes('password'), false);
  assert.equal(raw.includes('stack'), false);
});

test('URL cannot override canonical price/specification (checkout.js ignores query price)', async () => {
  // Static guarantee: checkout.js must only render from fetchPlan/API data.
  const fs = require('node:fs');
  const path = require('node:path');
  const checkoutJs = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/checkout.js'),
    'utf8'
  );
  // must fetch canonical plan from API
  assert.ok(checkoutJs.includes('fetchPlan'));
  // must not read price/name from the query string for display
  assert.equal(/params\.get\(\s*['"]price['"]\s*\)/.test(checkoutJs), false);
  assert.equal(/params\.get\(\s*['"]name['"]\s*\)/.test(checkoutJs), false);
  assert.ok(checkoutJs.includes('Canonical data comes only from the API'));

  // API single-plan response always comes from DB — verify price matches DB for starter
  const { pool: db } = require('../src/config/database');
  const { rows } = await db.query(
    "SELECT price::text AS price FROM hosting_plans WHERE slug = 'starter'"
  );
  assert.ok(rows.length === 1);
  const apiRes = await api('/plans/hosting/starter');
  assert.equal(apiRes.body.data.price, rows[0].price);
});

// ---------- Checkout (order preparation) ----------

test('checkout page serves for valid hosting selection', async () => {
  const response = await fetchPage(
    '/checkout?type=hosting&plan=starter'
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('js/checkout.js'));
  assert.ok(html.includes('id="checkout-root"'));
  assert.ok(html.includes('id="place-order"'));
  // payment methods are presented only after the order is placed, and the
  // page must still state that no service exists until the provider verifies
  assert.ok(html.includes('id="payment-methods"'));
  assert.ok(html.includes('id="bkash-pay-btn"'));
  assert.ok(html.includes('no service is provisioned before then'));
  // no payment fields
  assert.equal(/card number|cvv|iban|credit card/i.test(html), false);
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
});

test('checkout page serves for valid VPS selection', async () => {
  const response = await fetchPage('/checkout?type=vps&plan=vps-2');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('js/checkout.js'));
});

test('invalid selection does not crash (API rejects; page still 200)', async () => {
  // invalid type: no API data endpoint works
  const badType = await api('/plans/invalid/x');
  assert.equal(badType.response.status, 404);

  // invalid slug: safe 400
  const badSlug = await api('/plans/hosting/UPPER');
  assert.equal(badSlug.response.status, 400);

  // page itself always loads (client-side handles error state)
  for (const qs of [
    'type=hosting&plan=does-not-exist',
    'type=invalid&plan=starter',
    'type=hosting&plan=Bad%20Slug!',
    '',
  ]) {
    const response = await fetchPage(`/checkout?${qs}`);
    assert.equal(response.status, 200, qs);
  }
});

test('plan selection / GET checkout flow does not create orders by itself', async () => {
  const { pool: db } = require('../src/config/database');

  const { cookie, email } = await registerAndLogin();
  const { rows: userRows } = await db.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );
  assert.equal(userRows.length, 1);
  const userId = userRows[0].id;

  const before = await db.query(
    'SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1',
    [userId]
  );
  assert.equal(before.rows[0].n, 0);

  // simulate plan selection: list + single lookups (GET only)
  await api('/plans/hosting', { headers: { Cookie: cookie } });
  await api('/plans/hosting/starter', { headers: { Cookie: cookie } });
  await api('/plans/vps/vps-2', { headers: { Cookie: cookie } });

  // visit checkout page assets (static)
  await fetchPage('/checkout?type=hosting&plan=starter');
  await fetchPage('/js/checkout.js');

  // invalid order endpoints still 404
  const orderPost2 = await postJson(
    '/orders/create',
    { productType: 'hosting', productId: 'x' },
    { Cookie: cookie }
  );
  assert.equal(orderPost2.response.status, 404);

  const after = await db.query(
    'SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1',
    [userId]
  );
  assert.equal(
    after.rows[0].n,
    0,
    'orders table must not change for this user from GETs'
  );
});

// ---------- Regression ----------

test('regression: health endpoint still works', async () => {
  const { response, body } = await api('/health');
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'up');
});

test('regression: all public pages still load', async () => {
  const pages = [
    '/',
    '/login',
    '/register',
    '/dashboard',
    '/checkout',
    '/web-hosting',
    '/vps-hosting',
    '/about',
    '/faq',
    '/contact',
  ];
  for (const page of pages) {
    const response = await fetchPage(page);
    assert.equal(response.status, 200, `expected 200 for ${page}`);
  }
});

test('regression: login/register still work', async () => {
  const { email, password, cookie } = await registerAndLogin();
  assert.ok(email);
  assert.ok(password);
  assert.ok(cookie);

  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
});

test('regression: security headers still present on dashboard and checkout', async () => {
  for (const page of ['/dashboard', '/checkout']) {
    const response = await fetchPage(page);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', page);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', page);
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp, page);
    assert.ok(csp.includes("script-src 'self'"), page);
    assert.ok(csp.includes("style-src 'self'"), page);
    assert.ok(csp.includes("connect-src 'self'"), page);
  }
});

test('regression: CSP pages contain no inline scripts or styles', async () => {
  for (const page of ['/dashboard', '/checkout']) {
    const html = await (await fetchPage(page)).text();
    assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, page);
    assert.equal(/<style[\s>]/i.test(html), false, page);
    assert.equal(/\sonclick\s*=/i.test(html), false, page);
  }
});
