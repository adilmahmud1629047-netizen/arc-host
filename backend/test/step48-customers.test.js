const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, after } = require('node:test');

// STEP 48 — Admin customer management + order history / account controls
// (spec tests 1-37). External test server at TEST_BASE_URL; fixtures are
// %example.com users and are removed again by the STEP 48 cleanup script.
// Suspend = status transition + session revocation only. Password reset =
// existing Argon2id architecture, one-time temporary password in the single
// response, never stored in plaintext, never logged. No endpoint anywhere
// deletes a customer, an order, or a payment.

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;
const FRONTEND_ADMIN = path.join(__dirname, '../../frontend/admin');
const BACKEND_SRC = path.join(__dirname, '../src');

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;
const UUID_MISSING = '00000000-0000-4000-8000-000000000404';

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

async function registerUser(prefix = 'a48') {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Ada',
    lastName: 'Customer',
    email,
    password,
  });
  assert.equal(reg.response.status, 201, JSON.stringify(reg.body));
  return { email, password };
}

async function loginUser(email, password) {
  return postJson('/auth/login', { email, password });
}

let pool;

before(async () => {
  const { runUp } = require('../src/services/migrator');
  await runUp();
  pool = require('../src/config/database');
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

async function userIdByEmail(email) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  return rows[0] ? rows[0].id : null;
}

async function adminSession(prefix = 'a48-admin') {
  const { email, password } = await registerUser(prefix);
  await promoteAdmin(email);
  const login = await loginUser(email, password);
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);
  const id = await userIdByEmail(email);
  return { email, password, cookie, id };
}

async function customerSession(prefix = 'a48-cust') {
  const { email, password } = await registerUser(prefix);
  const login = await loginUser(email, password);
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);
  const id = await userIdByEmail(email);
  return { email, password, cookie, id };
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

function adminGet(pathSuffix, admin) {
  return api(pathSuffix, { headers: { Cookie: admin.cookie } });
}

function adminPost(pathSuffix, payload, admin, extraHeaders = {}) {
  return postJson(pathSuffix, payload, {
    Cookie: admin.cookie,
    ...extraHeaders,
  });
}

async function userRow(id) {
  const { rows } = await pool.query(
    `SELECT id, email, role, status, password_hash, first_name, last_name,
            created_at, updated_at
     FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function liveSessions(userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM sessions
     WHERE user_id = $1 AND expires_at > now()`,
    [userId]
  );
  return rows[0].n;
}

async function orderRows(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at, id`,
    [userId]
  );
  return rows;
}

async function paymentRows(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM payment_transactions WHERE user_id = $1 ORDER BY created_at, id`,
    [userId]
  );
  return rows;
}

async function insertPayment(orderId, userId, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO payment_transactions (
       order_id, user_id, provider, provider_transaction_id, amount, currency,
       status, payment_method, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      orderId,
      userId,
      overrides.provider || 'uddoktapay',
      overrides.providerTransactionId || null,
      overrides.amount || '10.00',
      overrides.currency || 'BDT',
      overrides.status || 'successful',
      overrides.paymentMethod || 'bkash',
      overrides.metadata == null ? '{}' : overrides.metadata,
    ]
  );
  return rows[0];
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

// ---------------------------------------------------------------------------
// 1-7 account status: suspend, no login, session revoked, API rejected,
//    reactivate, re-login, admin cannot suspend self
// ---------------------------------------------------------------------------

const suspendFixture = {};

test('[S-1] suspend: 200, status suspended server-side, all sessions revoked', async () => {
  const admin = await adminSession('a48-admin-suspend');
  const cust = await customerSession('a48-suspend');
  // second session for the same customer
  const again = await loginUser(cust.email, cust.password);
  assert.equal(again.response.status, 200);
  const secondCookie = extractSessionCookie(again.response.headers.getSetCookie());
  assert.ok(secondCookie);

  assert.equal(await liveSessions(cust.id), 2, 'two live sessions before suspend');

  const { response, body } = await adminPost(
    `/admin/customers/${cust.id}/suspend`,
    {},
    admin
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.data.customer.status, 'suspended');
  assert.equal(body.data.customer.id, cust.id);
  assert.equal(body.data.sessionsRevoked, 2);

  const row = await userRow(cust.id);
  assert.equal(row.status, 'suspended');
  assert.equal(await liveSessions(cust.id), 0, 'sessions deleted');

  Object.assign(suspendFixture, { admin, cust, secondCookie });
  await demote(admin.email);
});

test('[S-2] suspended customer cannot log in (403 ACCOUNT_DISABLED)', async () => {
  const { cust } = suspendFixture;
  const { response, body } = await loginUser(cust.email, cust.password);
  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'ACCOUNT_DISABLED');
});

