const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Mutate rate-limit config BEFORE loading smsService — the limiter reads
// config at require time.
const config = require('../src/config');
config.rateLimit.smsSendWindowMs = 60000;
config.rateLimit.smsSendMax = 3;

const {
  sendSms,
  getStatus,
  smsSendLimiter,
  MESSAGE_MAX_LENGTH,
  MAX_RECIPIENTS,
} = require('../src/services/sms/smsService');
const smsTemplates = require('../src/services/sms/smsTemplates');
const {
  SmsProvider,
  SmsError,
  getProvider,
} = require('../src/services/sms/smsProvider');
const smsMessageModel = require('../src/models/smsMessageModel');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5056';
const API = `${BASE_URL}/api`;

const TEST_KEY = 'test-textbee-key-do-not-leak';
const UPSTREAM_MARKER = 'UPSTREAM_SECRET_BODY_MARKER_DO_NOT_ECHO';
const SAFE_PROVIDER_MESSAGE = 'SMS provider is temporarily unavailable.';
const SAFE_NOT_CONFIGURED_MESSAGE = 'SMS sending is not available yet.';

const unique = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const validPassword = () => `Str0ngPass${unique().slice(0, 8)}!`;

// Unique valid E.164 numbers per call so recipient_hash rows never collide
// across runs.
function uniqueRecipient() {
  const tail = `${Date.now().toString().slice(-6)}${Math.floor(
    Math.random() * 100
  )
    .toString()
    .padStart(2, '0')}`;
  return `+88017${tail}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? addr.port : null);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

function extractSessionCookie(setCookie) {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    if (raw.startsWith('fh_session=')) {
      const nameValue = raw.split(';')[0];
      if (nameValue === 'fh_session=' || nameValue === 'fh_session') return null;
      return nameValue;
    }
  }
  return null;
}

async function api(pathname, options = {}) {
  const response = await fetch(`${API}${pathname}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

function postJson(pathname, payload, headers = {}) {
  return api(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Mock TextBee gateway (local HTTP server posing as the official REST API).
// ---------------------------------------------------------------------------
const mock = {
  requests: [],
  mode: 'ok',
  batchCounter: 0,
};

const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = null;
    }
    mock.requests.push({
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      body,
    });

    const send = (status, payload, raw = null) => {
      try {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(raw !== null ? raw : JSON.stringify(payload));
      } catch {
        // connection already closed (e.g. client timeout)
      }
    };

    if (mock.mode.startsWith('status')) {
      send(parseInt(mock.mode.slice(6), 10), {
        message: UPSTREAM_MARKER,
        error: UPSTREAM_MARKER,
      });
      return;
    }
    if (mock.mode === 'bad-json') {
      res.setHeader('Content-Type', 'application/json');
      try {
        res.end('{"broken_json":');
      } catch {
        /* ignore */
      }
      return;
    }
    if (mock.mode === 'not-object') {
      send(200, null, '["array-not-object"]');
      return;
    }
    if (mock.mode === 'success-false') {
      send(200, { data: { success: false, message: UPSTREAM_MARKER } });
      return;
    }
    if (mock.mode === 'redirect') {
      res.statusCode = 302;
      res.setHeader('Location', 'http://evil.example.com/collect');
      res.end();
      return;
    }
    if (mock.mode === 'delay') {
      const timer = setTimeout(() => {
        send(200, {
          data: { success: true, smsBatchId: 'too-late', recipientCount: 1 },
        });
      }, 2500);
      if (typeof timer.unref === 'function') timer.unref();
      return;
    }

    mock.batchCounter += 1;
    send(200, {
      data: {
        success: true,
        message: 'Queued',
        smsBatchId: `batch-${mock.batchCounter}`,
        recipientCount:
          body && Array.isArray(body.recipients) ? body.recipients.length : 0,
      },
    });
  });
});

