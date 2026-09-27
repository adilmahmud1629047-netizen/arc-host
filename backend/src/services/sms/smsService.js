const crypto = require('crypto');
const config = require('../../config');
const smsMessageModel = require('../../models/smsMessageModel');
const { createRateLimiter } = require('../../utils/rateLimiter');
const {
  SmsError,
  getProvider,
  notConfiguredError,
} = require('./smsProvider');

// Strict E.164 only: '+' , first digit 1-9, then 6-14 more digits (7-15 total).
// No silent normalization — local formats are rejected, never guessed.
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,49}$/;

// ~10 concatenated GSM-7 segments — a generous ceiling for transactional SMS.
const MESSAGE_MAX_LENGTH = 1600;
// Recipients per sendSms() call (bulk/campaign flows are out of scope).
const MAX_RECIPIENTS = 10;

function validationError(message) {
  return new SmsError(400, 'VALIDATION_ERROR', message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertRecipients(recipients) {
  if (!Array.isArray(recipients) || recipients.length < 1) {
    throw validationError('Recipients must be a non-empty array.');
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw validationError(
      `Recipients exceeds the maximum of ${MAX_RECIPIENTS} per message.`
    );
  }
  for (const recipient of recipients) {
    if (typeof recipient !== 'string' || !E164_PATTERN.test(recipient)) {
      throw validationError(
        'Recipient must be in E.164 format (for example +8801712345678).'
      );
    }
  }
}

function assertMessage(message) {
  if (typeof message !== 'string') {
    throw validationError('Message must be a string.');
  }
  if (message.trim().length === 0) {
    throw validationError('Message must not be empty.');
  }
  if (message.length > MESSAGE_MAX_LENGTH) {
    throw validationError(
      `Message exceeds the maximum length of ${MESSAGE_MAX_LENGTH} characters.`
    );
  }
  if (message.includes('\u0000')) {
    throw validationError('Message contains invalid characters.');
  }
  // Credentials must never travel inside message content.
  const apiKey = config.sms.textbee.apiKey;
  if (apiKey && message.includes(apiKey)) {
    throw validationError('Message must not contain credentials.');
  }
}

function assertOptions({ deviceId, simSubscriptionId, userId, messageType }) {
  if (
    deviceId !== undefined &&
    deviceId !== null &&
    deviceId !== '' &&
    (typeof deviceId !== 'string' || deviceId.length > 100)
  ) {
    throw validationError('Invalid device id.');
  }
  if (
    simSubscriptionId !== undefined &&
    simSubscriptionId !== null &&
    simSubscriptionId !== '' &&
    (!Number.isInteger(simSubscriptionId) || simSubscriptionId < 1)
  ) {
    throw validationError('Invalid SIM subscription id.');
  }
  if (
    userId !== undefined &&
    userId !== null &&
    userId !== '' &&
    (typeof userId !== 'string' || !UUID_PATTERN.test(userId))
  ) {
    throw validationError('Invalid user id.');
  }
  if (
    messageType !== undefined &&
    messageType !== null &&
    messageType !== '' &&
    (typeof messageType !== 'string' || !MESSAGE_TYPE_PATTERN.test(messageType))
  ) {
    throw validationError('Invalid message type.');
  }
}

// Best-effort audit update — a logging failure must never mask the real
// provider outcome (success stays success, the original error stays thrown).
async function safeMark(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// Central send path. Business features (future OTP, order/payment notices)
// call this — never a provider directly. Internal only: there is no HTTP
// endpoint that accepts user-controlled recipients or message bodies.
async function sendSms({
  recipients,
  message,
  deviceId = null,
  simSubscriptionId = null,
  userId = null,
  messageType = null,
} = {}) {
  assertRecipients(recipients);
  assertMessage(message);
  assertOptions({ deviceId, simSubscriptionId, userId, messageType });

  const providerName = config.sms.provider;
  const provider = getProvider(providerName);
  if (!provider) throw notConfiguredError();

  const recipientHashes = recipients.map((recipient) => sha256(recipient));
  const attemptIds = await smsMessageModel.createAttempts({
    provider: provider.name,
    userId: userId || null,
    recipientHashes,
    messageType: messageType || null,
    recipientCount: recipients.length,
  });

  let result;
  try {
    result = await provider.sendSms({
      recipients,
      message,
      deviceId,
      simSubscriptionId,
    });
  } catch (err) {
    await safeMark(() =>
      smsMessageModel.markFailed(
        attemptIds,
        err && typeof err.code === 'string' ? err.code : null
      )
    );
    throw err;
  }

  await safeMark(() =>
    smsMessageModel.markAccepted(attemptIds, {
      providerBatchId: (result && result.providerBatchId) || null,
      providerMessageId: (result && result.providerMessageId) || null,
    })
  );

  // Honest result: "accepted" means the provider accepted the request —
  // delivery is confirmed separately (future webhooks), never claimed here.
  return {
    provider: provider.name,
    status: 'accepted',
    recipientCount: recipients.length,
    providerMessageId: (result && result.providerMessageId) || null,
    providerBatchId: (result && result.providerBatchId) || null,
    sentAt: new Date().toISOString(),
  };
}

// Conceptual getStatus() half of the provider interface. Delivery tracking is
// not implemented yet — providers answer honestly instead of guessing.
async function getStatus() {
  const provider = getProvider(config.sms.provider);
  if (!provider) throw notConfiguredError();
  return provider.getStatus();
}

// Exported for FUTURE internal transactional endpoints to mount — nothing is
// mounted today (no public /api/sms route exists by design).
const smsSendLimiter = createRateLimiter({
  name: 'sms-send',
  windowMs: config.rateLimit.smsSendWindowMs,
  max: config.rateLimit.smsSendMax,
});

module.exports = {
  sendSms,
  getStatus,
  smsSendLimiter,
  SmsError,
  E164_PATTERN,
  MESSAGE_MAX_LENGTH,
  MAX_RECIPIENTS,
  MESSAGE_TYPE_PATTERN,
};
