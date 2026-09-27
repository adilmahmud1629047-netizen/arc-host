const crypto = require('crypto');
const config = require('../config');
const { getClient } = require('../config/database');
const orderModel = require('../models/orderModel');
const planService = require('./planService');

const PRODUCT_TYPES = ['hosting', 'vps'];
const NEW_ORDER_STATUS = 'awaiting_payment';
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 10;
const MAX_ORDER_RETRIES = 3;

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 100;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class OrderError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isValidProductType(value) {
  return PRODUCT_TYPES.includes(value);
}

function isValidSlug(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(value)
  );
}

function isValidIdempotencyKey(value) {
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value);
}

function isValidOrderId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function generateOrderNumber(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const random = crypto.randomBytes(6).toString('hex').toUpperCase().slice(0, 6);
  return `FLR-${y}${m}${d}-${random}`;
}

function mapOrderRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderNumber: row.order_number,
    productType: row.product_type,
    plan:
      row.product_id && (row.plan_name !== undefined)
        ? {
            id: row.product_id,
            name: row.plan_name,
            slug: row.plan_slug,
          }
        : { id: row.product_id, name: null, slug: null },
    amount: String(row.amount),
    currency: row.currency,
    billingCycle: row.billing_cycle,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function fetchActivePlan(client, productType, planSlug) {
  const table = productType === 'hosting' ? 'hosting_plans' : 'vps_plans';
  const { rows } = await client.query(
    `SELECT id, name, slug, price::text AS price, currency, billing_cycle, status
     FROM ${table}
     WHERE slug = $1 AND status = 'active'`,
    [planSlug]
  );
  return rows[0] || null;
}

async function createOrder(userId, { productType, planSlug }, { idempotencyKey } = {}) {
  if (!isValidProductType(productType)) {
    throw new OrderError(400, 'VALIDATION_ERROR', 'Invalid request.', [
      'productType must be "hosting" or "vps".',
    ]);
  }
  if (!isValidSlug(planSlug)) {
    throw new OrderError(400, 'VALIDATION_ERROR', 'Invalid request.', [
      'planSlug must be a lowercase letters, digits, and hyphens slug.',
    ]);
  }

  if (idempotencyKey !== undefined && idempotencyKey !== null && idempotencyKey !== '') {
    if (!isValidIdempotencyKey(idempotencyKey)) {
      throw new OrderError(400, 'VALIDATION_ERROR', 'Invalid request.', [
        'Idempotency-Key header is invalid.',
      ]);
    }
  } else {
    idempotencyKey = null;
  }

  if (idempotencyKey) {
    const existing = await orderModel.findByIdempotencyKeyWithPlan(
      userId,
      idempotencyKey
    );
    if (existing) {
      return { order: mapOrderRow(existing), reused: true };
    }
  }

  let lastUniqueError = null;

  for (let attempt = 0; attempt < MAX_ORDER_RETRIES; attempt += 1) {
    const client = await getClient();
    let committed = false;
    try {
      await client.query('BEGIN');

      if (idempotencyKey) {
        const { rows: dupRows } = await client.query(
          `SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2`,
          [userId, idempotencyKey]
        );
        if (dupRows.length > 0) {
          committed = false;
          const existing = await orderModel.findByIdempotencyKeyWithPlan(
            userId,
            idempotencyKey
          );
          return { order: mapOrderRow(existing), reused: true };
        }
      }

      const plan = await fetchActivePlan(client, productType, planSlug);
      if (!plan) {
        throw new OrderError(404, 'PLAN_NOT_FOUND', 'Plan not found.');
      }

      const orderNumber = generateOrderNumber();
      let row;
      try {
        row = await orderModel.createWithPlanSnapshot(client, {
          userId,
          orderNumber,
          productType,
          productId: plan.id,
          amount: plan.price,
          currency: plan.currency,
          billingCycle: plan.billing_cycle,
          status: NEW_ORDER_STATUS,
          idempotencyKey,
        });
      } catch (insertErr) {
        if (insertErr && insertErr.code === '23505') {
          lastUniqueError = insertErr;
          throw insertErr; // caught below → rollback → retry
        }
        throw insertErr;
      }

      await client.query('COMMIT');
      committed = true;

      const withPlan = await orderModel.findByIdWithPlanForUser(row.id, userId);
      return { order: mapOrderRow(withPlan || row), reused: false };
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {
          // connection may already be aborted
        }
      }

      if (err instanceof OrderError) throw err;

      const isUnique = err && err.code === '23505';
      if (isUnique) {
        lastUniqueError = err;
        // order_number collision → retry; idempotency collision → check below
        if (err.constraint === 'orders_user_idempotency_key_unique') {
          if (idempotencyKey) {
            const existing = await orderModel.findByIdempotencyKeyWithPlan(
              userId,
              idempotencyKey
            );
            if (existing) {
              return { order: mapOrderRow(existing), reused: true };
            }
          }
          throw new OrderError(500, 'INTERNAL_ERROR', 'Unable to create order.');
        }
        continue; // retry with a new order number
      }

      throw err;
    } finally {
      client.release();
    }
  }

  if (
    lastUniqueError &&
    lastUniqueError.constraint === 'orders_user_idempotency_key_unique' &&
    idempotencyKey
  ) {
    const existing = await orderModel.findByIdempotencyKeyWithPlan(
      userId,
      idempotencyKey
    );
    if (existing) {
      return { order: mapOrderRow(existing), reused: true };
    }
  }

  throw new OrderError(500, 'INTERNAL_ERROR', 'Unable to create order.');
}

