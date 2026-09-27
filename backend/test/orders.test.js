const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;
const idempotencyKey = () =>
  (unique() + unique() + unique()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

function extractSessionCookie(setCookie) {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    if (raw.startsWith('fh_session=')) {
      const nameValue = raw.split(';')[0];
      if (nameValue === 'fh_session=' || nameValue === 'fh_session') return null;
      return nameValue;
    }
  }
  return null;
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

async function registerUser(prefix = 'ord') {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Order',
    lastName: 'Tester',
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

async function fetchPlan(type, slug) {
  const { response, body } = await api(`/plans/${type}/${slug}`);
  assert.equal(response.status, 200);
  return body.data;
}

async function db() {
  return require('../src/config/database');
}

let database;

before(async () => {
  const { runUp } = require('../src/services/migrator');
  await runUp();
  database = require('../src/config/database');
  const { runSeed } = require('../src/services/seed');
  await runSeed();
});

after(async () => {
  if (database) await database.closePool().catch(() => {});
});

// ---------- Authentication ----------

test('POST /api/orders requires authentication (401)', async () => {
  const { response, body } = await postJson('/orders', {
    productType: 'hosting',
    planSlug: 'starter',
  });
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('GET /api/orders requires authentication (401)', async () => {
  const { response, body } = await api('/orders');
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('GET /api/orders/:id requires authentication (401)', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const { response, body } = await api(`/orders/${id}`);
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

// ---------- Create orders ----------

test('POST /api/orders creates a hosting order with DB price snapshot (201)', async () => {
  const { cookie } = await registerUser();
  const plan = await fetchPlan('hosting', 'starter');

  const { response, body } = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: cookie }
  );

  assert.equal(response.status, 201);
  assert.equal(body.success, true);
  const order = body.data;

  assert.match(order.orderNumber, /^FLR-\d{8}-[A-F0-9]{6}$/);
  assert.equal(order.productType, 'hosting');
  assert.equal(order.plan.id, plan.id);
  assert.equal(order.plan.slug, 'starter');
  assert.equal(order.amount, plan.price);
  assert.equal(order.currency, plan.currency);
  assert.equal(order.billingCycle, plan.billingCycle);
  assert.equal(order.status, 'awaiting_payment');
  assert.ok(order.createdAt);
  assert.ok(order.id);

  // no internal columns leaked
  const raw = JSON.stringify(body);
  assert.equal(raw.includes('user_id'), false);
  assert.equal(raw.includes('product_id'), false);
  assert.equal(raw.includes('idempotency_key'), false);

  // DB snapshot matches
  const { pool } = await db();
  const { rows } = await pool.query(
    'SELECT amount::text AS amount, currency, status, billing_cycle FROM orders WHERE id = $1',
    [order.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, plan.price);
  assert.equal(rows[0].currency, plan.currency);
  assert.equal(rows[0].status, 'awaiting_payment');
  assert.equal(rows[0].billing_cycle, plan.billingCycle);
});

test('POST /api/orders creates a VPS order (201)', async () => {
  const { cookie } = await registerUser('vps');
  const plan = await fetchPlan('vps', 'vps-2');

  const { response, body } = await postJson(
    '/orders',
    { productType: 'vps', planSlug: 'vps-2' },
    { Cookie: cookie }
  );

  assert.equal(response.status, 201);
  const order = body.data;
  assert.equal(order.productType, 'vps');
  assert.equal(order.plan.slug, 'vps-2');
  assert.equal(order.amount, plan.price);
  assert.equal(order.currency, plan.currency);
  assert.equal(order.status, 'awaiting_payment');
});

test('POST /api/orders ignores client-supplied amount/currency/userId/status', async () => {
  const { cookie } = await registerUser('tamper');
  const plan = await fetchPlan('hosting', 'business');

  const { response, body } = await postJson(
    '/orders',
    {
      productType: 'hosting',
      planSlug: 'business',
      amount: '1.00',
      currency: 'USD',
      userId: '00000000-0000-4000-8000-00000000dead',
      status: 'paid',
      price: '0.01',
    },
    { Cookie: cookie }
  );

  // unexpected fields rejected (strict validation)
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(
    body.error.details.some((d) => d.includes('Unexpected field')),
    'should reject unexpected fields'
  );

  // even with only allowed fields, amount stays server-side
  const clean = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'business' },
    { Cookie: cookie }
  );
  assert.equal(clean.response.status, 201);
  assert.equal(clean.body.data.amount, plan.price);
  assert.equal(clean.body.data.currency, plan.currency);
  assert.equal(clean.body.data.status, 'awaiting_payment');
});

test('POST /api/orders rejects unknown/inactive plan with 404 PLAN_NOT_FOUND', async () => {
  const { cookie } = await registerUser('nf');

  for (const planSlug of ['does-not-exist', 'inactive-plan']) {
    const { response, body } = await postJson(
      '/orders',
      { productType: 'hosting', planSlug },
      { Cookie: cookie }
    );
    assert.equal(response.status, 404, planSlug);
    assert.equal(body.error.code, 'PLAN_NOT_FOUND');
  }

  // vps slug against hosting type also not found
  const cross = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'vps-1' },
    { Cookie: cookie }
  );
  assert.equal(cross.response.status, 404);
  assert.equal(cross.body.error.code, 'PLAN_NOT_FOUND');
});

test('POST /api/orders validates body (400)', async () => {
  const { cookie } = await registerUser('val');

  const cases = [
    {},
    { productType: 'hosting' },
    { planSlug: 'starter' },
    { productType: 'domain', planSlug: 'starter' },
    { productType: 'hosting', planSlug: 'UPPER' },
    { productType: 'hosting', planSlug: 'bad slug!' },
    { productType: 'hosting', planSlug: '' },
  ];

  for (const payload of cases) {
    const { response, body } = await postJson(
      '/orders',
      payload,
      { Cookie: cookie }
    );
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    const raw = JSON.stringify(body).toLowerCase();
    assert.equal(raw.includes('sql'), false);
    assert.equal(raw.includes('stack'), false);
    assert.equal(raw.includes('password'), false);
  }
});

test('order numbers are non-sequential and unique across users', async () => {
  const a = await registerUser('seqa');
  const b = await registerUser('seqb');

  const created = [];
  for (const user of [a, a, b]) {
    const { response, body } = await postJson(
      '/orders',
      { productType: 'hosting', planSlug: 'starter' },
      { Cookie: user.cookie }
    );
    assert.equal(response.status, 201);
    created.push(body.data.orderNumber);
  }

  assert.equal(new Set(created).size, created.length, 'order numbers unique');
  for (const n of created) {
    assert.match(n, /^FLR-\d{8}-[A-F0-9]{6}$/);
  }

  // not simple sequential suffixes
  const suffixes = created.map((n) => parseInt(n.slice(-6), 16));
  const strictlySequential = suffixes.every(
    (v, i) => i === 0 || v === suffixes[i - 1] + 1
  );
  assert.equal(strictlySequential, false);
});

// ---------- Idempotency / double-submit ----------

test('same Idempotency-Key returns the same order (no duplicate)', async () => {
  const { cookie } = await registerUser('idem');
  const key = idempotencyKey();

  const first = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: cookie, 'Idempotency-Key': key }
  );
  assert.equal(first.response.status, 201);

  const second = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: cookie, 'Idempotency-Key': key }
  );
  assert.equal(second.response.status, 200);
  assert.equal(second.body.data.id, first.body.data.id);
  assert.equal(second.body.data.orderNumber, first.body.data.orderNumber);

  const { pool } = await db();
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM orders WHERE idempotency_key = $1',
    [key]
  );
  assert.equal(rows[0].n, 1);
});

