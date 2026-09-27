class PaymentProviderError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notConfiguredError() {
  return new PaymentProviderError(
    503,
    'PAYMENT_PROVIDER_NOT_CONFIGURED',
    'Payment processing is not available yet.'
  );
}

class PaymentProvider {
  constructor(name) {
    this.name = name;
  }

  async createPayment() {
    throw new PaymentProviderError(
      501,
      'PAYMENT_PROVIDER_UNSUPPORTED',
      'This payment provider cannot create payments.'
    );
  }

  async verifyPayment() {
    throw new PaymentProviderError(
      501,
      'PAYMENT_PROVIDER_UNSUPPORTED',
      'This payment provider cannot verify payments.'
    );
  }

  async handleWebhook() {
    throw new PaymentProviderError(
      501,
      'PAYMENT_PROVIDER_UNSUPPORTED',
      'This payment provider cannot handle webhooks.'
    );
  }
}

// Registry of payment providers. Add future providers here (lazy require keeps
// provider modules isolated and avoids circular imports).
const REGISTRY = {
  disabled: () => require('./providers/disabledProvider'),
  sslcommerz: () => require('./providers/sslcommerzProvider'),
  uddoktapay: () => require('./providers/uddoktapayProvider'),
};

function getProvider(name) {
  if (typeof name !== 'string' || name === '') return null;
  const key = name.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, key)) return null;
  const mod = REGISTRY[key]();
  return mod && mod.instance ? mod.instance : null;
}

module.exports = {
  PaymentProvider,
  PaymentProviderError,
  notConfiguredError,
  getProvider,
};
