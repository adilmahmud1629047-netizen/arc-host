const crypto = require('crypto');
const { sendOk, sendError } = require('../utils/respond');
const adminMetricsModel = require('../models/adminMetricsModel');
const adminOrderModel = require('../models/adminOrderModel');
const adminCustomerModel = require('../models/adminCustomerModel');
const adminPaymentModel = require('../models/adminPaymentModel');
const smsIncomingModel = require('../models/smsIncomingModel');
const paymentService = require('../services/payments/paymentService');
const sessionService = require('../services/sessionService');
const authService = require('../services/authService');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_REJECTION_REASON = 200;

// Admin write bodies are tiny and fixed: only listed keys are accepted.
// Anything else (amount, status, "verified", …) is a client error — the
// server always derives those values itself.
function rejectUnexpectedFields(req, res, allowedKeys) {
  const body = req.body;
  if (body === undefined || body === null) return true;
  if (typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
      'Request body must be a JSON object.',
    ]);
    return false;
  }
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `Unexpected field: ${key}.`,
      ]);
      return false;
    }
  }
  return true;
}

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: fallback };
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return { ok: false, error: 'must be a positive integer.' };
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return { ok: false, error: `must be between ${min} and ${max}.` };
  }
  return { ok: true, value: n };
}

function rejectUnexpectedQuery(req, res, allowedKeys) {
  for (const key of Object.keys(req.query || {})) {
    if (!allowedKeys.has(key)) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `Unexpected query parameter: ${key}.`,
      ]);
      return false;
    }
  }
  return true;
}

// GET /api/admin/me — minimal admin identity for the admin UI auth gate.
async function me(req, res, next) {
  try {
    sendOk(res, { admin: req.user });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/health — minimal authenticated health signal (no env/secrets).
async function health(req, res, next) {
  try {
    sendOk(res, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      role: 'admin',
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/dashboard — aggregate metrics only.
async function dashboard(req, res, next) {
  try {
    const metrics = await adminMetricsModel.getDashboardMetrics();
    sendOk(res, { metrics });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/orders — paginated, filterable, server-derived list.
async function listOrders(req, res, next) {
  try {
    if (!rejectUnexpectedQuery(req, res, new Set([
      'page',
      'limit',
      'status',
      'productType',
      'search',
    ]))) {
      return;
    }

    const pageParsed = parsePositiveInt(req.query.page, 1, {
      min: 1,
      max: 1_000_000,
    });
    if (!pageParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `page ${pageParsed.error}`,
      ]);
    }

    const limitParsed = parsePositiveInt(
      req.query.limit,
      adminOrderModel.DEFAULT_LIMIT,
      { min: 1, max: adminOrderModel.MAX_LIMIT }
    );
    if (!limitParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `limit must be between 1 and ${adminOrderModel.MAX_LIMIT}.`,
      ]);
    }

    let status = null;
    if (req.query.status !== undefined && req.query.status !== '') {
      status = String(req.query.status);
      if (!adminOrderModel.ORDER_STATUSES.includes(status)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `status must be one of: ${adminOrderModel.ORDER_STATUSES.join(', ')}.`,
        ]);
      }
    }

    let productType = null;
    if (req.query.productType !== undefined && req.query.productType !== '') {
      productType = String(req.query.productType);
      if (!adminOrderModel.PRODUCT_TYPES.includes(productType)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `productType must be one of: ${adminOrderModel.PRODUCT_TYPES.join(', ')}.`,
        ]);
      }
    }

    let search = null;
    if (req.query.search !== undefined && req.query.search !== '') {
      search = String(req.query.search).trim();
      if (search.length > adminOrderModel.MAX_SEARCH) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `search must be at most ${adminOrderModel.MAX_SEARCH} characters.`,
        ]);
      }
      if (search.length === 0) {
        search = null;
      }
    }

    const result = await adminOrderModel.listOrders({
      page: pageParsed.value,
      limit: limitParsed.value,
      status,
      productType,
      search,
    });

    sendOk(res, result);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/orders/:id — read-only operational detail.
async function getOrder(req, res, next) {
  try {
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'Order id must be a UUID.',
      ]);
    }

    const detail = await adminOrderModel.findOrderDetail(id);
    if (!detail) {
      return sendError(res, 404, 'NOT_FOUND', 'Order not found.');
    }

    sendOk(res, detail);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/customers — paginated, filterable, server-derived list.
