const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const path = require('path');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;
const backendDir = path.resolve(__dirname, '..');

const EXPECTED_HOSTING_SLUGS = ['starter', 'business', 'pro'];
const EXPECTED_VPS_SLUGS = ['vps-1', 'vps-2', 'vps-4'];

function assertOkShape(body) {
  assert.ok(body, 'expected JSON body');
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.data));
}

async function api(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { Accept: 'application/json' },
  });
  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    body = null;
  }
  return { response, body };
}

async function errorBody(response) {
  try {
    return await response.json();
  } catch (err) {
    return null;
  }
}

let pool;
let planService;

before(async () => {
  const { runUp } = require('../src/services/migrator');
  await runUp();
  const db = require('../src/config/database');
  pool = db;
  planService = require('../src/services/planService');
  const { runSeed } = require('../src/services/seed');
  await runSeed();
  planService.invalidateCache();
});

after(async () => {
  if (pool) {
    await pool.closePool().catch(() => {});
  }
});

test('GET /plans/hosting returns seeded active hosting plans', async () => {
  const { response, body } = await api('/plans/hosting');
  assert.equal(response.status, 200);
  assertOkShape(body);
  assert.ok(body.data.length >= 3);

  const slugs = body.data.map((p) => p.slug);
  for (const expected of EXPECTED_HOSTING_SLUGS) {
    assert.ok(slugs.includes(expected), `missing slug ${expected}`);
  }

  for (const plan of body.data) {
    assert.equal(plan.status, undefined, 'status must not be public');
    assert.equal(typeof plan.name, 'string');
    assert.match(plan.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(typeof plan.price, 'string');
    assert.match(plan.currency, /^[A-Z]{3}$/);
    assert.ok(['monthly', 'quarterly', 'yearly'].includes(plan.billingCycle));
    assert.equal(typeof plan.storageGb, 'number');
    if (plan.domains === null) {
      assert.equal(plan.emailAccounts, null);
      assert.equal(plan.databases, null);
    }
    assert.equal(typeof plan.ssl, 'boolean');
  }
});

test('GET /plans/vps returns seeded active VPS plans', async () => {
  const { response, body } = await api('/plans/vps');
  assert.equal(response.status, 200);
  assertOkShape(body);
  assert.ok(body.data.length >= 3);

  const slugs = body.data.map((p) => p.slug);
  for (const expected of EXPECTED_VPS_SLUGS) {
    assert.ok(slugs.includes(expected), `missing slug ${expected}`);
  }

  for (const plan of body.data) {
    assert.equal(typeof plan.price, 'string');
    assert.match(plan.currency, /^[A-Z]{3}$/);
    assert.equal(typeof plan.cpuCores, 'number');
    assert.equal(typeof plan.ramMb, 'number');
    assert.equal(typeof plan.storageGb, 'number');
    assert.equal(typeof plan.ipv4Addresses, 'number');
  }
});

test('GET /plans/hosting/:slug returns a single plan', async () => {
  const { response, body } = await api('/plans/hosting/starter');
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.slug, 'starter');
  assert.equal(body.data.name, 'Starter');
  assert.equal(typeof body.data.price, 'string');
  assert.equal(body.data.currency, 'BDT');
});

test('GET /plans/vps/:slug returns a single plan', async () => {
  const { response, body } = await api('/plans/vps/vps-2');
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.slug, 'vps-2');
  assert.equal(body.data.cpuCores, 2);
});

test('missing plan slug returns 404 PLAN_NOT_FOUND', async () => {
  for (const path of [
    '/plans/hosting/does-not-exist',
    '/plans/vps/does-not-exist',
  ]) {
    const response = await fetch(`${API}${path}`);
    assert.equal(response.status, 404, path);
    const body = await errorBody(response);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'PLAN_NOT_FOUND');
  }
});

test('malformed plan slug returns 400 VALIDATION_ERROR', async () => {
  const malformed = [
    'Bad Slug!',
    'UPPER',
    'a--b',
    'has_underscore',
    '-leading',
    'trailing-',
    'x'.repeat(101),
  ];

  for (const slug of malformed) {
    const response = await fetch(
      `${API}/plans/hosting/${encodeURIComponent(slug)}`
    );
    assert.equal(response.status, 400, slug);
    const body = await errorBody(response);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(body.error.message, 'Invalid plan slug.');
  }
});

