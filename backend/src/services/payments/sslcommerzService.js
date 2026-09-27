const config = require('../../config');
const paymentModel = require('../../models/paymentModel');
const paymentService = require('./paymentService');
const { getProvider, PaymentProviderError } = require('./paymentProvider');

const { PaymentError, markOrderPaidFromVerifiedPayment } = paymentService;

// Our merchant transaction ids: 'FLR' + 27 hex chars (30 total). Raw
// callback-only lookups must match this — anything else (including SQL
// injection attempts) is rejected before touching the database.
const TRAN_ID_PATTERN = /^FLR[0-9a-f]{27}$/;

// Validation status → payment status (only failure directions; never paid).
const TERMINAL_BY_VALIDATION = {
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'expired',
  unattempted: 'failed',
};

// IPN status field (no val_id) → payment status.
const TERMINAL_BY_IPN_STATUS = {
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

function verificationFailed(orderId) {
  const err = new PaymentError(
    400,
    'PAYMENT_VERIFICATION_FAILED',
    'Payment verification failed.'
  );
  if (orderId) err.orderId = orderId;
  return err;
}

function paymentNotFound() {
  return new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
}

// Callbacks must never be able to mark anything paid while the active
// provider is not sslcommerz (e.g. payments disabled).
function requireActive() {
  const active = (config.payments.provider || '').trim().toLowerCase();
  if (active !== 'sslcommerz') {
    throw new PaymentError(
      503,
      'PAYMENT_PROVIDER_NOT_CONFIGURED',
      'Payment processing is not available yet.'
    );
  }
}

function firstString(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function getProviderOrThrow() {
  const provider = getProvider('sslcommerz');
  if (!provider) {
    throw new PaymentError(
      503,
      'PAYMENT_PROVIDER_NOT_CONFIGURED',
      'Payment processing is not available yet.'
    );
  }
  return provider;
}

// The single verified-success path: Order Validation API → cross-checks →
// internal markOrderPaidFromVerifiedPayment (atomic, idempotent).
async function processValidation({ valId, callbackTranId = null }) {
  requireActive();
  const provider = getProviderOrThrow();

  const validation = await provider.verifyPayment({ valId });
  if (!validation.tranId) throw verificationFailed();
  if (callbackTranId && callbackTranId !== validation.tranId) {
    throw verificationFailed();
  }

  const payment = await paymentModel.findByProviderTransactionId(
    'sslcommerz',
    validation.tranId
  );
  if (!payment) throw paymentNotFound();

  // value_a carries our order id — cross-check against the payment row.
  if (validation.valueA && validation.valueA !== payment.order_id) {
    throw verificationFailed(payment.order_id);
  }

  if (validation.status === 'valid') {
    if (!validation.amount || !validation.currency) {
      throw verificationFailed(payment.order_id);
    }
    try {
      const result = await markOrderPaidFromVerifiedPayment({
        paymentId: payment.id,
        amount: validation.amount,
        currency: validation.currency,
        providerTransactionId: validation.tranId,
        validationId: validation.valId || null,
        bankTranId: validation.bankTranId || null,
        riskLevel: validation.riskLevel,
        riskFlag: validation.riskFlag,
      });
      return {
        orderId: payment.order_id,
        paymentId: payment.id,
        orderStatus: result.orderStatus,
        paymentStatus: result.payment.status,
        replayed: result.replayed,
        paid: true,
      };
    } catch (err) {
      // The order was already settled by another verified payment — that is
      // a settled success, not a verification failure. Surface the order id
      // so the browser still lands on the success result page.
      if (err && err.code === 'ORDER_ALREADY_PAID') {
        return {
          orderId: payment.order_id,
          paymentId: payment.id,
          orderStatus: 'paid',
          paymentStatus: payment.status,
          replayed: false,
          paid: true,
          alreadyPaid: true,
        };
      }
      if (err && err.code === 'PAYMENT_VERIFICATION_FAILED' && !err.orderId) {
        err.orderId = payment.order_id;
      }
      throw err;
    }
  }

  const terminal = TERMINAL_BY_VALIDATION[validation.status];
  if (terminal) {
    const updated = await paymentModel.markTerminal(payment.id, terminal);
    return {
      orderId: payment.order_id,
      paymentId: payment.id,
      orderStatus: null,
      paymentStatus: updated ? updated.status : payment.status,
      paid: false,
    };
  }

  // Validation pending/unknown — no state change (never marks paid).
  return {
    orderId: payment.order_id,
    paymentId: payment.id,
    orderStatus: null,
    paymentStatus: payment.status,
    paid: false,
  };
}

// Browser fail/cancel without a val_id: trust nothing for state upgrades —
// only failure-direction transitions keyed by our unguessable tran_id.
async function processTerminalCallback(kind, { valId, tranId }) {
  if (valId) {
    return processValidation({ valId, callbackTranId: tranId });
  }

  if (!tranId || !TRAN_ID_PATTERN.test(tranId)) throw verificationFailed();
  const payment = await paymentModel.findByProviderTransactionId(
    'sslcommerz',
    tranId
  );
  if (!payment) throw paymentNotFound();

  const target = kind === 'cancel' ? 'cancelled' : 'failed';
  const updated = await paymentModel.markTerminal(payment.id, target);
  return {
    orderId: payment.order_id,
    paymentId: payment.id,
    orderStatus: null,
    paymentStatus: updated ? updated.status : payment.status,
    paid: false,
  };
}

// kind: 'success' | 'fail' | 'cancel' — browser redirects. Errors are shaped
// PaymentErrors (controller turns them into the failed/cancelled result page).
async function processCallback(kind, data) {
  requireActive();
  const valId = firstString(data.val_id);
  const tranId = firstString(data.tran_id);

  if (kind === 'success') {
    if (!valId) throw verificationFailed();
    return processValidation({ valId, callbackTranId: tranId });
  }

  return processTerminalCallback(kind, { valId, tranId });
}

// IPN: always resolves (never throws) — the controller answers 200 regardless.
// Only a server-side VALID validation can ever mark an order paid.
async function processIpn(data) {
  const received = { received: true, paid: false };
  try {
    requireActive();
    const valId = firstString(data && data.val_id);
    const tranId = firstString(data && data.tran_id);

    if (valId) {
      const outcome = await processValidation({
        valId,
        callbackTranId: tranId,
      });
      return { received: true, paid: !!outcome.paid };
    }

    const status = firstString(data && data.status);
    const target = status ? TERMINAL_BY_IPN_STATUS[status.toUpperCase()] : null;
    if (target && tranId && TRAN_ID_PATTERN.test(tranId)) {
      const payment = await paymentModel.findByProviderTransactionId(
        'sslcommerz',
        tranId
      );
      if (payment) {
        await paymentModel.markTerminal(payment.id, target);
        return { received: true, paid: false };
      }
    }
    return received;
  } catch {
    // Unknown/invalid events are acknowledged as no-ops.
    return received;
  }
}

module.exports = {
  TRAN_ID_PATTERN,
  processValidation,
  processCallback,
  processIpn,
};
