const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;
const FRONTEND_DIR = path.join(__dirname, '../../frontend');
const FRONTEND_ADMIN = path.join(__dirname, '../../frontend/admin');

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
      if (nameValue !== 'fh_session=' && nameValue !== 'fh_session') {
        return nameValue;
      }
    }
  }
  return null;
}

async function req(pathSuffix, options = {}) {
  const response = await fetch(`${API}${pathSuffix}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    body = null;
  }
  return { response, body };
}

async function jsonReq(method, pathSuffix, payload, cookie) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${API}${pathSuffix}`, {
    method,
    headers,
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    body = null;
  }
  return { response, body };
}

async function makeUser(prefix) {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await jsonReq('POST', '/auth/register', {
    firstName: 'Step46',
    lastName: 'Gate',
    email,
    password,
  });
  assert.equal(reg.response.status, 201);
  return { email, password };
}

async function loginCookie(email, password) {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  const cookie = extractSessionCookie(response.headers.getSetCookie());
  assert.ok(cookie, 'expected session cookie');
  return cookie;
}

let pool;
let adminEmail;
let adminCookie;
let customerCookie;

before(async () => {
  const { runUp } = require('../src/services/migrator');
  await runUp();
  const db = require('../src/config/database');
  pool = db;

  const admin = await makeUser('step46-gate-admin');
  await pool.query(
    `UPDATE users SET role = 'admin', status = 'active' WHERE email = $1`,
    [admin.email.toLowerCase()]
  );
  adminEmail = admin.email;
  adminCookie = await loginCookie(admin.email, admin.password);

  const customer = await makeUser('step46-gate-cust');
  customerCookie = await loginCookie(customer.email, customer.password);
});

after(async () => {
  if (pool) {
    await pool.closePool().catch(() => {});
  }
});

/* ------------------------------------------------------------------ */
/* A. Server-side order/auth enforcement (live probes)                 */
/* ------------------------------------------------------------------ */

test('[API-1] anonymous admin plan list is rejected 401', async () => {
  const r = await req('/admin/plans');
  assert.equal(r.response.status, 401);
  assert.match((r.body && r.body.error && r.body.error.message) || '', /Authentication required/);
});

test('[API-2] authenticated customer cannot list admin plans (403)', async () => {
  const r = await req('/admin/plans', {
    headers: { Cookie: customerCookie, Accept: 'application/json' },
  });
  assert.equal(r.response.status, 403);
  assert.match((r.body && r.body.error && r.body.error.message) || '', /Administrator access required/);
});

test('[API-3] anonymous order access is rejected 401 (list + detail)', async () => {
  const list = await req('/orders');
  assert.equal(list.response.status, 401);
  const detail = await req('/orders/11111111-2222-3333-4444-555555555555');
  assert.equal(detail.response.status, 401);
});

test('[API-4] public hosting category enum: web/minecraft 200, vps/blog 400', async () => {
  assert.equal((await req('/plans/hosting?category=web')).response.status, 200);
  assert.equal(
    (await req('/plans/hosting?category=minecraft')).response.status,
    200
  );
  assert.equal((await req('/plans/hosting?category=vps')).response.status, 400);
  assert.equal((await req('/plans/hosting?category=blog')).response.status, 400);
});

test('[API-5] admin list query validation: valid combos 200, bad enums 400', async () => {
  const H = { Cookie: adminCookie, Accept: 'application/json' };
  const cases = [
    ['?productType=hosting&category=web', 200],
    ['?productType=hosting&category=minecraft', 200],
    ['?productType=vps', 200],
    ['?productType=hosting&category=vps', 400],
    ['?productType=vps&category=vps', 400],
    ['?category=vps', 400],
    ['?category=blog', 400],
    ['?productType=bogus', 400],
  ];
  for (const [q, expected] of cases) {
    const r = await req(`/admin/plans${q}`, { headers: H });
    assert.equal(r.response.status, expected, `${q} expected ${expected}`);
  }
});

test('[API-6] create: hosting plan with category=vps is rejected 400 and creates nothing', async () => {
  const slug = `s46-bad-${unique()}`;
  const r = await jsonReq(
    'POST',
    '/admin/plans',
    {
      productType: 'hosting',
      name: 'Step46 Bad Hosting',
      slug,
      price: '100.00',
      billingCycle: 'monthly',
      category: 'vps',
      status: 'inactive',
    },
    adminCookie
  );
  assert.equal(r.response.status, 400);
  const list = await req('/plans/hosting?category=web', {
    headers: { Accept: 'application/json' },
  });
  const rows = (list.body && list.body.data) || [];
  assert.equal(
    rows.some((p) => p.slug === slug),
    false,
    'rejected create must not persist a row'
  );
});

test('[API-7] create: vps plan with a hosting category is rejected 400 and creates nothing', async () => {
  const slug = `s46-bad2-${unique()}`;
  const r = await jsonReq(
    'POST',
    '/admin/plans',
    {
      productType: 'vps',
      name: 'Step46 Bad VPS',
      slug,
      price: '100.00',
      billingCycle: 'monthly',
      category: 'web',
      status: 'inactive',
      cpuCores: 1,
      ramMb: 1024,
      storageGb: 10,
      bandwidthGb: 100,
      ipv4Addresses: 1,
    },
    adminCookie
  );
  assert.equal(r.response.status, 400);
  const list = await req('/plans/vps', {
    headers: { Accept: 'application/json' },
  });
  const rows = (list.body && list.body.data) || [];
  assert.equal(
    rows.some((p) => p.slug === slug),
    false,
    'rejected vps create must not persist a row'
  );
});

test('[API-8] create without productType is rejected 400', async () => {
  const r = await jsonReq(
    'POST',
    '/admin/plans',
    {
      name: 'Step46 NoType',
      slug: `s46-notype-${unique()}`,
      price: '100.00',
      billingCycle: 'monthly',
      category: 'web',
      status: 'inactive',
    },
    adminCookie
  );
  assert.equal(r.response.status, 400);
});

test('[API-9] anonymous create is rejected 401 before validation', async () => {
  const r = await jsonReq('POST', '/admin/plans', {
    productType: 'bogus',
  });
  assert.equal(r.response.status, 401);
});

test('[API-10] PATCH cannot change a hosting plan to vps; plan stays hosting', async () => {
  const H = { Cookie: adminCookie, Accept: 'application/json' };
  const before = await req('/admin/plans?productType=hosting&category=minecraft', {
    headers: H,
  });
  const plan = before.body.data.products[0];
  assert.ok(plan, 'expected a minecraft hosting plan fixture');
  const r = await jsonReq(
    'PATCH',
    `/admin/plans/hosting/${encodeURIComponent(plan.id)}`,
    { productType: 'vps' },
    adminCookie
  );
  assert.equal(r.response.status, 400);
  const after = await req('/admin/plans?productType=hosting&category=minecraft', {
    headers: H,
  });
  const row = after.body.data.products.find((p) => p.id === plan.id);
  assert.ok(row, 'plan still exists');
  assert.equal(row.productType, 'hosting');
});

test('[API-11] PATCH cannot change a vps plan to hosting; plan stays vps', async () => {
  const H = { Cookie: adminCookie, Accept: 'application/json' };
  const before = await req('/admin/plans?productType=vps', { headers: H });
  const plan = before.body.data.products[0];
  assert.ok(plan, 'expected a vps plan fixture');
  const r = await jsonReq(
    'PATCH',
    `/admin/plans/vps/${encodeURIComponent(plan.id)}`,
    { productType: 'hosting' },
    adminCookie
  );
  assert.equal(r.response.status, 400);
  const after = await req('/admin/plans?productType=vps', { headers: H });
  const row = after.body.data.products.find((p) => p.id === plan.id);
  assert.ok(row, 'plan still exists');
  assert.equal(row.productType, 'vps');
});

test('[API-12] PATCH cannot attach a hosting category to a vps plan', async () => {
  const H = { Cookie: adminCookie, Accept: 'application/json' };
  const before = await req('/admin/plans?productType=vps', { headers: H });
  const plan = before.body.data.products[0];
  assert.ok(plan, 'expected a vps plan fixture');
  const r = await jsonReq(
    'PATCH',
    `/admin/plans/vps/${encodeURIComponent(plan.id)}`,
    { category: 'web' },
    adminCookie
  );
  assert.equal(r.response.status, 400);
  const after = await req('/admin/plans?productType=vps', { headers: H });
  const row = after.body.data.products.find((p) => p.id === plan.id);
  assert.equal(
    row.category,
    'vps',
    'vps plan keeps its catalog category after the rejected PATCH'
  );
});

test('[API-13] public vps catalog ignores category filters (200, vps serializer rows)', async () => {
  const r = await req('/plans/vps?category=web');
  assert.equal(r.response.status, 200);
  assert.equal(r.body.success, true);
  const rows = (r.body && r.body.data) || [];
  for (const row of rows) {
    assert.equal(
      row.category,
      undefined,
      'vps serializer rows carry no hosting category'
    );
    assert.ok(row.ipv4Addresses !== undefined, 'vps-specific field present');
  }
});

/* ------------------------------------------------------------------ */
/* B. Purchase gate — frontend source proof                            */
/* ------------------------------------------------------------------ */

test('[PUR-1] auth.js resolves ?next= and legacy ?return= through one safe target resolver', () => {
  const src = readFrontend('js/auth.js');
  assert.match(src, /params\.get\("next"\) \|\| params\.get\("return"\)/);
  assert.match(src, /function targetFromUrl\(/);
  assert.match(src, /function safeReturnPath\(/);
  assert.match(src, /function isSafeReturnPath\(/);
  // Old single-segment validator (the PUR-6 context-loss bug) is gone.
  assert.doesNotMatch(src, /const clean = \/\^\\\/\[A-Za-z0-9_-\]\+/);
});

test('[PUR-2] auth.js same-origin validator allows query targets, rejects // and backslash tricks', () => {
  const src = readFrontend('js/auth.js');
  const body = extractFunction(src, 'isSafeReturnPath');
  const isSafe = new Function(`${body}; return isSafeReturnPath;`)();
  assert.equal(isSafe('/checkout?type=hosting&plan=starterr'), true);
  assert.equal(isSafe('/dashboard#services'), true);
  assert.equal(isSafe('//evil.example'), false, 'protocol-relative rejected');
  assert.equal(isSafe('/\\evil.example'), false, 'backslash trick rejected');
  assert.equal(isSafe('https://evil.example'), false, 'absolute URL rejected');
  assert.equal(isSafe('/checkout\t?x=1'), false, 'control chars rejected');
  assert.equal(isSafe(''), false);
  assert.equal(isSafe(null), false);
});

test('[PUR-3] auth.js legacy plan/type handoff maps onto /checkout (context survives register)', () => {
  const src = readFrontend('js/auth.js');
  const isSafeBody = extractFunction(src, 'isSafeReturnPath');
  const body = extractFunction(src, 'targetFromUrl');
  const load = (search) =>
    new Function(
      'window',
      `${isSafeBody}; ${body}; return targetFromUrl();`
    )({ location: { search } });
  assert.equal(
    load('?next=' + encodeURIComponent('/checkout?type=hosting&plan=starterr')),
    '/checkout?type=hosting&plan=starterr'
  );
  assert.equal(
    load('?return=' + encodeURIComponent('/dashboard#orders')),
    '/dashboard#orders'
  );
  assert.equal(
    load('?plan=starterr&type=hosting'),
    '/checkout?type=hosting&plan=starterr'
  );
  assert.equal(
    load('?return=dashboard.html#billing'),
    '/dashboard#billing',
    'legacy .html destinations still map'
  );
  assert.equal(load('?next=' + encodeURIComponent('//evil.example')), '');
  assert.equal(load('?plan=bad+slug&type=hosting'), '', 'unsafe values ignored');
  assert.equal(load(''), '');
});

test('[PUR-4] auth.js register success auto-signs-in and forwards purchase context', () => {
  const src = readFrontend('js/auth.js');
  const registerBlock = src.slice(src.indexOf('if (response.status === 201)'));
  assert.ok(registerBlock, 'register 201 branch present');
  assert.match(src, /response\.status === 201/);
  // Two login call sites: login form + register auto-login.
  const loginCalls = (
    src.match(/apiRequest\("\/api\/auth\/login"/g) || []
  ).length;
  assert.equal(loginCalls, 2, 'expected login form + register auto-login');
  assert.match(registerBlock, /signedIn/);
  assert.match(registerBlock, /window\.location\.href = returnTo/);
  assert.match(
    registerBlock,
    /\/login\?next=" \+ encodeURIComponent\(target\)/,
    'auto-login failure falls back to the login gate with next'
  );
  assert.match(registerBlock, /Account created\. You can now sign in\./);
});

test('[PUR-5] auth.js carries next across auth-page links and redirects signed-in visitors', () => {
  const src = readFrontend('js/auth.js');
  assert.match(src, /function carryNextOnAuthLinks\(/);
  assert.match(
    src,
    /querySelectorAll\(\s*'a\[href\^="\/login"\], a\[href\^="\/register"\]'\s*\)/
  );
  assert.match(src, /window\.FlareAuthNav\.ready\(\)/);
  assert.match(src, /window\.FlareAuthNav\.isLoggedIn\(\)/);
  assert.match(src, /window\.location\.replace\(safeReturnPath\(\)\)/);
});

test('[PUR-6] auth-nav.js gates data-purchase-cta through /login?next= and exposes FlareAuthNav', () => {
  const src = readFrontend('js/auth-nav.js');
  assert.match(src, /data-purchase-cta/);
  assert.match(src, /data-purchase-href/);
  assert.match(src, /"\/login\?next=" \+ encodeURIComponent\(target\)/);
  assert.match(src, /window\.FlareAuthNav = \{/);
  assert.match(src, /ready:/);
  assert.match(src, /isLoggedIn:/);
  assert.match(src, /refresh:/);
  // Gate still obeys every auth-nav pin: no direct navigation, single /me.
  assert.doesNotMatch(src, /window\.location|location\.replace|location\.href/);
  const fetchCount = (src.match(/fetch\(\s*["']\/api\/auth\/me["']/g) || [])
    .length;
  assert.equal(fetchCount, 1);
  assert.match(src, /loggedIn \? "\/dashboard" : "\/register"/);
});

test('[PUR-7] plans.js card + compare CTAs target /checkout with purchase gate; no register deep links', () => {
  const src = readFrontend('js/plans.js');
  assert.match(src, /\/checkout\?type=/);
  assert.match(src, /data-purchase-cta/);
  assert.match(src, /data-purchase-href/);
  assert.match(src, /function purchaseHref\(/);
  assert.match(src, /refreshAuthGates\(\)/);
  assert.doesNotMatch(src, /\/register\?plan=/);
});

test('[PUR-8] minecraft-page.js config CTA + cards use the checkout purchase gate', () => {
  const src = readFrontend('js/minecraft-page.js');
  assert.match(src, /\/checkout\?type=/);
  assert.match(src, /data-purchase-cta/);
  assert.match(src, /data-purchase-href/);
  assert.match(src, /function applyPurchaseGate\(/);
  assert.doesNotMatch(src, /\/register\?plan=/);
});

test('[PUR-9] customer empty-state copy is the spec text on every public surface', () => {
  const expected = 'Plans are currently unavailable.';
  assert.ok(readFrontend('js/plans.js').includes(expected), 'plans.js');
  assert.ok(
    readFrontend('js/minecraft-page.js').includes(expected),
    'minecraft-page.js'
  );
  assert.ok(readFrontend('js/dashboard.js').includes(expected), 'dashboard.js');
  // Old copy removed from the same files.
  assert.doesNotMatch(readFrontend('js/plans.js'), /No plans available right now/);
  assert.doesNotMatch(
    readFrontend('js/minecraft-page.js'),
    /No plans are published yet/
  );
});

test('[PUR-10] home section CTA is auth-aware; hero and product-page pins intact', () => {
  const home = readFrontend('index.html');
  const hooks = (home.match(/data-auth-cta="get-started"/g) || []).length;
  assert.ok(hooks >= 2, `expected hero + section CTA hooks, saw ${hooks}`);
  assert.match(
    home,
    /data-auth-cta="get-started"[\s\S]{0,200}Start your server/,
    'section CTA carries the auth hook'
  );
  assert.match(
    home,
    /href="\/register"[^>]*data-auth-cta="get-started"|data-auth-cta="get-started"[^>]*href="\/register"/
  );
  for (const page of [
    'web-hosting.html',
    'vps-hosting.html',
    'minecraft-hosting.html',
  ]) {
    assert.doesNotMatch(
      readFrontend(page),
      /data-auth-cta=/,
      `${page} product CTAs stay static`
    );
  }
});

/* ------------------------------------------------------------------ */
/* C. Admin product utility fixes                                       */
/* ------------------------------------------------------------------ */

test('[ADM-1] products.html: hosting-category label, Catalog column, product-type hints', () => {
  const html = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'products.html'),
    'utf8'
  );
  assert.match(html, /<label for="product-category">Hosting category<\/label>/);
  assert.match(html, /<th scope="col">Catalog<\/th>/);
  assert.match(html, /id="product-type-hint"/);
  assert.match(html, /id="product-type-locked-hint"/);
  assert.match(html, /<label for="product-type">Product type<\/label>/);
  assert.doesNotMatch(
    html,
    /<label for="product-category">Category<\/label>/,
    'generic Category label removed'
  );
  assert.match(
    html,
    /Web and Minecraft plans are hosting categories\. VPS is its\s+own catalog\./
  );
  assert.match(html, /Product type cannot be changed after creation\./);
});

test('[ADM-2] admin-products.js: spec empty-state copy for default and filtered views', () => {
  const src = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js', 'admin-products.js'),
    'utf8'
  );
  assert.match(src, /No products yet\. Add your first product\./);
  assert.match(src, /No products match the current filters\./);
  assert.match(src, /function emptyMessage\(p\)/);
  // The old lowercase-anchored default is gone.
  assert.doesNotMatch(src, /"No products on page " \+\s*state\.page \+\s*"\."\s*\)/);
});

test('[ADM-3] admin-products.js: user actions push history; popstate re-renders filters', () => {
  const src = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js', 'admin-products.js'),
    'utf8'
  );
  const pushes = (src.match(/writeUrlState\("push"\)/g) || []).length;
  assert.ok(pushes >= 5, `expected push on tab/filter/reset/pages, saw ${pushes}`);
  assert.match(src, /window\.addEventListener\("popstate", applyUrlState\)/);
  assert.match(src, /function applyUrlState\(\)/);
  assert.match(src, /readUrl\(\);\s*writeUrlState\("replace"\);\s*updateTabs\(\);/);
  // load() must not write history on its own (render != navigation).
  const loadBody = extractFunction(src, 'load');
  assert.doesNotMatch(loadBody, /writeUrlState/);
});

test('[ADM-4] admin-products.js: legacy productType URLs map to category tabs and are normalized away', () => {
  const src = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js', 'admin-products.js'),
    'utf8'
  );
  assert.match(src, /Legacy API-style URLs \(\?productType=vps\) map onto the category tabs\./);
  assert.match(src, /var legacyType = params\.get\("productType"\)/);
  assert.match(src, /if \(legacyType === "vps"\) category = "vps";/);
  assert.match(src, /params\.delete\("productType"\)/);
  // API queries still carry productType (buildQuery) — only the page URL does not.
  const buildBody = extractFunction(src, 'buildQuery');
  assert.match(buildBody, /params\.set\("productType", "vps"\)/);
  assert.match(buildBody, /params\.set\("productType", "hosting"\)/);
});

test('[ADM-5] admin-products.js: success messages are set after the list reload (submit/toggle/delete)', () => {
  const src = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js', 'admin-products.js'),
    'utf8'
  );
  const submit = extractFunction(src, 'submitForm');
  assert.ok(
    submit.indexOf('await load()') < submit.indexOf('"Product updated."'),
    'submitForm: load() before success status'
  );
  const toggle = extractFunction(src, 'toggleStatus');
  assert.ok(
    toggle.indexOf('await load()') < toggle.indexOf('" deactivated.'),
    'toggleStatus: load() before success status'
  );
  const remove = extractFunction(src, 'removeProduct');
  assert.ok(
    remove.indexOf('await load()') < remove.indexOf('" deleted.'),
    'removeProduct: load() before success status'
  );
});

test('[ADM-6] admin-products.js: product type is locked in edit mode with visible hint', () => {
  const src = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js', 'admin-products.js'),
    'utf8'
  );
  const reset = extractFunction(src, 'resetEditor');
  assert.match(reset, /typeSelect\.disabled = false/);
  assert.match(reset, /typeHint\.hidden = false/);
  assert.match(reset, /typeLockedHint\.hidden = true/);
  const openEdit = extractFunction(src, 'openEdit');
  assert.ok(
    openEdit.indexOf('typeSelect.disabled = true') <
      openEdit.indexOf('typeLockedHint.hidden = false'),
    'edit mode disables type select and shows the locked hint'
  );
  assert.match(openEdit, /typeHint\.hidden = true/);
});

test('[ADM-7] admin.css ships the form hint style used by the product-type hints', () => {
  const css = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'css', 'admin.css'),
    'utf8'
  );
  assert.match(css, /\.form-field-hint\s*\{/);
});

test('[ADM-8] admin-products.js safety pins: no innerHTML, no .html nav, FlareAdmin wiring', () => {
  const src = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js', 'admin-products.js'),
    'utf8'
  );
  assert.doesNotMatch(src, /innerHTML\s*=/);
  assert.doesNotMatch(src, /["'](login|dashboard|orders|customers|index)\.html/);
  assert.match(src, /\/api\/admin\/plans/);
  assert.match(src, /FlareAdmin/);
});