test('without Idempotency-Key, two requests create two orders (frontend must disable button)', async () => {
  const { cookie } = await registerUser('dup');

  const a = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: cookie }
  );
  const b = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: cookie }
  );

  assert.equal(a.response.status, 201);
  assert.equal(b.response.status, 201);
  assert.notEqual(a.body.data.id, b.body.data.id);
});

test('Idempotency-Key is scoped per user (other user can reuse the key string)', async () => {
  const u1 = await registerUser('scope1');
  const u2 = await registerUser('scope2');
  const key = idempotencyKey();

  const r1 = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: u1.cookie, 'Idempotency-Key': key }
  );
  assert.equal(r1.response.status, 201);

  const r2 = await postJson(
    '/orders',
    { productType: 'vps', planSlug: 'vps-1' },
    { Cookie: u2.cookie, 'Idempotency-Key': key }
  );
  assert.equal(r2.response.status, 201);
  assert.notEqual(r1.body.data.id, r2.body.data.id);
});

test('invalid Idempotency-Key header is rejected (400)', async () => {
  const { cookie } = await registerUser('badkey');
  const { response, body } = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: cookie, 'Idempotency-Key': 'short' }
  );
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

// ---------- List / pagination ----------

test('GET /api/orders returns newest first with pagination', async () => {
  const { cookie } = await registerUser('list');
  const created = [];
  for (const slug of ['starter', 'business', 'pro']) {
    const { response, body } = await postJson(
      '/orders',
      { productType: 'hosting', planSlug: slug },
      { Cookie: cookie }
    );
    assert.equal(response.status, 201);
    created.push(body.data);
  }

  const { response, body } = await api('/orders?page=1&limit=2', {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.orders.length, 2);
  assert.equal(body.data.pagination.page, 1);
  assert.equal(body.data.pagination.limit, 2);
  assert.equal(body.data.pagination.total, 3);
  assert.equal(body.data.pagination.totalPages, 2);

  // newest first
  assert.equal(body.data.orders[0].id, created[2].id);
  assert.equal(body.data.orders[1].id, created[1].id);

  const page2 = await api('/orders?page=2&limit=2', {
    headers: { Cookie: cookie },
  });
  assert.equal(page2.body.data.orders.length, 1);
  assert.equal(page2.body.data.orders[0].id, created[0].id);
});

test('GET /api/orders caps limit at 50 and rejects unexpected query params', async () => {
  const { cookie } = await registerUser('q');

  const high = await api('/orders?limit=999', { headers: { Cookie: cookie } });
  assert.equal(high.response.status, 200);
  assert.equal(high.body.data.pagination.limit, 50);

  const bad = await api('/orders?foo=1', { headers: { Cookie: cookie } });
  assert.equal(bad.response.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

  const status = await api('/orders?status=paid', {
    headers: { Cookie: cookie },
  });
  assert.equal(status.response.status, 400);
});

test('empty list still returns valid pagination structure', async () => {
  const { cookie } = await registerUser('empty');
  const { response, body } = await api('/orders', {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.data.orders, []);
  assert.equal(body.data.pagination.total, 0);
  assert.equal(body.data.pagination.page, 1);
});

// ---------- Ownership / get by id ----------

test('GET /api/orders/:id returns own order', async () => {
  const { cookie } = await registerUser('own');
  const created = await postJson(
    '/orders',
    { productType: 'vps', planSlug: 'vps-1' },
    { Cookie: cookie }
  );
  const id = created.body.data.id;

  const { response, body } = await api(`/orders/${id}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.id, id);
  assert.equal(body.data.plan.slug, 'vps-1');
});

test('GET /api/orders/:id for another user\'s order is safe 404 (no existence leak)', async () => {
  const owner = await registerUser('owner');
  const attacker = await registerUser('attack');

  const created = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: owner.cookie }
  );
  const id = created.body.data.id;

  const foreign = await api(`/orders/${id}`, {
    headers: { Cookie: attacker.cookie },
  });
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.body.error.code, 'ORDER_NOT_FOUND');

  // same response as a truly missing order
  const missing = await api(
    '/orders/00000000-0000-4000-8000-0000000000ff',
    { headers: { Cookie: attacker.cookie } }
  );
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, 'ORDER_NOT_FOUND');
  assert.equal(foreign.body.error.code, missing.body.error.code);
  assert.equal(foreign.body.error.message, missing.body.error.message);
});

test('GET /api/orders/:id with invalid UUID is 404 not 500', async () => {
  const { cookie } = await registerUser('uuid');
  for (const id of ['not-a-uuid', '123', '../../etc/passwd']) {
    const { response, body } = await api(`/orders/${encodeURIComponent(id)}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 404, id);
    assert.equal(body.error.code, 'ORDER_NOT_FOUND');
    const raw = JSON.stringify(body).toLowerCase();
    assert.equal(raw.includes('sql'), false);
    assert.equal(raw.includes('stack'), false);
  }
});

test('list only returns the authenticated user\'s orders', async () => {
  const a = await registerUser('filt-a');
  const b = await registerUser('filt-b');

  await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: a.cookie }
  );
  await postJson(
    '/orders',
    { productType: 'vps', planSlug: 'vps-2' },
    { Cookie: b.cookie }
  );

  const listA = await api('/orders', { headers: { Cookie: a.cookie } });
  const listB = await api('/orders', { headers: { Cookie: b.cookie } });

  assert.equal(listA.body.data.pagination.total, 1);
  assert.equal(listB.body.data.pagination.total, 1);
  assert.notEqual(listA.body.data.orders[0].id, listB.body.data.orders[0].id);
});