async function listOrders(userId, { page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  const pageNum = Math.max(1, Math.floor(Number(page) || 1));
  const limitNum = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(limit) || DEFAULT_PAGE_SIZE))
  );
  const offset = (pageNum - 1) * limitNum;

  const [rows, total] = await Promise.all([
    orderModel.findByUserWithPlan(userId, { limit: limitNum, offset }),
    orderModel.countByUser(userId),
  ]);

  return {
    orders: rows.map(mapOrderRow),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
    },
  };
}

async function getOrder(userId, orderId) {
  if (!isValidOrderId(orderId)) {
    throw new OrderError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }
  const row = await orderModel.findByIdWithPlanForUser(orderId, userId);
  if (!row) {
    // same 404 whether missing or owned by another user
    throw new OrderError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }
  return mapOrderRow(row);
}

// Read-only bKash "Send Money" instructions for one order. Every value comes
// from server config or the persisted order row — request input is never
// consulted. Creates no payment row and never changes order status.
async function getBkashInstructions(userId, orderId) {
  if (!config.payments.bkash.enabled) {
    throw new OrderError(
      503,
      'PAYMENT_PROVIDER_NOT_CONFIGURED',
      'Payment processing is not available yet.'
    );
  }

  if (!isValidOrderId(orderId)) {
    throw new OrderError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }
  const row = await orderModel.findByIdWithPlanForUser(orderId, userId);
  if (!row) {
    // same 404 whether missing or owned by another user
    throw new OrderError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  if (row.status !== NEW_ORDER_STATUS) {
    throw new OrderError(
      409,
      'ORDER_NOT_AWAITING',
      'Payment instructions are not available for this order.'
    );
  }

  const receiverNumber = (config.payments.bkash.receiverNumber || '').trim();
  if (!receiverNumber) {
    throw new OrderError(
      503,
      'BKASH_PAYMENT_NOT_CONFIGURED',
      'bKash payment is not available yet.'
    );
  }

  return {
    receiverNumber,
    amount: String(row.amount),
    currency: row.currency,
    orderNumber: row.order_number,
  };
}

module.exports = {
  OrderError,
  PRODUCT_TYPES,
  NEW_ORDER_STATUS,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  isValidProductType,
  isValidSlug,
  isValidIdempotencyKey,
  isValidOrderId,
  generateOrderNumber,
  mapOrderRow,
  createOrder,
  listOrders,
  getOrder,
  getBkashInstructions,
  planService,
};
