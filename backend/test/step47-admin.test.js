const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { before, after } = require('node:test');

// PART P - Admin management + manual verification (spec tests 26-43).
// In-process app with a local Uddoktapay mock: no real credentials, no live
// payments, no external network. Every settlement below runs through the one
// server-side path (paymentService.markOrderPaidFromVerifiedPayment); there is
// no endpoint that marks an order paid from client input.
const config = require('../src/config');
const API_KEY = 'mock-uddokta-key-do-not-leak';

config.rateLimit.registerMax = 500;
config.rateLimit.loginMax = 500;
config.rateLimit.orderCreateMax = 500;
config.rateLimit.paymentCreateMax = 500;
config.payments.provider = 'uddoktapay';

const app = require('../src/app');

const ROOT_DIR = path.join(__dirname, '../..');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');

let BASE_URL = null;
let mockBaseUrl = null;
let appServer = null;
let mockServer = null;
let database = null;
let pool = null;

const mock = {
  initMode: 'success',
  initRequests: [],
  verifyRequests: [],
  verifications: new Map(),
};

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;
const UUID_DONOTUSE = '00000000-0000-4000-8000-000000000047';

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

function getCallback(pathname, query = {}) {
  const url = new URL(`${BASE_URL}/api${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return fetch(url, { redirect: 'manual' });
}

async function registerUser(prefix = 'a47') {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Ad',
    lastName: 'Min',
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

async function adminSession(prefix = 'a47-admin') {
  const session = await registerUser(prefix);
  await pool.query(
    `UPDATE users SET role = 'admin', status = 'active' WHERE email = $1`,
    [session.email]
  );
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [
    session.email,
  ]);
  assert.ok(rows[0], 'admin row');
  return { ...session, id: rows[0].id };
}

function adminGet(pathname, admin) {
  return api(pathname, {
    headers: { Cookie: admin.cookie, Accept: 'application/json' },
  });
}

function adminPost(pathname, payload, admin, extraHeaders = {}) {
  return postJson(pathname, payload, {
    Cookie: admin.cookie,
    ...extraHeaders,
  });
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

async function initiatePayment(cookie, orderId) {
  return postJson('/payments', { orderId }, { Cookie: cookie });
}

async function getPaymentRow(orderId) {
  const { rows } = await pool.query(
    `SELECT id, status, provider, provider_transaction_id, provider_session_key,
            validation_id, bank_transaction_id, amount::text AS amount, currency,
            metadata, paid_at, created_at, updated_at
     FROM payment_transactions
     WHERE order_id = $1
     ORDER BY created_at DESC, id DESC
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

function programVerify(invoiceId, fields) {
  mock.verifications.set(invoiceId, {
    full_name: 'Ad Min',
    email: 'verify@example.com',
    amount: '10.00',
    fee: '0.00',
    charged_amount: '10.00',
    invoice_id: invoiceId,
    metadata: null,
    payment_method: 'bkash',
    sender_number: '01311111111',
    transaction_id: `TXN${unique().toUpperCase()}`,
    date: '2026-01-07 14:00:50',
    status: 'COMPLETED',
    ...fields,
  });
}

// Fresh user + order + open UddoktaPay payment against the live mock.
async function setupAwaitingPayment(prefix) {
  const user = await registerUser(prefix);
  const order = await createOrder(user.cookie);
  const init = await initiatePayment(user.cookie, order.id);
  assert.equal(init.response.status, 201, JSON.stringify(init.body));
  const payment = await getPaymentRow(order.id);
  assert.ok(payment, 'payment row recorded');
  return { user, order, init: init.body.data, payment };
}

// Record a gateway invoice on the open row WITHOUT settling it (PENDING).
async function recordInvoice(order, payment, invoice) {
  programVerify(invoice, {
    status: 'PENDING',
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });
  const res = await getCallback('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(res.status, 302);
  const row = await getPaymentRow(order.id);
  assert.equal(row.status, 'pending', 'still open');
  assert.equal(row.provider_transaction_id, invoice, 'invoice recorded');
  return row;
}

// Settle through the gateway return (COMPLETED).
async function settleViaGateway(order, payment, invoice) {
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });
  const res = await getCallback('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(res.status, 302);
  const row = await getPaymentRow(order.id);
  assert.equal(row.status, 'successful');
  return row;
}

function verifyCalls(invoiceId) {
  return mock.verifyRequests.filter((r) => r.body.invoice_id === invoiceId);
}

async function submitManualTrx(user, order, transactionId) {
  return postJson(
    '/payments/transaction-id',
    { orderId: order.id, transactionId },
    { Cookie: user.cookie }
  );
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

  mockServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/api/checkout-v2') {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {
          body = {};
        }
        mock.initRequests.push({
          method: req.method,
          apiKey: req.headers['rt-uddoktapay-api-key'] || null,
          contentType: req.headers['content-type'] || '',
          body,
        });
        if (mock.initMode === 'http500') {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Internal error at Uddoktapay' }));
          return;
        }
        if (mock.initMode === 'failed') {
          res.end(JSON.stringify({ status: false, message: 'Rejected' }));
          return;
        }
        if (mock.initMode === 'evil') {
          res.end(
            JSON.stringify({
              status: true,
              message: 'Payment Url',
              payment_url: 'https://evil.example/pay',
            })
          );
          return;
        }
        res.end(
          JSON.stringify({
            status: true,
            message: 'Payment Url',
            payment_url: `${mockBaseUrl}/payment/${unique()}`,
          })
        );
        return;
      }

      if (url.pathname === '/api/verify-payment') {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {
          body = {};
        }
        mock.verifyRequests.push({
          apiKey: req.headers['rt-uddoktapay-api-key'] || null,
          body,
        });
        const invoiceId = typeof body.invoice_id === 'string' ? body.invoice_id : '';
        const programmed = mock.verifications.get(invoiceId);
        if (programmed) {
          res.end(JSON.stringify(programmed));
          return;
        }
        res.end(JSON.stringify({ status: 'ERROR', message: 'Invoice not found' }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ status: 'ERROR' }));
    });
  });
  const mockPort = await listen(mockServer);
  mockBaseUrl = `http://127.0.0.1:${mockPort}`;
  config.payments.uddoktapay.apiKey = API_KEY;
  config.payments.uddoktapay.baseUrl = mockBaseUrl;

  const started = await listenApp(app);
  appServer = started.server;
  BASE_URL = `http://127.0.0.1:${started.port}`;
  config.payments.uddoktapay.publicUrl = BASE_URL;
});

