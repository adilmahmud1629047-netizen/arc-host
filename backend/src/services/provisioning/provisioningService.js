const config = require('../../config');
const orderModel = require('../../models/orderModel');
const hostingPlanModel = require('../../models/hostingPlanModel');
const vpsPlanModel = require('../../models/vpsPlanModel');
const serviceInstanceModel = require('../../models/serviceInstanceModel');
const serverSelectionService = require('./serverSelectionService');
const {
  getProvider,
  ProvisioningProviderError,
} = require('./provisioningProvider');
const {
  ProvisioningError,
  CODES,
  canTransition,
} = require('./provisioningErrors');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 10;
const SAFE_PROVIDER_FAILURE_MESSAGE = 'Provisioning failed. Please contact support.';
const INVALID_RESPONSE_MESSAGE = 'Provisioning provider returned an invalid response.';

function isValidId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function orderNotFound() {
  return new ProvisioningError(404, CODES.ORDER_NOT_FOUND, 'Order not found.');
}

function instanceNotFound() {
  return new ProvisioningError(
    404,
    CODES.INSTANCE_NOT_FOUND,
    'Service not found.'
  );
}

function invalidState() {
  return new ProvisioningError(
    409,
    CODES.INVALID_STATE,
    'Service is not in a valid state for this operation.'
  );
}

function notConfigured() {
  return new ProvisioningError(
    503,
    CODES.NOT_CONFIGURED,
    'Provisioning is not available yet.'
  );
}

function orderNotEligible() {
  return new ProvisioningError(
    409,
    CODES.ORDER_NOT_ELIGIBLE,
    'Order is not eligible for provisioning.'
  );
}

// A provider-originated error is only trusted for persistence/exposure when it
// is one of OUR typed errors with an authored message (short, safe). Anything
// else (transport failures, raw exceptions) is replaced with a fixed safe
// message — raw provider messages may contain URLs, hostnames, tokens, or
// other internals and are never stored or returned.
function isSafeShaped(err) {
  if (!(err instanceof ProvisioningError || err instanceof ProvisioningProviderError)) {
    return false;
  }
  if (typeof err.message !== 'string' || err.message.length > 255) return false;
  if (typeof err.code !== 'string' || err.code.indexOf('PROVISIONING_') !== 0) {
    return false;
  }
  if (!Number.isInteger(err.status) || err.status < 400 || err.status >= 600) {
    return false;
  }
  return true;
}

// Normalize any provider failure into {code, message, error} where message is
// safe to persist in failure_message_safe and error is what the caller sees.
function toSafeFailure(err) {
  if (isSafeShaped(err)) {
    const error =
      err instanceof ProvisioningError
        ? err
        : new ProvisioningError(err.status, err.code, err.message);
    return { code: err.code, message: String(err.message), error };
  }
  const error = new ProvisioningError(
    502,
    CODES.PROVIDER_ERROR,
    SAFE_PROVIDER_FAILURE_MESSAGE
  );
  return { code: error.code, message: error.message, error };
}

// Re-throw a provider failure before any state has changed (precheck,
// lifecycle ops). Always throws — never returns.
function rethrowAsProvisioning(err) {
  if (err instanceof ProvisioningError) throw err;
  throw toSafeFailure(err).error;
}

function buildPayload({ order, plan }) {
  const base = {
    planId: plan.id,
    planSlug: plan.slug,
    userId: order.user_id,
    orderId: order.id,
  };
  if (order.product_type === 'vps') {
    return {
      serviceType: 'vps',
      ...base,
      resources: {
        cpu: plan.cpu_cores,
        ram: plan.ram_mb,
        storage: plan.storage_gb,
        bandwidth: plan.bandwidth_gb === undefined ? null : plan.bandwidth_gb,
      },
    };
  }
  return {
    serviceType: 'hosting',
    ...base,
    resources: {
      storage: plan.storage_gb,
      bandwidth: plan.bandwidth_gb === undefined ? null : plan.bandwidth_gb,
      databases: plan.databases,
      emailAccounts: plan.email_accounts,
      domains: plan.domains,
    },
  };
}

