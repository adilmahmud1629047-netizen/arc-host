const { query } = require('../config/database');

const COLUMNS =
  'id, user_id, order_number, product_type, product_id, amount, currency, billing_cycle, status, created_at, updated_at';

const COLUMNS_WITH_PLAN = `
  o.id, o.user_id, o.order_number, o.product_type, o.product_id,
  o.amount, o.currency, o.billing_cycle, o.status, o.created_at, o.updated_at,
  CASE o.product_type
    WHEN 'hosting' THEN hp.name
    WHEN 'vps' THEN vp.name
  END AS plan_name,
  CASE o.product_type
    WHEN 'hosting' THEN hp.slug
    WHEN 'vps' THEN vp.slug
  END AS plan_slug
FROM orders o
LEFT JOIN hosting_plans hp ON o.product_type = 'hosting' AND hp.id = o.product_id
LEFT JOIN vps_plans vp ON o.product_type = 'vps' AND vp.id = o.product_id
`;

async function findByIdForUser(id, userId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM orders WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

// Internal trusted lookup (provisioning workflow) — ownership, when
// required, is enforced by the caller via findByIdForUser.
async function findById(id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM orders WHERE id = $1`, [
    id,
  ]);
  return rows[0] || null;
}

async function findByIdWithPlanForUser(id, userId) {
  const { rows } = await query(
    `SELECT ${COLUMNS_WITH_PLAN}
     WHERE o.id = $1 AND o.user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

async function findByUserWithPlan(userId, { limit = 10, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${COLUMNS_WITH_PLAN}
     WHERE o.user_id = $1
     ORDER BY o.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

async function countByUser(userId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1',
    [userId]
  );
  return rows[0].n;
}

async function findByIdempotencyKey(userId, key) {
  if (!key) return null;
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM orders WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, key]
  );
  return rows[0] || null;
}

async function findByIdempotencyKeyWithPlan(userId, key) {
  if (!key) return null;
  const { rows } = await query(
    `SELECT ${COLUMNS_WITH_PLAN}
     WHERE o.user_id = $1 AND o.idempotency_key = $2`,
    [userId, key]
  );
  return rows[0] || null;
}

async function createWithPlanSnapshot(
  client,
  {
    userId,
    orderNumber,
    productType,
    productId,
    amount,
    currency,
    billingCycle,
    status,
    idempotencyKey,
  }
) {
  const { rows } = await client.query(
    `INSERT INTO orders (
       user_id, order_number, product_type, product_id,
       amount, currency, billing_cycle, status, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${COLUMNS}`,
    [
      userId,
      orderNumber,
      productType,
      productId,
      amount,
      currency,
      billingCycle,
      status,
      idempotencyKey || null,
    ]
  );
  return rows[0];
}

// Internal transition helpers (used by the payment service inside a
// transaction — never exposed through an HTTP route).
async function findByIdForUpdate(client, id) {
  const { rows } = await client.query(
    `SELECT id, user_id, order_number, product_type, product_id,
            amount::text AS amount, currency, billing_cycle, status
     FROM orders
     WHERE id = $1
     FOR UPDATE`,
    [id]
  );
  return rows[0] || null;
}

async function markPaidIfAwaiting(client, id) {
  const { rows } = await client.query(
    `UPDATE orders
     SET status = 'paid'
     WHERE id = $1 AND status IN ('pending', 'awaiting_payment')
     RETURNING id, status`,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  COLUMNS,
  findById,
  findByIdForUser,
  findByIdWithPlanForUser,
  findByUserWithPlan,
  countByUser,
  findByIdempotencyKey,
  findByIdempotencyKeyWithPlan,
  createWithPlanSnapshot,
  findByIdForUpdate,
  markPaidIfAwaiting,
};
