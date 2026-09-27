const { SmsProvider, notConfiguredError } = require('../smsProvider');

// Default provider (SMS_PROVIDER=disabled): no message is ever sent, nothing
// is ever pretended. Every operation fails with SMS_PROVIDER_NOT_CONFIGURED so
// callers get an honest structured error instead of a fake success.
class DisabledSmsProvider extends SmsProvider {
  constructor() {
    super('disabled');
  }

  async sendSms() {
    throw notConfiguredError();
  }

  async getStatus() {
    throw notConfiguredError();
  }
}

module.exports = {
  DisabledSmsProvider,
  instance: new DisabledSmsProvider(),
};
