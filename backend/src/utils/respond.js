function sendOk(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details && details.length > 0) {
    error.details = details;
  }
  return res.status(status).json({ success: false, error });
}

module.exports = { sendOk, sendError };
