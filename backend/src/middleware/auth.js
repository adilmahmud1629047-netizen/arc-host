const config = require('../config');
const { parseCookies } = require('../utils/cookies');
const { sendError } = require('../utils/respond');
const sessionService = require('../services/sessionService');
const { toSafeUser } = require('../services/authService');

function getTokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[config.session.cookieName] || null;
}

async function optionalAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      req.user = null;
      return next();
    }

    const row = await sessionService.findSessionUser(token);
    if (!row || row.status !== 'active') {
      req.user = null;
      return next();
    }

    req.user = toSafeUser(row);
    req.sessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

async function requireAuth(req, res, next) {
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

    req.user = toSafeUser(row);
    req.sessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, optionalAuth, getTokenFromRequest };
