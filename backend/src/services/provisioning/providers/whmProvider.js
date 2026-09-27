const config = require('../../../config');
const {
  ProvisioningProvider,
  ProvisioningProviderError,
  notConfiguredError,
} = require('../provisioningProvider');

// Placeholder WHM/cPanel provider (Step 12). Validates that configuration is
// present, then REFUSES — no WHM/cPanel API call is made, no hosting account
// is created. Real API integration comes in a dedicated later step.
//
// Future environment variables (secrets stay in the environment only —
// never in source code, the database, logs, or API responses):
//   WHM_API_URL    e.g. https://cp.example.com:2087
//   WHM_API_TOKEN  (never committed, never logged)
//   WHM_USERNAME   e.g. root
function getLiveConfig() {
  const cfg = (config.provisioning && config.provisioning.whm) || {};
  const apiUrl = String(cfg.apiUrl || '').trim();
  const apiToken = String(cfg.apiToken || '').trim();
  const username = String(cfg.username || '').trim();

  if (!apiUrl || !apiToken || !username) {
    throw notConfiguredError();
  }

  // Future HTTP calls must pin the request to this server-side URL only
  // (no client-controlled endpoints — SSRF guard), over https.
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw notConfiguredError();
  }
  if (parsed.protocol !== 'https:') {
    throw notConfiguredError();
  }

  return { apiUrl, apiToken, username };
}

function notImplementedError() {
  return new ProvisioningProviderError(
    503,
    'PROVISIONING_NOT_IMPLEMENTED',
    'Provisioning is not available yet.'
  );
}

class WhmProvider extends ProvisioningProvider {
  constructor() {
    super('whm');
  }

  // Config is validated first so missing/invalid credentials surface as
  // PROVISIONING_PROVIDER_NOT_CONFIGURED before anything else happens.
  async provision() {
    getLiveConfig();
    throw notImplementedError();
  }

  async suspend() {
    getLiveConfig();
    throw notImplementedError();
  }

  async unsuspend() {
    getLiveConfig();
    throw notImplementedError();
  }

  async terminate() {
    getLiveConfig();
    throw notImplementedError();
  }

  async getStatus() {
    getLiveConfig();
    throw notImplementedError();
  }
}

module.exports = { instance: new WhmProvider() };
