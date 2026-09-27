const crypto = require('crypto');
const config = require('../../config');
const smsIncomingModel = require('../../models/smsIncomingModel');
const {
  processBkashIncomingPayment,
} = require('../payments/bkashPaymentService');

// TextBee MESSAGE_RECEIVED handler — authentication + validation + store,
// then optional bKash payment parse/verify (gated by BKASH_PAYMENT_ENABLED).

const MAX_BODY_BYTES = 16 * 1024;
const MESSAGE_MAX_LENGTH = 1600;
const SENDER_MAX_LENGTH = 64;
const ID_MAX_LENGTH = 255;
const EVENT_NAME = 'MESSAGE_RECEIVED';

class WebhookError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function authError(message = 'Webhook authentication failed.') {
  return new WebhookError(401, 'WEBHOOK_UNAUTHORIZED', message);
}

function validationError(message) {
  return new WebhookError(400, 'VALIDATION_ERROR', message);
}

function notConfiguredError() {
  return new WebhookError(
    503,
    'SMS_PROVIDER_NOT_CONFIGURED',
    'TextBee webhook is not configured.'
  );
}

function isNonEmptyString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

// Official TextBee scheme: HMAC-SHA256(rawBody, TEXTBEE_WEBHOOK_SECRET)
// compared to the X-Signature hex header (timing-safe, length-checked first).
function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || typeof secret !== 'string' || secret.length === 0) {
    return false;
  }
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return false;
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(signatureHeader, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function assertAuthenticated(rawBody, signatureHeader) {
  const secret = config.sms.textbee.webhookSecret;
  if (!secret) throw notConfiguredError();
  if (!signatureHeader) throw authError('Missing signature.');
  if (!verifySignature(rawBody, signatureHeader, secret)) {
    throw authError('Invalid signature.');
  }
}

// Optional trusted-device gate (after HMAC — never a substitute for it).
// TEXTBEE_DEVICE_ID empty → preserve legacy behavior (any/missing deviceId).
// When set: payload.deviceId must be present and exactly equal the expected id.
// Failures use the same auth error shape — never echo the expected id.
function assertTrustedDevice(deviceId) {
  const expected = config.sms.textbee.deviceId;
  if (!expected) return;
  if (typeof deviceId !== 'string' || deviceId !== expected) {
    throw authError('Webhook authentication failed.');
  }
}

function parseAndValidate(rawBody) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw validationError('Empty request body.');
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    throw validationError('Request body too large.');
  }
  if (rawBody.includes(0)) {
    throw validationError('Request body contains invalid characters.');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw validationError('Malformed JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw validationError('Payload must be a JSON object.');
  }

  if (payload.webhookEvent !== EVENT_NAME) {
    throw validationError('Unsupported webhook event.');
  }
  if (!isNonEmptyString(payload.smsId, ID_MAX_LENGTH)) {
    throw validationError('Missing or invalid smsId.');
  }
  if (!isNonEmptyString(payload.idempotencyKey, ID_MAX_LENGTH)) {
    throw validationError('Missing or invalid idempotencyKey.');
  }
  if (typeof payload.message !== 'string' || payload.message.length === 0) {
    throw validationError('Missing or invalid message.');
  }
  if (payload.message.length > MESSAGE_MAX_LENGTH) {
    throw validationError('Message exceeds maximum length.');
  }
  if (payload.message.includes("\u0000")) {
    throw validationError('Message contains invalid characters.');
  }
  if (
    payload.sender !== undefined &&
    payload.sender !== null &&
    payload.sender !== '' &&
    (typeof payload.sender !== 'string' ||
      payload.sender.length > SENDER_MAX_LENGTH)
  ) {
    throw validationError('Invalid sender.');
  }

  let receivedAt = null;
  if (payload.receivedAt !== undefined && payload.receivedAt !== null) {
    if (typeof payload.receivedAt !== 'string') {
      throw validationError('Invalid receivedAt.');
    }
    const parsed = Date.parse(payload.receivedAt);
    if (Number.isNaN(parsed)) {
      throw validationError('Invalid receivedAt.');
    }
    receivedAt = new Date(parsed).toISOString();
  }

  const sender =
    typeof payload.sender === 'string' && payload.sender
      ? payload.sender
      : null;
  const deviceId =
    typeof payload.deviceId === 'string' && payload.deviceId
      ? payload.deviceId.slice(0, ID_MAX_LENGTH)
      : null;
  const webhookSubscriptionId =
    typeof payload.webhookSubscriptionId === 'string' &&
    payload.webhookSubscriptionId
      ? payload.webhookSubscriptionId.slice(0, ID_MAX_LENGTH)
      : null;

  return {
    smsId: payload.smsId,
    idempotencyKey: payload.idempotencyKey,
    webhookEvent: payload.webhookEvent,
    message: payload.message,
    sender,
    receivedAt,
    deviceId,
    webhookSubscriptionId,
  };
}

// Pure helper — never marks anything paid. Structured candidate only.
function toPaymentCandidate(event) {
  return {
    amount: null,
    transactionId: null,
    sender: event && event.sender ? event.sender : null,
    confidence: 'unknown',
  };
}

async function handleIncomingSms(rawBody, signatureHeader) {
  assertAuthenticated(rawBody, signatureHeader);
  const event = parseAndValidate(rawBody);
  assertTrustedDevice(event.deviceId);

  const result = await smsIncomingModel.insertIncoming({
    provider: 'textbee',
    providerMessageId: event.smsId,
    idempotencyKey: event.idempotencyKey,
    webhookEvent: event.webhookEvent,
    direction: 'received',
    sender: event.sender,
    messageBody: event.message,
    receivedAt: event.receivedAt,
    deviceId: event.deviceId,
    webhookSubscriptionId: event.webhookSubscriptionId,
    metadata: {
      confidence: 'unknown',
      paymentCandidate: toPaymentCandidate(event),
    },
  });

  let status = result.row ? result.row.status : 'received';
  let verification = null;

  if (result.stored && result.row && result.row.id) {
    try {
      const processed = await processBkashIncomingPayment(
        result.row.id,
        event.message
      );
      status = processed.status;
      verification = processed.verification;
    } catch {
      // Never fail the webhook ack on verify-path bugs; event stays stored.
      verification = { attempted: true, error: 'VERIFY_INTERNAL' };
    }
  }

  // Always 200 for authenticated valid payloads — including duplicates.
  return {
    ok: true,
    stored: result.stored,
    status,
    verification,
  };
}

module.exports = {
  WebhookError,
  MAX_BODY_BYTES,
  MESSAGE_MAX_LENGTH,
  EVENT_NAME,
  verifySignature,
  parseAndValidate,
  assertTrustedDevice,
  handleIncomingSms,
  toPaymentCandidate,
  authError,
  validationError,
  notConfiguredError,
};
