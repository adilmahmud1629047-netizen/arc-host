const uddoktapayService = require('../services/payments/uddoktapayService');

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
  // UddoktaPay may deliver callback data as a query string (return_type GET)
  // or a form/JSON POST (return_type POST default).
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

// Browser return from the UddoktaPay gateway. Verified server-side first;
// any verification/config problem lands the customer on the failed result
// page with no state change (the Verify Payment API is the trust boundary).
async function success(req, res, next) {
  try {
    const outcome = await uddoktapayService.processCallback(
      'success',
      mergedData(req)
    );
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
    const outcome = await uddoktapayService.processCallback(
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
    const outcome = await uddoktapayService.processCallback(
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

module.exports = {
  success,
  fail,
  cancel,
};
