const { query } = require('../config/database');

const SAFE_COLUMNS = `
  p.id, p.order_id, o.order_number, p.provider, p.amount, p.currency,
  p.status, p.initiated_at, p.paid_at, p.created_at
`;

const ALL_COLUMN_NAMES = [
  'id',
  'order_id',
  'user_id',
  'provider',
  'provider_transaction_id',
  'amount',
  'currency',
  'status',
  'payment_method',
  'initiated_at',
  'paid_at',
  'failed_at',
  'metadata',
  'provider_session_key',
  'validation_id',
  'bank_transaction_id',
  'created_at',
  'updated_at',
];

const ALL_COLUMNS = ALL_COLUMN_NAMES.join(', ');

// Same allow-list qualified with `p.` for queries that join the orders table
// (bare `id`/`amount`/`status` would be ambiguous), plus the order number.
const QUALIFIED_ALL_COLUMNS =
  ALL_COLUMN_NAMES.map((column) => `p.${column}`).join(', ') +
  ', o.order_number';

async function create({
  orderId,
  userId,
  provider,
  amount,
  currency,
  status = 'initiated',
  paymentMethod = null,
  providerTransactionId = null,
}) {
  const { rows } = await query(
    `INSERT INTO payment_transactions (
       order_id, user_id, provider, provider_transaction_id, amount, currency,
       status, payment_method
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ALL_COLUMNS}`,
    [
      orderId,
      userId,
      provider,
      providerTransactionId || null,
      amount,
      currency,
      status,
      paymentMethod,
    ]
  );
  return rows[0];
}

async function findByUserWithOrder(userId, { limit = 10, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${SAFE_COLUMNS}
     FROM payment_transactions p
     JOIN orders o ON o.id = p.order_id
     WHERE p.user_id = $1
     ORDER BY p.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

async function findByIdForUserWithOrder(id, userId) {
  const { rows } = await query(
    `SELECT ${SAFE_COLUMNS}
     FROM payment_transactions p
     JOIN orders o ON o.id = p.order_id
     WHERE p.id = $1 AND p.user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

async function countByUser(userId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM payment_transactions WHERE user_id = $1',
    [userId]
  );
  return rows[0].n;
}

async function findByIdForUpdate(client, id) {
  const { rows } = await client.query(
    `SELECT ${ALL_COLUMNS} FROM payment_transactions WHERE id = $1 FOR UPDATE`,
    [id]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await query(
    `SELECT ${ALL_COLUMNS} FROM payment_transactions WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

// Newest pending manual submission for one order (0 or 1 row — a partial
// unique index guarantees at most one).
async function findPendingManualForOrder(orderId) {
  const { rows } = await query(
    `SELECT ${ALL_COLUMNS} FROM payment_transactions
     WHERE order_id = $1 AND provider = 'manual' AND status = 'pending'`,
    [orderId]
  );
  return rows[0] || null;
}

// Newest manual submission for an order, scoped to the owning user
// (ownership is proven by the orders join, never by the request body).
async function findLatestManualForOrder(orderId, userId) {
  const { rows } = await query(
    `SELECT ${QUALIFIED_ALL_COLUMNS}
     FROM payment_transactions p
     JOIN orders o ON o.id = p.order_id
     WHERE p.order_id = $1 AND o.user_id = $2 AND p.provider = 'manual'
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT 1`,
    [orderId, userId]
  );
  return rows[0] || null;
}

async function findByProviderTransactionId(provider, providerTransactionId) {
  if (!provider || !providerTransactionId) return null;
  const { rows } = await query(
    `SELECT ${ALL_COLUMNS} FROM payment_transactions
     WHERE provider = $1 AND provider_transaction_id = $2`,
    [provider, providerTransactionId]
  );
  return rows[0] || null;
}

// Newest OPEN gateway session for one order + provider. A retry of an
// already-started payment reuses this row instead of opening a second
// session. Manual submissions and never-started (`initiated`) attempts are
// not gateway sessions and are never matched here.
async function findPendingGatewayForOrder(orderId, provider) {
  if (!orderId || !provider) return null;
  const { rows } = await query(
    `SELECT ${ALL_COLUMNS} FROM payment_transactions
     WHERE order_id = $1 AND provider = $2 AND status = 'pending'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [orderId, provider]
  );
  return rows[0] || null;
}

// A reference is globally unique no matter which provider recorded it —
// admin manual verification must never let the same transaction id settle
// two different payments.
async function findByTransactionIdAnywhere(providerTransactionId) {
  if (!providerTransactionId) return null;
  const { rows } = await query(
    `SELECT ${ALL_COLUMNS} FROM payment_transactions
     WHERE UPPER(provider_transaction_id) = UPPER($1)
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [providerTransactionId]
  );
  return rows[0] || null;
}

// details: { providerTransactionId, validationId, bankTranId, metadata }
// metadata is merged (||) — risk_level / risk_flag etc. Never stores secrets.
async function markSuccessful(client, id, details = {}) {
  const {
    providerTransactionId = null,
    validationId = null,
    bankTranId = null,
    metadata = {},
  } = details;
  const { rows } = await client.query(
    `UPDATE payment_transactions
     SET status = 'successful',
         paid_at = now(),
         provider_transaction_id = COALESCE($2, provider_transaction_id),
         validation_id = COALESCE($3, validation_id),
         bank_transaction_id = COALESCE($4, bank_transaction_id),
         metadata = metadata || $5::jsonb
     WHERE id = $1 AND status <> 'successful'
     RETURNING ${ALL_COLUMNS}`,
    [
      id,
      providerTransactionId || null,
      validationId || null,
      bankTranId || null,
      JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
    ]
  );
  return rows[0] || null;
}

// Failure-direction transition only (initiated/pending → terminal). A
// successful payment can never be downgraded.
// details.metadata is merged (||) — rejection reason / reviewer audit fields.
async function markTerminal(id, status, details = {}) {
  const { metadata = {} } = details;
  const { rows } = await query(
    `UPDATE payment_transactions
     SET status = $2::varchar,
         failed_at = CASE
           WHEN $2::varchar IN ('failed', 'cancelled', 'expired')
             THEN COALESCE(failed_at, now())
           ELSE failed_at
         END,
         metadata = metadata || $3::jsonb
     WHERE id = $1 AND status IN ('initiated', 'pending')
     RETURNING ${ALL_COLUMNS}`,
    [
      id,
      status,
      JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
    ]
  );
  return rows[0] || null;
}

async function updateProviderResult(
  id,
  { providerTransactionId = null, providerSessionKey = null, status = null }
) {
  const { rows } = await query(
    `UPDATE payment_transactions
     SET provider_transaction_id = COALESCE($2, provider_transaction_id),
         provider_session_key = COALESCE($3, provider_session_key),
         status = COALESCE($4, status)
     WHERE id = $1
     RETURNING ${ALL_COLUMNS}`,
    [id, providerTransactionId, providerSessionKey, status]
  );
  return rows[0] || null;
}

module.exports = {
  SAFE_COLUMNS,
  ALL_COLUMNS,
  create,
  findByUserWithOrder,
  findByIdForUserWithOrder,
  countByUser,
  findById,
  findByIdForUpdate,
  findPendingManualForOrder,
  findPendingGatewayForOrder,
  findLatestManualForOrder,
  findByProviderTransactionId,
  findByTransactionIdAnywhere,
  markSuccessful,
  markTerminal,
  updateProviderResult,
};
