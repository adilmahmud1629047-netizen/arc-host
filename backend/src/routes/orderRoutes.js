const express = require('express');
const config = require('../config');
const orderController = require('../controllers/orderController');
const { requireAuth } = require('../middleware/auth');
const { requireSameOrigin } = require('../middleware/csrf');
const { validateBody } = require('../middleware/validation');
const { createRateLimiter } = require('../utils/rateLimiter');

const router = express.Router();

const createOrderLimiter = createRateLimiter({
  name: 'order-create',
  windowMs: config.rateLimit.orderCreateWindowMs,
  max: config.rateLimit.orderCreateMax,
});

const createOrderRules = {
  productType: {
    label: 'Product type',
    required: true,
    trim: true,
    min: 1,
    max: 20,
    validate: (value) =>
      value === 'hosting' || value === 'vps'
        ? null
        : 'Product type must be "hosting" or "vps".',
  },
  planSlug: {
    label: 'Plan slug',
    required: true,
    trim: true,
    min: 1,
    max: 100,
    pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
    patternMessage:
      'Plan slug must contain only lowercase letters, digits, and hyphens.',
  },
};

router.post(
  '/',
  requireSameOrigin,
  requireAuth,
  createOrderLimiter,
  validateBody(createOrderRules),
  orderController.createOrder
);

router.get('/', requireAuth, orderController.listOrders);

router.get('/:id/bkash-instructions', requireAuth, orderController.getBkashInstructions);

router.get('/:id', requireAuth, orderController.getOrder);

module.exports = router;
module.exports.createOrderLimiter = createOrderLimiter;