async function listCustomers(req, res, next) {
  try {
    if (!rejectUnexpectedQuery(req, res, new Set([
      'page',
      'limit',
      'search',
      'status',
    ]))) {
      return;
    }

    const pageParsed = parsePositiveInt(req.query.page, 1, {
      min: 1,
      max: 1_000_000,
    });
    if (!pageParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `page ${pageParsed.error}`,
      ]);
    }

    const limitParsed = parsePositiveInt(
      req.query.limit,
      adminCustomerModel.DEFAULT_LIMIT,
      { min: 1, max: adminCustomerModel.MAX_LIMIT }
    );
    if (!limitParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `limit must be between 1 and ${adminCustomerModel.MAX_LIMIT}.`,
      ]);
    }

    let status = null;
    if (req.query.status !== undefined && req.query.status !== '') {
      status = String(req.query.status);
      if (!adminCustomerModel.USER_STATUSES.includes(status)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `status must be one of: ${adminCustomerModel.USER_STATUSES.join(', ')}.`,
        ]);
      }
    }

    let search = null;
    if (req.query.search !== undefined && req.query.search !== '') {
      search = String(req.query.search).trim();
      if (search.length > adminCustomerModel.MAX_SEARCH) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `search must be at most ${adminCustomerModel.MAX_SEARCH} characters.`,
        ]);
      }
      if (search.length === 0) {
        search = null;
      }
    }

    const result = await adminCustomerModel.listCustomers({
      page: pageParsed.value,
      limit: limitParsed.value,
      search,
      status,
    });

    sendOk(res, result);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/customers/:id — read-only operational customer profile.
async function getCustomer(req, res, next) {
  try {
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'Customer id must be a UUID.',
      ]);
    }

    const detail = await adminCustomerModel.findCustomerDetail(id);
    if (!detail) {
      return sendError(res, 404, 'NOT_FOUND', 'Customer not found.');
    }

    sendOk(res, detail);
  } catch (err) {
    next(err);
  }
}

// One-time temporary password: 16 unambiguous characters (no I/O/0/1/l)
// from the CSPRNG. Never logged, never stored in plaintext — only its
// Argon2id hash reaches the database.
const TEMP_PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generateTemporaryPassword() {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += TEMP_PASSWORD_ALPHABET[bytes[i] % TEMP_PASSWORD_ALPHABET.length];
  }
  return out;
}

function parseCustomerId(req, res) {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
      'Customer id must be a UUID.',
    ]);
    return null;
  }
  return id;
}

// Shared target lookup for the account controls: 400 on a malformed id,
// 404 when the user row does not exist.
async function findControlTarget(req, res) {
  const id = parseCustomerId(req, res);
  if (!id) return null;
  const profile = await adminCustomerModel.findCustomerProfile(id);
  if (!profile) {
    sendError(res, 404, 'NOT_FOUND', 'Customer not found.');
    return null;
  }
  return profile;
}

