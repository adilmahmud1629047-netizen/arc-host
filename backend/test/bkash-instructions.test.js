const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

// Pin flags before any src require. dotenv never overrides pre-set env.
process.env.BKASH_PAYMENT_ENABLED = 'false';
process.env.BKASH_RECEIVER_NUMBER = '';

const config = require('../src/config');

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;

// Sentinel: clearly not a phone number — never a plausible bKash receiver.
const RECEIVER_SENTINEL = 'RECEIVER-PLACEHOLDER-NOT-A-REAL-NUMBER';

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

async function api(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    body = null;
  }
  return { response, body };
}

function postJson(base, path, payload, headers = {}) {
  return api(base, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

async function registerUser(prefix = 'bki') {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson(
    `${live}/api`,
    '/auth/register',
    {
      firstName: 'Bkash',
      lastName: 'Tester',
      email,
      password,
    }
  );
  assert.equal(reg.response.status, 201);
  const login = await postJson(`${live}/api`, '/auth/login', { email, password });
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie, 'expected session cookie');
  return { email, password, cookie };
}

async function createOrder(cookie, productType = 'hosting', planSlug = 'starter') {
  const { response, body } = await postJson(
    `${live}/api`,
    '/orders',
    { productType, planSlug },
    { Cookie: cookie }
  );
  assert.equal(response.status, 201);
  return body.data;
}

async function getOrderRow(orderId) {
  const { rows } = await database.pool.query(
    `SELECT id, order_number, amount::text AS amount, currency, status, user_id
     FROM orders WHERE id = $1`,
    [orderId]
  );
  return rows[0] || null;
}

async function countPaymentRows(orderId) {
  const { rows } = await database.pool.query(
    'SELECT COUNT(*)::int AS n FROM payment_transactions WHERE order_id = $1',
    [orderId]
  );
  return rows[0].n;
}

// Hit the in-process app (separate port) where bkash config is mutated;
// users/orders come from the shared DB so sessions work on both servers.
async function instructions(path, cookie, query = '') {
  return api(
    own,
    `/api/orders/${path}/bkash-instructions${query}`,
    cookie
      ? { headers: { Cookie: cookie, Accept: 'application/json' } }
      : { headers: { Accept: 'application/json' } }
  );
}

async function withBkash({ enabled, receiver }, fn) {
  const prevEnabled = config.payments.bkash.enabled;
  const prevReceiver = config.payments.bkash.receiverNumber;
  config.payments.bkash.enabled = enabled;
  config.payments.bkash.receiverNumber = receiver;
  try {
    return await fn();
  } finally {
    config.payments.bkash.enabled = prevEnabled;
    config.payments.bkash.receiverNumber = prevReceiver;
  }
}

let database;
let live; // external test server (TEST_BASE_URL) — register/login/create only
let own; // in-process app — endpoint under test (mutable config)
let ownServer;

function listenApp(expressApp) {
  return new Promise((resolve, reject) => {
    const server = expressApp.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr && typeof addr === 'object' ? addr.port : null });
    });
    server.once('error', reject);
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

before(async () => {
  const { runUp } = require('../src/services/migrator');
  await runUp();
  database = require('../src/config/database');
  const { runSeed } = require('../src/services/seed');
  await runSeed();

  live = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';

  const app = require('../src/app');
  const started = await listenApp(app);
  ownServer = started.server;
  own = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await closeServer(ownServer);
  if (database) await database.closePool().catch(() => {});
});

// ---------- endpoint ----------

test('owner gets instructions when enabled, receiver set, awaiting payment', async () => {
  const user = await registerUser();
  const order = await createOrder(user.cookie);
  const row = await getOrderRow(order.id);

  await withBkash({ enabled: true, receiver: RECEIVER_SENTINEL }, async () => {
    const { response, body } = await instructions(order.id, user.cookie);
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    const data = body.data;
    assert.deepEqual(
      Object.keys(data).sort(),
      ['amount', 'currency', 'orderNumber', 'receiverNumber']
    );
    assert.equal(data.receiverNumber, RECEIVER_SENTINEL);
    assert.equal(data.amount, String(row.amount));
    assert.equal(data.currency, row.currency);
    assert.equal(data.orderNumber, row.order_number);
  });
});

test('unauthenticated request gets 401', async () => {
  const user = await registerUser();
  const order = await createOrder(user.cookie);

  await withBkash({ enabled: true, receiver: RECEIVER_SENTINEL }, async () => {
    const { response, body } = await instructions(order.id, null);
    assert.equal(response.status, 401);
    assert.equal(body.error.code, 'UNAUTHORIZED');
    assert.equal(JSON.stringify(body).includes(RECEIVER_SENTINEL), false);
  });
});

test('another authenticated user gets 404 (same as missing order)', async () => {
  const owner = await registerUser();
  const stranger = await registerUser('other');
  const order = await createOrder(owner.cookie);

  await withBkash({ enabled: true, receiver: RECEIVER_SENTINEL }, async () => {
    const { response, body } = await instructions(order.id, stranger.cookie);
    assert.equal(response.status, 404);
    assert.equal(body.error.code, 'ORDER_NOT_FOUND');
    assert.equal(JSON.stringify(body).includes(RECEIVER_SENTINEL), false);
  });
});

test('missing order gets 404 for its (non-)owner', async () => {
  const user = await registerUser();
  const missing = '11111111-2222-4333-8444-555555555555';

  await withBkash({ enabled: true, receiver: RECEIVER_SENTINEL }, async () => {
    const { response, body } = await instructions(missing, user.cookie);
    assert.equal(response.status, 404);
    assert.equal(body.error.code, 'ORDER_NOT_FOUND');
  });
});

