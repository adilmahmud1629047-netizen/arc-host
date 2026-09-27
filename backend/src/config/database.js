const { Pool } = require('pg');
const config = require('./index');

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: config.db.max,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
  ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function getClient() {
  return pool.connect();
}

async function healthCheck() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    console.error('PostgreSQL health check failed:', err.message);
    return false;
  }
}

async function closePool() {
  await pool.end();
}

module.exports = { pool, query, getClient, healthCheck, closePool };
