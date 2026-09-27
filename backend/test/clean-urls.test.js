const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// Client test server. 5056 is this project's test port — 5055 belongs to the
// inherited FLARE harness and must never be used for client tests.
const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const FRONTEND_DIR = path.join(__dirname, '../../frontend');

// Public origin this project is tested against. Environment-driven so the
// client never inherits the FLARE production domain. Empty/unset values fall
// back to a local origin, and trailing slashes are stripped exactly once so
// `${PUBLIC_URL}/path` is always deterministic.
const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  process.env.APP_PUBLIC_URL ||
  'http://127.0.0.1:5001/'
).replace(/\/+$/, '');

// A local test origin is allowed to appear in canonicals; a real public origin
// must never contain localhost / 127.0.0.1.
const PUBLIC_URL_IS_LOCAL =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(PUBLIC_URL);

const CLEAN_ROUTES = [
  '/',
  '/web-hosting',
  '/vps-hosting',
  '/minecraft-hosting',
  '/about',
  '/faq',
  '/contact',
  '/login',
  '/register',
  '/dashboard',
  '/checkout',
  '/payment-success',
  '/payment-failed',
  '/payment-cancelled',
];

const LEGACY_MAP = {
  '/index.html': '/',
  '/web-hosting.html': '/web-hosting',
  '/vps-hosting.html': '/vps-hosting',
  '/minecraft-hosting.html': '/minecraft-hosting',
  '/about.html': '/about',
  '/faq.html': '/faq',
  '/contact.html': '/contact',
  '/login.html': '/login',
  '/register.html': '/register',
  '/dashboard.html': '/dashboard',
  '/checkout.html': '/checkout',
  '/payment-success.html': '/payment-success',
  '/payment-failed.html': '/payment-failed',
  '/payment-cancelled.html': '/payment-cancelled',
};

async function fetchNoFollow(url, init = {}) {
  return fetch(url, { ...init, redirect: 'manual' });
}

