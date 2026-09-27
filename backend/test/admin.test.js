const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;
const FRONTEND_ADMIN = path.join(__dirname, '../../frontend/admin');
const APP_JS = path.join(__dirname, '../src/app.js');

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

async function fetchNoFollow(url, init = {}) {
  return fetch(url, { ...init, redirect: 'manual' });
}

async function registerUser() {
  const email = `admin-test-${unique()}@example.com`;
  const password = validPassword();
  const { response, body } = await postJson('/auth/register', {
    firstName: 'Ada',
    lastName: 'Admin',
    email,
    password,
  });
  return { response, body, email, password };
}

async function loginUser(email, password) {
  return postJson('/auth/login', { email, password });
}

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

async function promoteAdmin(email) {
  await pool.query(
    `UPDATE users SET role = 'admin', status = 'active' WHERE email = $1`,
    [email.toLowerCase()]
  );
}

async function demoteCustomer(email) {
  await pool.query(
    `UPDATE users SET role = 'customer' WHERE email = $1`,
    [email.toLowerCase()]
  );
}

test('admin: users.role column exists with default customer + CHECK', async () => {
  const { rows } = await pool.query(
    `SELECT column_default, is_nullable, data_type
     FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'role'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data_type, 'character varying');

  const def = await pool.query(
    `SELECT pg_get_expr(d.adbin, d.adrelid) AS default_expr
     FROM pg_attrdef d
     JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'users' AND a.attname = 'role'`
  );
  assert.ok(def.rows.length >= 1);
  assert.match(String(def.rows[0].default_expr), /customer/);

  const check = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conname = 'users_role_check' AND conrelid = 'users'::regclass`
  );
  assert.equal(check.rows.length, 1);
  assert.match(check.rows[0].def, /customer/);
  assert.match(check.rows[0].def, /admin/);
});

test('admin: migration 014 is applied and re-run is a no-op', async () => {
  const applied = await pool.query(
    `SELECT version FROM schema_migrations WHERE version = $1`,
    ['014_harden_admin_role.sql']
  );
  assert.equal(applied.rows.length, 1);

  const { runUp } = require('../src/services/migrator');
  await runUp();
  const again = await pool.query(
    `SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = $1`,
    ['014_harden_admin_role.sql']
  );
  assert.equal(again.rows[0].n, 1);
});

test('admin: registration creates customer, never admin (and rejects role field)', async () => {
  const { response, body, email } = await registerUser();
  assert.equal(response.status, 201);
  assert.equal(body.data.user.role, 'customer');

  const dbRow = await pool.query(`SELECT role FROM users WHERE email = $1`, [
    email,
  ]);
  assert.equal(dbRow.rows[0].role, 'customer');

  const withRole = await postJson('/auth/register', {
    firstName: 'X',
    lastName: 'Y',
    email: `role-${unique()}@example.com`,
    password: validPassword(),
    role: 'admin',
  });
  assert.equal(withRole.response.status, 400);
  assert.equal(withRole.body.error.code, 'VALIDATION_ERROR');
});