// POST /api/admin/customers/:id/suspend — status='suspended' only; the user
// row, orders, payments and services are never deleted. All of the target's
// sessions are revoked in the same request (login + per-request checks then
// reject them even without revocation, this makes it immediate).
async function suspendCustomer(req, res, next) {
  try {
    if (!rejectUnexpectedFields(req, res, new Set([]))) return;
    const profile = await findControlTarget(req, res);
    if (!profile) return;

    if (profile.id === req.user.id) {
      return sendError(
        res,
        403,
        'ADMIN_SELF_ACTION',
        'You cannot suspend your own administrator account.'
      );
    }
    if (profile.role === 'admin') {
      const others = await adminCustomerModel.countActiveAdminsExcept(
        profile.id
      );
      if (others < 1) {
        return sendError(
          res,
          403,
          'LAST_ADMIN_PROTECTED',
          'At least one active administrator account must remain.'
        );
      }
    }

    const customer = await adminCustomerModel.setCustomerStatus(
      profile.id,
      'suspended'
    );
    const sessionsRevoked = await sessionService.destroySessionsForUser(
      profile.id
    );
    sendOk(res, { customer, sessionsRevoked });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/customers/:id/reactivate — status='active' again. No
// sessions are created (the customer signs in fresh) and no other row is
// touched. Safe to re-run on an already-active account.
async function reactivateCustomer(req, res, next) {
  try {
    if (!rejectUnexpectedFields(req, res, new Set([]))) return;
    const profile = await findControlTarget(req, res);
    if (!profile) return;

    const customer = await adminCustomerModel.setCustomerStatus(
      profile.id,
      'active'
    );
    sendOk(res, { customer, sessionsRevoked: 0 });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/customers/:id/reset-password — Argon2id reset through the
// existing hash architecture. The one-time temporary password is returned
// exactly once in this response (never in logs, never retrievable again)
// and every session of the target is revoked. Customer accounts only: there
// is no existing policy for resetting another administrator, so admin
// targets are refused outright.
async function resetCustomerPassword(req, res, next) {
  try {
    if (!rejectUnexpectedFields(req, res, new Set([]))) return;
    const profile = await findControlTarget(req, res);
    if (!profile) return;

    if (profile.role === 'admin') {
      return sendError(
        res,
        403,
        'PASSWORD_RESET_NOT_ALLOWED',
        'Password reset is only available for customer accounts.'
      );
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await authService.hashPassword(temporaryPassword);
    const customer = await adminCustomerModel.updatePasswordHash(
      profile.id,
      passwordHash
    );
    const sessionsRevoked = await sessionService.destroySessionsForUser(
      profile.id
    );

    sendOk(res, {
      customer,
      temporaryPassword,
      sessionsRevoked,
      notice:
        'Deliver this temporary password to the customer through a secure channel. It will not be shown again.',
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/customers/:id/orders — complete, paginated order history
// for one customer (filterable by order status, searchable by order number).
async function listCustomerOrders(req, res, next) {
  try {
    if (!rejectUnexpectedQuery(req, res, new Set([
      'page',
      'limit',
      'status',
      'search',
    ]))) {
      return;
    }

    const pageParsed = parsePositiveInt(req.query.page, 1, {
      min: 1,
      max: 1_000_000,
    });
    if (!pageParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `page ${pageParsed.error}`,
      ]);
    }

    const limitParsed = parsePositiveInt(
      req.query.limit,
      adminCustomerModel.DEFAULT_LIMIT,
      { min: 1, max: adminCustomerModel.MAX_LIMIT }
    );
    if (!limitParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `limit must be between 1 and ${adminCustomerModel.MAX_LIMIT}.`,
      ]);
    }

    let status = null;
    if (req.query.status !== undefined && req.query.status !== '') {
      status = String(req.query.status);
      if (!adminOrderModel.ORDER_STATUSES.includes(status)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `status must be one of: ${adminOrderModel.ORDER_STATUSES.join(', ')}.`,
        ]);
      }
    }

    let search = null;
    if (req.query.search !== undefined && req.query.search !== '') {
      search = String(req.query.search).trim();
      if (search.length > adminOrderModel.MAX_SEARCH) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `search must be at most ${adminOrderModel.MAX_SEARCH} characters.`,
        ]);
      }
      if (search.length === 0) search = null;
    }

    const profile = await findControlTarget(req, res);
    if (!profile) return;

    const result = await adminCustomerModel.findCustomerOrders(profile.id, {
      page: pageParsed.value,
      limit: limitParsed.value,
      status,
      search,
    });

    sendOk(res, result);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/customers/:id/payments — that customer's payment history
// only (paginated), with the single verification-source string extracted
// server-side; the raw metadata row never leaves the database.
async function listCustomerPayments(req, res, next) {
  try {
    if (!rejectUnexpectedQuery(req, res, new Set(['page', 'limit']))) {
      return;
    }

    const pageParsed = parsePositiveInt(req.query.page, 1, {
      min: 1,
      max: 1_000_000,
    });
    if (!pageParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `page ${pageParsed.error}`,
      ]);
    }

    const limitParsed = parsePositiveInt(
      req.query.limit,
      adminCustomerModel.DEFAULT_LIMIT,
      { min: 1, max: adminCustomerModel.MAX_LIMIT }
    );
    if (!limitParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `limit must be between 1 and ${adminCustomerModel.MAX_LIMIT}.`,
      ]);
    }

    const profile = await findControlTarget(req, res);
    if (!profile) return;

    const result = await adminCustomerModel.findCustomerPayments(profile.id, {
      page: pageParsed.value,
      limit: limitParsed.value,
    });

    sendOk(res, result);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/sms/incoming — received TextBee SMS events (masked preview).
