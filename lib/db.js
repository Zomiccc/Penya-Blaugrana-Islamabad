// Datastore: PostgreSQL (production) with JSON-file fallback (local dev).
//
// On Render, the DATABASE_URL env var is set and we store the entire app
// state as a JSONB document in a single row. This survives deploys (unlike
// the ephemeral filesystem) and keeps the same readDb()/writeDb() interface
// so the rest of the app doesn't need to change.
//
// Locally (no DATABASE_URL), we use data/db.json as before.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

let pgPool = null;

function defaultDb() {
  return {
    admin: {
      username: process.env.ADMIN_USERNAME || 'admin',
      passwordHash: bcrypt.hashSync(process.env.ADMIN_INITIAL_PASSWORD || 'changeme123', 10),
    },
    pricing: {
      adult: 3000,
      kids: 1000,
      currency: 'PKR',
    },
    instagramEmbedCode: '',
    mediaPosts: [],
    members: [],
    predictions: [],
    memberAuthCodes: [],
  };
}

/* ---------- JSON file backend (local dev) ---------- */
function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb(), null, 2));
  }
}

function readJsonDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  let db;
  try {
    db = JSON.parse(raw);
  } catch (err) {
    throw new Error('db.json is corrupted: ' + err.message);
  }
  if (db.instagramEmbedCode === undefined) db.instagramEmbedCode = '';
  if (db.mediaPosts === undefined) db.mediaPosts = [];
  if (db.predictions === undefined) db.predictions = [];
  if (db.memberAuthCodes === undefined) db.memberAuthCodes = [];
  return db;
}

let writeQueue = Promise.resolve();
function writeJsonDb(mutatorFn) {
  writeQueue = writeQueue.then(() => {
    const current = readJsonDb();
    const next = mutatorFn(current) || current;
    fs.writeFileSync(DB_PATH, JSON.stringify(next, null, 2));
    return next;
  });
  return writeQueue;
}

/* ---------- PostgreSQL backend (production) ---------- */
async function getPool() {
  if (pgPool) return pgPool;
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  // Create the table if it doesn't exist
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INT PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT single_row CHECK (id = 1)
    )
  `);
  return pgPool;
}

async function ensurePgSeed() {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if (rows.length === 0) {
    // Seed from local db.json if it exists, otherwise use defaults
    let seedData;
    try {
      seedData = readJsonDb();
    } catch {
      seedData = defaultDb();
    }
    await pool.query(
      'INSERT INTO app_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
      [JSON.stringify(seedData)]
    );
    console.log('[db] seeded PostgreSQL from local db.json');
  }
}

async function readPgDb() {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if (rows.length === 0) {
    await ensurePgSeed();
    const { rows: rows2 } = await pool.query('SELECT data FROM app_state WHERE id = 1');
    return rows2[0].data;
  }
  const db = rows[0].data;
  if (db.instagramEmbedCode === undefined) db.instagramEmbedCode = '';
  if (db.mediaPosts === undefined) db.mediaPosts = [];
  if (db.predictions === undefined) db.predictions = [];
  if (db.memberAuthCodes === undefined) db.memberAuthCodes = [];
  return db;
}

async function writePgDb(mutatorFn) {
  const pool = await getPool();
  const current = await readPgDb();
  const next = mutatorFn(current) || current;
  await pool.query(
    'UPDATE app_state SET data = $1, updated_at = NOW() WHERE id = 1',
    [JSON.stringify(next)]
  );
  return next;
}

/* ---------- Public API — same interface as before ---------- */
function isPgMode() {
  return Boolean(DATABASE_URL);
}

// readDb() is synchronous for the JSON backend.
// For PostgreSQL, it returns the cached in-memory copy that's kept in sync
// by writeDb(). On startup, we load from PG into memory.
let memCache = null;

async function initDb() {
  if (isPgMode()) {
    console.log('[db] using PostgreSQL (DATABASE_URL set)');
    await ensurePgSeed();
    memCache = await readPgDb();
    console.log('[db] loaded from PostgreSQL:', memCache.members?.length || 0, 'members,',
                memCache.predictions?.length || 0, 'predictions');
  } else {
    console.log('[db] using JSON file (no DATABASE_URL)');
    memCache = null; // use file directly
  }
}

function readDb() {
  if (isPgMode()) {
    if (!memCache) {
      // Fallback: try to read synchronously (shouldn't happen after initDb)
      return defaultDb();
    }
    return memCache;
  }
  return readJsonDb();
}

function writeDb(mutatorFn) {
  if (isPgMode()) {
    return writePgDb((current) => {
      const next = mutatorFn(current) || current;
      memCache = next; // keep in-memory copy in sync
      return next;
    });
  }
  return writeJsonDb(mutatorFn);
}

/**
 * Force reseed from local db.json (PostgreSQL only).
 * Deletes the app_state row and reloads from the JSON seed file.
 * Use this when the PG database is empty but db.json has data.
 */
async function reseedFromJson() {
  if (!isPgMode()) {
    throw new Error('Not in PostgreSQL mode');
  }
  const pool = await getPool();
  await pool.query('DELETE FROM app_state WHERE id = 1');
  memCache = null;
  await ensurePgSeed();
  memCache = await readPgDb();
  console.log('[db] reseeded from db.json:', memCache.members?.length || 0, 'members,',
              memCache.predictions?.length || 0, 'predictions');
  return memCache;
}

module.exports = { readDb, writeDb, ensureDb, initDb, isPgMode, reseedFromJson, DB_PATH };
