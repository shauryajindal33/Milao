'use strict';
/**
 * store.js — persistence.
 *
 * Two drivers behind one interface:
 *   json      writes data/db.json (dev, and the fallback when no DATABASE_URL)
 *   postgres  keeps the whole state in one jsonb row (durable, survives restarts)
 *
 * The in-memory object stays the source of truth while the process runs; this
 * only decides where it survives. Swapping to proper per-entity tables is the
 * next step once concurrency needs it — the interface will not change.
 */

const fs = require('node:fs');
const path = require('node:path');

function jsonStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  return {
    kind: 'json',
    async init() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    },
    async save(state) {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    },
    async close() {}
  };
}

function pgStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    max: 3,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    idleTimeoutMillis: 10_000
  });
  return {
    kind: 'postgres',
    async init() {
      await pool.query('CREATE TABLE IF NOT EXISTS app_state (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL)');
      const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
      return r.rows.length ? r.rows[0].data : null;
    },
    async save(state) {
      await pool.query(
        `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, $2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(state), new Date()]
      );
    },
    async close() { await pool.end(); }
  };
}

function makeStore({ dataDir, connectionString }) {
  if (connectionString) return pgStore(connectionString);
  return jsonStore(dataDir);
}

module.exports = { makeStore };
