const { query } = require('../config/database');

const USER_STATUSES = Object.freeze(['active', 'suspended', 'pending']);

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MAX_SEARCH = 100;
const RECENT_ORDERS_LIMIT = 10;
const RECENT_SERVICES_LIMIT = 10;

// Deterministic ordering: newest first, id as tie-breaker.
const LIST_ORDER_BY = 'u.created_at DESC, u.id DESC';

function isValidUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Safe projection for list rows — never password_hash, sessions, or secrets.
const CUSTOMER_LIST_COLUMNS = `
  u.id,
  u.email,
  u.first_name,
  u.last_name,
  u.role,
  u.status,
  u.created_at,
  u.updated_at,
  COALESCE(oc.n, 0)::int AS order_count,
  COALESCE(sc.n, 0)::int AS service_count,
  lo.latest AS latest_order_at
`;

// Admin customer list: counts via scalar subqueries (no N+1).
async function listCustomers({
  page = 1,
  limit = DEFAULT_LIMIT,
  search = null,
  status = null,
} = {}) {
  const conditions = [];
  const params = [];
  let i = 1;

  if (status) {
    conditions.push(`u.status = $${i++}`);
    params.push(status);
  }
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    const nameExpr = `TRIM(CONCAT_WS(' ', u.first_name, u.last_name))`;
    conditions.push(
      `(u.email ILIKE $${i} OR ${nameExpr} ILIKE $${i} OR u.id::text ILIKE $${i})`
    );
    params.push(pattern);
    i += 1;
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const countSql = `
    SELECT COUNT(*)::int AS n
    FROM users u
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
      ${CUSTOMER_LIST_COLUMNS}
    FROM users u
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n FROM orders o WHERE o.user_id = u.id
    ) oc ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n FROM service_instances si WHERE si.user_id = u.id
    ) sc ON TRUE
    LEFT JOIN LATERAL (
      SELECT MAX(o.created_at) AS latest FROM orders o WHERE o.user_id = u.id
    ) lo ON TRUE
    ${where}
    ORDER BY ${LIST_ORDER_BY}
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const listResult = await query(listSql, listParams);

  return {
    customers: listResult.rows.map(mapListRow),
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
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orderCount: row.order_count,
    serviceCount: row.service_count,
    latestOrderAt: row.latest_order_at || null,
  };
}

async function findCustomerDetail(id) {
  if (!isValidUuid(id)) return null;

  const customerResult = await query(
    `SELECT
      u.id,
      u.email,
      u.first_name,
      u.last_name,
      u.role,
      u.status,
      u.created_at,
      u.updated_at
     FROM users u
     WHERE u.id = $1`,
    [id]
  );

  const row = customerResult.rows[0];
  if (!row) return null;

  const [summaryResult, ordersResult, servicesResult] = await Promise.all([
    query(
      `SELECT
        (SELECT COUNT(*)::int FROM orders o WHERE o.user_id = $1) AS orders,
        (SELECT COUNT(*)::int FROM orders o WHERE o.user_id = $1 AND o.status = 'paid') AS paid_orders,
        (SELECT COUNT(*)::int FROM service_instances si WHERE si.user_id = $1) AS services`,
      [id]
    ),
    query(
      `SELECT
        o.id,
        o.order_number,
        o.product_type,
        CASE o.product_type
          WHEN 'hosting' THEN hp.name
          WHEN 'vps' THEN vp.name
        END AS plan_name,
        o.amount::text AS amount,
        o.currency,
        o.status,
        o.created_at
       FROM orders o
       LEFT JOIN hosting_plans hp ON o.product_type = 'hosting' AND hp.id = o.product_id
       LEFT JOIN vps_plans vp ON o.product_type = 'vps' AND vp.id = o.product_id
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $2`,
      [id, RECENT_ORDERS_LIMIT]
    ),
    query(
      `SELECT
        si.id,
        si.service_type,
        CASE
          WHEN si.hosting_plan_id IS NOT NULL THEN hp.name
          WHEN si.vps_plan_id IS NOT NULL THEN vp.name
        END AS plan_name,
        si.status,
        si.created_at,
        si.updated_at
       FROM service_instances si
       LEFT JOIN hosting_plans hp ON si.hosting_plan_id = hp.id
       LEFT JOIN vps_plans vp ON si.vps_plan_id = vp.id
       WHERE si.user_id = $1
       ORDER BY si.created_at DESC, si.id DESC
       LIMIT $2`,
      [id, RECENT_SERVICES_LIMIT]
    ),
  ]);

  const summaryRow = summaryResult.rows[0] || {};

  return {
    customer: {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
      role: row.role,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    summary: {
      orders: summaryRow.orders || 0,
      paidOrders: summaryRow.paid_orders || 0,
      services: summaryRow.services || 0,
    },
    recentOrders: ordersResult.rows.map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      productType: o.product_type,
      planName: o.plan_name,
      amount: o.amount,
      currency: o.currency,
      status: o.status,
      createdAt: o.created_at,
    })),
    services: servicesResult.rows.map((s) => ({
      id: s.id,
      serviceType: s.service_type,
      planName: s.plan_name || null,
      status: s.status,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    })),
  };
}

// Shared safe projection for the account-control endpoints — the same
// public columns the detail view returns, never password_hash or sessions.
const SAFE_USER_RETURNING = `
  id, email, first_name, last_name, role, status, created_at, updated_at
`;

function mapSafeUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// One user row for the account controls (status/role guards before acting).
async function findCustomerProfile(id) {
  if (!isValidUuid(id)) return null;
  const { rows } = await query(
    `SELECT ${SAFE_USER_RETURNING}
     FROM users u
     WHERE u.id = $1`,
    [id]
  );
  return rows[0] ? mapSafeUserRow(rows[0]) : null;
}

// Suspend/reactivate: status transition only — never deletes the user row.
async function setCustomerStatus(id, status) {
  if (!isValidUuid(id) || !USER_STATUSES.includes(status)) return null;
  const { rows } = await query(
    `UPDATE users
     SET status = $2, updated_at = now()
     WHERE id = $1
     RETURNING ${SAFE_USER_RETURNING}`,
    [id, status]
  );
  return rows[0] ? mapSafeUserRow(rows[0]) : null;
}

// Password reset: replaces the hash only. The caller passes an already
// hashed Argon2id value — plaintext never reaches this layer.
async function updatePasswordHash(id, passwordHash) {
  if (!isValidUuid(id) || typeof passwordHash !== 'string') return null;
  const { rows } = await query(
    `UPDATE users
     SET password_hash = $2, updated_at = now()
     WHERE id = $1
     RETURNING ${SAFE_USER_RETURNING}`,
    [id, passwordHash]
  );
  return rows[0] ? mapSafeUserRow(rows[0]) : null;
}

// Last-admin guard: how many OTHER active administrators exist.
async function countActiveAdminsExcept(excludeUserId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n
     FROM users
     WHERE role = 'admin' AND status = 'active' AND id <> $1`,
    [excludeUserId]
  );
  return rows[0] ? rows[0].n : 0;
}

