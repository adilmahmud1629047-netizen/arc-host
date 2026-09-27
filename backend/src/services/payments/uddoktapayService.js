const crypto = require('crypto');
const config = require('../../config');
const paymentModel = require('../../models/paymentModel');
const paymentService = require('./paymentService');
const { getProvider, PaymentProviderError } = require('./paymentProvider');

const { PaymentError, markOrderPaidFromVerifiedPayment, isValidId } =
  paymentService;

// UddoktaPay Verify Payment statuses (docs: COMPLETED | PENDING | ERROR).
// Only a server-side COMPLETED verification can ever mark anything paid.

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

// Callbacks/webhooks must never settle anything while the active provider is
// not uddoktapay (e.g. payments disabled).
function requireActive() {
  const active = (config.payments.provider || '').trim().toLowerCase();
  if (active !== 'uddoktapay') {
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
  const provider = getProvider('uddoktapay');
  if (!provider) {
    throw new PaymentError(
      503,
      'PAYMENT_PROVIDER_NOT_CONFIGURED',
      'Payment processing is not available yet.'
    );
  }
  return provider;
}

// Constant-time comparison of the webhook API-key header (docs: respond 401
// when it does not equal the configured key). Hashed first so the comparison
// length is fixed and neither value's length is observable.
function timingSafeEqualString(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// The single verified-success path: Verify Payment API → row identified from
// the echoed metadata → cross-checks → internal markOrderPaidFromVerifiedPayment
// (atomic, idempotent, replay-safe). Returns a settled outcome object.
// `context` records provenance on settlement: { source, triggeredBy } —
// callbacks/webhooks settle as uddoktapay_auto with no actor; the admin
// auto-verify action adds the acting admin id.
async function verifyInvoice(invoiceId, context = {}) {
  requireActive();
  const provider = getProviderOrThrow();

  const verified = await provider.verifyPayment({ invoiceId });
  if (!verified.invoiceId) throw verificationFailed();

  // The metadata we sent at charge creation comes back on verify/webhook —
  // it is our pointer to the payment row (same role as SSLCommerz value_a).
  const meta = verified.metadata || {};
  const paymentId = firstString(meta.payment_id);
  const payment =
    paymentId && isValidId(paymentId)
      ? await paymentModel.findById(paymentId)
      : null;
  if (!payment) throw paymentNotFound();
  if (payment.provider !== 'uddoktapay') {
    throw verificationFailed(payment.order_id);
  }
  const metaOrderId = firstString(meta.order_id);
  if (metaOrderId && metaOrderId !== payment.order_id) {
    throw verificationFailed(payment.order_id);
  }

  // Record the invoice on our row as soon as it has been verified against
  // the gateway — this is what lets a later admin auto-verification derive
  // everything from the database alone. A (provider, invoice) uniqueness
  // conflict is left to settlement's backstop and never breaks verification.
  if (
    verified.invoiceId &&
    payment.provider_transaction_id !== verified.invoiceId
  ) {
    try {
      await paymentModel.updateProviderResult(payment.id, {
        providerTransactionId: verified.invoiceId,
      });
    } catch {
      // duplicate invoice recorded elsewhere → settlement rejects it below
    }
  }

  if (verified.status === 'completed') {
    if (!verified.amount) throw verificationFailed(payment.order_id);
    try {
      // currency: the gateway does not handle currencies — our own snapshot
      // is passed so the callee's payment-vs-order currency equality still
      // runs; the real gateway cross-check is amount vs the order amount.
      const result = await markOrderPaidFromVerifiedPayment({
        paymentId: payment.id,
        amount: verified.amount,
        currency: payment.currency,
        providerTransactionId: verified.invoiceId,
        validationId: verified.invoiceId,
        bankTranId: verified.transactionId || null,
        metadata: {
          payment_method: verified.paymentMethod,
          sender_number: verified.senderNumber,
          verification_source: context.source || 'uddoktapay_auto',
          ...(context.triggeredBy
            ? {
                verified_by: context.triggeredBy,
                verified_at: new Date().toISOString(),
              }
            : {}),
        },
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

  if (verified.status === 'error') {
    const updated = await paymentModel.markTerminal(payment.id, 'failed');
    return {
      orderId: payment.order_id,
      paymentId: payment.id,
      orderStatus: null,
      paymentStatus: updated ? updated.status : payment.status,
      paid: false,
    };
  }

  // PENDING — no state change (never marks paid; a later return/webhook with
  // COMPLETED can still settle it).
  return {
    orderId: payment.order_id,
    paymentId: payment.id,
    orderStatus: null,
    paymentStatus: payment.status,
    paid: false,
  };
}

// Browser return from the gateway (success/fail/cancel). invoice_id (GET
// query or POST body) is the only entry into verification. Failure-direction
// transitions only — the completed status always wins, whatever the route.
async function processCallback(kind, data) {
  requireActive();
  const invoiceId = firstString(data && data.invoice_id);

  if (invoiceId) {
    const outcome = await verifyInvoice(invoiceId);
    if (outcome.paid || kind === 'success') return outcome;

    // Verified but not completed: fail/cancel may move an open attempt to a
    // terminal state (failure direction only; successful is never downgraded).
    const target = kind === 'cancel' ? 'cancelled' : 'failed';
    if (
      outcome.paymentStatus === 'initiated' ||
      outcome.paymentStatus === 'pending'
    ) {
      const updated = await paymentModel.markTerminal(outcome.paymentId, target);
      if (updated) outcome.paymentStatus = updated.status;
    }
    return outcome;
  }

  // Success return without an invoice_id cannot be verified — never paid.
  if (kind === 'success') throw verificationFailed();

  // fail/cancel without invoice_id: no documented payment pointer arrives
  // here, so the attempt cannot be identified — acknowledge with no state
  // change (the customer simply returns to a result page).
  return {
    orderId: null,
    paymentId: null,
    orderStatus: null,
    paymentStatus: null,
    paid: false,
  };
}

// Webhook: authenticate the RT-UDDOKTAPAY-API-KEY header (401 otherwise),
// then re-verify the invoice_id against the Verify Payment API — the payload
// alone never marks anything paid. Always resolves after authentication so
// the endpoint answers a uniform 200 for unknown/invalid events.
async function processWebhook(headers, body) {
  const cfg = config.payments.uddoktapay || {};
  const expectedKey = String(cfg.apiKey || '').trim();
  const receivedKey =
    firstString(headers && headers['rt-uddoktapay-api-key']) ||
    firstString(headers && headers['RT-UDDOKTAPAY-API-KEY']);
  if (!expectedKey || !receivedKey || !timingSafeEqualString(receivedKey, expectedKey)) {
    throw new PaymentProviderError(401, 'WEBHOOK_UNAUTHORIZED', 'Unauthorized.');
  }

  const ack = { received: true, paid: false };
  try {
    requireActive();
    const invoiceId = firstString(body && body.invoice_id);
    if (!invoiceId) return ack;
    const outcome = await verifyInvoice(invoiceId);
    return { received: true, paid: !!outcome.paid };
  } catch {
    // Unknown/invalid events are acknowledged as no-ops.
    return ack;
  }
}

module.exports = {
  processCallback,
  processWebhook,
  verifyInvoice,
};
