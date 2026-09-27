const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { before, after } = require('node:test');

// PART P — Dual verification, automatic side (spec tests 20-25). In-process
// app against a local Uddoktapay mock: no real credentials, no live payments,
// no external network. The gateway's Verify Payment API is the only authority
// that can ever settle an order.
const config = require('../src/config');
const API_KEY = 'mock-uddokta-key-do-not-leak';

config.rateLimit.registerMax = 500;
config.rateLimit.loginMax = 500;
config.rateLimit.orderCreateMax = 500;
config.rateLimit.paymentCreateMax = 500;
config.payments.provider = 'uddoktapay';

const app = require('../src/app');

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

// Gateway-style browser return: no redirect following so the 302 Location
// can be inspected.
function getCallback(pathname, query = {}) {
  const url = new URL(`${BASE_URL}/api${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return fetch(url, { redirect: 'manual' });
}

async function registerUser(prefix = 'v47') {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Ver',
    lastName: 'Ifier',
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

async function initiatePayment(cookie, orderId) {
  return postJson('/payments', { orderId }, { Cookie: cookie });
}

async function getPaymentRow(orderId) {
  const { rows } = await pool.query(
    `SELECT id, status, provider, provider_transaction_id, provider_session_key,
            validation_id, bank_transaction_id, amount::text AS amount, currency,
            metadata, failed_at, paid_at, created_at, updated_at
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
    full_name: 'Ver Ifier',
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

// Initiate against a live mock gateway and return { user, order, payment }.
async function setupAwaitingPayment(prefix) {
  const user = await registerUser(prefix);
  const order = await createOrder(user.cookie);
  const init = await initiatePayment(user.cookie, order.id);
  assert.equal(init.response.status, 201, JSON.stringify(init.body));
  const payment = await getPaymentRow(order.id);
  assert.ok(payment, 'payment row recorded');
  return { user, order, init: init.body.data, payment };
}

function webhookHeaders(key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key !== undefined) headers['RT-UDDOKTAPAY-API-KEY'] = key;
  return headers;
}

function verifyCalls(invoiceId) {
  return mock.verifyRequests.filter((r) => r.body.invoice_id === invoiceId);
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

/* ------------------------------------------------------------------ */
/* 20: COMPLETED → payment completed + order paid                       */
/* ------------------------------------------------------------------ */

test('[P-20] gateway COMPLETED settles the payment and marks the order paid', async () => {
  const { order, payment } = await setupAwaitingPayment('v47-done');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const res = await getCallback('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location') || '';
  assert.ok(location.startsWith('/payment-success.html?order='), location);

  const row = await getPaymentRow(order.id);
  assert.equal(row.status, 'successful', 'payment completed');
  assert.equal(row.paid_at !== null, true);
  assert.equal(row.provider_transaction_id, invoice, 'invoice recorded');
  assert.equal(
    row.metadata.verification_source,
    'uddoktapay_auto',
    'automatic provenance recorded on settlement'
  );
  assert.equal((await getOrderRow(order.id)).status, 'paid', 'order paid');
  assert.equal(await countSuccessful(order.id), 1);

  // The gateway's Verify Payment API was the authority.
  const calls = verifyCalls(invoice);
  assert.ok(calls.length >= 1, 'gateway was asked');
  assert.equal(calls[0].apiKey, API_KEY);
});

/* ------------------------------------------------------------------ */
/* 21: PENDING → remains unpaid                                         */
/* ------------------------------------------------------------------ */

test('[P-21] gateway PENDING keeps the payment and order unpaid (invoice recorded)', async () => {
  const { order, payment } = await setupAwaitingPayment('v47-pend');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    status: 'PENDING',
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const res = await getCallback('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get('location') || '').startsWith('/payment-failed.html'),
    res.headers.get('location')
  );

  const row = await getPaymentRow(order.id);
  assert.notEqual(row.status, 'successful');
  assert.equal(row.status, payment.status, 'still open');
  assert.equal(row.provider_transaction_id, invoice, 'invoice is remembered');
  assert.equal(row.paid_at, null);
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

/* ------------------------------------------------------------------ */
/* 22: ERROR → payment attempt fails, order stays unpaid                */
/* ------------------------------------------------------------------ */

test('[P-22] gateway ERROR fails the attempt but never pays the order', async () => {
  const { order, payment } = await setupAwaitingPayment('v47-err');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    status: 'ERROR',
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const res = await getCallback('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get('location') || '').startsWith('/payment-failed.html'),
    res.headers.get('location')
  );

  const row = await getPaymentRow(order.id);
  assert.equal(row.status, 'failed', 'attempt failed');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

/* ------------------------------------------------------------------ */
/* 23: repeated UddoktaPay verification is idempotent                   */
/* ------------------------------------------------------------------ */

test('[P-23] repeated verification of the same invoice is idempotent — one settlement', async () => {
  const { user, order, payment } = await setupAwaitingPayment('v47-replay');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const first = await getCallback('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(first.status, 302);
  const settled = await getPaymentRow(order.id);
  assert.equal(settled.status, 'successful');
  assert.equal(await countSuccessful(order.id), 1);
  assert.equal((await getOrderRow(order.id)).status, 'paid');

  // Replays: the browser return, the same verification a second time.
  const beforeCalls = verifyCalls(invoice).length;
  const replay = await getCallback('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(replay.status, 302);
  assert.ok(
    (replay.headers.get('location') || '').startsWith('/payment-success.html'),
    replay.headers.get('location')
  );

  const after = await getPaymentRow(order.id);
  assert.equal(await countSuccessful(order.id), 1, 'no second settlement');
  assert.equal(
    new Date(after.paid_at).getTime(),
    new Date(settled.paid_at).getTime(),
    'paid_at untouched'
  );
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  assert.ok(
    verifyCalls(invoice).length > beforeCalls,
    'each replay re-verifies against the gateway (server authority)'
  );

  // A paid order accepts no new payment attempts.
  const again = await initiatePayment(user.cookie, order.id);
  assert.equal(again.response.status, 409);
  assert.equal(again.body.error.code, 'ORDER_NOT_PAYABLE');
});

/* ------------------------------------------------------------------ */
/* 24: repeated webhook is idempotent                                   */
/* ------------------------------------------------------------------ */

test('[P-24] repeated webhook delivers the same result — one settlement', async () => {
  const { order, payment } = await setupAwaitingPayment('v47-hook');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const payload = {
    full_name: 'Ver Ifier',
    email: 'wh@example.com',
    amount: String(order.amount),
    invoice_id: invoice,
    metadata: { payment_id: payment.id, order_id: order.id },
    payment_method: 'bkash',
    transaction_id: 'TXNP47',
    status: 'COMPLETED',
  };

  const first = await postJson('/payments/webhook/uddoktapay', payload, webhookHeaders(API_KEY));
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.body.data, { received: true, paid: true });
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  assert.equal(await countSuccessful(order.id), 1);
  const settled = await getPaymentRow(order.id);
  assert.equal(settled.status, 'successful');

  const second = await postJson('/payments/webhook/uddoktapay', payload, webhookHeaders(API_KEY));
  assert.equal(second.response.status, 200);
  assert.deepEqual(second.body.data, { received: true, paid: true });
  assert.equal(await countSuccessful(order.id), 1, 'no double payment');
  const after = await getPaymentRow(order.id);
  assert.equal(
    new Date(after.paid_at).getTime(),
    new Date(settled.paid_at).getTime(),
    'paid_at untouched'
  );
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  assert.ok(verifyCalls(invoice).length >= 2, 'webhook re-verifies server-side');
});

/* ------------------------------------------------------------------ */
/* 25: browser success URL alone cannot mark paid                       */
/* ------------------------------------------------------------------ */

test('[P-25] browser success URL without an invoice never marks anything paid', async () => {
  const { order, payment } = await setupAwaitingPayment('v47-browser');
  const beforeCalls = mock.verifyRequests.length;

  const res = await getCallback('/payments/uddoktapay/success', {});
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get('location') || '').startsWith('/payment-failed.html'),
    res.headers.get('location')
  );

  const row = await getPaymentRow(order.id);
  assert.equal(row.status, payment.status, 'no state change');
  assert.equal(row.paid_at, null);
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
  assert.equal(
    mock.verifyRequests.length,
    beforeCalls,
    'no verification without an invoice'
  );
});
