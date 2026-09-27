const config = require('../config');

const CODE_BY_STATUS = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
};

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  // Order/service errors carry their own code + safe message
  if (err.status && err.code && typeof err.code === 'string' && err.message) {
    const details = Array.isArray(err.details) ? err.details : undefined;
    const payload = {
      success: false,
      error: { code: err.code, message: err.message },
    };
    if (details && details.length > 0) {
      payload.error.details = details;
    }
    res.status(err.status).json(payload);
    return;
  }

  let statusCode = err.statusCode || err.status || 500;

  if (err.type === 'entity.parse.failed') {
    statusCode = 400;
  } else if (err.type === 'entity.too.large') {
    statusCode = 413;
  }

  let code = CODE_BY_STATUS[statusCode] || 'INTERNAL_ERROR';
  if (
    statusCode < 500 &&
    typeof err.code === 'string' &&
    /^[A-Z][A-Z_]*$/.test(err.code)
  ) {
    code = err.code;
  }

  let message;
  if (statusCode === 400 && err.type === 'entity.parse.failed') {
    message = 'Invalid JSON payload.';
  } else if (statusCode >= 500) {
    message =
      config.env === 'production' ? 'Internal server error' : 'Something went wrong';
  } else {
    message = err.message || 'Request failed.';
  }

  if (statusCode >= 500) {
    console.error(err);
  } else if (
    err.code === 'INVALID_CREDENTIALS' ||
    err.code === 'ACCOUNT_DISABLED'
  ) {
    console.warn(`Auth failure: ${err.code} on ${req.method} ${req.path}`);
  }

  res.status(statusCode).json({
    success: false,
    error: { code, message },
  });
}

module.exports = errorHandler;