function configureSms(overrides = {}) {
  const {
    provider = 'textbee',
    apiKey = TEST_KEY,
    baseUrl = mockBaseUrl,
    deviceId = '',
    simSubscriptionId = null,
    timeoutMs = 2000,
  } = overrides;
  config.sms.provider = provider;
  config.sms.textbee.apiKey = apiKey;
  config.sms.textbee.baseUrl = baseUrl;
  config.sms.textbee.deviceId = deviceId;
  config.sms.textbee.simSubscriptionId = simSubscriptionId;
  config.sms.textbee.timeoutMs = timeoutMs;
}

async function captureConsole(fn) {
  const calls = [];
  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  const original = {};
  for (const level of levels) {
    original[level] = console[level];
    console[level] = (...args) => {
      calls.push(
        args
          .map((a) => {
            if (typeof a === 'string') return a;
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(' ')
      );
    };
  }
  try {
    const value = await fn();
    return { value, calls };
  } finally {
    for (const level of levels) console[level] = original[level];
  }
}

async function rowsForRecipient(recipient) {
  const { rows } = await require('../src/config/database').query(
    'SELECT * FROM sms_messages WHERE recipient_hash = $1 ORDER BY created_at DESC',
    [sha256(recipient)]
  );
  return rows;
}

async function countSmsRows() {
  const { rows } = await require('../src/config/database').query(
    'SELECT COUNT(*)::int AS n FROM sms_messages'
  );
  return rows[0].n;
}

async function tableExists(name) {
  const { rows } = await require('../src/config/database').query(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [name]
  );
  return rows[0].exists;
}

function assertSmsError(err, status, code, message) {
  assert.ok(err instanceof SmsError || (err && err.status), 'expected SmsError');
  assert.equal(err.status, status);
  assert.equal(err.code, code);
  if (message) assert.equal(err.message, message);
}

async function expectRejects(fn, status, code, message) {
  try {
    await fn();
  } catch (err) {
    assertSmsError(err, status, code, message);
    return err;
  }
  assert.fail(`expected error ${code} but call resolved`);
}

let database;
let mockBaseUrl;
let unusedPort;

before(async () => {
  const { runUp } = require('../src/services/migrator');
  await runUp();
  database = require('../src/config/database');

  const port = await listen(mockServer);
  mockBaseUrl = `http://127.0.0.1:${port}/api/v1`;

  // A port that was open a moment ago and is now closed → connection refused.
  const probe = http.createServer();
  const probePort = await listen(probe);
  await closeServer(probe);
  unusedPort = probePort;

  configureSms();
});

after(async () => {
  await closeServer(mockServer);
  if (database) await database.closePool();
});

// ---------------------------------------------------------------------------
// Registry / provider architecture
// ---------------------------------------------------------------------------

test('SMS provider registry exposes textbee and disabled; unknown ids stay unregistered', () => {
  assert.equal(getProvider('textbee').name, 'textbee');
  assert.equal(getProvider('disabled').name, 'disabled');
  assert.equal(getProvider(' TEXTBEE ').name, 'textbee');
  assert.equal(getProvider('carrier-pigeon'), null);
  assert.equal(getProvider(''), null);
  assert.equal(getProvider(null), null);
  assert.equal(getProvider(42), null);
});

test('base SmsProvider operations answer with SMS_PROVIDER_UNSUPPORTED', async () => {
  const base = new SmsProvider('abstract');
  await expectRejects(
    () => base.sendSms(),
    501,
    'SMS_PROVIDER_UNSUPPORTED'
  );
  await expectRejects(
    () => base.getStatus(),
    501,
    'SMS_PROVIDER_UNSUPPORTED'
  );
});

// ---------------------------------------------------------------------------
// Disabled provider (default) — honest failure, nothing sent, nothing faked
// ---------------------------------------------------------------------------

test('disabled provider refuses sends with 503 SMS_PROVIDER_NOT_CONFIGURED and makes no HTTP call', async () => {
  configureSms({ provider: 'disabled' });
  const beforeRequests = mock.requests.length;
  const recipient = uniqueRecipient();
  const rowsBefore = await countSmsRows();

  const err = await expectRejects(
    () =>
      sendSms({
        recipients: [recipient],
        message: 'Should never leave the building.',
      }),
    503,
    'SMS_PROVIDER_NOT_CONFIGURED',
    SAFE_NOT_CONFIGURED_MESSAGE
  );
  assert.ok(!JSON.stringify({ ...err }).includes('sent'));

  assert.equal(mock.requests.length, beforeRequests, 'no provider HTTP call');

  // The attempt is still audited honestly as failed — never as sent.
  const rows = await rowsForRecipient(recipient);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].provider, 'disabled');
  assert.ok(rows[0].failed_at);
  assert.equal(rows[0].sent_at, null);
  assert.equal(rows[0].metadata.errorCode, 'SMS_PROVIDER_NOT_CONFIGURED');
  assert.ok((await countSmsRows()) === rowsBefore + 1);
});

