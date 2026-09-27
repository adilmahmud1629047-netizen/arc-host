const { query } = require('../config/database');

const COLUMNS =
  'id, name, hostname, provider, location, virtualization_type, api_endpoint, credentials_ref, status, created_at, updated_at';

async function findById(id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM servers WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findByStatus(status) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM servers WHERE status = $1 ORDER BY name ASC`,
    [status]
  );
  return rows;
}

async function findAll() {
  const { rows } = await query(`SELECT ${COLUMNS} FROM servers ORDER BY name ASC`);
  return rows;
}

module.exports = { findById, findByStatus, findAll };
