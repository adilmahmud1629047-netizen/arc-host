const { query } = require('../config/database');

const ORDER_STATUSES = Object.freeze([
  'pending',
  'awaiting_payment',
  'paid',
  'cancelled',
  'refunded',
  'failed',
]);

const PRODUCT_TYPES = Object.freeze(['hosting', 'vps']);

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MAX_SEARCH = 100;

// Deterministic ordering: newest first, id as tie-breaker.
const LIST_ORDER_BY = 'o.created_at DESC, o.id DESC';

function isValidUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Admin order list: joins user + plan once per row (no N+1).
async function listOrders({
  page = 1,
  limit = DEFAULT_LIMIT,
  status = null,
  productType = null,
  search = null,
} = {}) {
  const conditions = [];
  const params = [];
  let i = 1;

  if (status) {
    conditions.push(`o.status = $${i++}`);
    params.push(status);
  }
  if (productType) {
    conditions.push(`o.product_type = $${i++}`);
    params.push(productType);
  }
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(
      `(o.order_number ILIKE $${i} OR u.email ILIKE $${i})`
    );
    params.push(pattern);
    i += 1;
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const countSql = `
    SELECT COUNT(*)::int AS n
    FROM orders o
    JOIN users u ON u.id = o.user_id
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
      o.id,
      o.order_number,
      o.user_id,
      u.email AS customer_email,
      u.first_name AS customer_first_name,
      u.last_name AS customer_last_name,
      o.product_type,
      o.product_id,
      CASE o.product_type
        WHEN 'hosting' THEN hp.name
        WHEN 'vps' THEN vp.name
      END AS plan_name,
      CASE o.product_type
        WHEN 'hosting' THEN hp.slug
        WHEN 'vps' THEN vp.slug
      END AS plan_slug,
      o.amount::text AS amount,
      o.currency,
      o.billing_cycle,
      o.status,
      o.created_at,
      o.updated_at
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN hosting_plans hp ON o.product_type = 'hosting' AND hp.id = o.product_id
    LEFT JOIN vps_plans vp ON o.product_type = 'vps' AND vp.id = o.product_id
    ${where}
    ORDER BY ${LIST_ORDER_BY}
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const listResult = await query(listSql, listParams);

  return {
    orders: listResult.rows.map(mapListRow),
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
  return {
    id: row.id,
    orderNumber: row.order_number,
    customer: {
      id: row.user_id,
      email: row.customer_email,
      firstName: row.customer_first_name,
      lastName: row.customer_last_name,
    },
    productType: row.product_type,
    plan: {
      id: row.product_id,
      name: row.plan_name,
      slug: row.plan_slug,
    },
    amount: row.amount,
    currency: row.currency,
    billingCycle: row.billing_cycle,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Safe payment projection — never metadata, credentials, or raw payloads.
// verification_source is the one provenance string extracted from metadata
// (the raw object stays in the database).
const ADMIN_PAYMENT_COLUMNS = `
  p.id,
  p.provider,
  p.provider_transaction_id,
  p.status,
  p.amount::text AS amount,
  p.currency,
  p.payment_method,
  p.metadata->>'verification_source' AS verification_source,
  p.created_at,
  p.updated_at
`;

async function findOrderDetail(id) {
  if (!isValidUuid(id)) return null;

  const orderResult = await query(
    `SELECT
      o.id,
      o.order_number,
      o.user_id,
      u.email AS customer_email,
      u.first_name AS customer_first_name,
      u.last_name AS customer_last_name,
      u.status AS customer_status,
      u.role AS customer_role,
      o.product_type,
      o.product_id,
      CASE o.product_type
        WHEN 'hosting' THEN hp.name
        WHEN 'vps' THEN vp.name
      END AS plan_name,
      CASE o.product_type
        WHEN 'hosting' THEN hp.slug
        WHEN 'vps' THEN vp.slug
      END AS plan_slug,
      o.amount::text AS amount,
      o.currency,
      o.billing_cycle,
      o.status,
      o.created_at,
      o.updated_at
     FROM orders o
     JOIN users u ON u.id = o.user_id
     LEFT JOIN hosting_plans hp ON o.product_type = 'hosting' AND hp.id = o.product_id
     LEFT JOIN vps_plans vp ON o.product_type = 'vps' AND vp.id = o.product_id
     WHERE o.id = $1`,
    [id]
  );

  const orderRow = orderResult.rows[0];
  if (!orderRow) return null;

  const [paymentsResult, serviceResult] = await Promise.all([
    query(
      `SELECT ${ADMIN_PAYMENT_COLUMNS}
       FROM payment_transactions p
       WHERE p.order_id = $1
       ORDER BY p.created_at DESC, p.id DESC`,
      [id]
    ),
    query(
      `SELECT
        si.id,
        si.service_type,
        si.status,
        si.hostname,
        si.created_at,
        si.updated_at
       FROM service_instances si
       WHERE si.order_id = $1
       ORDER BY si.created_at DESC
       LIMIT 1`,
      [id]
    ),
  ]);

  return {
    order: {
      id: orderRow.id,
      orderNumber: orderRow.order_number,
      productType: orderRow.product_type,
      plan: {
        id: orderRow.product_id,
        name: orderRow.plan_name,
        slug: orderRow.plan_slug,
      },
      amount: orderRow.amount,
      currency: orderRow.currency,
      billingCycle: orderRow.billing_cycle,
      status: orderRow.status,
      createdAt: orderRow.created_at,
      updatedAt: orderRow.updated_at,
    },
    customer: {
      id: orderRow.user_id,
      email: orderRow.customer_email,
      firstName: orderRow.customer_first_name,
      lastName: orderRow.customer_last_name,
      status: orderRow.customer_status,
      role: orderRow.customer_role,
    },
    payments: paymentsResult.rows.map((p) => ({
      id: p.id,
      provider: p.provider,
      providerTransactionId: p.provider_transaction_id,
      status: p.status,
      amount: p.amount,
      currency: p.currency,
      paymentMethod: p.payment_method,
      verificationSource: p.verification_source || null,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    })),
    service: serviceResult.rows[0]
      ? {
          id: serviceResult.rows[0].id,
          serviceType: serviceResult.rows[0].service_type,
          status: serviceResult.rows[0].status,
          hostname: serviceResult.rows[0].hostname,
          createdAt: serviceResult.rows[0].created_at,
          updatedAt: serviceResult.rows[0].updated_at,
        }
      : null,
  };
}

module.exports = {
  ORDER_STATUSES,
  PRODUCT_TYPES,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  MAX_SEARCH,
  isValidUuid,
  listOrders,
  findOrderDetail,
};
