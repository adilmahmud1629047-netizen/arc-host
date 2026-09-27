const path = require('path');
const express = require('express');
const config = require('./config');
const apiRoutes = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const securityHeaders = require('./utils/securityHeaders');

const app = express();
const FRONTEND_DIR = path.join(__dirname, '../../frontend');

// Explicit allowlist of public clean pages. Files are never taken from req.path —
// only fixed basenames from this map are resolved under FRONTEND_DIR.
const PUBLIC_PAGES = Object.freeze({
  '/': 'index.html',
  '/web-hosting': 'web-hosting.html',
  '/vps-hosting': 'vps-hosting.html',
  '/minecraft-hosting': 'minecraft-hosting.html',
  '/about': 'about.html',
  '/faq': 'faq.html',
  '/contact': 'contact.html',
  '/login': 'login.html',
  '/register': 'register.html',
  '/dashboard': 'dashboard.html',
  '/checkout': 'checkout.html',
  '/payment-success': 'payment-success.html',
  '/payment-failed': 'payment-failed.html',
  '/payment-cancelled': 'payment-cancelled.html',
});

// Admin clean pages (files under frontend/admin/). No .html canonical URLs.
const ADMIN_PAGES = Object.freeze({
  '/admin/login': 'admin/login.html',
  '/admin/dashboard': 'admin/dashboard.html',
  '/admin/orders': 'admin/orders.html',
  '/admin/customers': 'admin/customers.html',
  '/admin/payments': 'admin/payments.html',
  '/admin/products': 'admin/products.html',
});

// Admin detail deep-links (UUID path params — not part of the static page map).
const ADMIN_ORDER_DETAIL_PATTERN =
  /^\/admin\/orders\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ADMIN_CUSTOMER_DETAIL_PATTERN =
  /^\/admin\/customers\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Old .html URLs → permanent redirects to clean paths (SEO / no duplicate content).
const HTML_TO_CLEAN = Object.freeze({
  '/index.html': '/',
  '/web-hosting.html': '/web-hosting',
  '/vps-hosting.html': '/vps-hosting',
  '/minecraft-hosting.html': '/minecraft-hosting',
  '/about.html': '/about',
  '/faq.html': '/faq',
  '/contact.html': '/contact',
  '/login.html': '/login',
  '/register.html': '/register',
  '/dashboard.html': '/dashboard',
  '/checkout.html': '/checkout',
  '/payment-success.html': '/payment-success',
  '/payment-failed.html': '/payment-failed',
  '/payment-cancelled.html': '/payment-cancelled',
  '/admin/index.html': '/admin/dashboard',
  '/admin/login.html': '/admin/login',
  '/admin/dashboard.html': '/admin/dashboard',
  '/admin/orders.html': '/admin/orders',
  '/admin/customers.html': '/admin/customers',
  '/admin/payments.html': '/admin/payments',
  '/admin/products.html': '/admin/products',
});

function queryOf(originalUrl) {
  const idx = originalUrl.indexOf('?');
  return idx === -1 ? '' : originalUrl.slice(idx);
}

function permanentRedirect(req, res, target) {
  // 301 for GET/HEAD; preserves query string on the clean destination.
  res.redirect(301, target + queryOf(req.originalUrl));
}

app.disable('x-powered-by');

if (config.isProduction) {
  app.set('trust proxy', 1);
}

