const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

// This suite exercises the disabled-provider deployment path (the external
// test server also runs PAYMENT_PROVIDER=disabled). Pin it in-process so an
// ambient .env that enables the SSLCommerz sandbox — used by the dev server
// for real sandbox payments — cannot change what these tests observe.
// dotenv does not override process env values that are already set.
process.env.PAYMENT_PROVIDER = 'disabled';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;

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

async function registerUser(prefix = 'pay') {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Pay',
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

async function createOrder(cookie, productType = 'hosting', planSlug = 'starter') {
  const { response, body } = await postJson(
    '/orders',
    { productType, planSlug },
    { Cookie: cookie }
  );
  assert.equal(response.status, 201);
  return body.data;
}

// Step 8 expectation: the disabled provider rejects every create attempt.
async function attemptPayment(cookie, orderId) {
  return postJson('/payments', { orderId }, { Cookie: cookie });
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

// ---------- Migration / schema ----------

test('migration 010 creates payment_transactions and re-running is a no-op', async () => {
  const { runUp } = require('../src/services/migrator');
  const second = await runUp();
  assert.equal(second.applied, 0, 'migration 010 must already be applied');

  const { pool } = await db();
  const { rows: table } = await pool.query(
    "SELECT to_regclass('payment_transactions') AS t"
  );
  assert.equal(table[0].t, 'payment_transactions');

  const { rows: applied } = await pool.query(
    "SELECT version FROM schema_migrations WHERE version LIKE '010%'"
  );
  assert.equal(applied.length, 1);
  assert.match(applied[0].version, /^010_create_payment_transactions\.sql$/);
});

test('payment_transactions accepts a valid attempt and enforces FK/status/currency/provider checks', async () => {
  const { cookie, email } = await registerUser('schema');
  const order = await createOrder(cookie);
  const { pool } = await db();

  const { rows: userRows } = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );
  const userId = userRows[0].id;

  // valid insert
  const inserted = await pool.query(
    `INSERT INTO payment_transactions (order_id, user_id, provider, amount, currency, status)
     VALUES ($1, $2, 'disabled', $3, $4, 'initiated')
     RETURNING status, payment_method, metadata, paid_at`,
    [order.id, userId, order.amount, order.currency]
  );
  assert.equal(inserted.rows.length, 1);
  assert.equal(inserted.rows[0].status, 'initiated');
  assert.equal(inserted.rows[0].payment_method, null);
  assert.equal(inserted.rows[0].paid_at, null);
  assert.deepEqual(inserted.rows[0].metadata, {});

  const expectFail = async (sql, params, code) => {
    await assert.rejects(
      () => pool.query(sql, params),
      (err) => {
        assert.equal(err.code, code, `${code} expected for: ${sql.slice(0, 60)}`);
        return true;
      }
    );
  };

  // FK violations
  await expectFail(
    `INSERT INTO payment_transactions (order_id, user_id, provider, amount, currency)
     VALUES ('00000000-0000-4000-8000-0000000000f1', $1, 'disabled', 1, 'BDT')`,
    [userId],
    '23503'
  );
  await expectFail(
    `INSERT INTO payment_transactions (order_id, user_id, provider, amount, currency)
     VALUES ($1, '00000000-0000-4000-8000-0000000000f2', 'disabled', 1, 'BDT')`,
    [order.id],
    '23503'
  );

  // status CHECK (orders statuses like "paid" are not payment statuses)
  await expectFail(
    `INSERT INTO payment_transactions (order_id, user_id, provider, amount, currency, status)
     VALUES ($1, $2, 'disabled', 1, 'BDT', 'paid')`,
    [order.id, userId],
    '23514'
  );
  await expectFail(
    `INSERT INTO payment_transactions (order_id, user_id, provider, amount, currency, status)
     VALUES ($1, $2, 'disabled', 1, 'BDT', 'succeeded')`,
    [order.id, userId],
    '23514'
  );

  // currency CHECK (must be uppercase ISO)
  await expectFail(
    `INSERT INTO payment_transactions (order_id, user_id, provider, amount, currency)
     VALUES ($1, $2, 'disabled', 1, 'usd')`,
    [order.id, userId],
    '23514'
  );

  // provider CHECK (safe lowercase name)
  await expectFail(
    `INSERT INTO payment_transactions (order_id, user_id, provider, amount, currency)
     VALUES ($1, $2, 'Stripe!', 1, 'BDT')`,
    [order.id, userId],
    '23514'
  );

  // amount CHECK
  await expectFail(
    `INSERT INTO payment_transactions (order_id, user_id, provider, amount, currency)
     VALUES ($1, $2, 'disabled', -1, 'BDT')`,
    [order.id, userId],
    '23514'
  );
});

test('multiple attempts per order; provider_transaction_id unique; one successful payment per order', async () => {
  const { cookie, email } = await registerUser('uniq');
  const order = await createOrder(cookie);
  const { pool } = await db();
  const { rows: userRows } = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );
  const userId = userRows[0].id;

  const insert = (status = 'initiated', txId = null) =>
    pool.query(
      `INSERT INTO payment_transactions (order_id, user_id, provider, provider_transaction_id, amount, currency, status)
       VALUES ($1, $2, 'disabled', $3, $4, $5, $6)
       RETURNING id`,
      [order.id, userId, txId, order.amount, order.currency, status]
    );

  // unique per run — provider_transaction_id is globally unique per provider
  const txAlpha = `tx-${unique()}`;
  const txBeta = `tx-${unique()}`;

  // multiple attempts for one order are allowed
  const a = await insert('initiated', txAlpha);
  const b = await insert('initiated', txBeta);
  assert.ok(a.rows[0].id);
  assert.ok(b.rows[0].id);

  // duplicate provider_transaction_id (same provider) rejected
  await assert.rejects(
    () => insert('initiated', txAlpha),
    (err) => err.code === '23505'
  );

  // first successful payment OK
  await pool.query(
    `UPDATE payment_transactions SET status = 'successful', paid_at = now()
     WHERE id = $1`,
    [a.rows[0].id]
  );

  // second successful payment for the same order rejected by partial index
  await assert.rejects(
    () => pool.query(
      `UPDATE payment_transactions SET status = 'successful', paid_at = now()
       WHERE id = $1`,
      [b.rows[0].id]
    ),
    (err) => err.code === '23505'
  );
});