function readFrontend(relPath) {
  return fs.readFileSync(path.join(FRONTEND_DIR, relPath), 'utf8');
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

test('clean URLs: every public route returns 200 HTML', async () => {
  for (const route of CLEAN_ROUTES) {
    const res = await fetch(`${BASE_URL}${route}`);
    assert.equal(res.status, 200, `${route} → ${res.status}`);
    const type = res.headers.get('content-type') || '';
    assert.match(type, /text\/html/, `${route} content-type ${type}`);
  }
});

test('clean URLs: legacy .html paths 301 to clean destinations', async () => {
  for (const [legacy, clean] of Object.entries(LEGACY_MAP)) {
    const res = await fetchNoFollow(`${BASE_URL}${legacy}`);
    assert.equal(res.status, 301, `${legacy} status ${res.status}`);
    const loc = res.headers.get('location') || '';
    assert.ok(
      loc === clean || loc.endsWith(clean),
      `${legacy} Location ${loc} expected ${clean}`
    );
  }
});

test('clean URLs: redirects preserve query strings', async () => {
  const cases = [
    ['/login.html?return=%2Fdashboard', '/login?return=%2Fdashboard'],
    ['/checkout.html?type=hosting&plan=starter', '/checkout?type=hosting&plan=starter'],
    ['/register.html?plan=starter&type=hosting', '/register?plan=starter&type=hosting'],
  ];
  for (const [legacy, expectedSuffix] of cases) {
    const res = await fetchNoFollow(`${BASE_URL}${legacy}`);
    assert.equal(res.status, 301, legacy);
    const loc = res.headers.get('location') || '';
    assert.ok(
      loc.includes(expectedSuffix),
      `${legacy} → ${loc} missing ${expectedSuffix}`
    );
  }
});

test('clean URLs: trailing slash strips to canonical (301, no trailing slash)', async () => {
  for (const route of ['/minecraft-hosting/', '/web-hosting/', '/about/']) {
    const res = await fetchNoFollow(`${BASE_URL}${route}`);
    assert.equal(res.status, 301, `${route} → ${res.status}`);
    const loc = res.headers.get('location') || '';
    assert.equal(loc.endsWith('/'), false, `${route} → ${loc}`);
    assert.ok(loc.includes(route.replace(/\/$/, '')), loc);
  }
});

test('clean URLs: API routes are never redirected by page middleware', async () => {
  const paths = ['/api/health', '/api/auth/me', '/api/auth/me?x=1'];
  for (const p of paths) {
    const res = await fetchNoFollow(`${BASE_URL}${p}`);
    assert.notEqual(res.status, 301, `${p} must not 301`);
    assert.notEqual(res.status, 302, `${p} must not 302`);
    assert.ok(res.status === 200 || res.status === 401, `${p} → ${res.status}`);
  }
});

test('clean URLs: static assets are never redirected', async () => {
  const assets = [
    '/css/styles.css',
    '/js/main.js',
    '/js/auth-nav.js',
    '/js/auth.js',
  ];
  for (const p of assets) {
    const res = await fetchNoFollow(`${BASE_URL}${p}`);
    assert.equal(res.status, 200, `${p} → ${res.status}`);
    assert.equal(res.headers.get('location'), null, p);
  }
});

test('clean URLs: trailing slash on non-allowlisted paths is not redirected', async () => {
  const res = await fetchNoFollow(`${BASE_URL}/no-such-page/`);
  assert.notEqual(res.status, 301, 'unknown path must not 301 via trailing-slash rule');
  assert.equal(res.status, 404, `got ${res.status}`);
});

test('clean URLs: no sendFile(req.path) / unbounded page catch-all in app.js', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/app.js'),
    'utf8'
  );
  assert.doesNotMatch(src, /sendFile\(\s*req\.path/);
  assert.doesNotMatch(src, /sendFile\(\s*path\.join\([^)]*req\.path/);
  // Allowlist present
  assert.match(src, /PUBLIC_PAGES/);
  assert.match(src, /HTML_TO_CLEAN/);
  // API before page routes (match code, not comments)
  const apiIdx = src.indexOf('app.use(config.apiPrefix, apiRoutes)');
  const staticIdx = src.indexOf('app.use(express.static');
  assert.ok(apiIdx !== -1 && staticIdx !== -1 && apiIdx < staticIdx,
    'API routes must register before static/page fallbacks');
});

test('clean URLs: internal HTML uses root-relative clean links (no page .html hrefs)', () => {
  const files = fs
    .readdirSync(FRONTEND_DIR)
    .filter((f) => f.endsWith('.html'));
  assert.ok(files.length >= 14, `expected ≥14 html files, got ${files.length}`);

  for (const file of files) {
    const html = readFrontend(file);
    // No relative page .html links
    const badHref = html.match(/href="(?:\/)?(?:[a-z0-9-]+)\.html(?:[?#][^"]*)?"/gi) || [];
    assert.deepEqual(badHref, [], `${file} has .html hrefs: ${badHref.join(', ')}`);
    // Root-relative assets
    assert.doesNotMatch(html, /href="css\//, `${file} relative css`);
    assert.doesNotMatch(html, /src="js\//, `${file} relative js`);
    assert.match(html, /href="\/css\/styles\.css"/, `${file} missing /css/styles.css`);
    // Canonical must identify this project's origin and its own clean route:
    // either an absolute URL under PUBLIC_URL, or a root-relative clean path
    // (the client frontend emits root-relative canonicals and resolves them
    // against the request host at render time).
    const canon = html.match(/rel="canonical" href="([^"]+)"/);
    assert.ok(canon, `${file} missing canonical`);
    const canonical = canon[1];
    const expectedPath =
      file === 'index.html' ? '/' : '/' + file.replace(/\.html$/, '');
    let canonicalPath = canonical;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(canonical)) {
      assert.ok(
        canonical.startsWith(PUBLIC_URL + '/'),
        `${file} canonical ${canonical} not under ${PUBLIC_URL}/`
      );
      if (!PUBLIC_URL_IS_LOCAL) {
        assert.equal(
          /localhost|127\.0\.0\.1/.test(canonical),
          false,
          `${file} canonical has local host`
        );
      }
      canonicalPath = canonical.slice((PUBLIC_URL + '/').length);
      canonicalPath = canonicalPath ? '/' + canonicalPath : '/';
    } else {
      assert.match(
        canonical,
        /^\/(?!\/)/,
        `${file} canonical ${canonical} must be root-relative`
      );
      assert.doesNotMatch(
        canonical,
        /\.html(?:[?#]|$)/,
        `${file} canonical ${canonical} targets a legacy .html path`
      );
    }
    assert.equal(
      canonicalPath,
      expectedPath,
      `${file} canonical ${canonical} must point at ${expectedPath}`
    );
  }
});

test('clean URLs: JS navigation uses clean paths (auth/checkout/dashboard)', () => {
  const checks = {
    'js/auth-nav.js': [/\/dashboard/, /\/register/],
    'js/auth.js': [/\/dashboard/, /legacy/],
    'js/dashboard.js': [/\/checkout\?type=/, /\/login\?return=/],
    'js/checkout.js': [/\/vps-hosting/, /\/web-hosting/, /\/login\?return=/],
    'js/payment-status.js': [/\/login\?return=/],
    'js/plans.js': [/\/checkout\?type=/],
  };
  for (const [rel, patterns] of Object.entries(checks)) {
    const src = readFrontend(rel);
    for (const re of patterns) {
      assert.match(src, re, `${rel} missing ${re}`);
    }
    // Must not navigate to page .html destinations (except legacy validator comment/pattern)
    if (rel !== 'js/auth.js') {
      assert.doesNotMatch(
        src,
        /["'](login|register|dashboard|checkout|index)\.html/,
        `${rel} still uses .html navigation`
      );
    }
  }
});

test('clean URLs: sslcommerz controller result redirects still target result pages (logic unchanged)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/controllers/sslcommerzController.js'),
    'utf8'
  );
  // Payment callback logic untouched: still builds /payment-*.html targets
  // (middleware 301s those to clean paths for browsers).
  assert.match(src, /payment-\$\{page\}\.html/);
  assert.match(src, /res\.redirect\(302, target\)/);
});
