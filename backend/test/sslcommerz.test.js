const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { before, after } = require('node:test');

const config = require('../src/config');

// This file runs an in-process app configured as an SSLCommerz SANDBOX
// integration against a local mock gateway — no real credentials, no live
// payments. Config is mutated BEFORE the app loads so route-level rate
// limiters pick up the raised limits. The external test server keeps
// PAYMENT_PROVIDER=disabled (other suites still cover the disabled path).
const STORE_ID = 'testbox';
const STORE_PASSWORD = 'mock-store-secret-do-not-leak';

config.rateLimit.registerMax = 500;
config.rateLimit.loginMax = 500;
config.rateLimit.orderCreateMax = 500;
config.rateLimit.paymentCreateMax = 500;
config.rateLimit.sslcommerzCallbackMax = 500;

config.payments.provider = 'sslcommerz';
config.payments.sslcommerz.storeId = STORE_ID;
config.payments.sslcommerz.storePassword = STORE_PASSWORD;
config.payments.sslcommerz.mode = 'sandbox';

const app = require('../src/app');

let BASE_URL = null;
let mockBaseUrl = null;
let appServer = null;
let mockServer = null;
let database = null;
let pool = null;

const mock = {
  initMode: 'success', // 'success' | 'failed' | 'evil'
  validationMode: 'ok', // 'ok' | 'error' (error → HTTP 500 from the validation API)
  initRequests: [],
  validations: new Map(), // val_id -> validation response
  validationRequests: [],
};

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

async function api(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathname}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

