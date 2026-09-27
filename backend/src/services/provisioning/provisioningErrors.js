// Shared service-level provisioning errors — same {status, code, message}
// shape as PaymentError so the global error handler serializes them into the
// standard API envelope. Messages are always safe to expose: never raw
// provider responses, credentials, or internal infrastructure details.
class ProvisioningError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const CODES = {
  ORDER_NOT_FOUND: 'PROVISIONING_ORDER_NOT_FOUND',
  ORDER_NOT_ELIGIBLE: 'PROVISIONING_ORDER_NOT_ELIGIBLE',
  INVALID_PLAN: 'PROVISIONING_INVALID_PLAN',
  ALREADY_EXISTS: 'PROVISIONING_ALREADY_EXISTS',
  INVALID_STATE: 'PROVISIONING_INVALID_STATE',
  INSTANCE_NOT_FOUND: 'PROVISIONING_INSTANCE_NOT_FOUND',
  NOT_CONFIGURED: 'PROVISIONING_PROVIDER_NOT_CONFIGURED',
  PROVIDER_ERROR: 'PROVISIONING_PROVIDER_ERROR',
  CAPACITY_UNAVAILABLE: 'PROVISIONING_CAPACITY_UNAVAILABLE',
  NOT_IMPLEMENTED: 'PROVISIONING_NOT_IMPLEMENTED',
  UNSUPPORTED: 'PROVISIONING_PROVIDER_UNSUPPORTED',
};

// The ONLY allowed service-status transitions (migration 006 status values).
// "pending" is the absence of a service instance row (paid order, not yet
// provisioned) and therefore has no entry here.
const ALLOWED_TRANSITIONS = {
  provisioning: ['active', 'failed'],
  active: ['suspended', 'terminated'],
  suspended: ['active', 'terminated'],
  failed: [], // terminal in Step 12 (retry/reconciliation comes later)
  terminated: [], // terminal
};

function canTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

module.exports = {
  ProvisioningError,
  CODES,
  ALLOWED_TRANSITIONS,
  canTransition,
};
