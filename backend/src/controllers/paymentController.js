const { sendOk, sendError } = require('../utils/respond');
const config = require('../config');
const paymentService = require('../services/payments/paymentService');
const { getProvider } = require('../services/payments/paymentProvider');

const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,29}$/;

function isShapedError(err) {
  return !!(
    err &&
    err.status &&
    typeof err.code === 'string' &&
    err.message
  );
}

function handleError(res, err) {
  if (isShapedError(err)) {
    return sendError(res, err.status, err.code, err.message, err.details);
  }
  return null;
}

async function createPayment(req, res, next) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    const { orderId } = req.body || {};
    const result = await paymentService.createPayment(userId, orderId);
    // Only what the browser needs to continue: the attempt id and the
    // provider gateway URL (null when the provider has no redirect).
    return sendOk(
      res,
      {
        paymentId: result.payment.id,
        gatewayUrl: result.gatewayUrl || null,
      },
      201
    );
  } catch (err) {
    const handled = handleError(res, err);
    if (handled) return handled;
    return next(err);
  }
}

async function listPayments(req, res, next) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    const allowed = new Set(['page', 'limit']);
    for (const key of Object.keys(req.query)) {
      if (!allowed.has(key)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `Unexpected query parameter: ${key}.`,
        ]);
      }
    }

    const result = await paymentService.listPayments(userId, {
      page: req.query.page,
      limit: req.query.limit,
    });
    return sendOk(res, {
      payments: result.payments,
      pagination: result.pagination,
    });
  } catch (err) {
    const handled = handleError(res, err);
    if (handled) return handled;
    return next(err);
  }
}

async function getPayment(req, res, next) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    const payment = await paymentService.getPayment(userId, req.params.id);
    return sendOk(res, payment);
  } catch (err) {
    const handled = handleError(res, err);
    if (handled) return handled;
    return next(err);
  }
}

// POST /api/payments/transaction-id — customer submits a Transaction id for
// their own awaiting-payment order. Server derives order/amount/currency and
// stores the submission as `pending` (awaiting admin verification). The body
// carries only orderId + transactionId (+ optional payment method); amount,
// currency, status and "verified" fields are rejected by validateBody.
async function submitTransactionId(req, res, next) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    const { orderId, transactionId, paymentMethod } = req.body || {};
    const result = await paymentService.submitManualTransaction(userId, {
      orderId,
      transactionId,
      paymentMethod,
    });
    return sendOk(res, result, 201);
  } catch (err) {
    const handled = handleError(res, err);
    if (handled) return handled;
    return next(err);
  }
}

// GET /api/payments/order/:orderId — owner-scoped verification state for one
// order (checkout / dashboard "awaiting admin verification" display).
async function getPaymentForOrder(req, res, next) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    const result = await paymentService.getPaymentForOrder(
      userId,
      req.params.orderId
    );
    return sendOk(res, result);
  } catch (err) {
    const handled = handleError(res, err);
    if (handled) return handled;
    return next(err);
  }
}

// Provider webhook endpoint: no session auth and no same-origin check —
// callers are external payment providers. A configured provider must verify
// its own signature here; the disabled provider rejects before any DB write,
// so this endpoint can never mark an order paid while payments are disabled.
async function handleWebhook(req, res, next) {
  try {
    const providerName =
      typeof req.params.provider === 'string' ? req.params.provider : '';

    if (!PROVIDER_NAME_PATTERN.test(providerName)) {
      return sendError(res, 404, 'NOT_FOUND', 'Webhook provider not found.');
    }

    const provider = getProvider(providerName);
    if (!provider) {
      return sendError(res, 404, 'NOT_FOUND', 'Webhook provider not found.');
    }

    const result = await provider.handleWebhook({
      headers: req.headers,
      body: req.body,
    });

    return sendOk(
      res,
      result && typeof result === 'object' ? result : { received: true }
    );
  } catch (err) {
    const handled = handleError(res, err);
    if (handled) return handled;
    return next(err);
  }
}

// GET /api/payments/provider — public, read-only. The active provider name
// lets the checkout show a provider-appropriate payment UI. When the active
// provider has a configured gateway base URL, its exact host is advertised
// as `gatewayHost` so the browser's isSafeGatewayUrl guard agrees with the
// server-side redirect trust rules. Host only — never credentials, never a
// scheme/path, never any other configuration.
function getPaymentProvider(req, res) {
  const data = { provider: config.payments.provider };
  const provider = getProvider(config.payments.provider);
  const gatewayHost =
    provider && typeof provider.trustedGatewayHost === 'function'
      ? provider.trustedGatewayHost()
      : null;
  if (typeof gatewayHost === 'string' && gatewayHost) {
    data.gatewayHost = gatewayHost;
  }
  return sendOk(res, data);
}

module.exports = {
  createPayment,
  listPayments,
  getPayment,
  submitTransactionId,
  getPaymentForOrder,
  getPaymentProvider,
  handleWebhook,
};