app.use(securityHeaders);
// Capture raw body for TextBee webhook HMAC verification (X-Signature is over
// the exact bytes TextBee sent — not a re-serialized object).
const TEXTBEE_WEBHOOK_PATH = '/api/webhooks/textbee/sms';
app.use(
  express.json({
    limit: '16kb',
    verify: (req, res, buf) => {
      if (req.path === TEXTBEE_WEBHOOK_PATH) {
        req.rawBody = Buffer.from(buf);
      }
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '16kb' }));

// Page-only clean URL redirects. Never touches /api/*, /css/*, /js/*, assets.
// Must run before express.static so .html files are not served as 200 duplicates.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path;

  if (Object.prototype.hasOwnProperty.call(HTML_TO_CLEAN, p)) {
    return permanentRedirect(req, res, HTML_TO_CLEAN[p]);
  }

  // Canonical form has no trailing slash: /minecraft-hosting/ → /minecraft-hosting
  if (p.length > 1 && p.endsWith('/')) {
    const bare = p.replace(/\/+$/, '');
    if (
      Object.prototype.hasOwnProperty.call(PUBLIC_PAGES, bare) ||
      Object.prototype.hasOwnProperty.call(ADMIN_PAGES, bare) ||
      bare === '/admin'
    ) {
      return permanentRedirect(req, res, bare);
    }
  }

  next();
});

// API responses must never be cached by the browser or intermediaries.
// A cached 401 on /api/auth/me (or a stale 200 after logout) would make a
// valid session appear logged out after refresh/navigation.
app.use(config.apiPrefix, (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  next();
});

// API routes stay before page fallbacks.
app.use(config.apiPrefix, apiRoutes);

// TEST-ONLY: clears in-memory rate-limiter counters between tests so the suite
// never has to raise production limits or wait out a limiter window.
// Registered ONLY when NODE_ENV=test, answers ONLY loopback callers, and
// changes no limit, window, default or middleware chain.
if (config.env === 'test') {
  const { resetAllRateLimiters } = require('./utils/rateLimiter');
  const { sendError } = require('./utils/respond');
  const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

  app.post(`${config.apiPrefix}/_test/reset-rate-limits`, (req, res) => {
    if (!LOOPBACK_IPS.has(req.ip)) {
      return sendError(
        res,
        403,
        'FORBIDDEN',
        'Test hook is loopback-only.'
      );
    }
    resetAllRateLimiters();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Cookie');
    return res.status(200).json({ success: true, data: { reset: true } });
  });

  // TEST-ONLY: clears the in-memory plan catalog cache so fixtures that write
  // plans directly (test process) become visible to this server immediately
  // instead of waiting out the catalog TTL. Same guards as above.
  app.post(`${config.apiPrefix}/_test/reset-plan-cache`, (req, res) => {
    if (!LOOPBACK_IPS.has(req.ip)) {
      return sendError(
        res,
        403,
        'FORBIDDEN',
        'Test hook is loopback-only.'
      );
    }
    require('./services/planService').invalidateCache();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Cookie');
    return res.status(200).json({ success: true, data: { reset: true } });
  });
}

// Clean public pages (allowlisted basenames only — no path traversal).
for (const [route, file] of Object.entries(PUBLIC_PAGES)) {
  app.get(route, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, file));
  });
}

// Admin root → dashboard (login gate lives in the dashboard client).
app.get('/admin', (req, res) => {
  permanentRedirect(req, res, '/admin/dashboard');
});

// Admin order detail deep-link (UUID validated before sendFile).
app.get('/admin/orders/:id', (req, res, next) => {
  const match = String(req.path).match(ADMIN_ORDER_DETAIL_PATTERN);
  if (!match) {
    return next();
  }
  res.sendFile(path.join(FRONTEND_DIR, 'admin/order-detail.html'));
});

// Admin customer detail deep-link (UUID validated before sendFile).
app.get('/admin/customers/:id', (req, res, next) => {
  const match = String(req.path).match(ADMIN_CUSTOMER_DETAIL_PATTERN);
  if (!match) {
    return next();
  }
  res.sendFile(path.join(FRONTEND_DIR, 'admin/customer-detail.html'));
});

// Clean admin pages (allowlisted under frontend/admin/).
for (const [route, file] of Object.entries(ADMIN_PAGES)) {
  app.get(route, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, file));
  });
}

// Static assets: /css/*, /js/*, /images/*, /admin/css/*, /admin/js/*, favicon, etc.
// index: false — "/" and "/admin" are owned by the clean routes above.
app.use(express.static(FRONTEND_DIR, { index: false }));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
