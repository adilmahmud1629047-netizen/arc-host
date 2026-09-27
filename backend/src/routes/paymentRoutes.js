const express = require('express');
const config = require('../config');
const paymentController = require('../controllers/paymentController');
const sslcommerzController = require('../controllers/sslcommerzController');
const uddoktapayController = require('../controllers/uddoktapayController');
const { requireAuth } = require('../middleware/auth');
const { validateBody } = require('../middleware/validation');
const { createRateLimiter } = require('../utils/rateLimiter');
const { sendError } = require('../utils/respond');

const router = express.Router();

const createPaymentLimiter = createRateLimiter({
  name: 'payment-create',
  windowMs: config.rateLimit.paymentCreateWindowMs,
  max: config.rateLimit.paymentCreateMax,
});

// Manual Transaction id submissions reuse the payment-create limits (same
// window/max) as its own named limiter so counters stay independent.
const manualTransactionLimiter = createRateLimiter({
  name: 'payment-manual-transaction',
  windowMs: config.rateLimit.paymentCreateWindowMs,
  max: config.rateLimit.paymentCreateMax,
});

// Gateway callbacks arrive from the customer's browser (redirects) and from
// SSLCommerz servers (IPN) — loose limit only; auth/CSRF do not apply because
// the trust boundary is the server-side Order Validation API.
const sslcommerzCallbackLimiter = createRateLimiter({
  name: 'sslcommerz-callback',
  windowMs: config.rateLimit.sslcommerzCallbackWindowMs,
  max: config.rateLimit.sslcommerzCallbackMax,
});

// UddoktaPay browser returns (success/fail/cancel) — same shared callback
// limits as the SSLCommerz callbacks, own counter name. Webhooks go through
// the generic /webhook/:provider route below.
const uddoktapayCallbackLimiter = createRateLimiter({
  name: 'uddoktapay-callback',
  windowMs: config.rateLimit.sslcommerzCallbackWindowMs,
  max: config.rateLimit.sslcommerzCallbackMax,
});

function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) {
    return next();
  }

  try {
    const parsed = new URL(origin);
    if (parsed.host === req.headers.host) {
      return next();
    }
  } catch {
    // fall through to rejection
  }

  return sendError(res, 403, 'CSRF_INVALID', 'Request origin not allowed.');
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createPaymentRules = {
  orderId: {
    label: 'Order ID',
    required: true,
    trim: true,
    min: 36,
    max: 36,
    pattern: UUID_PATTERN,
    patternMessage: 'Order ID must be a valid UUID.',
  },
};

// Manual verification submission: only orderId + transactionId (+ optional
// payment method) may be sent. amount / currency / status / verified are
// deliberately NOT accepted — every one of those is server-derived.
const submitTransactionRules = {
  orderId: {
    label: 'Order ID',
    required: true,
    trim: true,
    min: 36,
    max: 36,
    pattern: UUID_PATTERN,
    patternMessage: 'Order ID must be a valid UUID.',
  },
  transactionId: {
    label: 'Transaction ID',
    required: true,
    trim: true,
    min: 4,
    max: 64,
    pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/,
    patternMessage:
      'Transaction ID must be 4 to 64 characters (letters, numbers, "-" or "_").',
  },
  paymentMethod: {
    label: 'Payment method',
    required: false,
    trim: true,
    min: 3,
    max: 30,
    pattern: /^[A-Za-z0-9][A-Za-z0-9 &_-]{2,29}$/,
    patternMessage: 'Payment method must be 3 to 30 characters.',
  },
};

// External provider callback: no auth, no CSRF (provider signatures are the
// trust boundary once a real provider is configured).
router.post('/webhook/:provider', paymentController.handleWebhook);