// ---------- Authentication ----------

test('payment endpoints require authentication (401)', async () => {
  const id = '00000000-0000-4000-8000-000000000001';

  const create = await postJson('/payments', { orderId: id });
  assert.equal(create.response.status, 401);
  assert.equal(create.body.error.code, 'UNAUTHORIZED');

  const list = await api('/payments');
  assert.equal(list.response.status, 401);
  assert.equal(list.body.error.code, 'UNAUTHORIZED');

  const detail = await api(`/payments/${id}`);
  assert.equal(detail.response.status, 401);
  assert.equal(detail.body.error.code, 'UNAUTHORIZED');
});

// ---------- Create payment attempts ----------

test('POST /api/payments validates body (400) and rejects client-controlled fields', async () => {
  const { cookie } = await registerUser('pval');
  const order = await createOrder(cookie);

  const cases = [
    {},
    { orderId: 'not-a-uuid' },
    { orderId: '123' },
    { orderId: '' },
    {
      orderId: order.id,
      amount: '1.00',
      currency: 'USD',
      status: 'successful',
      userId: '00000000-0000-4000-8000-00000000dead',
    },
    { orderId: order.id, provider: 'stripe' },
  ];

  for (const payload of cases) {
    const { response, body } = await postJson('/payments', payload, {
      Cookie: cookie,
    });
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    const raw = JSON.stringify(body).toLowerCase();
    assert.equal(raw.includes('sql'), false);
    assert.equal(raw.includes('stack'), false);
    assert.equal(raw.includes('password'), false);
  }

  // rejected payloads created nothing
  const { pool } = await db();
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM payment_transactions WHERE order_id = $1',
    [order.id]
  );
  assert.equal(rows[0].n, 0);
});