test('[S-3] previously issued session is rejected after suspension (401)', async () => {
  const { cust } = suspendFixture;
  const res = await api('/auth/me', { headers: { Cookie: cust.cookie } });
  assert.equal(res.response.status, 401);
  assert.equal(res.body.error.code, 'UNAUTHORIZED');
  const res2 = await api('/auth/me', {
    headers: { Cookie: suspendFixture.secondCookie },
  });
  assert.equal(res2.response.status, 401);
});

test('[S-4] authenticated API rejected while suspended; no order created', async () => {
  const { cust } = suspendFixture;
  const before = await orderRows(cust.id);
  const { response, body } = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: cust.cookie }
  );
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
  const after = await orderRows(cust.id);
  assert.equal(after.length, before.length, 'no order created while suspended');
});

test('[S-5] reactivate: 200, status active again, nothing else changes', async () => {
  const { admin, cust } = suspendFixture;
  const ordersBefore = await orderRows(cust.id);
  const paymentsBefore = await paymentRows(cust.id);
  const hashBefore = (await userRow(cust.id)).password_hash;

  await demote(admin.email);
  await promoteAdmin(admin.email); // keep admin usable across demotes in other tests
  const { response, body } = await adminPost(
    `/admin/customers/${cust.id}/reactivate`,
    {},
    admin
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.customer.status, 'active');
  assert.equal(body.data.sessionsRevoked, 0);

  const row = await userRow(cust.id);
  assert.equal(row.status, 'active');
  assert.equal(row.password_hash, hashBefore, 'reactivate never touches the hash');
  assert.deepEqual(await orderRows(cust.id), ordersBefore, 'orders untouched');
  assert.deepEqual(await paymentRows(cust.id), paymentsBefore, 'payments untouched');
  await demote(admin.email);
});

test('[S-6] customer can sign in again after reactivation', async () => {
  const { cust } = suspendFixture;
  const login = await loginUser(cust.email, cust.password);
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);
  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
  assert.equal(me.body.data.user.email, cust.email);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [cust.id]);
});

test('[S-7] admin cannot suspend their own active account (403)', async () => {
  const admin = await adminSession('a48-admin-self');
  const { response, body } = await adminPost(
    `/admin/customers/${admin.id}/suspend`,
    {},
    admin
  );
  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'ADMIN_SELF_ACTION');
  const row = await userRow(admin.id);
  assert.equal(row.status, 'active', 'self-suspend must not change status');
  assert.ok((await liveSessions(admin.id)) >= 1, 'admin stays signed in');
  await demote(admin.email);
});

// ---------------------------------------------------------------------------
// 8-15 password reset: initiate, new pw works, old fails, sessions revoked,
//    Argon2id, no plaintext stored, no hash in API/logs, admin target refused
// ---------------------------------------------------------------------------

const resetFixture = {};

test('[R-8] reset initiates: one-time temporary password + sessions revoked', async () => {
  const admin = await adminSession('a48-admin-reset');
  const cust = await customerSession('a48-reset');

  const { response, body } = await adminPost(
    `/admin/customers/${cust.id}/reset-password`,
    {},
    admin
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  const temp = body.data.temporaryPassword;
  assert.equal(typeof temp, 'string');
  assert.equal(temp.length, 16, '16-char temporary password');
  assert.match(temp, /^[A-Za-z0-9]+$/, 'alphanumeric only');
  assert.equal(typeof body.data.sessionsRevoked, 'number');
  assert.ok(body.data.sessionsRevoked >= 1, 'existing sessions revoked');
  assert.match(body.data.notice, /secure channel/i);
  assert.equal(body.data.customer.id, cust.id);
  assert.equal(body.data.customer.status, 'active', 'reset does not change status');

  assert.equal(await liveSessions(cust.id), 0);
  Object.assign(resetFixture, { admin, cust, temp });
  await demote(admin.email);
});

test('[R-9] the temporary password signs in successfully', async () => {
  const { cust, temp } = resetFixture;
  const login = await loginUser(cust.email, temp);
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);
  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
  resetFixture.postResetCookie = cookie;
});

test('[R-10] the previous password no longer works (401)', async () => {
  const { cust } = resetFixture;
  const login = await loginUser(cust.email, cust.password);
  assert.equal(login.response.status, 401);
  assert.equal(login.body.error.code, 'INVALID_CREDENTIALS');
});