after(async () => {
  await closeServer(appServer);
  await closeServer(mockServer);
  if (database) await database.closePool().catch(() => {});
});

/* ---------------------------------------------------------------- */
/* 26-27: admin manual verification settles payment + order          */
/* ---------------------------------------------------------------- */

test('[P-26..27] admin manual verification completes the payment and marks the order paid', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-manual');
  const admin = await adminSession();

  const res = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    {
      transactionId: 'BANK' + unique().toUpperCase().slice(0, 14),
      amount: String(order.amount),
      currency: 'BDT',
      note: 'checked against the bank statement',
    },
    admin
  );
  assert.equal(res.response.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.paid, true, 'order reported paid');
  assert.equal(res.body.data.orderStatus, 'paid');

  const row = await getPaymentRow(order.id);
  assert.equal(row.status, 'successful', 'payment completed');
  assert.equal(row.paid_at !== null, true);
  assert.equal((await getOrderRow(order.id)).status, 'paid', 'order paid');
  assert.equal(await countSuccessful(order.id), 1, 'single settlement');
});

/* ---------------------------------------------------------------- */
/* 28-29: authorization gates                                       */
/* ---------------------------------------------------------------- */

test('[P-28] signed-in non-admin customer cannot use either verification endpoint (403)', async () => {
  const customer = await registerUser('a47-cust');
  const { order, payment } = await setupAwaitingPayment('a47-custrow');

  const gateway = await adminPost(
    `/admin/payments/${payment.id}/verify-uddoktapay`,
    {},
    customer
  );
  assert.equal(gateway.response.status, 403);

  const manual = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    {
      transactionId: 'CUST' + unique().toUpperCase().slice(0, 12),
      amount: String(order.amount),
    },
    customer
  );
  assert.equal(manual.response.status, 403);

  const row = await getPaymentRow(order.id);
  assert.notEqual(row.status, 'successful');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
});

test('[P-29] anonymous requests to both verification endpoints are 401', async () => {
  const gateway = await postJson(`/admin/payments/${UUID_DONOTUSE}/verify-uddoktapay`, {});
  assert.equal(gateway.response.status, 401);
  assert.equal(gateway.body.error.code, 'UNAUTHORIZED');

  const manual = await postJson(`/admin/payments/${UUID_DONOTUSE}/manual-verify`, {
    transactionId: 'ANON1234',
    amount: '100.00',
  });
  assert.equal(manual.response.status, 401);
  assert.equal(manual.body.error.code, 'UNAUTHORIZED');
});

