const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;

const unique = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;

function extractFullSessionCookie(setCookie) {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    if (raw.startsWith('fh_session=')) {
      return raw;
    }
  }
  return null;
}

function extractSessionCookie(setCookie) {
  const full = extractFullSessionCookie(setCookie);
  if (!full) return null;
  const nameValue = full.split(';')[0];
  if (nameValue === 'fh_session=' || nameValue === 'fh_session') {
    return null;
  }
  return nameValue;
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    body = null;
  }
  return { response, body };
}

function postJson(path, payload, headers = {}) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

async function registerUser(overrides = {}) {
  const email = overrides.email || `user-${unique()}@example.com`;
  const password = overrides.password || validPassword();
  const payload = {
    firstName: overrides.firstName || 'Ada',
    lastName: overrides.lastName || 'Lovelace',
    email,
    password,
    ...(overrides.payload || {}),
  };
  const { response, body } = await postJson('/auth/register', payload);
  return { response, body, email, password };
}

async function loginUser(email, password, headers = {}) {
  return postJson('/auth/login', { email, password }, headers);
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

test('health endpoint returns 200 with database up', async () => {
  const { response, body } = await api('/health');
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'up');
});

test('registration creates a customer account', async () => {
  const { response, body } = await registerUser();

  assert.equal(response.status, 201);
  assert.equal(body.success, true);
  assert.equal(body.data.user.role, 'customer');
  assert.equal(body.data.user.status, 'active');
  assert.equal(body.data.user.emailVerified, false);
  assert.equal(body.data.user.password, undefined);
  assert.equal(JSON.stringify(body).includes('password_hash'), false);
  assert.equal(JSON.stringify(body).includes('$argon2'), false);
});

test('registration rejects duplicate email with 409', async () => {
  const email = `dup-${unique()}@example.com`;
  const first = await registerUser({ email });
  assert.equal(first.response.status, 201);

  const second = await registerUser({ email });
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error.code, 'EMAIL_EXISTS');
});

test('registration enforces password policy', async () => {
  const cases = [
    { password: 'short', match: /at least 12/i },
    { password: 'alllowercaseonly', match: /uppercase/i },
    { password: 'ALLUPPERCASEONLY', match: /lowercase/i },
    { password: 'NoDigitsHereAtAll', match: /digit/i },
  ];

  for (const item of cases) {
    const { response, body } = await registerUser({ password: item.password });
    assert.equal(response.status, 400, `expected 400 for ${item.password}`);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      body.error.details.some((d) => item.match.test(d)),
      `expected detail matching ${item.match} for ${item.password}`
    );
  }
});

