const config = require('../../../config');
const {
  SmsProvider,
  notConfiguredError,
  providerError,
} = require('../smsProvider');

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// TextBee official REST API (https://textbee.dev/docs/api-reference):
//   POST {baseUrl}/gateway/send-sms   header: x-api-key
//   body: { recipients, message, deviceId?, simSubscriptionId? }
//
// Implemented with direct fetch instead of @textbee/sdk v0.2.0 because the SDK
// exposes no AbortSignal/timeout option, and every external SMS request here
// must be bounded by SMS_REQUEST_TIMEOUT_MS. Same official endpoint, same
// x-api-key authentication, zero new dependencies, full timeout control.
//
// The API key is read from the environment only: never returned, never logged,
// never placed in a message, and only ever sent as the x-api-key header over
// HTTPS (plain http is allowed solely for localhost test mocks).
class TextbeeProvider extends SmsProvider {
  constructor() {
    super('textbee');
  }

  // Resolved fresh per call so tests can vary config without reloading modules.
  getLiveConfig() {
    const t = config.sms.textbee;
    if (!t.apiKey) throw notConfiguredError();

    let url;
    try {
      url = new URL(`${t.baseUrl}/gateway/send-sms`);
    } catch {
      throw notConfiguredError();
    }
    const isHttps = url.protocol === 'https:';
    const isLocal = LOCAL_HOSTNAMES.has(url.hostname);
    if (!isHttps && !isLocal) {
      // Refuse to send the API key over plain http to a non-local host.
      throw notConfiguredError();
    }

    return {
      apiKey: t.apiKey,
      url: url.toString(),
      timeoutMs: Number.isFinite(t.timeoutMs) && t.timeoutMs > 0
        ? t.timeoutMs
        : DEFAULT_TIMEOUT_MS,
      deviceId: t.deviceId || null,
      simSubscriptionId:
        Number.isInteger(t.simSubscriptionId) && t.simSubscriptionId > 0
          ? t.simSubscriptionId
          : null,
    };
  }

  async sendSms({ recipients, message, deviceId, simSubscriptionId } = {}) {
    const cfg = this.getLiveConfig();

    const body = { recipients, message };
    const resolvedDevice =
      typeof deviceId === 'string' && deviceId ? deviceId : cfg.deviceId;
    if (resolvedDevice) body.deviceId = resolvedDevice;
    const resolvedSim =
      Number.isInteger(simSubscriptionId) && simSubscriptionId > 0
        ? simSubscriptionId
        : cfg.simSubscriptionId;
    if (resolvedSim !== null) body.simSubscriptionId = resolvedSim;

    let response;
    try {
      response = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-key': cfg.apiKey,
          'User-Agent': 'FLARE-Hosting/1.0',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
        redirect: 'error',
      });
    } catch {
      // Timeout, DNS, connection refused, TLS failure — one safe error.
      throw providerError();
    }

    if (!response.ok) {
      // 400 / 401 / 404 / 429 / 5xx: never read the body into our error.
      throw providerError();
    }

    let text;
    try {
      text = await response.text();
    } catch {
      throw providerError();
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw providerError();
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw providerError();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw providerError();
    }
    const data =
      parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
        ? parsed.data
        : parsed;
    if (data.success === false) throw providerError();

    return {
      provider: 'textbee',
      status: 'accepted',
      providerMessageId:
        typeof data._id === 'string' && data._id ? data._id : null,
      providerBatchId:
        typeof data.smsBatchId === 'string' && data.smsBatchId
          ? data.smsBatchId
          : null,
      recipientCount:
        Number.isInteger(data.recipientCount) && data.recipientCount >= 0
          ? data.recipientCount
          : Array.isArray(recipients)
            ? recipients.length
            : 0,
    };
  }

  // Delivery status arrives via future signed webhooks / batch polling — not
  // implemented in this step (sending only). Never claims delivery.
  async getStatus() {
    return { supported: false, status: 'unknown' };
  }
}

module.exports = {
  TextbeeProvider,
  instance: new TextbeeProvider(),
};
