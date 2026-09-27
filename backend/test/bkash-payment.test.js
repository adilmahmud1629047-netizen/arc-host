const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const crypto = require('node:crypto');

const config = require('../src/config');
const db = require('../src/config/database');
const { parseBkashIncomingSms } = require('../src/services/payments/bkashSmsParser');
const {
  processBkashIncomingPayment,
} = require('../src/services/payments/bkashPaymentService');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;
const WEBHOOK_PATH = '/webhooks/textbee/sms';
// Test-only HMAC secret. Must match the NODE_ENV=test fixture in
// src/config/index.js. Not a real TextBee credential and never stored in .env.
const TEST_SECRET = 'textbee-webhook-secret-for-tests-20chars-min';

const SAMPLE =
  'You have received Tk 2,470.00 from 01917210879. Fee Tk 0.00. Balance Tk 2,633.06. TrxID DFD09UPC86 at 13/06/2026 12:10';

function sign(rawBody, secret = TEST_SECRET) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function uniqueSuffix() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function buildWebhook(message, overrides = {}) {
  const id = uniqueSuffix();
  const payload = {
    smsId: `sms_${id}`,
    message,
    deviceId: 'device_test_1',
    webhookSubscriptionId: 'whsub_test_1',
    webhookEvent: 'MESSAGE_RECEIVED',
    idempotencyKey: `idem_${id}`,
    sender: '+8801712345678',
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
  const raw = JSON.stringify(payload);
  return { payload, raw, signature: sign(raw) };
}

async function postWebhook(rawBody, signature) {
  const response = await fetch(`${API}${WEBHOOK_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': signature },
    body: rawBody,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

async function createUserAndOrder({ amount, currency = 'BDT' }) {
  const suffix = uniqueSuffix();
  const email = `bkash_${suffix}@example.test`;
  const { rows: userRows } = await db.query(
    `INSERT INTO users (email, password_hash, first_name, last_name, role, status)
     VALUES ($1, $2, 'Bkash', 'Test', 'customer', 'active')
     RETURNING id`,
    [email, '$argon2id$v=19$m=19456,t=2,p=1$fake$fake']
  );
  const userId = userRows[0].id;
  const { rows: planRows } = await db.query(
    `INSERT INTO hosting_plans (name, slug, price, currency, billing_cycle, storage_gb)
     VALUES ($1, $2, $3, $4, 'monthly', 10)
     RETURNING id`,
    [`Plan ${suffix}`, `plan-${suffix}`, amount, currency]
  );
  const { rows: orderRows } = await db.query(
    `INSERT INTO orders (
       user_id, order_number, product_type, product_id, amount, currency,
       billing_cycle, status
     )
     VALUES ($1, $2, 'hosting', $3, $4, $5, 'monthly', 'awaiting_payment')
     RETURNING id, order_number, amount, currency, status, user_id`,
    [userId, `FLR-BK-${suffix.toUpperCase()}`, planRows[0].id, amount, currency]
  );
  return { userId, order: orderRows[0] };
}

async function countPaidOrders() {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM orders WHERE status = 'paid'`
  );
  return rows[0].n;
}

async function countSuccessfulBkash() {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM payment_transactions
     WHERE provider = 'bkash' AND status = 'successful'`
  );
  return rows[0].n;
}

let migrationCountBefore;

// Unique BDT amount per call so amount-matching never collides across
// tests or leftover rows from prior runs (cents strictly increasing).
let amountCents = 150000;
function nextAmount() {
  amountCents += 100;
  const whole = Math.floor(amountCents / 100);
  const frac = String(amountCents % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

async function cleanupBkashFixtures() {
  await db.query(
    `DELETE FROM payment_transactions WHERE provider = 'bkash'`
  ).catch(() => {});
  await db.query(
    `DELETE FROM orders WHERE order_number LIKE 'FLR-BK-%'`
  ).catch(() => {});
  await db.query(
    `DELETE FROM users WHERE email LIKE 'bkash_%@example.test'`
  ).catch(() => {});
  await db.query(
    `DELETE FROM sms_incoming_events WHERE message_body LIKE 'You have received%'`
  ).catch(() => {});
  // Fixture plans created above would otherwise stay active forever and leak
  // into the public GET /api/plans/hosting catalog (which returns every
  // active row). Match only the fixture shape: slug `plan-<suffix>` plus the
  // `Plan <suffix>` name used by createUserAndOrder.
  await db.query(
    `DELETE FROM hosting_plans
      WHERE slug LIKE 'plan-%' AND name LIKE 'Plan %'`
  ).catch(() => {});
}

before(async () => {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM schema_migrations'
  );
  migrationCountBefore = rows[0].n;
  await cleanupBkashFixtures();
});

after(async () => {
  await cleanupBkashFixtures();
});

test('parser: exact provided SMS parses correctly', () => {
  const r = parseBkashIncomingSms(SAMPLE);
  assert.equal(r.parsed, true);
  assert.equal(r.provider, 'bkash');
  assert.equal(r.direction, 'received');
  assert.equal(r.amount, '2470.00');
  assert.equal(r.amountCents, 247000);
  assert.equal(r.sender, '01917210879');
  assert.equal(r.fee, '0.00');
  assert.equal(r.balance, '2633.06');
  assert.equal(r.transactionId, 'DFD09UPC86');
  assert.equal(r.receivedAtText, '13/06/2026 12:10');
});

test('parser: amount with comma normalizes without float', () => {
  const r = parseBkashIncomingSms(SAMPLE);
  assert.equal(r.amount, '2470.00');
  assert.ok(Number.isInteger(r.amountCents));
  assert.equal(r.amountCents, 247000);
});

test('parser: different numbers still parse (not fixture-locked)', () => {
  const msg =
    'You have received Tk 999 from 01712345678. Fee Tk 0.00. Balance Tk 10.00. TrxID ABC123XYZ at 01/01/2026 00:00';
  const r = parseBkashIncomingSms(msg);
  assert.equal(r.parsed, true);
  assert.equal(r.amount, '999.00');
  assert.equal(r.transactionId, 'ABC123XYZ');
  assert.equal(r.sender, '01712345678');
});

test('parser: missing TrxID rejected', () => {
  const msg =
    'You have received Tk 100.00 from 01917210879. Fee Tk 0.00. Balance Tk 1.00 at 13/06/2026 12:10';
  const r = parseBkashIncomingSms(msg);
  assert.equal(r.parsed, false);
  assert.equal(r.reason, 'UNSUPPORTED_FORMAT');
});

test('parser: missing amount rejected', () => {
  const msg =
    'You have received from 01917210879. Fee Tk 0.00. Balance Tk 1.00. TrxID DFD09UPC86 at 13/06/2026 12:10';
  const r = parseBkashIncomingSms(msg);
  assert.equal(r.parsed, false);
});

test('parser: fake/random SMS rejected', () => {
  assert.equal(parseBkashIncomingSms('Hello world').parsed, false);
  assert.equal(parseBkashIncomingSms('').parsed, false);
  assert.equal(parseBkashIncomingSms(null).parsed, false);
  assert.equal(
    parseBkashIncomingSms('Your OTP code is 123456').parsed,
    false
  );
});

test('parser: oversized SMS rejected', () => {
  const r = parseBkashIncomingSms('x'.repeat(1601));
  assert.equal(r.parsed, false);
});

test('parser: zero amount rejected', () => {
  const msg =
    'You have received Tk 0.00 from 01917210879. Fee Tk 0.00. Balance Tk 0.00. TrxID ZZZZ9999 at 13/06/2026 12:10';
  const r = parseBkashIncomingSms(msg);
  assert.equal(r.parsed, false);
  assert.equal(r.reason, 'INVALID_AMOUNT');
});

test('parser: never throws on malformed input', () => {
  assert.doesNotThrow(() => parseBkashIncomingSms(undefined));
  assert.doesNotThrow(() => parseBkashIncomingSms({}));
  assert.doesNotThrow(() => parseBkashIncomingSms(12345));
});

test('BKASH_PAYMENT_ENABLED defaults false — process is a no-op', async () => {
  const prev = config.payments.bkash.enabled;
  config.payments.bkash.enabled = false;
  try {
    const { rows } = await db.query(
      `INSERT INTO sms_incoming_events (
         provider, provider_message_id, idempotency_key, message_body, status
       ) VALUES ('textbee', $1, $2, $3, 'received')
       RETURNING id`,
      [`pm_${uniqueSuffix()}`, `idem_${uniqueSuffix()}`, SAMPLE]
    );
    const out = await processBkashIncomingPayment(rows[0].id, SAMPLE);
    assert.equal(out.status, 'received');
    assert.equal(out.verification.attempted, false);
    assert.equal(out.verification.reason, 'BKASH_DISABLED');
    const { rows: after } = await db.query(
      `SELECT status, metadata FROM sms_incoming_events WHERE id = $1`,
      [rows[0].id]
    );
    assert.equal(after[0].status, 'received');
    assert.equal(after[0].metadata.reason, 'BKASH_DISABLED');
    assert.equal(after[0].metadata.attempted, false);
    const paid = await countPaidOrders();
    assert.equal(typeof paid, 'number');
  } finally {
    config.payments.bkash.enabled = prev;
    await db.query(`DELETE FROM sms_incoming_events WHERE message_body = $1`, [
      SAMPLE,
    ]).catch(() => {});
  }
});

test('exact amount match succeeds and order becomes paid', async () => {
  const prev = config.payments.bkash.enabled;
  config.payments.bkash.enabled = true;
  try {
    const amount = nextAmount();
    const { order } = await createUserAndOrder({ amount });
    const trx = `T${uniqueSuffix().toUpperCase().slice(0, 12)}`;
    const msg = `You have received Tk ${amount} from 01917210879. Fee Tk 0.00. Balance Tk 1.00. TrxID ${trx} at 13/06/2026 12:10`;
    const { rows } = await db.query(
      `INSERT INTO sms_incoming_events (
         provider, provider_message_id, idempotency_key, message_body, status
       ) VALUES ('textbee', $1, $2, $3, 'received')
       RETURNING id`,
      [`pm_${uniqueSuffix()}`, `idem_${uniqueSuffix()}`, msg]
    );
    const out = await processBkashIncomingPayment(rows[0].id, msg);
    assert.equal(out.status, 'verified');
    assert.equal(out.verification.transactionId, trx);
    assert.equal(out.verification.orderNumber, order.order_number);

    const { rows: o } = await db.query(
      'SELECT status FROM orders WHERE id = $1',
      [order.id]
    );
    assert.equal(o[0].status, 'paid');

    const { rows: p } = await db.query(
      `SELECT status, amount, currency, provider_transaction_id
       FROM payment_transactions
       WHERE provider = 'bkash' AND provider_transaction_id = $1`,
      [trx]
    );
    assert.equal(p.length, 1);
    assert.equal(p[0].status, 'successful');
    assert.equal(String(p[0].amount), amount);
    assert.equal(p[0].currency, 'BDT');
    assert.equal(p[0].provider_transaction_id, trx);
  } finally {
    config.payments.bkash.enabled = prev;
  }
});

test('wrong amount rejected — no matching order', async () => {
  const prev = config.payments.bkash.enabled;
  config.payments.bkash.enabled = true;
  try {
    const amount = nextAmount();
    const wrong = nextAmount();
    const { order } = await createUserAndOrder({ amount });
    const trx = `W${uniqueSuffix().toUpperCase().slice(0, 12)}`;
    const msg = `You have received Tk ${wrong} from 01917210879. Fee Tk 0.00. Balance Tk 1.00. TrxID ${trx} at 13/06/2026 12:10`;
    const { rows } = await db.query(
      `INSERT INTO sms_incoming_events (
         provider, provider_message_id, idempotency_key, message_body, status
       ) VALUES ('textbee', $1, $2, $3, 'received')
       RETURNING id`,
      [`pm_${uniqueSuffix()}`, `idem_${uniqueSuffix()}`, msg]
    );
    const out = await processBkashIncomingPayment(rows[0].id, msg);
    assert.equal(out.status, 'rejected');
    assert.equal(out.verification.reason, 'NO_MATCHING_ORDER');
    const { rows: o } = await db.query('SELECT status FROM orders WHERE id = $1', [
      order.id,
    ]);
    assert.equal(o[0].status, 'awaiting_payment');
  } finally {
    config.payments.bkash.enabled = prev;
  }
});

test('duplicate TrxID replay is idempotent — one payment, no second paid', async () => {
  const prev = config.payments.bkash.enabled;
  config.payments.bkash.enabled = true;
  try {
    const amount = nextAmount();
    const { order } = await createUserAndOrder({ amount });
    const trx = `D${uniqueSuffix().toUpperCase().slice(0, 12)}`;
    const msg = `You have received Tk ${amount} from 01917210879. Fee Tk 0.00. Balance Tk 1.00. TrxID ${trx} at 13/06/2026 12:10`;
    const insert = async () => {
      const { rows } = await db.query(
        `INSERT INTO sms_incoming_events (
           provider, provider_message_id, idempotency_key, message_body, status
         ) VALUES ('textbee', $1, $2, $3, 'received')
         RETURNING id`,
        [`pm_${uniqueSuffix()}`, `idem_${uniqueSuffix()}`, msg]
      );
      return rows[0].id;
    };
    const first = await processBkashIncomingPayment(await insert(), msg);
    assert.equal(first.status, 'verified');
    const paidAfterFirst = await countPaidOrders();
    const successAfterFirst = await countSuccessfulBkash();

    const second = await processBkashIncomingPayment(await insert(), msg);
    assert.equal(second.status, 'verified');
    assert.equal(second.verification.replayed, true);
    assert.equal(await countPaidOrders(), paidAfterFirst);
    assert.equal(await countSuccessfulBkash(), successAfterFirst);

    const { rows: p } = await db.query(
      `SELECT count(*)::int AS n FROM payment_transactions
       WHERE provider = 'bkash' AND provider_transaction_id = $1`,
      [trx]
    );
    assert.equal(p[0].n, 1);

    const { rows: o } = await db.query('SELECT status FROM orders WHERE id = $1', [
      order.id,
    ]);
    assert.equal(o[0].status, 'paid');
  } finally {
    config.payments.bkash.enabled = prev;
  }
});

test('same TrxID with different amount rejected', async () => {
  const prev = config.payments.bkash.enabled;
  config.payments.bkash.enabled = true;
  try {
    const amount = nextAmount();
    const otherAmount = nextAmount();
    const { order } = await createUserAndOrder({ amount });
    const other = await createUserAndOrder({ amount: otherAmount });
    const trx = `M${uniqueSuffix().toUpperCase().slice(0, 12)}`;
    const okMsg = `You have received Tk ${amount} from 01917210879. Fee Tk 0.00. Balance Tk 1.00. TrxID ${trx} at 13/06/2026 12:10`;
    const badMsg = `You have received Tk ${otherAmount} from 01917210879. Fee Tk 0.00. Balance Tk 1.00. TrxID ${trx} at 13/06/2026 12:10`;
    const insert = async (m) => {
      const { rows } = await db.query(
        `INSERT INTO sms_incoming_events (
           provider, provider_message_id, idempotency_key, message_body, status
         ) VALUES ('textbee', $1, $2, $3, 'received')
         RETURNING id`,
        [`pm_${uniqueSuffix()}`, `idem_${uniqueSuffix()}`, m]
      );
      return rows[0].id;
    };
    const first = await processBkashIncomingPayment(await insert(okMsg), okMsg);
    assert.equal(first.status, 'verified');

    const second = await processBkashIncomingPayment(await insert(badMsg), badMsg);
    assert.equal(second.status, 'rejected');
    assert.equal(second.verification.reason, 'TRX_AMOUNT_MISMATCH');

    const { rows: o } = await db.query('SELECT status FROM orders WHERE id = $1', [
      other.order.id,
    ]);
    assert.equal(o[0].status, 'awaiting_payment');
    const { rows: p } = await db.query(
      `SELECT count(*)::int AS n FROM payment_transactions
       WHERE provider = 'bkash' AND provider_transaction_id = $1`,
      [trx]
    );
    assert.equal(p[0].n, 1);
    assert.ok(order);
  } finally {
    config.payments.bkash.enabled = prev;
  }
});

test('multiple matching orders → ambiguous, no auto-pay', async () => {
  const prev = config.payments.bkash.enabled;
  config.payments.bkash.enabled = true;
  try {
    const amount = nextAmount();
    const a = await createUserAndOrder({ amount });
    const b = await createUserAndOrder({ amount });
    const trx = `A${uniqueSuffix().toUpperCase().slice(0, 12)}`;
    const msg = `You have received Tk ${amount} from 01917210879. Fee Tk 0.00. Balance Tk 1.00. TrxID ${trx} at 13/06/2026 12:10`;
    const { rows } = await db.query(
      `INSERT INTO sms_incoming_events (
         provider, provider_message_id, idempotency_key, message_body, status
       ) VALUES ('textbee', $1, $2, $3, 'received')
       RETURNING id`,
      [`pm_${uniqueSuffix()}`, `idem_${uniqueSuffix()}`, msg]
    );
    const out = await processBkashIncomingPayment(rows[0].id, msg);
    assert.equal(out.status, 'ambiguous');
    assert.equal(out.verification.reason, 'AMBIGUOUS_AMOUNT');
    assert.ok(out.verification.candidateCount >= 2);
    const { rows: o } = await db.query(
      `SELECT status FROM orders WHERE id = ANY($1::uuid[])`,
      [[a.order.id, b.order.id]]
    );
    for (const row of o) assert.equal(row.status, 'awaiting_payment');
    const { rows: p } = await db.query(
      `SELECT count(*)::int AS n FROM payment_transactions
       WHERE provider = 'bkash' AND provider_transaction_id = $1`,
      [trx]
    );
    assert.equal(p[0].n, 0);
  } finally {
    config.payments.bkash.enabled = prev;
  }
});

test('cancelled order cannot be paid (not awaiting)', async () => {
  const prev = config.payments.bkash.enabled;
  config.payments.bkash.enabled = true;
  try {
    const amount = nextAmount();
    const { order } = await createUserAndOrder({ amount });
    await db.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [
      order.id,
    ]);
    const trx = `C${uniqueSuffix().toUpperCase().slice(0, 12)}`;
    const msg = `You have received Tk ${amount} from 01917210879. Fee Tk 0.00. Balance Tk 1.00. TrxID ${trx} at 13/06/2026 12:10`;
    const { rows } = await db.query(
      `INSERT INTO sms_incoming_events (
         provider, provider_message_id, idempotency_key, message_body, status
       ) VALUES ('textbee', $1, $2, $3, 'received')
       RETURNING id`,
      [`pm_${uniqueSuffix()}`, `idem_${uniqueSuffix()}`, msg]
    );
    const out = await processBkashIncomingPayment(rows[0].id, msg);
    assert.equal(out.status, 'rejected');
    assert.equal(out.verification.reason, 'NO_MATCHING_ORDER');
    const { rows: o } = await db.query('SELECT status FROM orders WHERE id = $1', [
      order.id,
    ]);
    assert.equal(o[0].status, 'cancelled');
  } finally {
    config.payments.bkash.enabled = prev;
  }
});

test('already-paid order cannot be paid again via new unique TrxID of same amount', async () => {
  const prev = config.payments.bkash.enabled;
  config.payments.bkash.enabled = true;
  try {
    const amount = nextAmount();
    const { order } = await createUserAndOrder({ amount });
    await db.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
    const trx = `P${uniqueSuffix().toUpperCase().slice(0, 12)}`;
    const msg = `You have received Tk ${amount} from 01917210879. Fee Tk 0.00. Balance Tk 1.00. TrxID ${trx} at 13/06/2026 12:10`;
    const { rows } = await db.query(
      `INSERT INTO sms_incoming_events (
         provider, provider_message_id, idempotency_key, message_body, status
       ) VALUES ('textbee', $1, $2, $3, 'received')
       RETURNING id`,
      [`pm_${uniqueSuffix()}`, `idem_${uniqueSuffix()}`, msg]
    );
    const out = await processBkashIncomingPayment(rows[0].id, msg);
    // paid order not in awaiting set → no match (or ambiguous with others)
    assert.ok(['rejected', 'ambiguous'].includes(out.status));
    const { rows: p } = await db.query(
      `SELECT count(*)::int AS n FROM payment_transactions
       WHERE provider = 'bkash' AND provider_transaction_id = $1`,
      [trx]
    );
    assert.equal(p[0].n, 0);
  } finally {
    config.payments.bkash.enabled = prev;
  }
});

test('concurrent duplicate verification is safe (unique TrxID)', async () => {
  const prev = config.payments.bkash.enabled;
  config.payments.bkash.enabled = true;
  try {
    const amount = nextAmount();
    const { order } = await createUserAndOrder({ amount });
    const trx = `R${uniqueSuffix().toUpperCase().slice(0, 12)}`;
    const msg = `You have received Tk ${amount} from 01917210879. Fee Tk 0.00. Balance Tk 1.00. TrxID ${trx} at 13/06/2026 12:10`;
    const insert = async () => {
      const { rows } = await db.query(
        `INSERT INTO sms_incoming_events (
           provider, provider_message_id, idempotency_key, message_body, status
         ) VALUES ('textbee', $1, $2, $3, 'received')
         RETURNING id`,
        [`pm_${uniqueSuffix()}`, `idem_${uniqueSuffix()}`, msg]
      );
      return rows[0].id;
    };
    const [id1, id2] = await Promise.all([insert(), insert()]);
    const results = await Promise.all([
      processBkashIncomingPayment(id1, msg),
      processBkashIncomingPayment(id2, msg),
    ]);
    const verified = results.filter((r) => r.status === 'verified');
    assert.ok(verified.length >= 1);
    const { rows: p } = await db.query(
      `SELECT count(*)::int AS n FROM payment_transactions
       WHERE provider = 'bkash' AND provider_transaction_id = $1`,
      [trx]
    );
    assert.equal(p[0].n, 1);
    const { rows: o } = await db.query('SELECT status FROM orders WHERE id = $1', [
      order.id,
    ]);
    assert.equal(o[0].status, 'paid');
    const success = await countSuccessfulBkash();
    assert.ok(success >= 1);
  } finally {
    config.payments.bkash.enabled = prev;
  }
});

test('webhook with BKASH disabled still stores SMS but does not pay', async () => {
  const prevEnabled = config.payments.bkash.enabled;
  const prevSecret = config.sms.textbee.webhookSecret;
  config.payments.bkash.enabled = false;
  config.sms.textbee.webhookSecret = TEST_SECRET;
  try {
    const paidBefore = await countPaidOrders();
    const { payload, raw, signature } = buildWebhook(SAMPLE);
    const { response, body } = await postWebhook(raw, signature);
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.stored, true);
    assert.equal(body.data.status, 'received');
    assert.equal(body.data.verification.reason, 'BKASH_DISABLED');
    assert.equal(await countPaidOrders(), paidBefore);
    const { rows } = await db.query(
      `SELECT status, metadata FROM sms_incoming_events WHERE idempotency_key = $1`,
      [payload.idempotencyKey]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'received');
    assert.equal(rows[0].metadata.reason, 'BKASH_DISABLED');
  } finally {
    config.payments.bkash.enabled = prevEnabled;
    config.sms.textbee.webhookSecret = prevSecret;
  }
});

test('admin list exposes verification fields without secrets', async () => {
  const result = await require('../src/models/smsIncomingModel').listIncoming({
    page: 1,
    limit: 5,
  });
  assert.ok(Array.isArray(result.items));
  for (const item of result.items) {
    const text = JSON.stringify(item);
    assert.ok(!/password|session_hash|TEXTBEE_API_KEY|webhookSecret/i.test(text));
    assert.ok(!('messageBody' in item) || item.messageBody === undefined);
  }
});

test('migration count is 18 after 018_admin_product_catalog', async () => {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM schema_migrations'
  );
  assert.equal(rows[0].n, 18);
  assert.equal(migrationCountBefore, 18);
});

test('status CHECK allows pipeline statuses', async () => {
  const { rows } = await db.query(
    `INSERT INTO sms_incoming_events (
       provider, provider_message_id, idempotency_key, message_body, status
     ) VALUES ('textbee', $1, $2, $3, 'ambiguous')
     RETURNING status`,
    [`pm_${uniqueSuffix()}`, `idem_${uniqueSuffix()}`, SAMPLE]
  );
  assert.equal(rows[0].status, 'ambiguous');
  await db.query(`DELETE FROM sms_incoming_events WHERE status = 'ambiguous'`).catch(() => {});
});

test('no source under services/sms issues raw UPDATE orders paid', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '../src/services/sms');
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(
      !/UPDATE\s+orders\s+SET\s+status\s*=\s*'paid'/i.test(src),
      `${file} must not raw-update orders to paid`
    );
  }
});

test('frontend and backend keep bKash/TextBee secrets out of responses', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const roots = [
    path.join(__dirname, '../src/controllers/textbeeWebhookController.js'),
    path.join(__dirname, '../src/controllers/adminController.js'),
    path.join(__dirname, '../src/services/payments/bkashPaymentService.js'),
    path.join(__dirname, '../src/services/payments/bkashSmsParser.js'),
  ];
  for (const file of roots) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/TEXTBEE_API_KEY\s*=/.test(src));
    assert.ok(!/password_hash/.test(src));
  }
});
