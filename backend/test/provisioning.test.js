const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Provisioning must never depend on the ambient payment/SMS providers — the
// root .env may enable SSLCommerz/TextBee for the dev server. Pin both here
// (dotenv does not override pre-set process env values).
process.env.PAYMENT_PROVIDER = 'disabled';
process.env.PROVISIONING_PROVIDER = 'disabled';

const config = require('../src/config');

// Rate limiters read config at module load — raise limits before the app is
// required so this suite's users/orders are not throttled.
config.rateLimit.registerMax = 500;
config.rateLimit.loginMax = 500;
config.rateLimit.orderCreateMax = 500;
config.rateLimit.paymentCreateMax = 500;

const {
  getProvider,
  registerProvider,
  unregisterProvider,
  ProvisioningProviderError,
} = require('../src/services/provisioning/provisioningProvider');
const {
  ProvisioningError,
  CODES,
  ALLOWED_TRANSITIONS,
  canTransition,
} = require('../src/services/provisioning/provisioningErrors');
const provisioningService = require('../src/services/provisioning/provisioningService');
const { selectServer } = require('../src/services/provisioning/serverSelectionService');
const {
  provisionOrder,
  suspendService,
  unsuspendService,
  terminateService,
} = provisioningService;
const SAFE_PROVIDER_FAILURE_MESSAGE =
  provisioningService.SAFE_PROVIDER_FAILURE_MESSAGE;

const app = require('../src/app');

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;

// ---------------------------------------------------------------------------
// Mock provider (test seam — never registered in production config paths).
// ---------------------------------------------------------------------------
const mock = {
  calls: [],
  provisionImpl: null,
  getStatusImpl: null,
};

function resetMock() {
  mock.calls = [];
  mock.provisionImpl = null;
  mock.getStatusImpl = null;
}

const mockProvider = {
  name: 'mock',
  async getStatus() {
    mock.calls.push({ op: 'getStatus' });
    if (mock.getStatusImpl) return mock.getStatusImpl();
    return { status: 'ok' };
  },
  async provision(payload) {
    mock.calls.push({ op: 'provision', payload });
    if (mock.provisionImpl) return mock.provisionImpl(payload);
    // Unique per call: service_instances has a partial unique index on
    // (server_id, external_id) and test rows persist across suite runs.
    return {
      externalId: `mock-ext-${Date.now().toString(36)}-${mock.calls.length}-${Math.random()
        .toString(36)
        .slice(2, 10)}`,
    };
  },
  async suspend(arg) {
    mock.calls.push({ op: 'suspend', arg });
    return { ok: true };
  },
  async unsuspend(arg) {
    mock.calls.push({ op: 'unsuspend', arg });
    return { ok: true };
  },
  async terminate(arg) {
    mock.calls.push({ op: 'terminate', arg });
    return { ok: true };
  },
};

registerProvider('mock', mockProvider);

function useProvider(name) {
  config.provisioning.provider = name;
}