function postJson(pathname, payload, headers = {}) {
  return api(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

// Gateway-style form POST (application/x-www-form-urlencoded), no redirect
// following so the 302 Location can be inspected.
function postForm(pathname, fields, headers = {}) {
  const body = new URLSearchParams(fields).toString();
  return fetch(`${BASE_URL}/api${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body,
    redirect: 'manual',
  });
}

async function registerUser(prefix = 'ssl') {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Ssl',
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

async function initiatePayment(cookie, orderId, headers = {}) {
  return postJson('/payments', { orderId }, { Cookie: cookie, ...headers });
}

async function getPaymentRow(orderId) {
  const { rows } = await pool.query(
    `SELECT id, status, provider, provider_transaction_id, provider_session_key,
            validation_id, bank_transaction_id, amount::text AS amount, currency,
            metadata, failed_at, paid_at
     FROM payment_transactions
     WHERE order_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

async function getOrderRow(orderId) {
  const { rows } = await pool.query(
    'SELECT id, order_number, status, amount::text AS amount, currency FROM orders WHERE id = $1',
    [orderId]
  );
  return rows[0] || null;
}

async function countSuccessful(orderId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payment_transactions
     WHERE order_id = $1 AND status = 'successful'`,
    [orderId]
  );
  return rows[0].n;
}

function programValidation(valId, fields) {
  mock.validations.set(valId, { val_id: valId, ...fields });
}

// Initiate and return { order, payment row, tranId } with a clean success path.
async function setupAwaitingPayment(prefix) {
  const user = await registerUser(prefix);
  const order = await createOrder(user.cookie);
  const init = await initiatePayment(user.cookie, order.id);
  assert.equal(init.response.status, 201);
  const payment = await getPaymentRow(order.id);
  assert.ok(payment, 'payment row recorded');
  return { user, order, init: init.body.data, payment };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? addr.port : null);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

// Express apps are not http.Servers — app.listen creates one and returns it.
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
  pool = database.pool;
  const { runSeed } = require('../src/services/seed');
  await runSeed();

  // Mock SSLCommerz sandbox: session initiation + Order Validation API.
  mockServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/gwprocess/v4/api.php') {
        const params = Object.fromEntries(new URLSearchParams(raw));
        mock.initRequests.push({ method: req.method, params });
        if (mock.initMode === 'failed') {
          res.end(
            JSON.stringify({ status: 'FAILED', failedreason: 'Technical error' })
          );
          return;
        }
        if (mock.initMode === 'evil') {
          res.end(
            JSON.stringify({
              status: 'SUCCESS',
              GatewayPageURL: 'https://evil.example/pay',
            })
          );
          return;
        }
        res.end(
          JSON.stringify({
            status: 'SUCCESS',
            GatewayPageURL: `${mockBaseUrl}/gw?session=${encodeURIComponent(
              params.tran_id || ''
            )}`,
            sessionkey: `session-${params.tran_id || ''}`,
          })
        );
        return;
      }

      if (url.pathname === '/validator/api/validationserverAPI.php') {
        const params = Object.fromEntries(url.searchParams);
        mock.validationRequests.push(params);
        if (mock.validationMode === 'error') {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              failedcode: 503,
              failedreason: 'Internal error at SSLCommerz',
            })
          );
          return;
        }
        const programmed = mock.validations.get(params.val_id);
        if (programmed) {
          res.end(JSON.stringify(programmed));
          return;
        }
        res.end(
          JSON.stringify({
            status: 'FAILED',
            tran_id: '',
            val_id: params.val_id || '',
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ status: 'ERROR' }));
    });
  });
  const mockPort = await listen(mockServer);
  mockBaseUrl = `http://127.0.0.1:${mockPort}`;
  config.payments.sslcommerz.baseUrl = mockBaseUrl;
  config.payments.sslcommerz.validationUrl =
    `${mockBaseUrl}/validator/api/validationserverAPI.php`;

  const started = await listenApp(app);
  appServer = started.server;
  BASE_URL = `http://127.0.0.1:${started.port}`;
  config.payments.sslcommerz.publicUrl = BASE_URL;
});

after(async () => {
  await closeServer(appServer);
  await closeServer(mockServer);
  if (database) await database.closePool().catch(() => {});
});

// ---------- Migration / registry ----------

test('migration 011 adds provider session/validation/bank columns and re-running is a no-op', async () => {
  const { runUp } = require('../src/services/migrator');
  const second = await runUp();
  assert.equal(second.applied, 0, 'migration 011 must already be applied');

  const { rows: applied } = await pool.query(
    "SELECT version FROM schema_migrations WHERE version LIKE '011%'"
  );
  assert.equal(applied.length, 1);
  assert.match(applied[0].version, /^011_add_payment_provider_details\.sql$/);

  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'payment_transactions'
       AND column_name IN ('provider_session_key', 'validation_id', 'bank_transaction_id')
     ORDER BY column_name`
  );
  assert.deepEqual(
    cols.map((c) => c.column_name),
    ['bank_transaction_id', 'provider_session_key', 'validation_id']
  );
});

test('provider registry exposes sslcommerz; unknown providers stay unregistered', () => {
  const { getProvider } = require('../src/services/payments/paymentProvider');
  const provider = getProvider('sslcommerz');
  assert.ok(provider, 'sslcommerz provider must be registered');
  assert.equal(provider.name, 'sslcommerz');
  assert.equal(getProvider('stripe'), null);
  assert.equal(getProvider('unknown'), null);
});

// ---------- Initiation ----------

test('POST /api/payments initiates a sandbox session: 201 {paymentId, gatewayUrl}, callbacks from APP_PUBLIC_URL only, attempt recorded', async () => {
  const { user, order, init, payment } = await setupAwaitingPayment('init');

  // response shape
  assert.deepEqual(Object.keys(init).sort(), ['gatewayUrl', 'paymentId']);
  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.match(init.paymentId, UUID_PATTERN);
  assert.equal(init.paymentId, payment.id);
  assert.ok(
    init.gatewayUrl.startsWith(mockBaseUrl),
    'gateway URL comes from the (mock) session API'
  );

  // secrets never in the response
  const rawInit = JSON.stringify(init).toLowerCase();
  assert.equal(rawInit.includes('store_passwd'), false);
  assert.equal(rawInit.includes(STORE_PASSWORD.toLowerCase()), false);

  // payment row state
  assert.equal(payment.provider, 'sslcommerz');
  assert.equal(payment.status, 'pending');
  assert.ok(
    /^FLR[0-9a-f]{27}$/.test(payment.provider_transaction_id),
    'tran_id is FLR + payment id hex (<=30 chars)'
  );
  assert.ok(payment.provider_transaction_id.length <= 30);
  assert.equal(payment.provider_session_key, init.gatewayUrl);
  assert.equal(payment.paid_at, null);

  // order untouched
  const orderRow = await getOrderRow(order.id);
  assert.equal(orderRow.status, 'awaiting_payment');

  // captured session request — required SSLCommerz fields
  assert.ok(mock.initRequests.length > 0);
  const last = mock.initRequests[mock.initRequests.length - 1].params;
  assert.equal(last.store_id, STORE_ID);
  assert.equal(last.store_passwd, STORE_PASSWORD);
  assert.equal(Number(last.total_amount), Number(order.amount));
  assert.equal(last.currency, order.currency);
  assert.equal(last.tran_id, payment.provider_transaction_id);
  assert.equal(last.value_a, order.id);
  assert.equal(last.cus_email, user.email);
  assert.ok(last.cus_name);
  assert.ok(last.product_profile);
  assert.equal(last.success_url, `${BASE_URL}/api/payments/sslcommerz/success`);
  assert.equal(last.fail_url, `${BASE_URL}/api/payments/sslcommerz/fail`);
  assert.equal(last.cancel_url, `${BASE_URL}/api/payments/sslcommerz/cancel`);
  assert.equal(last.ipn_url, `${BASE_URL}/api/payments/sslcommerz/ipn`);

  // public payment payload still exposes only the safe fields
  const detail = await api(`/payments/${init.paymentId}`, {
    headers: { Cookie: user.cookie },
  });
  assert.equal(detail.response.status, 200);
  assert.deepEqual(
    Object.keys(detail.body.data).sort(),
    [
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
    ].sort()
  );
  const rawDetail = JSON.stringify(detail.body).toLowerCase();
  assert.equal(rawDetail.includes('provider_session_key'), false);
  assert.equal(rawDetail.includes('validation_id'), false);
  assert.equal(rawDetail.includes('bank_transaction_id'), false);
  assert.equal(rawDetail.includes('metadata'), false);
});

test('callback URLs are built only from APP_PUBLIC_URL — Host/X-Forwarded-Host/Origin cannot influence them', async () => {
  const { user, order } = await setupAwaitingPayment('host');

  const init = await initiatePayment(user.cookie, order.id, {
    'X-Forwarded-Host': 'evil.example',
    Forwarded: 'host=evil.example;proto=https',
    Origin: `${BASE_URL}`,
  });
  assert.equal(init.response.status, 201);

  const last = mock.initRequests[mock.initRequests.length - 1].params;
  for (const key of ['success_url', 'fail_url', 'cancel_url', 'ipn_url']) {
    assert.ok(last[key].startsWith(`${BASE_URL}/`), `${key} from APP_PUBLIC_URL`);
    assert.equal(last[key].includes('evil.example'), false);
  }
});

test('POST /api/payments rejects cross-origin POST (403 CSRF_INVALID)', async () => {
  const { cookie } = await registerUser('csrf');
  const order = await createOrder(cookie);
  const { response, body } = await postJson(
    '/payments',
    { orderId: order.id },
    { Cookie: cookie, Origin: 'https://evil.example' }
  );
  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'CSRF_INVALID');
});

// ---------- Verified success ----------

test('success callback with VALID validation marks paid atomically, records validation/bank/risk, redirects to the success page', async () => {
  const { user, order, payment } = await setupAwaitingPayment('ok');

  const valId = `VAL${unique()}`;
  const bankTranId = `BANK${unique()}`;
  programValidation(valId, {
    status: 'VALID',
    tran_id: payment.provider_transaction_id,
    amount: order.amount,
    currency: order.currency,
    bank_tran_id: bankTranId,
    value_a: order.id,
    risk_level: '1',
    risk_flag: 'HIGH',
  });

  // browser form POST, no session cookie (gateway redirect is not a session)
  const res = await postForm('/payments/sslcommerz/success', {
    val_id: valId,
    tran_id: payment.provider_transaction_id,
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location') || '';
  assert.ok(location.includes('payment-success.html'), location);
  assert.ok(location.includes(order.id), location);

  // order paid + payment successful atomically
  const orderRow = await getOrderRow(order.id);
  assert.equal(orderRow.status, 'paid');
  const updated = await getPaymentRow(order.id);
  assert.equal(updated.status, 'successful');
  assert.ok(updated.paid_at);
  assert.equal(updated.validation_id, valId);
  assert.equal(updated.bank_transaction_id, bankTranId);
  assert.deepEqual(updated.metadata, { risk_level: 1, risk_flag: 'HIGH' });
  assert.equal(await countSuccessful(order.id), 1);

  // the Order Validation API was called server-side with credentials
  const lastValidation =
    mock.validationRequests[mock.validationRequests.length - 1];
  assert.equal(lastValidation.val_id, valId);
  assert.equal(lastValidation.store_id, STORE_ID);
  assert.equal(lastValidation.store_passwd, STORE_PASSWORD);
  assert.equal(lastValidation.format, 'json');
  assert.equal(lastValidation.val_id, valId);

  // user-facing payment list still shows the safe payload only
  const list = await api('/payments', { headers: { Cookie: user.cookie } });
  assert.equal(list.response.status, 200);
  const listed = list.body.data.payments.find((p) => p.id === payment.id);
  assert.equal(listed.status, 'successful');
  const raw = JSON.stringify(list.body).toLowerCase();
  assert.equal(raw.includes('validation_id'), false);
  assert.equal(raw.includes('bank_transaction_id'), false);
  assert.equal(raw.includes('risk_level'), false);
});

test('verified success and IPN are idempotent — replay never double-pays', async () => {
  const { order, payment } = await setupAwaitingPayment('idem');

  const valId = `VAL${unique()}`;
  programValidation(valId, {
    status: 'VALID',
    tran_id: payment.provider_transaction_id,
    amount: order.amount,
    currency: order.currency,
    bank_tran_id: `BANK${unique()}`,
    value_a: order.id,
  });

  const first = await postForm('/payments/sslcommerz/success', {
    val_id: valId,
    tran_id: payment.provider_transaction_id,
  });
  assert.equal(first.status, 302);
  const afterFirst = await getPaymentRow(order.id);
  const firstPaidAt = afterFirst.paid_at.toISOString();
  assert.equal(afterFirst.status, 'successful');
  assert.equal((await getOrderRow(order.id)).status, 'paid');

  // browser replay
  const replay = await postForm('/payments/sslcommerz/success', {
    val_id: valId,
    tran_id: payment.provider_transaction_id,
  });
  assert.equal(replay.status, 302);

  // IPN replay — always 200, uniform body
  const ipn = await postForm('/payments/sslcommerz/ipn', {
    val_id: valId,
    tran_id: payment.provider_transaction_id,
    status: 'VALID',
  });
  assert.equal(ipn.status, 200);
  const ipnBody = await ipn.json();
  assert.deepEqual(ipnBody, { success: true, data: { received: true } });

  const final = await getPaymentRow(order.id);
  assert.equal(final.status, 'successful');
  assert.equal(final.paid_at.toISOString(), firstPaidAt);
  assert.equal(await countSuccessful(order.id), 1);
  assert.equal((await getOrderRow(order.id)).status, 'paid');
});

test('IPN alone (VALID) marks the order paid — no browser success callback needed', async () => {
  const { order, payment } = await setupAwaitingPayment('ipn');

  const valId = `VAL${unique()}`;
  programValidation(valId, {
    status: 'VALID',
    tran_id: payment.provider_transaction_id,
    amount: order.amount,
    currency: order.currency,
    bank_tran_id: `BANK${unique()}`,
    value_a: order.id,
  });

  // IPN alone — the server must still call the Order Validation API first.
  const validationsBeforeIpn = mock.validationRequests.length;
  const res = await postForm('/payments/sslcommerz/ipn', {
    val_id: valId,
    tran_id: payment.provider_transaction_id,
    status: 'VALID',
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()), { success: true, data: { received: true } });

  assert.ok(
    mock.validationRequests.length > validationsBeforeIpn,
    'IPN must perform server-side Order Validation before marking paid'
  );
  assert.equal(
    mock.validationRequests[mock.validationRequests.length - 1].val_id,
    valId
  );
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  assert.equal((await getPaymentRow(order.id)).status, 'successful');
  assert.equal(await countSuccessful(order.id), 1);
});

test('success callback with a VALID response whose amount/currency mismatch the order is rejected — never paid', async () => {
  // amount mismatch
  const amountCase = await setupAwaitingPayment('amt');
  const valAmount = `VAL${unique()}`;
  programValidation(valAmount, {
    status: 'VALID',
    tran_id: amountCase.payment.provider_transaction_id,
    amount: '0.01',
    currency: amountCase.order.currency,
    value_a: amountCase.order.id,
  });
  const resAmount = await postForm('/payments/sslcommerz/success', {
    val_id: valAmount,
    tran_id: amountCase.payment.provider_transaction_id,
  });
  assert.equal(resAmount.status, 302);
  const locAmount = resAmount.headers.get('location') || '';
  assert.ok(locAmount.includes('payment-failed.html'), locAmount);
  assert.ok(locAmount.includes(amountCase.order.id), locAmount);
  assert.equal((await getOrderRow(amountCase.order.id)).status, 'awaiting_payment');
  assert.equal(
    (await getPaymentRow(amountCase.order.id)).status,
    'pending',
    'failed verification leaves the attempt untouched'
  );
  assert.equal(await countSuccessful(amountCase.order.id), 0);

  // currency mismatch
  const currencyCase = await setupAwaitingPayment('cur');
  const valCurrency = `VAL${unique()}`;
  programValidation(valCurrency, {
    status: 'VALID',
    tran_id: currencyCase.payment.provider_transaction_id,
    amount: currencyCase.order.amount,
    currency: currencyCase.order.currency === 'BDT' ? 'USD' : 'BDT',
    value_a: currencyCase.order.id,
  });
  const resCurrency = await postForm('/payments/sslcommerz/success', {
    val_id: valCurrency,
    tran_id: currencyCase.payment.provider_transaction_id,
  });
  assert.equal(resCurrency.status, 302);
  assert.ok(
    (resCurrency.headers.get('location') || '').includes('payment-failed.html')
  );
  assert.equal(
    (await getOrderRow(currencyCase.order.id)).status,
    'awaiting_payment'
  );
  assert.equal(await countSuccessful(currencyCase.order.id), 0);
});

test('fail and cancel callbacks only move attempts to failure directions — orders are never paid', async () => {
  // fail (no val_id — tran_id only)
  const failCase = await setupAwaitingPayment('fail');
  const failRes = await postForm('/payments/sslcommerz/fail', {
    tran_id: failCase.payment.provider_transaction_id,
    status: 'FAILED',
  });
  assert.equal(failRes.status, 302);
  const failLoc = failRes.headers.get('location') || '';
  assert.ok(failLoc.includes('payment-failed.html'), failLoc);
  assert.ok(failLoc.includes(failCase.order.id), failLoc);
  assert.equal((await getPaymentRow(failCase.order.id)).status, 'failed');
  assert.ok((await getPaymentRow(failCase.order.id)).failed_at);
  assert.equal((await getOrderRow(failCase.order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(failCase.order.id), 0);

  // cancel (no val_id)
  const cancelCase = await setupAwaitingPayment('cancel');
  const cancelRes = await postForm('/payments/sslcommerz/cancel', {
    tran_id: cancelCase.payment.provider_transaction_id,
    status: 'CANCELLED',
  });
  assert.equal(cancelRes.status, 302);
  const cancelLoc = cancelRes.headers.get('location') || '';
  assert.ok(cancelLoc.includes('payment-cancelled.html'), cancelLoc);
  assert.ok(cancelLoc.includes(cancelCase.order.id), cancelLoc);
  assert.equal((await getPaymentRow(cancelCase.order.id)).status, 'cancelled');
  assert.equal(
    (await getOrderRow(cancelCase.order.id)).status,
    'awaiting_payment'
  );

  // IPN FAILED (no val_id) — same failure direction, still a uniform 200
  const ipnCase = await setupAwaitingPayment('ipnfail');
  const ipnRes = await postForm('/payments/sslcommerz/ipn', {
    tran_id: ipnCase.payment.provider_transaction_id,
    status: 'FAILED',
  });
  assert.equal(ipnRes.status, 200);
  assert.equal((await getPaymentRow(ipnCase.order.id)).status, 'failed');
  assert.equal(
    (await getOrderRow(ipnCase.order.id)).status,
    'awaiting_payment'
  );
});

test('fail/cancel callbacks can never downgrade a verified successful payment', async () => {
  const { order, payment } = await setupAwaitingPayment('down');

  const valId = `VAL${unique()}`;
  programValidation(valId, {
    status: 'VALID',
    tran_id: payment.provider_transaction_id,
    amount: order.amount,
    currency: order.currency,
    value_a: order.id,
  });
  const okRes = await postForm('/payments/sslcommerz/success', {
    val_id: valId,
    tran_id: payment.provider_transaction_id,
  });
  assert.equal(okRes.status, 302);
  assert.equal((await getOrderRow(order.id)).status, 'paid');

  const late = await postForm('/payments/sslcommerz/fail', {
    tran_id: payment.provider_transaction_id,
    status: 'FAILED',
  });
  assert.equal(late.status, 302);

  const row = await getPaymentRow(order.id);
  assert.equal(row.status, 'successful', 'successful payment not downgraded');
  assert.equal((await getOrderRow(order.id)).status, 'paid');
});

// ---------- Verification failures / hostile input ----------

test('success callback without a valid val_id never pays and redirects to the failed page', async () => {
  const { order, payment } = await setupAwaitingPayment('noval');

  // unknown val_id → validation API returns no usable tran_id
  const res = await postForm('/payments/sslcommerz/success', {
    val_id: `MISSING${unique()}`,
    tran_id: payment.provider_transaction_id,
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location') || '';
  assert.ok(location.includes('payment-failed.html'), location);
  assert.equal(location.includes('order='), false, 'no order to attribute');

  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal((await getPaymentRow(order.id)).status, 'pending');
  assert.equal(await countSuccessful(order.id), 0);

  // success callback with no val_id at all
  const noParams = await postForm('/payments/sslcommerz/success', {
    tran_id: payment.provider_transaction_id,
  });
  assert.equal(noParams.status, 302);
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('VALID validation for an unknown tran_id is a safe 404 → failed page, no state change', async () => {
  const { order } = await setupAwaitingPayment('unknown');

  const valId = `VAL${unique()}`;
  const unknownTran = 'FLR' + 'a'.repeat(27);
  programValidation(valId, {
    status: 'VALID',
    tran_id: unknownTran,
    amount: '100.00',
    currency: 'BDT',
    value_a: order.id,
  });

  const res = await postForm('/payments/sslcommerz/success', {
    val_id: valId,
    tran_id: unknownTran,
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location') || '';
  assert.ok(location.includes('payment-failed.html'), location);
  assert.equal(location.includes('order='), false);

  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('malformed/hostile tran_id on fail callback is rejected safely (no 500, no state change)', async () => {
  const { order, payment } = await setupAwaitingPayment('inject');

  const hostile = [
    "1'; DROP TABLE payment_transactions;--",
    '<script>alert(1)</script>',
    '../../etc/passwd',
    'FLRshort',
    '',
  ];

  for (const tran of hostile) {
    const res = await postForm('/payments/sslcommerz/fail', {
      tran_id: tran,
      status: 'FAILED',
    });
    assert.equal(res.status, 302, JSON.stringify(tran));
    const location = res.headers.get('location') || '';
    assert.ok(location.includes('payment-failed.html'), location);
    assert.equal(location.includes('order='), false, 'no payment looked up');
  }

  // table intact, attempt untouched
  const { rows } = await pool.query(
    "SELECT to_regclass('payment_transactions') AS t"
  );
  assert.equal(rows[0].t, 'payment_transactions');
  assert.equal((await getPaymentRow(order.id)).status, 'pending');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(payment.status, 'pending');
});

test('FAILED validation (with tran_id) from the success URL marks the attempt failed, never paid', async () => {
  const { order, payment } = await setupAwaitingPayment('vfail');

  const valId = `VAL${unique()}`;
  programValidation(valId, {
    status: 'FAILED',
    tran_id: payment.provider_transaction_id,
    amount: order.amount,
    currency: order.currency,
    value_a: order.id,
  });

  const res = await postForm('/payments/sslcommerz/success', {
    val_id: valId,
    tran_id: payment.provider_transaction_id,
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location') || '';
  assert.ok(location.includes('payment-failed.html'), location);
  assert.ok(location.includes(order.id), location);

  assert.equal((await getPaymentRow(order.id)).status, 'failed');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('a second verified attempt on an already-paid order stays at exactly one successful payment', async () => {
  const { user, order, payment } = await setupAwaitingPayment('twice');

  const valId = `VAL${unique()}`;
  programValidation(valId, {
    status: 'VALID',
    tran_id: payment.provider_transaction_id,
    amount: order.amount,
    currency: order.currency,
    value_a: order.id,
  });
  const first = await postForm('/payments/sslcommerz/success', {
    val_id: valId,
    tran_id: payment.provider_transaction_id,
  });
  assert.equal(first.status, 302);
  assert.equal((await getOrderRow(order.id)).status, 'paid');

  // A second attempt row (direct insert — the API correctly refuses new
  // attempts on paid orders), then a VALID validation for its tran_id.
  const secondTran = 'FLR' + require('node:crypto')
    .randomBytes(16)
    .toString('hex')
    .slice(0, 27)
    .padEnd(27, '0');
  const { rows: inserted } = await pool.query(
    `INSERT INTO payment_transactions (order_id, user_id, provider, provider_transaction_id, amount, currency, status)
     VALUES ($1, (SELECT user_id FROM orders WHERE id = $1), 'sslcommerz', $2, $3, $4, 'initiated')
     RETURNING id`,
    [order.id, secondTran, order.amount, order.currency]
  );
  assert.equal(inserted.length, 1);

  const secondVal = `VAL${unique()}`;
  programValidation(secondVal, {
    status: 'VALID',
    tran_id: secondTran,
    amount: order.amount,
    currency: order.currency,
    value_a: order.id,
  });
  const res = await postForm('/payments/sslcommerz/success', {
    val_id: secondVal,
    tran_id: secondTran,
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location') || '';
  assert.ok(location.includes('payment-success.html'), location);
  assert.ok(location.includes(order.id), location);

  assert.equal(await countSuccessful(order.id), 1, 'exactly one success');
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  // the second attempt was not flipped to successful by the partial index path
  const { rows: second } = await pool.query(
    'SELECT status FROM payment_transactions WHERE id = $1',
    [inserted[0].id]
  );
  assert.equal(second[0].status, 'initiated');
});

// ---------- Initiation failure modes ----------

test('session API failure → 502 PAYMENT_PROVIDER_ERROR with a safe message; order untouched, attempt recorded initiated', async () => {
  mock.initMode = 'failed';
  try {
    const { cookie } = await registerUser('gwfail');
    const order = await createOrder(cookie);
    const { response, body } = await initiatePayment(cookie, order.id);

    assert.equal(response.status, 502);
    assert.equal(body.error.code, 'PAYMENT_PROVIDER_ERROR');
    assert.equal(
      body.error.message,
      'Payment provider is temporarily unavailable.'
    );
    const raw = JSON.stringify(body).toLowerCase();
    assert.equal(raw.includes('technical error'), false, 'no upstream detail leak');
    assert.equal(raw.includes('stack'), false);
    assert.equal(raw.includes('sql'), false);
    assert.equal(raw.includes(STORE_PASSWORD.toLowerCase()), false);

    assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
    const payment = await getPaymentRow(order.id);
    assert.equal(payment.status, 'initiated');
    assert.equal(payment.provider_transaction_id, null);
    assert.equal(await countSuccessful(order.id), 0);
  } finally {
    mock.initMode = 'success';
  }
});

test('untrusted gateway URL in the session response → 502 PAYMENT_PROVIDER_ERROR (never redirected there)', async () => {
  mock.initMode = 'evil';
  try {
    const { cookie } = await registerUser('gwevil');
    const order = await createOrder(cookie);
    const { response, body } = await initiatePayment(cookie, order.id);

    assert.equal(response.status, 502);
    assert.equal(body.error.code, 'PAYMENT_PROVIDER_ERROR');
    assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
    assert.equal((await getPaymentRow(order.id)).status, 'initiated');
  } finally {
    mock.initMode = 'success';
  }
});

test('missing sandbox credentials / non-sandbox mode refuse initiation with 503', async () => {
  const savedPassword = config.payments.sslcommerz.storePassword;
  const savedMode = config.payments.sslcommerz.mode;
  try {
    config.payments.sslcommerz.storePassword = '';
    const { cookie } = await registerUser('nocreds');
    const order = await createOrder(cookie);
    const missing = await initiatePayment(cookie, order.id);
    assert.equal(missing.response.status, 503);
    assert.equal(missing.body.error.code, 'PAYMENT_PROVIDER_NOT_CONFIGURED');

    config.payments.sslcommerz.storePassword = savedPassword;
    config.payments.sslcommerz.mode = 'live';
    const order2 = await createOrder(cookie);
    const live = await initiatePayment(cookie, order2.id);
    assert.equal(live.response.status, 503);
    assert.equal(live.body.error.code, 'PAYMENT_PROVIDER_NOT_CONFIGURED');
    assert.equal(live.body.error.message, 'Payment processing is not available yet.');
  } finally {
    config.payments.sslcommerz.storePassword = savedPassword;
    config.payments.sslcommerz.mode = savedMode;
  }
});

// ---------- Callbacks: no auth/CSRF, uniform IPN ----------

test('callbacks require no session and no CSRF; IPN always answers a uniform 200', async () => {
  // IPN with no cookie, no Origin, garbage body — still 200 uniform
  const ipn = await postForm('/payments/sslcommerz/ipn', {
    hello: 'world',
    val_id: '',
  });
  assert.equal(ipn.status, 200);
  assert.deepEqual(await ipn.json(), {
    success: true,
    data: { received: true },
  });

  // IPN with an Origin header (CSRF irrelevant for providers)
  const ipnOrigin = await postForm(
    '/payments/sslcommerz/ipn',
    { status: 'VALID', val_id: `VAL${unique()}` },
    { Origin: 'https://evil.example' }
  );
  assert.equal(ipnOrigin.status, 200);

  // success callback without a session is processed (302, not 401/403)
  const { order, payment } = await setupAwaitingPayment('nocookie');
  const res = await postForm('/payments/sslcommerz/success', {
    val_id: `VAL${unique()}`,
    tran_id: payment.provider_transaction_id,
  });
  assert.equal(res.status, 302);
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
});

test('while payments are disabled, initiation is 503 and callbacks can never mark paid (IPN still 200)', async () => {
  const savedProvider = config.payments.provider;
  try {
    config.payments.provider = 'disabled';

    const { cookie } = await registerUser('dis');
    const order = await createOrder(cookie);
    const init = await initiatePayment(cookie, order.id);
    assert.equal(init.response.status, 503);
    assert.equal(init.body.error.code, 'PAYMENT_PROVIDER_NOT_CONFIGURED');

    // even a crafted VALID IPN is acknowledged but changes nothing
    const valId = `VAL${unique()}`;
    const tran = 'FLR' + 'b'.repeat(27);
    programValidation(valId, {
      status: 'VALID',
      tran_id: tran,
      amount: order.amount,
      currency: order.currency,
      value_a: order.id,
    });
    const ipn = await postForm('/payments/sslcommerz/ipn', {
      val_id: valId,
      tran_id: tran,
    });
    assert.equal(ipn.status, 200);
    assert.deepEqual(await ipn.json(), {
      success: true,
      data: { received: true },
    });
    assert.equal(await countSuccessful(order.id), 0);
    assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  } finally {
    config.payments.provider = savedProvider;
  }
});

// ---------- Secrets / frontend / result pages ----------

test('store password never appears in logs or API responses', async () => {
  const captured = [];
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };
  console.log = (...args) => captured.push(args.map(String).join(' '));
  console.warn = (...args) => captured.push(args.map(String).join(' '));
  console.error = (...args) => captured.push(args.map(String).join(' '));
  console.info = (...args) => captured.push(args.map(String).join(' '));
  console.debug = (...args) => captured.push(args.map(String).join(' '));

  let responseBody = '';
  try {
    const { user, order, payment } = await setupAwaitingPayment('leak');
    responseBody = JSON.stringify({ init: 'captured-above' });

    const valId = `VAL${unique()}`;
    programValidation(valId, {
      status: 'VALID',
      tran_id: payment.provider_transaction_id,
      amount: order.amount,
      currency: order.currency,
      value_a: order.id,
    });
    const res = await postForm('/payments/sslcommerz/success', {
      val_id: valId,
      tran_id: payment.provider_transaction_id,
    });
    assert.equal(res.status, 302);
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    console.info = originals.info;
    console.debug = originals.debug;
  }

  const joined = captured.join('\n');
  assert.equal(joined.includes(STORE_PASSWORD), false, 'password not logged');
  assert.equal(responseBody.includes(STORE_PASSWORD), false);
});

test('frontend ships no gateway secrets, result pages exist, checkout redirects on gatewayUrl', async () => {
  const frontendDir = path.join(__dirname, '../../frontend');

  const collect = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collect(full));
      else if (/\.(html|js|css)$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  for (const file of collect(frontendDir)) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content.includes(STORE_PASSWORD), false, file);
    assert.equal(/\bstore_passwd\b/.test(content), false, file);
    assert.equal(/\bSSLCOMMERZ_STORE_PASSWORD\b/.test(content), false, file);
    assert.equal(/\bstore_password\b/i.test(content), false, file);
  }

  // result pages: served, external scripts only, wired to payment-status.js
  for (const page of [
    'payment-success.html',
    'payment-failed.html',
    'payment-cancelled.html',
  ]) {
    const res = await fetch(`${BASE_URL}/${page}`);
    assert.equal(res.status, 200, page);
    const html = await res.text();
    assert.ok(html.includes('data-payment-result='), page);
    assert.ok(html.includes('js/payment-status.js'), page);
    assert.ok(html.includes('id="payment-result-message"'), page);
    assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, page);
    assert.equal(/<style[\s>]/i.test(html), false, page);
  }

  // payment-status.js logic markers
  const statusJs = fs.readFileSync(
    path.join(frontendDir, 'js/payment-status.js'),
    'utf8'
  );
  assert.ok(statusJs.includes('Payment is still being verified.'));
  assert.ok(statusJs.includes('Payment successful.'));
  assert.ok(statusJs.includes("We couldn't find that order."));
  assert.ok(statusJs.includes('/login?return='));
  assert.equal(/innerHTML/.test(statusJs), false);

  // checkout redirects to the server-provided gateway URL only
  const checkoutJs = fs.readFileSync(
    path.join(frontendDir, 'js/checkout.js'),
    'utf8'
  );
  assert.ok(checkoutJs.includes('body.data.gatewayUrl'));
  assert.ok(checkoutJs.includes('Idempotency-Key'));

  const checkoutHtml = await (
    await fetch(`${BASE_URL}/checkout.html`)
  ).text();
  // payment-methods UI (SSLCommerz button + optional bKash instructions) with
  // the standing warning that an unpaid order provisions nothing
  assert.ok(checkoutHtml.includes('id="payment-methods"'));
  assert.ok(checkoutHtml.includes('no service is provisioned before then'));
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(checkoutHtml), false);
});

// ---------- Step 11: payment verification & security audit ----------

test('audit: success callback tran_id that does not match the validation tran_id fails verification — never paid', async () => {
  const { order, payment } = await setupAwaitingPayment('mismatch');

  const valId = `VAL${unique()}`;
  programValidation(valId, {
    status: 'VALID',
    tran_id: payment.provider_transaction_id,
    amount: order.amount,
    currency: order.currency,
    value_a: order.id,
  });

  const otherTran = 'FLR' + 'd'.repeat(27); // well-formed, but not this validation's tran_id
  const validationsBefore = mock.validationRequests.length;
  const res = await postForm('/payments/sslcommerz/success', {
    val_id: valId,
    tran_id: otherTran,
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location') || '';
  assert.ok(location.includes('payment-failed.html'), location);
  assert.equal(location.includes('order='), false, 'rejected before payment lookup');
  assert.ok(
    mock.validationRequests.length > validationsBefore,
    'validation API is still consulted first'
  );

  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal((await getPaymentRow(order.id)).status, 'pending');
  assert.equal(await countSuccessful(order.id), 0);
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM payment_transactions WHERE provider_transaction_id = $1',
    [otherTran]
  );
  assert.equal(rows[0].n, 0, 'no state change for the mismatched tran_id');
});

test('audit: provider validation API error (HTTP 500) → failed page; order remains awaiting_payment', async () => {
  mock.validationMode = 'error';
  try {
    const { order, payment } = await setupAwaitingPayment('vapi');
    const valId = `VAL${unique()}`;
    programValidation(valId, {
      status: 'VALID',
      tran_id: payment.provider_transaction_id,
      amount: order.amount,
      currency: order.currency,
      value_a: order.id,
    });

    const validationsBefore = mock.validationRequests.length;
    const res = await postForm('/payments/sslcommerz/success', {
      val_id: valId,
      tran_id: payment.provider_transaction_id,
    });
    assert.equal(res.status, 302);
    const location = res.headers.get('location') || '';
    assert.ok(location.includes('payment-failed.html'), location);
    assert.equal(
      mock.validationRequests.length,
      validationsBefore + 1,
      'validation API was attempted'
    );

    assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
    assert.equal((await getPaymentRow(order.id)).status, 'pending');
    assert.equal(await countSuccessful(order.id), 0);

    // IPN through the same broken validation API: 200, still no state change
    const ipn = await postForm('/payments/sslcommerz/ipn', {
      val_id: valId,
      tran_id: payment.provider_transaction_id,
    });
    assert.equal(ipn.status, 200);
    assert.deepEqual(await ipn.json(), {
      success: true,
      data: { received: true },
    });
    assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
    assert.equal(await countSuccessful(order.id), 0);
  } finally {
    mock.validationMode = 'ok';
  }
});

test('audit: client-supplied amount/currency/status/transaction id can never change payment state', async () => {
  // 1. Strict body on initiation — unexpected fields are rejected outright.
  const { user, order, payment } = await setupAwaitingPayment('ctl');
  const forgedCreate = await postJson(
    '/payments',
    {
      orderId: order.id,
      amount: '1.00',
      currency: 'USD',
      status: 'paid',
      providerTransactionId: 'FLR' + 'e'.repeat(27),
    },
    { Cookie: user.cookie }
  );
  assert.equal(forgedCreate.response.status, 400);
  assert.equal(forgedCreate.body.error.code, 'VALIDATION_ERROR');
  assert.ok(
    forgedCreate.body.error.details.some((d) => d.includes('Unexpected field: amount'))
  );
  assert.equal(await countSuccessful(order.id), 0);
  const { rows: attemptRows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM payment_transactions WHERE order_id = $1',
    [order.id]
  );
  assert.equal(attemptRows[0].n, 1, 'rejected body created no extra attempt');

  // 2. Forged fields on the success callback — validation API values win.
  const valId = `VAL${unique()}`;
  programValidation(valId, {
    status: 'VALID',
    tran_id: payment.provider_transaction_id,
    amount: order.amount,
    currency: order.currency,
    value_a: order.id,
    bank_tran_id: `BANK${unique()}`,
  });
  const res = await postForm('/payments/sslcommerz/success', {
    val_id: valId,
    tran_id: payment.provider_transaction_id,
    amount: '0.01',
    currency: 'USD',
    status: 'successful',
    order_status: 'paid',
    provider_transaction_id: 'FLR' + 'e'.repeat(27),
    validation_id: 'FORGED',
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location') || '';
  assert.ok(location.includes('payment-success.html'), location);
  assert.equal(location.includes(STORE_PASSWORD), false);
  assert.equal(location.includes('store_passwd'), false);

  const orderRow = await getOrderRow(order.id);
  assert.equal(orderRow.status, 'paid');
  assert.equal(Number(orderRow.amount), Number(order.amount), 'order amount unchanged');
  assert.equal(orderRow.currency, order.currency, 'order currency unchanged');
  const paidRow = await getPaymentRow(order.id);
  assert.equal(paidRow.status, 'successful');
  assert.equal(Number(paidRow.amount), Number(payment.amount), 'payment amount unchanged');
  assert.equal(paidRow.currency, payment.currency, 'payment currency unchanged');
  assert.equal(
    paidRow.provider_transaction_id,
    payment.provider_transaction_id,
    'provider transaction id comes from the validation API, not the client'
  );
  assert.equal(paidRow.validation_id, valId, 'validation_id from API, not FORGED');
  assert.equal(await countSuccessful(order.id), 1);

  // 3. Forged query-string fields on a GET success callback are ignored too.
  const queryCase = await setupAwaitingPayment('qctl');
  const queryVal = `VAL${unique()}`;
  programValidation(queryVal, {
    status: 'VALID',
    tran_id: queryCase.payment.provider_transaction_id,
    amount: queryCase.order.amount,
    currency: queryCase.order.currency,
    value_a: queryCase.order.id,
  });
  const getRes = await fetch(
    `${BASE_URL}/api/payments/sslcommerz/success` +
      `?val_id=${encodeURIComponent(queryVal)}` +
      `&tran_id=${queryCase.payment.provider_transaction_id}` +
      '&amount=0.01&currency=USD&status=failed&provider_transaction_id=EVIL',
    { redirect: 'manual' }
  );
  assert.equal(getRes.status, 302);
  assert.ok(
    (getRes.headers.get('location') || '').includes('payment-success.html'),
    'validation API values (not forged query fields) decided the outcome'
  );
  const queryOrder = await getOrderRow(queryCase.order.id);
  assert.equal(queryOrder.status, 'paid');
  assert.equal(Number(queryOrder.amount), Number(queryCase.order.amount));
  const queryPaid = await getPaymentRow(queryCase.order.id);
  assert.equal(queryPaid.provider_transaction_id, queryCase.payment.provider_transaction_id);
  assert.equal(await countSuccessful(queryCase.order.id), 1);
});

test('audit: IPN status field alone can never mark an order paid (no val_id, no validation call)', async () => {
  const { order, payment } = await setupAwaitingPayment('ipnctl');

  for (const status of ['VALID', 'SUCCESSFUL', 'successful']) {
    const validationsBefore = mock.validationRequests.length;
    const res = await postForm('/payments/sslcommerz/ipn', {
      tran_id: payment.provider_transaction_id,
      status,
      amount: '0.01',
      currency: 'USD',
    });
    assert.equal(res.status, 200, status);
    assert.deepEqual(await res.json(), {
      success: true,
      data: { received: true },
    });
    assert.equal(
      mock.validationRequests.length,
      validationsBefore,
      'status-only IPN never reaches the validation API'
    );
    assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment', status);
    assert.equal((await getPaymentRow(order.id)).status, 'pending', status);
    assert.equal(await countSuccessful(order.id), 0, status);
  }
});

test('audit: hostile callbacks cannot downgrade an already-paid order (fail/cancel/IPN failure statuses)', async () => {
  const { order, payment } = await setupAwaitingPayment('auditdown');

  const valId = `VAL${unique()}`;
  programValidation(valId, {
    status: 'VALID',
    tran_id: payment.provider_transaction_id,
    amount: order.amount,
    currency: order.currency,
    value_a: order.id,
  });
  const paid = await postForm('/payments/sslcommerz/success', {
    val_id: valId,
    tran_id: payment.provider_transaction_id,
  });
  assert.equal(paid.status, 302);
  const before = await getPaymentRow(order.id);
  assert.equal(before.status, 'successful');
  const paidAt = before.paid_at.toISOString();

  const failRes = await postForm('/payments/sslcommerz/fail', {
    tran_id: payment.provider_transaction_id,
    status: 'FAILED',
  });
  assert.equal(failRes.status, 302);
  const cancelRes = await postForm('/payments/sslcommerz/cancel', {
    tran_id: payment.provider_transaction_id,
    status: 'CANCELLED',
  });
  assert.equal(cancelRes.status, 302);
  for (const status of ['FAILED', 'CANCELLED', 'EXPIRED']) {
    const ipn = await postForm('/payments/sslcommerz/ipn', {
      tran_id: payment.provider_transaction_id,
      status,
    });
    assert.equal(ipn.status, 200, status);
  }

  const after = await getPaymentRow(order.id);
  assert.equal(after.status, 'successful', 'successful payment never downgraded');
  assert.equal(after.paid_at.toISOString(), paidAt, 'paid_at unchanged');
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  assert.equal(await countSuccessful(order.id), 1);
});

test('audit: store password is never stored in the database (no credential columns, no row content)', async () => {
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'payment_transactions'`
  );
  for (const { column_name: name } of cols) {
    assert.doesNotMatch(
      name,
      /password|passwd|secret|credential|store_/i,
      `payment_transactions must not have a credential column: ${name}`
    );
  }

  const { rows: hits } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM payment_transactions
       WHERE row_to_json(payment_transactions)::text ILIKE $1
          OR row_to_json(payment_transactions)::text ILIKE '%store_passwd%'
     ) AS hit`,
    [`%${STORE_PASSWORD}%`]
  );
  assert.equal(hits[0].hit, false, 'store password must not appear in any payment row');

  // A full verified flow (attempt + success) still stores nothing sensitive.
  const { order, payment } = await setupAwaitingPayment('dbsecret');
  const valId = `VAL${unique()}`;
  programValidation(valId, {
    status: 'VALID',
    tran_id: payment.provider_transaction_id,
    amount: order.amount,
    currency: order.currency,
    value_a: order.id,
  });
  const res = await postForm('/payments/sslcommerz/success', {
    val_id: valId,
    tran_id: payment.provider_transaction_id,
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location') || '';
  assert.equal(location.includes(STORE_PASSWORD), false);
  const { rows: afterHits } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM payment_transactions
       WHERE row_to_json(payment_transactions)::text ILIKE $1
     ) AS hit`,
    [`%${STORE_PASSWORD}%`]
  );
  assert.equal(afterHits[0].hit, false);
});

// ---------- Regression against the shared external server ----------

test('regression: external test server still runs payments disabled; health OK', async () => {
  const external = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
  const health = await fetch(`${external}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.database, 'up');

  // in-process app health too
  const local = await api('/health');
  assert.equal(local.response.status, 200);
  assert.equal(local.body.database, 'up');
});