test('disabled provider getStatus also refuses with SMS_PROVIDER_NOT_CONFIGURED', async () => {
  configureSms({ provider: 'disabled' });
  await expectRejects(
    () => getStatus(),
    503,
    'SMS_PROVIDER_NOT_CONFIGURED',
    SAFE_NOT_CONFIGURED_MESSAGE
  );
});

test('unknown SMS_PROVIDER id behaves like not-configured and records nothing', async () => {
  configureSms({ provider: 'carrier-pigeon' });
  const rowsBefore = await countSmsRows();
  await expectRejects(
    () =>
      sendSms({ recipients: [uniqueRecipient()], message: 'hello' }),
    503,
    'SMS_PROVIDER_NOT_CONFIGURED',
    SAFE_NOT_CONFIGURED_MESSAGE
  );
  assert.equal(await countSmsRows(), rowsBefore, 'no rows for unknown provider');
});

// ---------------------------------------------------------------------------
// Phone number validation (strict E.164, no guessing)
// ---------------------------------------------------------------------------

test('valid E.164 recipients are accepted', async () => {
  configureSms();
  const valid = ['+8801712345678', '+12025550123', '+447911123456'];
  for (const recipient of valid) {
    const result = await sendSms({ recipients: [recipient], message: 'ok' });
    assert.equal(result.status, 'accepted');
    assert.equal(result.recipientCount, 1);
  }
});

test('invalid phone numbers are rejected with 400 and never hit the provider or the database', async () => {
  configureSms();
  const invalid = [
    '01712345678',
    '8801712345678',
    '+880 1712345678',
    '01712-345678',
    '+0123456789',
    '+88017123456789012345',
    '+',
    '++8801712345678',
    'tel:+8801712345678',
    '+8801712345678 ',
    ' +8801712345678',
    '+8801712345678\n',
  ];
  const beforeRequests = mock.requests.length;
  const rowsBefore = await countSmsRows();

  for (const recipient of invalid) {
    await expectRejects(
      () => sendSms({ recipients: [recipient], message: 'hello' }),
      400,
      'VALIDATION_ERROR'
    );
  }

  // Non-string / malformed recipients structures.
  for (const recipients of [
    'not-an-array',
    12345,
    null,
    undefined,
    {},
    [],
    [123],
    [null],
    ['+8801712345678', 'nope'],
  ]) {
    await expectRejects(
      () => sendSms({ recipients, message: 'hello' }),
      400,
      'VALIDATION_ERROR'
    );
  }

  assert.equal(mock.requests.length, beforeRequests, 'no provider HTTP call');
  assert.equal(await countSmsRows(), rowsBefore, 'no rows for invalid input');
});

test('recipients above the per-call maximum are rejected', async () => {
  configureSms();
  const recipients = Array.from({ length: MAX_RECIPIENTS + 1 }, () =>
    uniqueRecipient()
  );
  await expectRejects(
    () => sendSms({ recipients, message: 'hello' }),
    400,
    'VALIDATION_ERROR'
  );
});

// ---------------------------------------------------------------------------
// Message validation
// ---------------------------------------------------------------------------

