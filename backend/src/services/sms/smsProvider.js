// Shared SMS error shape — mirrors PaymentProviderError so the global error
// handler serializes {status, code, message} into the standard API envelope.
// Messages are always safe to expose: no provider bodies, no credentials.
class SmsError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notConfiguredError() {
  return new SmsError(
    503,
    'SMS_PROVIDER_NOT_CONFIGURED',
    'SMS sending is not available yet.'
  );
}

// Single safe error for every transport/timeout/HTTP/parse problem. The
// upstream response body is never echoed back — it may contain sensitive data.
function providerError() {
  return new SmsError(
    502,
    'SMS_PROVIDER_ERROR',
    'SMS provider is temporarily unavailable.'
  );
}

class SmsProvider {
  constructor(name) {
    this.name = name;
  }

  async sendSms() {
    throw new SmsError(
      501,
      'SMS_PROVIDER_UNSUPPORTED',
      'This SMS provider cannot send messages.'
    );
  }

  async getStatus() {
    throw new SmsError(
      501,
      'SMS_PROVIDER_UNSUPPORTED',
      'This SMS provider cannot look up message status.'
    );
  }
}

// Registry of SMS providers. Lazy require keeps provider modules isolated and
// avoids circular imports (same pattern as paymentProvider.js).
const REGISTRY = {
  disabled: () => require('./providers/disabledSmsProvider'),
  textbee: () => require('./providers/textbeeProvider'),
};

function getProvider(name) {
  if (typeof name !== 'string' || name === '') return null;
  const key = name.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, key)) return null;
  const mod = REGISTRY[key]();
  return mod && mod.instance ? mod.instance : null;
}

module.exports = {
  SmsError,
  SmsProvider,
  notConfiguredError,
  providerError,
  getProvider,
};