function mockOpCounts() {
  const counts = {};
  for (const call of mock.calls) {
    counts[call.op] = (counts[call.op] || 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// In-process app + HTTP helpers
// ---------------------------------------------------------------------------
let BASE_URL = null;
let appServer = null;
let database = null;
let pool = null;
let starterPlanId = null;
let fixtureServerId = null;

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

async function registerUser(prefix = 'prov') {
  const email = `${prefix}-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Prov',
    lastName: 'Tester',
    email,
    password,
  });
  assert.equal(reg.response.status, 201);
  const login = await postJson('/auth/login', { email, password });
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie, 'expected session cookie');
  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
  return { cookie, userId: me.body.data.user.id };
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

async function createPaidOrder(cookie, productType = 'hosting', planSlug = 'starter') {
  const order = await createOrder(cookie, productType, planSlug);
  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [
    'paid',
    order.id,
  ]);
  return order;
}

async function insertOrderDirect({
  userId,
  productType = 'hosting',
  productId,
  status = 'paid',
}) {
  const orderNumber = `FLR-PRV-${unique()}`.slice(0, 32);
  const { rows } = await pool.query(
    `INSERT INTO orders (user_id, order_number, product_type, product_id, amount, currency, billing_cycle, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, order_number, status, user_id, product_type, product_id`,
    [userId, orderNumber, productType, productId, '500.00', 'BDT', 'monthly', status]
  );
  return rows[0];
}

async function insertPrivateHostingPlan(status) {
  const slug = `prov-${status}-${unique()}`.slice(0, 100);
  const { rows } = await pool.query(
    `INSERT INTO hosting_plans (name, slug, price, billing_cycle, storage_gb, bandwidth_gb, domains, email_accounts, databases, ssl, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, slug, status`,
    [`Prov ${status}`, slug, '100.00', 'monthly', 10, 100, 1, 1, 1, true, status]
  );
  return rows[0];
}

async function insertInstance({
  userId,
  orderId,
  serviceType = 'hosting',
  hostingPlanId = null,
  vpsPlanId = null,
  serverId = null,
  externalId = null,
  provider = 'mock',
  status = 'provisioning',
}) {
  const { rows } = await pool.query(
    `INSERT INTO service_instances (
       user_id, order_id, service_type, hosting_plan_id, vps_plan_id,
       server_id, external_id, provider, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [userId, orderId, serviceType, hostingPlanId, vpsPlanId, serverId, externalId, provider, status]
  );
  return rows[0];
}

async function getServiceRow(orderId) {
  const { rows } = await pool.query(
    'SELECT * FROM service_instances WHERE order_id = $1',
    [orderId]
  );
  return rows[0] || null;
}

async function countServicesFor(orderId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM service_instances WHERE order_id = $1',
    [orderId]
  );
  return rows[0].n;
}

async function getOrderStatus(orderId) {
  const { rows } = await pool.query('SELECT status FROM orders WHERE id = $1', [
    orderId,
  ]);
  return rows[0] ? rows[0].status : null;
}

async function expectProvisioningError(fn, status, code, message) {
  try {
    await fn();
  } catch (err) {
    assert.equal(err.status, status, `expected ${status}, got ${err.status} (${err.code})`);
    assert.equal(err.code, code);
    if (message) assert.equal(err.message, message);
    return err;
  }
  assert.fail(`expected error ${code} but call resolved`);
}

before(async () => {
  const { runUp } = require('../src/services/migrator');
  await runUp().catch(() => runUp());
  database = require('../src/config/database');
  pool = database.pool;
  const { runSeed } = require('../src/services/seed');
  await runSeed();

  const started = await listenApp(app);
  appServer = started.server;
  BASE_URL = `http://127.0.0.1:${started.port}`;

  const { rows: planRows } = await pool.query(
    "SELECT id FROM hosting_plans WHERE slug = 'starter'"
  );
  starterPlanId = planRows[0].id;

  const { rows: serverRows } = await pool.query(
    `INSERT INTO servers (name, hostname, virtualization_type, status)
     VALUES ('prov-test-node', 'prov-test-node.test', 'kvm', 'active')
     ON CONFLICT (name) DO UPDATE SET status = 'active'
     RETURNING id`
  );
  fixtureServerId = serverRows[0].id;

  useProvider('disabled');
  resetMock();
});

after(async () => {
  await closeServer(appServer);
  unregisterProvider('mock');
  if (database) await database.closePool().catch(() => {});
});

// ---------------------------------------------------------------------------
// Migration 013
// ---------------------------------------------------------------------------

test('migration 013 adds provisioning columns and a unique order_id index; re-run is a no-op', async () => {
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'service_instances'
       AND column_name IN ('provider', 'provisioned_at', 'suspended_at',
                           'terminated_at', 'failure_code', 'failure_message_safe')
     ORDER BY column_name`
  );
  assert.deepEqual(
    cols.map((c) => c.column_name),
    [
      'failure_code',
      'failure_message_safe',
      'provider',
      'provisioned_at',
      'suspended_at',
      'terminated_at',
    ]
  );

  const { rows: idx } = await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE tablename = 'service_instances' AND indexname = 'service_instances_order_id_unique'`
  );
  assert.equal(idx.length, 1, 'unique order_id index must exist');

  const { runUp } = require('../src/services/migrator');
  const second = await runUp();
  assert.equal(second.applied, 0, 'migration 013 must already be applied');
});

// ---------------------------------------------------------------------------
// Provider architecture (section 12)
// ---------------------------------------------------------------------------

test('provisioning provider registry exposes disabled/proxmox/whm; unknown ids stay unregistered', () => {
  assert.equal(getProvider('disabled').name, 'disabled');
  assert.equal(getProvider('proxmox').name, 'proxmox');
  assert.equal(getProvider('whm').name, 'whm');
  assert.equal(getProvider(' PROXMOX ').name, 'proxmox');
  assert.equal(getProvider('carrier-pigeon'), null);
  assert.equal(getProvider(''), null);
  assert.equal(getProvider(null), null);
  assert.equal(getProvider(42), null);
  assert.equal(getProvider('mock').name, 'mock', 'test seam provider registered');
});

test('proxmox and whm providers refuse honestly: unconfigured → NOT_CONFIGURED, configured → NOT_IMPLEMENTED', async () => {
  const proxmox = getProvider('proxmox');
  const whm = getProvider('whm');
  const savedProxmox = { ...config.provisioning.proxmox };
  const savedWhm = { ...config.provisioning.whm };
  try {
    await expectProvisioningError(
      () => proxmox.getStatus(),
      503,
      CODES.NOT_CONFIGURED,
      'Provisioning is not available yet.'
    );
    await expectProvisioningError(
      () => whm.provision({}),
      503,
      CODES.NOT_CONFIGURED,
      'Provisioning is not available yet.'
    );

    config.provisioning.proxmox = {
      apiUrl: 'https://pve.example.internal:8006',
      tokenId: 'root@pam!provisioner',
      tokenSecret: 'test-secret-do-not-leak',
      node: 'pve1',
    };
    config.provisioning.whm = {
      apiUrl: 'https://cp.example.com:2087',
      apiToken: 'test-whm-token-do-not-leak',
      username: 'root',
    };

    await expectProvisioningError(
      () => proxmox.getStatus(),
      503,
      CODES.NOT_IMPLEMENTED,
      'Provisioning is not available yet.'
    );
    await expectProvisioningError(
      () => proxmox.provision({}),
      503,
      CODES.NOT_IMPLEMENTED,
      'Provisioning is not available yet.'
    );
    await expectProvisioningError(
      () => whm.provision({}),
      503,
      CODES.NOT_IMPLEMENTED,
      'Provisioning is not available yet.'
    );
    await expectProvisioningError(
      () => whm.suspend({}),
      503,
      CODES.NOT_IMPLEMENTED
    );
    await expectProvisioningError(
      () => proxmox.terminate({}),
      503,
      CODES.NOT_IMPLEMENTED
    );
  } finally {
    config.provisioning.proxmox = savedProxmox;
    config.provisioning.whm = savedWhm;
  }
});

test('plain http proxmox/whm endpoint URLs are treated as unconfigured (no cleartext credential use)', async () => {
  const proxmox = getProvider('proxmox');
  const savedProxmox = { ...config.provisioning.proxmox };
  try {
    config.provisioning.proxmox = {
      apiUrl: 'http://pve.example.internal:8006',
      tokenId: 'root@pam!provisioner',
      tokenSecret: 's',
      node: 'pve1',
    };
    await expectProvisioningError(
      () => proxmox.getStatus(),
      503,
      CODES.NOT_CONFIGURED
    );
  } finally {
    config.provisioning.proxmox = savedProxmox;
  }
});

// ---------------------------------------------------------------------------
// Eligibility (section 6)
// ---------------------------------------------------------------------------

test('disabled provider: paid order → 503 NOT_CONFIGURED and ZERO service rows (no fake instance)', async () => {
  resetMock();
  useProvider('disabled');
  const { cookie } = await registerUser();
  const order = await createPaidOrder(cookie);

  await expectProvisioningError(
    () => provisionOrder(order.id),
    503,
    CODES.NOT_CONFIGURED,
    'Provisioning is not available yet.'
  );
  assert.equal(await countServicesFor(order.id), 0, 'no instance row created');
  assert.equal(mock.calls.length, 0, 'mock provider never invoked');
  assert.equal(await getOrderStatus(order.id), 'paid', 'order untouched');
});

test('unknown PROVISIONING_PROVIDER id behaves like not-configured and creates zero rows', async () => {
  resetMock();
  useProvider('carrier-pigeon');
  const { cookie } = await registerUser();
  const order = await createPaidOrder(cookie);

  await expectProvisioningError(
    () => provisionOrder(order.id),
    503,
    CODES.NOT_CONFIGURED
  );
  assert.equal(await countServicesFor(order.id), 0);
  assert.equal(mock.calls.length, 0);
});

test('awaiting_payment order is not eligible — 409, zero rows, order untouched', async () => {
  resetMock();
  useProvider('mock');
  const { cookie } = await registerUser();
  const order = await createOrder(cookie);
  assert.equal(order.status, 'awaiting_payment');

  await expectProvisioningError(
    () => provisionOrder(order.id),
    409,
    CODES.ORDER_NOT_ELIGIBLE,
    'Order is not eligible for provisioning.'
  );
  assert.equal(await countServicesFor(order.id), 0);
  assert.equal(mock.calls.length, 0, 'provider not consulted');
  assert.equal(await getOrderStatus(order.id), 'awaiting_payment');
});

test('cancelled order is not eligible — 409, zero rows', async () => {
  resetMock();
  useProvider('mock');
  const { cookie } = await registerUser();
  const order = await createOrder(cookie);
  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [
    'cancelled',
    order.id,
  ]);

  await expectProvisioningError(
    () => provisionOrder(order.id),
    409,
    CODES.ORDER_NOT_ELIGIBLE
  );
  assert.equal(await countServicesFor(order.id), 0);
});

test('nonexistent and malformed order ids return 404 ORDER_NOT_FOUND', async () => {
  resetMock();
  useProvider('mock');
  await expectProvisioningError(
    () => provisionOrder(crypto.randomUUID()),
    404,
    CODES.ORDER_NOT_FOUND,
    'Order not found.'
  );
  await expectProvisioningError(
    () => provisionOrder("1'; DROP TABLE service_instances;--"),
    404,
    CODES.ORDER_NOT_FOUND
  );
  await expectProvisioningError(
    () => provisionOrder(null),
    404,
    CODES.ORDER_NOT_FOUND
  );
  const { rows } = await pool.query(
    "SELECT to_regclass('service_instances') IS NOT NULL AS exists"
  );
  assert.equal(rows[0].exists, true, 'table survives hostile order ids');
});

test('inactive or missing plans return 409 INVALID_PLAN with zero rows', async () => {
  resetMock();
  useProvider('mock');
  const { cookie, userId } = await registerUser();

  const inactivePlan = await insertPrivateHostingPlan('inactive');
  const inactiveOrder = await insertOrderDirect({
    userId,
    productId: inactivePlan.id,
  });
  await expectProvisioningError(
    () => provisionOrder(inactiveOrder.id),
    409,
    CODES.INVALID_PLAN,
    'Selected plan is not available.'
  );
  assert.equal(await countServicesFor(inactiveOrder.id), 0);

  const missingPlanOrder = await insertOrderDirect({
    userId,
    productId: crypto.randomUUID(),
  });
  await expectProvisioningError(
    () => provisionOrder(missingPlanOrder.id),
    409,
    CODES.INVALID_PLAN
  );
  assert.equal(await countServicesFor(missingPlanOrder.id), 0);
  assert.equal(mock.calls.length, 0);
  void cookie;
});

test('ownership: foreign userId yields the identical 404 as a missing order (no existence leak)', async () => {
  resetMock();
  useProvider('mock');
  const alice = await registerUser('alice');
  const mallory = await registerUser('mallory');
  const order = await createPaidOrder(alice.cookie);

  const foreign = await expectProvisioningError(
    () => provisionOrder(order.id, { userId: mallory.userId }),
    404,
    CODES.ORDER_NOT_FOUND
  );
  const missing = await expectProvisioningError(
    () => provisionOrder(crypto.randomUUID(), { userId: mallory.userId }),
    404,
    CODES.ORDER_NOT_FOUND
  );
  assert.equal(foreign.message, missing.message);
  assert.equal(await countServicesFor(order.id), 0, 'no row for foreign call');
});

// ---------------------------------------------------------------------------
// Successful provisioning (sections 7–9)
// ---------------------------------------------------------------------------

test('paid hosting order provisions to active with plan-derived payload and a clean row', async () => {
  resetMock();
  useProvider('mock');
  const { cookie } = await registerUser();
  const order = await createPaidOrder(cookie);

  const result = await provisionOrder(order.id);
  assert.equal(result.created, true);
  assert.equal(result.replayed, false);
  assert.deepEqual(Object.keys(result.instance).sort(), [
    'id',
    'orderId',
    'serviceType',
    'status',
  ]);
  assert.equal(result.instance.status, 'active');
  assert.equal(result.instance.serviceType, 'hosting');
  assert.equal(result.instance.orderId, order.id);

  const row = await getServiceRow(order.id);
  assert.equal(row.status, 'active');
  assert.equal(row.provider, 'mock');
  assert.equal(row.service_type, 'hosting');
  assert.match(row.external_id, /^mock-ext-/);
  assert.ok(row.provisioned_at, 'provisioned_at stamped');
  assert.equal(row.failure_code, null);
  assert.equal(row.hosting_plan_id, starterPlanId);
  assert.equal(row.vps_plan_id, null);
  assert.equal(await getOrderStatus(order.id), 'paid', 'order stays paid');

  const counts = mockOpCounts();
  assert.equal(counts.getStatus, 1, 'readiness precheck ran');
  assert.equal(counts.provision, 1, 'provider provision called once');

  const provisionCall = mock.calls.find((c) => c.op === 'provision');
  assert.equal(provisionCall.payload.serviceType, 'hosting');
  assert.equal(provisionCall.payload.planSlug, 'starter');
  assert.equal(provisionCall.payload.orderId, order.id);
  const { rows: planRows } = await pool.query(
    `SELECT storage_gb, bandwidth_gb, databases, email_accounts, domains
     FROM hosting_plans WHERE slug = 'starter'`
  );
  const plan = planRows[0];
  assert.deepEqual(provisionCall.payload.resources, {
    storage: plan.storage_gb,
    bandwidth: plan.bandwidth_gb === undefined ? null : plan.bandwidth_gb,
    databases: plan.databases,
    emailAccounts: plan.email_accounts,
    domains: plan.domains,
  });
});

test('paid VPS order provisions to active with a server assignment and VPS resources', async () => {
  resetMock();
  useProvider('mock');
  const { cookie } = await registerUser();
  const order = await createPaidOrder(cookie, 'vps', 'vps-1');

  const result = await provisionOrder(order.id);
  assert.equal(result.created, true);
  assert.equal(result.instance.status, 'active');
  assert.equal(result.instance.serviceType, 'vps');

  const row = await getServiceRow(order.id);
  assert.equal(row.status, 'active');
  assert.equal(row.service_type, 'vps');
  assert.ok(row.server_id, 'VPS placed on a server');
  assert.ok(row.vps_plan_id, 'vps plan FK set');
  assert.equal(row.hosting_plan_id, null);

  const provisionCall = mock.calls.find((c) => c.op === 'provision');
  assert.equal(provisionCall.payload.serviceType, 'vps');
  const { rows: planRows } = await pool.query(
    `SELECT cpu_cores, ram_mb, storage_gb, bandwidth_gb
     FROM vps_plans WHERE slug = 'vps-1'`
  );
  const plan = planRows[0];
  assert.deepEqual(provisionCall.payload.resources, {
    cpu: plan.cpu_cores,
    ram: plan.ram_mb,
    storage: plan.storage_gb,
    bandwidth: plan.bandwidth_gb === undefined ? null : plan.bandwidth_gb,
  });
  assert.ok(!('ipv4' in provisionCall.payload.resources));
});

// ---------------------------------------------------------------------------
// Idempotency (section 10)
// ---------------------------------------------------------------------------

test('double provisionOrder is idempotent: one row, one provider call, second call replays', async () => {
  resetMock();
  useProvider('mock');
  const { cookie } = await registerUser();
  const order = await createPaidOrder(cookie);

  const first = await provisionOrder(order.id);
  assert.equal(first.created, true);

  const second = await provisionOrder(order.id);
  assert.equal(second.created, false);
  assert.equal(second.replayed, true);
  assert.equal(second.instance.id, first.instance.id);
  assert.equal(second.instance.status, 'active');

  assert.equal(await countServicesFor(order.id), 1, 'exactly one row');
  const counts = mockOpCounts();
  assert.equal(counts.provision, 1, 'provider never re-called');
  assert.equal(counts.getStatus, 1, 'precheck not repeated for replay');
});

test('pre-existing instance row replays without consulting the provider', async () => {
  resetMock();
  useProvider('mock');
  const { cookie, userId } = await registerUser();
  const order = await createPaidOrder(cookie);
  const preexisting = await insertInstance({
    userId,
    orderId: order.id,
    status: 'active',
    hostingPlanId: starterPlanId,
    externalId: 'already-here',
  });

  const result = await provisionOrder(order.id);
  assert.equal(result.created, false);
  assert.equal(result.replayed, true);
  assert.equal(result.instance.id, preexisting.id);
  assert.equal(result.instance.status, 'active');
  assert.equal(mock.calls.length, 0, 'provider untouched');
  assert.equal(await countServicesFor(order.id), 1);
});

test('failed provisioning record replays as failed — never a second provider attempt', async () => {
  resetMock();
  useProvider('mock');
  mock.provisionImpl = () => {
    throw new ProvisioningProviderError(
      502,
      CODES.PROVIDER_ERROR,
      'Provisioning provider is temporarily unavailable.'
    );
  };
  const { cookie } = await registerUser();
  const order = await createPaidOrder(cookie);

  await expectProvisioningError(
    () => provisionOrder(order.id),
    502,
    CODES.PROVIDER_ERROR
  );
  assert.equal((await getServiceRow(order.id)).status, 'failed');
  const countsAfterFirst = mockOpCounts();
  assert.equal(countsAfterFirst.provision, 1);

  mock.provisionImpl = null; // would succeed now — must still not be called
  const replay = await provisionOrder(order.id);
  assert.equal(replay.created, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.instance.status, 'failed');
  assert.equal(mockOpCounts().provision, 1, 'no second attempt');
  assert.equal(await countServicesFor(order.id), 1);
});

// ---------------------------------------------------------------------------
// Lifecycle / state machine (sections 11–14)
// ---------------------------------------------------------------------------

test('state machine happy path: active → suspended → active → terminated with timestamps', async () => {
  resetMock();
  useProvider('mock');
  const { cookie } = await registerUser();
  const order = await createPaidOrder(cookie);
  const created = await provisionOrder(order.id);
  const id = created.instance.id;
  assert.equal(created.instance.status, 'active');

  const suspended = await suspendService(id);
  assert.equal(suspended.status, 'suspended');
  let row = await getServiceRow(order.id);
  assert.equal(row.status, 'suspended');
  assert.ok(row.suspended_at, 'suspended_at stamped');
  assert.equal(row.provisioned_at !== null, true);

  const resumed = await unsuspendService(id);
  assert.equal(resumed.status, 'active');
  row = await getServiceRow(order.id);
  assert.equal(row.status, 'active');
  assert.equal(row.suspended_at, null, 'suspended_at cleared on resume');

  const terminated = await terminateService(id);
  assert.equal(terminated.status, 'terminated');
  row = await getServiceRow(order.id);
  assert.equal(row.status, 'terminated');
  assert.ok(row.terminated_at, 'terminated_at stamped');

  const ops = mock.calls.filter((c) => c.op !== 'getStatus' && c.op !== 'provision');
  assert.deepEqual(
    ops.map((c) => c.op),
    ['suspend', 'unsuspend', 'terminate'],
    'provider ops recorded in order'
  );
  assert.equal(await getOrderStatus(order.id), 'paid', 'order untouched');
});

test('invalid lifecycle transitions are rejected with 409 INVALID_STATE — no provider call, no DB change', async () => {
  resetMock();
  useProvider('mock');
  const { cookie, userId } = await registerUser();
  const cases = [
    { status: 'provisioning', op: suspendService },
    { status: 'provisioning', op: terminateService },
    { status: 'active', op: unsuspendService },
    { status: 'suspended', op: suspendService },
    { status: 'failed', op: suspendService },
    { status: 'failed', op: terminateService },
    { status: 'terminated', op: suspendService },
    { status: 'terminated', op: terminateService },
  ];

  for (const c of cases) {
    const order = await createPaidOrder(cookie);
    const instance = await insertInstance({
      userId,
      orderId: order.id,
      status: c.status,
      hostingPlanId: starterPlanId,
      externalId: `ext-${c.status}-${unique()}`,
    });
    await expectProvisioningError(
      () => c.op(instance.id),
      409,
      CODES.INVALID_STATE,
      'Service is not in a valid state for this operation.'
    );
    const { rows } = await pool.query(
      'SELECT status FROM service_instances WHERE id = $1',
      [instance.id]
    );
    assert.equal(rows[0].status, c.status, `${c.status} row unchanged`);
  }
  assert.equal(mock.calls.length, 0, 'provider never consulted for invalid transitions');
});

test('transition matrix covers only the documented paths', () => {
  assert.deepEqual(ALLOWED_TRANSITIONS, {
    provisioning: ['active', 'failed'],
    active: ['suspended', 'terminated'],
    suspended: ['active', 'terminated'],
    failed: [],
    terminated: [],
  });
  const allowed = [
    ['provisioning', 'active'],
    ['provisioning', 'failed'],
    ['active', 'suspended'],
    ['active', 'terminated'],
    ['suspended', 'active'],
    ['suspended', 'terminated'],
  ];
  for (const [from, to] of allowed) {
    assert.equal(canTransition(from, to), true, `${from} → ${to}`);
  }
  const rejected = [
    ['provisioning', 'suspended'],
    ['provisioning', 'terminated'],
    ['provisioning', 'provisioning'],
    ['active', 'active'],
    ['active', 'provisioning'],
    ['active', 'failed'],
    ['suspended', 'suspended'],
    ['suspended', 'failed'],
    ['failed', 'active'],
    ['failed', 'provisioning'],
    ['terminated', 'active'],
    ['terminated', 'suspended'],
    ['pending', 'active'], // "pending" is the absence of a row — never a status
    [undefined, 'active'],
  ];
  for (const [from, to] of rejected) {
    assert.equal(canTransition(from, to), false, `${from} → ${to} rejected`);
  }
});

test('lifecycle ops on unknown/invalid/foreign instance ids return 404 with no leaks', async () => {
  resetMock();
  useProvider('mock');
  const alice = await registerUser('alice2');
  const mallory = await registerUser('mallory2');
  const order = await createPaidOrder(alice.cookie);
  const created = await provisionOrder(order.id);

  for (const id of [crypto.randomUUID(), 'not-a-uuid', null]) {
    await expectProvisioningError(
      () => suspendService(id),
      404,
      CODES.INSTANCE_NOT_FOUND,
      'Service not found.'
    );
  }

  const foreign = await expectProvisioningError(
    () => suspendService(created.instance.id, { userId: mallory.userId }),
    404,
    CODES.INSTANCE_NOT_FOUND
  );
  const missing = await expectProvisioningError(
    () => suspendService(crypto.randomUUID(), { userId: mallory.userId }),
    404,
    CODES.INSTANCE_NOT_FOUND
  );
  assert.equal(foreign.message, missing.message);
  const { rows } = await pool.query(
    'SELECT status FROM service_instances WHERE id = $1',
    [created.instance.id]
  );
  assert.equal(rows[0].status, 'active', 'instance untouched by foreign call');
});

// ---------------------------------------------------------------------------
// Provider failure handling (sections 16–17)
// ---------------------------------------------------------------------------

test('shaped provider failure → safe thrown error + failed row; order stays paid', async () => {
  resetMock();
  useProvider('mock');
  mock.provisionImpl = () => {
    throw new ProvisioningProviderError(
      502,
      CODES.PROVIDER_ERROR,
      'Provisioning provider is temporarily unavailable.'
    );
  };
  const { cookie } = await registerUser();
  const order = await createPaidOrder(cookie);

  const err = await expectProvisioningError(
    () => provisionOrder(order.id),
    502,
    CODES.PROVIDER_ERROR
  );
  assert.equal(err.message, 'Provisioning provider is temporarily unavailable.');

  const row = await getServiceRow(order.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_code, CODES.PROVIDER_ERROR);
  assert.equal(
    row.failure_message_safe,
    'Provisioning provider is temporarily unavailable.'
  );
  assert.ok(row.failure_message_safe.length <= 255);
  assert.equal(await getOrderStatus(order.id), 'paid');
  assert.equal(row.provisioned_at, null);
});

test('raw provider exception is never persisted — only the fixed safe message is stored', async () => {
  resetMock();
  useProvider('mock');
  const internals = 'ECONNREFUSED 10.0.0.5:8006 token=super-secret-do-not-leak';
  mock.provisionImpl = () => {
    throw new Error(internals);
  };
  const { cookie } = await registerUser();
  const order = await createPaidOrder(cookie);

  const err = await expectProvisioningError(
    () => provisionOrder(order.id),
    502,
    CODES.PROVIDER_ERROR
  );
  assert.equal(err.message, SAFE_PROVIDER_FAILURE_MESSAGE);

  const row = await getServiceRow(order.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_code, CODES.PROVIDER_ERROR);
  assert.equal(row.failure_message_safe, SAFE_PROVIDER_FAILURE_MESSAGE);
  const flat = JSON.stringify({
    message: err.message,
    code: err.code,
    failure_code: row.failure_code,
    failure_message_safe: row.failure_message_safe,
  });
  assert.ok(!flat.includes(internals), 'raw internals never stored or thrown');
  assert.ok(!flat.includes('super-secret'), 'secret fragment never stored');
  assert.equal(await getOrderStatus(order.id), 'paid');
});

test('capacity-shaped provider failure records the failed row and surfaces 503 CAPACITY_UNAVAILABLE', async () => {
  resetMock();
  useProvider('mock');
  mock.provisionImpl = () => {
    throw new ProvisioningProviderError(
      503,
      CODES.CAPACITY_UNAVAILABLE,
      'No server capacity is available right now.'
    );
  };
  const { cookie } = await registerUser();
  const order = await createPaidOrder(cookie);

  await expectProvisioningError(
    () => provisionOrder(order.id),
    503,
    CODES.CAPACITY_UNAVAILABLE,
    'No server capacity is available right now.'
  );
  const row = await getServiceRow(order.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_code, CODES.CAPACITY_UNAVAILABLE);
});

test('malformed provider results are rejected as failed rows with a safe 502', async () => {
  const badResults = ['not-an-object', null, 42, [], { externalId: 12345 }];
  for (const bad of badResults) {
    resetMock();
    useProvider('mock');
    mock.provisionImpl = () => bad;
    const { cookie } = await registerUser();
    const order = await createPaidOrder(cookie);

    await expectProvisioningError(
      () => provisionOrder(order.id),
      502,
      CODES.PROVIDER_ERROR
    );
    const row = await getServiceRow(order.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.failure_code, CODES.PROVIDER_ERROR);
    assert.ok(row.failure_message_safe.length <= 255);
    assert.equal(await getOrderStatus(order.id), 'paid');
  }
});

test('no active server capacity: VPS provisioning fails cleanly with zero rows, repeatably; disabled selector never places', async () => {
  resetMock();
  useProvider('mock');
  const snapshot = await pool.query(
    'SELECT id, status FROM servers FOR UPDATE'
  );
  await pool.query("UPDATE servers SET status = 'drain'");
  try {
    const { cookie } = await registerUser();
    const order = await createPaidOrder(cookie, 'vps', 'vps-1');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expectProvisioningError(
        () => provisionOrder(order.id),
        503,
        CODES.CAPACITY_UNAVAILABLE,
        'No server capacity is available right now.'
      );
      assert.equal(
        await countServicesFor(order.id),
        0,
        'capacity failure creates zero rows'
      );
    }
    assert.equal(
      mockOpCounts().provision || 0,
      0,
      'provider never called without capacity'
    );

    // Disabled deployment must never place a service on a real server even
    // when active rows exist.
    for (const row of snapshot.rows) {
      if (row.status === 'active') {
        await pool.query("UPDATE servers SET status = 'active' WHERE id = $1", [
          row.id,
        ]);
      }
    }
    useProvider('disabled');
    assert.equal(await selectServer('vps', {}), null, 'disabled → no placement');
    assert.equal(await selectServer('hosting', {}), null, 'hosting → no server');
  } finally {
    for (const row of snapshot.rows) {
      await pool.query('UPDATE servers SET status = $1 WHERE id = $2', [
        row.status,
        row.id,
      ]);
    }
    await pool.query(
      "UPDATE servers SET status = 'active' WHERE name = 'prov-test-node'"
    );
  }
});

// ---------------------------------------------------------------------------
// API surface + security (sections 15, 18)
// ---------------------------------------------------------------------------

test('GET /api/services requires auth, validates query params, and returns only the caller services with a safe projection', async () => {
  resetMock();
  useProvider('mock');

  const unauth = await api('/services');
  assert.equal(unauth.response.status, 401);
  assert.equal(unauth.body.error.code, 'UNAUTHORIZED');

  const badQuery = await api('/services?evil=1', {
    headers: { Cookie: (await registerUser()).cookie },
  });
  assert.equal(badQuery.response.status, 400);
  assert.equal(badQuery.body.error.code, 'VALIDATION_ERROR');

  const alice = await registerUser('lister');
  const bob = await registerUser('lister2');
  const aliceOrder = await createPaidOrder(alice.cookie);
  const created = await provisionOrder(aliceOrder.id);
  assert.equal(created.instance.status, 'active');

  const bobList = await api('/services', { headers: { Cookie: bob.cookie } });
  assert.equal(bobList.response.status, 200);
  assert.deepEqual(bobList.body.data.services, [], "bob sees bob's services");

  const list = await api('/services', { headers: { Cookie: alice.cookie } });
  assert.equal(list.response.status, 200);
  const services = list.body.data.services;
  assert.equal(services.length, 1);
  assert.equal(services[0].id, created.instance.id);
  assert.deepEqual(Object.keys(services[0]).sort(), [
    'id',
    'orderId',
    'orderNumber',
    'serviceType',
    'status',
  ]);
  assert.ok(list.body.data.pagination, 'pagination present');

  const raw = JSON.stringify(list.body);
  for (const forbidden of [
    'external_id',
    'externalId',
    'server_id',
    'failure_code',
    'failure_message',
    'hostname',
    'mock-ext',
    '"provider"',
    'token',
    'secret',
  ]) {
    assert.ok(!raw.includes(forbidden), `response must not contain ${forbidden}`);
  }
});

test('no HTTP trigger exists for provisioning or lifecycle — POST/PUT shapes answer 404', async () => {
  const { cookie } = await registerUser();
  const targets = [
    { method: 'POST', path: '/provision', payload: { orderId: crypto.randomUUID() } },
    { method: 'POST', path: '/services', payload: { orderId: crypto.randomUUID() } },
    {
      method: 'POST',
      path: `/services/${crypto.randomUUID()}/suspend`,
      payload: {},
    },
    {
      method: 'POST',
      path: `/services/${crypto.randomUUID()}/terminate`,
      payload: {},
    },
    { method: 'PUT', path: '/services', payload: { status: 'active' } },
    { method: 'DELETE', path: `/services/${crypto.randomUUID()}`, payload: undefined },
  ];
  for (const t of targets) {
    const { response, body } = await api(t.path, {
      method: t.method,
      headers: {
        Cookie: cookie,
        ...(t.payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: t.payload ? JSON.stringify(t.payload) : undefined,
    });
    assert.equal(response.status, 404, `${t.method} ${t.path} must be 404`);
    assert.equal(body.error.code, 'NOT_FOUND');
  }
});

test('provisioning credentials never appear in backend source or frontend files', () => {
  const forbiddenLiterals = [
    'PROXMOX_TOKEN_SECRET=',
    'WHM_API_TOKEN=',
    'mock-ext-',
  ];
  const roots = [
    path.join(__dirname, '../src'),
    path.join(__dirname, '../../frontend'),
  ];
  for (const root of roots) {
    const entries = fs.readdirSync(root, { recursive: true });
    for (const entry of entries) {
      const file = path.join(root, String(entry));
      if (!fs.statSync(file).isFile()) continue;
      if (!/\.(js|html|css)$/i.test(String(entry))) continue;
      const content = fs.readFileSync(file, 'utf8');
      for (const literal of forbiddenLiterals) {
        assert.ok(
          !content.includes(literal),
          `${entry} must not contain ${literal}`
        );
      }
      // Secrets must come from the environment — never hardcoded.
      assert.ok(
        !/tokenSecret\s*[:=]\s*['"][^'"]+['"]/.test(content) ||
          content.includes('process.env'),
        `${entry} must not hardcode tokenSecret literals`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Dashboard (section 15)
// ---------------------------------------------------------------------------

test('dashboard.html services section is functional markup with ids and no inline scripts', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '../../frontend/dashboard.html'),
    'utf8'
  );
  assert.ok(html.includes('id="section-services"'));
  assert.ok(html.includes('data-section="services"'));
  assert.ok(html.includes('id="services-list"'));
  assert.ok(html.includes('id="services-status"'));
  assert.ok(html.includes('id="services-empty"'));
  assert.ok(html.includes('id="stat-active-services"'));
  // orders section assertions stay intact
  assert.ok(html.includes('id="section-orders"'));
  assert.ok(html.includes('id="orders-list"'));
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
  assert.equal(/<style[\s>]/i.test(html), false);
});

test('dashboard.js loads /api/services and renders safe service states without innerHTML', () => {
  const js = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/dashboard.js'),
    'utf8'
  );
  assert.ok(js.includes('/api/services'));
  assert.ok(js.includes('Payment received — service provisioning pending.'));
  assert.ok(js.includes('Provisioning your service...'));
  assert.ok(js.includes('Provisioning failed — support is required.'));
  assert.ok(js.includes('Service active.'));
  assert.ok(js.includes('order-service-state'));
  assert.ok(js.includes('ensureServicesLoaded'));
  // existing order assertions stay intact
  assert.ok(js.includes('/api/orders'));
  assert.ok(js.includes('order-number'));
  assert.ok(js.includes('awaiting_payment'));
  // no innerHTML injection of service or order fields
  assert.equal(
    /service\.(status|orderId|serviceType|orderNumber)[\s\S]{0,40}innerHTML/.test(
      js
    ),
    false
  );
  assert.equal(
    /order\.(orderNumber|amount)[\s\S]{0,40}innerHTML/.test(js),
    false
  );
});

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

test('regression: in-process API health still answers 200', async () => {
  const { response, body } = await api('/health');
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
});

test('regression: external test server health is OK and dashboard page still loads', async () => {
  const external = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
  const health = await fetch(`${external}/api/health`);
  assert.equal(health.status, 200);
  const page = await fetch(`${external}/dashboard.html`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('id="services-list"'), 'external server serves new markup');
});