test('disabled flag gives 503 PAYMENT_PROVIDER_NOT_CONFIGURED and no receiver leak', async () => {
  const user = await registerUser();
  const order = await createOrder(user.cookie);

  await withBkash({ enabled: false, receiver: RECEIVER_SENTINEL }, async () => {
    const { response, body } = await instructions(order.id, user.cookie);
    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'PAYMENT_PROVIDER_NOT_CONFIGURED');
    assert.equal(JSON.stringify(body).includes(RECEIVER_SENTINEL), false);
  });
});

test('empty receiver gives 503 BKASH_PAYMENT_NOT_CONFIGURED', async () => {
  const user = await registerUser();
  const order = await createOrder(user.cookie);

  await withBkash({ enabled: true, receiver: '' }, async () => {
    const { response, body } = await instructions(order.id, user.cookie);
    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'BKASH_PAYMENT_NOT_CONFIGURED');
    assert.equal(JSON.stringify(body).includes(RECEIVER_SENTINEL), false);
  });
});

test('paid order gets 409 ORDER_NOT_AWAITING', async () => {
  const user = await registerUser();
  const order = await createOrder(user.cookie);
  await database.pool.query(
    `UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'awaiting_payment'`,
    [order.id]
  );

  await withBkash({ enabled: true, receiver: RECEIVER_SENTINEL }, async () => {
    const { response, body } = await instructions(order.id, user.cookie);
    assert.equal(response.status, 409);
    assert.equal(body.error.code, 'ORDER_NOT_AWAITING');
    assert.equal(JSON.stringify(body).includes(RECEIVER_SENTINEL), false);
  });
});

test('cancelled order gets 409 ORDER_NOT_AWAITING', async () => {
  const user = await registerUser();
  const order = await createOrder(user.cookie);
  await database.pool.query(
    `UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'awaiting_payment'`,
    [order.id]
  );

  await withBkash({ enabled: true, receiver: RECEIVER_SENTINEL }, async () => {
    const { response, body } = await instructions(order.id, user.cookie);
    assert.equal(response.status, 409);
    assert.equal(body.error.code, 'ORDER_NOT_AWAITING');
  });
});

test('amount/order values come from the DB, not from the request', async () => {
  const user = await registerUser();
  const order = await createOrder(user.cookie);
  const row = await getOrderRow(order.id);

  await withBkash({ enabled: true, receiver: RECEIVER_SENTINEL }, async () => {
    const { response, body } = await instructions(
      order.id,
      user.cookie,
      '?amount=1&currency=USD&orderNumber=FAKE-1&receiverNumber=01800000000'
    );
    assert.equal(response.status, 200);
    assert.equal(body.data.amount, String(row.amount));
    assert.equal(body.data.currency, row.currency);
    assert.equal(body.data.orderNumber, row.order_number);
    assert.equal(body.data.receiverNumber, RECEIVER_SENTINEL);
  });
});

test('fetching instructions never creates a payment row or changes status', async () => {
  const user = await registerUser();
  const order = await createOrder(user.cookie);
  const paymentsBefore = await countPaymentRows(order.id);
  const rowBefore = await getOrderRow(order.id);

  await withBkash({ enabled: true, receiver: RECEIVER_SENTINEL }, async () => {
    const { response } = await instructions(order.id, user.cookie);
    assert.equal(response.status, 200);
  });

  const paymentsAfter = await countPaymentRows(order.id);
  const rowAfter = await getOrderRow(order.id);
  assert.equal(paymentsAfter, paymentsBefore, 'no payment_transactions row added');
  assert.equal(paymentsAfter, 0);
  assert.equal(rowAfter.status, rowBefore.status, 'order status unchanged');
  assert.equal(rowAfter.status, 'awaiting_payment');
});

// ---------- frontend (served static files) ----------

test('checkout page has bKash controls, no inline script, no card fields', async () => {
  const response = await fetch(`${live}/checkout`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('id="bkash-pay-btn"'));
  assert.ok(html.includes('id="bkash-instructions"'));
  assert.ok(html.includes('id="proceed-payment"'));
  assert.ok(html.includes('Pay with bKash'));
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
  assert.equal(/card number|cvv|iban|credit card number/i.test(html), false);
});

test('checkout.js fetches instructions via GET and never posts payment data', async () => {
  const js = await (await fetch(`${live}/js/checkout.js`)).text();
  assert.ok(js.includes('/bkash-instructions'));
  assert.ok(js.includes('bkash-receiver'));
  assert.equal(/mark\s+as\s+paid/i.test(js), false);
  assert.equal(/body:\s*JSON\.stringify\(\{[^}]*amount/s.test(js), false);
  assert.equal(/payment (successful|confirmed|complete)/i.test(js), false);
});

test('dashboard.js shows instructions only while awaiting and has no mark-paid control', async () => {
  const js = await (await fetch(`${live}/js/dashboard.js`)).text();
  assert.ok(js.includes('/bkash-instructions'));
  assert.ok(js.includes('dash-bkash-receiver'));
  assert.ok(js.includes('awaiting_payment'));
  assert.equal(/mark\s+as\s+paid/i.test(js), false);
});

test('frontend hardcodes no bKash receiver number', async () => {
  for (const path of [
    '/js/checkout.js',
    '/js/dashboard.js',
    '/checkout',
    '/dashboard',
  ]) {
    const text = await (await fetch(`${live}${path}`)).text();
    assert.equal(/01[3-9]\d{8}/.test(text), false, `receiver-like number in ${path}`);
    assert.equal(text.includes(RECEIVER_SENTINEL), false, `sentinel leak in ${path}`);
  }
});
