const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config');
const db = require('../src/config/database');
const {
  verifySignature,
  WebhookError,
  toPaymentCandidate,
  handleIncomingSms,
  assertTrustedDevice,
} = require('../src/services/sms/textbeeWebhook');
const smsIncomingModel = require('../src/models/smsIncomingModel');
const { getProvider } = require('../src/services/sms/smsProvider');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;
const WEBHOOK_PATH = '/webhooks/textbee/sms';

// Test-only HMAC secret. Must match the NODE_ENV=test fixture in
// src/config/index.js (the test server signs/verifies with it). Not a real
// TextBee credential and never stored in .env.
const TEST_SECRET = 'textbee-webhook-secret-for-tests-20chars-min';
const TEST_API_KEY = 'textbee-api-key-must-not-leak';
const uniqueSuffix = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function sign(rawBody, secret = TEST_SECRET) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function buildPayload(overrides = {}) {
  const id = uniqueSuffix();
  return {
    smsId: `sms_${id}`,
    message: 'Payment received for order FLARE-TEST-1 amount 500 BDT',
    deviceId: 'device_test_1',
    webhookSubscriptionId: 'whsub_test_1',
    webhookEvent: 'MESSAGE_RECEIVED',
    idempotencyKey: `idem_${id}`,
    sender: '+8801712345678',
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function postWebhook(rawBody, signature) {
  const headers = { 'Content-Type': 'application/json' };
  if (signature !== undefined) headers['x-signature'] = signature;
  const response = await fetch(`${API}${WEBHOOK_PATH}`, {
    method: 'POST',
    headers,
    body:
      typeof rawBody === 'string' || Buffer.isBuffer(rawBody)
        ? rawBody
        : JSON.stringify(rawBody),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

async function countForIdempotency(key) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM sms_incoming_events WHERE idempotency_key = $1',
    [key]
  );
  return rows[0].n;
}

async function anyPaidOrders() {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM orders WHERE status = 'paid'`
  );
  return rows[0].n;
}

let paidBefore = 0;

before(async () => {
  config.sms.provider = 'textbee';
  config.sms.textbee.webhookSecret = TEST_SECRET;
  config.sms.textbee.apiKey = TEST_API_KEY;
  paidBefore = await anyPaidOrders();
});

after(async () => {
  config.sms.textbee.webhookSecret = '';
  config.sms.textbee.apiKey = '';
  config.sms.provider = 'disabled';
});

test('verifySignature: valid HMAC-SHA256 matches', () => {
  const raw = Buffer.from(JSON.stringify({ a: 1 }));
  assert.equal(verifySignature(raw, sign(raw), TEST_SECRET), true);
});

test('verifySignature: invalid signature rejected', () => {
  const raw = Buffer.from(JSON.stringify({ a: 1 }));
  assert.equal(verifySignature(raw, 'deadbeef', TEST_SECRET), false);
  assert.equal(verifySignature(raw, sign(raw), 'wrong-secret'), false);
});

test('verifySignature: missing signature / empty secret rejected', () => {
  const raw = Buffer.from(JSON.stringify({ a: 1 }));
  assert.equal(verifySignature(raw, '', TEST_SECRET), false);
  assert.equal(verifySignature(raw, sign(raw), ''), false);
  assert.equal(verifySignature(raw, null, TEST_SECRET), false);
});

test('verifySignature: length mismatch does not throw (timing-safe path)', () => {
  const raw = Buffer.from('x');
  assert.doesNotThrow(() => verifySignature(raw, 'short', TEST_SECRET));
  assert.equal(verifySignature(raw, 'short', TEST_SECRET), false);
});

test('HTTP: valid signature -> 200 and stores event', async () => {
  const payload = buildPayload();
  const raw = JSON.stringify(payload);
  const { response, body } = await postWebhook(raw, sign(raw));
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.stored, true);
  assert.equal(body.data.status, 'received');
  assert.equal(await countForIdempotency(payload.idempotencyKey), 1);
});

test('HTTP: invalid signature -> 401, nothing stored', async () => {
  const payload = buildPayload();
  const raw = JSON.stringify(payload);
  const { response, body } = await postWebhook(raw, '0'.repeat(64));
  assert.equal(response.status, 401);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'WEBHOOK_UNAUTHORIZED');
  assert.equal(await countForIdempotency(payload.idempotencyKey), 0);
});

test('HTTP: missing signature -> 401', async () => {
  const payload = buildPayload();
  const raw = JSON.stringify(payload);
  const { response } = await postWebhook(raw, undefined);
  assert.equal(response.status, 401);
  assert.equal(await countForIdempotency(payload.idempotencyKey), 0);
});

test('HTTP: malformed JSON -> 400', async () => {
  const raw = '{not-json';
  const { response, body } = await postWebhook(raw, sign(raw));
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('HTTP: missing smsId -> 400', async () => {
  const payload = buildPayload();
  delete payload.smsId;
  const raw = JSON.stringify(payload);
  const { response } = await postWebhook(raw, sign(raw));
  assert.equal(response.status, 400);
  assert.equal(await countForIdempotency(payload.idempotencyKey), 0);
});

test('HTTP: missing idempotencyKey -> 400', async () => {
  const payload = buildPayload();
  delete payload.idempotencyKey;
  const raw = JSON.stringify(payload);
  const { response } = await postWebhook(raw, sign(raw));
  assert.equal(response.status, 400);
});

test('HTTP: wrong webhookEvent -> 400', async () => {
  const payload = buildPayload({ webhookEvent: 'MESSAGE_SENT' });
  const raw = JSON.stringify(payload);
  const { response } = await postWebhook(raw, sign(raw));
  assert.equal(response.status, 400);
});

test('HTTP: oversized message -> 400', async () => {
  const payload = buildPayload({ message: 'x'.repeat(1601) });
  const raw = JSON.stringify(payload);
  const { response } = await postWebhook(raw, sign(raw));
  assert.equal(response.status, 400);
});

test('HTTP: null byte in message -> 400', async () => {
  const payload = buildPayload({ message: 'hello' + String.fromCharCode(0) + 'world' });
  const raw = JSON.stringify(payload);
  const { response } = await postWebhook(raw, sign(raw));
  assert.equal(response.status, 400);
});

test('HTTP: duplicate webhook returns 200 without second row', async () => {
  const payload = buildPayload();
  const raw = JSON.stringify(payload);
  const first = await postWebhook(raw, sign(raw));
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.stored, true);

  const second = await postWebhook(raw, sign(raw));
  assert.equal(second.response.status, 200);
  assert.equal(second.body.success, true);
  assert.equal(second.body.data.stored, false);
  assert.equal(await countForIdempotency(payload.idempotencyKey), 1);
});

test('HTTP: response never contains API key or webhook secret', async () => {
  const payload = buildPayload();
  const raw = JSON.stringify(payload);
  const { response, body } = await postWebhook(raw, sign(raw));
  assert.equal(response.status, 200);
  const text = JSON.stringify(body);
  assert.ok(!text.includes(TEST_API_KEY));
  assert.ok(!text.includes(TEST_SECRET));
  assert.ok(!/x-api-key|password_hash|session_hash/i.test(text));
});

test('HTTP: no order becomes paid after stored SMS', async () => {
  const payload = buildPayload({
    message: 'FLARE order paid amount 999 transaction TX-NEVER',
  });
  const raw = JSON.stringify(payload);
  const { response } = await postWebhook(raw, sign(raw));
  assert.equal(response.status, 200);
  const paidAfter = await anyPaidOrders();
  assert.equal(paidAfter, paidBefore, 'orders paid count must not change');
});

test('toPaymentCandidate never claims proof', () => {
  const c = toPaymentCandidate({ sender: '+8801700000000' });
  assert.equal(c.amount, null);
  assert.equal(c.transactionId, null);
  assert.equal(c.confidence, 'unknown');
});

test('SMS_PROVIDER=disabled does not activate TextBee send', async () => {
  const previous = config.sms.provider;
  config.sms.provider = 'disabled';
  try {
    assert.equal(getProvider('disabled').name, 'disabled');
    const provider = getProvider(config.sms.provider);
    assert.equal(provider.name, 'disabled');
  } finally {
    config.sms.provider = previous;
  }
});

test('missing webhook secret -> 503 (not configured)', async () => {
  const previous = config.sms.textbee.webhookSecret;
  config.sms.textbee.webhookSecret = '';
  try {
    const raw = JSON.stringify(buildPayload());
    await assert.rejects(
      () => handleIncomingSms(Buffer.from(raw), sign(raw)),
      (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.code, 'SMS_PROVIDER_NOT_CONFIGURED');
        return true;
      }
    );
  } finally {
    config.sms.textbee.webhookSecret = previous;
  }
});

test('stored row has status received/unverified only (never paid)', async () => {
  const payload = buildPayload();
  const raw = JSON.stringify(payload);
  await postWebhook(raw, sign(raw));
  const { rows } = await db.query(
    `SELECT status, direction, provider FROM sms_incoming_events
     WHERE idempotency_key = $1`,
    [payload.idempotencyKey]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'textbee');
  assert.equal(rows[0].direction, 'received');
  assert.ok(['received', 'unverified', 'parsed', 'rejected'].includes(rows[0].status));
});

test('migration count is 18 after 018_admin_product_catalog', async () => {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM schema_migrations'
  );
  assert.equal(rows[0].n, 18);
});

test('admin GET /api/admin/sms/incoming requires admin session', async () => {
  const response = await fetch(`${API}/admin/sms/incoming`);
  assert.equal(response.status, 401);
});

test('model mask helpers never return full secrets', () => {
  assert.equal(smsIncomingModel.maskSender('+8801712345678'), '***5678');
  const preview = smsIncomingModel.maskPreview('y'.repeat(200));
  assert.ok(preview.length <= smsIncomingModel.PREVIEW_LENGTH + 1);
  assert.ok(preview.endsWith('...') || preview.endsWith('\u2026'));
});

test('no source file under services/sms references markOrderPaid', () => {
  const dir = path.join(__dirname, '../src/services/sms');
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(
      !src.includes('markOrderPaidFromVerifiedPayment'),
      `${file} must not call markOrderPaidFromVerifiedPayment`
    );
  }
});

test('WebhookError carries status/code only', () => {
  const err = new WebhookError(401, 'WEBHOOK_UNAUTHORIZED', 'nope');
  assert.equal(err.status, 401);
  assert.equal(err.code, 'WEBHOOK_UNAUTHORIZED');
});

// --- Step 21: optional trusted-device gate (after HMAC, never instead of it) ---

async function withDeviceId(expected, fn) {
  const prev = config.sms.textbee.deviceId;
  config.sms.textbee.deviceId = expected;
  try {
    return await fn();
  } finally {
    config.sms.textbee.deviceId = prev;
  }
}

test('device gate: empty TEXTBEE_DEVICE_ID accepts any/missing deviceId (legacy)', async () => {
  await withDeviceId('', () => {
    assert.doesNotThrow(() => assertTrustedDevice('device_test_1'));
    assert.doesNotThrow(() => assertTrustedDevice(null));
    assert.doesNotThrow(() => assertTrustedDevice(undefined));
    assert.doesNotThrow(() => assertTrustedDevice(''));
  });
});

test('device gate: configured + matching deviceId accepted', async () => {
  await withDeviceId('trusted_device_abc', () => {
    assert.doesNotThrow(() => assertTrustedDevice('trusted_device_abc'));
  });
});

test('device gate: configured + mismatched deviceId rejected with 401', async () => {
  await withDeviceId('trusted_device_abc', () => {
    assert.throws(
      () => assertTrustedDevice('other_device'),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.code, 'WEBHOOK_UNAUTHORIZED');
        assert.ok(!String(err.message).includes('trusted_device_abc'));
        return true;
      }
    );
  });
});

test('device gate: configured + missing/null deviceId rejected safely', async () => {
  await withDeviceId('trusted_device_abc', () => {
    for (const bad of [null, undefined, '', 123, {}]) {
      assert.throws(
        () => assertTrustedDevice(bad),
        (err) => {
          assert.equal(err.status, 401);
          assert.equal(err.code, 'WEBHOOK_UNAUTHORIZED');
          return true;
        },
        `deviceId=${String(bad)} must be rejected`
      );
    }
  });
});

test('HTTP/unit: matching deviceId accepted via handleIncomingSms', async () => {
  await withDeviceId('trusted_device_abc', async () => {
    const payload = buildPayload({ deviceId: 'trusted_device_abc' });
    const raw = Buffer.from(JSON.stringify(payload));
    const result = await handleIncomingSms(raw, sign(raw));
    assert.equal(result.ok, true);
    assert.equal(result.stored, true);
    assert.equal(await countForIdempotency(payload.idempotencyKey), 1);
  });
});

test('HTTP/unit: mismatched deviceId rejected via handleIncomingSms, nothing stored', async () => {
  await withDeviceId('trusted_device_abc', async () => {
    const payload = buildPayload({ deviceId: 'evil_device' });
    const raw = Buffer.from(JSON.stringify(payload));
    await assert.rejects(
      () => handleIncomingSms(raw, sign(raw)),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.code, 'WEBHOOK_UNAUTHORIZED');
        assert.ok(!JSON.stringify({ m: err.message }).includes('trusted_device_abc'));
        return true;
      }
    );
    assert.equal(await countForIdempotency(payload.idempotencyKey), 0);
  });
});

test('HTTP/unit: missing deviceId when configured rejected via handleIncomingSms', async () => {
  await withDeviceId('trusted_device_abc', async () => {
    const payload = buildPayload();
    delete payload.deviceId;
    const raw = Buffer.from(JSON.stringify(payload));
    await assert.rejects(
      () => handleIncomingSms(raw, sign(raw)),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.code, 'WEBHOOK_UNAUTHORIZED');
        return true;
      }
    );
    assert.equal(await countForIdempotency(payload.idempotencyKey), 0);
  });
});

test('device gate: configured + invalid/missing HMAC still rejected first', async () => {
  await withDeviceId('trusted_device_abc', async () => {
    const payload = buildPayload({ deviceId: 'trusted_device_abc' });
    const raw = Buffer.from(JSON.stringify(payload));

    await assert.rejects(
      () => handleIncomingSms(raw, '0'.repeat(64)),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.code, 'WEBHOOK_UNAUTHORIZED');
        return true;
      }
    );
    await assert.rejects(
      () => handleIncomingSms(raw, undefined),
      (err) => {
        assert.equal(err.status, 401);
        return true;
      }
    );
    assert.equal(await countForIdempotency(payload.idempotencyKey), 0);
  });
});

test('device gate: duplicate delivery remains idempotent when device matches', async () => {
  await withDeviceId('trusted_device_abc', async () => {
    const payload = buildPayload({ deviceId: 'trusted_device_abc' });
    const raw = Buffer.from(JSON.stringify(payload));
    const first = await handleIncomingSms(raw, sign(raw));
    assert.equal(first.stored, true);
    const second = await handleIncomingSms(raw, sign(raw));
    assert.equal(second.ok, true);
    assert.equal(second.stored, false);
    assert.equal(await countForIdempotency(payload.idempotencyKey), 1);
  });
});

test('device gate: BKASH_PAYMENT_ENABLED=false still prevents payment processing', async () => {
  const prevEnabled = config.payments.bkash.enabled;
  config.payments.bkash.enabled = false;
  try {
    await withDeviceId('trusted_device_abc', async () => {
      const paidBefore = await anyPaidOrders();
      const payload = buildPayload({
        deviceId: 'trusted_device_abc',
        message:
          'You have received Tk 2,470.00 from 01917210879. Fee Tk 0.00. Balance Tk 2,633.06. TrxID DFD09UPC86 at 13/06/2026 12:10',
      });
      const raw = Buffer.from(JSON.stringify(payload));
      const result = await handleIncomingSms(raw, sign(raw));
      assert.equal(result.ok, true);
      assert.equal(result.stored, true);
      assert.equal(result.status, 'received');
      assert.equal(result.verification && result.verification.reason, 'BKASH_DISABLED');
      assert.equal(await anyPaidOrders(), paidBefore);
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM payment_transactions
         WHERE provider = 'bkash' OR payment_method = 'bkash_sms'`
      );
      assert.equal(rows[0].n, 0);
    });
  } finally {
    config.payments.bkash.enabled = prevEnabled;
  }
});

test('device gate: response never contains configured TEXTBEE_DEVICE_ID', async () => {
  await withDeviceId('trusted_device_secret_id_do_not_leak', async () => {
    const payload = buildPayload({ deviceId: 'evil_device' });
    const raw = Buffer.from(JSON.stringify(payload));
    try {
      await handleIncomingSms(raw, sign(raw));
      assert.fail('expected rejection');
    } catch (err) {
      const text = JSON.stringify({
        status: err.status,
        code: err.code,
        message: err.message,
      });
      assert.ok(!text.includes('trusted_device_secret_id_do_not_leak'));
      assert.ok(!text.includes('TEXTBEE_DEVICE_ID'));
    }
  });
});
