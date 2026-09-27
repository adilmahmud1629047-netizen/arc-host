const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;
const FRONTEND_DIR = path.join(__dirname, '../../frontend');

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;

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

async function api(pathname, options = {}) {
  const response = await fetch(`${API}${pathname}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch (err) {
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

async function registerAndLogin() {
  const email = `nav-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Nav',
    lastName: 'Test',
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

async function fetchPage(pagePath, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  return fetch(`${BASE_URL}${pagePath}`, { headers });
}

function readFrontend(relPath) {
  return fs.readFileSync(path.join(FRONTEND_DIR, relPath), 'utf8');
}

const PUBLIC_PAGES = [
  'index.html',
  'web-hosting.html',
  'vps-hosting.html',
  'minecraft-hosting.html',
  'about.html',
  'faq.html',
  'contact.html',
  'login.html',
  'register.html',
  'checkout.html',
  'payment-success.html',
  'payment-failed.html',
  'payment-cancelled.html',
];

let pool;

before(async () => {
  const { runUp } = require('../src/services/migrator');
  await runUp();
  const db = require('../src/config/database');
  pool = db;
});

after(async () => {
  if (pool) {
    await pool.closePool().catch(() => {});
  }
});

test('regression: anonymous Home — /me is 401 and Login/Get Started markup remains', async () => {
  const me = await api('/auth/me');
  assert.equal(me.response.status, 401);

  const page = await fetchPage('/');
  assert.equal(page.status, 200);
  const html = await page.text();

  assert.match(html, /data-auth-nav/);
  assert.match(html, /data-auth-anon[\s\S]*?href="\/login"[\s\S]*?Login/);
  assert.match(html, /data-auth-anon[\s\S]*?href="\/register"[\s\S]*?Get Started/);
  assert.match(html, /data-auth-user[^>]*hidden/);
  assert.match(html, /data-auth-user[\s\S]*?href="\/dashboard"[\s\S]*?Dashboard/);
  assert.match(html, /js\/auth-nav\.js/);
});

test('regression: authenticated Home — /me is 200 and Dashboard control is present for swap', async () => {
  const { cookie } = await registerAndLogin();

  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
  assert.equal(me.body.success, true);
  assert.ok(me.body.data.user.email);

  const page = await fetchPage('/', cookie);
  assert.equal(page.status, 200);
  const html = await page.text();

  // Static SSR keeps both states; auth-nav.js shows user block only on 200.
  assert.match(html, /data-auth-user[^>]*hidden/);
  assert.match(html, /href="\/dashboard">Dashboard</);
  assert.match(html, /data-auth-anon/);
  assert.match(html, /js\/auth-nav\.js/);
});

test('regression: auth-nav.js treats only 200 as logged-in; failures keep anonymous UI', async () => {
  const src = readFrontend('js/auth-nav.js');

  assert.match(src, /credentials:\s*"include"/);
  assert.match(src, /\/api\/auth\/me/);
  assert.match(src, /response\.status === 200/);
  assert.match(src, /data-auth-anon/);
  assert.match(src, /data-auth-user/);

  // Must not treat non-200 as logout, must not redirect or call logout.
  assert.doesNotMatch(src, /status === 401[\s\S]{0,80}(location|replace|href)/);
  assert.doesNotMatch(src, /auth\/logout/);
  assert.doesNotMatch(src, /localStorage|sessionStorage/);
  assert.doesNotMatch(src, /document\.cookie/);
  assert.doesNotMatch(src, /fh_session/);
  assert.doesNotMatch(src, /window\.location/);
  assert.doesNotMatch(src, /location\.replace/);
  assert.doesNotMatch(src, /location\.href/);

  // Network / non-200 paths fall through without mutating UI (catch is empty of mutations).
  assert.match(src, /catch\s*\(/);
  assert.doesNotMatch(
    src,
    /catch\s*\([^)]*\)\s*\{[^}]*anon\.hidden\s*=\s*false/
  );
});

test('regression: session remains valid after Home navigation sequence', async () => {
  const { email, cookie } = await registerAndLogin();

  const home = await fetchPage('/', cookie);
  assert.equal(home.status, 200);

  const dash = await fetchPage('/dashboard', cookie);
  assert.equal(dash.status, 200);

  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
  assert.equal(me.body.data.user.email, email);
});

test('regression: after logout, Home keeps Login/Get Started and /me is 401', async () => {
  const { cookie } = await registerAndLogin();

  const before = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(before.response.status, 200);

  const logout = await postJson('/auth/logout', {}, { Cookie: cookie });
  assert.equal(logout.response.status, 200);

  const after = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(after.response.status, 401);

  const page = await fetchPage('/', cookie);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-auth-anon[\s\S]*?href="\/login"/);
  assert.match(html, /data-auth-anon[\s\S]*?href="\/register"/);
  assert.match(html, /data-auth-user[^>]*hidden/);
});

test('regression: direct /index.html load while authenticated still ships auth-nav hooks', async () => {
  const { cookie } = await registerAndLogin();

  const page = await fetchPage('/', cookie);
  assert.equal(page.status, 200);
  const html = await page.text();

  assert.match(html, /data-auth-nav/);
  assert.match(html, /js\/auth-nav\.js/);
  assert.match(html, /href="\/dashboard">Dashboard</);

  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
});

test('regression: refresh Home while authenticated — session and markup intact', async () => {
  const { cookie } = await registerAndLogin();

  // Two loads = refresh-equivalent
  const first = await fetchPage('/', cookie);
  assert.equal(first.status, 200);
  const second = await fetchPage('/', cookie);
  assert.equal(second.status, 200);

  const html = await second.text();
  assert.match(html, /data-auth-user[^>]*hidden/);
  assert.match(html, /js\/auth-nav\.js/);

  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
});

test('regression: auth-nav initializes once — single-flight guard, single /me fetch site', async () => {
  const src = readFrontend('js/auth-nav.js');

  // Only one fetch to /api/auth/me in the file
  const fetchCount = (src.match(/fetch\(\s*["']\/api\/auth\/me["']/g) || [])
    .length;
  assert.equal(fetchCount, 1, 'expected exactly one /me fetch call site');

  // Duplicate init guard present
  assert.match(src, /initialized/);
  assert.match(src, /if \(initialized\) return/);

  // DOMContentLoaded or readyState path attaches once
  assert.match(src, /DOMContentLoaded/);
});

test('regression: all public pages include auth-nav markup and script; dashboard does not', async () => {
  for (const page of PUBLIC_PAGES) {
    const html = readFrontend(page);
    assert.match(html, /data-auth-nav/, `${page} missing data-auth-nav`);
    assert.match(html, /data-auth-anon/, `${page} missing data-auth-anon`);
    assert.match(html, /data-auth-user[^>]*hidden/, `${page} missing hidden user block`);
    assert.match(html, /js\/auth-nav\.js/, `${page} missing auth-nav.js`);
    assert.doesNotMatch(html, /js\/dashboard\.js/, `${page} must not load dashboard.js`);
  }

  const dash = readFrontend('dashboard.html');
  assert.doesNotMatch(dash, /js\/auth-nav\.js/, 'dashboard must not load auth-nav.js');
  assert.doesNotMatch(dash, /data-auth-nav/, 'dashboard must not use public auth-nav hooks');
});

test('regression: auth-nav source never exposes session secrets to JS', async () => {
  const src = readFrontend('js/auth-nav.js');
  assert.doesNotMatch(src, /fh_session/);
  assert.doesNotMatch(src, /document\.cookie/);
  assert.doesNotMatch(src, /password/i);
  assert.doesNotMatch(src, /localStorage|sessionStorage/);
  assert.doesNotMatch(src, /auth\/logout/);
});

test('regression: homepage Get Started CTA ships data-auth-cta hook + safe default href', async () => {
  const page = await fetchPage('/');
  assert.equal(page.status, 200);
  const html = await page.text();

  assert.match(
    html,
    /data-auth-cta="get-started"/,
    'homepage missing data-auth-cta="get-started"'
  );
  assert.match(
    html,
    /href="\/register"[^>]*data-auth-cta="get-started"|data-auth-cta="get-started"[^>]*href="\/register"/,
    'auth CTA must default to /register'
  );

  // Product CTAs must not be blanket-rewritten
  assert.match(html, /href="\/minecraft-hosting"[^>]*>Explore Minecraft Hosting</);
});

test('regression: auth-nav routes data-auth-cta — 200 → dashboard, else register', async () => {
  const src = readFrontend('js/auth-nav.js');

  assert.match(src, /data-auth-cta="get-started"/);
  assert.match(src, /credentials:\s*"include"/);
  assert.match(src, /\/api\/auth\/me/);
  assert.match(src, /response\.status === 200/);
  assert.match(src, /\/dashboard/);
  assert.match(src, /\/register/);
  assert.match(src, /applyAuthCta\(true\)/);
  assert.match(src, /applyAuthCta\(false\)/);

  // Still a single /me fetch site
  const fetchCount = (src.match(/fetch\(\s*["']\/api\/auth\/me["']/g) || []).length;
  assert.equal(fetchCount, 1);

  // Never call logout, never read session storage/cookies
  assert.doesNotMatch(src, /auth\/logout/);
  assert.doesNotMatch(src, /localStorage|sessionStorage/);
  assert.doesNotMatch(src, /document\.cookie/);
  assert.doesNotMatch(src, /fh_session/);

  // No auto-redirect on auth failures
  assert.doesNotMatch(src, /window\.location/);
  assert.doesNotMatch(src, /location\.replace/);
  assert.doesNotMatch(src, /location\.href/);
});

test('regression: auth CTA keeps /register when /me is 401 (HTML default)', async () => {
  const me = await api('/auth/me');
  assert.equal(me.response.status, 401);

  const page = await fetchPage('/');
  const html = await page.text();
  const match = html.match(
    /<a[^>]*data-auth-cta="get-started"[^>]*>|<a[^>]*href="\/register"[^>]*data-auth-cta="get-started"[^>]*>/
  );
  assert.ok(match, 'expected data-auth-cta element');
  assert.match(match[0], /href="\/register"/);
});

test('regression: auth CTA source maps /me 200 → dashboard destination', async () => {
  const { cookie } = await registerAndLogin();

  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);

  const page = await fetchPage('/', cookie);
  assert.equal(page.status, 200);

  const src = readFrontend('js/auth-nav.js');
  // On 200 the client swaps CTA to dashboard before navigation
  assert.match(src, /if \(response\.status === 200\)[\s\S]{0,400}applyAuthCta\(true\)/);
  assert.match(src, /loggedIn \? "\/dashboard" : "\/register"/);
});

test('regression: auth CTA network/5xx path keeps safe register default and does not logout', async () => {
  const src = readFrontend('js/auth-nav.js');

  // catch applies safe false (register) without logout or redirect
  assert.match(src, /catch\s*\(/);
  assert.match(src, /applyAuthCta\(false\)/);
  assert.doesNotMatch(src, /auth\/logout/);
  assert.doesNotMatch(src, /window\.location/);
  assert.doesNotMatch(src, /location\.href/);
  assert.doesNotMatch(src, /localStorage|sessionStorage/);
});

test('regression: clicking auth CTA never calls /api/auth/logout', async () => {
  const src = readFrontend('js/auth-nav.js');
  assert.doesNotMatch(src, /\/api\/auth\/logout/);
  assert.doesNotMatch(src, /auth\/logout/);

  const html = readFrontend('index.html');
  // CTA is a plain anchor — no inline handlers that could logout
  const ctaTags = html.match(/<a[^>]*data-auth-cta="get-started"[^>]*>/g) || [];
  assert.ok(ctaTags.length >= 1);
  for (const tag of ctaTags) {
    assert.doesNotMatch(tag, /onclick/i);
    assert.doesNotMatch(tag, /logout/i);
  }
});

test('regression: only homepage platform CTAs use data-auth-cta; nav markup unchanged', async () => {
  const pages = [
    'index.html',
    'web-hosting.html',
    'vps-hosting.html',
    'minecraft-hosting.html',
    'about.html',
    'faq.html',
    'contact.html',
  ];

  for (const page of pages) {
    const html = readFrontend(page);
    // Nav still has classic Login | Get Started / Dashboard swap
    assert.match(html, /data-auth-anon[\s\S]*?href="\/register"[\s\S]*?Get Started/, page);
    assert.match(html, /data-auth-user[^>]*hidden/, page);
    assert.match(html, /data-auth-user[\s\S]*?href="\/dashboard"[\s\S]*?Dashboard/, page);
  }

  // Only homepage platform signup CTAs are hooked
  const home = readFrontend('index.html');
  const homeHooks = (home.match(/data-auth-cta="get-started"/g) || []).length;
  assert.ok(homeHooks >= 1, 'homepage expected at least one auth CTA hook');

  const mc = readFrontend('minecraft-hosting.html');
  assert.doesNotMatch(mc, /data-auth-cta=/, 'product page CTAs stay static');

  const web = readFrontend('web-hosting.html');
  assert.doesNotMatch(web, /data-auth-cta=/);
});