// ---------- Security / boundary ----------

test('there is no client-controlled paid endpoint (POST /api/orders/:id/pay → 404)', async () => {
  const { cookie } = await registerUser('pay');
  const created = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: cookie }
  );
  const id = created.body.data.id;

  for (const path of [
    `/orders/${id}/pay`,
    '/orders/pay',
    '/orders/mark-paid',
    `/orders/${id}/status`,
  ]) {
    const { response, body } = await postJson(
      path,
      { status: 'paid' },
      { Cookie: cookie }
    );
    assert.equal(response.status, 404, path);
    assert.equal(body.error.code, 'NOT_FOUND');
  }

  // status in DB remains awaiting_payment
  const { pool } = await db();
  const { rows } = await pool.query(
    'SELECT status FROM orders WHERE id = $1',
    [id]
  );
  assert.equal(rows[0].status, 'awaiting_payment');
});

test('order create rejects cross-origin POST (403 CSRF_INVALID when Origin present)', async () => {
  const { cookie } = await registerUser('csrf');
  const { response, body } = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: cookie, Origin: 'https://evil.example' }
  );
  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'CSRF_INVALID');
});

test('order create rate limiter returns 429 RATE_LIMITED after max attempts', async () => {
  const { createRateLimiter } = require('../src/utils/rateLimiter');
  const { sendError } = require('../src/utils/respond');

  const limiter = createRateLimiter({
    name: 'order-create-test',
    windowMs: 60000,
    max: 3,
  });

  function makeRes() {
    const res = {
      statusCode: null,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    return res;
  }

  function next() {}

  // max=3 → first three pass, fourth is limited
  for (let i = 0; i < 3; i += 1) {
    const res = makeRes();
    limiter({ ip: '10.0.0.9' }, res, next);
    assert.equal(res.statusCode, null, `attempt ${i + 1} should pass`);
  }

  const res = makeRes();
  limiter({ ip: '10.0.0.9' }, res, next);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error.code, 'RATE_LIMITED');
  assert.ok(res.headers['retry-after']);

  limiter.reset();
});

