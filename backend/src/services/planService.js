const config = require('../config');
const hostingPlanModel = require('../models/hostingPlanModel');
const vpsPlanModel = require('../models/vpsPlanModel');

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 100;

const cache = new Map();

function isValidSlug(slug) {
  return (
    typeof slug === 'string' &&
    slug.length > 0 &&
    slug.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(slug)
  );
}

function priceToString(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function nullToUnlimited(value) {
  return value === undefined ? null : value;
}

function mapHostingPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    price: priceToString(row.price),
    currency: row.currency || config.catalog.currency,
    billingCycle: row.billing_cycle,
    category: row.category || 'web',
    storageGb: row.storage_gb,
    bandwidthGb: nullToUnlimited(row.bandwidth_gb),
    domains: nullToUnlimited(row.domains),
    emailAccounts: nullToUnlimited(row.email_accounts),
    databases: nullToUnlimited(row.databases),
    ssl: Boolean(row.ssl),
    cpuCores: row.cpu_cores === undefined ? null : row.cpu_cores,
    ramMb: row.ram_mb === undefined ? null : row.ram_mb,
    displayOrder: row.display_order === undefined ? 0 : row.display_order,
    popular: Boolean(row.popular),
  };
}

function mapVpsPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    price: priceToString(row.price),
    currency: row.currency || config.catalog.currency,
    billingCycle: row.billing_cycle,
    cpuCores: row.cpu_cores,
    ramMb: row.ram_mb,
    storageGb: row.storage_gb,
    bandwidthGb: nullToUnlimited(row.bandwidth_gb),
    ipv4Addresses: row.ipv4_addresses,
    displayOrder: row.display_order === undefined ? 0 : row.display_order,
    popular: Boolean(row.popular),
  };
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + config.catalog.cacheTtlMs });
}

function invalidateCache() {
  cache.clear();
}

async function listHostingPlans(category = null) {
  const cacheKey = `hosting:list:${category || 'all'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const rows = await hostingPlanModel.findActive(category);
  const plans = rows.map(mapHostingPlan);
  cacheSet(cacheKey, plans);
  return plans;
}

async function getHostingPlanBySlug(slug) {
  if (!isValidSlug(slug)) {
    return { ok: false, reason: 'invalid' };
  }

  const cacheKey = `hosting:${slug}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    return cached === false ? { ok: false, reason: 'not_found' } : { ok: true, plan: cached };
  }

  const row = await hostingPlanModel.findActiveBySlug(slug);
  if (!row) {
    cacheSet(cacheKey, false);
    return { ok: false, reason: 'not_found' };
  }

  const plan = mapHostingPlan(row);
  cacheSet(cacheKey, plan);
  return { ok: true, plan };
}

async function listVpsPlans() {
  const cacheKey = 'vps:list';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const rows = await vpsPlanModel.findActive();
  const plans = rows.map(mapVpsPlan);
  cacheSet(cacheKey, plans);
  return plans;
}

async function getVpsPlanBySlug(slug) {
  if (!isValidSlug(slug)) {
    return { ok: false, reason: 'invalid' };
  }

  const cacheKey = `vps:${slug}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    return cached === false ? { ok: false, reason: 'not_found' } : { ok: true, plan: cached };
  }

  const row = await vpsPlanModel.findActiveBySlug(slug);
  if (!row) {
    cacheSet(cacheKey, false);
    return { ok: false, reason: 'not_found' };
  }

  const plan = mapVpsPlan(row);
  cacheSet(cacheKey, plan);
  return { ok: true, plan };
}

module.exports = {
  isValidSlug,
  mapHostingPlan,
  mapVpsPlan,
  listHostingPlans,
  getHostingPlanBySlug,
  listVpsPlans,
  getVpsPlanBySlug,
  invalidateCache,
  SLUG_PATTERN,
};
