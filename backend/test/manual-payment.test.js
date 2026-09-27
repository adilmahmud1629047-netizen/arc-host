const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// STEP 37: manual payment verification. Automatic verification must stay
// off — pin the disabled provider in-process (dotenv does not override
// already-set env values) exactly like payments.test.js does.
process.env.PAYMENT_PROVIDER = 'disabled';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;
const FRONTEND = path.join(__dirname, '../../frontend');
const FRONTEND_ADMIN = path.join(FRONTEND, 'admin');
const APP_JS = path.join(__dirname, '../src/app.js');

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;
// Transaction ids must be unique per run: duplicate-TrxID is a 409 by design,
// and fixtures from a previous run are intentionally left in the database
// (the STEP 36 cleanup sweeps them after the suite).
const trx = (label) => `TRX-${label}-${unique()}`.toUpperCase();

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

// node:fetch refuses a body on GET/HEAD, but the admin foundation contract
// must still hold for a raw GET that arrives with a JSON body.
const http = require('node:http');
function rawRequest(pathSuffix, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${API}${pathSuffix}`,
      { method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function registerSession(prefix) {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Manual',
    lastName: 'Payment',
    email,
    password,
  });
  assert.equal(reg.response.status, 201, JSON.stringify(reg.body));
  const login = await postJson('/auth/login', { email, password });
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie, 'expected session cookie');
  return { email, password, cookie };
}

async function createAwaitingOrder(cookie) {
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

async function promoteAdmin(email) {
  await pool.query(
    `UPDATE users SET role = 'admin', status = 'active' WHERE email = $1`,
    [email.toLowerCase()]
  );
}

async function adminSession(prefix = 'mp-admin') {
  const session = await registerSession(prefix);
  await promoteAdmin(session.email);
  const login = await postJson('/auth/login', {
    email: session.email,
    password: session.password,
  });
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie, 'expected admin session cookie');
  return { ...session, cookie };
}

async function userIdByEmail(email) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  return rows[0] ? rows[0].id : null;
}

async function paymentRow(paymentId) {
  const { rows } = await pool.query(
    `SELECT id, order_id, user_id, provider, provider_transaction_id, amount::text AS amount,
            currency, status, payment_method, paid_at, metadata
     FROM payment_transactions WHERE id = $1`,
    [paymentId]
  );
  return rows[0] || null;
}

async function orderRow(orderId) {
  const { rows } = await pool.query(
    'SELECT id, status, amount::text AS amount, currency FROM orders WHERE id = $1',
    [orderId]
  );
  return rows[0] || null;
}

async function manualCountForOrder(orderId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payment_transactions
     WHERE order_id = $1 AND provider = 'manual'`,
    [orderId]
  );
  return rows[0].n;
}

function submitTransaction(cookie, payload) {
  return postJson('/payments/transaction-id', payload, { Cookie: cookie });
}

let pool;

before(async () => {
  const { runUp } = require('../src/services/migrator');
  await runUp();
  const db = require('../src/config/database');
  pool = db;
});

after(async () => {
  if (pool) await pool.closePool().catch(() => {});
});

// ---------- Migration / schema ----------