function buildPagination(page, limit, total, rowCount, offset) {
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasNext: offset + rowCount < total,
    hasPrev: page > 1,
  };
}

// Full order history for one customer (paginated). `paymentStatus` is the
// customer's most recent payment attempt for that order, if any.
async function findCustomerOrders(
  id,
  { page = 1, limit = DEFAULT_LIMIT, status = null, search = null } = {}
) {
  if (!isValidUuid(id)) return null;

  const conditions = ['o.user_id = $1'];
  const params = [id];
  let i = 2;
  if (status) {
    conditions.push(`o.status = $${i++}`);
    params.push(status);
  }
  if (search) {
    conditions.push(`o.order_number ILIKE $${i}`);
    params.push(`%${escapeLike(search)}%`);
    i += 1;
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const countResult = await query(
    `SELECT COUNT(*)::int AS n FROM orders o ${where}`,
    params
  );
  const total = countResult.rows[0] ? countResult.rows[0].n : 0;

  const offset = (page - 1) * limit;
  const listParams = [...params, limit, offset];
  const listSql = `
    SELECT
      o.id,
      o.order_number,
      o.product_type,
      CASE o.product_type
        WHEN 'hosting' THEN hp.name
        WHEN 'vps' THEN vp.name
      END AS plan_name,
      o.amount::text AS amount,
      o.currency,
      o.status,
      o.created_at,
      o.updated_at,
      lp.status AS payment_status
    FROM orders o
    LEFT JOIN hosting_plans hp ON o.product_type = 'hosting' AND hp.id = o.product_id
    LEFT JOIN vps_plans vp ON o.product_type = 'vps' AND vp.id = o.product_id
    LEFT JOIN LATERAL (
      SELECT p.status
      FROM payment_transactions p
      WHERE p.order_id = o.id
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 1
    ) lp ON TRUE
    ${where}
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
  `;
  const listResult = await query(listSql, listParams);

  return {
    orders: listResult.rows.map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      productType: o.product_type,
      planName: o.plan_name,
      amount: o.amount,
      currency: o.currency,
      status: o.status,
      paymentStatus: o.payment_status || null,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    })),
    pagination: buildPagination(page, limit, total, listResult.rows.length, offset),
  };
}

