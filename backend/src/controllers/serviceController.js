const { sendOk, sendError } = require('../utils/respond');
const provisioningService = require('../services/provisioning/provisioningService');

function isShapedError(err) {
  return !!(err && err.status && typeof err.code === 'string' && err.message);
}

function handleError(res, err) {
  if (isShapedError(err)) {
    return sendError(res, err.status, err.code, err.message, err.details);
  }
  return null;
}

// Read-only lifecycle view for the customer dashboard. Provisioning itself is
// NEVER triggered over HTTP — provisionOrder/suspend/terminate are internal
// trusted workflows only (no POST routes exist for them).
async function listServices(req, res, next) {
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

    const result = await provisioningService.listServices(userId, {
      page: req.query.page,
      limit: req.query.limit,
    });
    return sendOk(res, {
      services: result.services,
      pagination: result.pagination,
    });
  } catch (err) {
    const handled = handleError(res, err);
    if (handled) return handled;
    return next(err);
  }
}

module.exports = { listServices };
