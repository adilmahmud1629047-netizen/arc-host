const { query } = require('../config/database');

const COLUMNS =
  'id, name, slug, description, price, currency, billing_cycle, storage_gb, bandwidth_gb, domains, email_accounts, databases, ssl, status, category, display_order, popular, cpu_cores, ram_mb, created_at, updated_at';

const ADMIN_COLUMNS =
  'p.id, p.name, p.slug, p.description, p.price, p.currency, p.billing_cycle, p.storage_gb, p.bandwidth_gb, p.domains, p.email_accounts, p.databases, p.ssl, p.status, p.category, p.display_order, p.popular, p.cpu_cores, p.ram_mb, p.created_at, p.updated_at';

const USAGE_COUNTS = `(SELECT count(*) FROM orders o WHERE o.product_type = 'hosting' AND o.product_id = p.id)::int AS order_count,
     (SELECT count(*) FROM service_instances s WHERE s.hosting_plan_id = p.id)::int AS service_count`;

async function findById(id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM hosting_plans WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findBySlug(slug) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM hosting_plans WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

async function findActiveBySlug(slug) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM hosting_plans WHERE slug = $1 AND status = $2`,
    [slug, 'active']
  );
  return rows[0] || null;
}

async function findActive(category = null) {
  if (category) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM hosting_plans WHERE status = $1 AND category = $2
       ORDER BY display_order ASC, price ASC`,
      ['active', category]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM hosting_plans WHERE status = $1
     ORDER BY display_order ASC, price ASC`,
    ['active']
  );
  return rows;
}

async function findAll({ limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM hosting_plans ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

function adminWhere({ search = null, status = null, category = null } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    params.push(status);
    clauses.push(`p.status = $${params.length}`);
  }
  if (category) {
    params.push(category);
    clauses.push(`p.category = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(p.name ILIKE $${params.length} OR p.slug ILIKE $${params.length})`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

async function listAdmin(filters = {}, { limit = 50, offset = 0 } = {}) {
  const { where, params } = adminWhere(filters);
  const totalResult = await query(
    `SELECT count(*)::int AS n FROM hosting_plans p ${where}`,
    params
  );
  const { rows } = await query(
    `SELECT ${USAGE_COUNTS}, ${ADMIN_COLUMNS}
     FROM hosting_plans p
     ${where}
     ORDER BY p.category ASC, p.display_order ASC, p.price ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { rows, total: totalResult.rows[0].n };
}

async function findByIdAdmin(id) {
  const { rows } = await query(
    `SELECT ${USAGE_COUNTS}, ${ADMIN_COLUMNS}
     FROM hosting_plans p WHERE p.id = $1`,
    [id]
  );
  return rows[0] || null;
}

const INSERT_SQL = `INSERT INTO hosting_plans
  (name, slug, description, price, currency, billing_cycle, storage_gb, bandwidth_gb,
   domains, email_accounts, databases, ssl, status, category, display_order, popular,
   cpu_cores, ram_mb)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
  RETURNING ${COLUMNS}`;

async function insertPlan(fields) {
  const { rows } = await query(INSERT_SQL, [
    fields.name,
    fields.slug,
    fields.description,
    fields.price,
    fields.currency,
    fields.billingCycle,
    fields.storageGb,
    fields.bandwidthGb,
    fields.domains,
    fields.emailAccounts,
    fields.databases,
    fields.ssl,
    fields.status,
    fields.category,
    fields.displayOrder,
    fields.popular,
    fields.cpuCores,
    fields.ramMb,
  ]);
  return rows[0];
}

const UPDATE_FIELDS = {
  name: 'name',
  slug: 'slug',
  description: 'description',
  price: 'price',
  currency: 'currency',
  billingCycle: 'billing_cycle',
  storageGb: 'storage_gb',
  bandwidthGb: 'bandwidth_gb',
  domains: 'domains',
  emailAccounts: 'email_accounts',
  databases: 'databases',
  ssl: 'ssl',
  status: 'status',
  category: 'category',
  displayOrder: 'display_order',
  popular: 'popular',
  cpuCores: 'cpu_cores',
  ramMb: 'ram_mb',
};

async function updatePlan(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATE_FIELDS[k]);
  if (keys.length === 0) return null;
  const sets = keys.map((k, i) => `${UPDATE_FIELDS[k]} = $${i + 2}`);
  const params = [id, ...keys.map((k) => fields[k])];
  const { rows } = await query(
    `UPDATE hosting_plans SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
    params
  );
  return rows[0] || null;
}

async function deletePlan(id) {
  const { rowCount } = await query('DELETE FROM hosting_plans WHERE id = $1', [id]);
  return rowCount;
}

async function countUsage(id) {
  const { rows } = await query(
    `SELECT
       (SELECT count(*) FROM orders o WHERE o.product_type = 'hosting' AND o.product_id = $1)::int AS orders,
       (SELECT count(*) FROM service_instances s WHERE s.hosting_plan_id = $1)::int AS services`,
    [id]
  );
  return rows[0];
}

module.exports = {
  findById,
  findBySlug,
  findActiveBySlug,
  findActive,
  findAll,
  listAdmin,
  findByIdAdmin,
  insertPlan,
  updatePlan,
  deletePlan,
  countUsage,
};