test('POST /api/payments for an awaiting_payment order reaches the disabled provider (503) and records initiated attempts only', async () => {
  const { cookie } = await registerUser('pcreate');
  const order = await createOrder(cookie);
  const { pool } = await db();

  const first = await attemptPayment(cookie, order.id);
  assert.equal(first.response.status, 503);
  assert.equal(first.body.error.code, 'PAYMENT_PROVIDER_NOT_CONFIGURED');
  assert.equal(first.body.error.message, 'Payment processing is not available yet.');

  const raw = JSON.stringify(first.body).toLowerCase();
  assert.equal(raw.includes('sql'), false);
  assert.equal(raw.includes('stack'), false);

  // second attempt — still rejected, attempt recorded
  const second = await attemptPayment(cookie, order.id);
  assert.equal(second.response.status, 503);
  assert.equal(second.body.error.code, 'PAYMENT_PROVIDER_NOT_CONFIGURED');

  const { rows: orderRows } = await pool.query(
    'SELECT status FROM orders WHERE id = $1',
    [order.id]
  );
  assert.equal(orderRows[0].status, 'awaiting_payment');

  const { rows: paymentRows } = await pool.query(
    'SELECT status, amount::text AS amount, currency FROM payment_transactions WHERE order_id = $1',
    [order.id]
  );
  assert.equal(paymentRows.length, 2, 'both attempts recorded');
  for (const row of paymentRows) {
    assert.equal(row.status, 'initiated');
    assert.equal(row.amount, order.amount, 'amount snapshotted from order');
    assert.equal(row.currency, order.currency);
  }

  const { rows: successRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payment_transactions
     WHERE order_id = $1 AND status = 'successful'`,
    [order.id]
  );
  assert.equal(successRows[0].n, 0, 'never a successful payment');
});

test('POST /api/payments rejects orders that are not awaiting payment (409)', async () => {
  const { cookie } = await registerUser('ppaid');
  const order = await createOrder(cookie);
  const { pool } = await db();

  for (const status of ['paid', 'cancelled', 'refunded', 'failed']) {
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [
      status,
      order.id,
    ]);

    const { response, body } = await attemptPayment(cookie, order.id);
    assert.equal(response.status, 409, status);
    assert.equal(body.error.code, 'ORDER_NOT_PAYABLE');
  }

  // no attempt was inserted for a non-payable order
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM payment_transactions WHERE order_id = $1',
    [order.id]
  );
  assert.equal(rows[0].n, 0);
});

test("POST /api/payments for another user's order is a safe 404 (identical to missing)", async () => {
  const owner = await registerUser('powner');
  const attacker = await registerUser('pattack');
  const order = await createOrder(owner.cookie);

  const foreign = await attemptPayment(attacker.cookie, order.id);
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.body.error.code, 'ORDER_NOT_FOUND');

  const missing = await attemptPayment(
    attacker.cookie,
    '00000000-0000-4000-8000-0000000000fa'
  );
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, 'ORDER_NOT_FOUND');
  assert.equal(foreign.body.error.message, missing.body.error.message);

  // foreign attempt did not touch the owner's order or create rows
  const { pool } = await db();
  const { rows: orderRows } = await pool.query(
    'SELECT status FROM orders WHERE id = $1',
    [order.id]
  );
  assert.equal(orderRows[0].status, 'awaiting_payment');
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM payment_transactions WHERE order_id = $1',
    [order.id]
  );
  assert.equal(rows[0].n, 0);
});

test('payment create rejects cross-origin POST (403 CSRF_INVALID when Origin present)', async () => {
  const { cookie } = await registerUser('pcsrf');
  const order = await createOrder(cookie);

  const { response, body } = await postJson(
    '/payments',
    { orderId: order.id },
    { Cookie: cookie, Origin: 'https://evil.example' }
  );
  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'CSRF_INVALID');
});

test('payment create rate limiter returns 429 RATE_LIMITED after max attempts', async () => {
  const { createRateLimiter } = require('../src/utils/rateLimiter');

  const limiter = createRateLimiter({
    name: 'payment-create-test',
    windowMs: 60000,
    max: 3,
  });

  function makeRes() {
    return {
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
  }

  function next() {}

  for (let i = 0; i < 3; i += 1) {
    const res = makeRes();
    limiter({ ip: '10.0.0.11' }, res, next);
    assert.equal(res.statusCode, null, `attempt ${i + 1} should pass`);
  }

  const res = makeRes();
  limiter({ ip: '10.0.0.11' }, res, next);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error.code, 'RATE_LIMITED');
  assert.ok(res.headers['retry-after']);

  limiter.reset();
});

// ---------- List / detail / ownership ----------

test("GET /api/payments returns only the caller's attempts, newest first, with pagination", async () => {
  const a = await registerUser('plist-a');
  const b = await registerUser('plist-b');

  const created = [];
  for (const slug of ['starter', 'business', 'pro']) {
    const order = await createOrder(a.cookie, 'hosting', slug);
    await attemptPayment(a.cookie, order.id);
    created.push(order.id);
  }
  const bOrder = await createOrder(b.cookie);
  await attemptPayment(b.cookie, bOrder.id);

  const { response, body } = await api('/payments?page=1&limit=2', {
    headers: { Cookie: a.cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.payments.length, 2);
  assert.equal(body.data.pagination.page, 1);
  assert.equal(body.data.pagination.limit, 2);
  assert.equal(body.data.pagination.total, 3);
  assert.equal(body.data.pagination.totalPages, 2);

  // newest first — matches reverse creation order
  assert.equal(body.data.payments[0].orderId, created[2]);
  assert.equal(body.data.payments[1].orderId, created[1]);

  const page2 = await api('/payments?page=2&limit=2', {
    headers: { Cookie: a.cookie },
  });
  assert.equal(page2.body.data.payments.length, 1);
  assert.equal(page2.body.data.payments[0].orderId, created[0]);

  // user B sees only their own attempt
  const listB = await api('/payments', { headers: { Cookie: b.cookie } });
  assert.equal(listB.body.data.pagination.total, 1);
  assert.equal(listB.body.data.payments[0].orderId, bOrder.id);
  assert.equal(created.includes(listB.body.data.payments[0].orderId), false);

  // safe fields only — no internals anywhere in the payload
  const raw = JSON.stringify(body).toLowerCase();
  assert.equal(raw.includes('user_id'), false);
  assert.equal(raw.includes('provider_transaction_id'), false);
  assert.equal(raw.includes('payment_method'), false);
  assert.equal(raw.includes('metadata'), false);
  assert.equal(raw.includes('failed_at'), false);
});

test('GET /api/payments caps limit at 50 and rejects unexpected query params', async () => {
  const { cookie } = await registerUser('pquery');

  const high = await api('/payments?limit=999', { headers: { Cookie: cookie } });
  assert.equal(high.response.status, 200);
  assert.equal(high.body.data.pagination.limit, 50);

  const bad = await api('/payments?foo=1', { headers: { Cookie: cookie } });
  assert.equal(bad.response.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

  const status = await api('/payments?status=successful', {
    headers: { Cookie: cookie },
  });
  assert.equal(status.response.status, 400);
});

test('empty payment list still returns valid pagination structure', async () => {
  const { cookie } = await registerUser('pempty');
  const { response, body } = await api('/payments', {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.data.payments, []);
  assert.equal(body.data.pagination.total, 0);
  assert.equal(body.data.pagination.page, 1);
});

test('GET /api/payments/:id returns own payment with only safe fields', async () => {
  const { cookie } = await registerUser('pown');
  const order = await createOrder(cookie);
  await attemptPayment(cookie, order.id);

  const list = await api('/payments', { headers: { Cookie: cookie } });
  assert.equal(list.body.data.payments.length, 1);
  const id = list.body.data.payments[0].id;

  const { response, body } = await api(`/payments/${id}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(body.success, true);

  const payment = body.data;
  const expectedKeys = [
    'amount',
    'createdAt',
    'currency',
    'id',
    'initiatedAt',
    'orderId',
    'orderNumber',
    'paidAt',
    'provider',
    'status',
  ].sort();
  assert.deepEqual(Object.keys(payment).sort(), expectedKeys);

  assert.equal(payment.orderId, order.id);
  assert.equal(payment.orderNumber, order.orderNumber);
  assert.equal(payment.provider, 'disabled');
  assert.equal(payment.status, 'initiated');
  assert.equal(payment.amount, order.amount);
  assert.equal(payment.currency, order.currency);
  assert.equal(payment.paidAt, null);

  const raw = JSON.stringify(body).toLowerCase();
  assert.equal(raw.includes('user_id'), false);
  assert.equal(raw.includes('provider_transaction_id'), false);
  assert.equal(raw.includes('metadata'), false);
  assert.equal(raw.includes('sql'), false);
});

test("GET /api/payments/:id for another user's payment is a safe 404 (identical to missing)", async () => {
  const owner = await registerUser('pdowner');
  const attacker = await registerUser('pdattack');
  const order = await createOrder(owner.cookie);
  await attemptPayment(owner.cookie, order.id);

  const list = await api('/payments', { headers: { Cookie: owner.cookie } });
  const id = list.body.data.payments[0].id;

  const foreign = await api(`/payments/${id}`, {
    headers: { Cookie: attacker.cookie },
  });
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.body.error.code, 'PAYMENT_NOT_FOUND');

  const missing = await api(
    '/payments/00000000-0000-4000-8000-0000000000fe',
    { headers: { Cookie: attacker.cookie } }
  );
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, 'PAYMENT_NOT_FOUND');
  assert.equal(foreign.body.error.message, missing.body.error.message);

  const invalid = await api('/payments/not-a-uuid', {
    headers: { Cookie: attacker.cookie },
  });
  assert.equal(invalid.response.status, 404);
  assert.equal(invalid.body.error.code, 'PAYMENT_NOT_FOUND');
  const raw = JSON.stringify(invalid.body).toLowerCase();
  assert.equal(raw.includes('sql'), false);
  assert.equal(raw.includes('stack'), false);
});