// SSLCommerz sandbox callbacks. No session auth, no CSRF, no client secrets —
// payment truth comes only from the Order Validation API (val_id) server-side.
// Browser redirects end in a 302 to a local result page; IPN always answers
// a uniform 200. Callback URLs sent to the gateway are built exclusively from
// APP_PUBLIC_URL (never Host/Origin/Referer).
router.post(
  '/sslcommerz/success',
  sslcommerzCallbackLimiter,
  sslcommerzController.success
);
router.get(
  '/sslcommerz/success',
  sslcommerzCallbackLimiter,
  sslcommerzController.success
);
router.post(
  '/sslcommerz/fail',
  sslcommerzCallbackLimiter,
  sslcommerzController.fail
);
router.get(
  '/sslcommerz/fail',
  sslcommerzCallbackLimiter,
  sslcommerzController.fail
);
router.post(
  '/sslcommerz/cancel',
  sslcommerzCallbackLimiter,
  sslcommerzController.cancel
);
router.get(
  '/sslcommerz/cancel',
  sslcommerzCallbackLimiter,
  sslcommerzController.cancel
);
router.post(
  '/sslcommerz/ipn',
  sslcommerzCallbackLimiter,
  sslcommerzController.ipn
);
router.get(
  '/sslcommerz/ipn',
  sslcommerzCallbackLimiter,
  sslcommerzController.ipn
);

// UddoktaPay gateway returns. No session auth, no CSRF — payment truth comes
// only from the server-side Verify Payment API (invoice_id) once the
// RT-UDDOKTAPAY-API-KEY-authenticated webhook or this return calls it.
// Browser redirects end in a 302 to a local result page. Callback URLs sent
// to the gateway are built exclusively from APP_PUBLIC_URL (never
// Host/Origin/Referer). GET carries invoice_id as a query parameter
// (return_type=GET); POST is accepted as well for the default return type.
router.get(
  '/uddoktapay/success',
  uddoktapayCallbackLimiter,
  uddoktapayController.success
);
router.post(
  '/uddoktapay/success',
  uddoktapayCallbackLimiter,
  uddoktapayController.success
);
router.get(
  '/uddoktapay/fail',
  uddoktapayCallbackLimiter,
  uddoktapayController.fail
);
router.post(
  '/uddoktapay/fail',
  uddoktapayCallbackLimiter,
  uddoktapayController.fail
);
router.get(
  '/uddoktapay/cancel',
  uddoktapayCallbackLimiter,
  uddoktapayController.cancel
);
router.post(
  '/uddoktapay/cancel',
  uddoktapayCallbackLimiter,
  uddoktapayController.cancel
);

router.post(
  '/',
  requireSameOrigin,
  requireAuth,
  createPaymentLimiter,
  validateBody(createPaymentRules),
  paymentController.createPayment
);

// Manual payment verification: customer submits a Transaction id for their
// own awaiting-payment order (auth + same-origin + rate limit + strict body).
// Registered before GET /:id so "order" is never read as a payment id.
router.post(
  '/transaction-id',
  requireSameOrigin,
  requireAuth,
  manualTransactionLimiter,
  validateBody(submitTransactionRules),
  paymentController.submitTransactionId
);

router.get('/', requireAuth, paymentController.listPayments);

router.get('/order/:orderId', requireAuth, paymentController.getPaymentForOrder);

// Public, read-only: which payment provider is active. Returns the provider
// name plus the host-only gatewayHost (server-derived from configuration)
// when a gateway is configured — never credentials, keys, or full gateway
// URLs. Registered before GET /:id so "provider" is never read as a payment
// id.
router.get('/provider', paymentController.getPaymentProvider);

router.get('/:id', requireAuth, paymentController.getPayment);

module.exports = router;
module.exports.createPaymentLimiter = createPaymentLimiter;
module.exports.manualTransactionLimiter = manualTransactionLimiter;
module.exports.sslcommerzCallbackLimiter = sslcommerzCallbackLimiter;
module.exports.uddoktapayCallbackLimiter = uddoktapayCallbackLimiter;
