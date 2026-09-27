const express = require('express');
const textbeeWebhookController = require('../controllers/textbeeWebhookController');
const { createRateLimiter } = require('../utils/rateLimiter');

const router = express.Router();

// Server-to-server: signature auth + body cap + light provider-aware throttle.
// Not the customer-session limiter (no cookie / IP flood assumptions).
const textbeeWebhookLimiter = createRateLimiter({
  name: 'textbee-webhook',
  windowMs:
    parseInt(process.env.TEXTBEE_WEBHOOK_RATE_LIMIT_WINDOW_MS, 10) || 60000,
  max: parseInt(process.env.TEXTBEE_WEBHOOK_RATE_LIMIT_MAX, 10) || 120,
});

router.post(
  '/textbee/sms',
  textbeeWebhookLimiter,
  textbeeWebhookController.receiveSms
);

module.exports = router;
