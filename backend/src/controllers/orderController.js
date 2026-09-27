const { sendOk, sendError } = require('../utils/respond');
const orderService = require('../services/orderService');

function handleError(res, err) {
  if (err instanceof orderService.OrderError) {
    return sendError(res, err.status, err.code, err.message, err.details);
  }
  // unexpected errors go to global handler via next — but controller catches
  return null;
}

async function createOrder(req, res, next) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    const { productType, planSlug } = req.body || {};
    const idempotencyKey = req.headers['idempotency-key'];

    const result = await orderService.createOrder(
      userId,
      { productType, planSlug },
      { idempotencyKey }
    );

    return sendOk(res, result.order, result.reused ? 200 : 201);
  } catch (err) {
    const handled = handleError(res, err);
    if (handled) return handled;
    return next(err);
  }
}

async function listOrders(req, res, next) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    const page = req.query.page;
    const limit = req.query.limit;

    // reject unexpected query params
    const allowed = new Set(['page', 'limit']);
    for (const key of Object.keys(req.query)) {
      if (!allowed.has(key)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `Unexpected query parameter: ${key}.`,
        ]);
      }
    }

    const result = await orderService.listOrders(userId, { page, limit });
    return sendOk(res, {
      orders: result.orders,
      pagination: result.pagination,
    });
  } catch (err) {
    const handled = handleError(res, err);
    if (handled) return handled;
    return next(err);
  }
}

async function getOrder(req, res, next) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    const order = await orderService.getOrder(userId, req.params.id);
    return sendOk(res, order);
  } catch (err) {
    const handled = handleError(res, err);
    if (handled) return handled;
    return next(err);
  }
}

async function getBkashInstructions(req, res, next) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    // Read-only: values come from config + the persisted order row. Request
    // query/body input is deliberately ignored — instructions are never
    // client-supplied and no payment/order state is touched here.
    const instructions = await orderService.getBkashInstructions(
      userId,
      req.params.id
    );
    return sendOk(res, instructions);
  } catch (err) {
    const handled = handleError(res, err);
    if (handled) return handled;
    return next(err);
  }
}

module.exports = { createOrder, listOrders, getOrder, getBkashInstructions };
