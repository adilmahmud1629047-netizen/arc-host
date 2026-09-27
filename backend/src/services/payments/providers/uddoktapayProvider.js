const config = require('../../../config');
const {
  PaymentProvider,
  PaymentProviderError,
  notConfiguredError,
} = require('../paymentProvider');
const client = require('./uddoktapayClient');

// API docs: https://uddoktapay.readme.io/reference/create-charge-api-guideline
// Callback slugs under our public API prefix; URLs are built exclusively from
// APP_PUBLIC_URL (never Host/Origin/Referer).
const API_CALLBACK_SLUG = '/payments/uddoktapay';
const WEBHOOK_SLUG = '/payments/webhook/uddoktapay';

function providerError() {
  return new PaymentProviderError(
    502,
    'PAYMENT_PROVIDER_ERROR',
    'Payment provider is temporarily unavailable.'
  );
}

// Credentials + endpoint config, read at call time so tests and future
// config reloads are respected. Both the API base URL (location of the
// UddoktaPay installation) and the API key come only from the environment.
function getLiveConfig() {
  const cfg = config.payments.uddoktapay;
  if (!cfg) throw notConfiguredError();

  const apiKey = String(cfg.apiKey || '').trim();
  const baseUrl = String(cfg.baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!apiKey || !baseUrl) throw notConfiguredError();

  let parsedBase;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw notConfiguredError();
  }
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    throw notConfiguredError();
  }

  const publicUrl = String(cfg.publicUrl || '')
    .trim()
    .replace(/\/+$/, '');
  let parsedPublic;
  try {
    parsedPublic = new URL(publicUrl);
  } catch {
    throw notConfiguredError();
  }
  if (parsedPublic.protocol !== 'http:' && parsedPublic.protocol !== 'https:') {
    throw notConfiguredError();
  }

  return {
    apiKey,
    baseUrl,
    publicUrl,
    connectTimeoutMs: cfg.connectTimeoutMs,
    requestTimeoutMs: cfg.requestTimeoutMs,
  };
}

// The payment URL comes from an external API response — never trust it
// blindly. Allowed: any https URL on *.uddoktapay.com (sandbox and hosted
// domains), or an http(s) URL on the exact host of the server-configured
// baseUrl (lets sandbox tests use a local mock; baseUrl itself is env-only,
// never client-controlled).
function isTrustedPaymentUrl(paymentUrl, baseUrl) {
  let parsed;
  let base;
  try {
    parsed = new URL(paymentUrl);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const onUddoktapay =
    host === 'uddoktapay.com' || host.endsWith('.uddoktapay.com');
  const sameAsBase = parsed.host === base.host;
  if (!onUddoktapay && !sameAsBase) return false;
  if (parsed.protocol === 'https:') return true;
  // Plain HTTP only for a non-uddoktapay local/test endpoint matching baseUrl.
  return parsed.protocol === 'http:' && sameAsBase && !onUddoktapay;
}

function asString(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

// Verify/webhook payloads carry `metadata` as a JSON object (docs). Tolerate
// a JSON-encoded string; anything else (arrays, scalars) is not our object.
function normalizeMetadata(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // fall through — metadata is optional context, never payment truth
    }
  }
  return null;
}

function normalizeStatus(raw) {
  const status = String(raw || '').trim().toUpperCase();
  if (status === 'COMPLETED') return 'completed';
  if (status === 'PENDING') return 'pending';
  if (status === 'ERROR') return 'error';
  return null;
}

class UddoktapayProvider extends PaymentProvider {
  constructor() {
    super('uddoktapay');
  }