test('migration 017 adds the manual pending-order unique index and re-running is a no-op', async () => {
  const { runUp } = require('../src/services/migrator');
  const second = await runUp();
  assert.equal(second.applied, 0, 'migration 017 must already be applied');

  const { rows: applied } = await pool.query(
    "SELECT version FROM schema_migrations WHERE version LIKE '017%'"
  );
  assert.equal(applied.length, 1);
  assert.match(applied[0].version, /^017_add_manual_payment_constraints\.sql$/);

  const { rows: indexes } = await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE tablename = 'payment_transactions'
       AND indexname IN (
         'payment_transactions_manual_pending_order',
         'payment_transactions_provider_tx_unique',
         'payment_transactions_one_success_per_order'
       )`
  );
  assert.equal(indexes.length, 3, JSON.stringify(indexes));

  const { rows: count } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM schema_migrations'
  );
  assert.equal(count[0].n, 18, '18 migrations after 018');
});

// ---------- Customer submission ----------

test('POST /api/payments/transaction-id: anonymous 401, cross-origin 403 CSRF', async () => {
  const anon = await postJson('/payments/transaction-id', {
    orderId: '00000000-0000-4000-8000-000000000001',
    transactionId: 'TRX-12345',
  });
  assert.equal(anon.response.status, 401);
  assert.equal(anon.body.error.code, 'UNAUTHORIZED');

  const { cookie } = await registerSession('mp-csrf');
  const cross = await postJson(
    '/payments/transaction-id',
    {
      orderId: '00000000-0000-4000-8000-000000000001',
      transactionId: 'TRX-12345',
    },
    { Cookie: cookie, Origin: 'https://evil.example' }
  );
  assert.equal(cross.response.status, 403);
  assert.equal(cross.body.error.code, 'CSRF_INVALID');
});

test('POST /api/payments/transaction-id: strict body validation (400s)', async () => {
  const { cookie } = await registerSession('mp-valid');
  const order = await createAwaitingOrder(cookie);

  const missingTrx = await postJson(
    '/payments/transaction-id',
    { orderId: order.id },
    { Cookie: cookie }
  );
  assert.equal(missingTrx.response.status, 400);
  assert.equal(missingTrx.body.error.code, 'VALIDATION_ERROR');

  const shortTrx = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: 'ab',
  });
  assert.equal(shortTrx.response.status, 400);

  const badTrx = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: 'trx id with spaces!',
  });
  assert.equal(badTrx.response.status, 400);
  assert.match(badTrx.body.error.details.join(' '), /Transaction ID/);

  // Client-supplied truth fields are never accepted.
  for (const field of ['amount', 'currency', 'status', 'verified']) {
    const attempt = await submitTransaction(cookie, {
      orderId: order.id,
      transactionId: 'TRX-99001',
      [field]: field === 'status' || field === 'verified' ? 'successful' : '1',
    });
    assert.equal(attempt.response.status, 400, `field ${field}`);
    assert.match(attempt.body.error.details.join(' '), new RegExp(field));
  }

  assert.equal(await manualCountForOrder(order.id), 0, 'nothing persisted');
  assert.equal((await orderRow(order.id)).status, 'awaiting_payment');
});

test('POST /api/payments/transaction-id: 404 for unknown or foreign orders', async () => {
  const { cookie } = await registerSession('mp-owner');
  const order = await createAwaitingOrder(cookie);

  const other = await registerSession('mp-other');
  const foreign = await submitTransaction(other.cookie, {
    orderId: order.id,
    transactionId: 'TRX-FOREIGN1',
  });
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.body.error.code, 'ORDER_NOT_FOUND');

  const unknown = await submitTransaction(cookie, {
    orderId: '00000000-0000-4000-8000-0000000000ff',
    transactionId: 'TRX-UNKNOWN1',
  });
  assert.equal(unknown.response.status, 404);

  const malformed = await submitTransaction(cookie, {
    orderId: 'not-a-uuid',
    transactionId: 'TRX-MALFORMED1',
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(await manualCountForOrder(order.id), 0);
});

test('submit: 201 stores pending manual row, server-derived amount, uppercase TrxID, order untouched', async () => {
  const { cookie } = await registerSession('mp-submit');
  const order = await createAwaitingOrder(cookie);

  const rawTrx = `trx-abc123-${unique()}`;
  const { response, body } = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: `  ${rawTrx}  `,
    paymentMethod: 'bKash',
  });
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.data.payment.status, 'awaiting_verification');
  assert.equal(body.data.payment.transactionId, rawTrx.toUpperCase());
  assert.equal(body.data.payment.paymentMethod, 'bKash');
  assert.equal(body.data.order.status, 'awaiting_payment');
  assert.equal(body.data.order.amount, String(order.amount));

  const rows = await pool.query(
    `SELECT provider, status, provider_transaction_id, payment_method,
            amount::text AS amount, currency, user_id
     FROM payment_transactions WHERE order_id = $1`,
    [order.id]
  );
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0];
  assert.equal(row.provider, 'manual');
  assert.equal(row.status, 'pending');
  assert.equal(row.provider_transaction_id, rawTrx.toUpperCase());
  assert.equal(row.payment_method, 'bKash');
  assert.equal(row.amount, String(order.amount), 'amount from order only');

  const afterOrder = await orderRow(order.id);
  assert.equal(afterOrder.status, 'awaiting_payment', 'never auto-paid');
});

test('submit: duplicate submission per order → 409 PAYMENT_SUBMISSION_EXISTS', async () => {
  const { cookie } = await registerSession('mp-dupsubmit');
  const order = await createAwaitingOrder(cookie);

  const first = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('FIRST'),
  });
  assert.equal(first.response.status, 201);

  const second = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('SECOND'),
  });
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error.code, 'PAYMENT_SUBMISSION_EXISTS');
  assert.equal(await manualCountForOrder(order.id), 1, 'no stacked rows');
  assert.equal((await orderRow(order.id)).status, 'awaiting_payment');
});

test('submit: same Transaction ID on another order → 409 DUPLICATE_TRANSACTION_ID', async () => {
  const { cookie } = await registerSession('mp-duptrx');
  const orderA = await createAwaitingOrder(cookie);
  const orderB = await createAwaitingOrder(cookie);
  const sharedTrx = trx('SHARED');

  const first = await submitTransaction(cookie, {
    orderId: orderA.id,
    transactionId: sharedTrx,
  });
  assert.equal(first.response.status, 201);

  const second = await submitTransaction(cookie, {
    orderId: orderB.id,
    transactionId: sharedTrx.toLowerCase(),
  });
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error.code, 'DUPLICATE_TRANSACTION_ID');
  assert.equal(await manualCountForOrder(orderB.id), 0);
});

test('submit: order that is not awaiting payment → 409 ORDER_NOT_PAYABLE', async () => {
  const { cookie } = await registerSession('mp-paid');
  const order = await createAwaitingOrder(cookie);
  await pool.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [
    order.id,
  ]);

  const { response, body } = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('PAID'),
  });
  assert.equal(response.status, 409);
  assert.equal(body.error.code, 'ORDER_NOT_PAYABLE');
  assert.equal(await manualCountForOrder(order.id), 0);
});

test('submit: rate limited after payment-create max (429 RATE_LIMITED)', async () => {
  const config = require('../src/config');
  const { cookie } = await registerSession('mp-rate');
  const max = config.rateLimit.paymentCreateMax;

  let last = null;
  for (let i = 0; i <= max; i += 1) {
    last = await submitTransaction(cookie, {
      orderId: '00000000-0000-4000-8000-0000000000fe',
      transactionId: `TRX-RATE-${i}`,
    });
    if (last.response.status === 429) break;
  }
  assert.equal(last.response.status, 429, `expected 429 after ${max} hits`);
  assert.equal(last.body.error.code, 'RATE_LIMITED');
});

// ---------- Customer payment state ----------

test('GET /api/payments/order/:orderId: none → awaiting → verified, plus 400/404 cases', async () => {
  const { cookie } = await registerSession('mp-state');
  const order = await createAwaitingOrder(cookie);

  const before = await api(`/payments/order/${order.id}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(before.response.status, 200);
  assert.equal(before.body.data.status, 'none');
  assert.equal(before.body.data.payment, null);
  assert.equal(before.body.data.order.status, 'awaiting_payment');

  const badUuid = await api('/payments/order/not-a-uuid', {
    headers: { Cookie: cookie },
  });
  assert.equal(badUuid.response.status, 400);
  assert.equal(badUuid.body.error.code, 'VALIDATION_ERROR');

  const other = await registerSession('mp-state-x');
  const foreign = await api(`/payments/order/${order.id}`, {
    headers: { Cookie: other.cookie },
  });
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.body.error.code, 'ORDER_NOT_FOUND');

  const anon = await api(`/payments/order/${order.id}`);
  assert.equal(anon.response.status, 401);

  const submitted = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('STATE'),
  });
  assert.equal(submitted.response.status, 201);
  const paymentId = submitted.body.data.payment.paymentId;

  const pending = await api(`/payments/order/${order.id}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(pending.body.data.status, 'awaiting_verification');
  assert.equal(
    pending.body.data.payment.transactionId,
    submitted.body.data.payment.transactionId
  );

  const admin = await adminSession();
  const verify = await postJson(
    `/admin/payments/${paymentId}/verify`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(verify.response.status, 200, JSON.stringify(verify.body));

  const verified = await api(`/payments/order/${order.id}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(verified.body.data.status, 'verified');
  assert.equal(verified.body.data.order.status, 'paid');
});

