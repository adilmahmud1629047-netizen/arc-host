const config = require('../config');
const { query, closePool } = require('../config/database');

// DEMO / PLACEHOLDER catalog only — not a commercial offer.
// Prices are sample BDT figures for local development. Demo rows are inserted
// as INACTIVE so a manual seed run never makes fake products visible to
// customers (STEP 45); the test suite activates them through its own fixture
// helper (_hooks.cjs ensureTestCatalog).
const HOSTING_PLANS = [
  {
    name: 'Starter',
    slug: 'starter',
    description:
      'Sample demo tier for personal sites and first projects. Placeholder pricing.',
    price: '299.00',
    billingCycle: 'monthly',
    storageGb: 5,
    bandwidthGb: 50,
    domains: 1,
    emailAccounts: 5,
    databases: 2,
    ssl: true,
  },
  {
    name: 'Business',
    slug: 'business',
    description:
      'Sample demo tier for businesses and multi-site projects. Placeholder pricing.',
    price: '799.00',
    billingCycle: 'monthly',
    storageGb: 25,
    bandwidthGb: 250,
    domains: 10,
    emailAccounts: 50,
    databases: 20,
    ssl: true,
  },
  {
    name: 'Pro',
    slug: 'pro',
    description:
      'Sample demo tier for high-traffic and agency use. Placeholder pricing.',
    price: '1499.00',
    billingCycle: 'monthly',
    storageGb: 50,
    bandwidthGb: null,
    domains: null,
    emailAccounts: null,
    databases: null,
    ssl: true,
  },
];

const VPS_PLANS = [
  {
    name: 'VPS-1',
    slug: 'vps-1',
    description:
      'Sample demo entry VPS for light workloads. Placeholder pricing.',
    price: '599.00',
    billingCycle: 'monthly',
    cpuCores: 1,
    ramMb: 1024,
    storageGb: 25,
    bandwidthGb: 100,
    ipv4Addresses: 1,
  },
  {
    name: 'VPS-2',
    slug: 'vps-2',
    description:
      'Sample demo mid-tier VPS for growing production apps. Placeholder pricing.',
    price: '1099.00',
    billingCycle: 'monthly',
    cpuCores: 2,
    ramMb: 2048,
    storageGb: 50,
    bandwidthGb: 250,
    ipv4Addresses: 1,
  },
  {
    name: 'VPS-4',
    slug: 'vps-4',
    description:
      'Sample demo higher-tier VPS for demanding workloads. Placeholder pricing.',
    price: '1999.00',
    billingCycle: 'monthly',
    cpuCores: 4,
    ramMb: 4096,
    storageGb: 100,
    bandwidthGb: null,
    ipv4Addresses: 2,
  },
];

async function seedHostingPlans() {
  let inserted = 0;
  let skipped = 0;

  for (const plan of HOSTING_PLANS) {
    const { rowCount } = await query(
      `INSERT INTO hosting_plans (
         name, slug, description, price, currency, billing_cycle,
         storage_gb, bandwidth_gb, domains, email_accounts, databases, ssl, status, category
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'inactive', 'web')
       ON CONFLICT (slug) DO NOTHING`,
      [
        plan.name,
        plan.slug,
        plan.description,
        plan.price,
        config.catalog.currency,
        plan.billingCycle,
        plan.storageGb,
        plan.bandwidthGb,
        plan.domains,
        plan.emailAccounts,
        plan.databases,
        plan.ssl,
      ]
    );
    if (rowCount > 0) inserted += 1;
    else skipped += 1;
  }

  return { inserted, skipped };
}

async function seedVpsPlans() {
  let inserted = 0;
  let skipped = 0;

  for (const plan of VPS_PLANS) {
    const { rowCount } = await query(
      `INSERT INTO vps_plans (
         name, slug, description, price, currency, billing_cycle,
         cpu_cores, ram_mb, storage_gb, bandwidth_gb, ipv4_addresses, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'inactive')
       ON CONFLICT (slug) DO NOTHING`,
      [
        plan.name,
        plan.slug,
        plan.description,
        plan.price,
        config.catalog.currency,
        plan.billingCycle,
        plan.cpuCores,
        plan.ramMb,
        plan.storageGb,
        plan.bandwidthGb,
        plan.ipv4Addresses,
      ]
    );
    if (rowCount > 0) inserted += 1;
    else skipped += 1;
  }

  return { inserted, skipped };
}

async function runSeed() {
  const hosting = await seedHostingPlans();
  const vps = await seedVpsPlans();
  return { hosting, vps };
}

async function main() {
  if (config.isProduction && process.env.SEED_ALLOW_PRODUCTION !== 'true') {
    console.error(
      'Refusing to seed in production. Set SEED_ALLOW_PRODUCTION=true to override.'
    );
    process.exitCode = 1;
    return;
  }

  try {
    const { runUp } = require('./migrator');
    await runUp();

    const result = await runSeed();
    console.log(
      `Hosting plans: ${result.hosting.inserted} inserted, ${result.hosting.skipped} already existed.`
    );
    console.log(
      `VPS plans: ${result.vps.inserted} inserted, ${result.vps.skipped} already existed.`
    );
    console.log('Seed complete. Data is demo/placeholder catalog only.');
  } finally {
    await closePool().catch(() => {});
  }
}

module.exports = { runSeed, HOSTING_PLANS, VPS_PLANS };

if (require.main === module) {
  main().catch((err) => {
    console.error(`Seed failed: ${err.message}`);
    process.exit(1);
  });
}