// ---------- Provider architecture ----------

test('payment provider registry: disabled provider rejects all operations, unknown providers are not registered', async () => {
  const { getProvider } = require('../src/services/payments/paymentProvider');
  const config = require('../src/config');

  assert.equal(config.payments.provider, 'disabled');

  const provider = getProvider('disabled');
  assert.ok(provider, 'disabled provider must be registered');
  assert.equal(provider.name, 'disabled');

  assert.equal(getProvider('stripe'), null);
  assert.equal(getProvider(''), null);
  assert.equal(getProvider(undefined), null);

  for (const op of ['createPayment', 'verifyPayment', 'handleWebhook']) {
    await assert.rejects(
      () => provider[op]({}),
      (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.code, 'PAYMENT_PROVIDER_NOT_CONFIGURED');
        return true;
      },
      op
    );
  }
});

// ---------- Webhook ----------

test('GET /api/payments/provider: public, read-only, provider name only', async () => {
  const config = require('../src/config');
  const { response, body } = await api('/payments/provider');
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body.data), ['provider'], 'provider name only');
  assert.equal(body.data.provider, config.payments.provider);
  const raw = JSON.stringify(body).toLowerCase();
  assert.equal(raw.includes('http'), false, 'no URLs leak');
  assert.equal(raw.includes('key'), false, 'no key material leaks');
  assert.equal(raw.includes('secret'), false, 'no secrets leak');
});

