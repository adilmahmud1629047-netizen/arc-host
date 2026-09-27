const config = require('../../../config');
const {
  ProvisioningProvider,
  ProvisioningProviderError,
  notConfiguredError,
} = require('../provisioningProvider');

// Placeholder Proxmox provider (Step 12). Validates that configuration is
// present, then REFUSES — no Proxmox API call is made, no resource is
// created. Real API integration comes in a dedicated later step.
//
// Future environment variables (secrets stay in the environment only —
// never in source code, the database, logs, or API responses):
//   PROXMOX_API_URL       e.g. https://pve.example.internal:8006
//   PROXMOX_TOKEN_ID      e.g. root@pam!provisioner
//   PROXMOX_TOKEN_SECRET  (never committed, never logged)
//   PROXMOX_NODE
function getLiveConfig() {
  const cfg = (config.provisioning && config.provisioning.proxmox) || {};
  const apiUrl = String(cfg.apiUrl || '').trim();
  const tokenId = String(cfg.tokenId || '').trim();
  const tokenSecret = String(cfg.tokenSecret || '').trim();
  const node = String(cfg.node || '').trim();

  if (!apiUrl || !tokenId || !tokenSecret || !node) {
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

  return { apiUrl, tokenId, tokenSecret, node };
}

function notImplementedError() {
  return new ProvisioningProviderError(
    503,
    'PROVISIONING_NOT_IMPLEMENTED',
    'Provisioning is not available yet.'
  );
}

class ProxmoxProvider extends ProvisioningProvider {
  constructor() {
    super('proxmox');
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

module.exports = { instance: new ProxmoxProvider() };
