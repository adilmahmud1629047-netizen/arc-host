const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { before, after } = require('node:test');

// STEP 47 REGRESSION — live checkout payment hand-off (13 tests).
// The browser guard and the server-side redirect trust check must agree on
// the same env-derived gateway host; the uddoktapay hand-off must be a
// single click with no second "Proceed to Payment" button; retries reuse the
// existing order and its open gateway session (never duplicates) and stale
// sessions are expired in favour of a fresh gateway URL. In-process app with
// a UddoktaPay mock gateway — no real credentials, no live payments, no
// external network.
const config = require('../src/config');
const API_KEY = 'mock-uddokta-key-do-not-leak';

config.rateLimit.registerMax = 500;
config.rateLimit.loginMax = 500;
config.rateLimit.orderCreateMax = 500;
config.rateLimit.paymentCreateMax = 500;
config.payments.provider = 'uddoktapay';

const app = require('../src/app');

const FRONTEND_DIR = path.join(__dirname, '../../frontend');

let BASE_URL = null;
let mockBaseUrl = null;
let appServer = null;
let mockServer = null;
let database = null;
let pool = null;

const mock = {
  initMode: 'success', // 'success' | 'failed' | 'evil'
  initRequests: [],
};

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;

function readFrontend(relPath) {
  return fs.readFileSync(path.join(FRONTEND_DIR, relPath), 'utf8');
}

function extractFunction(src, name) {
  const sig = 'function ' + name + '(';
  const start = src.indexOf(sig);
  assert.ok(start >= 0, `missing function ${name}`);
  const braceAt = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceAt; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

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

async function getPage(pathname) {
  const response = await fetch(`${BASE_URL}${pathname}`);
  const html = await response.text();
  return { response, html };
}

async function registerUser(prefix = 'r47reg') {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Regression',
    lastName: 'Fixture',
    email,
    password,
  });
  assert.equal(reg.response.status, 201);
  const login = await postJson('/auth/login', { email, password });
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie, 'expected session cookie');
  return { email, cookie };
}

async function createAwaitingOrder(cookie, label) {
  const order = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: cookie, 'Idempotency-Key': `${label}-` + unique().slice(0, 16) }
  );
  assert.equal(order.response.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.data.status, 'awaiting_payment');
  return order.body.data;
}

async function paymentRows(orderId) {
  const { rows } = await pool.query(
    `SELECT id, status, provider, provider_session_key
     FROM payment_transactions
     WHERE order_id = $1
     ORDER BY created_at, id`,
    [orderId]
  );
  return rows;
}

async function getOrderRow(orderId) {
  const { rows } = await pool.query(
    'SELECT status FROM orders WHERE id = $1',
    [orderId]
  );
  return rows[0] || null;
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
          body,
        });
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
/* 1-2: server advertises the exact host its trust check uses           */
/* ------------------------------------------------------------------ */

test('[R-01] GET /api/payments/provider advertises the exact trusted gateway host (host only)', async () => {
  const { response, body } = await api('/payments/provider');
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(
    Object.keys(body.data).sort(),
    ['gatewayHost', 'provider'],
    'provider name + exact host, nothing else'
  );
  assert.equal(body.data.provider, 'uddoktapay');
  assert.equal(body.data.gatewayHost, new URL(mockBaseUrl).host.toLowerCase());
  assert.equal(
    /^[^/]+$/.test(body.data.gatewayHost),
    true,
    'host only — no scheme, no path'
  );
  const raw = JSON.stringify(body).toLowerCase();
  assert.equal(raw.includes('http'), false, 'no URLs leak');
  assert.equal(raw.includes('key'), false, 'no key material leaks');
  assert.equal(raw.includes('secret'), false, 'no secrets leak');

  // Unconfigured base URL → nothing but the name is advertised.
  const saved = config.payments.uddoktapay.baseUrl;
  config.payments.uddoktapay.baseUrl = '';
  try {
    const bare = await api('/payments/provider');
    assert.deepEqual(Object.keys(bare.body.data), ['provider']);
  } finally {
    config.payments.uddoktapay.baseUrl = saved;
  }
});

