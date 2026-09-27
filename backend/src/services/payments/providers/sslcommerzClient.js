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

function request(
  method,
  urlString,
  { query = null, body = null, connectTimeoutMs, requestTimeoutMs } = {}
) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      reject(providerUnavailableError());
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(providerUnavailableError());
      return;
    }
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const payload = body ? new URLSearchParams(body).toString() : null;
    const lib = url.protocol === 'https:' ? https : http;
    const headers = {
      Accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
      'User-Agent': 'FLARE-Hosting/1.0',
      Connection: 'close',
    };
    if (payload !== null) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

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
        method,
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
            finish(providerUnavailableError());
            return;
          }
          chunks.push(chunk);
        });
        res.on('aborted', () => finish(providerUnavailableError()));
        res.on('error', () => finish(providerUnavailableError()));
        res.on('end', () => {
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            finish(providerUnavailableError());
            return;
          }
          try {
            finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            finish(providerUnavailableError());
          }
        });
      }
    );

    absoluteTimer = setTimeout(() => {
      req.destroy();
      finish(providerUnavailableError());
    }, Number.isFinite(requestTimeoutMs)
      ? requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS);
    if (typeof absoluteTimer.unref === 'function') absoluteTimer.unref();

    req.on('timeout', () => {
      req.destroy();
      finish(providerUnavailableError());
    });
    req.on('error', () => finish(providerUnavailableError()));

    if (payload !== null) req.write(payload);
    req.end();
  });
}

// Session initiation: POST application/x-www-form-urlencoded, JSON response.
async function postForm(url, fields, timeouts = {}) {
  return request('POST', url, {
    body: fields,
    connectTimeoutMs: timeouts.connectTimeoutMs,
    requestTimeoutMs: timeouts.requestTimeoutMs,
  });
}

// Order Validation API: GET with query params, JSON response (format=json).
async function getJson(url, query, timeouts = {}) {
  return request('GET', url, {
    query,
    connectTimeoutMs: timeouts.connectTimeoutMs,
    requestTimeoutMs: timeouts.requestTimeoutMs,
  });
}

module.exports = {
  postForm,
  getJson,
  providerUnavailableError,
};
