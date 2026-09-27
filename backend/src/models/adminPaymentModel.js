const { query } = require('../config/database');

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

// Admin-facing filter values → stored payment status. Only provider='manual'
// rows are ever listed by the legacy (no `provider` param) mode: old
// `disabled`-provider attempts are a different lifecycle and must never be
// reinterpreted as reviewable submissions.
const STATUS_FILTERS = Object.freeze({
  awaiting_verification: 'pending',
  verified: 'successful',
  rejected: 'failed',
});

// Extended mode (explicit `provider` query param) additionally accepts raw
// provider statuses so gateway rows can be filtered by their own lifecycle.
const EXTENDED_STATUSES = Object.freeze([
  'initiated',
  'pending',
  'successful',
  'failed',
  'cancelled',
  'expired',
  'refunded',
]);

// Providers the extended list may filter on. `all` disables the condition.
const PROVIDER_FILTERS = Object.freeze(['all', 'manual', 'uddoktapay', 'sslcommerz', 'disabled']);

const UI_STATUS_BY_DB = Object.freeze({
  pending: 'awaiting_verification',
  successful: 'verified',
  failed: 'rejected',
});

// Deterministic ordering: newest first, id as tie-breaker.
const LIST_ORDER_BY = 'p.created_at DESC, p.id DESC';

function isValidUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function uiStatus(status) {
  return UI_STATUS_BY_DB[status] || status;
}

// A status filter value is valid when it is a legacy review alias or a raw
// provider status. Returns the raw stored status, or null when invalid.
// (`paid` is never a payment status and is rejected in both modes.)
function normalizeStatusFilter(value) {
  if (typeof value !== 'string' || !value) return null;
  if (STATUS_FILTERS[value]) return STATUS_FILTERS[value];
  if (EXTENDED_STATUSES.includes(value)) return value;
  return null;
}

function validStatusFilterValues() {
  return [...Object.keys(STATUS_FILTERS), ...EXTENDED_STATUSES];
}

// Which review actions a row can accept right now — the same eligibility
// rules the endpoints enforce server-side (the UI never decides).
function availableActions(row) {
  const actions = [];
  if (row.provider === 'manual') {
    if (row.status === 'pending') actions.push('verify', 'reject');
    return actions;
  }
  const open = row.status === 'initiated' || row.status === 'pending';
  if (row.provider === 'uddoktapay' && open && row.provider_transaction_id) {
    actions.push('verify-uddoktapay');
  }
  // Same rules the endpoint enforces: every non-successful state except a
  // refunded attempt (money already returned) can still be settled manually.
  if (row.status !== 'successful' && row.status !== 'refunded') {
    actions.push('manual-verify');
  }
  return actions;
}

