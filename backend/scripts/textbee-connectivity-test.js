'use strict';

// Temporary development-only TextBee connectivity test (Step 10A).
//
// Safety properties:
//   - Refuses to run when NODE_ENV=production.
//   - NOT an HTTP endpoint: no route is added, nothing is publicly reachable.
//   - Takes no arguments: fixed message, single recipient from
//     TEXTBEE_TEST_RECIPIENT env only — no arbitrary content or recipients.
//   - One send per invocation plus a 60-second per-recipient cooldown
//     (rate-limiting equivalent for a CLI tool).
//   - Never prints the API key or the raw recipient number.
//   - No automatic retries: a failure is reported as-is.

const crypto = require('crypto');

const FIXED_MESSAGE = 'FLARE HostiNG TextBee test SMS.';
const MESSAGE_TYPE = 'integration_test';
const COOLDOWN_MS = 60000;

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      'ABORT: connectivity test is disabled when NODE_ENV=production.'
    );
    process.exit(1);
  }
  if (process.argv.length > 2) {
    console.error(
      'ABORT: this script accepts no arguments (fixed message + env recipient only).'
    );
    process.exit(1);
  }

  const config = require('../src/config');
  const providerCfg = config.sms.textbee;
  const recipient = (process.env.TEXTBEE_TEST_RECIPIENT || '').trim();

  // Presence checks only — values (especially the API key) are never printed.
  const checks = {
    NODE_ENV: config.env,
    SMS_PROVIDER_is_textbee: config.sms.provider === 'textbee',
    TEXTBEE_API_KEY_present: Boolean(providerCfg.apiKey),
    TEXTBEE_BASE_URL_present: Boolean(providerCfg.baseUrl),
    TEXTBEE_DEVICE_ID_present: Boolean(providerCfg.deviceId),
    TEXTBEE_TEST_RECIPIENT_present: Boolean(recipient),
  };
  console.log('Configuration (secret values hidden):');
  for (const [key, value] of Object.entries(checks)) {
    console.log(`  ${key}: ${value}`);
  }

  const missing = [];
  if (!checks.SMS_PROVIDER_is_textbee) missing.push('SMS_PROVIDER=textbee');
  if (!checks.TEXTBEE_API_KEY_present) missing.push('TEXTBEE_API_KEY');
  if (!checks.TEXTBEE_BASE_URL_present) missing.push('TEXTBEE_BASE_URL');
  if (!checks.TEXTBEE_DEVICE_ID_present) missing.push('TEXTBEE_DEVICE_ID');
  if (!checks.TEXTBEE_TEST_RECIPIENT_present) {
    missing.push('TEXTBEE_TEST_RECIPIENT');
  }
  if (missing.length > 0) {
    // Names only — never values.
    console.error(`ABORT: missing configuration: ${missing.join(', ')}`);
    process.exit(1);
  }

  const smsService = require('../src/services/sms/smsService');
  if (!smsService.E164_PATTERN.test(recipient)) {
    console.error(
      'ABORT: TEXTBEE_TEST_RECIPIENT must be strict E.164 (for example +8801712345678).'
    );
    process.exit(1);
  }

  // Idempotent schema ensure so the audit row can be written.
  const { runUp } = require('../src/services/migrator');
  await runUp();

  const database = require('../src/config/database');
  const recipientHash = crypto
    .createHash('sha256')
    .update(recipient, 'utf8')
    .digest('hex');

  // Simple cooldown: at most one integration_test send per recipient per minute.
  const recent = await database.query(
    `SELECT COUNT(*)::int AS n FROM sms_messages
     WHERE recipient_hash = $1
       AND message_type = $2
       AND created_at > now() - ($3::int * interval '1 millisecond')`,
    [recipientHash, MESSAGE_TYPE, COOLDOWN_MS]
  );
  if (recent.rows[0].n > 0) {
    console.error('ABORT: cooldown active — one test per recipient per 60s.');
    await database.closePool();
    process.exit(1);
  }

  console.log('Sending exactly one test SMS through smsService.sendSms()...');
  let sendFailed = false;
  try {
    const result = await smsService.sendSms({
      recipients: [recipient],
      message: FIXED_MESSAGE,
      messageType: MESSAGE_TYPE,
    });
    // Normalized, safe-to-report result (no key, no raw provider body).
    console.log('Provider result (normalized):');
    console.log(JSON.stringify(result, null, 2));
    console.log(
      "Note: 'accepted' means TextBee accepted the request — delivery is not confirmed by this test."
    );
  } catch (err) {
    sendFailed = true;
    const safe = {
      status: err && err.status,
      code: err && err.code,
      message: err && err.message,
    };
    console.error('Provider error (safe normalized — no retry performed):');
    console.error(JSON.stringify(safe, null, 2));
  }

  // Verify the SMS audit record (hash lookup only — never selects raw numbers).
  try {
    const audit = await database.query(
      `SELECT id, provider, status, message_type, provider_batch_id,
              created_at, sent_at, failed_at, metadata
       FROM sms_messages
       WHERE recipient_hash = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [recipientHash]
    );
    if (audit.rows.length === 0) {
      console.error('Audit: NO sms_messages row found');
      sendFailed = true;
    } else {
      const row = audit.rows[0];
      console.log('Audit record (safe fields):');
      console.log(
        JSON.stringify(
          {
            id: row.id,
            provider: row.provider,
            status: row.status,
            messageType: row.message_type,
            providerBatchId: row.provider_batch_id,
            createdAt: row.created_at,
            sentAt: row.sent_at,
            failedAt: row.failed_at,
            metadata: row.metadata,
          },
          null,
          2
        )
      );
      if (!sendFailed && row.status !== 'accepted') sendFailed = true;
    }
  } catch (err) {
    console.error('Audit check failed:', err.message);
    sendFailed = true;
  }

  await database.closePool();
  if (sendFailed) {
    console.error('RESULT: connectivity test FAILED (no automatic retry).');
    // Set the code and let the event loop drain naturally — process.exit()
    // here can race still-closing sockets on Windows.
    process.exitCode = 1;
    return;
  }
  console.log(
    'RESULT: connectivity test OK — TextBee accepted the request (delivery not confirmed here).'
  );
}

main().catch((err) => {
  console.error('ABORT:', err && err.message ? err.message : String(err));
  process.exitCode = 1;
});
