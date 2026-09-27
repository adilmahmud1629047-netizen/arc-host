const { parseCookies } = require('../utils/cookies');
const { sendError } = require('../utils/respond');
const sessionService = require('../services/sessionService');
const { toSafeUser } = require('../services/authService');
const config = require('../config');

function getTokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[config.session.cookieName] || null;
}

// Admin-only gate: active session + role === 'admin'.
// 401 when unauthenticated / invalid session; 403 when non-admin or inactive.
async function requireAdmin(req, res, next) {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    const row = await sessionService.findSessionUser(token);
    if (!row) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    }

    if (row.status !== 'active') {
      return sendError(res, 403, 'ACCOUNT_DISABLED', 'This account is not active.');
    }

    if (row.role !== 'admin') {
      return sendError(res, 403, 'FORBIDDEN', 'Administrator access required.');
    }

    req.user = toSafeUser(row);
    req.sessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

// Admin foundation endpoints are GET-only and must not accept a JSON body.
function rejectUnexpectedBody(req, res, next) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    const keys = Object.keys(req.body);
    if (keys.length > 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Request body is not allowed.', [
        'Remove the request body.',
      ]);
    }
  }
  next();
}

module.exports = { requireAdmin, rejectUnexpectedBody };
