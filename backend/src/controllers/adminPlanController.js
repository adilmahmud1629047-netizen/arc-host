const { sendOk, sendError } = require('../utils/respond');
const hostingPlanModel = require('../models/hostingPlanModel');
const vpsPlanModel = require('../models/vpsPlanModel');
const planService = require('../services/planService');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const PRICE_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;

const PRODUCT_TYPES = ['hosting', 'vps'];
const HOSTING_CATEGORIES = ['web', 'minecraft'];
const BILLING_CYCLES = ['monthly', 'quarterly', 'yearly'];
const PLAN_STATUSES = ['active', 'inactive', 'archived'];
// Writes never set 'archived' — that status is legacy/read-only; the admin UI
// only activates or deactivates.
const WRITE_STATUSES = ['active', 'inactive'];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_SEARCH = 100;
const MERGED_FETCH_LIMIT = 1000;

const COMMON_KEYS = [
  'productType',
  'name',
  'slug',
  'description',
  'price',
  'currency',
  'billingCycle',
  'status',
  'displayOrder',
  'popular',
];
const HOSTING_KEYS = [
  'category',
  'storageGb',
  'bandwidthGb',
  'domains',
  'emailAccounts',
  'databases',
  'ssl',
  'cpuCores',
  'ramMb',
];
const VPS_KEYS = ['cpuCores', 'ramMb', 'storageGb', 'bandwidthGb', 'ipv4Addresses'];

function modelFor(productType) {
  return productType === 'vps' ? vpsPlanModel : hostingPlanModel;
}

function allowedKeysFor(productType) {
  return new Set([
    ...COMMON_KEYS,
    ...(productType === 'vps' ? VPS_KEYS : HOSTING_KEYS),
  ]);
}

function parseInteger(value, { label, min, max, nullable = false }) {
  if (value === null) {
    if (nullable) return { ok: true, value: null };
    return { ok: false, error: `${label} is required.` };
  }
  if (typeof value !== 'string' || !/^-?\d{1,10}$/.test(value)) {
    return { ok: false, error: `${label} must be an integer.` };
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return { ok: false, error: `${label} must be between ${min} and ${max}.` };
  }
  return { ok: true, value: n };
}

function parseBoolean(value, { label, nullable = false }) {
  if (value === null) {
    if (nullable) return { ok: true, value: null };
    return { ok: false, error: `${label} is required.` };
  }
  if (typeof value === 'boolean') return { ok: true, value };
  if (value === 'true') return { ok: true, value: true };
  if (value === 'false') return { ok: true, value: false };
  return { ok: false, error: `${label} must be true or false.` };
}

function parseText(value, { label, min = 0, max, pattern = null, patternMessage = null, nullable = false, trim = true }) {
  if (value === null || value === undefined) {
    if (nullable && value === null) return { ok: true, value: null };
    return { ok: false, error: `${label} is required.` };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `${label} must be a string.` };
  }
  let text = trim ? value.trim() : value;
  if (text === '') {
    if (nullable) return { ok: true, value: null };
    return { ok: false, error: `${label} is required.` };
  }
  if (text.length < min) {
    return { ok: false, error: `${label} must be at least ${min} characters.` };
  }
  if (text.length > max) {
    return { ok: false, error: `${label} must be at most ${max} characters.` };
  }
  if (pattern && !pattern.test(text)) {
    return { ok: false, error: patternMessage || `${label} is invalid.` };
  }
  return { ok: true, value: text };
}