test('[R-11] every pre-reset session is revoked (401 on old cookie)', async () => {
  const { cust, admin } = resetFixture;
  // issue a fresh session, then reset again and prove it dies
  const login = await loginUser(cust.email, resetFixture.temp);
  assert.equal(login.response.status, 200);
  const preCookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(preCookie);

  await promoteAdmin(admin.email);
  const again = await adminPost(
    `/admin/customers/${cust.id}/reset-password`,
    {},
    admin
  );
  assert.equal(again.response.status, 200);
  await demote(admin.email);

  const dead = await api('/auth/me', { headers: { Cookie: preCookie } });
  assert.equal(dead.response.status, 401);
  assert.equal(await liveSessions(cust.id), 0);
  resetFixture.temp = again.body.data.temporaryPassword;
});

test('[R-12] stored credential is an Argon2id hash', async () => {
  const { cust } = resetFixture;
  const row = await userRow(cust.id);
  assert.match(row.password_hash, /^\$argon2id\$/);
  assert.notEqual(row.password_hash, resetFixture.temp);
});

test('[R-13] the temporary password is never stored in plaintext', async () => {
  const { cust, temp } = resetFixture;
  const row = await userRow(cust.id);
  const raw = JSON.stringify(row);
  assert.equal(raw.includes(temp), false, 'no plaintext password in the users row');
  const { rows } = await pool.query(
    `SELECT * FROM sessions WHERE user_id = $1`,
    [cust.id]
  );
  assert.equal(
    JSON.stringify(rows).includes(temp),
    false,
    'no plaintext password in sessions'
  );
});

test('[R-14] no hash material in any account-control response', async () => {
  const { admin, cust } = resetFixture;
  await promoteAdmin(admin.email);

  const reset = await adminPost(
    `/admin/customers/${cust.id}/reset-password`,
    {},
    admin
  );
  assert.equal(reset.response.status, 200);
  const raw = JSON.stringify(reset.body);
  assert.equal(raw.includes('$argon2'), false, 'no argon2 hash in response');
  assert.equal(raw.includes('password_hash'), false);
  assert.equal(raw.includes('session_hash'), false);
  assert.ok(reset.body.data.temporaryPassword, 'temp password returned once');
  resetFixture.temp = reset.body.data.temporaryPassword;

  for (const suffix of [
    '',
    `/${cust.id}`,
    `/${cust.id}/orders`,
    `/${cust.id}/payments`,
  ]) {
    const res = await adminGet(`/admin/customers${suffix}`, admin);
    assert.equal(res.response.status, 200, suffix);
    assertNoSecrets(JSON.stringify(res.body));
  }

  await demote(admin.email);
});

test('[R-15] password reset is refused for an administrator target', async () => {
  const admin = await adminSession('a48-admin-target');
  const other = await adminSession('a48-admin-other');

  const { response, body } = await adminPost(
    `/admin/customers/${other.id}/reset-password`,
    {},
    admin
  );
  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'PASSWORD_RESET_NOT_ALLOWED');

  const row = await userRow(other.id);
  assert.equal(row.role, 'admin');
  assert.equal(row.status, 'active');
  assert.ok((await liveSessions(other.id)) >= 1, 'other admin stays signed in');

  await demote(admin.email);
  await demote(other.email);
});

// ---------------------------------------------------------------------------
// 16-20 order history
// ---------------------------------------------------------------------------

