const { PaymentProvider, notConfiguredError } = require('../paymentProvider');

// Default provider: no gateway integration exists yet. Every operation fails
// with PAYMENT_PROVIDER_NOT_CONFIGURED so nothing can be initiated, verified,
// or marked paid through this provider.
class DisabledProvider extends PaymentProvider {
  constructor() {
    super('disabled');
  }

  async createPayment() {
    throw notConfiguredError();
  }

  async verifyPayment() {
    throw notConfiguredError();
  }

  async handleWebhook() {
    throw notConfiguredError();
  }
}

module.exports = {
  DisabledProvider,
  instance: new DisabledProvider(),
};