// Admin plan bodies are validated field-by-field here (same pattern as
// verifyPayment/rejectPayment): every key is whitelisted per product type,
// enums are checked, prices are pattern-validated (no negatives, no junk),
// and nullable fields accept an explicit JSON null so the UI can clear them.
function validatePlanBody(body, productType, { partial = false }) {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object.'] };
  }

  const errors = [];
  const out = {};
  const allowed = allowedKeysFor(productType);

  for (const key of Object.keys(body)) {
    if (key === 'productType' && partial) {
      errors.push('productType cannot be changed.');
      continue;
    }
    if (!allowed.has(key)) {
      if (HOSTING_KEYS.includes(key) || VPS_KEYS.includes(key) || COMMON_KEYS.includes(key)) {
        errors.push(`Field ${key} is not valid for ${productType} products.`);
        continue;
      }
      errors.push(`Unexpected field: ${key}.`);
    }
  }

  const provided = (key) =>
    Object.prototype.hasOwnProperty.call(body, key) &&
    !(partial && body[key] === undefined);

  if (!partial || provided('name')) {
    const r = parseText(body.name, { label: 'Name', min: 1, max: 100 });
    if (r.ok) out.name = r.value;
    else errors.push(r.error);
  }
  if (!partial || provided('slug')) {
    const r = parseText(body.slug, {
      label: 'Slug',
      min: 1,
      max: 100,
      pattern: SLUG_PATTERN,
      patternMessage: 'Slug must contain only lowercase letters, digits, and hyphens.',
    });
    if (r.ok) out.slug = r.value;
    else errors.push(r.error);
  }
  if (provided('description')) {
    const r = parseText(body.description, { label: 'Description', max: 500, nullable: true, trim: false });
    if (r.ok) out.description = r.value;
    else errors.push(r.error);
  }
  if (!partial || provided('price')) {
    const r = parseText(body.price, {
      label: 'Price',
      min: 1,
      max: 11,
      pattern: PRICE_PATTERN,
      patternMessage: 'Price must be a non-negative number with up to 2 decimals.',
    });
    if (r.ok) out.price = r.value;
    else errors.push(r.error);
  }
  if (provided('currency')) {
    const r = parseText(body.currency, {
      label: 'Currency',
      min: 3,
      max: 3,
      pattern: CURRENCY_PATTERN,
      patternMessage: 'Currency must be a 3-letter uppercase code.',
    });
    if (r.ok) out.currency = r.value;
    else errors.push(r.error);
  }
  if (provided('billingCycle')) {
    const r = parseText(body.billingCycle, { label: 'Billing cycle', max: 20 });
    if (!r.ok) errors.push(r.error);
    else if (!BILLING_CYCLES.includes(r.value)) {
      errors.push(`Billing cycle must be one of: ${BILLING_CYCLES.join(', ')}.`);
    } else out.billingCycle = r.value;
  }
  if (provided('status')) {
    const r = parseText(body.status, { label: 'Status', max: 20 });
    if (!r.ok) errors.push(r.error);
    else if (!WRITE_STATUSES.includes(r.value)) {
      errors.push(`Status must be one of: ${WRITE_STATUSES.join(', ')}.`);
    } else out.status = r.value;
  }
  if (provided('displayOrder')) {
    const r = parseInteger(body.displayOrder, { label: 'Display order', min: -100000, max: 100000 });
    if (r.ok) out.displayOrder = r.value;
    else errors.push(r.error);
  }
  if (provided('popular')) {
    const r = parseBoolean(body.popular, { label: 'Popular flag' });
    if (r.ok) out.popular = r.value;
    else errors.push(r.error);
  }

  if (productType === 'hosting') {
    if (provided('category')) {
      const r = parseText(body.category, { label: 'Category', max: 20 });
      if (!r.ok) errors.push(r.error);
      else if (!HOSTING_CATEGORIES.includes(r.value)) {
        errors.push(`Category must be one of: ${HOSTING_CATEGORIES.join(', ')}.`);
      } else out.category = r.value;
    }
    if (provided('ssl')) {
      const r = parseBoolean(body.ssl, { label: 'SSL' });
      if (r.ok) out.ssl = r.value;
      else errors.push(r.error);
    }
    if (provided('cpuCores')) {
      const r = parseInteger(body.cpuCores, { label: 'vCPU cores', min: 1, max: 128, nullable: true });
      if (r.ok) out.cpuCores = r.value;
      else errors.push(r.error);
    }
    if (provided('ramMb')) {
      const r = parseInteger(body.ramMb, { label: 'RAM (MB)', min: 64, max: 2097152, nullable: true });
      if (r.ok) out.ramMb = r.value;
      else errors.push(r.error);
    }
  } else {
    if (provided('cpuCores')) {
      const r = parseInteger(body.cpuCores, { label: 'vCPU cores', min: 1, max: 128 });
      if (r.ok) out.cpuCores = r.value;
      else errors.push(r.error);
    }
    if (provided('ramMb')) {
      const r = parseInteger(body.ramMb, { label: 'RAM (MB)', min: 1, max: 2097152 });
      if (r.ok) out.ramMb = r.value;
      else errors.push(r.error);
    }
    if (provided('ipv4Addresses')) {
      const r = parseInteger(body.ipv4Addresses, { label: 'IPv4 addresses', min: 1, max: 64 });
      if (r.ok) out.ipv4Addresses = r.value;
      else errors.push(r.error);
    }
  }

  if (provided('storageGb')) {
    const r = parseInteger(body.storageGb, { label: 'Storage (GB)', min: 1, max: 1048576 });
    if (r.ok) out.storageGb = r.value;
    else errors.push(r.error);
  }
  if (provided('bandwidthGb')) {
    const r = parseInteger(body.bandwidthGb, { label: 'Bandwidth (GB)', min: 0, max: 1048576, nullable: true });
    if (r.ok) out.bandwidthGb = r.value;
    else errors.push(r.error);
  }
  if (productType === 'hosting') {
    if (provided('domains')) {
      const r = parseInteger(body.domains, { label: 'Domains', min: 0, max: 100000 });
      if (r.ok) out.domains = r.value;
      else errors.push(r.error);
    }
    if (provided('emailAccounts')) {
      const r = parseInteger(body.emailAccounts, { label: 'Email accounts', min: 0, max: 100000 });
      if (r.ok) out.emailAccounts = r.value;
      else errors.push(r.error);
    }
    if (provided('databases')) {
      const r = parseInteger(body.databases, { label: 'Databases', min: 0, max: 100000 });
      if (r.ok) out.databases = r.value;
      else errors.push(r.error);
    }
  }

  if (errors.length > 0) return { errors };
  return { errors: [], value: out };
}

