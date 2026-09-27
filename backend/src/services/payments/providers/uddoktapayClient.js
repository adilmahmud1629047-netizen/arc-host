const http = require('http');
const https = require('https');
const { URL } = require('url');
const { PaymentProviderError } = require('../paymentProvider');

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

// Single safe error for every transport/parse/timeout problem. The upstream
// body is never echoed back — the gateway may include sensitive fields.
function providerUnavailableError() {
  return new PaymentProviderError(
    502,
    'PAYMENT_PROVIDER_ERROR',
    'Payment provider is temporarily unavailable.'
  );
}

// The documented error body is {status:false, message:"..."} (see
// create-charge-api-guideline). Extract ONLY that message field, replace
// control characters, scrub the API key defensively, and cap the length.
// Returns null when there is nothing safe to report.
function sanitizeProviderMessage(raw, apiKey) {
  if (typeof raw !== 'string') return null;
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  out = out.trim();
  if (apiKey && apiKey.length >= 8) {
    out = out.split(apiKey).join('<<redacted>>');
  }
  out = out.slice(0, 200);
  return out || null;
}

// Attach server-side-only diagnostics to the safe customer-facing error.
// `details` is deliberately never set — sendError() would forward it to the
// browser. The same single line is written to the server log (never the key,
// never the raw upstream body) so operators can see the real HTTP status /
// provider message behind the generic 502.
function attachDiagnostics(err, diagnostics, endpoint) {
  if (!err || typeof err !== 'object') return err;
  const info = Object.assign({ endpoint: endpoint || null }, diagnostics || {});
  err.diagnostics = info;
  const parts = Object.keys(info)
    .filter((k) => info[k] !== null && info[k] !== undefined)
    .map((k) => k + '=' + JSON.stringify(String(info[k])));
  try {
    console.error('[uddoktapay] ' + parts.join(' '));
  } catch {
    // logging must never break the payment flow
  }
  return err;
}

// POST JSON to a UddoktaPay API endpoint with the RT-UDDOKTAPAY-API-KEY
// header (https://uddoktapay.readme.io/reference/create-charge-api-guideline).
// The key never leaves the server: it is only ever sent as a request header
// to the configured gateway base URL.
function postJson(urlString, payload, { apiKey, connectTimeoutMs, requestTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      reject(
        attachDiagnostics(providerUnavailableError(), { reason: 'bad-url' }, null)
      );
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(
        attachDiagnostics(providerUnavailableError(), { reason: 'bad-url' }, null)
      );
      return;
    }
    if (typeof apiKey !== 'string' || !apiKey) {
      reject(
        attachDiagnostics(
          providerUnavailableError(),
          { reason: 'missing-api-key' },
          url.pathname
        )
      );
      return;
    }

    let data;
    try {
      data = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    } catch {
      reject(
        attachDiagnostics(
          providerUnavailableError(),
          { reason: 'bad-payload' },
          url.pathname
        )
      );
      return;
    }

    // Customer-facing error stays the generic 502; the reason (and, for
    // non-2xx, the documented `message` field) is attached server-side only.
    // Guarded so one request never logs twice (destroy() can emit several
    // events for the same failure).
    const fail = (reason, extra) => {
      if (settled) return;
      const diagnostics = Object.assign({ reason }, extra || {});
      finish(attachDiagnostics(providerUnavailableError(), diagnostics, url.pathname));
    };

    const lib = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'RT-UDDOKTAPAY-API-KEY': apiKey,
      'User-Agent': 'FLARE-Hosting/1.0',
      Connection: 'close',
      'Content-Length': String(data.length),
    };

    let settled = false;
    let absoluteTimer = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (absoluteTimer) clearTimeout(absoluteTimer);
      if (err) reject(err);
      else resolve(value);
    };

    const req = lib.request(
      url,
      {
        method: 'POST',
        headers,
        timeout: Number.isFinite(connectTimeoutMs)
          ? connectTimeoutMs
          : DEFAULT_CONNECT_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            fail('response-too-large', { httpStatus: res.statusCode || null });
            return;
          }
          chunks.push(chunk);
        });
        res.on('aborted', () => fail('aborted', { httpStatus: res.statusCode || null }));
        res.on('error', () => fail('connection', { httpStatus: res.statusCode || null }));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            // Documented error shape: {status:false, message:"..."} — surface
            // the message (sanitized) to the server log, never to the client.
            let providerMessage = null;
            try {
              const parsed = JSON.parse(bodyText);
              providerMessage = sanitizeProviderMessage(
                parsed && typeof parsed.message === 'string' ? parsed.message : null,
                apiKey
              );
            } catch {
              // non-JSON error body (HTML error page etc.) — nothing safe to extract
            }
            fail('http-status', {
              httpStatus: res.statusCode,
              providerMessage: providerMessage || '(no json message)',
            });
            return;
          }
          let parsedBody;
          try {
            parsedBody = JSON.parse(bodyText);
          } catch {
            fail('invalid-json', { httpStatus: res.statusCode });
            return;
          }
          finish(null, parsedBody);
        });
      }
    );

    absoluteTimer = setTimeout(() => {
      req.destroy();
      fail('timeout', { timeoutMs: requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS });
    }, Number.isFinite(requestTimeoutMs)
      ? requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS);
    if (typeof absoluteTimer.unref === 'function') absoluteTimer.unref();

    req.on('timeout', () => {
      req.destroy();
      fail('timeout', { timeoutMs: connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS });
    });
    req.on('error', () => fail('connection'));

    req.write(data);
    req.end();
  });
}

module.exports = {
  postJson,
  providerUnavailableError,
  sanitizeProviderMessage,
  attachDiagnostics,
};