test('[R-02] advertised host is derived from the same config the server trust check uses', () => {
  const uddokta = require('../src/services/payments/providers/uddoktapayProvider');
  assert.equal(typeof uddokta.instance.trustedGatewayHost, 'function');
  assert.equal(
    uddokta.instance.trustedGatewayHost(),
    new URL(config.payments.uddoktapay.baseUrl).host.toLowerCase()
  );
  // The advertised host and the trust check are the same source of truth:
  // a payment URL on that host passes isTrustedPaymentUrl.
  const trusted = uddokta.isTrustedPaymentUrl(
    `${mockBaseUrl}/payment/abc`,
    config.payments.uddoktapay.baseUrl
  );
  assert.equal(trusted, true);

  const ssl = require('../src/services/payments/providers/sslcommerzProvider');
  assert.equal(typeof ssl.instance.trustedGatewayHost, 'function');
  const sslHost = ssl.instance.trustedGatewayHost();
  if (sslHost) {
    assert.equal(sslHost, new URL(config.payments.sslcommerz.baseUrl).host.toLowerCase());
    assert.equal(/^[^/]+$/.test(sslHost), true, 'host only');
  } else {
    assert.equal(
      String(config.payments.sslcommerz.baseUrl || '').trim(),
      '',
      'null only when unconfigured'
    );
  }
});

/* ------------------------------------------------------------------ */
/* 3-4: browser guard agrees with the server (and keeps legacy rules)   */
/* ------------------------------------------------------------------ */

function loadGuard(windowShim) {
  const js = readFrontend('js/checkout.js');
  const body = extractFunction(js, 'isSafeGatewayUrl');
  return new Function('window', `${body}; return isSafeGatewayUrl;`)(windowShim);
}

test('[R-03] browser guard accepts the advertised host verbatim and nothing else', () => {
  const host = new URL(mockBaseUrl).host; // 127.0.0.1:<port>
  const win = { location: { host: 'arch.raincloud.fun' }, __trustedGatewayHost: host };
  const guard = loadGuard(win);

  assert.equal(guard(`${mockBaseUrl}/payment/abc`), true, 'advertised host trusted');
  assert.equal(guard(`https://${host}/payment/abc`), true, 'https on advertised host trusted');
  assert.equal(guard('https://evil.example/pay'), false, 'foreign host rejected');
  assert.equal(
    guard(`https://${host}.evil.example/x`),
    false,
    'suffix trick rejected — verbatim host compare, never a pattern'
  );
  assert.equal(guard('https://archost.paymently.io/x'), false, 'unadvertised host rejected');
  assert.equal(guard('javascript:alert(1)'), false);
  assert.equal(guard('/relative'), false);

  // Without a learned host the guard stays exactly as conservative as
  // before: loopback/own-origin still work, everything foreign does not.
  const blind = loadGuard({ location: { host: 'arch.raincloud.fun' } });
  assert.equal(blind(`${mockBaseUrl}/payment/abc`), true, 'legacy loopback rule kept');
  assert.equal(blind('https://evil.example/pay'), false);
  assert.equal(blind('https://archost.paymently.io/x'), false, 'unlearned host rejected');
});

test('[R-04] guard keeps every legacy safety rule (vendor https-only, loopback, protocols)', () => {
  const js = readFrontend('js/checkout.js');
  const body = extractFunction(js, 'isSafeGatewayUrl');
  const guard = new Function(`${body}; return isSafeGatewayUrl;`)(); // no window (Node)

  // vendor domains: https only (mirrors the server-side rules)
  assert.equal(guard('https://pay.uddoktapay.com/x'), true);
  assert.equal(guard('http://pay.uddoktapay.com/x'), false);
  assert.equal(guard('https://sandbox.sslcommerz.com/gw'), true);
  assert.equal(guard('http://sandbox.sslcommerz.com/gw'), false);
  // loopback mock gateway over plain http
  assert.equal(guard(`${mockBaseUrl}/payment/abc`), true);
  // protocol / shape rejections
  assert.equal(guard('javascript:alert(1)'), false);
  assert.equal(guard('//evil.example/pay'), false);
  assert.equal(guard('/payment/relative'), false);
  assert.equal(guard(''), false);
  assert.equal(guard(null), false);
  assert.equal(guard('ftp://127.0.0.1/x'), false);
});

/* ------------------------------------------------------------------ */
/* 5-10: checkout source contracts (single click, no second button,     */
/* truthful errors, order/session reuse on retry)                       */
/* ------------------------------------------------------------------ */