function createDefaults(productType, value) {
  const fields = { ...value };
  fields.billingCycle = fields.billingCycle || 'monthly';
  fields.status = fields.status || 'active';
  fields.currency = fields.currency || 'BDT';
  fields.displayOrder = fields.displayOrder === undefined ? 0 : fields.displayOrder;
  fields.popular = fields.popular === undefined ? false : fields.popular;
  fields.description = fields.description === undefined ? null : fields.description;
  fields.bandwidthGb = fields.bandwidthGb === undefined ? null : fields.bandwidthGb;
  if (productType === 'hosting') {
    fields.category = fields.category || 'web';
    fields.storageGb = fields.storageGb === undefined ? 1 : fields.storageGb;
    fields.domains = fields.domains === undefined ? 1 : fields.domains;
    fields.emailAccounts = fields.emailAccounts === undefined ? 0 : fields.emailAccounts;
    fields.databases = fields.databases === undefined ? 0 : fields.databases;
    fields.ssl = fields.ssl === undefined ? true : fields.ssl;
    fields.cpuCores = fields.cpuCores === undefined ? null : fields.cpuCores;
    fields.ramMb = fields.ramMb === undefined ? null : fields.ramMb;
  } else {
    fields.cpuCores = fields.cpuCores === undefined ? 1 : fields.cpuCores;
    fields.ramMb = fields.ramMb === undefined ? 1024 : fields.ramMb;
    fields.storageGb = fields.storageGb === undefined ? 20 : fields.storageGb;
    fields.ipv4Addresses = fields.ipv4Addresses === undefined ? 1 : fields.ipv4Addresses;
  }
  return fields;
}

function mapAdminRow(row, productType) {
  const base = {
    id: row.id,
    productType,
    name: row.name,
    slug: row.slug,
    description: row.description,
    price: row.price === null || row.price === undefined ? null : String(row.price),
    currency: row.currency,
    billingCycle: row.billing_cycle,
    status: row.status,
    popular: Boolean(row.popular),
    displayOrder: row.display_order,
    orderCount: row.order_count,
    serviceCount: row.service_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (productType === 'hosting') {
    return {
      ...base,
      category: row.category || 'web',
      storageGb: row.storage_gb,
      bandwidthGb: row.bandwidth_gb,
      domains: row.domains,
      emailAccounts: row.email_accounts,
      databases: row.databases,
      ssl: Boolean(row.ssl),
      cpuCores: row.cpu_cores,
      ramMb: row.ram_mb,
    };
  }
  return {
    ...base,
    category: 'vps',
    cpuCores: row.cpu_cores,
    ramMb: row.ram_mb,
    storageGb: row.storage_gb,
    bandwidthGb: row.bandwidth_gb,
    ipv4Addresses: row.ipv4_addresses,
  };
}

function parseProductType(value) {
  if (typeof value === 'string' && PRODUCT_TYPES.includes(value)) return value;
  return null;
}

function pagination(page, limit, total, returned) {
  const offset = (page - 1) * limit;
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasNext: offset + returned < total,
    hasPrev: page > 1,
  };
}