test('message validation rejects empty, non-string, oversized, malformed, and credential-bearing input', async () => {
  configureSms();
  const rowsBefore = await countSmsRows();
  const recipient = '+8801712345678';
  const badMessages = [
    '',
    '    ',
    '\n\t',
    42,
    {},
    [],
    null,
    undefined,
    true,
    'a'.repeat(MESSAGE_MAX_LENGTH + 1),
    'hi\u0000there',
    `code is ${TEST_KEY}`, // API key must never travel inside a message
  ];
  for (const message of badMessages) {
    await expectRejects(
      () => sendSms({ recipients: [recipient], message }),
      400,
      'VALIDATION_ERROR'
    );
  }
  assert.equal(await countSmsRows(), rowsBefore, 'no rows for invalid messages');
});

test('message exactly at the maximum length is accepted', async () => {
  configureSms();
  const result = await sendSms({
    recipients: [uniqueRecipient()],
    message: 'a'.repeat(MESSAGE_MAX_LENGTH),
  });
  assert.equal(result.status, 'accepted');
});

test('optional deviceId, simSubscriptionId, userId, messageType are strictly validated', async () => {
  configureSms();
  const recipient = uniqueRecipient();
  for (const deviceId of [123, {}, [], true]) {
    await expectRejects(
      () => sendSms({ recipients: [recipient], message: 'hi', deviceId }),
      400,
      'VALIDATION_ERROR'
    );
  }
  for (const simSubscriptionId of [0, -1, 1.5, 'two', {}]) {
    await expectRejects(
      () =>
        sendSms({ recipients: [recipient], message: 'hi', simSubscriptionId }),
      400,
      'VALIDATION_ERROR'
    );
  }
  await expectRejects(
    () =>
      sendSms({ recipients: [recipient], message: 'hi', userId: 'not-a-uuid' }),
    400,
    'VALIDATION_ERROR'
  );
  for (const messageType of ['OTP', '1abc', 'x'.repeat(51), "a'); DROP TABLE sms_messages;--"]) {
    await expectRejects(
      () => sendSms({ recipients: [recipient], message: 'hi', messageType }),
      400,
      'VALIDATION_ERROR'
    );
  }
  assert.ok(await tableExists('sms_messages'), 'table survives hostile input');
});

// ---------------------------------------------------------------------------
// TextBee request shape (endpoint, auth, payload, optionals)
// ---------------------------------------------------------------------------

test('successful send hits POST /api/v1/gateway/send-sms with x-api-key, message, and recipients', async () => {
  configureSms();
  mock.requests.length = 0;
  const recipient = uniqueRecipient();
  const message = `Hello ${unique()}`;

  const result = await sendSms({ recipients: [recipient], message });

  assert.equal(result.provider, 'textbee');
  assert.equal(result.status, 'accepted');
  assert.equal(result.recipientCount, 1);
  assert.match(result.providerBatchId, /^batch-\d+$/);
  assert.ok(result.sentAt);

  assert.equal(mock.requests.length, 1);
  const req = mock.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/api/v1/gateway/send-sms');
  assert.equal(req.headers['x-api-key'], TEST_KEY);
  assert.match(req.headers['content-type'], /application\/json/);
  assert.deepEqual(req.body.recipients, [recipient]);
  assert.equal(req.body.message, message);
  assert.ok(!('deviceId' in req.body), 'deviceId omitted when unconfigured');
  assert.ok(
    !('simSubscriptionId' in req.body),
    'simSubscriptionId omitted when unconfigured'
  );

  // Normalized result never leaks the key.
  const flat = JSON.stringify(result);
  assert.ok(!flat.includes(TEST_KEY));
});