test('[R-05] checkout.js learns the advertised host before any redirect', () => {
  const js = readFrontend('js/checkout.js');
  assert.ok(js.includes('body.data.gatewayHost'), 'reads the advertised host');
  assert.ok(
    js.includes('window.__trustedGatewayHost'),
    'stores the host for the guard'
  );
  const fetchBody = extractFunction(js, 'fetchPaymentProvider');
  assert.ok(fetchBody.includes('gatewayHost'), 'provider fetch captures the host');
  assert.ok(fetchBody.includes('__trustedGatewayHost'), 'host stored in provider fetch');
  const guardBody = extractFunction(js, 'isSafeGatewayUrl');
  assert.ok(
    guardBody.includes('__trustedGatewayHost'),
    'guard consults the advertised host'
  );
  const payBody = extractFunction(js, 'proceedToPayment');
  assert.ok(
    payBody.includes('await fetchPaymentProvider()'),
    'payment start re-resolves the provider/host before guarding'
  );
  assert.ok(
    js.includes('!isSafeGatewayUrl(body.data.gatewayUrl)'),
    'redirect still gated by the guard'
  );
  assert.ok(
    js.includes('window.location.href = body.data.gatewayUrl'),
    'redirect target is the server-provided gateway URL'
  );
});

test('[R-06] no second payment button under uddoktapay (source + HTML)', () => {
  const js = readFrontend('js/checkout.js');
  const gateIdx = js.indexOf('function updatePaymentMethods');
  assert.ok(gateIdx > 0);
  const gate = js.slice(gateIdx, js.indexOf('function setManualStatus'));
  assert.match(
    gate,
    /proceedBtn\.hidden = !awaiting \|\| gatewayOnly/,
    'Proceed to Payment hidden for the gateway-only provider'
  );
  assert.match(
    gate,
    /paymentMethodsEl\.hidden = !awaiting \|\| gatewayOnly/,
    'whole payment-selection section hidden for the gateway-only provider'
  );
  assert.ok(gate.includes('isUddoktaPay()'), 'still provider-gated');

  // Legacy flows keep the button, but it ships hidden and only appears
  // after an order exists (never as a second hand-off click under uddoktapay).
  const html = readFrontend('checkout.html');
  const proceedAt = html.indexOf('id="proceed-payment"');
  assert.ok(proceedAt > -1, 'element kept for legacy/manual flows');
  const proceedTag = html.slice(proceedAt, html.indexOf('>', proceedAt));
  assert.match(proceedTag, /\bhidden\b/, 'Proceed button ships hidden');
  assert.ok(html.includes('Proceed to Payment'), 'legacy label intact');
  assert.ok(html.includes('id="payment-methods"'), 'section kept for legacy flows');
});

