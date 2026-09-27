const config = require('../../../config');
const {
  PaymentProvider,
  PaymentProviderError,
  notConfiguredError,
} = require('../paymentProvider');
const client = require('./sslcommerzClient');

const API_CALLBACK_SLUG = '/payments/sslcommerz';

function providerError() {
  return new PaymentProviderError(
    502,
    'PAYMENT_PROVIDER_ERROR',
    'Payment provider is temporarily unavailable.'
  );
}

// Credentials + sandbox-only config, read at call time so tests and future
// config reloads are respected. Live/production mode is intentionally
// refused: this integration only supports the SSLCommerz sandbox.
function getLiveConfig() {
  const cfg = config.payments.sslcommerz;
  if (!cfg) throw notConfiguredError();

  const storeId = String(cfg.storeId || '').trim();
  const storePassword = String(cfg.storePassword || '').trim();
  if (!storeId || !storePassword) throw notConfiguredError();
  if ((cfg.mode || 'sandbox').trim().toLowerCase() !== 'sandbox') {
    throw notConfiguredError();
  }

  const baseUrl = String(cfg.baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  const validationUrl = String(cfg.validationUrl || '').trim();
  if (!baseUrl || !validationUrl) throw notConfiguredError();

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
    storeId,
    storePassword,
    baseUrl,
    validationUrl,
    publicUrl,
    connectTimeoutMs: cfg.connectTimeoutMs,
    requestTimeoutMs: cfg.requestTimeoutMs,
  };
}

// The gateway URL comes from an external API response — never trust it
// blindly. Allowed: any https URL on *.sslcommerz.com, or an http(s) URL on
// the exact host of the server-configured baseUrl (lets sandbox tests use a
// local endpoint; baseUrl itself is env-only, never client-controlled).
function isTrustedGatewayUrl(gatewayUrl, baseUrl) {
  let parsed;
  let base;
  try {
    parsed = new URL(gatewayUrl);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const onSslcommerz = host === 'sslcommerz.com' || host.endsWith('.sslcommerz.com');
  const sameAsBase = parsed.host === base.host;
  if (!onSslcommerz && !sameAsBase) return false;
  if (parsed.protocol === 'https:') return true;
  // Plain HTTP only for a non-sslcommerz local/test endpoint matching baseUrl.
  return parsed.protocol === 'http:' && sameAsBase && !onSslcommerz;
}

function pickGatewayUrl(json) {
  for (const key of Object.keys(json)) {
    if (key.toLowerCase() === 'gatewaypageurl') {
      const value = json[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return null;
}

function normalizeValidationStatus(raw) {
  const status = String(raw || '').toUpperCase();
  if (status === 'VALID' || status === 'VALIDATED') return 'valid';
  if (status === 'FAILED') return 'failed';
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'EXPIRED') return 'expired';
  if (status === 'UNATTEMPTED') return 'unattempted';
  return 'unknown';
}

function asString(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

class SslcommerzProvider extends PaymentProvider {
  constructor() {
    super('sslcommerz');
  }

  // Exact host of the configured gateway base URL — advertised to the
  // checkout via GET /api/payments/provider so the browser-side
  // isSafeGatewayUrl guard agrees with this file's isTrustedGatewayUrl
  // rule. Host only (no scheme, path, or credentials); env config only.
  trustedGatewayHost() {
    const cfg = config.payments.sslcommerz;
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

  async createPayment({ payment, order, customer }) {
    const cfg = getLiveConfig();
    if (!payment || !order || !order.id) throw providerError();

    // Merchant transaction id (SSLCommerz max 30 chars): our own payment id,
    // stored on the payment row at initiation so callbacks can look it up.
    const tranId = 'FLR' + String(payment.id).replace(/-/g, '').slice(0, 27);
    const apiPrefix = config.apiPrefix || '/api';
    const callbackBase = `${cfg.publicUrl}${apiPrefix}${API_CALLBACK_SLUG}`;
    const cusName = String((customer && customer.name) || 'Customer')
      .trim()
      .slice(0, 60);
    const cusEmail = String((customer && customer.email) || '').trim();

    const fields = {
      store_id: cfg.storeId,
      store_passwd: cfg.storePassword,
      total_amount: String(order.amount),
      currency: String(order.currency),
      tran_id: tranId,
      success_url: `${callbackBase}/success`,
      fail_url: `${callbackBase}/fail`,
      cancel_url: `${callbackBase}/cancel`,
      ipn_url: `${callbackBase}/ipn`,
      shipping_method: 'NO',
      product_name: `FLARE order ${order.orderNumber || order.id}`.slice(0, 250),
      product_category:
        order.productType === 'vps' ? 'vps' : 'hosting',
      product_profile: 'non-physical-goods',
      cus_name: cusName || 'Customer',
      cus_email: cusEmail,
      cus_add1: 'N/A',
      cus_city: 'N/A',
      cus_country: 'Bangladesh',
      cus_phone: 'N/A',
      value_a: order.id,
    };

    const json = await client.postForm(
      `${cfg.baseUrl}/gwprocess/v4/api.php`,
      fields,
      cfg
    );

    const status =
      json && typeof json.status === 'string' ? json.status.toUpperCase() : '';
    if (status !== 'SUCCESS') throw providerError();

    const gatewayUrl = pickGatewayUrl(json);
    if (!gatewayUrl || !isTrustedGatewayUrl(gatewayUrl, cfg.baseUrl)) {
      throw providerError();
    }

    return {
      status: 'pending',
      providerTransactionId: tranId,
      providerSessionKey: gatewayUrl,
      gatewayUrl,
    };
  }

  // Server-to-server Order Validation API — the only source of payment truth.
  async verifyPayment({ valId }) {
    const cfg = getLiveConfig();
    if (typeof valId !== 'string' || !valId.trim()) {
      throw new PaymentProviderError(
        400,
        'PAYMENT_VERIFICATION_FAILED',
        'Payment verification failed.'
      );
    }

    const json = await client.getJson(
      cfg.validationUrl,
      {
        val_id: valId.trim(),
        store_id: cfg.storeId,
        store_passwd: cfg.storePassword,
        format: 'json',
      },
      cfg
    );
    if (!json || typeof json !== 'object') throw providerError();

    return {
      status: normalizeValidationStatus(json.status),
      rawStatus: asString(json.status),
      valId: asString(json.val_id) || valId.trim(),
      tranId: asString(json.tran_id) || '',
      bankTranId: asString(json.bank_tran_id),
      amount: asString(json.amount),
      currency: asString(json.currency),
      valueA: asString(json.value_a),
      riskLevel: asString(json.risk_level),
      riskFlag: asString(json.risk_flag),
    };
  }

  // Generic webhook path — delegates to the same IPN processing as the
  // dedicated /sslcommerz/ipn callback (validation API is the trust boundary).
  async handleWebhook({ body }) {
    const sslcommerzService = require('../sslcommerzService');
    return sslcommerzService.processIpn(body || {});
  }
}

module.exports = {
  SslcommerzProvider,
  isTrustedGatewayUrl,
  instance: new SslcommerzProvider(),
};