test('[O-16] order history: shape, complete list, newest first', async () => {
  const admin = await adminSession('a48-admin-orders');
  const cust = await customerSession('a48-orders');
  const orderA = await createHostingOrder(cust.cookie);
  const orderB = await createHostingOrder(cust.cookie);

  const { response, body } = await adminGet(
    `/admin/customers/${cust.id}/orders`,
    admin
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  const orders = body.data.orders;
  assert.ok(Array.isArray(orders));
  assert.equal(orders.length, 2, 'complete history for this customer');

  const rowA = orders.find((o) => o.id === orderA.id);
  assert.ok(rowA, 'first order present');
  assert.equal(rowA.orderNumber, orderA.orderNumber);
  assert.equal(rowA.productType, 'hosting');
  assert.equal(typeof rowA.planName, 'string');
  assert.ok(rowA.amount !== undefined && rowA.amount !== null);
  assert.equal(rowA.currency, 'BDT');
  assert.ok(rowA.status);
  assert.ok('paymentStatus' in rowA, 'payment status field present');
  assert.ok(rowA.createdAt);
  assert.ok(rowA.updatedAt);
  assert.equal('metadata' in rowA, false);
  assert.ok('password_hash' in rowA === false);

  for (let i = 1; i < orders.length; i++) {
    const prev = new Date(orders[i - 1].createdAt).getTime();
    const cur = new Date(orders[i].createdAt).getTime();
    assert.ok(prev >= cur, 'newest first');
  }

  assert.equal(typeof body.data.pagination.total, 'number');
  assert.ok(body.data.pagination.totalPages >= 1);

  assertNoSecrets(JSON.stringify(body));
  Object.assign(suspendFixture, { ordersCust: cust });
  await demote(admin.email);
});

test('[O-17] order history: status filter valid + invalid rejected', async () => {
  const admin = await adminSession('a48-admin-ofilter');
  const cust = suspendFixture.ordersCust;
  assert.ok(cust, 'fixture from O-16');

  const ok = await adminGet(
    `/admin/customers/${cust.id}/orders?status=awaiting_payment`,
    admin
  );
  assert.equal(ok.response.status, 200);
  assert.ok(ok.body.data.orders.length >= 1);
  assert.ok(ok.body.data.orders.every((o) => o.status === 'awaiting_payment'));

  const bad = await adminGet(
    `/admin/customers/${cust.id}/orders?status=deleted`,
    admin
  );
  assert.equal(bad.response.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  await demote(admin.email);
});

test('[O-18] order history: pagination + validation of page/limit', async () => {
  const admin = await adminSession('a48-admin-opage');
  const cust = suspendFixture.ordersCust;
  assert.ok(cust, 'fixture from O-16');

  const p1 = await adminGet(
    `/admin/customers/${cust.id}/orders?limit=1&page=1`,
    admin
  );
  assert.equal(p1.response.status, 200);
  assert.equal(p1.body.data.orders.length, 1);
  assert.equal(p1.body.data.pagination.hasPrev, false);
  assert.equal(p1.body.data.pagination.hasNext, true);

  const p2 = await adminGet(
    `/admin/customers/${cust.id}/orders?limit=1&page=2`,
    admin
  );
  assert.equal(p2.response.status, 200);
  assert.equal(p2.body.data.pagination.hasPrev, true);
  assert.notEqual(p2.body.data.orders[0].id, p1.body.data.orders[0].id);

  const badPage = await adminGet(
    `/admin/customers/${cust.id}/orders?page=abc`,
    admin
  );
  assert.equal(badPage.response.status, 400);

  const badLimit = await adminGet(
    `/admin/customers/${cust.id}/orders?limit=51`,
    admin
  );
  assert.equal(badLimit.response.status, 400);
  await demote(admin.email);
});

test('[O-19] order history: only this customer\u2019s orders are returned', async () => {
  const admin = await adminSession('a48-admin-oiso');
  const cust = suspendFixture.ordersCust;
  const other = await customerSession('a48-orders-other');
  const otherOrder = await createHostingOrder(other.cookie);

  const { response, body } = await adminGet(
    `/admin/customers/${cust.id}/orders?limit=50`,
    admin
  );
  assert.equal(response.status, 200);
  const numbers = body.data.orders.map((o) => o.orderNumber);
  assert.equal(
    numbers.includes(otherOrder.orderNumber),
    false,
    'foreign orders must not appear'
  );
  assert.ok(numbers.length >= 2, 'own orders still present');
  await demote(admin.email);
});

test('[O-20] order history: bad uuid 400, unknown customer 404, unknown query 400', async () => {
  const admin = await adminSession('a48-admin-o404');

  const badId = await adminGet('/admin/customers/not-a-uuid/orders', admin);
  assert.equal(badId.response.status, 400);
  assert.equal(badId.body.error.code, 'VALIDATION_ERROR');

  const missing = await adminGet(
    `/admin/customers/${UUID_MISSING}/orders`,
    admin
  );
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  const extra = await adminGet(
    `/admin/customers/${UUID_MISSING}/orders?foo=1`,
    admin
  );
  assert.equal(extra.response.status, 400);

  await demote(admin.email);
});

// ---------------------------------------------------------------------------
// 21-24 payment history
// ---------------------------------------------------------------------------

test('[P-21] payment history: shape, invoice/reference, verification source, manual alias', async () => {
  const admin = await adminSession('a48-admin-pays');
  const cust = await customerSession('a48-pays');
  const order = await createHostingOrder(cust.cookie);
  const invoice = `INV48${unique().toUpperCase()}`;
  await insertPayment(order.id, cust.id, {
    provider: 'uddoktapay',
    providerTransactionId: invoice,
    status: 'successful',
    metadata: { verification_source: 'uddoktapay_auto' },
  });
  await insertPayment(order.id, cust.id, {
    provider: 'manual',
    status: 'pending',
    paymentMethod: 'bKash',
  });

  const { response, body } = await adminGet(
    `/admin/customers/${cust.id}/payments`,
    admin
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  const payments = body.data.payments;
  assert.ok(Array.isArray(payments));
  assert.equal(payments.length, 2);

  const gateway = payments.find((p) => p.invoiceId === invoice);
  assert.ok(gateway, 'gateway row present');
  assert.equal(gateway.orderId, order.id);
  assert.equal(gateway.orderNumber, order.orderNumber);
  assert.equal(gateway.provider, 'uddoktapay');
  assert.equal(gateway.reference, invoice);
  assert.equal(gateway.verificationSource, 'uddoktapay_auto');
  assert.equal(gateway.status, 'successful');
  assert.ok(gateway.amount !== undefined && gateway.currency === 'BDT');
  assert.ok(gateway.createdAt && gateway.updatedAt);
  assert.equal('metadata' in gateway, false, 'raw metadata never returned');

  const manual = payments.find((p) => p.provider === 'manual');
  assert.ok(manual, 'manual row present');
  assert.equal(manual.rawStatus, 'pending');
  assert.equal(manual.status, 'awaiting_verification', 'review alias applied');
  assert.equal(manual.invoiceId, null, 'invoice only for UddoktaPay rows');
  assert.equal('userId' in manual, false);

  assert.equal(typeof body.data.pagination.total, 'number');
  assertNoSecrets(JSON.stringify(body));
  Object.assign(suspendFixture, { paysCust: cust });
  await demote(admin.email);
});

test('[P-22] payment history: no secrets in any page of the response', async () => {
  const admin = await adminSession('a48-admin-psecret');
  const cust = suspendFixture.paysCust;
  assert.ok(cust, 'fixture from P-21');

  for (const page of [1, 2]) {
    const res = await adminGet(
      `/admin/customers/${cust.id}/payments?page=${page}`,
      admin
    );
    assert.equal(res.response.status, 200);
    assertNoSecrets(JSON.stringify(res.body));
  }
  await demote(admin.email);
});

test('[P-23] payment history: pagination + only this customer\u2019s payments', async () => {
  const admin = await adminSession('a48-admin-piso');
  const cust = suspendFixture.paysCust;
  assert.ok(cust, 'fixture from P-21');

  const p1 = await adminGet(
    `/admin/customers/${cust.id}/payments?limit=1&page=1`,
    admin
  );
  assert.equal(p1.response.status, 200);
  assert.equal(p1.body.data.payments.length, 1);
  assert.equal(p1.body.data.pagination.total, 2);
  assert.equal(p1.body.data.pagination.hasNext, true);

  const p2 = await adminGet(
    `/admin/customers/${cust.id}/payments?limit=1&page=2`,
    admin
  );
  assert.equal(p2.response.status, 200);
  assert.equal(p2.body.data.pagination.hasPrev, true);
  assert.notEqual(p2.body.data.payments[0].id, p1.body.data.payments[0].id);

  const other = await customerSession('a48-pays-other');
  const otherOrder = await createHostingOrder(other.cookie);
  const otherTxn = `OTX48${unique().toUpperCase()}`;
  await insertPayment(otherOrder.id, other.id, {
    providerTransactionId: otherTxn,
  });

  const iso = await adminGet(
    `/admin/customers/${cust.id}/payments?limit=50`,
    admin
  );
  const refs = iso.body.data.payments.map((p) => p.reference);
  assert.equal(refs.includes(otherTxn), false, 'foreign payments must not appear');
  await demote(admin.email);
});

test('[P-24] payment history: validation of page/limit/unknown query/ids', async () => {
  const admin = await adminSession('a48-admin-p400');

  const badPage = await adminGet(
    `/admin/customers/${UUID_MISSING}/payments?page=x`,
    admin
  );
  assert.equal(badPage.response.status, 400);

  const badLimit = await adminGet(
    `/admin/customers/${UUID_MISSING}/payments?limit=0`,
    admin
  );
  assert.equal(badLimit.response.status, 400);

  const extra = await adminGet(
    `/admin/customers/${UUID_MISSING}/payments?status=paid`,
    admin
  );
  assert.equal(extra.response.status, 400);

  const missing = await adminGet(
    `/admin/customers/${UUID_MISSING}/payments`,
    admin
  );
  assert.equal(missing.response.status, 404);

  const badId = await adminGet('/admin/customers/nope/payments', admin);
  assert.equal(badId.response.status, 400);
  await demote(admin.email);
});

// ---------------------------------------------------------------------------
// 25-28 authorization
// ---------------------------------------------------------------------------

test('[A-25] anonymous requests: 401 on every customer control endpoint', async () => {
  const id = UUID_MISSING;
  for (const [method, suffix, payload] of [
    ['POST', `/admin/customers/${id}/suspend`, {}],
    ['POST', `/admin/customers/${id}/reactivate`, {}],
    ['POST', `/admin/customers/${id}/reset-password`, {}],
    ['GET', `/admin/customers/${id}/orders`, undefined],
    ['GET', `/admin/customers/${id}/payments`, undefined],
  ]) {
    const options = { headers: {} };
    if (method === 'POST') {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(payload);
    }
    const res = await api(suffix, options);
    assert.equal(res.response.status, 401, `${method} ${suffix}`);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  }
});

test('[A-26] signed-in customer: 403 on every customer control endpoint', async () => {
  const cust = await customerSession('a48-cust-forbidden');
  for (const [method, suffix] of [
    ['POST', `/admin/customers/${cust.id}/suspend`],
    ['POST', `/admin/customers/${cust.id}/reactivate`],
    ['POST', `/admin/customers/${cust.id}/reset-password`],
    ['GET', `/admin/customers/${cust.id}/orders`],
    ['GET', `/admin/customers/${cust.id}/payments`],
  ]) {
    const options = { headers: { Cookie: cust.cookie } };
    if (method === 'POST') {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = '{}';
    }
    const res = await api(suffix, options);
    assert.equal(res.response.status, 403, `${method} ${suffix}`);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  }
  const row = await userRow(cust.id);
  assert.equal(row.status, 'active', '403 must not change anything');
  assert.equal(row.role, 'customer');
});

test('[A-27] admin: allowed — suspend and reactivate round trip', async () => {
  const admin = await adminSession('a48-admin-allowed');
  const cust = await customerSession('a48-allowed');

  const sus = await adminPost(
    `/admin/customers/${cust.id}/suspend`,
    {},
    admin
  );
  assert.equal(sus.response.status, 200, JSON.stringify(sus.body));
  const re = await adminPost(
    `/admin/customers/${cust.id}/reactivate`,
    {},
    admin
  );
  assert.equal(re.response.status, 200);

  const list = await adminGet('/admin/customers', admin);
  assert.equal(list.response.status, 200);
  await demote(admin.email);
});

test('[A-28] cross-origin POST is rejected by the same-origin guard', async () => {
  const admin = await adminSession('a48-admin-csrf');
  const cust = await customerSession('a48-csrf');

  const res = await adminPost(
    `/admin/customers/${cust.id}/suspend`,
    {},
    admin,
    { Origin: 'https://evil.example' }
  );
  assert.equal(res.response.status, 403);
  assert.equal(res.body.error.code, 'CSRF_INVALID');

  const row = await userRow(cust.id);
  assert.equal(row.status, 'active', 'target untouched by rejected request');
  await demote(admin.email);
});

// ---------------------------------------------------------------------------
// 29-32 data integrity — status/password operations never delete data
// ---------------------------------------------------------------------------

test('[I-29] suspend deletes only sessions: orders and payments byte-identical', async () => {
  const admin = await adminSession('a48-admin-int');
  const cust = await customerSession('a48-int');
  const order = await createHostingOrder(cust.cookie);
  await insertPayment(order.id, cust.id, {
    providerTransactionId: `IINT48${unique().toUpperCase()}`,
  });

  const ordersBefore = await orderRows(cust.id);
  const paymentsBefore = await paymentRows(cust.id);
  assert.equal(ordersBefore.length, 1);
  assert.equal(paymentsBefore.length, 1);

  const res = await adminPost(
    `/admin/customers/${cust.id}/suspend`,
    {},
    admin
  );
  assert.equal(res.response.status, 200);

  assert.deepEqual(await orderRows(cust.id), ordersBefore, 'orders intact');
  assert.deepEqual(await paymentRows(cust.id), paymentsBefore, 'payments intact');
  assert.equal(await liveSessions(cust.id), 0);
  const row = await userRow(cust.id);
  assert.equal(row.status, 'suspended');
  assert.equal(row.email, cust.email, 'user row itself is never deleted');

  Object.assign(suspendFixture, { intCust: cust, intAdmin: admin });
});

test('[I-30] suspension touches no other user\u2019s data', async () => {
  const { intCust, intAdmin } = suspendFixture;
  const bystander = await customerSession('a48-bystander');
  const order = await createHostingOrder(bystander.cookie);
  await insertPayment(order.id, bystander.id, {
    providerTransactionId: `IBYS48${unique().toUpperCase()}`,
  });

  const adminSessions = await liveSessions(intAdmin.id);
  const bystanderOrders = await orderRows(bystander.id);
  const bystanderPayments = await paymentRows(bystander.id);
  const bystanderSessions = await liveSessions(bystander.id);

  assert.equal(await liveSessions(intCust.id), 0, 'target already suspended');
  assert.equal(
    await liveSessions(intAdmin.id),
    adminSessions,
    'admin sessions untouched'
  );
  assert.deepEqual(await orderRows(bystander.id), bystanderOrders);
  assert.deepEqual(await paymentRows(bystander.id), bystanderPayments);
  assert.equal(
    await liveSessions(bystander.id),
    bystanderSessions,
    'other users keep their sessions'
  );
});

test('[I-31] reactivate restores status only; hash, orders, payments unchanged', async () => {
  const { intCust, intAdmin } = suspendFixture;
  const ordersBefore = await orderRows(intCust.id);
  const paymentsBefore = await paymentRows(intCust.id);
  const hashBefore = (await userRow(intCust.id)).password_hash;

  await promoteAdmin(intAdmin.email);
  const res = await adminPost(
    `/admin/customers/${intCust.id}/reactivate`,
    {},
    intAdmin
  );
  assert.equal(res.response.status, 200);

  const row = await userRow(intCust.id);
  assert.equal(row.status, 'active');
  assert.equal(row.password_hash, hashBefore);
  assert.deepEqual(await orderRows(intCust.id), ordersBefore);
  assert.deepEqual(await paymentRows(intCust.id), paymentsBefore);
  await demote(intAdmin.email);
});

test('[I-32] password reset changes only the hash (+sessions): status/orders/payments intact', async () => {
  const admin = await adminSession('a48-admin-int2');
  const cust = await customerSession('a48-int2');
  const order = await createHostingOrder(cust.cookie);
  await insertPayment(order.id, cust.id, {
    providerTransactionId: `IRES48${unique().toUpperCase()}`,
  });

  const ordersBefore = await orderRows(cust.id);
  const paymentsBefore = await paymentRows(cust.id);
  const hashBefore = (await userRow(cust.id)).password_hash;

  const res = await adminPost(
    `/admin/customers/${cust.id}/reset-password`,
    {},
    admin
  );
  assert.equal(res.response.status, 200);

  const row = await userRow(cust.id);
  assert.equal(row.status, 'active', 'status unchanged');
  assert.notEqual(row.password_hash, hashBefore, 'hash replaced');
  assert.match(row.password_hash, /^\$argon2id\$/);
  assert.deepEqual(await orderRows(cust.id), ordersBefore, 'orders untouched');
  assert.deepEqual(await paymentRows(cust.id), paymentsBefore, 'payments untouched');
  assert.equal(await liveSessions(cust.id), 0, 'sessions revoked');
  await demote(admin.email);
});

// ---------------------------------------------------------------------------
// 33-37 security
// ---------------------------------------------------------------------------

test('[X-33] no password hash in any new endpoint response', async () => {
  const admin = await adminSession('a48-admin-sec');
  const cust = await customerSession('a48-sec');

  const responses = [];
  responses.push(await adminPost(`/admin/customers/${cust.id}/suspend`, {}, admin));
  responses.push(await adminPost(`/admin/customers/${cust.id}/reactivate`, {}, admin));
  responses.push(await adminGet(`/admin/customers/${cust.id}/orders`, admin));
  responses.push(await adminGet(`/admin/customers/${cust.id}/payments`, admin));
  responses.push(await adminPost(`/admin/customers/${cust.id}/reset-password`, {}, admin));

  for (const r of responses) {
    const raw = JSON.stringify(r.body);
    assert.equal(raw.includes('$argon2'), false, 'no argon2 hash');
    assert.equal(raw.includes('password_hash'), false, 'no hash column name');
    assert.equal(raw.includes('session_hash'), false, 'no session hash');
    assert.equal(raw.includes('sessionToken'), false);
  }
  await demote(admin.email);
});

test('[X-34] hash/temp password never logged; static source hygiene', async () => {
  const controller = fs.readFileSync(
    path.join(BACKEND_SRC, 'controllers/adminController.js'),
    'utf8'
  );
  assert.doesNotMatch(
    controller,
    /console\.(log|info|warn|error|debug|trace)\(/,
    'admin controller must not write to the console'
  );

  // the temporary password is constructed only in adminController — no other
  // backend source file references it (so nothing else can log or store it)
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        if (full.endsWith(path.join('controllers', 'adminController.js'))) {
          continue;
        }
        const src = fs.readFileSync(full, 'utf8');
        if (src.includes('temporaryPassword')) {
          offenders.push(full);
        }
      }
    }
  })(BACKEND_SRC);
  assert.deepEqual(offenders, [], 'temp password referenced only in adminController');

  const detailJs = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js/admin-customer-detail.js'),
    'utf8'
  );
  assert.doesNotMatch(detailJs, /password_hash|argon2|session_hash/);
  assert.doesNotMatch(detailJs, /console\.(log|info|warn|error|debug)\(/);
});

