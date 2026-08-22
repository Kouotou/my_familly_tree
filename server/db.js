const Database = require('better-sqlite3');
const path = require('path');
const dbfile = process.env.DB_FILE || path.join(__dirname, 'data.sqlite');
const db = new Database(dbfile);

function init() {
  // people
  db.exec(`
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    full_name TEXT NOT NULL,
    gender TEXT,
    birth_year INTEGER,
    birth_date TEXT,
    death_date TEXT,
    occupation TEXT,
    residence TEXT,
    phone TEXT,
    photo_path TEXT,
    family_head TEXT,
    created_by TEXT,
    created_at TEXT,
    last_edited_by TEXT,
    last_edited_at TEXT,
    approval_status TEXT DEFAULT 'approved',
    reviewed_by TEXT
  );

  CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    relative_id TEXT NOT NULL,
    type TEXT NOT NULL,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    password_hash TEXT,
    role TEXT DEFAULT 'member',
    person_id TEXT
  );

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    type TEXT,
    payload TEXT,
    status TEXT DEFAULT 'pending',
    created_by TEXT,
    created_at TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_note TEXT
  );

  CREATE TABLE IF NOT EXISTS archive (
    id TEXT PRIMARY KEY,
    title TEXT,
    url TEXT,
    description TEXT,
    created_by TEXT,
    created_at TEXT,
    approval_status TEXT DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  `);
}

init();
// attach the resolved DB file path for runtime inspection
db.__dbfile = dbfile;
console.log('[db] using sqlite file:', dbfile);

module.exports = db;