function isUniqueViolation(err) {
  return Boolean(err) && err.code === '23505' && /slug/i.test(String(err.constraint || ''));
}

// GET /api/admin/plans — paginated, filterable, server-derived product list.
async function listPlans(req, res, next) {
  try {
    const allowedQuery = new Set(['page', 'limit', 'search', 'status', 'category', 'productType']);
    for (const key of Object.keys(req.query || {})) {
      if (!allowedQuery.has(key)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `Unexpected query parameter: ${key}.`,
        ]);
      }
    }

    const pageParsed = parsePage(req.query.page);
    if (!pageParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [pageParsed.error]);
    }
    const limitParsed = parseLimit(req.query.limit);
    if (!limitParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [limitParsed.error]);
    }

    let status = null;
    if (req.query.status !== undefined && req.query.status !== '') {
      status = String(req.query.status);
      if (!PLAN_STATUSES.includes(status)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `status must be one of: ${PLAN_STATUSES.join(', ')}.`,
        ]);
      }
    }

    let category = null;
    if (req.query.category !== undefined && req.query.category !== '') {
      category = String(req.query.category);
      if (!HOSTING_CATEGORIES.includes(category)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `category must be one of: ${HOSTING_CATEGORIES.join(', ')}.`,
        ]);
      }
    }

    let productType = null;
    if (req.query.productType !== undefined && req.query.productType !== '') {
      productType = parseProductType(String(req.query.productType));
      if (!productType) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `productType must be one of: ${PRODUCT_TYPES.join(', ')}.`,
        ]);
      }
    }

    if (productType === 'vps' && category) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'category cannot be combined with productType=vps.',
      ]);
    }
    if (category) productType = productType || 'hosting';

    let search = null;
    if (req.query.search !== undefined && req.query.search !== '') {
      search = String(req.query.search).trim();
      if (search.length > MAX_SEARCH) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `search must be at most ${MAX_SEARCH} characters.`,
        ]);
      }
      if (search.length === 0) search = null;
    }

    const page = pageParsed.value;
    const limit = limitParsed.value;
    const filters = { search, status, category };

    if (productType) {
      const result = await modelFor(productType).listAdmin(filters, {
        limit,
        offset: (page - 1) * limit,
      });
      const items = result.rows.map((row) => mapAdminRow(row, productType));
      return sendOk(res, {
        products: items,
        pagination: pagination(page, limit, result.total, items.length),
      });
    }

    // Merged view: catalog size is small, fetch both tables (bounded) and
    // paginate in memory so ordering stays stable across the union.
    const [hosting, vps] = await Promise.all([
      hostingPlanModel.listAdmin(filters, { limit: MERGED_FETCH_LIMIT, offset: 0 }),
      vpsPlanModel.listAdmin(filters, { limit: MERGED_FETCH_LIMIT, offset: 0 }),
    ]);
    const typeOrder = { hosting: 0, vps: 1 };
    const merged = [
      ...hosting.rows.map((row) => mapAdminRow(row, 'hosting')),
      ...vps.rows.map((row) => mapAdminRow(row, 'vps')),
    ].sort((a, b) => {
      if (typeOrder[a.productType] !== typeOrder[b.productType]) {
        return typeOrder[a.productType] - typeOrder[b.productType];
      }
      if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
      return Number(a.price || 0) - Number(b.price || 0);
    });
    const total = hosting.total + vps.total;
    const offset = (page - 1) * limit;
    const items = merged.slice(offset, offset + limit);
    return sendOk(res, {
      products: items,
      pagination: pagination(page, limit, total, items.length),
    });
  } catch (err) {
    next(err);
  }
}