test('admin: GET /api/admin/me unauthenticated → 401', async () => {
  const { response, body } = await api('/admin/me');
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('admin: GET /api/admin/health unauthenticated → 401', async () => {
  const { response, body } = await api('/admin/health');
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('admin: customer session → 403 on /api/admin/*', async () => {
  const { email, password } = await registerUser();
  const login = await loginUser(email, password);
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);

  for (const p of ['/admin/me', '/admin/health']) {
    const { response, body } = await api(p, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 403, `${p} → ${response.status}`);
    assert.equal(body.error.code, 'FORBIDDEN');
  }

  await demoteCustomer(email);
});

test('admin: admin session → 200 on /api/admin/me and /api/admin/health (no secrets)', async () => {
  const { email, password } = await registerUser();
  await promoteAdmin(email);
  const login = await loginUser(email, password);
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);

  const me = await api('/admin/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
  assert.equal(me.body.success, true);
  assert.equal(me.body.data.admin.role, 'admin');
  assert.equal(me.body.data.admin.email, email);
  assert.ok(me.body.data.admin.id);
  const raw = JSON.stringify(me.body);
  assert.equal(raw.includes('password_hash'), false);
  assert.equal(raw.includes('$argon2'), false);
  assert.equal(raw.includes('session_hash'), false);

  const health = await api('/admin/health', { headers: { Cookie: cookie } });
  assert.equal(health.response.status, 200);
  assert.equal(health.body.data.status, 'ok');
  assert.equal(health.body.data.role, 'admin');
  assert.equal(JSON.stringify(health.body).includes('database'), false);
  assert.equal(JSON.stringify(health.body).includes('password'), false);

  await demoteCustomer(email);
});

test('admin: GET-only + body rejected; cross-origin Origin → 403', async () => {
  const { email, password } = await registerUser();
  await promoteAdmin(email);
  const login = await loginUser(email, password);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);

  const postMe = await api('/admin/me', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(postMe.response.status, 404);

  // fetch() forbids a body on GET — send a raw request with a JSON body.
  const getWithBody = await new Promise((resolve, reject) => {
    const http = require('node:http');
    const req = http.request(
      `${API}/admin/me`,
      {
        method: 'GET',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength('{"x":1}'),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d) });
          } catch (e) {
            resolve({ status: res.statusCode, body: null });
          }
        });
      }
    );
    req.on('error', reject);
    req.write('{"x":1}');
    req.end();
  });
  assert.equal(getWithBody.status, 400);
  assert.equal(getWithBody.body.error.code, 'VALIDATION_ERROR');

  const evil = await api('/admin/me', {
    headers: {
      Cookie: cookie,
      Origin: 'https://evil.example.com',
    },
  });
  assert.equal(evil.response.status, 403);
  assert.equal(evil.body.error.code, 'CSRF_INVALID');

  await demoteCustomer(email);
});

test('admin: suspended admin → 403 ACCOUNT_DISABLED', async () => {
  const { email, password } = await registerUser();
  await promoteAdmin(email);
  const login = await loginUser(email, password);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);

  await pool.query(`UPDATE users SET status = 'suspended' WHERE email = $1`, [
    email,
  ]);
  const { response, body } = await api('/admin/me', {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'ACCOUNT_DISABLED');

  await pool.query(
    `UPDATE users SET status = 'active', role = 'customer' WHERE email = $1`,
    [email]
  );
});

test('admin frontend: clean routes serve HTML, .html 301, trailing slash 301', async () => {
  const routes = ['/admin/login', '/admin/dashboard'];
  for (const route of routes) {
    const res = await fetch(`${BASE_URL}${route}`);
    assert.equal(res.status, 200, `${route} → ${res.status}`);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
  }

  const root = await fetchNoFollow(`${BASE_URL}/admin`);
  assert.equal(root.status, 301);
  const rootLoc = root.headers.get('location') || '';
  assert.ok(
    rootLoc === '/admin/dashboard' || rootLoc.endsWith('/admin/dashboard'),
    `root Location ${rootLoc}`
  );

  const legacy = {
    '/admin/index.html': '/admin/dashboard',
    '/admin/login.html': '/admin/login',
    '/admin/dashboard.html': '/admin/dashboard',
  };
  for (const [oldPath, dest] of Object.entries(legacy)) {
    const res = await fetchNoFollow(`${BASE_URL}${oldPath}`);
    assert.equal(res.status, 301, `${oldPath} → ${res.status}`);
    const loc = res.headers.get('location') || '';
    assert.ok(
      loc === dest || loc.endsWith(dest),
      `${oldPath} Location ${loc} expected ${dest}`
    );
  }

  for (const slash of ['/admin/', '/admin/login/', '/admin/dashboard/']) {
    const res = await fetchNoFollow(`${BASE_URL}${slash}`);
    assert.equal(res.status, 301, `${slash} → ${res.status}`);
    const loc = res.headers.get('location') || '';
    assert.equal(loc.endsWith('/'), false, `${slash} → ${loc}`);
  }
});