test('configured and per-call deviceId / simSubscriptionId flow into the request body (call wins)', async () => {
  mock.requests.length = 0;
  configureSms({ deviceId: 'cfg-device', simSubscriptionId: 2 });

  await sendSms({ recipients: [uniqueRecipient()], message: 'cfg only' });
  assert.equal(mock.requests[mock.requests.length - 1].body.deviceId, 'cfg-device');
  assert.equal(
    mock.requests[mock.requests.length - 1].body.simSubscriptionId,
    2
  );

  await sendSms({
    recipients: [uniqueRecipient()],
    message: 'call wins',
    deviceId: 'call-device',
    simSubscriptionId: 5,
  });
  const last = mock.requests[mock.requests.length - 1];
  assert.equal(last.body.deviceId, 'call-device');
  assert.equal(last.body.simSubscriptionId, 5);

  configureSms({ deviceId: '', simSubscriptionId: null });
  await sendSms({ recipients: [uniqueRecipient()], message: 'none' });
  const bare = mock.requests[mock.requests.length - 1];
  assert.ok(!('deviceId' in bare.body));
  assert.ok(!('simSubscriptionId' in bare.body));
});

test('missing API key initializes nothing — send fails with 503 and no HTTP call', async () => {
  configureSms({ apiKey: '' });
  const beforeRequests = mock.requests.length;
  await expectRejects(
    () =>
      sendSms({ recipients: [uniqueRecipient()], message: 'hello' }),
    503,
    'SMS_PROVIDER_NOT_CONFIGURED',
    SAFE_NOT_CONFIGURED_MESSAGE
  );
  assert.equal(mock.requests.length, beforeRequests);
});

test('plain-http base URL to a non-local host is refused (API key never sent in cleartext)', async () => {
  configureSms({ baseUrl: 'http://sms.example.com/api/v1' });
  const beforeRequests = mock.requests.length;
  await expectRejects(
    () =>
      sendSms({ recipients: [uniqueRecipient()], message: 'hello' }),
    503,
    'SMS_PROVIDER_NOT_CONFIGURED',
    SAFE_NOT_CONFIGURED_MESSAGE
  );
  assert.equal(mock.requests.length, beforeRequests);
});

// ---------------------------------------------------------------------------
// Provider response handling: 400/401/404/429/5xx, malformed, redirect,
// timeout, network failure — all normalized to one safe 502
// ---------------------------------------------------------------------------

test('HTTP error statuses from TextBee (400/401/404/429/500) map to safe SMS_PROVIDER_ERROR', async () => {
  for (const mode of ['status400', 'status401', 'status404', 'status429', 'status500']) {
    configureSms();
    mock.mode = mode;
    const recipient = uniqueRecipient();
    try {
      const err = await expectRejects(
        () => sendSms({ recipients: [recipient], message: 'hello' }),
        502,
        'SMS_PROVIDER_ERROR',
        SAFE_PROVIDER_MESSAGE
      );
      const flat = JSON.stringify({
        status: err.status,
        code: err.code,
        message: err.message,
        details: err.details,
      });
      assert.ok(!flat.includes(UPSTREAM_MARKER), 'upstream body never echoed');
      assert.ok(!flat.includes(TEST_KEY), 'API key never echoed');

      const rows = await rowsForRecipient(recipient);
      assert.equal(rows[0].status, 'failed');
      assert.equal(rows[0].metadata.errorCode, 'SMS_PROVIDER_ERROR');
      assert.ok(rows[0].failed_at);
    } finally {
      mock.mode = 'ok';
    }
  }
});

test('malformed provider responses (bad JSON, non-object, success:false) map to safe SMS_PROVIDER_ERROR', async () => {
  for (const mode of ['bad-json', 'not-object', 'success-false']) {
    configureSms();
    mock.mode = mode;
    try {
      await expectRejects(
        () => sendSms({ recipients: [uniqueRecipient()], message: 'hello' }),
        502,
        'SMS_PROVIDER_ERROR',
        SAFE_PROVIDER_MESSAGE
      );
    } finally {
      mock.mode = 'ok';
    }
  }
});

test('a redirect response is not followed — the API key is never re-sent elsewhere', async () => {
  configureSms();
  mock.mode = 'redirect';
  try {
    await expectRejects(
      () => sendSms({ recipients: [uniqueRecipient()], message: 'hello' }),
      502,
      'SMS_PROVIDER_ERROR',
      SAFE_PROVIDER_MESSAGE
    );
  } finally {
    mock.mode = 'ok';
  }
});

