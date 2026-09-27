// Shared provisioning provider error shape — mirrors PaymentProviderError so
// the global error handler serializes {status, code, message} into the
// standard API envelope. Messages are always safe: no provider bodies, no
// credentials, no infrastructure internals.
class ProvisioningProviderError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notConfiguredError() {
  return new ProvisioningProviderError(
    503,
    'PROVISIONING_PROVIDER_NOT_CONFIGURED',
    'Provisioning is not available yet.'
  );
}

// Single safe error for every transport/timeout/HTTP/parse problem. The
// upstream response body is never echoed back — it may contain sensitive data.
function providerError() {
  return new ProvisioningProviderError(
    502,
    'PROVISIONING_PROVIDER_ERROR',
    'Provisioning provider is temporarily unavailable.'
  );
}

class ProvisioningProvider {
  constructor(name) {
    this.name = name;
  }

  async provision() {
    throw new ProvisioningProviderError(
      501,
      'PROVISIONING_PROVIDER_UNSUPPORTED',
      'This provisioning provider cannot provision services.'
    );
  }

  async suspend() {
    throw new ProvisioningProviderError(
      501,
      'PROVISIONING_PROVIDER_UNSUPPORTED',
      'This provisioning provider cannot suspend services.'
    );
  }

  async unsuspend() {
    throw new ProvisioningProviderError(
      501,
      'PROVISIONING_PROVIDER_UNSUPPORTED',
      'This provisioning provider cannot resume services.'
    );
  }

  async terminate() {
    throw new ProvisioningProviderError(
      501,
      'PROVISIONING_PROVIDER_UNSUPPORTED',
      'This provisioning provider cannot terminate services.'
    );
  }

  async getStatus() {
    throw new ProvisioningProviderError(
      501,
      'PROVISIONING_PROVIDER_UNSUPPORTED',
      'This provisioning provider cannot report service status.'
    );
  }
}

// Registry of provisioning providers. Lazy require keeps provider modules
// isolated and avoids circular imports (same pattern as paymentProvider.js).
const REGISTRY = {
  disabled: () => require('./providers/disabledProvisioningProvider'),
  proxmox: () => require('./providers/proxmoxProvider'),
  whm: () => require('./providers/whmProvider'),
};

function getProvider(name) {
  if (typeof name !== 'string' || name === '') return null;
  const key = name.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, key)) return null;
  const mod = REGISTRY[key]();
  return mod && mod.instance ? mod.instance : null;
}

// Test seam: lets suites inject mock providers without touching production
// selection. Never called by application code; production providers come
// from the static REGISTRY above (config.provisioning.provider).
function registerProvider(name, instance) {
  if (typeof name !== 'string' || !name.trim() || !instance) {
    throw new Error('registerProvider requires a non-empty name and an instance');
  }
  const key = name.trim().toLowerCase();
  REGISTRY[key] = () => ({ instance });
}

function unregisterProvider(name) {
  if (typeof name !== 'string' || !name.trim()) return;
  delete REGISTRY[name.trim().toLowerCase()];
}

module.exports = {
  ProvisioningProvider,
  ProvisioningProviderError,
  notConfiguredError,
  providerError,
  getProvider,
  registerProvider,
  unregisterProvider,
};
