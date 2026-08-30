// Minimal JSON-file datastore. Small club site, low write volume — a real
// database (Postgres/SQLite) is a straightforward future upgrade, but this
// keeps the project dependency-free and easy to inspect/back up.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function defaultDb() {
  return {
    admin: {
      username: process.env.ADMIN_USERNAME || 'admin',
      // default password "changeme123" — MUST be changed via env var / admin UI before going live
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
    // Predictor league. Predictions are append-only: once a row lands here it
    // is never updated or removed by any code path (not even admin), which is
    // what makes the league trustworthy.
    predictions: [],
    // Short-lived 6-digit codes emailed to members setting/resetting a password.
    memberAuthCodes: [],
  };
}

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb(), null, 2));
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  let db;
  try {
    db = JSON.parse(raw);
  } catch (err) {
    throw new Error('db.json is corrupted: ' + err.message);
  }
  // Backfill fields added in later versions so old db.json files don't break.
  if (db.instagramEmbedCode === undefined) db.instagramEmbedCode = '';
  if (db.mediaPosts === undefined) db.mediaPosts = [];
  if (db.predictions === undefined) db.predictions = [];
  if (db.memberAuthCodes === undefined) db.memberAuthCodes = [];
  return db;
}

// Very small write lock so two concurrent requests can't interleave writes
// and corrupt the file (real DB would handle this natively).
let writeQueue = Promise.resolve();
function writeDb(mutatorFn) {
  writeQueue = writeQueue.then(() => {
    const current = readDb();
    const next = mutatorFn(current) || current;
    fs.writeFileSync(DB_PATH, JSON.stringify(next, null, 2));
    return next;
  });
  return writeQueue;
}

module.exports = { readDb, writeDb, ensureDb, DB_PATH };