/* ---------------------------------------------------------------- */
/* 30-35: manual verification input validation                       */
/* ---------------------------------------------------------------- */

test('[P-30] wrong amount (or currency) is rejected - payment and order unchanged', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-amount');
  const admin = await adminSession();
  const trx = 'AMT' + unique().toUpperCase().slice(0, 12);

  const wrongAmount = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    { transactionId: trx, amount: '0.01' },
    admin
  );
  assert.equal(wrongAmount.response.status, 400);
  assert.equal(wrongAmount.body.error.code, 'PAYMENT_VERIFICATION_FAILED');

  const wrongCurrency = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    { transactionId: trx, amount: String(order.amount), currency: 'USD' },
    admin
  );
  assert.equal(wrongCurrency.response.status, 400);
  assert.equal(wrongCurrency.body.error.code, 'PAYMENT_VERIFICATION_FAILED');

  const row = await getPaymentRow(order.id);
  assert.notEqual(row.status, 'successful');
  assert.equal(row.status, 'pending', 'still open');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('[P-31] mismatched reference is rejected against a recorded gateway invoice', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-ref');
  const invoice = `INV${unique()}`;
  await recordInvoice(order, payment, invoice);
  const admin = await adminSession();

  const res = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    {
      transactionId: 'MISMATCH' + unique().toUpperCase().slice(0, 10),
      amount: String(order.amount),
    },
    admin
  );
  assert.equal(res.response.status, 409);
  assert.equal(res.body.error.code, 'PAYMENT_REFERENCE_MISMATCH');

  const row = await getPaymentRow(order.id);
  assert.notEqual(row.status, 'successful');
  assert.equal(row.provider_transaction_id, invoice, 'recorded invoice untouched');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('[P-32] duplicate transaction ID is rejected - another row already holds it', async () => {
  // Order A settles with invoice I...
  const a = await setupAwaitingPayment('a47-dupA');
  const invoice = `INV${unique()}`;
  await settleViaGateway(a.order, a.payment, invoice);
  assert.equal(await countSuccessful(a.order.id), 1);

  // ...order B is an open attempt with no invoice.
  const b = await setupAwaitingPayment('a47-dupB');
  const admin = await adminSession();

  const res = await adminPost(
    `/admin/payments/${b.payment.id}/manual-verify`,
    { transactionId: invoice, amount: String(b.order.amount) },
    admin
  );
  assert.equal(res.response.status, 409);
  assert.equal(res.body.error.code, 'DUPLICATE_TRANSACTION_ID');

  const rowB = await getPaymentRow(b.order.id);
  assert.notEqual(rowB.status, 'successful');
  assert.equal((await getOrderRow(b.order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(b.order.id), 0);
  // The first settlement is untouched.
  assert.equal(await countSuccessful(a.order.id), 1);
  assert.equal((await getOrderRow(a.order.id)).status, 'paid');
});

test('[P-33] an already-settled payment is an idempotent replay - never settled twice', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-replay');
  const invoice = `INV${unique()}`;
  const settled = await settleViaGateway(order, payment, invoice);
  const admin = await adminSession();

  // Manual verification against the completed row (matching reference).
  const manual = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    { transactionId: invoice, amount: String(order.amount) },
    admin
  );
  assert.equal(manual.response.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.data.replayed, true, 'replay, not a new settlement');

  const after = await getPaymentRow(order.id);
  assert.equal(await countSuccessful(order.id), 1, 'still one successful payment');
  assert.equal(
    new Date(after.paid_at).getTime(),
    new Date(settled.paid_at).getTime(),
    'paid_at untouched'
  );
  assert.equal((await getOrderRow(order.id)).status, 'paid');
});

test('[P-34] missing or malformed transaction reference is rejected', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-notrx');
  const admin = await adminSession();

  const missing = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    { amount: String(order.amount) },
    admin
  );
  assert.equal(missing.response.status, 400);
  assert.equal(missing.body.error.code, 'VALIDATION_ERROR');
  assert.ok(
    JSON.stringify(missing.body.error.details || []).includes(
      'Transaction ID must be 4 to 64 characters'
    )
  );

  const tooShort = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    { transactionId: 'ab', amount: String(order.amount) },
    admin
  );
  assert.equal(tooShort.response.status, 400);
  assert.equal(tooShort.body.error.code, 'VALIDATION_ERROR');

  const row = await getPaymentRow(order.id);
  assert.equal(row.status, 'pending', 'unchanged');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
});