function parsePage(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: 1 };
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return { ok: false, error: 'page must be a positive integer.' };
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000000) {
    return { ok: false, error: 'page must be between 1 and 1000000.' };
  }
  return { ok: true, value: n };
}

function parseLimit(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: DEFAULT_LIMIT };
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return { ok: false, error: `limit must be between 1 and ${MAX_LIMIT}.` };
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_LIMIT) {
    return { ok: false, error: `limit must be between 1 and ${MAX_LIMIT}.` };
  }
  return { ok: true, value: n };
}

// GET /api/admin/plans/:productType/:id
async function getPlan(req, res, next) {
  try {
    const productType = parseProductType(req.params.productType);
    if (!productType) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `productType must be one of: ${PRODUCT_TYPES.join(', ')}.`,
      ]);
    }
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', ['Plan id must be a UUID.']);
    }
    const row = await modelFor(productType).findByIdAdmin(id);
    if (!row) {
      return sendError(res, 404, 'NOT_FOUND', 'Product not found.');
    }
    return sendOk(res, { product: mapAdminRow(row, productType) });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/plans — create (productType comes from the body).
async function createPlan(req, res, next) {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'Request body must be a JSON object.',
      ]);
    }
    const productType = parseProductType(body.productType);
    if (!productType) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `productType must be one of: ${PRODUCT_TYPES.join(', ')}.`,
      ]);
    }

    const result = validatePlanBody(body, productType, { partial: false });
    if (result.errors.length > 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', result.errors);
    }

    const fields = createDefaults(productType, result.value);
    const row = await modelFor(productType).insertPlan(fields);
    planService.invalidateCache();
    return sendOk(res, { product: mapAdminRow(row, productType) }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return sendError(res, 409, 'SLUG_TAKEN', 'A product with this slug already exists.');
    }
    next(err);
  }
}

// PATCH /api/admin/plans/:productType/:id — partial update + activate/deactivate.
async function updatePlan(req, res, next) {
  try {
    const productType = parseProductType(req.params.productType);
    if (!productType) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `productType must be one of: ${PRODUCT_TYPES.join(', ')}.`,
      ]);
    }
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', ['Plan id must be a UUID.']);
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'Request body must be a JSON object.',
      ]);
    }
    if (Object.keys(body).length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'No fields to update.',
      ]);
    }

    const result = validatePlanBody(body, productType, { partial: true });
    if (result.errors.length > 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', result.errors);
    }
    if (Object.keys(result.value).length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'No fields to update.',
      ]);
    }

    const row = await modelFor(productType).updatePlan(id, result.value);
    if (!row) {
      return sendError(res, 404, 'NOT_FOUND', 'Product not found.');
    }
    planService.invalidateCache();
    return sendOk(res, { product: mapAdminRow(row, productType) });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return sendError(res, 409, 'SLUG_TAKEN', 'A product with this slug already exists.');
    }
    next(err);
  }
}

// DELETE /api/admin/plans/:productType/:id — only when no order or service
// references the product; otherwise 409 so the admin deactivates instead.
async function deletePlan(req, res, next) {
  try {
    const productType = parseProductType(req.params.productType);
    if (!productType) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `productType must be one of: ${PRODUCT_TYPES.join(', ')}.`,
      ]);
    }
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', ['Plan id must be a UUID.']);
    }

    const model = modelFor(productType);
    const existing = await model.findByIdAdmin(id);
    if (!existing) {
      return sendError(res, 404, 'NOT_FOUND', 'Product not found.');
    }

    const usage = await model.countUsage(id);
    const referenced = usage.orders > 0 || usage.services > 0;
    if (referenced) {
      return sendError(
        res,
        409,
        'PLAN_IN_USE',
        'This product cannot be deleted because existing orders or services depend on it. Deactivate it instead.',
        [`${usage.orders} order(s), ${usage.services} service(s) reference this product.`]
      );
    }

    const deleted = await model.deletePlan(id);
    if (deleted === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Product not found.');
    }
    planService.invalidateCache();
    return sendOk(res, { deleted: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
};