// Read-only; never returns full bodies, API keys, or webhook secrets.
async function listIncomingSms(req, res, next) {
  try {
    if (!rejectUnexpectedQuery(req, res, new Set(['page', 'limit']))) {
      return;
    }

    const pageParsed = parsePositiveInt(req.query.page, 1, {
      min: 1,
      max: 1_000_000,
    });
    if (!pageParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `page ${pageParsed.error}`,
      ]);
    }

    const limitParsed = parsePositiveInt(
      req.query.limit,
      smsIncomingModel.DEFAULT_LIMIT,
      { min: 1, max: smsIncomingModel.MAX_LIMIT }
    );
    if (!limitParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `limit must be between 1 and ${smsIncomingModel.MAX_LIMIT}.`,
      ]);
    }

    const result = await smsIncomingModel.listIncoming({
      page: pageParsed.value,
      limit: limitParsed.value,
    });
    sendOk(res, result);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/payments — the admin payment list in two modes.
//   * no `provider` param: exactly the legacy behaviour (manual Transaction
//     id submissions only, review-alias status filter).
//   * explicit `provider` param (a provider name or `all`): the extended
//     list across every provider with order/customer/transaction filters
//     and raw gateway statuses.
async function listManualPayments(req, res, next) {
  try {
    const extended = req.query.provider !== undefined;
    const allowedKeys = extended
      ? new Set(['page', 'limit', 'status', 'provider', 'order', 'customer', 'transaction'])
      : new Set(['page', 'limit', 'status']);
    if (!rejectUnexpectedQuery(req, res, allowedKeys)) {
      return;
    }

    const pageParsed = parsePositiveInt(req.query.page, 1, {
      min: 1,
      max: 1_000_000,
    });
    if (!pageParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `page ${pageParsed.error}`,
      ]);
    }

    const limitParsed = parsePositiveInt(
      req.query.limit,
      adminPaymentModel.DEFAULT_LIMIT,
      { min: 1, max: adminPaymentModel.MAX_LIMIT }
    );
    if (!limitParsed.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        `limit must be between 1 and ${adminPaymentModel.MAX_LIMIT}.`,
      ]);
    }

    let provider = null;
    if (extended) {
      provider = String(req.query.provider);
      if (!adminPaymentModel.PROVIDER_FILTERS.includes(provider)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `provider must be one of: ${adminPaymentModel.PROVIDER_FILTERS.join(', ')}.`,
        ]);
      }
    }

    let status = null;
    if (req.query.status !== undefined && req.query.status !== '') {
      status = String(req.query.status);
      if (!extended) {
        // legacy mode: the three review aliases only (historical contract)
        if (!adminPaymentModel.STATUS_FILTERS[status]) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
            `status must be one of: ${Object.keys(adminPaymentModel.STATUS_FILTERS).join(', ')}.`,
          ]);
        }
        status = adminPaymentModel.STATUS_FILTERS[status];
      } else {
        const normalized = adminPaymentModel.normalizeStatusFilter(status);
        if (!normalized) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
            `status must be one of: ${adminPaymentModel.validStatusFilterValues().join(', ')}.`,
          ]);
        }
        status = normalized;
      }
    }

    // Text filters: short, single-valued strings only.
    const textFilters = {};
    for (const key of ['order', 'customer', 'transaction']) {
      if (!extended || req.query[key] === undefined || req.query[key] === '') {
        continue;
      }
      const raw = req.query[key];
      if (typeof raw !== 'string') {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `${key} must be a single search value.`,
        ]);
      }
      const value = raw.trim().slice(0, 100);
      if (!value) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `${key} must be a single search value.`,
        ]);
      }
      textFilters[key] = value;
    }

    const result = await adminPaymentModel.listPayments({
      page: pageParsed.value,
      limit: limitParsed.value,
      status,
      provider,
      order: textFilters.order || null,
      customer: textFilters.customer || null,
      transaction: textFilters.transaction || null,
    });

    sendOk(res, result);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/payments/:id — full payment detail with its order,