test('[P-35] cross-origin request is rejected by the same-origin guard before any work', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-csrf');
  const admin = await adminSession();

  const evil = { Origin: 'https://evil.example' };
  const gateway = await adminPost(
    `/admin/payments/${payment.id}/verify-uddoktapay`,
    {},
    admin,
    evil
  );
  assert.equal(gateway.response.status, 403);
  assert.equal(gateway.body.error.code, 'CSRF_INVALID');

  const manual = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    {
      transactionId: 'CSRF' + unique().toUpperCase().slice(0, 12),
      amount: String(order.amount),
    },
    admin,
    evil
  );
  assert.equal(manual.response.status, 403);
  assert.equal(manual.body.error.code, 'CSRF_INVALID');

  const row = await getPaymentRow(order.id);
  assert.notEqual(row.status, 'successful');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
});

/* ---------------------------------------------------------------- */
/* 36-37: provenance on manual verification                          */
/* ---------------------------------------------------------------- */

test('[P-36..37] manual verification records source, admin identity, timestamp and note', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-prov');
  const admin = await adminSession();
  const note = 'matched the bank statement line';

  const res = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    {
      transactionId: 'PROV' + unique().toUpperCase().slice(0, 12),
      amount: String(order.amount),
      note,
    },
    admin
  );
  assert.equal(res.response.status, 200, JSON.stringify(res.body));

  const row = await getPaymentRow(order.id);
  assert.equal(row.metadata.verification_source, 'admin_manual', 'source');
  assert.equal(row.metadata.verified_by, admin.id, 'responsible admin identity');
  assert.ok(row.metadata.verified_at, 'verification timestamp');
  assert.equal(row.metadata.verification_note, note, 'admin note recorded');

  // The detail endpoint echoes the provenance to the payments UI.
  const detail = await adminGet(`/admin/payments/${payment.id}`, admin);
  assert.equal(detail.response.status, 200);
  const prov = detail.body.data.provenance;
  assert.equal(prov.source, 'admin_manual');
  assert.equal(prov.verifiedBy, admin.id);
  assert.ok(prov.verifiedAt);
  assert.equal(prov.note, note);
});

/* ---------------------------------------------------------------- */
/* 38: admin payment list                                            */
/* ---------------------------------------------------------------- */

test('[P-38] admin list: extended view shows every provider; legacy stays manual-only; filters validate', async () => {
  const admin = await adminSession();

  // One gateway attempt (open) + one manual Transaction ID submission.
  const gw = await setupAwaitingPayment('a47-list-gw');
  const mw = await registerUser('a47-list-mw');
  const mOrder = await createOrder(mw.cookie);
  const submit = await submitManualTrx(
    mw,
    mOrder,
    'LIST' + unique().toUpperCase().slice(0, 12)
  );
  assert.ok([200, 201].includes(submit.response.status), JSON.stringify(submit.body));
  const mPayment = await getPaymentRow(mOrder.id);

  // Extended view (explicit provider param).
  const extended = await adminGet('/admin/payments?provider=all&limit=50', admin);
  assert.equal(extended.response.status, 200);
  assert.equal(extended.body.success, true);
  const rows = extended.body.data.payments || [];
  const gwRow = rows.find((r) => r.id === gw.payment.id);
  assert.ok(gwRow, 'gateway attempt listed');
  assert.equal(gwRow.provider, 'uddoktapay');
  assert.equal(gwRow.status, 'pending');
  assert.ok(gwRow.orderNumber, 'order number present');
  assert.equal(gwRow.customer.email, gw.user.email, 'customer present');
  assert.ok(gwRow.amount);
  assert.ok(gwRow.updatedAt, 'updated timestamp present');
  assert.ok(Array.isArray(gwRow.availableActions), 'actions list present');
  assert.ok(
    gwRow.availableActions.includes('manual-verify'),
    'open gateway attempt exposes manual verification'
  );
  const mwRow = rows.find((r) => r.id === mPayment.id);
  assert.ok(mwRow, 'manual submission listed');
  assert.equal(mwRow.provider, 'manual');

  // Status + text filters in the extended view.
  const byStatus = await adminGet(
    '/admin/payments?provider=all&status=awaiting_verification&limit=50',
    admin
  );
  assert.equal(byStatus.response.status, 200);
  assert.ok(
    (byStatus.body.data.payments || []).some((r) => r.id === gw.payment.id),
    'status filter reaches gateway rows through the review alias'
  );
  const byOrder = await adminGet(
    '/admin/payments?provider=all&order=' + encodeURIComponent(gw.order.orderNumber),
    admin
  );
  assert.equal(byOrder.response.status, 200);
  assert.ok(
    (byOrder.body.data.payments || []).some((r) => r.id === gw.payment.id),
    'order filter finds the attempt'
  );

  // Validation: unknown provider / unknown query key are refused.
  const badProvider = await adminGet('/admin/payments?provider=stripe', admin);
  assert.equal(badProvider.response.status, 400);
  const badKey = await adminGet('/admin/payments?provider=all&nope=1', admin);
  assert.equal(badKey.response.status, 400);

  // Legacy view (no provider param) stays manual-only.
  const legacy = await adminGet('/admin/payments?limit=50', admin);
  assert.equal(legacy.response.status, 200);
  const legacyRows = legacy.body.data.payments || [];
  assert.ok(legacyRows.length > 0, 'manual submission listed');
  for (const row of legacyRows) {
    assert.equal(row.provider, 'manual', 'legacy view is manual-only');
  }
  assert.equal(
    legacyRows.some((r) => r.id === gw.payment.id),
    false,
    'gateway rows never leak into the legacy view'
  );
});