test('POST /api/payments/webhook/disabled cannot mark an order paid (503, no state change)', async () => {
  const { cookie } = await registerUser('pwhook');
  const order = await createOrder(cookie);
  const { pool } = await db();

  const { response, body } = await postJson(
    '/payments/webhook/disabled',
    {
      orderId: order.id,
      status: 'successful',
      amount: order.amount,
      currency: order.currency,
    }
    // no session cookie — webhooks are external calls
  );
  assert.equal(response.status, 503);
  assert.equal(body.error.code, 'PAYMENT_PROVIDER_NOT_CONFIGURED');

  const { rows: orderRows } = await pool.query(
    'SELECT status FROM orders WHERE id = $1',
    [order.id]
  );
  assert.equal(orderRows[0].status, 'awaiting_payment');

  const { rows: successRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payment_transactions
     WHERE order_id = $1 AND status = 'successful'`,
    [order.id]
  );
  assert.equal(successRows[0].n, 0);

  const { rows: anyRows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM payment_transactions WHERE order_id = $1',
    [order.id]
  );
  assert.equal(anyRows[0].n, 0, 'webhook must not create payment rows');
});

test('unknown or invalid webhook provider names are 404', async () => {
  for (const name of ['stripe', 'UPPER', 'disabled-extra', 'x']) {
    const { response, body } = await postJson(
      `/payments/webhook/${name}`,
      { hello: 'world' }
    );
    assert.equal(response.status, 404, name);
    assert.equal(body.error.code, 'NOT_FOUND', name);
  }
});

// ---------- No client-controlled confirmation ----------

test('there is no client-controlled payment confirmation endpoint', async () => {
  const { cookie } = await registerUser('pconfirm');
  const order = await createOrder(cookie);
  const list = await attemptPayment(cookie, order.id);
  assert.equal(list.response.status, 503);

  const { pool } = await db();
  const { rows } = await pool.query(
    'SELECT id FROM payment_transactions WHERE order_id = $1 LIMIT 1',
    [order.id]
  );
  const paymentId = rows[0].id;

  for (const path of [
    `/payments/${paymentId}/confirm`,
    `/payments/${paymentId}/complete`,
    `/payments/${paymentId}/success`,
    `/payments/${paymentId}/capture`,
    '/payments/confirm',
    '/payments/mark-successful',
  ]) {
    const { response, body } = await postJson(
      path,
      { status: 'successful' },
      { Cookie: cookie }
    );
    assert.equal(response.status, 404, path);
    assert.equal(body.error.code, 'NOT_FOUND', path);
  }

  // order and payment unchanged
  const { rows: orderRows } = await pool.query(
    'SELECT status FROM orders WHERE id = $1',
    [order.id]
  );
  assert.equal(orderRows[0].status, 'awaiting_payment');
  const { rows: payRows } = await pool.query(
    'SELECT status FROM payment_transactions WHERE id = $1',
    [paymentId]
  );
  assert.equal(payRows[0].status, 'initiated');
});

// ---------- Internal paid transition ----------

test('markOrderPaidFromVerifiedPayment verifies atomically, is idempotent on replay, and rejects mismatched amounts', async () => {
  const paymentService = require('../src/services/payments/paymentService');
  const { cookie } = await registerUser('pmark');
  const order = await createOrder(cookie);
  const { pool } = await db();

  // record an initiated attempt via the API (disabled provider → 503)
  const attempt = await attemptPayment(cookie, order.id);
  assert.equal(attempt.response.status, 503);

  const { rows: payRows } = await pool.query(
    'SELECT id, status FROM payment_transactions WHERE order_id = $1',
    [order.id]
  );
  assert.equal(payRows.length, 1);
  const paymentId = payRows[0].id;

  // wrong amount → verification failure, nothing changes
  await assert.rejects(
    () =>
      paymentService.markOrderPaidFromVerifiedPayment({
        paymentId,
        amount: '0.01',
        currency: order.currency,
      }),
    (err) => {
      assert.equal(err.code, 'PAYMENT_VERIFICATION_FAILED');
      return true;
    }
  );

  // wrong currency → verification failure, nothing changes
  await assert.rejects(
    () =>
      paymentService.markOrderPaidFromVerifiedPayment({
        paymentId,
        amount: order.amount,
        currency: order.currency === 'BDT' ? 'USD' : 'BDT',
      }),
    (err) => {
      assert.equal(err.code, 'PAYMENT_VERIFICATION_FAILED');
      return true;
    }
  );

  let state = await pool.query(
    `SELECT o.status AS order_status, p.status AS payment_status, p.paid_at
     FROM orders o JOIN payment_transactions p ON p.order_id = o.id
     WHERE o.id = $1`,
    [order.id]
  );
  assert.equal(state.rows[0].order_status, 'awaiting_payment');
  assert.equal(state.rows[0].payment_status, 'initiated');
  assert.equal(state.rows[0].paid_at, null);

  // correct verified values → payment successful + order paid atomically
  const verifiedTx = `tx-${unique()}`;
  const result = await paymentService.markOrderPaidFromVerifiedPayment({
    paymentId,
    amount: order.amount,
    currency: order.currency,
    providerTransactionId: verifiedTx,
  });
  assert.equal(result.orderStatus, 'paid');
  assert.equal(result.payment.status, 'successful');
  assert.ok(result.payment.paidAt);

  state = await pool.query(
    `SELECT o.status AS order_status, p.status AS payment_status, p.paid_at,
            p.provider_transaction_id
     FROM orders o JOIN payment_transactions p ON p.order_id = o.id
     WHERE o.id = $1`,
    [order.id]
  );
  assert.equal(state.rows[0].order_status, 'paid');
  assert.equal(state.rows[0].payment_status, 'successful');
  assert.ok(state.rows[0].paid_at);
  assert.equal(state.rows[0].provider_transaction_id, verifiedTx);
  const firstPaidAt = state.rows[0].paid_at.toISOString();

  // verified replay is idempotent — no error, no second successful payment
  const replay = await paymentService.markOrderPaidFromVerifiedPayment({
    paymentId,
    amount: order.amount,
    currency: order.currency,
    providerTransactionId: verifiedTx,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.orderStatus, 'paid');

  state = await pool.query(
    `SELECT p.paid_at,
            (SELECT COUNT(*)::int FROM payment_transactions
             WHERE order_id = $1 AND status = 'successful') AS successes
     FROM payment_transactions p WHERE p.id = $2`,
    [order.id, paymentId]
  );
  assert.equal(state.rows[0].paid_at.toISOString(), firstPaidAt);
  assert.equal(state.rows[0].successes, 1);

  // a second attempt on an already-paid order cannot create another success
  const { rows: userRows } = await pool.query(
    `SELECT o.user_id FROM orders o WHERE o.id = $1`,
    [order.id]
  );
  const second = await pool.query(
    `INSERT INTO payment_transactions (order_id, user_id, provider, amount, currency, status)
     VALUES ($1, $2, 'disabled', $3, $4, 'initiated')
     RETURNING id`,
    [order.id, userRows[0].user_id, order.amount, order.currency]
  );

  await assert.rejects(
    () =>
      paymentService.markOrderPaidFromVerifiedPayment({
        paymentId: second.rows[0].id,
        amount: order.amount,
        currency: order.currency,
      }),
    (err) => {
      assert.equal(err.code, 'ORDER_ALREADY_PAID');
      return true;
    }
  );

  const finalCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payment_transactions
     WHERE order_id = $1 AND status = 'successful'`,
    [order.id]
  );
  assert.equal(finalCount.rows[0].n, 1, 'exactly one successful payment');
});

