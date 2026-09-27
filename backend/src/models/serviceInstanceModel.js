const { query } = require('../config/database');

// Full internal row (includes server_id / external_id / failure diagnostics —
// never returned directly to API clients; use mapPublic for responses).
const COLUMNS = `id, user_id, order_id, service_type, hosting_plan_id, vps_plan_id,
  server_id, external_id, hostname, status, provider,
  provisioned_at, suspended_at, terminated_at,
  failure_code, failure_message_safe, created_at, updated_at`;

const COLUMNS_WITH_ORDER = `
  si.id, si.user_id, si.order_id, si.service_type, si.status,
  o.order_number
FROM service_instances si
LEFT JOIN orders o ON o.id = si.order_id
`;

async function findById(id) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM service_instances WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function findByOrderId(orderId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM service_instances WHERE order_id = $1 LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

async function findByUserWithOrder(userId, { limit = 10, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${COLUMNS_WITH_ORDER}
     WHERE si.user_id = $1
     ORDER BY si.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

async function countByUser(userId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM service_instances WHERE user_id = $1',
    [userId]
  );
  return rows[0].n;
}

// Insert initial 'provisioning' row. The unique index on order_id makes
// duplicate creation for the same order impossible — a losing racer receives
// Postgres error 23505, which the service converts into an idempotent replay.
async function create({
  userId,
  orderId,
  serviceType,
  hostingPlanId = null,
  vpsPlanId = null,
  serverId = null,
  provider,
  status = 'provisioning',
}) {
  const { rows } = await query(
    `INSERT INTO service_instances (
       user_id, order_id, service_type, hosting_plan_id, vps_plan_id,
       server_id, provider, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [userId, orderId, serviceType, hostingPlanId, vpsPlanId, serverId, provider, status]
  );
  return rows[0];
}

// Guarded transitions — the WHERE clause enforces the allowed state machine
// at the database level (races resolve to zero rows -> INVALID_STATE).
async function markActive(id, externalId) {
  const { rows } = await query(
    `UPDATE service_instances
     SET status = 'active',
         external_id = $2,
         provisioned_at = now(),
         failure_code = NULL,
         failure_message_safe = NULL
     WHERE id = $1 AND status = 'provisioning'
     RETURNING ${COLUMNS}`,
    [id, externalId]
  );
  return rows[0] || null;
}

async function markFailed(id, failureCode, failureMessageSafe) {
  const { rows } = await query(
    `UPDATE service_instances
     SET status = 'failed',
         failure_code = $2,
         failure_message_safe = $3
     WHERE id = $1 AND status = 'provisioning'
     RETURNING ${COLUMNS}`,
    [id, failureCode, failureMessageSafe]
  );
  return rows[0] || null;
}

async function markSuspended(id) {
  const { rows } = await query(
    `UPDATE service_instances
     SET status = 'suspended',
         suspended_at = now()
     WHERE id = $1 AND status = 'active'
     RETURNING ${COLUMNS}`,
    [id]
  );
  return rows[0] || null;
}

async function markResumed(id) {
  const { rows } = await query(
    `UPDATE service_instances
     SET status = 'active',
         suspended_at = NULL
     WHERE id = $1 AND status = 'suspended'
     RETURNING ${COLUMNS}`,
    [id]
  );
  return rows[0] || null;
}

async function markTerminated(id) {
  const { rows } = await query(
    `UPDATE service_instances
     SET status = 'terminated',
         terminated_at = now()
     WHERE id = $1 AND status IN ('active', 'suspended')
     RETURNING ${COLUMNS}`,
    [id]
  );
  return rows[0] || null;
}

// API-safe projection — never includes server_id, external_id, provider,
// hostname, or failure diagnostics (internal infrastructure details).
function mapPublic(row) {
  if (!row) return null;
  const out = {
    id: row.id,
    orderId: row.order_id,
    serviceType: row.service_type,
    status: row.status,
  };
  if (row.order_number !== undefined && row.order_number !== null) {
    out.orderNumber = row.order_number;
  }
  return out;
}

module.exports = {
  COLUMNS,
  findById,
  findByOrderId,
  findByUserWithOrder,
  countByUser,
  create,
  markActive,
  markFailed,
  markSuspended,
  markResumed,
  markTerminated,
  mapPublic,
};
