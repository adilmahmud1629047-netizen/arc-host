const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { before, after } = require('node:test');

// PART P — Purchase flow (spec tests 1-19). In-process app with a UddoktaPay
// mock gateway (PHASE 15 local test mode): no real credentials, no live
// payments, no external network. Config is mutated BEFORE the app loads so
// route-level rate limiters pick up raised limits.
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
  initMode: 'success', // 'success' | 'failed' | 'evil' | 'http500'
  initRequests: [],
  verifyRequests: [],
  verifications: new Map(),
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

async function registerUser(prefix = 'p47') {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Part',
    lastName: 'P',
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

async function getHostingPlan(slug = 'starter') {
  const { response, body } = await api(`/plans/hosting/${slug}`);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  return body.data;
}

async function countOrders(cookie) {
  const { response, body } = await api('/orders', {
    headers: { Cookie: cookie, Accept: 'application/json' },
  });
  assert.equal(response.status, 200);
  return body.data.orders.length;
}

async function getOrderRow(orderId) {
  const { rows } = await pool.query(
    'SELECT id, order_number, status, amount::text AS amount, currency FROM orders WHERE id = $1',
    [orderId]
  );
  return rows[0] || null;
}

async function getPaymentRow(orderId) {
  const { rows } = await pool.query(
    `SELECT id, status, provider, provider_transaction_id, provider_session_key,
            amount::text AS amount, currency, metadata
     FROM payment_transactions
     WHERE order_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

async function countPayments(orderId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM payment_transactions WHERE order_id = $1',
    [orderId]
  );
  return rows[0].n;
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

/* ------------------------------------------------------------------ */
/* 1-3: anonymous Buy → login; login/register keep checkout context     */
/* ------------------------------------------------------------------ */

test('[P-1] anonymous Buy → /login?next= gate; checkout and login pages serve', async () => {
  const plansSrc = readFrontend('js/plans.js');
  assert.match(plansSrc, /function purchaseHref\(/);
  assert.ok(
    plansSrc.includes(
      '"/checkout?type=" + type + "&plan=" + encodeURIComponent(slug)'
    ),
    'purchase CTA targets checkout with the selected plan'
  );

  const navSrc = readFrontend('js/auth-nav.js');
  assert.ok(
    navSrc.includes('"/login?next=" + encodeURIComponent(target)'),
    'anonymous visitors are gated through /login?next=<checkout target>'
  );

  const target = '/checkout?type=hosting&plan=starter';
  const login = await getPage('/login?next=' + encodeURIComponent(target));
  assert.equal(login.response.status, 200);
  assert.ok(login.html.includes('id="login-form"'));
  assert.ok(
    login.response.url.includes('next=' + encodeURIComponent(target)),
    'the checkout context survives in the login URL'
  );

  const checkout = await getPage('/checkout?type=hosting&plan=starter');
  assert.equal(checkout.response.status, 200);
  assert.ok(checkout.html.includes('id="place-order"'));
});

test('[P-2] login preserves the checkout context (?return= handoff)', async () => {
  const authSrc = readFrontend('js/auth.js');
  assert.match(authSrc, /window\.location\.href = safeReturnPath\(\);/);
  assert.match(authSrc, /params\.get\("next"\) \|\| params\.get\("return"\)/);

  const target = '/checkout?type=hosting&plan=starter';
  const login = await getPage('/login?return=' + encodeURIComponent(target));
  assert.equal(login.response.status, 200);
  assert.ok(login.html.includes('id="login-form"'));

  const isSafeBody = extractFunction(authSrc, 'isSafeReturnPath');
  const targetBody = extractFunction(authSrc, 'targetFromUrl');
  const resolveTarget = (search) =>
    new Function(
      'window',
      `${isSafeBody}; ${targetBody}; return targetFromUrl();`
    )({ location: { search } });
  assert.equal(
    resolveTarget('?return=' + encodeURIComponent(target)),
    target,
    'legacy ?return= still resolves the checkout destination'
  );
});

test('[P-3] register preserves the checkout context (?plan/&type handoff)', async () => {
  const authSrc = readFrontend('js/auth.js');
  assert.match(authSrc, /window\.location\.replace\(safeReturnPath\(\)\);/);

  const page = await getPage('/register?plan=starter&type=hosting');
  assert.equal(page.response.status, 200);
  assert.ok(page.html.includes('id="register-form"'));

  const isSafeBody = extractFunction(authSrc, 'isSafeReturnPath');
  const targetBody = extractFunction(authSrc, 'targetFromUrl');
  const resolveTarget = (search) =>
    new Function(
      'window',
      `${isSafeBody}; ${targetBody}; return targetFromUrl();`
    )({ location: { search } });
  assert.equal(
    resolveTarget('?plan=starter&type=hosting'),
    '/checkout?type=hosting&plan=starter',
    'the register handoff maps onto checkout — context is never lost'
  );
});

/* ------------------------------------------------------------------ */
/* 4-5: authed checkout reachability; plan selection creates no order   */
/* ------------------------------------------------------------------ */

test('[P-4] signed-in customer reaches checkout and resolves the plan', async () => {
  const user = await registerUser('p47-ctx');

  const checkout = await getPage('/checkout?type=hosting&plan=starter');
  assert.equal(checkout.response.status, 200);

  const plan = await getHostingPlan('starter');
  assert.equal(plan.slug, 'starter');
  assert.ok(plan.price !== undefined && plan.price !== null);

  const js = readFrontend('js/checkout.js');
  assert.ok(
    js.includes('catalog.fetchPlan(query.type, query.plan)'),
    'checkout loads the plan named in the URL'
  );
  assert.ok(js.includes('renderPlan(query.type, result.plan)'), 'plan renders');

  // The session works against the order API the page will call.
  const orders = await api('/orders', {
    headers: { Cookie: user.cookie, Accept: 'application/json' },
  });
  assert.equal(orders.response.status, 200);
});

test('[P-5] plan selection alone creates no order (server + single client call site)', async () => {
  const user = await registerUser('p47-noord');
  assert.equal(await countOrders(user.cookie), 0);

  // Viewing the plan and the checkout page must not create anything.
  const plan = await getHostingPlan('starter');
  assert.ok(plan.slug);
  const page = await getPage('/checkout?type=hosting&plan=starter');
  assert.equal(page.response.status, 200);
  assert.equal(await countOrders(user.cookie), 0);

  const js = readFrontend('js/checkout.js');
  const callCount = (js.match(/fetch\("\/api\/orders"/g) || []).length;
  assert.equal(
    callCount,
    1,
    'exactly one client-side order-creation call site (placeOrder)'
  );
  const placeIdx = js.indexOf('async function placeOrder');
  const proceedIdx = js.indexOf('async function proceedToPayment');
  assert.ok(placeIdx > 0 && proceedIdx > placeIdx);
  const callSite = js.indexOf('fetch("/api/orders"');
  assert.ok(
    callSite > placeIdx && callSite < proceedIdx,
    'order creation lives inside placeOrder only'
  );
  const place = js.slice(placeIdx, proceedIdx);
  assert.ok(place.includes('productType: state.type'), 'body carries productType');
  assert.ok(place.includes('planSlug: state.plan.slug'), 'body carries planSlug');
  assert.doesNotMatch(
    place,
    /JSON\.stringify\(\{[^}]*\bamount\b/,
    'amount never leaves the browser'
  );
});

/* ------------------------------------------------------------------ */
/* 6-8: Place Order creates order + payment; trusted gateway URL        */
/* ------------------------------------------------------------------ */

test('[P-6..8] Place Order → order (server-priced) → payment session with trusted gateway URL', async () => {
  const user = await registerUser('p47-order');
  const plan = await getHostingPlan('starter');
  const beforePayments = mock.initRequests.length;

  const orderRes = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: user.cookie, 'Idempotency-Key': 'p47-' + unique().slice(0, 20) }
  );
  assert.equal(orderRes.response.status, 201, JSON.stringify(orderRes.body));
  const order = orderRes.body.data;
  assert.ok(order.id && order.orderNumber);
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(
    String(order.amount),
    String(plan.price),
    'order amount comes from the catalog, not the browser'
  );
  assert.equal(await countPayments(order.id), 0, 'no payment row at order time');

  const payRes = await postJson(
    '/payments',
    { orderId: order.id },
    { Cookie: user.cookie }
  );
  assert.equal(payRes.response.status, 201, JSON.stringify(payRes.body));
  assert.deepEqual(
    Object.keys(payRes.body.data).sort(),
    ['gatewayUrl', 'paymentId'],
    'only safe fields reach the browser'
  );
  assert.ok(
    payRes.body.data.gatewayUrl.startsWith(`${mockBaseUrl}/payment/`),
    'gateway URL is the trusted gateway address'
  );
  assert.equal(mock.initRequests.length, beforePayments + 1);
  assert.equal(mock.initRequests[mock.initRequests.length - 1].apiKey, API_KEY);

  const payment = await getPaymentRow(order.id);
  assert.ok(payment, 'payment session recorded');
  assert.equal(payment.provider, 'uddoktapay');
  assert.equal(payment.status, 'pending');
  assert.equal(payment.provider_session_key, payRes.body.data.gatewayUrl);
  assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
});

/* ------------------------------------------------------------------ */
/* 9-11: direct gateway redirect; no intermediate page / second click   */
/* ------------------------------------------------------------------ */

test('[P-9] Place Order chains straight into the gateway redirect (source)', () => {
  const js = readFrontend('js/checkout.js');

  assert.ok(
    js.includes('placeOrderBtn.addEventListener("click", placeOrder)'),
    'the Place Order button wires placeOrder directly'
  );
  const placeIdx = js.indexOf('async function placeOrder');
  const proceedIdx = js.indexOf('async function proceedToPayment');
  assert.ok(placeIdx > 0 && proceedIdx > placeIdx);
  const place = js.slice(placeIdx, proceedIdx);
  assert.ok(
    place.includes('await proceedToPayment()'),
    'the same click creates the payment session'
  );
  assert.ok(
    js.includes('window.location.href = body.data.gatewayUrl'),
    'redirect target is the server-provided gateway URL'
  );
});

test('[P-10] no intermediate payment-selection/confirmation page under UddoktaPay (source)', () => {
  const js = readFrontend('js/checkout.js');
  const gateStart = js.indexOf('if (isUddoktaPay() &&');
  const confirmCall = js.indexOf('showConfirmation(body.data)');
  assert.ok(gateStart > 0 && confirmCall > gateStart);
  const branch = js.slice(gateStart, confirmCall);

  assert.ok(branch.includes('await proceedToPayment()'), 'payment starts in-flow');
  assert.ok(
    branch.includes('setStatus("Redirecting to secure payment…"'),
    'one status line, then out — no selection step'
  );
  assert.doesNotMatch(
    branch,
    /showConfirmation\(/,
    'the confirmation card is never the gateway hand-off step'
  );
  assert.ok(
    branch.includes('recoverFromPaymentStart('),
    'only a recoverable failure shows the order again'
  );
  assert.doesNotMatch(js, /payment-success\.html/, 'no intermediate success page');
});

test('[P-11] no second Proceed click when UddoktaPay is active (auto-chain + hidden retry)', async () => {
  const js = readFrontend('js/checkout.js');
  const gateStart = js.indexOf('if (isUddoktaPay() &&');
  const confirmCall = js.indexOf('showConfirmation(body.data)');
  const branch = js.slice(gateStart, confirmCall);
  const at = branch.indexOf('await proceedToPayment()');
  const recoverAt = branch.indexOf('recoverFromPaymentStart(');
  assert.ok(at > -1 && recoverAt > at, 'payment runs before any recovery UI');

  const html = await getPage('/checkout?type=hosting&plan=starter');
  assert.equal(html.response.status, 200);
  const confirmAt = html.html.indexOf('id="order-confirm"');
  assert.ok(confirmAt > -1);
  assert.match(
    html.html.slice(confirmAt, confirmAt + 200),
    /hidden/,
    'confirmation card ships hidden'
  );
  const proceedAt = html.html.indexOf('id="proceed-payment"');
  assert.ok(proceedAt > -1);
  const proceedTag = html.html.slice(proceedAt, html.html.indexOf('>', proceedAt));
  assert.match(proceedTag, /\bhidden\b/, 'Proceed button ships hidden (retry only)');
});

/* ------------------------------------------------------------------ */
/* 12: double-click Place Order → no duplicate orders                   */
/* ------------------------------------------------------------------ */

test('[P-12] double-click Place Order reuses the idempotency key — one order', async () => {
  const user = await registerUser('p47-double');
  const key = 'p47dbl-' + unique().slice(0, 16);
  const payload = { productType: 'hosting', planSlug: 'starter' };

  const first = await postJson('/orders', payload, {
    Cookie: user.cookie,
    'Idempotency-Key': key,
  });
  assert.equal(first.response.status, 201, JSON.stringify(first.body));

  const second = await postJson('/orders', payload, {
    Cookie: user.cookie,
    'Idempotency-Key': key,
  });
  assert.equal(second.response.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.data.id, first.body.data.id, 'same order returned');

  const list = await api('/orders', {
    headers: { Cookie: user.cookie, Accept: 'application/json' },
  });
  assert.equal(list.body.data.orders.length, 1, 'exactly one order exists');
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM orders WHERE idempotency_key = $1',
    [key]
  );
  assert.equal(rows[0].n, 1, 'one persisted row for the key');
});

/* ------------------------------------------------------------------ */
/* 13: unauthenticated order API → 401                                  */
/* ------------------------------------------------------------------ */

test('[P-13] unauthenticated order API → 401 (create + list)', async () => {
  const create = await postJson('/orders', {
    productType: 'hosting',
    planSlug: 'starter',
  });
  assert.equal(create.response.status, 401);
  assert.equal(create.body.error.code, 'UNAUTHORIZED');

  const list = await api('/orders');
  assert.equal(list.response.status, 401);
  assert.equal(list.body.error.code, 'UNAUTHORIZED');
});

/* ------------------------------------------------------------------ */
/* 14: inactive plan rejected                                           */
/* ------------------------------------------------------------------ */

test('[P-14] inactive plan cannot be ordered (404 PLAN_NOT_FOUND)', async () => {
  const admin = await registerUser('p47-planadmin');
  await pool.query(
    `UPDATE users SET role = 'admin', status = 'active' WHERE email = $1`,
    [admin.email]
  );

  const slug = `s47-inactive-${unique().slice(0, 12)}`;
  const created = await postJson(
    '/admin/plans',
    {
      productType: 'hosting',
      name: 'Step47 Inactive',
      slug,
      price: '450.00',
      billingCycle: 'monthly',
      category: 'web',
      status: 'inactive',
    },
    { Cookie: admin.cookie }
  );
  assert.ok(
    [200, 201].includes(created.response.status),
    JSON.stringify(created.body)
  );

  try {
    const customer = await registerUser('p47-inactive');
    const order = await postJson(
      '/orders',
      { productType: 'hosting', planSlug: slug },
      { Cookie: customer.cookie, 'Idempotency-Key': 'p47ia-' + unique().slice(0, 12) }
    );
    assert.equal(order.response.status, 404, JSON.stringify(order.body));
    assert.equal(order.body.error.code, 'PLAN_NOT_FOUND');
    assert.equal(await countOrders(customer.cookie), 0, 'nothing was created');
  } finally {
    const list = await api('/admin/plans?productType=hosting&category=web', {
      headers: { Cookie: admin.cookie, Accept: 'application/json' },
    });
    const row = ((list.body && list.body.data && list.body.data.products) || []).find(
      (p) => p.slug === slug
    );
    if (row) {
      await api(`/admin/plans/hosting/${row.id}`, {
        method: 'DELETE',
        headers: { Cookie: admin.cookie, Accept: 'application/json' },
      });
    }
  }
});

/* ------------------------------------------------------------------ */
/* 15: client-supplied price cannot manipulate the order amount         */
/* ------------------------------------------------------------------ */

test('[P-15] client-supplied amount/currency/status are rejected — nothing created', async () => {
  const user = await registerUser('p47-inject');
  const cases = [
    { productType: 'hosting', planSlug: 'starter', amount: '0.01' },
    { productType: 'hosting', planSlug: 'starter', currency: 'USD' },
    { productType: 'hosting', planSlug: 'starter', status: 'paid' },
    { productType: 'hosting', planSlug: 'starter', price: '1' },
  ];
  for (const payload of cases) {
    const { response, body } = await postJson('/orders', payload, {
      Cookie: user.cookie,
      'Idempotency-Key': 'p47j-' + unique().slice(0, 16),
    });
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      JSON.stringify(body.error.details || []).includes('Unexpected field'),
      'unknown payment fields are refused outright'
    );
  }
  assert.equal(await countOrders(user.cookie), 0, 'no order was created');

  // And the clean path still prices from the catalog.
  const plan = await getHostingPlan('starter');
  const clean = await postJson(
    '/orders',
    { productType: 'hosting', planSlug: 'starter' },
    { Cookie: user.cookie, 'Idempotency-Key': 'p47j-' + unique().slice(0, 16) }
  );
  assert.equal(clean.response.status, 201);
  assert.equal(String(clean.body.data.amount), String(plan.price));
});

/* ------------------------------------------------------------------ */
/* 16: invalid/missing gateway URL → no redirect + safe recovery        */
/* ------------------------------------------------------------------ */

test('[P-16] untrusted gateway URL never reaches the browser; client guard rejects unsafe URLs', async () => {
  mock.initMode = 'evil';
  try {
    const user = await registerUser('p47-evil');
    const order = (await postJson(
      '/orders',
      { productType: 'hosting', planSlug: 'starter' },
      { Cookie: user.cookie, 'Idempotency-Key': 'p47e-' + unique().slice(0, 16) }
    )).body.data;

    const pay = await postJson('/payments', { orderId: order.id }, {
      Cookie: user.cookie,
    });
    assert.equal(pay.response.status, 502);
    assert.equal(pay.body.error.code, 'PAYMENT_PROVIDER_ERROR');
    assert.equal(
      JSON.stringify(pay.body).includes('evil.example'),
      false,
      'no redirect target is ever returned'
    );
    const payment = await getPaymentRow(order.id);
    assert.notEqual(payment.status, 'successful');
    assert.equal((await getOrderRow(order.id)).status, 'awaiting_payment');
  } finally {
    mock.initMode = 'success';
  }

  // Client-side: only absolute http(s) URLs may ever be assigned to location.
  const js = readFrontend('js/checkout.js');
  assert.ok(js.includes('function isSafeGatewayUrl('), 'safe URL helper exists');
  assert.ok(
    js.includes('!isSafeGatewayUrl(body.data.gatewayUrl)'),
    'the redirect is refused unless the URL passes the guard'
  );
  const guardBody = extractFunction(js, 'isSafeGatewayUrl');
  const guard = new Function(`${guardBody}; return isSafeGatewayUrl;`)();
  assert.equal(guard(`${mockBaseUrl}/payment/abc`), true);
  assert.equal(guard('https://evil.example/pay'), false, 'https but untrusted host');
  assert.equal(guard('javascript:alert(1)'), false);
  assert.equal(guard('//evil.example/pay'), false);
  assert.equal(guard('/payment/relative'), false, 'not absolute');
  assert.equal(guard(''), false);
  assert.equal(guard(null), false);
});

/* ------------------------------------------------------------------ */
/* 17-19: next/return target validation (auth.js extraction)            */
/* ------------------------------------------------------------------ */

function loadAuthHelpers() {
  const authSrc = readFrontend('js/auth.js');
  const isSafeBody = extractFunction(authSrc, 'isSafeReturnPath');
  const targetBody = extractFunction(authSrc, 'targetFromUrl');
  const isSafe = new Function(`${isSafeBody}; return isSafeReturnPath;`)();
  const targetFromUrl = (search) =>
    new Function(
      'window',
      `${isSafeBody}; ${targetBody}; return targetFromUrl();`
    )({ location: { search } });
  return { isSafe, targetFromUrl };
}

test('[P-17] valid same-origin internal next/return targets are accepted', () => {
  const { isSafe, targetFromUrl } = loadAuthHelpers();

  assert.equal(isSafe('/checkout?type=hosting&plan=starter'), true);
  assert.equal(isSafe('/dashboard#services'), true);

  assert.equal(
    targetFromUrl('?next=' + encodeURIComponent('/checkout?type=hosting&plan=starter')),
    '/checkout?type=hosting&plan=starter',
    '?next= keeps the full checkout context'
  );
  assert.equal(
    targetFromUrl('?return=' + encodeURIComponent('/checkout?type=vps&plan=s1')),
    '/checkout?type=vps&plan=s1',
    'legacy ?return= keeps the full checkout context'
  );
});

test('[P-18] external next/return targets are rejected', () => {
  const { isSafe, targetFromUrl } = loadAuthHelpers();

  assert.equal(isSafe('https://evil.example/x'), false, 'absolute URL rejected');
  assert.equal(isSafe('http://evil.example/x'), false, 'http absolute rejected');
  assert.equal(isSafe('//evil.example/x'), false, 'protocol-relative rejected');
  assert.equal(isSafe('/\\evil.example'), false, 'backslash trick rejected');

  assert.equal(targetFromUrl('?next=' + encodeURIComponent('https://evil.example')), '');
  assert.equal(targetFromUrl('?return=' + encodeURIComponent('//evil.example')), '');
  assert.equal(
    targetFromUrl('?next=' + encodeURIComponent('javascript:alert(1)')),
    '',
    'javascript: scheme rejected'
  );
});

test('[P-19] malformed/unsafe next/return targets are rejected', () => {
  const { isSafe, targetFromUrl } = loadAuthHelpers();

  assert.equal(isSafe(''), false, 'empty rejected');
  assert.equal(isSafe(null), false);
  assert.equal(isSafe('checkout'), false, 'must start with a single slash');
  assert.equal(isSafe('/checkout\nx'), false, 'control characters rejected');
  assert.equal(isSafe('/checkout\t?x=1'), false, 'tab rejected');
  assert.equal(isSafe('/' + 'a'.repeat(3000)), false, 'over-length rejected');
  assert.equal(isSafe(' https://evil.example'), false, 'leading space rejected');

  assert.equal(targetFromUrl(''), '');
  assert.equal(targetFromUrl('?next=' + encodeURIComponent('/\ncheckout')), '');
  assert.equal(targetFromUrl('?plan=bad slug&type=hosting'), '', 'unsafe plan handoff ignored');
});