test('the provider request times out within SMS_REQUEST_TIMEOUT_MS and fails safely', async () => {
  configureSms({ timeoutMs: 300 });
  mock.mode = 'delay';
  try {
    const started = Date.now();
    await expectRejects(
      () => sendSms({ recipients: [uniqueRecipient()], message: 'slow' }),
      502,
      'SMS_PROVIDER_ERROR',
      SAFE_PROVIDER_MESSAGE
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `timed out promptly (took ${elapsed}ms)`);
  } finally {
    mock.mode = 'ok';
  }
});

test('network failure (connection refused) maps to safe SMS_PROVIDER_ERROR', async () => {
  configureSms({ baseUrl: `http://127.0.0.1:${unusedPort}/api/v1` });
  await expectRejects(
    () => sendSms({ recipients: [uniqueRecipient()], message: 'hello' }),
    502,
    'SMS_PROVIDER_ERROR',
    SAFE_PROVIDER_MESSAGE
  );
});

// ---------------------------------------------------------------------------
// Sending: multi-recipient rows, user linkage, honest result shape
// ---------------------------------------------------------------------------

test('two recipients produce two accepted audit rows sharing one provider batch id', async () => {
  configureSms();
  const a = uniqueRecipient();
  const b = uniqueRecipient();
  const secretBody = `private-message-${unique()}`;
  const result = await sendSms({
    recipients: [a, b],
    message: secretBody,
    messageType: 'order_confirmation',
  });
  assert.equal(result.recipientCount, 2);
  assert.equal(result.status, 'accepted');

  const rowsA = await rowsForRecipient(a);
  const rowsB = await rowsForRecipient(b);
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  for (const row of [rowsA[0], rowsB[0]]) {
    assert.equal(row.status, 'accepted');
    assert.equal(row.provider, 'textbee');
    assert.equal(row.message_type, 'order_confirmation');
    assert.ok(row.sent_at);
    assert.equal(row.failed_at, null);
    assert.equal(row.provider_batch_id, result.providerBatchId);
    assert.equal(row.metadata.recipientCount, 2);
    // No phone number, message text, or credentials in the row.
    const flat = JSON.stringify(row);
    assert.ok(!flat.includes(a) && !flat.includes(b), 'no raw phone stored');
    assert.ok(!flat.includes(secretBody), 'no message body stored');
    assert.ok(!flat.includes(TEST_KEY), 'no API key stored');
  }
});

test('sms_messages schema stores hashes only — no message body, recipient, or phone columns', async () => {
  const { rows } = await database.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'sms_messages'`
  );
  const columns = rows.map((r) => r.column_name);
  for (const forbidden of ['message', 'body', 'recipient', 'phone', 'phone_number', 'api_key']) {
    assert.ok(
      !columns.includes(forbidden),
      `column ${forbidden} must not exist (got: ${columns.join(', ')})`
    );
  }
  assert.ok(columns.includes('recipient_hash'));
  assert.ok(columns.includes('metadata'));
  assert.ok(columns.includes('user_id'));
});

test('valid userId links audit rows to the owning account (FK honored)', async () => {
  configureSms();
  const email = `sms-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Sms',
    lastName: 'Tester',
    email,
    password,
  });
  assert.equal(reg.response.status, 201);
  const login = await postJson('/auth/login', { email, password });
  assert.equal(login.response.status, 200);
  const cookie = extractSessionCookie(login.response.headers.getSetCookie());
  assert.ok(cookie, 'expected session cookie for FK test');
  const me = await api('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
  assert.ok(me.body.data && me.body.data.user, 'me returns { user }');
  const userId = me.body.data.user.id;
  assert.ok(userId, 'user id present');

  const recipient = uniqueRecipient();
  await sendSms({
    recipients: [recipient],
    message: 'linked',
    userId,
    messageType: 'service_notification',
  });
  const rows = await rowsForRecipient(recipient);
  assert.equal(rows[0].user_id, userId);
});

