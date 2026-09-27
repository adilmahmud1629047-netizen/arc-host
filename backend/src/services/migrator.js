const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const config = require('../config');
const { pool, closePool } = require('../config/database');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../database/migrations');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function loadMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      return {
        version: file,
        name: file.replace(/\.sql$/, ''),
        sql,
        checksum: sha256(sql),
      };
    });
}

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(100) PRIMARY KEY,
      name TEXT NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations() {
  const { rows } = await pool.query(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version'
  );
  return rows;
}

async function runUp() {
  const files = loadMigrationFiles();
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));

  const pending = files.filter((file) => !appliedByVersion.has(file.version));

  if (pending.length === 0) {
    console.log(`No pending migrations. ${applied.length} migration(s) already applied.`);
    return { applied: 0, total: files.length };
  }

  let appliedCount = 0;

  for (const file of files) {
    const existing = appliedByVersion.get(file.version);

    if (existing) {
      if (existing.checksum !== file.checksum) {
        throw new Error(
          `Checksum mismatch for ${file.version}: the file changed after it was applied. ` +
            'Restore the original file or add a new migration instead of editing applied ones.'
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(file.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [file.version, file.name, file.checksum]
      );
      await client.query('COMMIT');
      appliedCount += 1;
      console.log(`Applied: ${file.version}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`Failed and rolled back: ${file.version}`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`Done. Applied ${appliedCount} migration(s). Total on file: ${files.length}.`);
  return { applied: appliedCount, total: files.length };
}

async function runStatus() {
  const files = loadMigrationFiles();
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));

  console.log('Migration status');
  console.log('----------------');
  console.log(`Migrations directory: ${MIGRATIONS_DIR}`);

  for (const file of files) {
    const row = appliedByVersion.get(file.version);
    if (row) {
      console.log(`  [applied ] ${file.version} (at ${row.applied_at.toISOString()})`);
    } else {
      console.log(`  [pending ] ${file.version}`);
    }
  }

  const pendingCount = files.filter((file) => !appliedByVersion.has(file.version)).length;
  console.log(`Summary: ${applied.length} applied, ${pendingCount} pending, ${files.length} total.`);
}

async function runCheck() {
  const { rows } = await pool.query(
    'SELECT current_database() AS database, current_user AS user, version() AS version'
  );
  const row = rows[0];
  console.log('Database connection OK');
  console.log(`  database: ${row.database}`);
  console.log(`  user: ${row.user}`);
  console.log(`  server: ${row.version}`);
}

async function runCreate() {
  const dbName = config.db.database;

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
    throw new Error(`Invalid database name: ${dbName}`);
  }

  const client = new Client({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: 'postgres',
    connectionTimeoutMillis: config.db.connectionTimeoutMillis,
  });

  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);

    if (existing.rowCount > 0) {
      console.log(`Database already exists: ${dbName}`);
      return;
    }

    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Created database: ${dbName}`);
  } finally {
    await client.end();
  }
}

async function main() {
  const command = process.argv[2] || 'up';

  try {
    switch (command) {
      case 'up':
        await runUp();
        break;
      case 'status':
        await runStatus();
        break;
      case 'check':
        await runCheck();
        break;
      case 'create':
        await runCreate();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Usage: node src/services/migrator.js [up|status|check|create]');
        process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => {});
  }
}

module.exports = { runUp, runStatus, runCheck, runCreate, loadMigrationFiles };

if (require.main === module) {
  main().catch((err) => {
    console.error(`Migration command failed: ${err.message}`);
    process.exit(1);
  });
}