test('SQL injection style slug is safe (400, no leak)', async () => {
  const evil = "x' OR 1=1--";
  const response = await fetch(
    `${API}/plans/hosting/${encodeURIComponent(evil)}`
  );
  assert.equal(response.status, 400);
  const body = await errorBody(response);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  const raw = JSON.stringify(body).toLowerCase();
  assert.equal(raw.includes('sql'), false);
  assert.equal(raw.includes('error:'), false);
  assert.equal(raw.includes('syntax'), false);
  assert.equal(raw.includes('password'), false);
  assert.equal(raw.includes('stack'), false);
});

test('inactive plans are excluded from public list and lookup', async () => {
  const { pool: db } = require('../src/config/database');
  const slug = `inactive-test-${Date.now().toString(36)}`;
  await db.query(
    `INSERT INTO hosting_plans (name, slug, description, price, currency, billing_cycle, storage_gb, bandwidth_gb, status)
     VALUES ($1, $2, $3, $4, 'BDT', 'monthly', 1, 1, 'inactive')`,
    ['Inactive', slug, 'Should not appear publicly', '10.00']
  );

  planService.invalidateCache();

  try {
    const list = await api('/plans/hosting');
    assert.equal(list.response.status, 200);
    const slugs = list.body.data.map((p) => p.slug);
    assert.equal(slugs.includes(slug), false, 'inactive plan leaked to list');

    const single = await fetch(`${API}/plans/hosting/${slug}`);
    assert.equal(single.status, 404);
    const body = await errorBody(single);
    assert.equal(body.error.code, 'PLAN_NOT_FOUND');
  } finally {
    await db.query('DELETE FROM hosting_plans WHERE slug = $1', [slug]);
    planService.invalidateCache();
  }
});

test('seed is idempotent (run twice creates no duplicates)', async () => {
  const { runSeed } = require('../src/services/seed');
  const beforeCount = await countAllPlans();

  const first = await runSeed();
  const midCount = await countAllPlans();
  planService.invalidateCache();

  const second = await runSeed();
  planService.invalidateCache();
  const afterCount = await countAllPlans();

  assert.equal(first.hosting.inserted + first.vps.inserted, 0, 'seed should skip existing');
  assert.equal(second.hosting.inserted, 0);
  assert.equal(second.vps.inserted, 0);
  assert.equal(afterCount, midCount);
  assert.ok(midCount >= 6, 'expected at least 6 seeded plans total');
  assert.ok(beforeCount >= 6);
});

async function countAllPlans() {
  const { pool: db } = require('../src/config/database');
  const h = await db.query('SELECT COUNT(*)::int AS n FROM hosting_plans');
  const v = await db.query('SELECT COUNT(*)::int AS n FROM vps_plans');
  return h.rows[0].n + v.rows[0].n;
}

test('seed CLI refuses production without override', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['src/services/seed.js'],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SEED_ALLOW_PRODUCTION: '',
      },
    }
  ).catch((err) => {
    return { stdout: err.stdout || '', stderr: err.stderr || '' };
  });

  const output = `${stdout}${stderr}`;
  assert.match(output, /Refusing to seed in production/i);
});

test('db errors do not leak to plan API responses', async () => {
  const response = await fetch(`${API}/plans/hosting/starter`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const lower = text.toLowerCase();
  assert.equal(lower.includes('password'), false);
  assert.equal(lower.includes('stack'), false);
  assert.equal(lower.includes('syntax error'), false);
  assert.equal(lower.includes('connection'), false);
  assert.equal(lower.includes('$argon2'), false);
});

test('regression: plan routes require no auth and health still works', async () => {
  const health = await api('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.database, 'up');

  for (const path of ['/plans/hosting', '/plans/vps']) {
    const { response } = await api(path);
    assert.equal(response.status, 200, path);
    assert.equal(
      response.headers.get('www-authenticate'),
      null,
      'plan endpoints must not require auth'
    );
  }
});

test('regression: static plan pages still served', async () => {
  for (const page of ['/web-hosting', '/vps-hosting']) {
    const response = await fetch(`${BASE_URL}${page}`);
    assert.equal(response.status, 200, `expected 200 for ${page}`);
    const html = await response.text();
    assert.ok(html.includes('plans.js'), `${page} must load plans.js`);
    assert.ok(html.includes('id="plans-root"'), `${page} must have plans-root`);
  }
});