/* ---------------------------------------------------------------- */
/* 39: admin payment detail                                          */
/* ---------------------------------------------------------------- */

test('[P-39] payment detail carries order, customer and payment information', async () => {
  const { user, order, payment } = await setupAwaitingPayment('a47-detail');
  const admin = await adminSession();

  const res = await adminGet(`/admin/payments/${payment.id}`, admin);
  assert.equal(res.response.status, 200, JSON.stringify(res.body));
  const data = res.body.data;

  assert.equal(data.id, payment.id);
  assert.equal(data.orderNumber, order.orderNumber);
  assert.equal(data.order.status, 'awaiting_payment');
  assert.ok(data.order.amount !== undefined, 'order amount present');
  assert.equal(data.customer.email, user.email, 'customer email present');
  assert.ok(data.customer.id, 'customer id present');
  assert.equal(data.provider, 'uddoktapay');
  assert.equal(data.status, 'pending');
  assert.ok(data.amount !== undefined, 'payment amount present');
  assert.ok(data.currency);
  assert.ok(data.createdAt, 'created timestamp');
  assert.ok(data.updatedAt, 'updated timestamp');
  assert.ok(data.provenance && typeof data.provenance === 'object');
  assert.ok(Array.isArray(data.availableActions));
  // No session material ever leaves the server.
  const serialized = JSON.stringify(data);
  if (payment.provider_session_key) {
    assert.equal(
      serialized.includes(payment.provider_session_key),
      false,
      'gateway session URL is not part of the admin payload'
    );
  }
  assert.equal(serialized.includes(API_KEY), false, 'no API key in the payload');
});

/* ---------------------------------------------------------------- */
/* 40: eligible attempt exposes + honors Verify with UddoktaPay      */
/* ---------------------------------------------------------------- */

test('[P-40] eligible attempt exposes Verify with UddoktaPay and settles through the gateway', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-gwverify');
  const invoice = `INV${unique()}`;
  await recordInvoice(order, payment, invoice);
  const admin = await adminSession();

  // Detail + list both expose the automatic action.
  const detail = await adminGet(`/admin/payments/${payment.id}`, admin);
  assert.equal(detail.response.status, 200);
  assert.ok(
    detail.body.data.availableActions.includes('verify-uddoktapay'),
    'detail exposes Verify with UddoktaPay'
  );
  const list = await adminGet(
    '/admin/payments?provider=all&transaction=' + encodeURIComponent(invoice),
    admin
  );
  assert.equal(list.response.status, 200);
  const listed = (list.body.data.payments || []).find((r) => r.id === payment.id);
  assert.ok(listed, 'transaction filter finds the attempt');
  assert.ok(listed.availableActions.includes('verify-uddoktapay'));

  // The gateway flips to COMPLETED; the admin trigger asks the gateway.
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });
  const beforeCalls = verifyCalls(invoice).length;

  const res = await adminPost(
    `/admin/payments/${payment.id}/verify-uddoktapay`,
    {},
    admin
  );
  assert.equal(res.response.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.paid, true);
  assert.equal(res.body.data.orderStatus, 'paid');
  assert.equal(res.body.data.gatewayStatus, 'completed');

  const calls = verifyCalls(invoice);
  assert.equal(
    calls.length,
    beforeCalls + 1,
    'exactly one new gateway verification'
  );
  assert.equal(calls[calls.length - 1].apiKey, API_KEY, 'gateway asked with the key');

  const row = await getPaymentRow(order.id);
  assert.equal(row.status, 'successful');
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  assert.equal(await countSuccessful(order.id), 1);
  assert.equal(
    row.metadata.verification_source,
    'uddoktapay_auto',
    'automatic provenance'
  );
  assert.equal(row.metadata.verified_by, admin.id, 'triggering admin recorded');
});

