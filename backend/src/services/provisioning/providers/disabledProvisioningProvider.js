const {
  ProvisioningProvider,
  notConfiguredError,
} = require('../provisioningProvider');

// Default provider (PROVISIONING_PROVIDER=disabled). Every operation refuses
// with PROVISIONING_PROVIDER_NOT_CONFIGURED — no external call, no fake
// service, no pretend success.
class DisabledProvisioningProvider extends ProvisioningProvider {
  constructor() {
    super('disabled');
  }

  async provision() {
    throw notConfiguredError();
  }

  async suspend() {
    throw notConfiguredError();
  }

  async unsuspend() {
    throw notConfiguredError();
  }

  async terminate() {
    throw notConfiguredError();
  }

  async getStatus() {
    throw notConfiguredError();
  }
}

module.exports = { instance: new DisabledProvisioningProvider() };
