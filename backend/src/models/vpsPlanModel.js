const { query } = require('../config/database');

const COLUMNS =
  'id, name, slug, description, price, currency, billing_cycle, cpu_cores, ram_mb, storage_gb, bandwidth_gb, ipv4_addresses, status, display_order, popular, created_at, updated_at';

const ADMIN_COLUMNS =
  'p.id, p.name, p.slug, p.description, p.price, p.currency, p.billing_cycle, p.cpu_cores, p.ram_mb, p.storage_gb, p.bandwidth_gb, p.ipv4_addresses, p.status, p.display_order, p.popular, p.created_at, p.updated_at';

const USAGE_COUNTS = `(SELECT count(*) FROM orders o WHERE o.product_type = 'vps' AND o.product_id = p.id)::int AS order_count,
     (SELECT count(*) FROM service_instances s WHERE s.vps_plan_id = p.id)::int AS service_count`;

async function findById(id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM vps_plans WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findBySlug(slug) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM vps_plans WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

async function findActiveBySlug(slug) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM vps_plans WHERE slug = $1 AND status = $2`,
    [slug, 'active']
  );
  return rows[0] || null;
}

async function findActive() {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM vps_plans WHERE status = $1
     ORDER BY display_order ASC, price ASC`,
    ['active']
  );
  return rows;
}

async function findAll({ limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM vps_plans ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

function adminWhere({ search = null, status = null } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    params.push(status);
    clauses.push(`p.status = $${params.length}`);
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
    `SELECT count(*)::int AS n FROM vps_plans p ${where}`,
    params
  );
  const { rows } = await query(
    `SELECT ${USAGE_COUNTS}, ${ADMIN_COLUMNS}
     FROM vps_plans p
     ${where}
     ORDER BY p.display_order ASC, p.price ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { rows, total: totalResult.rows[0].n };
}

async function findByIdAdmin(id) {
  const { rows } = await query(
    `SELECT ${USAGE_COUNTS}, ${ADMIN_COLUMNS}
     FROM vps_plans p WHERE p.id = $1`,
    [id]
  );
  return rows[0] || null;
}

const INSERT_SQL = `INSERT INTO vps_plans
  (name, slug, description, price, currency, billing_cycle, cpu_cores, ram_mb,
   storage_gb, bandwidth_gb, ipv4_addresses, status, display_order, popular)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
  RETURNING ${COLUMNS}`;

async function insertPlan(fields) {
  const { rows } = await query(INSERT_SQL, [
    fields.name,
    fields.slug,
    fields.description,
    fields.price,
    fields.currency,
    fields.billingCycle,
    fields.cpuCores,
    fields.ramMb,
    fields.storageGb,
    fields.bandwidthGb,
    fields.ipv4Addresses,
    fields.status,
    fields.displayOrder,
    fields.popular,
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
  cpuCores: 'cpu_cores',
  ramMb: 'ram_mb',
  storageGb: 'storage_gb',
  bandwidthGb: 'bandwidth_gb',
  ipv4Addresses: 'ipv4_addresses',
  status: 'status',
  displayOrder: 'display_order',
  popular: 'popular',
};

async function updatePlan(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATE_FIELDS[k]);
  if (keys.length === 0) return null;
  const sets = keys.map((k, i) => `${UPDATE_FIELDS[k]} = $${i + 2}`);
  const params = [id, ...keys.map((k) => fields[k])];
  const { rows } = await query(
    `UPDATE vps_plans SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
    params
  );
  return rows[0] || null;
}

async function deletePlan(id) {
  const { rowCount } = await query('DELETE FROM vps_plans WHERE id = $1', [id]);
  return rowCount;
}

async function countUsage(id) {
  const { rows } = await query(
    `SELECT
       (SELECT count(*) FROM orders o WHERE o.product_type = 'vps' AND o.product_id = $1)::int AS orders,
       (SELECT count(*) FROM service_instances s WHERE s.vps_plan_id = $1)::int AS services`,
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
