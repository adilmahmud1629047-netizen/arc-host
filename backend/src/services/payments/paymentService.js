const config = require('../../config');
const { getClient } = require('../../config/database');
const paymentModel = require('../../models/paymentModel');
const orderModel = require('../../models/orderModel');
const userModel = require('../../models/userModel');
const { getProvider, PaymentProviderError } = require('./paymentProvider');

const AWAITING_PAYMENT = 'awaiting_payment';
const INITIATED = 'initiated';
// A pending gateway session older than this is expired for reuse purposes:
// retries get a fresh gateway session instead of a possibly dead URL.
const GATEWAY_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 10;
const PROVIDER_RESULT_STATUSES = [
  'initiated',
  'pending',
  'successful',
  'failed',
  'cancelled',
  'expired',
  'refunded',
];

// Manual payment verification (transaction id submitted by the customer,
// reviewed by an admin). `manual` is the only provider this flow writes.
const MANUAL_PROVIDER = 'manual';
// 4–64 chars: starts alphanumeric, then letters/digits/"-"/"_" only.
const MANUAL_TRX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const MANUAL_METHOD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 &_-]{2,29}$/;
const MANUAL_MAX_REASON = 200;
// Stored status → what the customer/admin UI shows. Stored values never change.
const MANUAL_UI_STATUS = Object.freeze({
  pending: 'awaiting_verification',
  successful: 'verified',
  failed: 'rejected',
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PaymentError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isValidId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function manualUiStatus(status) {
  return MANUAL_UI_STATUS[status] || status;
}

// Trim + case-normalize the customer's Transaction ID. Never invents or
// formats a value — only what the customer typed.
function normalizeTransactionId(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!MANUAL_TRX_PATTERN.test(trimmed)) {
    throw new PaymentError(400, 'VALIDATION_ERROR', 'Invalid request.', [
      'Transaction ID must be 4 to 64 characters (letters, numbers, "-" or "_").',
    ]);
  }
  return trimmed.toUpperCase();
}

function normalizePaymentMethod(value) {
  if (value === undefined || value === null || value === '') return null;
  const trimmed = String(value).trim();
  if (!MANUAL_METHOD_PATTERN.test(trimmed)) {
    throw new PaymentError(400, 'VALIDATION_ERROR', 'Invalid request.', [
      'Payment method must be 3 to 30 characters.',
    ]);
  }
  return trimmed;
}

// Unique violations the payment flow can hit (all guaranteed by indexes):
//   * one pending manual submission per order  → PAYMENT_SUBMISSION_EXISTS
//   * one successful payment per order         → ORDER_ALREADY_PAID
//   * one row per (provider, transaction id)   → DUPLICATE_TRANSACTION_ID
function mapUniqueViolation(err) {
  if (!err || err.code !== '23505') return null;
  const where = [err.constraint, err.index, err.message]
    .filter(Boolean)
    .join(' ');
  if (where.includes('manual_pending_order')) {
    return new PaymentError(
      409,
      'PAYMENT_SUBMISSION_EXISTS',
      'A Transaction ID has already been submitted for this order.'
    );
  }
  if (where.includes('one_success_per_order')) {
    return new PaymentError(
      409,
      'ORDER_ALREADY_PAID',
      'Order has already been paid.'
    );
  }
  return new PaymentError(
    409,
    'DUPLICATE_TRANSACTION_ID',
    'This Transaction ID has already been recorded.'
  );
}

// Drop empty values so metadata stays a clean audit trail.
function cleanMetadata(metadata) {
  const out = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

function mapPaymentRow(row, extra = {}) {
  if (!row) return null;
  const orderNumber =
    row.order_number !== undefined && row.order_number !== null
      ? row.order_number
      : extra.orderNumber || null;
  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber,
    provider: row.provider,
    amount: String(row.amount),
    currency: row.currency,
    status: row.status,
    initiatedAt: row.initiated_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

function moneyMatches(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return Math.round(na * 100) === Math.round(nb * 100);
}

// Customer-facing view of a manual submission (their own row only).
function manualPaymentView(row) {
  if (!row) return null;
  return {
    paymentId: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number || null,
    paymentMethod: row.payment_method,
    transactionId: row.provider_transaction_id,
    status: manualUiStatus(row.status),
    rawStatus: row.status,
    submittedAt: row.created_at,
    resolvedAt: row.paid_at || row.failed_at || null,
  };
}

// Admin-facing view of a gateway payment attempt. Gateway rows keep their
// raw provider status — the manual review aliases never apply to them.
function gatewayPaymentView(row, orderNumber) {
  if (!row) return null;
  return {
    paymentId: row.id,
    orderId: row.order_id,
    orderNumber: orderNumber || row.order_number || null,
    provider: row.provider,
    amount: String(row.amount),
    currency: row.currency,
    status: row.status,
    rawStatus: row.status,
    paymentMethod: row.payment_method,
    transactionId: row.provider_transaction_id,
    invoiceId:
      row.provider === 'uddoktapay' ? row.provider_transaction_id : null,
    initiatedAt: row.initiated_at,
    paidAt: row.paid_at,
    failedAt: row.failed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildMetadataPatch({ riskLevel, riskFlag }) {
  const patch = {};
  if (riskLevel !== undefined && riskLevel !== null && riskLevel !== '') {
    const numeric = Number(riskLevel);
    patch.risk_level = Number.isFinite(numeric)
      ? numeric
      : String(riskLevel).slice(0, 50);
  }
  if (riskFlag !== undefined && riskFlag !== null && riskFlag !== '') {
    patch.risk_flag = String(riskFlag).slice(0, 50);
  }
  return patch;
}

async function createPayment(userId, orderId) {
  if (!isValidId(orderId)) {
    throw new PaymentError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  const orderRow = await orderModel.findByIdForUser(orderId, userId);
  if (!orderRow) {
    // identical response whether missing or owned by someone else
    throw new PaymentError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  if (orderRow.status !== AWAITING_PAYMENT) {
    throw new PaymentError(
      409,
      'ORDER_NOT_PAYABLE',
      'Order is not awaiting payment.'
    );
  }

  const provider = getProvider(config.payments.provider);
  if (!provider) {
    throw new PaymentError(
      503,
      'PAYMENT_PROVIDER_NOT_CONFIGURED',
      'Payment processing is not available yet.'
    );
  }

  // One open gateway session per order: a retry (double-click, refresh,
  // failed redirect) reuses the pending attempt and its stored gateway URL
  // instead of opening a second session. Attempts that never reached the
  // provider (`initiated`) and manual submissions are never reused. A
  // pending session older than GATEWAY_SESSION_TTL_MS is treated as expired:
  // the stale row is closed and a fresh session is opened so a later retry
  // is never handed a dead payment URL.
  if (typeof provider.reusePaymentSession === 'function') {
    const open = await paymentModel.findPendingGatewayForOrder(
      orderRow.id,
      provider.name
    );
    if (open) {
      const createdAtMs = open.created_at
        ? new Date(open.created_at).getTime()
        : NaN;
      const sessionAgeMs = Number.isFinite(createdAtMs)
        ? Date.now() - createdAtMs
        : 0;
      if (sessionAgeMs < GATEWAY_SESSION_TTL_MS) {
        const reusedSession = provider.reusePaymentSession({ payment: open });
        if (reusedSession && reusedSession.gatewayUrl) {
          return {
            payment: mapPaymentRow(open, {
              orderNumber: orderRow.order_number,
            }),
            gatewayUrl: reusedSession.gatewayUrl,
          };
        }
      } else {
        await paymentModel.markTerminal(open.id, 'expired');
      }
    }
  }

  // Gateway-required customer fields come from the users row (server-side
  // only) — never from the request body.
  const userRow = await userModel.findById(userId);
  const customer = {
    name: userRow
      ? `${userRow.first_name || ''} ${userRow.last_name || ''}`.trim()
      : '',
    email: userRow ? userRow.email : '',
  };

  // Record the attempt first (amount/currency snapshotted from the order
  // row), then ask the provider to start the payment. A provider failure
  // never changes the order and never creates a successful payment.
  const row = await paymentModel.create({
    orderId: orderRow.id,
    userId,
    provider: provider.name,
    amount: orderRow.amount,
    currency: orderRow.currency,
    status: INITIATED,
  });

  const result = await provider.createPayment({
    payment: mapPaymentRow(row, { orderNumber: orderRow.order_number }),
    order: {
      id: orderRow.id,
      orderNumber: orderRow.order_number,
      amount: String(orderRow.amount),
      currency: orderRow.currency,
      productType: orderRow.product_type,
      billingCycle: orderRow.billing_cycle,
      status: orderRow.status,
    },
    customer,
  });

  if (result && typeof result === 'object') {
    const nextStatus =
      typeof result.status === 'string' &&
      PROVIDER_RESULT_STATUSES.includes(result.status)
        ? result.status
        : INITIATED;
    const updated = await paymentModel.updateProviderResult(row.id, {
      providerTransactionId: result.providerTransactionId || null,
      providerSessionKey: result.providerSessionKey || null,
      status: nextStatus,
    });
    return {
      payment: mapPaymentRow(updated || row, {
        orderNumber: orderRow.order_number,
      }),
      gatewayUrl:
        typeof result.gatewayUrl === 'string' && result.gatewayUrl
          ? result.gatewayUrl
          : null,
    };
  }

  return {
    payment: mapPaymentRow(row, { orderNumber: orderRow.order_number }),
    gatewayUrl: null,
  };
}

async function listPayments(userId, { page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  const pageNum = Math.max(1, Math.floor(Number(page) || 1));
  const limitNum = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(limit) || DEFAULT_PAGE_SIZE))
  );
  const offset = (pageNum - 1) * limitNum;

  const [rows, total] = await Promise.all([
    paymentModel.findByUserWithOrder(userId, { limit: limitNum, offset }),
    paymentModel.countByUser(userId),
  ]);

  return {
    payments: rows.map((row) => mapPaymentRow(row)),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
    },
  };
}

async function getPayment(userId, paymentId) {
  if (!isValidId(paymentId)) {
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  }
  const row = await paymentModel.findByIdForUserWithOrder(paymentId, userId);
  if (!row) {
    // same 404 whether missing or owned by another user
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  }
  return mapPaymentRow(row);
}

// Customer submits a Transaction ID for their own awaiting-payment order.
// Nothing is verified here: the row lands as `pending` (awaiting admin
// review), the order stays `awaiting_payment`, and amount/currency come from
// the order row — never from the request body. No PIN, OTP, password or card
// data is ever accepted or stored.
async function submitManualTransaction(
  userId,
  { orderId, transactionId, paymentMethod = null }
) {
  if (!isValidId(orderId)) {
    throw new PaymentError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  const orderRow = await orderModel.findByIdForUser(orderId, userId);
  if (!orderRow) {
    // identical response whether missing or owned by someone else
    throw new PaymentError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  if (orderRow.status !== AWAITING_PAYMENT) {
    throw new PaymentError(
      409,
      'ORDER_NOT_PAYABLE',
      'Order is not awaiting payment.'
    );
  }

  const normalizedTrx = normalizeTransactionId(transactionId);
  const method = normalizePaymentMethod(paymentMethod);

  const existingPending = await paymentModel.findPendingManualForOrder(
    orderRow.id
  );
  if (existingPending) {
    throw new PaymentError(
      409,
      'PAYMENT_SUBMISSION_EXISTS',
      'A Transaction ID has already been submitted for this order.'
    );
  }

  const existingTrx = await paymentModel.findByProviderTransactionId(
    MANUAL_PROVIDER,
    normalizedTrx
  );
  if (existingTrx) {
    throw new PaymentError(
      409,
      'DUPLICATE_TRANSACTION_ID',
      'This Transaction ID has already been recorded.'
    );
  }

  let row;
  try {
    row = await paymentModel.create({
      orderId: orderRow.id,
      userId,
      provider: MANUAL_PROVIDER,
      amount: orderRow.amount,
      currency: orderRow.currency,
      status: 'pending',
      paymentMethod: method,
      providerTransactionId: normalizedTrx,
    });
  } catch (err) {
    const mapped = mapUniqueViolation(err);
    if (mapped) throw mapped;
    throw err;
  }

  return {
    payment: manualPaymentView({ ...row, order_number: orderRow.order_number }),
    order: {
      id: orderRow.id,
      orderNumber: orderRow.order_number,
      amount: String(orderRow.amount),
      currency: orderRow.currency,
      status: orderRow.status,
    },
  };
}

// Owner-scoped payment state for one order — drives the checkout and
// dashboard "awaiting admin verification" display. Never marks anything paid.
async function getPaymentForOrder(userId, orderId) {
  if (typeof orderId !== 'string' || !UUID_PATTERN.test(orderId)) {
    throw new PaymentError(400, 'VALIDATION_ERROR', 'Invalid request.', [
      'Order id must be a UUID.',
    ]);
  }

  const orderRow = await orderModel.findByIdForUser(orderId, userId);
  if (!orderRow) {
    // identical response whether missing or owned by someone else
    throw new PaymentError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  const paymentRow = await paymentModel.findLatestManualForOrder(
    orderRow.id,
    userId
  );

  return {
    order: {
      id: orderRow.id,
      orderNumber: orderRow.order_number,
      amount: String(orderRow.amount),
      currency: orderRow.currency,
      status: orderRow.status,
    },
    payment: manualPaymentView(paymentRow),
    status: paymentRow ? manualUiStatus(paymentRow.status) : 'none',
  };
}

// Admin verifies a pending manual submission: the ONLY path in this flow that
// marks an order paid. Runs inside the same controlled transaction used by
// provider-verified payments (lock payment → lock order → amount/currency
// check → mark payment successful → mark order paid → COMMIT).
async function adminVerifyPayment(adminId, paymentId) {
  if (!isValidId(paymentId)) {
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  }

  const result = await markOrderPaidFromVerifiedPayment({
    paymentId,
    expectedProvider: MANUAL_PROVIDER,
    expectedStatus: 'pending',
    // The customer's submitted Transaction id is never rewritten here.
    providerTransactionId: null,
    metadata: {
      verification_source: 'admin_manual',
      verified_by: adminId,
      verified_at: new Date().toISOString(),
    },
  });

  const row = await paymentModel.findById(paymentId);
  return {
    payment: manualPaymentView(
      row ? { ...row, order_number: result.payment.orderNumber } : null
    ),
    orderStatus: result.orderStatus,
    replayed: result.replayed,
  };
}

// Admin rejects a pending manual submission. The payment becomes `failed`
// (shown as "Rejected"); the order stays awaiting_payment so the customer can
// submit a different Transaction id.
async function adminRejectPayment(adminId, paymentId, reason = null) {
  if (!isValidId(paymentId)) {
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  }

  const payment = await paymentModel.findById(paymentId);
  if (!payment) {
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  }
  if (payment.provider !== MANUAL_PROVIDER) {
    throw new PaymentError(
      409,
      'PAYMENT_NOT_MANUAL',
      'Only manually submitted payments can be reviewed here.'
    );
  }
  if (payment.status !== 'pending') {
    throw new PaymentError(
      409,
      'PAYMENT_STATE_CONFLICT',
      'Payment state changed. Please try again.'
    );
  }

  let rejectionReason = null;
  if (reason !== undefined && reason !== null && String(reason).trim() !== '') {
    rejectionReason = String(reason).trim().slice(0, MANUAL_MAX_REASON);
  }

  const metadata = {
    rejected_by: adminId,
    rejected_at: new Date().toISOString(),
  };
  if (rejectionReason) metadata.rejection_reason = rejectionReason;

  const updated = await paymentModel.markTerminal(paymentId, 'failed', {
    metadata: cleanMetadata(metadata),
  });
  if (!updated) {
    // concurrent verify/reject won the race
    throw new PaymentError(
      409,
      'PAYMENT_STATE_CONFLICT',
      'Payment state changed. Please try again.'
    );
  }

  const order = await orderModel.findById(payment.order_id);
  return {
    payment: manualPaymentView(
      order ? { ...updated, order_number: order.order_number } : updated
    ),
    orderStatus: order ? order.status : null,
    replayed: false,
  };
}

// Admin-triggered AUTOMATIC verification (PART K): re-verify the invoice
// recorded on this row against the UddoktaPay Verify Payment API. The row
// and the invoice come from the database only — nothing is taken from the
// request body — and settlement still flows through the single authoritative
// path (verifyInvoice → markOrderPaidFromVerifiedPayment). PENDING keeps
// everything unpaid; ERROR fails the attempt only; a settled payment is an
// idempotent replay, never a second settlement.
async function adminVerifyWithGateway(adminId, paymentId) {
  if (!isValidId(paymentId)) {
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  }
  const payment = await paymentModel.findById(paymentId);
  if (!payment) {
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  }
  if (payment.provider !== 'uddoktapay') {
    throw new PaymentError(
      409,
      'PAYMENT_NOT_GATEWAY',
      'Only UddoktaPay payment attempts can be verified with the gateway.'
    );
  }
  const order = await orderModel.findById(payment.order_id);
  if (!order) {
    throw new PaymentError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  if (payment.status === 'successful') {
    return {
      payment: gatewayPaymentView(payment, order.order_number),
      orderStatus: order.status,
      replayed: true,
      paid: true,
      gatewayStatus: 'completed',
    };
  }
  if (payment.status !== 'initiated' && payment.status !== 'pending') {
    throw new PaymentError(
      409,
      'PAYMENT_STATE_CONFLICT',
      'Payment state changed. Please try again.'
    );
  }

  const invoiceId =
    typeof payment.provider_transaction_id === 'string' &&
    payment.provider_transaction_id.trim()
      ? payment.provider_transaction_id.trim()
      : null;
  if (!invoiceId) {
    throw new PaymentError(
      409,
      'PAYMENT_INVOICE_MISSING',
      'No gateway invoice is recorded for this payment. Use Manual Verification instead.'
    );
  }

  // Lazy require: uddoktapayService depends on this module at load time.
  const uddoktapayService = require('./uddoktapayService');
  const outcome = await uddoktapayService.verifyInvoice(invoiceId, {
    source: 'uddoktapay_auto',
    triggeredBy: adminId,
  });
  if (outcome.paymentId && outcome.paymentId !== payment.id) {
    // The gateway's verified metadata pointed at a different row — never
    // trust a settlement target we did not ask about.
    throw new PaymentError(
      409,
      'PAYMENT_VERIFICATION_FAILED',
      'Payment verification failed.'
    );
  }

  const updated = await paymentModel.findById(payment.id);
  const orderAfter = await orderModel.findById(payment.order_id);
  const gatewayStatus =
    updated && updated.status === 'successful'
      ? 'completed'
      : updated && updated.status === 'failed'
        ? 'error'
        : 'pending';
  return {
    payment: gatewayPaymentView(
      updated || payment,
      orderAfter ? orderAfter.order_number : order.order_number
    ),
    orderStatus:
      outcome.orderStatus || (orderAfter ? orderAfter.status : order.status),
    replayed: !!outcome.replayed,
    paid: !!outcome.paid,
    gatewayStatus,
  };
}

// Admin MANUAL fallback for gateway rows (PART L): the admin confirms the
// exact amount and the external reference for an unpaid gateway attempt.
// Every value is validated against the locked payment/order rows and no
// other payment may hold the reference — then settlement runs through the
// same authoritative transaction as every other path, with admin_manual
// provenance recorded on the payment row.
async function adminManualVerify(adminId, paymentId, input = {}) {
  if (!isValidId(paymentId)) {
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  }
  const payment = await paymentModel.findById(paymentId);
  if (!payment) {
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  }
  if (payment.provider === MANUAL_PROVIDER) {
    throw new PaymentError(
      409,
      'PAYMENT_NOT_GATEWAY',
      'Only gateway payment attempts can be manually verified here.'
    );
  }
  // A refunded attempt already had its money returned — it can never settle
  // again. Every other non-successful state (initiated, pending, failed,
  // cancelled, expired) is exactly the stuck attempt this fallback exists for.
  if (payment.status === 'refunded') {
    throw new PaymentError(
      409,
      'PAYMENT_STATE_CONFLICT',
      'Payment state changed. Please try again.'
    );
  }

  const order = await orderModel.findById(payment.order_id);
  if (!order) {
    throw new PaymentError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  // Required exact amount — the value the admin sees at the bank/gateway.
  const rawAmount = input.amount;
  if (
    rawAmount === undefined ||
    rawAmount === null ||
    (typeof rawAmount === 'string' && rawAmount.trim() === '')
  ) {
    throw new PaymentError(400, 'VALIDATION_ERROR', 'Invalid request.', [
      'Amount is required.',
    ]);
  }
  if (
    !moneyMatches(rawAmount, payment.amount) ||
    !moneyMatches(rawAmount, order.amount)
  ) {
    throw new PaymentError(
      400,
      'PAYMENT_VERIFICATION_FAILED',
      'Payment verification failed.'
    );
  }
  if (
    input.currency !== undefined &&
    input.currency !== null &&
    input.currency !== ''
  ) {
    const currency = String(input.currency);
    if (currency !== payment.currency || currency !== order.currency) {
      throw new PaymentError(
        400,
        'PAYMENT_VERIFICATION_FAILED',
        'Payment verification failed.'
      );
    }
  }

  // Required reference. When a gateway invoice is already recorded it must
  // match (case-insensitively); when nothing is recorded the admin's
  // reference is stored as the payment's transaction id.
  const normalizedTrx = normalizeTransactionId(input.transactionId);
  const recorded =
    typeof payment.provider_transaction_id === 'string' &&
    payment.provider_transaction_id.trim()
      ? payment.provider_transaction_id.trim()
      : null;
  if (recorded && normalizedTrx !== recorded.toUpperCase()) {
    throw new PaymentError(
      409,
      'PAYMENT_REFERENCE_MISMATCH',
      'Reference does not match the recorded gateway reference for this payment.'
    );
  }
  const clash = await paymentModel.findByTransactionIdAnywhere(normalizedTrx);
  if (clash && clash.id !== payment.id) {
    throw new PaymentError(
      409,
      'DUPLICATE_TRANSACTION_ID',
      'This Transaction ID has already been recorded.'
    );
  }

  const note =
    typeof input.note === 'string' && input.note.trim()
      ? input.note.trim().slice(0, MANUAL_MAX_REASON)
      : null;

  const result = await markOrderPaidFromVerifiedPayment({
    paymentId: payment.id,
    amount: rawAmount,
    currency: payment.currency,
    providerTransactionId: recorded ? null : normalizedTrx,
    expectedStatus: null,
    metadata: {
      verification_source: 'admin_manual',
      verified_by: adminId,
      verified_at: new Date().toISOString(),
      ...(note ? { verification_note: note } : {}),
    },
  });

  const updated = await paymentModel.findById(payment.id);
  const orderAfter = await orderModel.findById(payment.order_id);
  return {
    payment: gatewayPaymentView(
      updated || payment,
      orderAfter ? orderAfter.order_number : order.order_number
    ),
    orderStatus: result.orderStatus,
    replayed: result.replayed,
    paid: result.orderStatus === 'paid' || orderAfter?.status === 'paid',
  };
}

// Internal-only: the single server-side path that can mark an order paid.
// Never exposed as an HTTP endpoint. Callers must supply values already
// verified — either by a configured payment provider (webhook signature +
// lookup) or by an admin reviewing a manual Transaction id submission
// (expectedProvider/expectedStatus enforce that choice under the row lock).
// Atomic: lock payment → lock order → verify amount/currency → mark payment
// successful → mark order paid → COMMIT (any failure rolls back both).
// Optional validationId/bankTranId/riskLevel/riskFlag are recorded by real
// gateways (e.g. SSLCommerz) on the payment row — never on the order.
async function markOrderPaidFromVerifiedPayment({
  paymentId,
  amount,
  currency,
  providerTransactionId = null,
  validationId = null,
  bankTranId = null,
  riskLevel = undefined,
  riskFlag = undefined,
  expectedProvider = null,
  expectedStatus = null,
  metadata = {},
}) {
  if (!isValidId(paymentId)) {
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  }

  const client = await getClient();
  let committed = false;
  try {
    await client.query('BEGIN');

    const payment = await paymentModel.findByIdForUpdate(client, paymentId);
    if (!payment) {
      throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
    }

    if (expectedProvider && payment.provider !== expectedProvider) {
      throw new PaymentError(
        409,
        'PAYMENT_NOT_MANUAL',
        'Only manually submitted payments can be reviewed here.'
      );
    }

    if (payment.status === 'successful') {
      // verified replay — idempotent, no state change
      const existingOrder = await orderModel.findByIdForUpdate(
        client,
        payment.order_id
      );
      await client.query('COMMIT');
      committed = true;
      return {
        payment: mapPaymentRow(payment, {
          orderNumber: existingOrder ? existingOrder.order_number : null,
        }),
        orderStatus: existingOrder ? existingOrder.status : null,
        replayed: true,
      };
    }

    if (expectedStatus && payment.status !== expectedStatus) {
      throw new PaymentError(
        409,
        'PAYMENT_STATE_CONFLICT',
        'Payment state changed. Please try again.'
      );
    }

    const order = await orderModel.findByIdForUpdate(client, payment.order_id);
    if (!order) {
      throw new PaymentError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    }

    if (
      payment.provider_transaction_id &&
      providerTransactionId &&
      payment.provider_transaction_id !== providerTransactionId
    ) {
      throw new PaymentError(
        400,
        'PAYMENT_VERIFICATION_FAILED',
        'Payment verification failed.'
      );
    }

    if (
      !moneyMatches(payment.amount, order.amount) ||
      payment.currency !== order.currency
    ) {
      throw new PaymentError(
        400,
        'PAYMENT_VERIFICATION_FAILED',
        'Payment verification failed.'
      );
    }

    // amount/currency are optional for the manual path (the locked payment
    // row above is already compared to the order); provider callers pass them.
    if (
      amount !== undefined &&
      amount !== null &&
      (!moneyMatches(amount, order.amount) || currency !== order.currency)
    ) {
      throw new PaymentError(
        400,
        'PAYMENT_VERIFICATION_FAILED',
        'Payment verification failed.'
      );
    }

    if (order.status === 'paid') {
      throw new PaymentError(
        409,
        'ORDER_ALREADY_PAID',
        'Order has already been paid.'
      );
    }

    const updatedPayment = await paymentModel.markSuccessful(client, payment.id, {
      providerTransactionId,
      validationId,
      bankTranId,
      metadata: {
        ...buildMetadataPatch({ riskLevel, riskFlag }),
        ...cleanMetadata(metadata),
      },
    });
    if (!updatedPayment) {
      throw new PaymentError(
        409,
        'PAYMENT_STATE_CONFLICT',
        'Payment state changed. Please try again.'
      );
    }

    const paidOrder = await orderModel.markPaidIfAwaiting(client, order.id);
    if (!paidOrder) {
      throw new PaymentError(
        409,
        'ORDER_NOT_PAYABLE',
        'Order is not awaiting payment.'
      );
    }

    await client.query('COMMIT');
    committed = true;
    return {
      payment: mapPaymentRow(updatedPayment, {
        orderNumber: order.order_number,
      }),
      orderStatus: 'paid',
      replayed: false,
    };
  } catch (err) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        // connection may already be aborted
      }
    }
    const mapped = mapUniqueViolation(err);
    if (mapped) throw mapped;
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  PaymentError,
  PaymentProviderError,
  AWAITING_PAYMENT,
  MANUAL_PROVIDER,
  MANUAL_UI_STATUS,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  isValidId,
  manualUiStatus,
  mapPaymentRow,
  gatewayPaymentView,
  createPayment,
  listPayments,
  getPayment,
  submitManualTransaction,
  getPaymentForOrder,
  adminVerifyPayment,
  adminRejectPayment,
  adminVerifyWithGateway,
  adminManualVerify,
  markOrderPaidFromVerifiedPayment,
};