test('registration validates email format', async () => {
  const { response, body } = await registerUser({ email: 'not-an-email' });
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('login returns session cookie and safe user', async () => {
  const { email, password } = await registerUser();
  const { response, body } = await loginUser(email, password);

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.user.email, email);

  const cookieHeader = extractSessionCookie(response.headers.getSetCookie());
  const fullCookie = extractFullSessionCookie(response.headers.getSetCookie());
  assert.ok(cookieHeader, 'expected Set-Cookie fh_session');
  assert.ok(fullCookie);
  assert.match(fullCookie, /HttpOnly/);
  assert.match(fullCookie, /SameSite=Lax/);
  assert.match(fullCookie, /Path=\//);
  assert.equal(JSON.stringify(body).includes('password_hash'), false);
});

test('login with wrong password returns generic 401', async () => {
  const { email, password } = await registerUser();
  const { response, body } = await loginUser(email, `${password}x`);

  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(body.error.message, 'Invalid email or password.');
});

test('login with unknown email returns generic 401', async () => {
  const { response, body } = await loginUser(
    `ghost-${unique()}@example.com`,
    validPassword()
  );
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(body.error.message, 'Invalid email or password.');
});

test('me returns user when session cookie present', async () => {
  const { email, password } = await registerUser();
  const login = await loginUser(email, password);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);

  const { response, body } = await api('/auth/me', {
    headers: { Cookie: cookie },
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.user.email, email);
  assert.equal(JSON.stringify(body).includes('password_hash'), false);
});

test('me returns 401 without session cookie', async () => {
  const { response, body } = await api('/auth/me');
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('me returns 401 with invalid session cookie', async () => {
  const { response, body } = await api('/auth/me', {
    headers: { Cookie: `fh_session=${'a'.repeat(43)}` },
  });
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('logout clears session cookie and kills session', async () => {
  const { email, password } = await registerUser();
  const login = await loginUser(email, password);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);

  const logout = await postJson('/auth/logout', {}, { Cookie: cookie });
  assert.equal(logout.response.status, 200);

  const clearCookie = extractFullSessionCookie(logout.response.headers.getSetCookie());
  assert.ok(clearCookie, 'expected clear Set-Cookie');
  assert.match(clearCookie, /Max-Age=0/);

  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 401);
});

test('logout without session is safe (still 200)', async () => {
  const { response, body } = await postJson('/auth/logout', {});
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
});

test('CSRF: cross-origin Origin header rejected', async () => {
  const { response, body } = await postJson(
    '/auth/login',
    { email: 'someone@example.com', password: validPassword() },
    { Origin: 'https://evil.example.com' }
  );
  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'CSRF_INVALID');
});

test('CSRF: matching Origin header allowed', async () => {
  const { email, password } = await registerUser();
  const { response } = await loginUser(email, password, {
    // Same origin the test server actually answers on — derived from
    // TEST_BASE_URL so this test never depends on a fixed port.
    Origin: new URL(BASE_URL).origin,
  });
  assert.equal(response.status, 200);
});

test('security headers present', async () => {
  const { response } = await api('/health');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.ok(response.headers.get('content-security-policy'));
  assert.ok(response.headers.get('referrer-policy'));
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('rate limiter middleware returns 429 after max attempts', () => {
  const { createRateLimiter } = require('../src/utils/rateLimiter');
  const limiter = createRateLimiter({ name: 'unit', windowMs: 60000, max: 3 });

  let statusCode = null;
  let retryAfter = null;
  const res = {
    setHeader(name, value) {
      if (name === 'Retry-After') retryAfter = value;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };
  const req = { ip: '10.0.0.1' };

  for (let i = 0; i < 3; i += 1) {
    limiter(req, res, () => {});
    assert.equal(statusCode, null, `request ${i + 1} should pass`);
  }

  limiter(req, res, () => {
    assert.fail('4th request should not call next');
  });
  assert.equal(statusCode, 429);
  assert.ok(retryAfter);
});

test('invalid JSON body returns 400', async () => {
  const { response, body } = await api('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"email":',
  });
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('unexpected fields rejected on register', async () => {
  const { response, body } = await postJson('/auth/register', {
    firstName: 'A',
    lastName: 'B',
    email: `extra-${unique()}@example.com`,
    password: validPassword(),
    role: 'admin',
  });
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => /role/i.test(d)));
});

test('regression: static pages still served', async () => {
  for (const page of ['/', '/login', '/register', '/dashboard']) {
    const response = await fetch(`${BASE_URL}${page}`);
    assert.equal(response.status, 200, `expected 200 for ${page}`);
  }
});

test('regression: API unknown route returns 404 with code', async () => {
  const { response, body } = await api('/does-not-exist');
  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('session not stored in plaintext (DB stores hash only)', async () => {
  const { email, password } = await registerUser();
  const login = await loginUser(email, password);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie);

  const rawToken = cookie.split('=')[1];
  const { pool } = require('../src/config/database');
  const { rows } = await pool.query(
    'SELECT session_hash FROM sessions ORDER BY created_at DESC LIMIT 1'
  );
  assert.ok(rows.length > 0);
  assert.notEqual(rows[0].session_hash, rawToken);
  assert.equal(rows[0].session_hash.length, 64);
});

// ---------- Session persistence regression suite (refresh / navigation) ----------

async function loginAndGetCookie() {
  const { email, password } = await registerUser();
  const login = await loginUser(email, password);
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie, 'expected session cookie after login');
  return { email, password, cookie, login };
}

test('regression: login creates a valid session usable immediately', async () => {
  const { email, cookie } = await loginAndGetCookie();
  const { response, body } = await api('/auth/me', {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.user.email, email);
});

test('regression: same session remains valid on subsequent requests', async () => {
  const { email, cookie } = await loginAndGetCookie();
  for (let i = 0; i < 3; i += 1) {
    const { response, body } = await api('/auth/me', {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200, `request ${i + 1} should stay authenticated`);
    assert.equal(body.data.user.email, email);
  }
});

test('regression: session survives page reload behavior (static + me)', async () => {
  const { email, cookie } = await loginAndGetCookie();

  // Simulate a full dashboard reload: fetch the HTML, then re-run /me.
  const page = await fetch(`${BASE_URL}/dashboard`, {
    headers: { Cookie: cookie },
  });
  assert.equal(page.status, 200);

  const { response, body } = await api('/auth/me', {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.user.email, email);
});

test('regression: public page navigation does not invalidate session', async () => {
  const { email, cookie } = await loginAndGetCookie();

  // Visit public pages while "logged in" (cookie sent, but these pages are public).
  for (const page of ['/', '/', '/about', '/faq', '/contact']) {
    const res = await fetch(`${BASE_URL}${page}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200, `expected 200 for ${page}`);
  }

  const { response, body } = await api('/auth/me', {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200, 'session must survive public navigation');
  assert.equal(body.data.user.email, email);
});

test('regression: dashboard remains accessible after navigation sequence', async () => {
  const { email, cookie } = await loginAndGetCookie();

  // dashboard -> home -> dashboard (reload-equivalent fetch sequence)
  assert.equal((await fetch(`${BASE_URL}/dashboard`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${BASE_URL}/`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${BASE_URL}/dashboard`, { headers: { Cookie: cookie } })).status, 200);

  const { response, body } = await api('/auth/me', {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.user.email, email);
});

test('regression: explicit logout invalidates the session', async () => {
  const { cookie } = await loginAndGetCookie();

  const before = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(before.response.status, 200);

  const logout = await postJson('/auth/logout', {}, { Cookie: cookie });
  assert.equal(logout.response.status, 200);

  const after = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(after.response.status, 401);
  assert.equal(after.body.error.code, 'UNAUTHORIZED');
});

test('regression: expired session returns 401', async () => {
  const { cookie } = await loginAndGetCookie();
  const rawToken = cookie.split('=')[1];
  const crypto = require('node:crypto');
  const sessionHash = crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');

  const { pool } = require('../src/config/database');
  await pool.query(
    "UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE session_hash = $1",
    [sessionHash]
  );

  const { response, body } = await api('/auth/me', {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('regression: invalid session token returns 401', async () => {
  const { response, body } = await api('/auth/me', {
    headers: { Cookie: `fh_session=${'z'.repeat(43)}` },
  });
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('regression: session cookie is HttpOnly with correct attributes', async () => {
  const { login } = await loginAndGetCookie();
  const fullCookie = extractFullSessionCookie(login.response.headers.getSetCookie());
  assert.ok(fullCookie, 'expected Set-Cookie');
  assert.match(fullCookie, /HttpOnly/);
  assert.match(fullCookie, /SameSite=Lax/);
  assert.match(fullCookie, /Path=\//);
  assert.match(fullCookie, /Max-Age=\d+/);
  assert.doesNotMatch(fullCookie, /; *Secure/i, 'dev login must not set Secure');
});

test('regression: local HTTP development does not require Secure cookie', async () => {
  // Server under test runs NODE_ENV=development (assert via cookie on login).
  const { login } = await loginAndGetCookie();
  const fullCookie = extractFullSessionCookie(login.response.headers.getSetCookie());
  assert.ok(fullCookie);
  assert.doesNotMatch(fullCookie, /; *Secure/i);
  // config.isProduction must be false for this environment.
  const config = require('../src/config');
  assert.equal(config.isProduction, false);
});

test('regression: production cookie builder still enables Secure', async () => {
  const {
    buildSessionCookieHeader,
    buildClearCookieHeader,
  } = require('../src/utils/cookies');

  const setHeader = buildSessionCookieHeader('fh_session', 'tok', {
    maxAgeSeconds: 604800,
    secure: true,
  });
  assert.match(setHeader, /Secure/);
  assert.match(setHeader, /HttpOnly/);
  assert.match(setHeader, /SameSite=Lax/);

  const clearHeader = buildClearCookieHeader('fh_session', { secure: true });
  assert.match(clearHeader, /Secure/);
  assert.match(clearHeader, /Max-Age=0/);

  // Non-secure (development) builder path:
  const devHeader = buildSessionCookieHeader('fh_session', 'tok', {
    maxAgeSeconds: 604800,
    secure: false,
  });
  assert.doesNotMatch(devHeader, /; *Secure/i);
});

test('regression: API responses are not cacheable (Cache-Control no-store)', async () => {
  const unauth = await fetch(`${API}/auth/me`);
  assert.equal(unauth.headers.get('cache-control'), 'no-store');
  assert.equal(unauth.headers.get('vary'), 'Cookie');

  const { cookie } = await loginAndGetCookie();
  const authed = await fetch(`${API}/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(authed.headers.get('cache-control'), 'no-store');
  assert.equal(authed.headers.get('vary'), 'Cookie');

  const plans = await fetch(`${API}/plans/hosting`);
  assert.equal(plans.headers.get('cache-control'), 'no-store');
});