test('admin frontend: CSP-safe markup (no inline script/style/event handlers)', () => {
  const files = ['index.html', 'login.html', 'dashboard.html'];
  for (const file of files) {
    const html = fs.readFileSync(path.join(FRONTEND_ADMIN, file), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, `${file} inline script`);
    assert.doesNotMatch(html, /<style\b/i, `${file} inline style block`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${file} style attribute`);
    assert.doesNotMatch(
      html,
      /\son[a-z]+\s*=\s*["']/i,
      `${file} inline event handler`
    );
    assert.match(html, /href="\/admin\/css\/admin\.css"/, `${file} missing admin.css`);
    assert.doesNotMatch(html, /href="css\//, `${file} relative css`);
    assert.doesNotMatch(html, /src="js\//, `${file} relative js`);
    assert.match(
      html,
      /rel="canonical"\s+href="https:\/\/billing\.flarenodesbd\.com\//,
      `${file} canonical`
    );
    assert.match(html, /name="robots" content="noindex, nofollow"/, `${file} noindex`);
  }

  const login = fs.readFileSync(path.join(FRONTEND_ADMIN, 'login.html'), 'utf8');
  assert.match(login, /src="\/admin\/js\/admin-auth\.js"/);
  const dash = fs.readFileSync(path.join(FRONTEND_ADMIN, 'dashboard.html'), 'utf8');
  assert.match(dash, /src="\/admin\/js\/admin-auth\.js"/);
  assert.match(dash, /src="\/admin\/js\/admin-dashboard\.js"/);
});

test('admin frontend: admin JS uses clean paths and credential-including fetch', () => {
  const auth = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js/admin-auth.js'),
    'utf8'
  );
  assert.match(auth, /\/api\/admin\/me/);
  const dashJs = fs.readFileSync(
    path.join(FRONTEND_ADMIN, 'js/admin-dashboard.js'),
    'utf8'
  );
  assert.match(
    `${auth}\n${dashJs}`,
    /\/api\/admin\/health/,
    'admin health poll lives in auth or dashboard JS'
  );
  assert.match(auth, /credentials:\s*["']include["']/);
  assert.match(auth, /\/admin\/login/);
  assert.match(auth, /\/admin\/dashboard/);
  assert.doesNotMatch(
    auth,
    /["'](login|dashboard|index)\.html/,
    'admin JS must not navigate to .html paths'
  );
  assert.doesNotMatch(auth, /innerHTML\s*=/, 'no innerHTML');
});

test('admin: API paths are never redirected by page middleware', async () => {
  for (const p of ['/api/admin/me', '/api/admin/health']) {
    const res = await fetchNoFollow(`${BASE_URL}${p}`);
    assert.notEqual(res.status, 301, `${p} must not 301`);
    assert.notEqual(res.status, 302, `${p} must not 302`);
    assert.equal(res.status, 401, `${p} → ${res.status}`);
  }
});

test('admin: static admin assets are served without redirect', async () => {
  for (const asset of ['/admin/css/admin.css', '/admin/js/admin-auth.js']) {
    const res = await fetchNoFollow(`${BASE_URL}${asset}`);
    assert.equal(res.status, 200, `${asset} → ${res.status}`);
    assert.equal(res.headers.get('location'), null, asset);
  }
});

test('admin: app.js registers admin clean routes and drops legacy empty static', () => {
  const src = fs.readFileSync(APP_JS, 'utf8');
  assert.match(src, /ADMIN_PAGES/);
  assert.match(src, /'\/admin\/login'/);
  assert.match(src, /'\/admin\/dashboard'/);
  assert.match(src, /app\.get\('\/admin'/);
  assert.doesNotMatch(
    src,
    /app\.use\(['"]\/admin['"],\s*express\.static/,
    'must not serve empty repo-root admin/ as static'
  );
  const apiIdx = src.indexOf('app.use(config.apiPrefix, apiRoutes)');
  const staticIdx = src.indexOf('app.use(express.static');
  assert.ok(apiIdx !== -1 && staticIdx !== -1 && apiIdx < staticIdx);
});

test('admin: no auto-promotion via unexpected profile fields on /api/auth/me', async () => {
  const { email, password } = await registerUser();
  const login = await loginUser(email, password);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  const { response, body } = await api('/auth/me', {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.user.role, 'customer');
  assert.equal(JSON.stringify(body).includes('password_hash'), false);
});