// customer and the provenance recorded on the row.
async function getPaymentDetail(req, res, next) {
  try {
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'Payment id must be a UUID.',
      ]);
    }
    const payment = await adminPaymentModel.getPaymentDetail(id);
    if (!payment) {
      return sendError(res, 404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
    }
    sendOk(res, payment);
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/payments/:id/verify — the admin-only path that marks an
// order paid from a pending manual submission (server-side checks only).
async function verifyPayment(req, res, next) {
  try {
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'Payment id must be a UUID.',
      ]);
    }
    if (!rejectUnexpectedFields(req, res, new Set([]))) return;

    const result = await paymentService.adminVerifyPayment(req.user.id, id);
    sendOk(res, result);
  } catch (err) {
    if (err && err.status && typeof err.code === 'string' && err.message) {
      return sendError(res, err.status, err.code, err.message, err.details);
    }
    next(err);
  }
}

// POST /api/admin/payments/:id/reject — payment becomes failed ("Rejected");
// the order stays awaiting_payment so the customer can submit again.
async function rejectPayment(req, res, next) {
  try {
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'Payment id must be a UUID.',
      ]);
    }
    if (!rejectUnexpectedFields(req, res, new Set(['reason']))) return;

    const rawReason = req.body ? req.body.reason : null;
    let reason = null;
    if (rawReason !== undefined && rawReason !== null && rawReason !== '') {
      if (typeof rawReason !== 'string') {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          'Reason must be a string.',
        ]);
      }
      reason = rawReason.trim();
      if (reason.length > MAX_REJECTION_REASON) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `Reason must be at most ${MAX_REJECTION_REASON} characters.`,
        ]);
      }
      if (reason === '') reason = null;
    }

    const result = await paymentService.adminRejectPayment(
      req.user.id,
      id,
      reason
    );
    sendOk(res, result);
  } catch (err) {
    if (err && err.status && typeof err.code === 'string' && err.message) {
      return sendError(res, err.status, err.code, err.message, err.details);
    }
    next(err);
  }
}

// POST /api/admin/payments/:id/verify-uddoktapay — admin-triggered AUTOMATIC
// verification (PART K). No request data: the row and its recorded invoice
// come from the database and the gateway's Verify Payment API is the only
// authority. Settlement still runs through markOrderPaidFromVerifiedPayment.
async function verifyPaymentWithGateway(req, res, next) {
  try {
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'Payment id must be a UUID.',
      ]);
    }
    if (!rejectUnexpectedFields(req, res, new Set([]))) return;

    const result = await paymentService.adminVerifyWithGateway(req.user.id, id);
    sendOk(res, result);
  } catch (err) {
    if (err && err.status && typeof err.code === 'string' && err.message) {
      return sendError(res, err.status, err.code, err.message, err.details);
    }
    next(err);
  }
}

// POST /api/admin/payments/:id/manual-verify — admin MANUAL fallback for an
// unpaid gateway attempt (PART L). Only the listed keys are accepted: the
// exact amount, the external reference and an optional note. Amount/status/
// paid are never trusted from the body — paymentService validates everything
// against the locked payment and order rows.
async function manualVerifyPayment(req, res, next) {
  try {
    const id = req.params.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'Payment id must be a UUID.',
      ]);
    }
    if (
      !rejectUnexpectedFields(
        req,
        res,
        new Set(['transactionId', 'amount', 'currency', 'note'])
      )
    ) {
      return;
    }

    const body = req.body || {};
    const result = await paymentService.adminManualVerify(req.user.id, id, {
      transactionId: body.transactionId,
      amount: body.amount,
      currency: body.currency,
      note: body.note,
    });
    sendOk(res, result);
  } catch (err) {
    if (err && err.status && typeof err.code === 'string' && err.message) {
      return sendError(res, err.status, err.code, err.message, err.details);
    }
    next(err);
  }
}

module.exports = {
  me,
  health,
  dashboard,
  listOrders,
  getOrder,
  listCustomers,
  getCustomer,
  suspendCustomer,
  reactivateCustomer,
  resetCustomerPassword,
  listCustomerOrders,
  listCustomerPayments,
  listIncomingSms,
  listManualPayments,
  getPaymentDetail,
  verifyPayment,
  rejectPayment,
  verifyPaymentWithGateway,
  manualVerifyPayment,
};
