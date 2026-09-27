const { query } = require('../config/database');

const ALL_COLUMNS = `
  id, user_id, provider, provider_message_id, provider_batch_id,
  recipient_hash, message_type, status, created_at, sent_at, delivered_at,
  failed_at, metadata, updated_at
`;

// One "sending" row per recipient, written BEFORE the provider call so every
// attempt leaves an audit trail (mirrors how payment attempts are recorded
// first). recipient_hash is sha256(E.164 number) — never store raw numbers.
async function createAttempts({
  provider,
  userId = null,
  recipientHashes,
  messageType = null,
  recipientCount,
}) {
  const { rows } = await query(
    `INSERT INTO sms_messages (
       provider, user_id, recipient_hash, message_type, status, metadata
     )
     SELECT $1, $2, h, $4, 'sending',
            jsonb_build_object('recipientCount', $5::int)
     FROM unnest($3::text[]) AS h
     RETURNING id`,
    [provider, userId, recipientHashes, messageType, recipientCount]
  );
  return rows.map((row) => row.id);
}

// sending → accepted (provider accepted the batch; not delivery-confirmed).
async function markAccepted(ids, { providerBatchId = null, providerMessageId = null } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const { rowCount } = await query(
    `UPDATE sms_messages
     SET status = 'accepted',
         sent_at = now(),
         provider_batch_id = COALESCE($2, provider_batch_id),
         provider_message_id = COALESCE($3, provider_message_id)
     WHERE id = ANY($1::uuid[]) AND status = 'sending'`,
    [ids, providerBatchId, providerMessageId]
  );
  return rowCount;
}

// sending → failed (failure direction only; accepted rows are never downgraded).
async function markFailed(ids, errorCode = null) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const { rowCount } = await query(
    `UPDATE sms_messages
     SET status = 'failed',
         failed_at = now(),
         metadata = metadata || jsonb_build_object('errorCode', $2::text)
     WHERE id = ANY($1::uuid[]) AND status = 'sending'`,
    [ids, errorCode]
  );
  return rowCount;
}

async function findById(id) {
  const { rows } = await query(
    `SELECT ${ALL_COLUMNS} FROM sms_messages WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  ALL_COLUMNS,
  createAttempts,
  markAccepted,
  markFailed,
  findById,
};
