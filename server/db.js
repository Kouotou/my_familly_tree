const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL (or POSTGRES_URL) is not set — run `vercel env pull .env.local` or set it in .env');
}

// query_timeout is a hard safety net: no single query can hang a request (and, via the
// db.ready gate every request awaits, the whole site) forever — it gets cancelled and
// throws instead. This is deliberately here after a real incident where a stuck query took
// the entire site down for everyone until Vercel's unrelated 300s function timeout finally
// killed each hung invocation.
const pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 10000, query_timeout: 10000 });
// an idle client emitting an error (e.g. the remote end closing the connection) would
// otherwise be an unhandled 'error' event and crash the process
pool.on('error', (err) => { console.error('[db] idle client error', err); });

// --- ? -> $1,$2,... placeholder conversion -------------------------------------------
// Every query in this codebase uses SQLite-style `?` positional placeholders, and (checked
// against every query in routes.js as of this migration) none of them contain a literal `?`
// inside a string/JSON value or a Postgres `?` jsonb operator — so a straight sequential
// conversion is safe. If a future query needs a literal `?`, this assumption breaks and the
// placeholder-count assertion below will catch the mismatch loudly rather than silently
// binding the wrong parameter.
const placeholderCache = new Map();
function toPositional(sql) {
  let converted = placeholderCache.get(sql);
  if (converted === undefined) {
    let n = 0;
    converted = sql.replace(/\?/g, () => `$${++n}`);
    placeholderCache.set(sql, converted);
  }
  return converted;
}
function placeholderCount(sql) {
  const m = sql.match(/\?/g);
  return m ? m.length : 0;
}

// A cold-started function reconnecting to a suspended Neon compute occasionally hits a
// connection-establishment failure on the very first query (observed both locally and on
// Vercel) — every request after that succeeds. These are network/TLS-handshake failures,
// not query errors, so retrying once is safe (nothing partially executed yet).
function isRetryableConnectionError(err) {
  if (!err) return false;
  if (err.code && /^[0-9A-Z]{5}$/.test(err.code)) return false; // a real Postgres SQLSTATE error — don't retry
  const msg = String(err.message || '');
  return /socket disconnected|Connection terminated|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND/i.test(msg) || ['ECONNRESET','ETIMEDOUT','EPIPE','ENOTFOUND'].includes(err.code);
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- prepare().get/all/run() shim, bindable to either the pool or a transaction client ---
function bind(runner, allowRetry) {
  function prepare(sql) {
    const expected = placeholderCount(sql);
    const positional = toPositional(sql);
    async function exec(params) {
      if (params.length !== expected) {
        throw new Error(`placeholder count mismatch: query expects ${expected}, got ${params.length}\n${sql}`);
      }
      try {
        return await runner.query(positional, params);
      } catch (err) {
        if (allowRetry && isRetryableConnectionError(err)) {
          console.warn('[db] retrying after connection error:', err.message);
          await delay(300);
          return runner.query(positional, params);
        }
        throw err;
      }
    }
    return {
      async get(...params) { const r = await exec(params); return r.rows[0]; },
      async all(...params) { const r = await exec(params); return r.rows; },
      async run(...params) { const r = await exec(params); return { changes: r.rowCount }; },
    };
  }
  return { prepare, query: (text, params) => runner.query(text, params) };
}

const db = bind(pool, true);

// runs fn with a single dedicated client wrapped in BEGIN/COMMIT/ROLLBACK
db.transaction = async function transaction(fn) {
  const client = await connectWithRetry();
  try {
    await client.query('BEGIN');
    const result = await fn(bind(client, false));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

async function connectWithRetry() {
  try {
    return await pool.connect();
  } catch (err) {
    if (!isRetryableConnectionError(err)) throw err;
    console.warn('[db] retrying initial connection after error:', err.message);
    await delay(300);
    return pool.connect();
  }
}

// --- schema (idempotent — every statement is CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT
// EXISTS, safe to run concurrently from multiple cold starts without any locking) ---
//
// A previous version of this guarded the DDL with a session-scoped Postgres advisory lock
// (pg_advisory_lock/pg_advisory_unlock). That's unsafe over a *pooled* connection (which
// DATABASE_URL is, via PgBouncer): individual statements on the same `client` object aren't
// guaranteed to hit the same actual Postgres backend outside of an explicit transaction, so
// the unlock call could silently land on a different backend than the one that acquired the
// lock — leaving it held forever. Every subsequent cold start then blocked on
// pg_advisory_lock (which waits indefinitely by design) behind that stuck lock, and since
// every request awaits db.ready before doing anything else, this took the entire site down
// until Vercel's unrelated 300s function timeout eventually killed each hung invocation.
// Removed rather than "fixed with pg_advisory_xact_lock" — the DDL below doesn't need
// locking to be safe, so the lock was pure downside.
async function ensureSchema() {
  const client = await connectWithRetry();
  try {
    await client.query(`
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

      ALTER TABLE archive ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'photo';
      ALTER TABLE archive ADD COLUMN IF NOT EXISTS file_path TEXT;
      ALTER TABLE archive ADD COLUMN IF NOT EXISTS person_id TEXT;
      ALTER TABLE archive ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
      ALTER TABLE archive ADD COLUMN IF NOT EXISTS reviewed_at TEXT;
      ALTER TABLE archive ADD COLUMN IF NOT EXISTS event_type TEXT;
    `);
    console.log('[db] schema ready (postgres)');
  } finally {
    client.release();
  }
}

// Belt-and-suspenders on top of removing the advisory lock above: every request awaits
// db.ready before doing anything else (see the gate middleware in app.js), so this promise
// must never hang forever, no matter what goes wrong inside ensureSchema() in the future.
// Cap it at 15s and resolve (not reject) either way — worst case a route hits a real error
// against a not-yet-migrated table and returns a normal 500, instead of every request on
// the site hanging until Vercel's unrelated 300s function timeout kills it.
db.ready = Promise.race([
  ensureSchema().catch(err => { console.error('[db] schema init failed', err); }),
  new Promise(resolve => setTimeout(() => { console.error('[db] schema init exceeded 15s, proceeding anyway'); resolve(); }, 15000)),
]);
db.pool = pool;

module.exports = db;