// ---------- Admin authorization + list ----------

test('GET /api/admin/payments: anon 401, customer 403, admin 200', async () => {
  const anon = await api('/admin/payments');
  assert.equal(anon.response.status, 401);
  assert.equal(anon.body.error.code, 'UNAUTHORIZED');

  const customer = await registerSession('mp-listcust');
  const asCustomer = await api('/admin/payments', {
    headers: { Cookie: customer.cookie },
  });
  assert.equal(asCustomer.response.status, 403);
  assert.equal(asCustomer.body.error.code, 'FORBIDDEN');

  const admin = await adminSession();
  const asAdmin = await api('/admin/payments', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(asAdmin.response.status, 200);
  assert.ok(asAdmin.body.data.payments);
  assert.ok(asAdmin.body.data.pagination);
});

test('GET /api/admin/payments: lists manual rows only; filters + query validation', async () => {
  const { cookie } = await registerSession('mp-list');
  const order = await createAwaitingOrder(cookie);
  const listTrx = trx('LIST');
  const submitted = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: listTrx,
  });
  assert.equal(submitted.response.status, 201);

  // a non-manual attempt on the same order must never surface for review
  await pool.query(
    `INSERT INTO payment_transactions (order_id, user_id, provider, amount, currency, status)
     VALUES ($1, (SELECT user_id FROM orders WHERE id = $1), 'disabled', 10.00, 'BDT', 'initiated')`,
    [order.id]
  );

  const admin = await adminSession();

  const all = await api('/admin/payments?page=1&limit=50', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(all.response.status, 200);
  const listed = all.body.data.payments;
  assert.ok(listed.length >= 1);
  const uiStatuses = new Set(['awaiting_verification', 'verified', 'rejected']);
  assert.ok(
    listed.every((p) => uiStatuses.has(p.status)),
    'only reviewable manual submissions are listed'
  );
  const mine = listed.find((p) => p.orderId === order.id);
  assert.ok(mine, 'manual submission listed');
  assert.equal(mine.status, 'awaiting_verification');
  assert.equal(mine.rawStatus, 'pending');
  assert.equal(mine.transactionId, listTrx);
  assert.equal(mine.orderNumber, order.orderNumber);
  assert.equal(typeof mine.customer.email, 'string');
  assert.ok(
    !listed.some((p) => p.rawStatus === 'initiated'),
    'disabled-provider attempts are never listed'
  );

  const waiting = await api('/admin/payments?status=awaiting_verification', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(waiting.response.status, 200);
  assert.ok(
    waiting.body.data.payments.every(
      (p) => p.status === 'awaiting_verification'
    )
  );

  const verified = await api('/admin/payments?status=verified', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(verified.response.status, 200);
  assert.ok(verified.body.data.payments.every((p) => p.status === 'verified'));

  const rejected = await api('/admin/payments?status=rejected', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(rejected.response.status, 200);
  assert.ok(rejected.body.data.payments.every((p) => p.status === 'rejected'));

  const badStatus = await api('/admin/payments?status=paid', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badStatus.response.status, 400);
  assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');

  const badQuery = await api('/admin/payments?nope=1', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badQuery.response.status, 400);

  const badLimit = await api('/admin/payments?limit=0', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(badLimit.response.status, 400);
});

test('admin GET foundation stays body-free: GET with JSON body → 400', async () => {
  const admin = await adminSession();
  const bodyText = JSON.stringify({ status: 'verified' });
  const { status, body } = await rawRequest('/admin/payments', {
    method: 'GET',
    headers: {
      Cookie: admin.cookie,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyText),
    },
    body: bodyText,
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.match(body.error.details.join(' '), /Remove the request body/);
});

// ---------- Admin verify ----------

test('verify: anon 401 / customer 403 / admin 200 → order paid, metadata audited', async () => {
  const { cookie } = await registerSession('mp-verify');
  const order = await createAwaitingOrder(cookie);
  const submitted = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('VERIFY'),
  });
  assert.equal(submitted.response.status, 201);
  const paymentId = submitted.body.data.payment.paymentId;

  const anon = await postJson(`/admin/payments/${paymentId}/verify`, {});
  assert.equal(anon.response.status, 401);

  const customer = await registerSession('mp-verify-cust');
  const asCustomer = await postJson(
    `/admin/payments/${paymentId}/verify`,
    {},
    { Cookie: customer.cookie }
  );
  assert.equal(asCustomer.response.status, 403);
  assert.equal(asCustomer.body.error.code, 'FORBIDDEN');

  assert.equal((await orderRow(order.id)).status, 'awaiting_payment');

  const admin = await adminSession();
  const adminId = await userIdByEmail(admin.email);
  const { response, body } = await postJson(
    `/admin/payments/${paymentId}/verify`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.payment.status, 'verified');
  assert.equal(body.data.orderStatus, 'paid');
  assert.equal(body.data.replayed, false);

  assert.equal((await orderRow(order.id)).status, 'paid');
  const row = await paymentRow(paymentId);
  assert.equal(row.status, 'successful');
  assert.ok(row.paid_at, 'paid_at stamped');
  assert.equal(row.metadata.verified_by, adminId);
  assert.ok(row.metadata.verified_at);
  assert.equal(
    row.provider_transaction_id,
    submitted.body.data.payment.transactionId
  );

  const successes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payment_transactions
     WHERE order_id = $1 AND status = 'successful'`,
    [order.id]
  );
  assert.equal(successes.rows[0].n, 1, 'exactly one paid row');
});

test('verify: replay is idempotent; wrong ids and wrong states are rejected', async () => {
  const { cookie } = await registerSession('mp-replay');
  const order = await createAwaitingOrder(cookie);
  const submitted = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('REPLAY'),
  });
  const paymentId = submitted.body.data.payment.paymentId;
  const admin = await adminSession();

  const first = await postJson(
    `/admin/payments/${paymentId}/verify`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(first.response.status, 200);

  const second = await postJson(
    `/admin/payments/${paymentId}/verify`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(second.response.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.data.replayed, true);
  assert.equal((await orderRow(order.id)).status, 'paid');

  const badUuid = await postJson(
    '/admin/payments/not-a-uuid/verify',
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(badUuid.response.status, 400);
  assert.equal(badUuid.body.error.code, 'VALIDATION_ERROR');

  const unknown = await postJson(
    '/admin/payments/00000000-0000-4000-8000-0000000000ff/verify',
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error.code, 'PAYMENT_NOT_FOUND');

  const unexpected = await postJson(
    `/admin/payments/${paymentId}/verify`,
    { amount: '1.00' },
    { Cookie: admin.cookie }
  );
  assert.equal(unexpected.response.status, 400);
  assert.match(unexpected.body.error.details.join(' '), /amount/);
});

test('verify: only manual pending rows — non-manual and rejected rows are refused', async () => {
  const { cookie } = await registerSession('mp-notmanual');
  const order = await createAwaitingOrder(cookie);

  // non-manual attempt row created directly (never a reviewable submission)
  const inserted = await pool.query(
    `INSERT INTO payment_transactions (order_id, user_id, provider, amount, currency, status)
     VALUES ($1, (SELECT user_id FROM orders WHERE id = $1), 'disabled', 10.00, 'BDT', 'initiated')
     RETURNING id`,
    [order.id]
  );
  const disabledPaymentId = inserted.rows[0].id;

  const submitted = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('NOTMANUAL'),
  });
  const manualPaymentId = submitted.body.data.payment.paymentId;

  const admin = await adminSession();

  const wrongProvider = await postJson(
    `/admin/payments/${disabledPaymentId}/verify`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(wrongProvider.response.status, 409);
  assert.equal(wrongProvider.body.error.code, 'PAYMENT_NOT_MANUAL');
  assert.equal((await orderRow(order.id)).status, 'awaiting_payment');

  const reject = await postJson(
    `/admin/payments/${manualPaymentId}/reject`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(reject.response.status, 200);

  const rejectAgain = await postJson(
    `/admin/payments/${manualPaymentId}/verify`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(rejectAgain.response.status, 409);
  assert.equal(rejectAgain.body.error.code, 'PAYMENT_STATE_CONFLICT');
  assert.equal((await orderRow(order.id)).status, 'awaiting_payment');
});

test('verify: an order already marked paid outside the flow → 409 ORDER_ALREADY_PAID', async () => {
  const { cookie } = await registerSession('mp-externally');
  const order = await createAwaitingOrder(cookie);
  const submitted = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('EXTERNAL'),
  });
  const paymentId = submitted.body.data.payment.paymentId;

  await pool.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [
    order.id,
  ]);

  const admin = await adminSession();
  const { response, body } = await postJson(
    `/admin/payments/${paymentId}/verify`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(response.status, 409);
  assert.equal(body.error.code, 'ORDER_ALREADY_PAID');

  const row = await paymentRow(paymentId);
  assert.equal(row.status, 'pending', 'no partial success persisted');
});

// ---------- Admin reject ----------

test('reject: anon 401 / customer 403 / admin 200 → failed row, order still awaiting', async () => {
  const { cookie } = await registerSession('mp-reject');
  const order = await createAwaitingOrder(cookie);
  const submitted = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('REJECT'),
  });
  const paymentId = submitted.body.data.payment.paymentId;

  const anon = await postJson(`/admin/payments/${paymentId}/reject`, {});
  assert.equal(anon.response.status, 401);

  const customer = await registerSession('mp-reject-cust');
  const asCustomer = await postJson(
    `/admin/payments/${paymentId}/reject`,
    {},
    { Cookie: customer.cookie }
  );
  assert.equal(asCustomer.response.status, 403);

  const admin = await adminSession();
  const adminId = await userIdByEmail(admin.email);
  const { response, body } = await postJson(
    `/admin/payments/${paymentId}/reject`,
    { reason: 'Amount did not match the order total' },
    { Cookie: admin.cookie }
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.payment.status, 'rejected');
  assert.equal(body.data.orderStatus, 'awaiting_payment');

  assert.equal((await orderRow(order.id)).status, 'awaiting_payment');
  const row = await paymentRow(paymentId);
  assert.equal(row.status, 'failed');
  assert.equal(row.metadata.rejected_by, adminId);
  assert.equal(
    row.metadata.rejection_reason,
    'Amount did not match the order total'
  );

  const again = await postJson(
    `/admin/payments/${paymentId}/reject`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(again.response.status, 409);
  assert.equal(again.body.error.code, 'PAYMENT_STATE_CONFLICT');
});

test('reject: after rejection the customer can submit a new Transaction ID', async () => {
  const { cookie } = await registerSession('mp-resubmit');
  const order = await createAwaitingOrder(cookie);
  const first = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('RESUBMIT-A'),
  });
  const firstId = first.body.data.payment.paymentId;

  const admin = await adminSession();
  const rejected = await postJson(
    `/admin/payments/${firstId}/reject`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(rejected.response.status, 200);

  const second = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('RESUBMIT-B'),
  });
  assert.equal(second.response.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.data.payment.status, 'awaiting_verification');
  assert.equal(await manualCountForOrder(order.id), 2, 'old row kept for audit');

  const old = await paymentRow(firstId);
  assert.equal(old.status, 'failed');
});

test('reject: reason validation and unexpected admin body fields → 400', async () => {
  const { cookie } = await registerSession('mp-reason');
  const order = await createAwaitingOrder(cookie);
  const submitted = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('REASON'),
  });
  const paymentId = submitted.body.data.payment.paymentId;
  const admin = await adminSession();

  const tooLong = await postJson(
    `/admin/payments/${paymentId}/reject`,
    { reason: 'x'.repeat(201) },
    { Cookie: admin.cookie }
  );
  assert.equal(tooLong.response.status, 400);

  const unexpected = await postJson(
    `/admin/payments/${paymentId}/reject`,
    { status: 'successful' },
    { Cookie: admin.cookie }
  );
  assert.equal(unexpected.response.status, 400);
  assert.match(unexpected.body.error.details.join(' '), /Unexpected field/);

  const ok = await postJson(
    `/admin/payments/${paymentId}/reject`,
    {},
    { Cookie: admin.cookie }
  );
  assert.equal(ok.response.status, 200, JSON.stringify(ok.body));
});

// ---------- No automatic verification ----------

test('automatic verification stays disabled: provider path still 503, state machine untouched', async () => {
  const config = require('../src/config');
  assert.equal(config.payments.provider, 'disabled');
  assert.equal(config.payments.bkash.enabled, false);

  const { cookie } = await registerSession('mp-auto');
  const order = await createAwaitingOrder(cookie);

  const createPayment = await postJson('/payments', { orderId: order.id }, {
    Cookie: cookie,
  });
  assert.equal(createPayment.response.status, 503);
  assert.equal(
    createPayment.body.error.code,
    'PAYMENT_PROVIDER_NOT_CONFIGURED'
  );

  const submitted = await submitTransaction(cookie, {
    orderId: order.id,
    transactionId: trx('NOAUTO'),
  });
  assert.equal(submitted.response.status, 201);

  // No callback endpoint can pay the order: unknown webhook → 404, and the
  // submission stays pending with the order awaiting payment.
  const webhook = await postJson('/payments/webhook/manual', {
    orderId: order.id,
    status: 'successful',
  });
  assert.equal(webhook.response.status, 404);

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await orderRow(order.id)).status, 'awaiting_payment');
  const { rows: manualRows } = await pool.query(
    `SELECT id FROM payment_transactions
     WHERE order_id = $1 AND provider = 'manual'`,
    [order.id]
  );
  assert.equal(manualRows.length, 1, 'exactly one manual submission');
  const row = await paymentRow(manualRows[0].id);
  assert.equal(row.status, 'pending', 'still awaiting admin review');
});

// ---------- Frontend / page contracts ----------

test('checkout ships the manual Transaction ID flow and keeps payment-field bans', async () => {
  const response = await fetch(`${BASE_URL}/checkout`);
  assert.equal(response.status, 200);
  const html = await response.text();

  for (const id of [
    'manual-payment',
    'manual-payment-form',
    'manual-payment-status',
    'manual-order-number',
    'manual-amount',
    'manual-receiver',
    'manual-receiver-note',
    'transaction-id',
    'submit-transaction',
    'payment-methods',
    'bkash-instructions',
    'proceed-payment',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes('placeholder="Enter your Transaction ID"'));
  // the copy wraps across lines in the source — compare on normalized text
  assert.ok(
    html.replace(/\s+/g, ' ').includes('until an admin verifies your payment')
  );
  assert.equal(/card number|cvv|iban|credit card number/i.test(html), false);
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
  assert.equal(/<style[\s>]/i.test(html), false);

  const js = fs.readFileSync(path.join(FRONTEND, 'js', 'checkout.js'), 'utf8');
  assert.ok(js.includes('"/api/payments/transaction-id"'));
  assert.ok(js.includes('awaiting admin verification'));
  assert.ok(!js.includes('until an admin verifies'));
  assert.equal(/payment (successful|confirmed|complete)/i.test(js), false);
  assert.equal(/mark\s+as\s+paid/i.test(js), false);
  assert.equal(/\/payment-success/.test(js), false, 'no redirect after submit');
});

test('dashboard exposes the order payment state and honest awaiting copy', async () => {
  const response = await fetch(`${BASE_URL}/dashboard`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('id="detail-payment-state"'));
  assert.ok(html.includes('until the admin verifies your payment'));

  const js = fs.readFileSync(path.join(FRONTEND, 'js', 'dashboard.js'), 'utf8');
  assert.ok(js.includes('MANUAL_PAYMENT_LABELS'));
  assert.ok(js.includes('/api/payments/order/'));
  assert.ok(js.includes('Awaiting admin verification'));
  assert.ok(js.includes('the admin verifies your payment.'));
  assert.equal(/mark\s+as\s+paid/i.test(js), false);
});

test('admin payments page: served clean, CSP-safe, linked from every admin nav', async () => {
  const response = await fetch(`${BASE_URL}/admin/payments`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  const html = await response.text();

  assert.ok(html.includes('id="admin-payments-tbody"'));
  assert.ok(html.includes('id="filter-status"'));
  assert.ok(html.includes('href="/admin/payments" aria-current="page"'));
  assert.ok(html.includes('href="/admin/css/admin.css"'));
  assert.ok(html.includes('name="robots" content="noindex, nofollow"'));
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
  assert.equal(/<style\b/i.test(html), false);
  assert.equal(/\sstyle\s*=/i.test(html), false);
  assert.equal(/\son[a-z]+\s*=\s*["']/i.test(html), false);

  const legacy = await fetch(`${BASE_URL}/admin/payments.html`, {
    redirect: 'manual',
  });
  assert.equal(legacy.status, 301);
  const loc = legacy.headers.get('location') || '';
  assert.ok(loc === '/admin/payments' || loc.endsWith('/admin/payments'), loc);

  for (const file of [
    'dashboard.html',
    'orders.html',
    'order-detail.html',
    'customers.html',
    'customer-detail.html',
    'payments.html',
  ]) {
    const page = fs.readFileSync(path.join(FRONTEND_ADMIN, file), 'utf8');
    assert.ok(page.includes('href="/admin/payments"'), `${file} nav link`);
    assert.equal(
      (page.match(/class="admin-nav-item is-disabled" aria-disabled="true"/g) ||
        []).length,
      3,
      `${file} disabled nav count (Services/Support/Settings only)`
    );
    assert.equal(/<script(?![^>]*\bsrc=)/i.test(page), false, file);
    assert.equal(/<style\b/i.test(page), false, file);
    assert.equal(/\son[a-z]+\s*=\s*["']/i.test(page), false, file);
  }

  const adminJs = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js', 'admin-payments.js'),
    'utf8'
  );
  assert.ok(adminJs.includes('/api/admin/payments'));
  assert.ok(adminJs.includes('"verify"') || adminJs.includes("'verify'"));
  assert.equal(/innerHTML\s*=/.test(adminJs), false);
  assert.equal(/["'](login|dashboard|orders|customers|index)\.html/.test(adminJs), false);
  assert.ok(/FlareAdmin|credentials:\s*["']include["']/.test(adminJs));

  const appSrc = fs.readFileSync(APP_JS, 'utf8');
  assert.ok(appSrc.includes("'/admin/payments': 'admin/payments.html'"));
  assert.ok(appSrc.includes("'/admin/payments.html': '/admin/payments'"));
});
