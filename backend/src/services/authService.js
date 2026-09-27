const argon2 = require('argon2');
const config = require('../config');
const { query } = require('../config/database');
const sessionService = require('./sessionService');

const USER_SELECT_COLUMNS = `
  id, email, first_name, last_name, role, status, email_verified_at, created_at
`;

let dummyHashPromise = null;

function getDummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash('timing-equalization-dummy-password', {
      type: argon2.argon2id,
      memoryCost: config.argon2.memoryCost,
      timeCost: config.argon2.timeCost,
      parallelism: config.argon2.parallelism,
    });
  }
  return dummyHashPromise;
}

function toSafeUser(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    status: row.status,
    emailVerified: Boolean(row.email_verified_at),
    createdAt: row.created_at,
  };
}

class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: config.argon2.memoryCost,
    timeCost: config.argon2.timeCost,
    parallelism: config.argon2.parallelism,
  });
}

async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

async function register({ firstName, lastName, email, password }) {
  const normalizedEmail = String(email).toLowerCase();
  const passwordHash = await hashPassword(password);

  const { rows } = await query(
    `INSERT INTO users (email, password_hash, first_name, last_name, role, status, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL)
     ON CONFLICT (email) DO NOTHING
     RETURNING ${USER_SELECT_COLUMNS}`,
    [normalizedEmail, passwordHash, firstName, lastName, 'customer', 'active']
  );

  if (rows.length === 0) {
    throw new AuthError(
      409,
      'EMAIL_EXISTS',
      'An account with this email already exists.'
    );
  }

  return toSafeUser(rows[0]);
}

async function login({ email, password }, { ipAddress, userAgent } = {}) {
  const normalizedEmail = String(email).toLowerCase();

  const { rows } = await query(
    `SELECT ${USER_SELECT_COLUMNS}, password_hash FROM users WHERE email = $1`,
    [normalizedEmail]
  );

  const user = rows[0];

  if (!user) {
    const dummyHash = await getDummyHash();
    await verifyPassword(dummyHash, password);
    throw new AuthError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  const passwordValid = await verifyPassword(user.password_hash, password);

  if (!passwordValid) {
    throw new AuthError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  if (user.status !== 'active') {
    throw new AuthError(403, 'ACCOUNT_DISABLED', 'This account is not active.');
  }

  await sessionService.purgeExpiredSessions();

  const { token, expiresAt } = await sessionService.createSession(user.id, {
    ipAddress,
    userAgent,
  });

  return { user: toSafeUser(user), token, expiresAt };
}

async function getUserById(userId) {
  const { rows } = await query(
    `SELECT ${USER_SELECT_COLUMNS} FROM users WHERE id = $1`,
    [userId]
  );
  return toSafeUser(rows[0]);
}

module.exports = {
  AuthError,
  register,
  login,
  getUserById,
  toSafeUser,
  hashPassword,
  verifyPassword,
};