/* ---------------------------------------------------------------- */
/* 41: eligible unpaid attempt exposes Manual Verification           */
/* ---------------------------------------------------------------- */

test('[P-41] open gateway attempt exposes Manual Verification (and no gateway action without an invoice)', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-manual-elig');
  const admin = await adminSession();

  const detail = await adminGet(`/admin/payments/${payment.id}`, admin);
  assert.equal(detail.response.status, 200);
  const actions = detail.body.data.availableActions;
  assert.ok(actions.includes('manual-verify'), 'manual verification exposed');
  assert.equal(
    actions.includes('verify-uddoktapay'),
    false,
    'no gateway action without a recorded invoice'
  );

  const list = await adminGet(
    '/admin/payments?provider=all&order=' + encodeURIComponent(order.orderNumber),
    admin
  );
  const listed = (list.body.data.payments || []).find((r) => r.id === payment.id);
  assert.ok(listed);
  assert.ok(listed.availableActions.includes('manual-verify'));
  assert.equal(listed.availableActions.includes('verify-uddoktapay'), false);
});

/* ---------------------------------------------------------------- */
/* 42: a completed payment cannot be settled a second time           */
/* ---------------------------------------------------------------- */

test('[P-42] completed payment: gateway replay only, manual replay only, legacy route stays locked', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-once');
  const invoice = `INV${unique()}`;
  const settled = await settleViaGateway(order, payment, invoice);
  const admin = await adminSession();

  // (a) automatic: replay without any new settlement, no second gateway call.
  const callsBefore = verifyCalls(invoice).length;
  const auto = await adminPost(
    `/admin/payments/${payment.id}/verify-uddoktapay`,
    {},
    admin
  );
  assert.equal(auto.response.status, 200, JSON.stringify(auto.body));
  assert.equal(auto.body.data.replayed, true, 'idempotent replay');
  assert.equal(auto.body.data.paid, true);
  assert.equal(
    verifyCalls(invoice).length,
    callsBefore,
    'replay never re-asks the gateway'
  );
  assert.equal(await countSuccessful(order.id), 1);
  assert.equal((await getOrderRow(order.id)).status, 'paid');

  // (b) manual: also a replay - no second settlement.
  const manual = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    { transactionId: invoice, amount: String(order.amount) },
    admin
  );
  assert.equal(manual.response.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.data.replayed, true);
  assert.equal(await countSuccessful(order.id), 1, 'still one settlement');
  const after = await getPaymentRow(order.id);
  assert.equal(
    new Date(after.paid_at).getTime(),
    new Date(settled.paid_at).getTime(),
    'paid_at untouched'
  );
  assert.equal((await getOrderRow(order.id)).status, 'paid');

  // (c) the legacy review route can never flip a gateway row.
  const legacy = await adminPost(`/admin/payments/${payment.id}/verify`, {}, admin);
  assert.equal(legacy.response.status, 409);
  assert.equal(legacy.body.error.code, 'PAYMENT_NOT_MANUAL');
  assert.equal(await countSuccessful(order.id), 1);
});

/* ---------------------------------------------------------------- */
/* 43: no arbitrary "mark paid" endpoint                             */
/* ---------------------------------------------------------------- */

