const { query } = require('../config/database');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const PREVIEW_LENGTH = 80;

// Insert one received SMS event. Unique (provider, idempotency_key) and
// (provider, provider_message_id) make TextBee retries no-ops: returns
// { stored: false } when the event already exists.
async function insertIncoming({
  provider,
  providerMessageId,
  idempotencyKey,
  webhookEvent,
  direction,
  sender,
  messageBody,
  receivedAt,
  deviceId,
  webhookSubscriptionId,
  metadata = {},
}) {
  const { rows } = await query(
    `INSERT INTO sms_incoming_events (
       provider, provider_message_id, idempotency_key, webhook_event,
       direction, sender, message_body, received_at, device_id,
       webhook_subscription_id, status, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'received', $11::jsonb)
     ON CONFLICT (provider, idempotency_key) DO NOTHING
     RETURNING id, status, created_at`,
    [
      provider,
      providerMessageId,
      idempotencyKey,
      webhookEvent,
      direction,
      sender,
      messageBody,
      receivedAt,
      deviceId,
      webhookSubscriptionId,
      JSON.stringify(metadata),
    ]
  );
  if (rows.length === 0) {
    return { stored: false, row: null };
  }
  return { stored: true, row: rows[0] };
}

function maskSender(sender) {
  if (!sender || typeof sender !== 'string') return null;
  const digits = sender.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}

function maskPreview(body) {
  if (typeof body !== 'string' || body.length === 0) return '';
  if (body.length <= PREVIEW_LENGTH) return body;
  return `${body.slice(0, PREVIEW_LENGTH)}…`;
}

// Update processing status + merge metadata after parse/verify.
// status must satisfy migration 016 CHECK; metadata is shallow-merged.
async function updateProcessing(id, { status, metadata = {} } = {}) {
  if (!id) return null;
  const { rows } = await query(
    `UPDATE sms_incoming_events
     SET status = COALESCE($2, status),
         metadata = metadata || $3::jsonb
     WHERE id = $1
     RETURNING id, status, metadata`,
    [id, status || null, JSON.stringify(metadata || {})]
  );
  return rows[0] || null;
}

// Admin-safe projection: never returns full body or secrets.
async function listIncoming({ page = 1, limit = DEFAULT_LIMIT } = {}) {
  const offset = (page - 1) * limit;
  const { rows: countRows } = await query(
    'SELECT count(*)::int AS total FROM sms_incoming_events'
  );
  const total = countRows[0] ? countRows[0].total : 0;
  const { rows } = await query(
    `SELECT id, provider, provider_message_id, direction, sender,
            status, received_at, created_at, message_body, metadata
     FROM sms_incoming_events
     ORDER BY created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return {
    items: rows.map((row) => {
      const meta =
        row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      return {
        id: row.id,
        provider: row.provider,
        providerMessageId: row.provider_message_id,
        direction: row.direction,
        sender: maskSender(row.sender),
        status: row.status,
        receivedAt: row.received_at,
        createdAt: row.created_at,
        messagePreview: maskPreview(row.message_body),
        amount: meta.amount || null,
        transactionId: meta.transactionId || null,
        parseReason: meta.parseReason || null,
        verifyReason: meta.reason || null,
        orderNumber: meta.orderNumber || null,
        orderId: meta.orderId || null,
        candidateCount:
          typeof meta.candidateCount === 'number' ? meta.candidateCount : null,
      };
    }),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PREVIEW_LENGTH,
  insertIncoming,
  updateProcessing,
  listIncoming,
  maskSender,
  maskPreview,
};