// Manual rows keep the review aliases (awaiting_verification/verified/
// rejected) exactly like the admin payments list; gateway rows keep their
// raw status. verificationSource is a single extracted string — the raw
// metadata object is never returned.
const MANUAL_STATUS_ALIASES = Object.freeze({
  pending: 'awaiting_verification',
  successful: 'verified',
  failed: 'rejected',
});

async function findCustomerPayments(id, { page = 1, limit = DEFAULT_LIMIT } = {}) {
  if (!isValidUuid(id)) return null;

  const params = [id];
  const where = 'WHERE p.user_id = $1';

  const countResult = await query(
    `SELECT COUNT(*)::int AS n FROM payment_transactions p ${where}`,
    params
  );
  const total = countResult.rows[0] ? countResult.rows[0].n : 0;

  const offset = (page - 1) * limit;
  const listParams = [...params, limit, offset];
  const listSql = `
    SELECT
      p.id,
      p.order_id,
      o.order_number,
      p.provider,
      p.provider_transaction_id,
      p.bank_transaction_id,
      p.payment_method,
      p.amount::text AS amount,
      p.currency,
      p.status,
      p.created_at,
      p.updated_at,
      p.metadata->>'verification_source' AS verification_source
    FROM payment_transactions p
    JOIN orders o ON o.id = p.order_id
    ${where}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
  `;
  const listResult = await query(listSql, listParams);

  return {
    payments: listResult.rows.map((p) => ({
      id: p.id,
      orderId: p.order_id,
      orderNumber: p.order_number,
      provider: p.provider,
      reference: p.provider_transaction_id || p.bank_transaction_id || null,
      invoiceId:
        p.provider === 'uddoktapay' ? p.provider_transaction_id || null : null,
      paymentMethod: p.payment_method,
      amount: p.amount,
      currency: p.currency,
      status:
        p.provider === 'manual'
          ? MANUAL_STATUS_ALIASES[p.status] || p.status
          : p.status,
      rawStatus: p.status,
      verificationSource: p.verification_source || null,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    })),
    pagination: buildPagination(page, limit, total, listResult.rows.length, offset),
  };
}

module.exports = {
  USER_STATUSES,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  MAX_SEARCH,
  RECENT_ORDERS_LIMIT,
  RECENT_SERVICES_LIMIT,
  isValidUuid,
  listCustomers,
  findCustomerDetail,
  findCustomerProfile,
  setCustomerStatus,
  updatePasswordHash,
  countActiveAdminsExcept,
  findCustomerOrders,
  findCustomerPayments,
};