  async createPayment({ payment, order, customer }) {
    const cfg = getLiveConfig();
    if (!payment || !order || !order.id) throw providerError();

    const apiPrefix = config.apiPrefix || '/api';
    const callbackBase = `${cfg.publicUrl}${apiPrefix}${API_CALLBACK_SLUG}`;
    const cusName = String((customer && customer.name) || '').trim();
    const cusEmail = String((customer && customer.email) || '').trim();
    if (!cusEmail) throw providerError();

    // metadata is echoed back by the Verify Payment API and webhooks — it is
    // how a returned invoice_id is mapped to OUR payment row. String values,
    // exactly like the docs' samples ({order_id: "50"}).
    const payload = {
      full_name: cusName || 'Customer',
      email: cusEmail,
      amount: String(order.amount),
      metadata: {
        payment_id: String(payment.id),
        order_id: String(order.id),
      },
      redirect_url: `${callbackBase}/success`,
      return_type: 'GET',
      cancel_url: `${callbackBase}/cancel`,
      webhook_url: `${cfg.publicUrl}${apiPrefix}${WEBHOOK_SLUG}`,
    };

    const json = await client.postJson(
      `${cfg.baseUrl}/api/checkout-v2`,
      payload,
      cfg
    );
    if (!json || typeof json !== 'object') {
      throw client.attachDiagnostics(
        providerError(),
        { reason: 'bad-response' },
        '/api/checkout-v2'
      );
    }
    if (json.status !== true && json.status !== 'true') {
      // Documented error response {status:false, message}. Keep the customer
      // message generic; log a sanitized copy server-side.
      throw client.attachDiagnostics(
        providerError(),
        {
          reason: 'provider-status-false',
          providerMessage:
            client.sanitizeProviderMessage(json.message, cfg.apiKey) ||
            '(no message)',
        },
        '/api/checkout-v2'
      );
    }

    const paymentUrl =
      typeof json.payment_url === 'string' && json.payment_url
        ? json.payment_url
        : null;
    if (!paymentUrl || !isTrustedPaymentUrl(paymentUrl, cfg.baseUrl)) {
      let host = null;
      try {
        host = new URL(paymentUrl || '').hostname || null;
      } catch {
        host = paymentUrl ? '(unparseable url)' : '(missing)';
      }
      throw client.attachDiagnostics(
        providerError(),
        { reason: 'untrusted-payment-url', host },
        '/api/checkout-v2'
      );
    }

    return {
      status: 'pending',
      providerTransactionId: null,
      providerSessionKey: paymentUrl,
      gatewayUrl: paymentUrl,
    };
  }

  // Exact host of the configured API base URL — advertised to the checkout
  // via GET /api/payments/provider so its browser-side isSafeGatewayUrl
  // guard agrees with this file's isTrustedPaymentUrl rule. Host only (no
  // scheme, path, or credentials); derived from env config at call time.
  trustedGatewayHost() {
    const cfg = config.payments.uddoktapay;
    const raw = String((cfg && cfg.baseUrl) || '')
      .trim()
      .replace(/\/+$/, '');
    if (!raw) return null;
    try {
      return new URL(raw).host.toLowerCase();
    } catch {
      return null;
    }
  }

  // A retry (double-click / refresh) reuses the open gateway session instead
  // of creating a second one: the pending row's stored payment URL is
  // re-validated against the same trust rules as a fresh create response,
  // and requires the live configuration to still be present. Returns null
  // when the session cannot be safely reused — the caller then opens a new
  // attempt as before.
  reusePaymentSession({ payment }) {
    if (!payment || payment.status !== 'pending') return null;
    const stored = payment.provider_session_key || payment.providerSessionKey;
    if (typeof stored !== 'string' || !stored) return null;
    let cfg;
    try {
      cfg = getLiveConfig();
    } catch {
      return null; // provider disabled/unconfigured → no reuse, no URL leak
    }
    if (!isTrustedPaymentUrl(stored, cfg.baseUrl)) return null;
    return { gatewayUrl: stored };
  }

  // Server-side Verify Payment API — the only source of payment truth.
  async verifyPayment({ invoiceId }) {
    const cfg = getLiveConfig();
    if (typeof invoiceId !== 'string' || !invoiceId.trim()) {
      throw new PaymentProviderError(
        400,
        'PAYMENT_VERIFICATION_FAILED',
        'Payment verification failed.'
      );
    }

    const json = await client.postJson(
      `${cfg.baseUrl}/api/verify-payment`,
      { invoice_id: invoiceId.trim() },
      cfg
    );
    if (!json || typeof json !== 'object') {
      throw client.attachDiagnostics(
        providerError(),
        { reason: 'bad-response' },
        '/api/verify-payment'
      );
    }

    const status = normalizeStatus(json.status);
    if (!status) {
      throw client.attachDiagnostics(
        providerError(),
        {
          reason: 'provider-status-unusable',
          providerMessage:
            client.sanitizeProviderMessage(json.message, cfg.apiKey) ||
            '(no message)',
        },
        '/api/verify-payment'
      );
    }

    return {
      status,
      invoiceId: asString(json.invoice_id) || invoiceId.trim(),
      amount: asString(json.amount),
      fee: asString(json.fee),
      paymentMethod: asString(json.payment_method),
      senderNumber: asString(json.sender_number),
      transactionId: asString(json.transaction_id),
      date: asString(json.date),
      metadata: normalizeMetadata(json.metadata),
    };
  }

  // Generic webhook path — RT-UDDOKTAPAY-API-KEY header authentication, then
  // an authoritative Verify Payment API call (the payload alone never marks
  // anything paid).
  async handleWebhook({ headers, body }) {
    const uddoktapayService = require('../uddoktapayService');
    return uddoktapayService.processWebhook(headers || {}, body || {});
  }
}

module.exports = {
  UddoktapayProvider,
  isTrustedPaymentUrl,
  instance: new UddoktapayProvider(),
};
