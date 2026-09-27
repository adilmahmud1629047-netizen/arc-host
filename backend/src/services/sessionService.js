const crypto = require('crypto');
const config = require('../config');
const { query } = require('../config/database');

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function createSession(userId, { ipAddress, userAgent } = {}) {
  const token = generateToken();
  const sessionHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.session.ttlSeconds * 1000);

  const safeAgent =
    typeof userAgent === 'string' && userAgent.length > 0
      ? userAgent.slice(0, 512)
      : null;
  const safeIp =
    typeof ipAddress === 'string' && ipAddress.length > 0
      ? ipAddress.slice(0, 45)
      : null;

  await query(
    `INSERT INTO sessions (user_id, session_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, sessionHash, expiresAt, safeIp, safeAgent]
  );

  return { token, expiresAt };
}

async function findSessionUser(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) {
    return null;
  }

  const sessionHash = hashToken(token);

  const { rows } = await query(
    `SELECT
       s.id AS session_id,
       s.expires_at,
       u.id,
       u.email,
       u.first_name,
       u.last_name,
       u.role,
       u.status,
       u.email_verified_at,
       u.created_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.session_hash = $1 AND s.expires_at > now()`,
    [sessionHash]
  );

  if (rows.length === 0) {
    return null;
  }

  await query('UPDATE sessions SET last_seen_at = now() WHERE session_hash = $1', [
    sessionHash,
  ]);

  return rows[0];
}

async function destroySession(token) {
  if (typeof token !== 'string' || token.length < 16) {
    return false;
  }
  const sessionHash = hashToken(token);
  const result = await query('DELETE FROM sessions WHERE session_hash = $1', [
    sessionHash,
  ]);
  return result.rowCount > 0;
}

async function expireSessionByHash(sessionHash) {
  const result = await query('DELETE FROM sessions WHERE session_hash = $1', [
    sessionHash,
  ]);
  return result.rowCount > 0;
}

async function purgeExpiredSessions() {
  const result = await query('DELETE FROM sessions WHERE expires_at <= now()');
  return result.rowCount;
}

// Admin account controls (STEP 48): revoke every live session of one user
// (suspend / password reset). Scoped to a single user_id — there is no
// "revoke all users" variant.
async function destroySessionsForUser(userId) {
  if (typeof userId !== 'string' || userId.length < 1) {
    return 0;
  }
  const result = await query('DELETE FROM sessions WHERE user_id = $1', [
    userId,
  ]);
  return result.rowCount;
}

async function touchSessionExpiry(token, expiresAt) {
  const sessionHash = hashToken(token);
  await query('UPDATE sessions SET expires_at = $1 WHERE session_hash = $2', [
    expiresAt,
    sessionHash,
  ]);
}

module.exports = {
  createSession,
  findSessionUser,
  destroySession,
  destroySessionsForUser,
  purgeExpiredSessions,
  hashToken,
  touchSessionExpiry,
};
