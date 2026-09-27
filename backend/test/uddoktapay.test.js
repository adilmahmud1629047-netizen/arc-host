const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { before, after } = require('node:test');

const config = require('../src/config');

// This file runs an in-process app configured as a Uddoktapay integration
// against a local mock gateway — no real credentials, no live payments, no
// external network (PHASE 15 local test mode). Config is mutated BEFORE the
// app loads so route-level rate limiters pick up raised limits. The external
// test server keeps PAYMENT_PROVIDER=disabled (other suites cover that path).
const API_KEY = 'mock-uddokta-key-do-not-leak';

config.rateLimit.registerMax = 500;
config.rateLimit.loginMax = 500;
config.rateLimit.orderCreateMax = 500;
config.rateLimit.paymentCreateMax = 500;
config.rateLimit.sslcommerzCallbackMax = 500;
config.payments.provider = 'uddoktapay';

const app = require('../src/app');

let BASE_URL = null;
let mockBaseUrl = null;
let appServer = null;
let mockServer = null;
let database = null;
let pool = null;

const mock = {
  initMode: 'success', // 'success' | 'failed' | 'evil' | 'http500'
  initRequests: [],
  verifyRequests: [],
  verifications: new Map(), // invoice_id -> verify response payload
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

// Gateway-style browser return: query or form POST, no redirect following so
// the 302 Location can be inspected.
function getCallback(pathname, query = {}) {
  const url = new URL(`${BASE_URL}/api${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return fetch(url, { redirect: 'manual' });
}

function postForm(pathname, fields, headers = {}) {
  const body = new URLSearchParams(fields).toString();
  return fetch(`${BASE_URL}/api${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body,
    redirect: 'manual',
  });
}

async function registerUser(prefix = 'ud') {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Uddok',
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

async function initiatePayment(cookie, orderId, payload = {}, headers = {}) {
  return postJson('/payments', { orderId, ...payload }, { Cookie: cookie, ...headers });
}

async function getPaymentRow(orderId) {
  const { rows } = await pool.query(
    `SELECT id, status, provider, provider_transaction_id, provider_session_key,
            validation_id, bank_transaction_id, amount::text AS amount, currency,
            metadata, failed_at, paid_at
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

// Program the Verify Payment API answer for one invoice_id (docs shape).
function programVerify(invoiceId, fields) {
  mock.verifications.set(invoiceId, {
    full_name: 'Uddok Tester',
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

// Initiate and return { user, order, payment row } with a live mock gateway.
async function setupAwaitingPayment(prefix) {
  const user = await registerUser(prefix);
  const order = await createOrder(user.cookie);
  const init = await initiatePayment(user.cookie, order.id);
  assert.equal(init.response.status, 201, JSON.stringify(init.body));
  const payment = await getPaymentRow(order.id);
  assert.ok(payment, 'payment row recorded');
  return { user, order, init: init.body.data, payment };
}

async function promoteAdmin(email) {
  await pool.query(
    `UPDATE users SET role = 'admin', status = 'active' WHERE email = $1`,
    [email]
  );
}

async function adminSession(prefix = 'ud-admin') {
  const session = await registerUser(prefix);
  await promoteAdmin(session.email);
  return session;
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

  // Mock Uddoktapay API: Create Charge + Verify Payment (docs endpoints).
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

// ---------- Architecture / configuration ----------

test('provider registry exposes uddoktapay; disabled/sslcommerz intact; unknown stay unregistered', () => {
  const { getProvider } = require('../src/services/payments/paymentProvider');
  const provider = getProvider('uddoktapay');
  assert.ok(provider, 'uddoktapay provider must be registered');
  assert.equal(provider.name, 'uddoktapay');
  assert.ok(getProvider('disabled'));
  assert.ok(getProvider('sslcommerz'));
  assert.equal(getProvider('stripe'), null);
  assert.equal(getProvider(''), null);
  assert.equal(getProvider(undefined), null);
});

test('env placeholders exist, are empty, and no gateway secret is hardcoded anywhere', () => {
  const root = path.join(__dirname, '../..');
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(example, /^UDDOKTAPAY_API_URL=$/m);
  assert.match(example, /^UDDOKTAPAY_API_KEY=$/m);
  assert.match(example, /^PAYMENT_PROVIDER=disabled$/m);

  // The public sandbox API key from the docs must never be committed.
  // (Assembled at runtime so this very file does not match its own scan.)
  const docKey = ['982d3813', '60a69d419689740d9f2e26ce36fb7a50'].join('');
  const scanDirs = [
    path.join(root, 'backend/src'),
    path.join(root, 'backend/test'),
    path.join(root, 'frontend'),
  ];
  for (const dir of scanDirs) {
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!/\.(js|cjs|html|css|json)$/.test(entry.name)) continue;
        const content = fs.readFileSync(full, 'utf8');
        assert.equal(
          content.includes(docKey),
          false,
          `docs sandbox API key leaked in ${full}`
        );
      }
    }
  }

  // Browser code never references the secret env var name.
  const checkoutJs = fs.readFileSync(
    path.join(root, 'frontend/js/checkout.js'),
    'utf8'
  );
  assert.equal(/UDDOKTAPAY_API_KEY/.test(checkoutJs), false);
});

test('GET /api/payments/provider is public and returns the provider name + exact trusted gateway host', async () => {
  const { response, body } = await api('/payments/provider');
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(
    Object.keys(body.data).sort(),
    ['gatewayHost', 'provider'],
    'provider name + exact gateway host only'
  );
  assert.equal(body.data.provider, config.payments.provider);
  // Host only — the same env-derived host the server-side redirect trust
  // check (isTrustedPaymentUrl) compares against. No scheme, no path.
  assert.equal(
    body.data.gatewayHost,
    new URL(config.payments.uddoktapay.baseUrl).host.toLowerCase()
  );
  assert.equal(/^[^/]+$/.test(body.data.gatewayHost), true, 'host, never a URL');
  const raw = JSON.stringify(body).toLowerCase();
  assert.equal(raw.includes('http'), false, 'no URLs leak');
  assert.equal(raw.includes('key'), false, 'no key material leaks');
  assert.equal(raw.includes('secret'), false, 'no secrets leak');

  // Unconfigured gateway base URL → no host is advertised at all.
  const savedBase = config.payments.uddoktapay.baseUrl;
  config.payments.uddoktapay.baseUrl = '';
  try {
    const bare = await api('/payments/provider');
    assert.deepEqual(Object.keys(bare.body.data), ['provider'], 'no host when unconfigured');
  } finally {
    config.payments.uddoktapay.baseUrl = savedBase;
  }
});

test('checkout frontend: UddoktaPay-only payment UI and automatic gateway redirect', () => {
  const root = path.join(__dirname, '../..');
  const js = fs.readFileSync(path.join(root, 'frontend/js/checkout.js'), 'utf8');

  // discovers the active provider from the public endpoint
  assert.ok(js.includes('"/api/payments/provider"'), 'fetches active provider');
  assert.ok(
    js.includes('state.provider === "uddoktapay"'),
    'gates on the active provider name'
  );

  // legacy bKash / manual Transaction ID UI is hidden under uddoktapay
  const gateIdx = js.indexOf('function updatePaymentMethods');
  assert.ok(gateIdx > 0, 'updatePaymentMethods exists');
  const gate = js.slice(gateIdx, js.indexOf('function setManualStatus'));
  assert.ok(gate.includes('isUddoktaPay()'), 'method list is provider-gated');
  assert.ok(gate.includes('bkashPayBtn.hidden'), 'bKash button gated');
  assert.ok(gate.includes('manualCard.hidden'), 'manual section gated');
  assert.ok(gate.includes('confirmNoticeEl.hidden'), 'manual notice gated');

  // Place Order chains into payment creation and redirects to the server URL
  const placeIdx = js.indexOf('async function placeOrder');
  assert.ok(placeIdx > 0, 'placeOrder exists');
  const place = js.slice(placeIdx, js.indexOf('async function proceedToPayment'));
  assert.ok(place.includes('await fetchPaymentProvider()'), 'provider resolved first');
  assert.ok(
    place.includes('isUddoktaPay() &&') && place.includes('proceedToPayment()'),
    'auto-chain only under the uddoktapay gate'
  );
  assert.ok(
    js.includes('window.location.href = body.data.gatewayUrl'),
    'redirect target is the server-provided gateway URL'
  );

  // no credentials in browser code
  assert.equal(/UDDOKTAPAY_API_KEY|RT-UDDOKTAPAY/i.test(js), false);
});

// ---------- Payment creation (PHASE 4) ----------

test('unauthenticated customer cannot create a payment', async () => {
  const user = await registerUser('ud-anon');
  const order = await createOrder(user.cookie);
  const { response, body } = await postJson('/payments', { orderId: order.id });
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
  assert.equal(await countSuccessful(order.id), 0);
});

test("customer cannot pay another customer's order", async () => {
  const owner = await registerUser('ud-owner');
  const order = await createOrder(owner.cookie);
  const attacker = await registerUser('ud-attacker');
  const { response, body } = await initiatePayment(attacker.cookie, order.id);
  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'ORDER_NOT_FOUND');
  const row = await getOrderRow(order.id);
  assert.equal(row.status, 'awaiting_payment');
});

test('create request is built from the DB amount and official docs fields; response leaks nothing', async () => {
  const before = mock.initRequests.length;
  const user = await registerUser('ud-create');
  const order = await createOrder(user.cookie);
  const orderRow = await getOrderRow(order.id);

  const init = await initiatePayment(user.cookie, order.id);
  assert.equal(init.response.status, 201, JSON.stringify(init.body));
  assert.deepEqual(
    Object.keys(init.body.data).sort(),
    ['gatewayUrl', 'paymentId'],
    'only safe fields reach the browser'
  );
  assert.ok(
    init.body.data.gatewayUrl.startsWith(`${mockBaseUrl}/payment/`),
    'gateway URL comes from the create response'
  );

  assert.equal(mock.initRequests.length, before + 1);
  const sent = mock.initRequests[mock.initRequests.length - 1];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.apiKey, API_KEY, 'RT-UDDOKTAPAY-API-KEY header required');
  assert.match(sent.contentType, /application\/json/);
  assert.equal(sent.body.full_name, 'Uddok Tester');
  assert.equal(sent.body.email, user.email);
  assert.equal(
    sent.body.amount,
    String(orderRow.amount),
    'amount must come from the database, not the browser'
  );
  assert.deepEqual(sent.body.metadata, {
    payment_id: init.body.data.paymentId,
    order_id: order.id,
  });
  assert.equal(
    sent.body.redirect_url,
    `${BASE_URL}/api/payments/uddoktapay/success`
  );
  assert.equal(sent.body.return_type, 'GET');
  assert.equal(
    sent.body.cancel_url,
    `${BASE_URL}/api/payments/uddoktapay/cancel`
  );
  assert.equal(
    sent.body.webhook_url,
    `${BASE_URL}/api/payments/webhook/uddoktapay`
  );

  const payment = await getPaymentRow(order.id);
  assert.equal(payment.provider, 'uddoktapay');
  assert.equal(payment.status, 'pending');
  assert.equal(payment.provider_session_key, init.body.data.gatewayUrl);
  assert.equal(payment.metadata && typeof payment.metadata, 'object');
  assert.equal(
    JSON.stringify(payment.metadata).includes(API_KEY),
    false,
    'never store the API key on a payment row'
  );
});

test('client-supplied amount/currency/status/provider are rejected before any gateway call', async () => {
  const before = mock.initRequests.length;
  const user = await registerUser('ud-inject');
  const order = await createOrder(user.cookie);

  const cases = [
    { orderId: order.id, amount: '0.01' },
    { orderId: order.id, currency: 'USD' },
    { orderId: order.id, status: 'successful' },
    { orderId: order.id, provider: 'stripe' },
  ];
  for (const payload of cases) {
    const { response, body } = await initiatePayment(user.cookie, order.id, payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(mock.initRequests.length, before, 'no gateway request was sent');
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM payment_transactions WHERE order_id = $1',
    [order.id]
  );
  assert.equal(rows[0].n, 0, 'rejected payloads created nothing');
});

// ---------- Configuration / provider failures (PHASE 13) ----------

test('missing Uddoktapay configuration fails safely with 503 and never calls the gateway', async () => {
  const before = mock.initRequests.length;
  const saved = {
    apiKey: config.payments.uddoktapay.apiKey,
    baseUrl: config.payments.uddoktapay.baseUrl,
    publicUrl: config.payments.uddoktapay.publicUrl,
  };
  try {
    for (const key of ['apiKey', 'baseUrl', 'publicUrl']) {
      config.payments.uddoktapay[key] = '';
      const user = await registerUser('ud-nocfg');
      const order = await createOrder(user.cookie);
      const { response, body } = await initiatePayment(user.cookie, order.id);
      assert.equal(response.status, 503, key);
      assert.equal(body.error.code, 'PAYMENT_PROVIDER_NOT_CONFIGURED', key);
      assert.equal(
        body.error.message,
        'Payment processing is not available yet.',
        key
      );
      const row = await getOrderRow(order.id);
      assert.equal(row.status, 'awaiting_payment', key);
    }
  } finally {
    config.payments.uddoktapay.apiKey = saved.apiKey;
    config.payments.uddoktapay.baseUrl = saved.baseUrl;
    config.payments.uddoktapay.publicUrl = saved.publicUrl;
  }
  assert.equal(mock.initRequests.length, before, 'gateway never called');
});

test('gateway HTTP failure → 502 PAYMENT_PROVIDER_ERROR; order untouched; no upstream details leak', async () => {
  mock.initMode = 'http500';
  try {
    const user = await registerUser('ud-500');
    const order = await createOrder(user.cookie);
    const { response, body } = await initiatePayment(user.cookie, order.id);
    assert.equal(response.status, 502);
    assert.equal(body.error.code, 'PAYMENT_PROVIDER_ERROR');
    const raw = JSON.stringify(body).toLowerCase();
    assert.equal(raw.includes('internal error'), false);
    assert.equal(raw.includes('stack'), false);
    const row = await getOrderRow(order.id);
    assert.equal(row.status, 'awaiting_payment');
    const payment = await getPaymentRow(order.id);
    assert.notEqual(payment.status, 'successful');
  } finally {
    mock.initMode = 'success';
  }
});

test('gateway error response → 502; untrusted payment_url is never returned to the browser', async () => {
  mock.initMode = 'failed';
  try {
    const user = await registerUser('ud-reject');
    const order = await createOrder(user.cookie);
    const { response, body } = await initiatePayment(user.cookie, order.id);
    assert.equal(response.status, 502);
    assert.equal(body.error.code, 'PAYMENT_PROVIDER_ERROR');
  } finally {
    mock.initMode = 'success';
  }

  mock.initMode = 'evil';
  try {
    const user = await registerUser('ud-evil');
    const order = await createOrder(user.cookie);
    const { response, body } = await initiatePayment(user.cookie, order.id);
    assert.equal(response.status, 502);
    assert.equal(body.error.code, 'PAYMENT_PROVIDER_ERROR');
    assert.equal(
      JSON.stringify(body).includes('evil.example'),
      false,
      'untrusted URL never reaches the browser'
    );
    const payment = await getPaymentRow(order.id);
    assert.notEqual(payment.status, 'successful');
  } finally {
    mock.initMode = 'success';
  }
});

// ---------- Browser returns (PHASE 5 / 9 / 10) ----------

test('browser success URL alone (no invoice_id) never marks anything paid', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-noinv');
  const res = await getCallback('/payments/uddoktapay/success', {});
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get('location') || '').startsWith('/payment-failed.html'),
    res.headers.get('location')
  );
  const after = await getPaymentRow(order.id);
  assert.equal(after.status, payment.status, 'no state change');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('verified COMPLETED payment marks the order paid; replay of the same return is idempotent', async () => {
  const { user, order, payment } = await setupAwaitingPayment('ud-paid');
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
  assert.ok(location.includes(order.id), location);

  const paid = await getPaymentRow(order.id);
  assert.equal(paid.status, 'successful');
  assert.equal(paid.paid_at !== null, true);
  assert.equal(paid.provider_transaction_id, invoice, 'invoice id stored as provider tx');
  assert.equal(paid.validation_id, invoice);
  assert.equal(paid.metadata.payment_method, 'bkash');
  assert.equal(paid.metadata.sender_number, '01311111111');
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  assert.equal(await countSuccessful(order.id), 1);

  // replayed browser return — safe, idempotent, still one successful payment
  const replay = await getCallback('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(replay.status, 302);
  assert.ok(
    (replay.headers.get('location') || '').startsWith('/payment-success.html'),
    replay.headers.get('location')
  );
  assert.equal(await countSuccessful(order.id), 1);
  assert.equal((await getOrderRow(order.id)).status, 'paid');

  // a paid order accepts no new payment attempts
  const again = await initiatePayment(user.cookie, order.id);
  assert.equal(again.response.status, 409);
  assert.equal(again.body.error.code, 'ORDER_NOT_PAYABLE');
});

test('verified PENDING payment changes nothing and lands on the failed/verifying page', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-pending');
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
  assert.equal(row.status, payment.status, 'still open');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('verified ERROR payment fails the attempt but never pays the order', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-error');
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
  assert.equal(row.status, 'failed');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('unknown invoice (no metadata pointer) → failed page, nothing paid', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-unknown');
  const res = await getCallback('/payments/uddoktapay/success', {
    invoice_id: `MISSING${unique()}`,
  });
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get('location') || '').startsWith('/payment-failed.html'),
    res.headers.get('location')
  );
  const row = await getPaymentRow(order.id);
  assert.equal(row.status, payment.status);
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('amount mismatch cannot mark the order paid', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-amount');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: '0.01',
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
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('order/reference mismatch (metadata order_id) cannot mark the order paid', async () => {
  const victim = await registerUser('ud-victim');
  const other = await createOrder(victim.cookie);
  const { order, payment } = await setupAwaitingPayment('ud-ref');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: other.id },
  });

  const res = await getCallback('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get('location') || '').startsWith('/payment-failed.html'),
    res.headers.get('location')
  );
  assert.notEqual((await getPaymentRow(order.id)).status, 'successful');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal((await getOrderRow(other.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('same invoice cannot pay a second payment row — DB uniqueness backstop holds', async () => {
  // Settle payment A with invoice I…
  const user = await registerUser('ud-uniq');
  const orderA = await createOrder(user.cookie);
  const initA = await initiatePayment(user.cookie, orderA.id);
  assert.equal(initA.response.status, 201);
  const paymentA = await getPaymentRow(orderA.id);
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: String((await getOrderRow(orderA.id)).amount),
    metadata: { payment_id: paymentA.id, order_id: orderA.id },
  });
  const first = await getCallback('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(first.status, 302);
  assert.ok(
    (first.headers.get('location') || '').startsWith('/payment-success.html'),
    first.headers.get('location')
  );
  assert.equal(await countSuccessful(orderA.id), 1);

  // …then the same invoice is presented against payment B (forged metadata
  // shape — only possible with a compromised gateway, which is exactly why
  // the (provider, provider_transaction_id) unique index exists).
  const orderB = await createOrder(user.cookie);
  const initB = await initiatePayment(user.cookie, orderB.id);
  assert.equal(initB.response.status, 201);
  const paymentB = await getPaymentRow(orderB.id);
  programVerify(invoice, {
    amount: String((await getOrderRow(orderB.id)).amount),
    metadata: { payment_id: paymentB.id, order_id: orderB.id },
  });

  const second = await getCallback('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(second.status, 302);
  assert.ok(
    (second.headers.get('location') || '').startsWith('/payment-failed.html'),
    second.headers.get('location')
  );
  assert.notEqual((await getPaymentRow(orderB.id)).status, 'successful');
  assert.equal((await getOrderRow(orderB.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(orderB.id), 0);
  // the first settlement is untouched
  assert.equal(await countSuccessful(orderA.id), 1);
  assert.equal((await getOrderRow(orderA.id)).status, 'paid');
});

test('POST return (default return_type) is accepted and verified the same way', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-post');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const res = await postForm('/payments/uddoktapay/success', {
    invoice_id: invoice,
  });
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get('location') || '').startsWith('/payment-success.html'),
    res.headers.get('location')
  );
  assert.equal((await getOrderRow(order.id)).status, 'paid');
});

test('cancel without invoice_id → cancelled page, payment untouched, order unpaid', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-cancel');
  const res = await getCallback('/payments/uddoktapay/cancel', {});
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get('location') || '').startsWith('/payment-cancelled.html'),
    res.headers.get('location')
  );
  const row = await getPaymentRow(order.id);
  assert.equal(row.status, payment.status, 'no identification → no state change');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('cancel with a PENDING invoice cancels the attempt — never pays', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-cancel2');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    status: 'PENDING',
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const res = await getCallback('/payments/uddoktapay/cancel', {
    invoice_id: invoice,
  });
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get('location') || '').startsWith('/payment-cancelled.html'),
    res.headers.get('location')
  );
  const row = await getPaymentRow(order.id);
  assert.equal(row.status, 'cancelled');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  assert.equal(await countSuccessful(order.id), 0);
});

test('fail return without invoice_id → failed page, attempt unchanged', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-fail');
  const res = await getCallback('/payments/uddoktapay/fail', {});
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get('location') || '').startsWith('/payment-failed.html'),
    res.headers.get('location')
  );
  const row = await getPaymentRow(order.id);
  assert.equal(row.status, payment.status);
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
});

test('fail route with a COMPLETED invoice still settles — gateway truth wins over the route name', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-late');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const res = await getCallback('/payments/uddoktapay/fail', {
    invoice_id: invoice,
  });
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get('location') || '').startsWith('/payment-success.html'),
    res.headers.get('location')
  );
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  assert.equal(await countSuccessful(order.id), 1);
});

test('callbacks are inert while PAYMENT_PROVIDER is not uddoktapay', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-off');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const saved = config.payments.provider;
  config.payments.provider = 'disabled';
  try {
    const res = await getCallback('/payments/uddoktapay/success', {
      invoice_id: invoice,
    });
    assert.equal(res.status, 302);
    assert.ok(
      (res.headers.get('location') || '').startsWith('/payment-failed.html'),
      res.headers.get('location')
    );
    assert.notEqual((await getPaymentRow(order.id)).status, 'successful');
    assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  } finally {
    config.payments.provider = saved;
  }
});

// ---------- Webhook (PHASE 5) ----------

function webhookHeaders(key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key !== undefined) headers['RT-UDDOKTAPAY-API-KEY'] = key;
  return headers;
}

test('webhook without the API key header → 401 WEBHOOK_UNAUTHORIZED, no state change', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-wh-nokey');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const res = await postJson(
    '/payments/webhook/uddoktapay',
    { invoice_id: invoice, status: 'COMPLETED' },
    webhookHeaders(undefined)
  );
  assert.equal(res.response.status, 401);
  assert.equal(res.body.error.code, 'WEBHOOK_UNAUTHORIZED');
  assert.notEqual((await getPaymentRow(order.id)).status, 'successful');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
});

test('webhook with a wrong API key → 401, no state change', async () => {
  const { order } = await setupAwaitingPayment('ud-wh-badkey');
  const res = await postJson(
    '/payments/webhook/uddoktapay',
    { invoice_id: `INV${unique()}`, status: 'COMPLETED' },
    webhookHeaders('not-the-right-key')
  );
  assert.equal(res.response.status, 401);
  assert.equal(res.body.error.code, 'WEBHOOK_UNAUTHORIZED');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
});

test('authenticated webhook verifies server-side, marks paid, and is idempotent on repeats', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-wh-ok');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const payload = {
    full_name: 'Uddok Tester',
    email: 'wh@example.com',
    amount: String(order.amount),
    invoice_id: invoice,
    metadata: { payment_id: payment.id, order_id: order.id },
    payment_method: 'bkash',
    transaction_id: 'TXNWEB1',
    status: 'COMPLETED',
  };

  const first = await postJson(
    '/payments/webhook/uddoktapay',
    payload,
    webhookHeaders(API_KEY)
  );
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.body.data, { received: true, paid: true });
  assert.equal((await getOrderRow(order.id)).status, 'paid');
  assert.equal(await countSuccessful(order.id), 1);

  const repeat = await postJson(
    '/payments/webhook/uddoktapay',
    payload,
    webhookHeaders(API_KEY)
  );
  assert.equal(repeat.response.status, 200);
  assert.deepEqual(repeat.body.data, { received: true, paid: true });
  assert.equal(await countSuccessful(order.id), 1, 'no double payment');
  assert.equal((await getOrderRow(order.id)).status, 'paid');

  // the Verify Payment API was the actual authority — called with our key
  const calls = mock.verifyRequests.filter((r) => r.body.invoice_id === invoice);
  assert.ok(calls.length >= 2, 'each webhook re-verifies server-side');
  assert.ok(calls.every((c) => c.apiKey === API_KEY));
});

test('webhook payload claiming COMPLETED is not trusted when the verify API says PENDING', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-wh-lies');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    status: 'PENDING',
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const res = await postJson(
    '/payments/webhook/uddoktapay',
    { invoice_id: invoice, status: 'COMPLETED' },
    webhookHeaders(API_KEY)
  );
  assert.equal(res.response.status, 200);
  assert.deepEqual(res.body.data, { received: true, paid: false });
  assert.notEqual((await getPaymentRow(order.id)).status, 'successful');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
});

test('webhook for an unknown invoice is acknowledged as a no-op', async () => {
  const res = await postJson(
    '/payments/webhook/uddoktapay',
    { invoice_id: `NOPE${unique()}`, status: 'COMPLETED' },
    webhookHeaders(API_KEY)
  );
  assert.equal(res.response.status, 200);
  assert.deepEqual(res.body.data, { received: true, paid: false });
});

test('webhook without invoice_id is acknowledged as a no-op', async () => {
  const res = await postJson(
    '/payments/webhook/uddoktapay',
    { status: 'COMPLETED' },
    webhookHeaders(API_KEY)
  );
  assert.equal(res.response.status, 200);
  assert.deepEqual(res.body.data, { received: true, paid: false });
});

test('webhook is a no-op while PAYMENT_PROVIDER is not uddoktapay', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-wh-off');
  const invoice = `INV${unique()}`;
  programVerify(invoice, {
    amount: String(order.amount),
    metadata: { payment_id: payment.id, order_id: order.id },
  });

  const saved = config.payments.provider;
  config.payments.provider = 'disabled';
  try {
    const res = await postJson(
      '/payments/webhook/uddoktapay',
      { invoice_id: invoice, status: 'COMPLETED' },
      webhookHeaders(API_KEY)
    );
    assert.equal(res.response.status, 200);
    assert.deepEqual(res.body.data, { received: true, paid: false });
    assert.notEqual((await getPaymentRow(order.id)).status, 'successful');
  } finally {
    config.payments.provider = saved;
  }
});

// ---------- Authorization / admin (PHASE 11 / 14) ----------

test('admin payment review stays admin-only, CSRF-guarded in policy, and can never flip a uddoktapay row', async () => {
  const { order, payment } = await setupAwaitingPayment('ud-adminrow');

  // anonymous
  const anon = await postJson(`/admin/payments/${payment.id}/verify`, {});
  assert.equal(anon.response.status, 401);

  // signed-in non-admin customer
  const customer = await registerUser('ud-cust');
  const custRes = await postJson(`/admin/payments/${payment.id}/verify`, {}, {
    Cookie: customer.cookie,
  });
  assert.equal(custRes.response.status, 403);

  // admin CAN reach the endpoint, but gateway rows are never manually flippable
  const admin = await adminSession();
  const adminRes = await postJson(`/admin/payments/${payment.id}/verify`, {}, {
    Cookie: admin.cookie,
  });
  assert.equal(adminRes.response.status, 409);
  assert.equal(adminRes.body.error.code, 'PAYMENT_NOT_MANUAL');
  assert.notEqual((await getPaymentRow(order.id)).status, 'successful');
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
});

test('auth is checked before any provider logic on payment creation', async () => {
  const response = await fetch(`${BASE_URL}/api/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: '00000000-0000-4000-8000-000000000001' }),
    redirect: 'manual',
  });
  assert.equal(response.status, 401, 'auth always comes first');
});