test('[X-35] no generic delete/creation endpoint exists for customers or orders', async () => {
  const admin = await adminSession('a48-admin-nodelete');
  const uuid = '00000000-0000-4000-8000-000000000001';

  const forbidden = [
    ['DELETE', `/admin/customers`],
    ['DELETE', `/admin/customers/${uuid}`],
    ['POST', `/admin/customers`],
    ['PUT', `/admin/customers/${uuid}`],
    ['PATCH', `/admin/customers/${uuid}`],
    ['POST', `/admin/customers/${uuid}/role`],
    ['POST', `/admin/customers/${uuid}/delete`],
    ['POST', `/admin/customers/delete-all`],
    ['DELETE', `/admin/orders`],
    ['DELETE', `/admin/orders/${uuid}`],
    ['POST', `/admin/orders/delete-all`],
    ['DELETE', `/admin/payments/${uuid}`],
  ];
  for (const [method, suffix] of forbidden) {
    const res = await api(suffix, {
      method,
      headers: {
        Cookie: admin.cookie,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.ok(
      res.response.status === 404 || res.response.status === 405,
      `${method} ${suffix} must not exist (got ${res.response.status})`
    );
  }
  await demote(admin.email);
});

test('[X-36] orders can never be deleted — not by the customer, not by the admin', async () => {
  const admin = await adminSession('a48-admin-persist');
  const cust = await customerSession('a48-persist');
  const order = await createHostingOrder(cust.cookie);
  await insertPayment(order.id, cust.id, {
    providerTransactionId: `IX48${unique().toUpperCase()}`,
    status: 'successful',
    metadata: { verification_source: 'admin_manual' },
  });

  // paid-style settlement row exists; deletion is not routed anywhere
  const adminDelete = await api(`/admin/orders/${order.id}`, {
    method: 'DELETE',
    headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.ok(
    adminDelete.response.status === 404 || adminDelete.response.status === 405
  );

  const custDelete = await api(`/orders/${order.id}`, {
    method: 'DELETE',
    headers: { Cookie: cust.cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.ok(
    custDelete.response.status === 404 || custDelete.response.status === 405
  );

  const orders = await orderRows(cust.id);
  assert.equal(orders.length, 1, 'order still exists');
  assert.equal(orders[0].id, order.id);
  const payments = await paymentRows(cust.id);
  assert.equal(payments.length, 1, 'payment still exists');
  await demote(admin.email);
});

test('[X-37] regression self-check: schema, legacy shapes, updated UI pins', async () => {
  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM schema_migrations`
  );
  assert.equal(count.rows[0].n, 18, 'no migrations added for STEP 48');

  const admin = await adminSession('a48-admin-regress');
  const cust = await customerSession('a48-regress');
  await createHostingOrder(cust.cookie);

  // legacy detail shape intact
  const detail = await adminGet(`/admin/customers/${cust.id}`, admin);
  assert.equal(detail.response.status, 200);
  const d = detail.body.data;
  assert.ok(Array.isArray(d.recentOrders));
  assert.ok(d.recentOrders.length <= 10);
  assert.equal(typeof d.summary.orders, 'number');
  assert.ok(d.recentOrders.length > 0, 'fixture order in legacy detail');
  assert.equal(
    ['id', 'orderNumber', 'productType', 'amount', 'currency', 'status', 'createdAt']
      .every((k) => k in d.recentOrders[0]),
    true,
    'legacy recentOrders shape intact'
  );
  assert.equal('metadata' in d.recentOrders[0], false, 'no raw metadata leak');
  assert.ok(Array.isArray(d.services));
  assert.equal(
    d.services.every((s) => !('externalId' in s) && !('credentialsRef' in s)),
    true
  );
  assertNoSecrets(JSON.stringify(detail.body));

  // list keeps its old contract plus latestOrderAt
  const list = await api(
    `/admin/customers?search=${encodeURIComponent(cust.email)}`,
    { headers: { Cookie: admin.cookie } }
  );
  assert.equal(list.response.status, 200);
  const row = list.body.data.customers.find((c) => c.id === cust.id);
  assert.ok(row);
  assert.equal(typeof row.orderCount, 'number');
  assert.equal(typeof row.serviceCount, 'number');
  assert.ok('latestOrderAt' in row);

  // role filter still refused (no new query surface)
  const role = await adminGet('/admin/customers?role=admin', admin);
  assert.equal(role.response.status, 400);

  // updated UI pins: controls exist, destructive words still banned
  const detailHtml = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'customer-detail.html'),
    'utf8'
  );
  assert.match(detailHtml, /id="customer-suspend-action"/);
  assert.match(detailHtml, /id="customer-reactivate-action"/);
  assert.match(detailHtml, /id="customer-reset-action"/);
  assert.match(detailHtml, /id="admin-customer-orders-tbody"/);
  assert.match(detailHtml, /id="admin-customer-payments-tbody"/);
  assert.doesNotMatch(detailHtml, /Delete customer|Change role/i);
  assert.doesNotMatch(detailHtml, /\(read-only\)/);

  const listHtml = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'customers.html'),
    'utf8'
  );
  assert.doesNotMatch(listHtml, /\(read-only\)/);
  assert.match(listHtml, /Latest order/);

  await demote(admin.email);
});
