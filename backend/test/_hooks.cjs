// Loaded by `npm test` through:  node --test --require ./test/_hooks.cjs
//
// Registers a ROOT beforeEach, so it runs before EVERY test in the test-file
// process. It only CLEARS in-memory rate-limiter counters — it never changes a
// limit, a window, a default, or the middleware chain, so production behaviour
// and every 429 assertion stay exactly as they are.
//
// Registers a ROOT before() that ensures the canonical demo-plan fixtures are
// present and ACTIVE (STEP 45): the demo rows are deactivated/deleted from the
// live catalog after cleanup, but the suite (plans/orders/payments/…) depends
// on those slugs being orderable. The upsert restores the canonical seed specs
// so every run sees the same deterministic catalog, then asks the test server
// to drop its plan cache (fixtures are written from THIS process, so the
// server's in-memory cache would otherwise serve stale data for up to 30 s).
// Runs only under `npm test`; production behaviour is untouched.
//
// Isolation is done in two places because limiters live in two processes:
//   1. limiters instantiated inside this test process (e.g. smsSendLimiter)
//   2. limiters instantiated inside the test server (register/login/order/...)

const { before, beforeEach } = require('node:test');

const BASE_URL = (
  process.env.TEST_BASE_URL || 'http://127.0.0.1:5056'
).replace(/\/+$/, '');

const RESET_PATH = '/api/_test/reset-rate-limits';
const RESET_PLAN_CACHE_PATH = '/api/_test/reset-plan-cache';

let warned = false;
function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(`[test-hooks] ${message}`);
}

async function ensureTestCatalog() {
  const { query } = require('../src/config/database');
  const { HOSTING_PLANS, VPS_PLANS } = require('../src/services/seed');

  for (const plan of HOSTING_PLANS) {
    await query(
      `INSERT INTO hosting_plans (
         name, slug, description, price, currency, billing_cycle,
         storage_gb, bandwidth_gb, domains, email_accounts, databases, ssl,
         status, category
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', 'web')
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         billing_cycle = EXCLUDED.billing_cycle,
         storage_gb = EXCLUDED.storage_gb,
         bandwidth_gb = EXCLUDED.bandwidth_gb,
         domains = EXCLUDED.domains,
         email_accounts = EXCLUDED.email_accounts,
         databases = EXCLUDED.databases,
         ssl = EXCLUDED.ssl,
         status = 'active',
         category = 'web'`,
      [
        plan.name,
        plan.slug,
        plan.description,
        plan.price,
        'BDT',
        plan.billingCycle,
        plan.storageGb,
        plan.bandwidthGb,
        plan.domains,
        plan.emailAccounts,
        plan.databases,
        plan.ssl,
      ]
    );
  }

  for (const plan of VPS_PLANS) {
    await query(
      `INSERT INTO vps_plans (
         name, slug, description, price, currency, billing_cycle,
         cpu_cores, ram_mb, storage_gb, bandwidth_gb, ipv4_addresses, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         billing_cycle = EXCLUDED.billing_cycle,
         cpu_cores = EXCLUDED.cpu_cores,
         ram_mb = EXCLUDED.ram_mb,
         storage_gb = EXCLUDED.storage_gb,
         bandwidth_gb = EXCLUDED.bandwidth_gb,
         ipv4_addresses = EXCLUDED.ipv4_addresses,
         status = 'active'`,
      [
        plan.name,
        plan.slug,
        plan.description,
        plan.price,
        'BDT',
        plan.billingCycle,
        plan.cpuCores,
        plan.ramMb,
        plan.storageGb,
        plan.bandwidthGb,
        plan.ipv4Addresses,
      ]
    );
  }
}

before(async () => {
  try {
    await ensureTestCatalog();
  } catch (err) {
    warnOnce(`plan fixtures not ensured: ${err.message}`);
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}${RESET_PLAN_CACHE_PATH}`, { method: 'POST' });
    if (res.status === 404) {
      warnOnce(
        `test server at ${BASE_URL} has no ${RESET_PLAN_CACHE_PATH} — start it with NODE_ENV=test`
      );
    } else if (!res.ok) {
      warnOnce(`${RESET_PLAN_CACHE_PATH} returned HTTP ${res.status}`);
    }
  } catch (err) {
    warnOnce(`cannot reach test server at ${BASE_URL}: ${err.message}`);
  }
});

beforeEach(async () => {
  try {
    const { resetAllRateLimiters } = require('../src/utils/rateLimiter');
    resetAllRateLimiters();
  } catch (err) {
    warnOnce(`in-process limiter reset skipped: ${err.message}`);
  }

  try {
    const res = await fetch(`${BASE_URL}${RESET_PATH}`, { method: 'POST' });
    if (res.status === 404) {
      warnOnce(
        `test server at ${BASE_URL} has no ${RESET_PATH} — start it with NODE_ENV=test`
      );
    } else if (!res.ok) {
      warnOnce(`${RESET_PATH} returned HTTP ${res.status}`);
    }
  } catch (err) {
    warnOnce(`cannot reach test server at ${BASE_URL}: ${err.message}`);
  }
});
