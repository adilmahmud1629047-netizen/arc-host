const { query } = require('../config/database');

const PUBLIC_COLUMNS =
  'id, email, first_name, last_name, role, status, email_verified_at, created_at, updated_at';

async function findById(id) {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findByEmail(email) {
  const normalized = String(email).toLowerCase();
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE email = $1`,
    [normalized]
  );
  return rows[0] || null;
}

async function findAll({ limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

module.exports = { findById, findByEmail, findAll };