test('[R-07] hand-off failure stays on the form — Place Order is the retry', () => {
  const js = readFrontend('js/checkout.js');

  // recovery never swaps in the confirmation card or a second button
  const recover = extractFunction(js, 'recoverFromPaymentStart');
  assert.ok(recover.includes('showConfirmation') === false, 'no confirmation card');
  assert.ok(recover.includes('setStatus('), 'truthful error on the form');
  assert.ok(
    recover.includes("We couldn't start the payment session. Please try again."),
    'default recovery copy'
  );
  assert.ok(recover.includes('state.order = order'), 'existing order kept for the retry');

  // the failure path is still inside the single-click gateway branch
  const gateStart = js.indexOf('if (isUddoktaPay() &&');
  const confirmCall = js.indexOf('showConfirmation(body.data)');
  assert.ok(gateStart > 0 && confirmCall > gateStart);
  const branch = js.slice(gateStart, confirmCall);
  assert.ok(branch.includes('await proceedToPayment()'), 'payment starts in-flow');
  const at = branch.indexOf('await proceedToPayment()');
  const recoverAt = branch.indexOf('recoverFromPaymentStart(');
  assert.ok(at > -1 && recoverAt > at, 'failure handled after the payment attempt');
  assert.equal(
    (js.match(/if \(isUddoktaPay\(\) &&/g) || []).length,
    1,
    'exactly one gateway gate'
  );
});

test('[R-08] truthful error copy; the regression message is gone', () => {
  const js = readFrontend('js/checkout.js');
  assert.ok(
    js.includes("We couldn't start the payment session. Please try again."),
    'provider-failure copy present'
  );
  assert.ok(
    js.includes('The payment session has expired. Please try again.'),
    'expired-session copy present'
  );
  assert.equal(
    js.includes('The payment link is invalid'),
    false,
    'regression screenshot message removed'
  );
  assert.ok(js.includes('PAYMENT_PROVIDER_NOT_CONFIGURED'), 'code mapping kept');
  assert.ok(
    js.includes('Payment processing is not available yet.'),
    'disabled-provider copy kept'
  );
  assert.ok(js.includes('PAYMENT_PROVIDER_ERROR'), 'provider failure mapped');
  assert.ok(js.includes('PAYMENT_SESSION_EXPIRED'), 'expired session mapped');
  assert.equal(
    /payment (successful|confirmed|complete)/i.test(js),
    false,
    'never claims a completed payment'
  );
});

test('[R-09] retry reuses the existing awaiting order — never a second order (source)', () => {
  const js = readFrontend('js/checkout.js');
  const placeIdx = js.indexOf('async function placeOrder');
  const proceedIdx = js.indexOf('async function proceedToPayment');
  assert.ok(placeIdx > 0 && proceedIdx > placeIdx);
  const place = js.slice(placeIdx, proceedIdx);

  const orderCalls = (js.match(/fetch\("\/api\/orders"/g) || []).length;
  assert.equal(orderCalls, 1, 'exactly one order-creation call site');

  const retryAt = place.indexOf('state.order && state.order.status === "awaiting_payment"');
  const fetchAt = place.indexOf('fetch("/api/orders"');
  assert.ok(retryAt > -1, 'existing-order retry branch exists');
  assert.ok(fetchAt > retryAt, 'retry branch runs before any order creation');
  const retryBranch = place.slice(retryAt, fetchAt);
  assert.ok(retryBranch.includes('await proceedToPayment()'), 'retry goes straight to payment');
  assert.ok(
    retryBranch.includes('recoverFromPaymentStart('),
    'retry failure handled by the same recovery'
  );
  assert.ok(
    place.includes('for (var orderAttempt = 0; orderAttempt < 2; orderAttempt++)'),
    'creation loop is capped — stale-key refresh can never loop'
  );
});

test('[R-10] idempotency key survives a failed hand-off; retired only when the order is finished', () => {
  const js = readFrontend('js/checkout.js');
  // definition + exactly one call site (inside the stale-key pass)
  assert.equal(
    (js.match(/clearIdempotencyKey\(/g) || []).length,
    2,
    'key cleared in exactly one place'
  );
  const placeIdx = js.indexOf('async function placeOrder');
  const proceedIdx = js.indexOf('async function proceedToPayment');
  const place = js.slice(placeIdx, proceedIdx);
  assert.ok(
    place.includes('response.status === 200 &&') &&
      place.includes('body.data.status !== "awaiting_payment"') &&
      place.includes('orderAttempt === 0'),
    'retired only when the reused order is no longer awaiting payment'
  );
  assert.ok(
    place.includes('state.idempotencyKey = readIdempotencyKey('),
    'fresh key generated for the one fresh attempt'
  );
  assert.ok(
    place.includes('// The key stays while this order still needs payment'),
    'key retained for refresh/retry reuse'
  );
});

/* ------------------------------------------------------------------ */
/* 11-13: server-side retry, stale sessions, failure recovery           */
/* ------------------------------------------------------------------ */

test('[R-11] same idempotency key returns the same order; payment retries reuse the open session', async () => {
  const user = await registerUser('r47reuse');
  const key = 'r47r-' + unique().slice(0, 16);
  const payload = { productType: 'hosting', planSlug: 'starter' };

  const first = await postJson('/orders', payload, {
    Cookie: user.cookie,
    'Idempotency-Key': key,
  });
  assert.equal(first.response.status, 201);
  const order = first.body.data;

  const again = await postJson('/orders', payload, {
    Cookie: user.cookie,
    'Idempotency-Key': key,
  });
  assert.equal(again.response.status, 200, 'reused, not recreated');
  assert.equal(again.body.data.id, order.id);
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');

  const initsBefore = mock.initRequests.length;
  const pay1 = await postJson('/payments', { orderId: order.id }, { Cookie: user.cookie });
  assert.equal(pay1.response.status, 201, JSON.stringify(pay1.body));
  assert.ok(pay1.body.data.gatewayUrl.startsWith(`${mockBaseUrl}/payment/`));
  assert.equal(mock.initRequests.length, initsBefore + 1);

  // immediate retry: same session, no second gateway call, no second row
  const pay2 = await postJson('/payments', { orderId: order.id }, { Cookie: user.cookie });
  assert.equal(pay2.response.status, 201);
  assert.equal(pay2.body.data.paymentId, pay1.body.data.paymentId, 'same open session');
  assert.equal(pay2.body.data.gatewayUrl, pay1.body.data.gatewayUrl, 'same gateway URL');
  assert.equal(mock.initRequests.length, initsBefore + 1, 'no second gateway session');
  assert.equal((await paymentRows(order.id)).length, 1, 'exactly one gateway row');

  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment', 'never auto-paid');
});

test('[R-12] a stale gateway session is expired in favour of a FRESH gateway URL', async () => {
  const user = await registerUser('r47stale');
  const order = await createAwaitingOrder(user.cookie, 'r47stale');

  const pay1 = await postJson('/payments', { orderId: order.id }, { Cookie: user.cookie });
  assert.equal(pay1.response.status, 201);
  const staleId = pay1.body.data.paymentId;
  const staleUrl = pay1.body.data.gatewayUrl;

  // age the open session past the reuse TTL
  await pool.query(
    `UPDATE payment_transactions
     SET created_at = now() - interval '31 minutes'
     WHERE order_id = $1 AND status = 'pending'`,
    [order.id]
  );

  const pay2 = await postJson('/payments', { orderId: order.id }, { Cookie: user.cookie });
  assert.equal(pay2.response.status, 201, JSON.stringify(pay2.body));
  assert.notEqual(pay2.body.data.paymentId, staleId, 'fresh attempt row');
  assert.ok(pay2.body.data.gatewayUrl, 'fresh gateway URL returned');
  assert.notEqual(pay2.body.data.gatewayUrl, staleUrl, 'URL is actually fresh');
  assert.ok(pay2.body.data.gatewayUrl.startsWith(`${mockBaseUrl}/payment/`), 'still trusted');

  const rows = await paymentRows(order.id);
  assert.deepEqual(
    rows.map((r) => r.status).sort(),
    ['expired', 'pending'],
    'stale row closed, new session open'
  );
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
});

test('[R-13] provider failure is truthful, keeps the order alive, and the retry then succeeds', async () => {
  try {
    const user = await registerUser('r47fail');
    const order = await createAwaitingOrder(user.cookie, 'r47fail');

    // gateway rejects → 502, order untouched, no success recorded
    mock.initMode = 'failed';
    const fail = await postJson('/payments', { orderId: order.id }, { Cookie: user.cookie });
    assert.equal(fail.response.status, 502);
    assert.equal(fail.body.error.code, 'PAYMENT_PROVIDER_ERROR');
    assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
    let rows = await paymentRows(order.id);
    assert.equal(rows.length, 1, 'attempt recorded');
    assert.equal(rows[0].status, 'initiated', 'never a session, never successful');

    // gateway returns an untrusted URL → refused server-side, nothing leaks
    mock.initMode = 'evil';
    const evil = await postJson('/payments', { orderId: order.id }, { Cookie: user.cookie });
    assert.equal(evil.response.status, 502);
    assert.equal(
      JSON.stringify(evil.body).includes('evil.example'),
      false,
      'no redirect target ever returned'
    );
    assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');

    // the retry (same order) now succeeds — failed attempts never block it
    mock.initMode = 'success';
    const ok = await postJson('/payments', { orderId: order.id }, { Cookie: user.cookie });
    assert.equal(ok.response.status, 201, JSON.stringify(ok.body));
    assert.ok(ok.body.data.gatewayUrl.startsWith(`${mockBaseUrl}/payment/`));
    rows = await paymentRows(order.id);
    assert.deepEqual(
      rows.map((r) => r.status).sort(),
      ['initiated', 'initiated', 'pending'],
      'two failed attempts kept as history; one open session'
    );
    const successes = rows.filter((r) => r.status === 'successful');
    assert.equal(successes.length, 0, 'nothing ever marked paid by the browser flow');
    assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  } finally {
    mock.initMode = 'success';
  }
});
