const { sendOk } = require('../utils/respond');
const sslcommerzService = require('../services/payments/sslcommerzService');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mergedData(req) {
  const body =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {};
  const query =
    req.query && typeof req.query === 'object' && !Array.isArray(req.query)
      ? req.query
      : {};
  // SSLCommerz may deliver callback data as a form POST or a query string.
  return { ...query, ...body };
}

function isShapedError(err) {
  return !!(err && err.status && typeof err.code === 'string' && err.message);
}

function redirectResult(res, page, orderId) {
  const id =
    typeof orderId === 'string' && UUID_PATTERN.test(orderId) ? orderId : null;
  const target = id
    ? `/payment-${page}.html?order=${encodeURIComponent(id)}`
    : `/payment-${page}.html`;
  res.redirect(302, target);
}

// Browser return from the SSLCommerz gateway. Validated server-side first;
// any verification/config problem lands the customer on the failed result
// page with no state change (the Order Validation API is the trust boundary).
async function success(req, res, next) {
  try {
    const outcome = await sslcommerzService.processCallback(
      'success',
      mergedData(req)
    );
    // Only a verified-paid outcome lands on the success result page.
    return redirectResult(res, outcome.paid ? 'success' : 'failed', outcome.orderId);
  } catch (err) {
    if (isShapedError(err)) {
      return redirectResult(res, 'failed', err.orderId);
    }
    return next(err);
  }
}

async function fail(req, res, next) {
  try {
    const outcome = await sslcommerzService.processCallback(
      'fail',
      mergedData(req)
    );
    return redirectResult(
      res,
      outcome.paid ? 'success' : 'failed',
      outcome.orderId
    );
  } catch (err) {
    if (isShapedError(err)) {
      return redirectResult(res, 'failed', err.orderId);
    }
    return next(err);
  }
}

async function cancel(req, res, next) {
  try {
    const outcome = await sslcommerzService.processCallback(
      'cancel',
      mergedData(req)
    );
    return redirectResult(
      res,
      outcome.paid ? 'success' : 'cancelled',
      outcome.orderId
    );
  } catch (err) {
    if (isShapedError(err)) {
      return redirectResult(res, 'cancelled', err.orderId);
    }
    return next(err);
  }
}

// IPN: always HTTP 200 with the same uniform body — success, failure,
// invalid, disabled, or internal problems are never distinguished here.
async function ipn(req, res) {
  try {
    await sslcommerzService.processIpn(mergedData(req));
  } catch {
    // never surface provider or internal errors to the IPN caller
  }
  return sendOk(res, { received: true });
}

module.exports = {
  success,
  fail,
  cancel,
  ipn,
};
