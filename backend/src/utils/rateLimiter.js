const { sendError } = require('./respond');

// Every limiter built by this factory is registered here so a TEST-ONLY hook
// can clear in-memory counters between tests. Nothing in production calls
// resetAllRateLimiters(); limits, windows and defaults are untouched.
const registry = new Set();

function resetAllRateLimiters() {
  for (const limiter of registry) {
    limiter.reset();
  }
}

function createRateLimiter({ windowMs, max, name }) {
  const hits = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) {
        hits.delete(key);
      }
    }
  }, Math.max(windowMs, 60000));
  cleanup.unref();

  function middleware(req, res, next) {
    const now = Date.now();
    const key = `${name}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((entry.resetAt - now) / 1000)
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return sendError(
        res,
        429,
        'RATE_LIMITED',
        'Too many requests. Please try again later.'
      );
    }

    next();
  }

  middleware.reset = () => hits.clear();
  middleware.name = name;
  registry.add(middleware);

  return middleware;
}

module.exports = { createRateLimiter, resetAllRateLimiters };