// Admin payment list. `provider === null` keeps the legacy behaviour exactly
// (manual rows only); an explicit provider ('all' or one name) opens the
// extended view with provider/order/customer/transaction filters.
async function listPayments({
  page = 1,
  limit = DEFAULT_LIMIT,
  status = null,
  provider = null,
  order = null,
  customer = null,
  transaction = null,
} = {}) {
  const conditions = [];
  const params = [];
  let i = 1;

  if (provider === null) {
    conditions.push(`p.provider = 'manual'`);
  } else if (provider !== 'all') {
    conditions.push(`p.provider = $${i++}`);
    params.push(provider);
  }

  if (status) {
    conditions.push(`p.status = $${i++}`);
    params.push(status);
  }

  if (order) {
    conditions.push(
      `(o.order_number ILIKE '%' || $${i} || '%' OR o.id::text = $${i})`
    );
    params.push(order);
    i++;
  }

  if (customer) {
    conditions.push(
      `(u.email ILIKE '%' || $${i} || '%'
        OR u.first_name ILIKE '%' || $${i} || '%'
        OR u.last_name ILIKE '%' || $${i} || '%')`
    );
    params.push(customer);
    i++;
  }

  if (transaction) {
    conditions.push(
      `(UPPER(p.provider_transaction_id) LIKE UPPER('%' || $${i} || '%')
        OR UPPER(p.bank_transaction_id) LIKE UPPER('%' || $${i} || '%'))`
    );
    params.push(transaction);
    i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countSql = `
    SELECT COUNT(*)::int AS n
    FROM payment_transactions p
    JOIN orders o ON o.id = p.order_id
    JOIN users u ON u.id = p.user_id
    ${where}
  `;
  const countResult = await query(countSql, params);
  const total = countResult.rows[0] ? countResult.rows[0].n : 0;

  const offset = (page - 1) * limit;
  const listParams = [...params, limit, offset];
  const limitIdx = listParams.length - 1;
  const offsetIdx = listParams.length;

  const listSql = `
    SELECT
      p.id,
      p.order_id,
      o.order_number,
      p.user_id,
      u.email AS customer_email,
      u.first_name AS customer_first_name,
      u.last_name AS customer_last_name,
      p.provider,
      p.provider_transaction_id,
      p.bank_transaction_id,
      p.payment_method,
      p.amount::text AS amount,
      p.currency,
      p.status,
      p.paid_at,
      p.failed_at,
      p.created_at,
      p.updated_at
    FROM payment_transactions p
    JOIN orders o ON o.id = p.order_id
    JOIN users u ON u.id = p.user_id
    ${where}
    ORDER BY ${LIST_ORDER_BY}
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const listResult = await query(listSql, listParams);

  return {
    payments: listResult.rows.map(mapListRow),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: offset + listResult.rows.length < total,
      hasPrev: page > 1,
    },
  };
}

function mapListRow(row) {
  const manual = row.provider === 'manual';
  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    customer: {
      id: row.user_id,
      email: row.customer_email,
      firstName: row.customer_first_name,
      lastName: row.customer_last_name,
    },
    provider: row.provider,
    transactionId: row.provider_transaction_id,
    bankTransactionId: row.bank_transaction_id || null,
    reference: row.provider_transaction_id || row.bank_transaction_id || null,
    paymentMethod: row.payment_method,
    amount: row.amount,
    currency: row.currency,
    // manual rows keep the review aliases; gateway rows keep raw status
    status: manual ? uiStatus(row.status) : row.status,
    rawStatus: row.status,
    submittedAt: row.created_at,
    resolvedAt: row.paid_at || row.failed_at || null,
    updatedAt: row.updated_at,
    availableActions: availableActions(row),
  };
}

// One payment with its order + customer and the audit provenance recorded
// on the row — everything the admin detail panel needs, nothing else
// (no session keys, no raw metadata dump).
async function getPaymentDetail(id) {
  if (!isValidUuid(id)) return null;
  const { rows } = await query(
    `SELECT
      p.id,
      p.order_id,
      o.order_number,
      o.status AS order_status,
      o.amount::text AS order_amount,
      o.currency AS order_currency,
      o.product_type AS order_product_type,
      p.user_id,
      u.email AS customer_email,
      u.first_name AS customer_first_name,
      u.last_name AS customer_last_name,
      p.provider,
      p.provider_transaction_id,
      p.bank_transaction_id,
      p.payment_method,
      p.amount::text AS amount,
      p.currency,
      p.status,
      p.metadata,
      p.initiated_at,
      p.paid_at,
      p.failed_at,
      p.created_at,
      p.updated_at
    FROM payment_transactions p
    JOIN orders o ON o.id = p.order_id
    JOIN users u ON u.id = p.user_id
    WHERE p.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;
  return mapDetailRow(row);
}

function mapDetailRow(row) {
  const manual = row.provider === 'manual';
  const meta =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    order: {
      status: row.order_status,
      amount: row.order_amount,
      currency: row.order_currency,
      productType: row.order_product_type,
    },
    customer: {
      id: row.user_id,
      email: row.customer_email,
      firstName: row.customer_first_name,
      lastName: row.customer_last_name,
    },
    provider: row.provider,
    amount: row.amount,
    currency: row.currency,
    status: manual ? uiStatus(row.status) : row.status,
    rawStatus: row.status,
    paymentMethod: row.payment_method,
    transactionId: row.provider_transaction_id,
    invoiceId:
      row.provider === 'uddoktapay' ? row.provider_transaction_id : null,
    manualReference: manual ? row.provider_transaction_id : null,
    gatewayReference: row.bank_transaction_id || null,
    provenance: {
      source: meta.verification_source || null,
      verifiedBy: meta.verified_by || null,
      verifiedAt: meta.verified_at || null,
      rejectedBy: meta.rejected_by || null,
      rejectedAt: meta.rejected_at || null,
      rejectionReason: meta.rejection_reason || null,
      note: meta.verification_note || null,
    },
    initiatedAt: row.initiated_at,
    paidAt: row.paid_at,
    failedAt: row.failed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    availableActions: availableActions(row),
  };
}

module.exports = {
  MAX_LIMIT,
  DEFAULT_LIMIT,
  STATUS_FILTERS,
  EXTENDED_STATUSES,
  PROVIDER_FILTERS,
  isValidUuid,
  uiStatus,
  normalizeStatusFilter,
  validStatusFilterValues,
  availableActions,
  listPayments,
  getPaymentDetail,
};