// ---------- Frontend / checkout / dashboard regressions ----------

test('checkout.html has Proceed to Payment UI and no payment fields', async () => {
  const response = await fetch(`${BASE_URL}/checkout`);
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.ok(html.includes('id="proceed-payment"'));
  assert.ok(html.includes('id="payment-status"'));
  assert.ok(html.includes('id="order-confirm"'));
  assert.ok(html.includes('id="place-order"'));
  assert.ok(html.includes('Proceed to Payment'));

  // no card collection, no inline scripts/styles
  assert.equal(/card number|cvv|iban|credit card number/i.test(html), false);
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
  assert.equal(/<style[\s>]/i.test(html), false);
});

test('checkout.js posts only orderId to /api/payments and handles the disabled provider honestly', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/checkout.js'),
    'utf8'
  );

  assert.ok(js.includes('"/api/payments"'));
  assert.ok(js.includes('PAYMENT_PROVIDER_NOT_CONFIGURED'));
  assert.ok(js.includes('Payment processing is not available yet.'));

  // inspect the payment request payload region — orderId only
  const idx = js.indexOf('"/api/payments"');
  assert.ok(idx > 0);
  const slice = js.slice(idx, idx + 700);
  assert.ok(slice.includes('orderId'));
  assert.equal(/\bamount\s*:/.test(slice), false, 'no amount in payment body');
  assert.equal(/\bcurrency\s*:/.test(slice), false, 'no currency in payment body');
  assert.equal(/\bstatus\s*:/.test(slice), false, 'no status in payment body');

  // never claims a successful/confirmed/complete payment
  assert.equal(/payment (successful|confirmed|complete)/i.test(js), false);

  // order flow regressions intact
  assert.ok(js.includes('Idempotency-Key'));
  assert.ok(js.includes('Canonical data comes only from the API'));
});

