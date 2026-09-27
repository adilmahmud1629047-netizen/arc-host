const express = require('express');
const config = require('../config');
const authController = require('../controllers/authController');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { validateRegister, validateLogin } = require('../middleware/validation');
const { createRateLimiter } = require('../utils/rateLimiter');
const { requireSameOrigin } = require('../middleware/csrf');

const router = express.Router();

const registerLimiter = createRateLimiter({
  name: 'register',
  windowMs: config.rateLimit.registerWindowMs,
  max: config.rateLimit.registerMax,
});

const loginLimiter = createRateLimiter({
  name: 'login',
  windowMs: config.rateLimit.loginWindowMs,
  max: config.rateLimit.loginMax,
});

router.post(
  '/register',
  requireSameOrigin,
  registerLimiter,
  validateRegister,
  authController.register
);

router.post(
  '/login',
  requireSameOrigin,
  loginLimiter,
  validateLogin,
  authController.login
);

router.get('/me', requireAuth, authController.me);

router.post('/logout', requireSameOrigin, optionalAuth, authController.logout);

module.exports = router;
module.exports.registerLimiter = registerLimiter;
module.exports.loginLimiter = loginLimiter;