test('sendSms returns a consistent normalized result shape', async () => {
  configureSms();
  const result = await sendSms({
    recipients: [uniqueRecipient()],
    message: 'shape check',
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'provider',
    'providerBatchId',
    'providerMessageId',
    'recipientCount',
    'sentAt',
    'status',
  ]);
  assert.equal(result.provider, 'textbee');
  assert.equal(result.status, 'accepted');
  assert.equal(result.providerMessageId, null);
});

test('getStatus is honest — accepted is not claimed as delivered', async () => {
  configureSms();
  const status = await getStatus();
  assert.deepEqual(status, { supported: false, status: 'unknown' });
});

// ---------------------------------------------------------------------------
// Security: no public endpoint, no leaks to logs/frontend, templates hygiene
// ---------------------------------------------------------------------------

test('no public SMS endpoint exists — /api/sms/* answers 404 for all common shapes', async () => {
  const paths = [
    '/sms',
    '/sms/send',
    '/sms/test',
    '/sms/send-sms',
    '/sms/otp',
    '/messages/send',
  ];
  for (const p of paths) {
    for (const method of ['GET', 'POST']) {
      const { response, body } = await api(p, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ phone: '+8801712345678', message: 'spam' }) : undefined,
      });
      assert.equal(response.status, 404, `${method} ${p} must be 404`);
      assert.equal(body.error.code, 'NOT_FOUND');
    }
  }
});

test('API key and message content never appear in console output during sends', async () => {
  configureSms();
  const recipient = uniqueRecipient();
  const message = `secret body ${unique()}`;

  const success = await captureConsole(() =>
    sendSms({ recipients: [recipient], message })
  );
  mock.mode = 'status501';
  let failure;
  try {
    failure = await captureConsole(() =>
      sendSms({ recipients: [recipient], message }).then(
        () => ({ value: null, calls: [] }),
        (err) => ({ value: err, calls: [] })
      )
    );
  } finally {
    mock.mode = 'ok';
  }

  const allText = [...success.calls, ...failure.calls].join('\n');
  assert.ok(!allText.includes(TEST_KEY), 'API key never logged');
  assert.ok(!allText.includes(message), 'message body never logged');
  assert.ok(!allText.includes(recipient), 'phone number never logged');
});

test('frontend contains no TextBee config, API key references, or SMS secrets', () => {
  const frontendDir = path.join(__dirname, '../../frontend');
  const entries = fs.readdirSync(frontendDir, { recursive: true });
  for (const entry of entries) {
    const file = path.join(frontendDir, String(entry));
    if (!fs.statSync(file).isFile()) continue;
    if (!/\.(html|js|css)$/i.test(String(entry))) continue;
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!/textbee/i.test(content), `${entry} must not mention textbee`);
    assert.ok(!/x-api-key/i.test(content), `${entry} must not mention x-api-key`);
    assert.ok(!/TEXTBEE_API_KEY/i.test(content), `${entry} must not mention TEXTBEE_API_KEY`);
    assert.ok(!content.includes(TEST_KEY), `${entry} must not contain the key`);
  }
});

test('backend source keeps x-api-key handling confined to the TextBee provider and hardcodes no keys', () => {
  const srcDir = path.join(__dirname, '../src');
  const entries = fs.readdirSync(srcDir, { recursive: true });
  const keyHeaderFiles = [];
  for (const entry of entries) {
    const file = path.join(srcDir, String(entry));
    if (!fs.statSync(file).isFile() || !/\.js$/i.test(String(entry))) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (/x-api-key/i.test(content)) keyHeaderFiles.push(String(entry));
    assert.ok(
      !/apiKey:\s*['"][^'"]+['"]/.test(content),
      `${entry} must not hardcode an api key literal`
    );
    assert.ok(!content.includes(TEST_KEY), `${entry} must not contain the test key`);
  }
  assert.deepEqual(keyHeaderFiles, [
    path.join('services', 'sms', 'providers', 'textbeeProvider.js'),
  ]);
});

