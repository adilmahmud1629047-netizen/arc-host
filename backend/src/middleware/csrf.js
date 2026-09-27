const { sendError } = require('../utils/respond');

// Same-origin guard for state-changing requests (login/logout/register/orders).
// Requests without Origin (same-origin form/fetch from browsers that omit it)
// are allowed; cross-origin Origins must match the Host header.
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

module.exports = { requireSameOrigin };
