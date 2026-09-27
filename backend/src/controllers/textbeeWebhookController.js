const { sendOk, sendError } = require('../utils/respond');
const {
  handleIncomingSms,
  WebhookError,
} = require('../services/sms/textbeeWebhook');

// POST /api/webhooks/textbee/sms — TextBee server-to-server webhook.
// No session / CSRF / same-origin: authenticity is the HMAC X-Signature.
async function receiveSms(req, res) {
  try {
    const result = await handleIncomingSms(req.rawBody, req.get('x-signature'));
    sendOk(res, result);
  } catch (err) {
    if (err instanceof WebhookError) {
      return sendError(res, err.status, err.code, err.message);
    }
    return sendError(res, 500, 'INTERNAL_ERROR', 'Webhook processing failed.');
  }
}

module.exports = { receiveSms };