test('templates are plain transactional strings with no credentials and no send logic', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/services/sms/smsTemplates.js'),
    'utf8'
  );
  assert.ok(!src.includes('require('), 'templates must not import anything');
  assert.ok(
    !/apiKey|x-api-key|TEXTBEE_API_KEY/i.test(src),
    'templates must not reference credentials'
  );
  assert.ok(
    !/smsService|provider\.send|fetch\(/i.test(src),
    'templates must not send anything'
  );

  const v = smsTemplates.verificationCode({ code: '123456', expiresInMinutes: 5 });
  assert.match(v, /123456/);
  assert.match(v, /5 minutes/);
  const p = smsTemplates.passwordReset({ code: '654321' });
  assert.match(p, /654321/);
  const o = smsTemplates.orderConfirmation({ orderNumber: 'FLR-20260923-ABC123' });
  assert.match(o, /FLR-20260923-ABC123/);
  const pay = smsTemplates.paymentNotification({
    orderNumber: 'FLR-20260923-ABC123',
    outcome: 'received',
  });
  assert.match(pay, /received/);
  const s = smsTemplates.serviceNotification({ summary: 'Scheduled maintenance.' });
  assert.match(s, /Scheduled maintenance\./);
  for (const text of [v, p, o, pay, s]) {
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0 && text.length <= MESSAGE_MAX_LENGTH);
    assert.ok(!text.includes(TEST_KEY));
  }
});

// ---------------------------------------------------------------------------
// Rate limiting (for future internal transactional endpoints)
// ---------------------------------------------------------------------------

test('smsSendLimiter rate limits by IP with 429 RATE_LIMITED and Retry-After', async () => {
  const express = require('express');
  const app = express();
  app.post('/internal/sms-hypothetical', smsSendLimiter, (req, res) => {
    res.status(200).json({ success: true, data: { ok: true } });
  });
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/internal/sms-hypothetical`, {
        method: 'POST',
      });
      assert.equal(res.status, 200, `request ${i + 1} allowed`);
    }
    const res = await fetch(
      `http://127.0.0.1:${port}/internal/sms-hypothetical`,
      { method: 'POST' }
    );
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('Retry-After'));
    const body = await res.json();
    assert.equal(body.error.code, 'RATE_LIMITED');
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// SQL injection resistance
// ---------------------------------------------------------------------------

test('hostile input can never reach SQL — invalid E.164/message_type rejected before any query', async () => {
  configureSms();
  const rowsBefore = await countSmsRows();
  const attacks = [
    { recipients: ["'+8801712345678'; DROP TABLE sms_messages;--"], message: 'x' },
    { recipients: ['+8801712345678 OR 1=1--'], message: 'x' },
    { recipients: ['+8801712345678'], message: 'x', messageType: "a'); DROP TABLE sms_messages;--" },
    { recipients: ['+8801712345678'], message: 'x', userId: "1'; DROP TABLE sms_messages;--" },
  ];
  for (const args of attacks) {
    await expectRejects(() => sendSms(args), 400, 'VALIDATION_ERROR');
  }
  assert.equal(await countSmsRows(), rowsBefore, 'no rows written for attacks');
  assert.ok(await tableExists('sms_messages'), 'table still present');
});

// ---------------------------------------------------------------------------
// Regressions: auth flow unchanged, health/pages still fine
// ---------------------------------------------------------------------------

test('registration and login still work unchanged (auth regression in this suite)', async () => {
  const email = `smsreg-${unique()}@example.com`;
  const password = validPassword();
  const reg = await postJson('/auth/register', {
    firstName: 'Reg',
    lastName: 'Check',
    email,
    password,
  });
  assert.equal(reg.response.status, 201);
  assert.ok(reg.body.success);
  const login = await postJson('/auth/login', { email, password });
  assert.equal(login.response.status, 200);
  assert.ok(extractSessionCookie(login.response.headers.getSetCookie()));
});

test('regression: external test server health is OK and pages still load', async () => {
  const health = await api('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok');
  for (const page of ['/', '/checkout', '/payment-success']) {
    const res = await fetch(`${BASE_URL}${page}`);
    assert.equal(res.status, 200, `${page} loads`);
  }
});