// Internal trusted workflow (Step 12) — never exposed as an HTTP endpoint.
// Order-paid -> plan validation -> provider readiness -> instance row ->
// provider.provision -> active | failed. Idempotent per order: a second call
// for an order that already has a service returns the recorded instance and
// NEVER calls the provider again.
async function provisionOrder(orderId, { userId = null } = {}) {
  if (!isValidId(orderId)) throw orderNotFound();

  // Ownership: when userId is supplied a foreign/missing order yields the
  // identical 404 (no existence leak).
  const order = userId
    ? await orderModel.findByIdForUser(orderId, userId)
    : await orderModel.findById(orderId);
  if (!order) throw orderNotFound();

  if (order.status !== 'paid') throw orderNotEligible();
  if (order.product_type !== 'hosting' && order.product_type !== 'vps') {
    throw orderNotEligible();
  }

  const plan =
    order.product_type === 'hosting'
      ? await hostingPlanModel.findById(order.product_id)
      : await vpsPlanModel.findById(order.product_id);
  if (!plan || plan.status !== 'active') {
    throw new ProvisioningError(
      409,
      CODES.INVALID_PLAN,
      'Selected plan is not available.'
    );
  }

  const existing = await serviceInstanceModel.findByOrderId(order.id);
  if (existing) {
    return {
      instance: serviceInstanceModel.mapPublic(existing),
      created: false,
      replayed: true,
    };
  }

  const providerName = (config.provisioning.provider || 'disabled')
    .trim()
    .toLowerCase();
  const provider = getProvider(providerName);
  if (!provider) throw notConfigured();

  // Provider readiness precheck BEFORE any row is written: a disabled or
  // unconfigured provider creates zero service instances.
  try {
    await provider.getStatus();
  } catch (err) {
    rethrowAsProvisioning(err);
  }

  const payload = buildPayload({ order, plan });

  let server = null;
  if (order.product_type === 'vps') {
    server = await serverSelectionService.selectServer(
      'vps',
      payload.resources
    );
    if (!server) {
      throw new ProvisioningError(
        503,
        CODES.CAPACITY_UNAVAILABLE,
        'No server capacity is available right now.'
      );
    }
  }

  let instance;
  try {
    instance = await serviceInstanceModel.create({
      userId: order.user_id,
      orderId: order.id,
      serviceType: order.product_type,
      hostingPlanId: order.product_type === 'hosting' ? plan.id : null,
      vpsPlanId: order.product_type === 'vps' ? plan.id : null,
      serverId: server ? server.id : null,
      provider: provider.name,
      status: 'provisioning',
    });
  } catch (err) {
    // Unique order_id index: a concurrent duplicate loses the race cleanly.
    if (err && err.code === '23505') {
      const raced = await serviceInstanceModel.findByOrderId(order.id);
      if (raced) {
        return {
          instance: serviceInstanceModel.mapPublic(raced),
          created: false,
          replayed: true,
        };
      }
    }
    throw err;
  }

  // External call happens with NO open DB transaction. On failure the row is
  // recorded as failed (safe diagnostic only) and the error is re-thrown.
  let result;
  try {
    result = await provider.provision(payload);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new ProvisioningError(502, CODES.PROVIDER_ERROR, INVALID_RESPONSE_MESSAGE);
    }
    if (
      result.externalId !== undefined &&
      result.externalId !== null &&
      typeof result.externalId !== 'string'
    ) {
      throw new ProvisioningError(502, CODES.PROVIDER_ERROR, INVALID_RESPONSE_MESSAGE);
    }
  } catch (err) {
    const failure = toSafeFailure(err);
    await serviceInstanceModel.markFailed(
      instance.id,
      failure.code,
      failure.message
    );
    throw failure.error;
  }

  const externalId =
    typeof result.externalId === 'string' && result.externalId
      ? result.externalId
      : null;
  const activated = await serviceInstanceModel.markActive(
    instance.id,
    externalId
  );
  if (!activated) {
    // Row moved by another path — return recorded state, provider not re-called.
    const current = await serviceInstanceModel.findById(instance.id);
    return {
      instance: serviceInstanceModel.mapPublic(current || instance),
      created: false,
      replayed: true,
    };
  }

  return {
    instance: serviceInstanceModel.mapPublic(activated),
    created: true,
    replayed: false,
  };
}

async function loadInstance(instanceId, userId) {
  if (!isValidId(instanceId)) throw instanceNotFound();
  const row = await serviceInstanceModel.findById(instanceId);
  if (!row) throw instanceNotFound();
  // identical 404 when the instance belongs to someone else
  if (userId && row.user_id !== userId) throw instanceNotFound();
  return row;
}

function providerForInstance(row) {
  const name = (
    row.provider ||
    config.provisioning.provider ||
    'disabled'
  )
    .trim()
    .toLowerCase();
  return getProvider(name);
}

// Shared lifecycle transition: validate matrix -> provider op (failure means
// NO state change) -> guarded UPDATE that re-enforces the matrix at the DB.
async function transitionTo(instanceId, userId, { to, providerOp, modelOp }) {
  const row = await loadInstance(instanceId, userId);
  if (!canTransition(row.status, to)) throw invalidState();

  const provider = providerForInstance(row);
  if (!provider) throw notConfigured();

  try {
    await provider[providerOp]({
      externalId: row.external_id,
      serviceType: row.service_type,
      instanceId: row.id,
    });
  } catch (err) {
    rethrowAsProvisioning(err);
  }

  const updated = await serviceInstanceModel[modelOp](row.id);
  if (!updated) throw invalidState(); // state changed concurrently
  return serviceInstanceModel.mapPublic(updated);
}

async function suspendService(instanceId, { userId = null } = {}) {
  return transitionTo(instanceId, userId, {
    to: 'suspended',
    providerOp: 'suspend',
    modelOp: 'markSuspended',
  });
}

async function unsuspendService(instanceId, { userId = null } = {}) {
  return transitionTo(instanceId, userId, {
    to: 'active',
    providerOp: 'unsuspend',
    modelOp: 'markResumed',
  });
}

async function terminateService(instanceId, { userId = null } = {}) {
  return transitionTo(instanceId, userId, {
    to: 'terminated',
    providerOp: 'terminate',
    modelOp: 'markTerminated',
  });
}

async function listServices(userId, { page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  const pageNum = Math.max(1, Math.floor(Number(page) || 1));
  const limitNum = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(limit) || DEFAULT_PAGE_SIZE))
  );
  const offset = (pageNum - 1) * limitNum;

  const [rows, total] = await Promise.all([
    serviceInstanceModel.findByUserWithOrder(userId, { limit: limitNum, offset }),
    serviceInstanceModel.countByUser(userId),
  ]);

  return {
    services: rows.map((row) => serviceInstanceModel.mapPublic(row)),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
    },
  };
}

module.exports = {
  ProvisioningError,
  ProvisioningProviderError,
  CODES,
  SAFE_PROVIDER_FAILURE_MESSAGE,
  isValidId,
  provisionOrder,
  suspendService,
  unsuspendService,
  terminateService,
  listServices,
};