test('dashboard.html billing section is functional (live payment history, not coming soon)', async () => {
  const response = await fetch(`${BASE_URL}/dashboard`);
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.ok(html.includes('data-section="billing"'));
  assert.ok(html.includes('id="payments-list"'));
  assert.ok(html.includes('id="payments-empty"'));
  assert.ok(html.includes('id="payments-pagination"'));
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
  assert.equal(/<style[\s>]/i.test(html), false);
});

test('dashboard.js loads payments from /api/payments with safe DOM rendering', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/dashboard.js'),
    'utf8'
  );

  assert.ok(js.includes('/api/payments?page='));
  assert.ok(js.includes('PAYMENT_STATUS_LABELS'));
  assert.ok(js.includes('initiated'));
  assert.ok(js.includes('payments-empty'));

  // no innerHTML injection of payment fields
  assert.equal(
    /payment\.(orderNumber|amount|orderId)[\s\S]{0,40}innerHTML/.test(js),
    false
  );
});

// ---------- Regression ----------

test('regression: health and order create still work with payments enabled', async () => {
  const health = await api('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.database, 'up');

  const { cookie } = await registerUser('regress');
  const order = await createOrder(cookie, 'vps', 'vps-1');
  assert.equal(order.status, 'awaiting_payment');

  // orders still have no pay endpoint
  const pay = await postJson(
    `/orders/${order.id}/pay`,
    { status: 'paid' },
    { Cookie: cookie }
  );
  assert.equal(pay.response.status, 404);
});