// ---------- Frontend / dashboard / checkout regressions ----------

test('dashboard.js loads orders from /api/orders and shows safe DOM order cards', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/dashboard.js'),
    'utf8'
  );
  assert.ok(js.includes('/api/orders'));
  assert.ok(js.includes('order-number'));
  assert.ok(js.includes("You haven't placed any orders yet") || js.includes('orders-empty'));
  assert.ok(js.includes('awaiting_payment'));
  // no innerHTML injection of order fields
  assert.equal(/order\.(orderNumber|amount)[\s\S]{0,40}innerHTML/.test(js), false);
});

test('checkout.js posts only productType + planSlug with Idempotency-Key', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/checkout.js'),
    'utf8'
  );
  assert.ok(js.includes('"/api/orders"'));
  assert.ok(js.includes('Idempotency-Key'));
  assert.ok(js.includes('productType'));
  assert.ok(js.includes('planSlug'));
  // must not send price/amount/currency/status from client
  assert.equal(/body:\s*JSON\.stringify\(\{[^}]*amount/s.test(js), false);
  assert.equal(/body:\s*JSON\.stringify\(\{[^}]*status/s.test(js), false);
  assert.equal(/body:\s*JSON\.stringify\(\{[^}]*currency/s.test(js), false);
  // double-submit guard
  assert.ok(js.includes('submitting'));
  assert.ok(js.includes('disabled'));
});

test('dashboard.html orders section is functional (not coming soon)', async () => {
  const response = await fetch(`${BASE_URL}/dashboard`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('id="orders-list"'));
  assert.ok(html.includes('id="orders-empty"'));
  assert.ok(html.includes('id="orders-pagination"'));
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
  assert.equal(/<style[\s>]/i.test(html), false);
});

test('checkout.html has confirmation UI and no payment fields', async () => {
  const response = await fetch(`${BASE_URL}/checkout`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('id="order-confirm"'));
  assert.ok(html.includes('id="place-order"'));
  assert.equal(/card number|cvv|iban|credit card number/i.test(html), false);
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
});

test('regression: public plan APIs and health still work', async () => {
  const health = await api('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.database, 'up');

  const plans = await api('/plans/hosting');
  assert.equal(plans.response.status, 200);
  assert.ok(plans.body.data.length >= 1);
});