test('[P-43] no route or client input can arbitrarily mark an order paid', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-noarbit');
  const admin = await adminSession();

  // Fabricated endpoints simply do not exist.
  const adminMark = await adminPost(
    `/admin/payments/${payment.id}/mark-paid`,
    {},
    admin
  );
  assert.equal(adminMark.response.status, 404);
  const userMark = await postJson(`/payments/${payment.id}/mark-paid`, {});
  assert.equal(userMark.response.status, 404);
  const orderMark = await adminPost(`/admin/orders/${order.id}/mark-paid`, {}, admin);
  assert.equal(orderMark.response.status, 404);

  // Nothing changed.
  assert.equal((await getPaymentRow(order.id)).status, 'pending');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);

  // The settlement path is never routed, and no state flag is read from a body.
  const routesDir = path.join(ROOT_DIR, 'backend/src/routes');
  for (const file of fs.readdirSync(routesDir)) {
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    assert.doesNotMatch(
      src,
      /markOrderPaid|mark-paid/,
      `${file} must not expose a settlement shortcut`
    );
  }
  for (const file of [
    'paymentController.js',
    'adminController.js',
    'orderController.js',
  ]) {
    const src = fs.readFileSync(
      path.join(ROOT_DIR, 'backend/src/controllers', file),
      'utf8'
    );
    assert.doesNotMatch(
      src,
      /req\.body\.(status|paid|verified|orderStatus)|body\.(paid|verified|orderStatus)/,
      `${file} never trusts a status flag from the client`
    );
  }

  // The browser only ever sends ids - never money or state.
  const checkoutJs = fs.readFileSync(
    path.join(FRONTEND_DIR, 'js/checkout.js'),
    'utf8'
  );
  const placeIdx = checkoutJs.indexOf('async function placeOrder');
  const proceedIdx = checkoutJs.indexOf('async function proceedToPayment');
  const place = checkoutJs.slice(placeIdx, proceedIdx);
  assert.doesNotMatch(
    place,
    /JSON\.stringify\(\{[^}]*\b(amount|status|currency|paid)\b/,
    'order creation carries no money or state'
  );
  const payBodyIdx = checkoutJs.indexOf(
    'body: JSON.stringify({ orderId: state.order.id })'
  );
  assert.ok(payBodyIdx > proceedIdx, 'payment creation carries only the order id');
  assert.equal(
    checkoutJs.includes('"mark-paid"') || checkoutJs.includes("'mark-paid'"),
    false,
    'no mark-paid call in the browser'
  );
});

/* ---------------------------------------------------------------- */
/* 44: an invoice-recorded attempt keeps BOTH review actions         */
/* ---------------------------------------------------------------- */

test('[P-44] attempt with a recorded invoice exposes gateway AND manual verification', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-both-actions');
  const admin = await adminSession();
  const invoice = `INV${unique()}`;
  await recordInvoice(order, payment, invoice);

  const detail = await adminGet(`/admin/payments/${payment.id}`, admin);
  assert.equal(detail.response.status, 200);
  const detailActions = detail.body.data.availableActions;
  assert.ok(
    detailActions.includes('verify-uddoktapay'),
    'gateway action exposed: ' + JSON.stringify(detailActions)
  );
  assert.ok(
    detailActions.includes('manual-verify'),
    'manual fallback exposed: ' + JSON.stringify(detailActions)
  );

  const list = await adminGet(
    '/admin/payments?provider=all&order=' + encodeURIComponent(order.orderNumber),
    admin
  );
  const listed = (list.body.data.payments || []).find(
    (r) => r.id === payment.id
  );
  assert.ok(listed, 'attempt listed');
  assert.ok(listed.availableActions.includes('verify-uddoktapay'));
  assert.ok(
    listed.availableActions.includes('manual-verify'),
    'the list payload offers the manual fallback'
  );

  // The gateway attempt is settled through the fallback that the row must
  // actually render — the UI may never hide an action the API offers.
  const settle = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    { transactionId: invoice, amount: String(order.amount) },
    admin
  );
  assert.equal(settle.response.status, 200, JSON.stringify(settle.body));
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  assert.equal(await countSuccessful(order.id), 1);
});

/* ---------------------------------------------------------------- */
/* 45: manual verification is visible to the customer               */
/* ---------------------------------------------------------------- */

test('[P-45] manual verification settles payment + order and the customer sees the order paid', async () => {
  const { user, order, payment } = await setupAwaitingPayment('a47-customer-sees');
  const admin = await adminSession();

  // Customer sees the order unpaid before the admin acts.
  const before = await api(`/orders/${order.id}`, {
    headers: { Cookie: user.cookie, Accept: 'application/json' },
  });
  assert.equal(before.response.status, 200, JSON.stringify(before.body));
  assert.notEqual(before.body.data.status, 'paid');

  const res = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    {
      transactionId: `SEED${unique().toUpperCase().slice(0, 10)}`,
      amount: String(order.amount),
      currency: order.currency,
      note: 'customer must see paid',
    },
    admin
  );
  assert.equal(res.response.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.orderStatus, 'paid');
  assert.equal(res.body.data.paid, true);

  const row = await getPaymentRow(order.id);
  assert.equal(row.status, 'successful');
  assert.equal(row.metadata.verification_source, 'admin_manual');
  assert.equal(row.metadata.verified_by, admin.id);
  assert.ok(row.metadata.verified_at, 'verification timestamp recorded');
  assert.equal(row.metadata.verification_note, 'customer must see paid');
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  assert.equal(await countSuccessful(order.id), 1);

  // Customer view after settlement.
  const after = await api(`/orders/${order.id}`, {
    headers: { Cookie: user.cookie, Accept: 'application/json' },
  });
  assert.equal(after.response.status, 200, JSON.stringify(after.body));
  assert.equal(
    after.body.data.status,
    'paid',
    'customer sees the order paid'
  );

  const payView = await api(`/payments/order/${order.id}`, {
    headers: { Cookie: user.cookie, Accept: 'application/json' },
  });
  assert.equal(payView.response.status, 200, JSON.stringify(payView.body));
  assert.equal(payView.body.data.order.status, 'paid');
  assert.equal(await countSuccessful(order.id), 1, 'still exactly one settlement');
});

/* ---------------------------------------------------------------- */
/* 46: a refunded attempt is never eligible again                   */
/* ---------------------------------------------------------------- */

test('[P-46] refunded attempt: no manual action offered, endpoint refuses 409', async () => {
  const { order, payment } = await setupAwaitingPayment('a47-refunded');
  const admin = await adminSession();
  await pool.query(
    `UPDATE payment_transactions SET status = 'refunded' WHERE id = $1`,
    [payment.id]
  );

  const detail = await adminGet(`/admin/payments/${payment.id}`, admin);
  assert.equal(detail.response.status, 200);
  assert.equal(
    detail.body.data.availableActions.includes('manual-verify'),
    false,
    'refunded attempt never offers manual verification'
  );

  const res = await adminPost(
    `/admin/payments/${payment.id}/manual-verify`,
    {
      transactionId: `REF${unique().toUpperCase().slice(0, 10)}`,
      amount: String(order.amount),
    },
    admin
  );
  assert.equal(res.response.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'PAYMENT_STATE_CONFLICT');

  const row = await getPaymentRow(order.id);
  assert.equal(row.status, 'refunded', 'state untouched');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0, 'nothing settled');
});

/* ---------------------------------------------------------------- */
/* 47: the admin UI never hides an offered action, and confirms     */
/*     only after the panel refresh has cleared the message node    */
/* ---------------------------------------------------------------- */

test('[P-47] admin payments UI renders every offered action and confirms after the refresh', () => {
  const src = fs.readFileSync(
    path.join(FRONTEND_DIR, 'admin/js/admin-payments.js'),
    'utf8'
  );

  // Row renderer: offer manual verification whenever the API marks it, never
  // gated behind "no other action is available".
  const rowStart = src.indexOf('function appendRowActions');
  assert.ok(rowStart > -1, 'appendRowActions present');
  const rowEnd = src.indexOf('function appendRow(', rowStart);
  assert.ok(rowEnd > rowStart, 'appendRow located');
  const rowSrc = src.slice(rowStart, rowEnd);
  assert.match(rowSrc, /if \(canManual\)/, 'row renders the manual action');
  assert.doesNotMatch(
    rowSrc,
    /canManual\s*&&/,
    'the row must not hide an action the server offered'
  );

  // Confirmation must be written after refreshAfterAction(), which clears the
  // message node it would otherwise wipe.
  const sliceFunction = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start > -1, `${name} present`);
    const rest = src.slice(start + 1);
    const next = rest.match(/\n  (?:async )?function \w+\(/);
    return src.slice(start, next ? start + 1 + next.index : src.length);
  };
  const expectRefreshFirst = (name, setter) => {
    const body = sliceFunction(name);
    const refresh = body.indexOf('await refreshAfterAction(');
    assert.ok(refresh > -1, `${name} refreshes the panel`);
    const confirm = body.lastIndexOf(setter);
    assert.ok(confirm > refresh, `${name} confirms after the refresh`);
  };
  expectRefreshFirst('manualVerify', 'setDetailMessage(');
  expectRefreshFirst('reviewPayment', 'FA.setStatus(');
  expectRefreshFirst('gatewayVerify', 'FA.setStatus(');
});
