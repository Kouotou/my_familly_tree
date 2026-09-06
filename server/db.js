const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
const { sendEmail } = require('./email');

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

// --- multi-tenancy: one Postgres schema per family -----------------------------------------
// Every request is scoped to exactly one family's schema via a per-request Postgres client
// whose `search_path` is set once (see server/tenant.js, which builds on the primitives
// below). Storing that client in AsyncLocalStorage lets every existing `db.prepare(...)` call
// site across the whole codebase keep working completely unchanged — they transparently run
// against whichever schema the current request belongs to, with isolation enforced by
// Postgres itself rather than by an application-level filter that every query would otherwise
// need to remember to include.
//
// `search_path` always lists the tenant schema first, `public` second — never the tenant
// schema alone. This is deliberate, not just a default: connect-pg-simple (the session store)
// runs its own unqualified queries against a plain `session` table using this same pool, via
// its own independent checkout/release cycle, on a connection that could have any schema left
// over from whichever request last used it. Keeping `public` in the path always resolves
// `session` correctly regardless of that leftover state, since no tenant schema ever defines
// one.
const requestContext = new AsyncLocalStorage();

// schema names are only ever derived from a slug already validated against
// /^[a-z0-9]+(-[a-z0-9]+)*$/ (see server/tenant.js) — this is a defensive re-check, not the
// primary guard, since `SET search_path` can't take a bound parameter and this string is
// interpolated directly into SQL.
function quoteSchemaIdent(schemaName) {
  if (!/^[a-z0-9_]+$/.test(schemaName)) throw new Error(`refusing to use unsafe schema name: ${schemaName}`);
  return `"${schemaName}"`;
}

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

// whichever client the current request (or one-off tenant operation) has parked in
// AsyncLocalStorage, or the shared pool if there is none (e.g. at boot, before any request
// has come in) — this is what makes every existing `db.prepare(...)` call site in the
// codebase tenant-aware without having to change any of them.
function currentRunner() {
  const store = requestContext.getStore();
  return store ? store.client : pool;
}

// Whether a single failed query on the current connection is safe to retry once (see
// isRetryableConnectionError above — the cold-start-reconnect issue this exists for is a
// per-connection problem, not specific to the shared pool). Safe whenever queries are each
// auto-committed independently, which is everything except inside an explicit db.transaction()
// (BEGIN...COMMIT) — retrying a query there could re-run a statement whose effects are already
// ambiguously applied. Every other path (the shared pool with no request in flight, and every
// per-request/one-off tenant-scoped client below) is a bare series of independent statements,
// exactly like the original pool-only version of this file, so retry stays on for all of them.
function currentAllowRetry() {
  const store = requestContext.getStore();
  return !store || store.allowRetry !== false;
}

const db = {
  prepare(sql) { return bind(currentRunner(), currentAllowRetry()).prepare(sql); },
  query(text, params) { return currentRunner().query(text, params); },
};

// runs fn with a single dedicated client wrapped in BEGIN/COMMIT/ROLLBACK — unchanged
// signature/usage for every existing call site, just also applies the current request's
// schema (if any) to the fresh client it checks out here, since this client is distinct from
// whatever client the surrounding request already parked in AsyncLocalStorage.
db.transaction = async function transaction(fn) {
  const store = requestContext.getStore();
  const client = await connectWithRetry();
  try {
    if (store && store.schemaIdent) await client.query(`SET search_path TO ${store.schemaIdent}, public`);
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

// one-off cross-schema operation (e.g. approving a new family: creating its schema, seeding
// its first admin row) — checks out its own client, sets search_path, awaits fn to completion,
// then releases. Safe to await directly (unlike the Express-lifecycle attachment in
// server/tenant.js, where "when is this request truly done" isn't something a plain await can
// answer) since this is just a normal async function call, not a middleware `next()`.
db.withTenant = async function withTenant(schemaName, fn) {
  const schemaIdent = quoteSchemaIdent(schemaName);
  const client = await connectWithRetry();
  try {
    await client.query(`SET search_path TO ${schemaIdent}, public`);
    return await requestContext.run({ client, schemaIdent, allowRetry: true }, fn);
  } finally {
    client.release();
  }
};

// used by server/tenant.js's request middleware, which manages this client's lifetime itself
// (release is tied to the response's 'finish'/'close' events, not to an awaitable callback —
// see the comment there for why db.withTenant's await-then-release shape doesn't fit there).
db.connectForTenant = async function connectForTenant(schemaName) {
  const schemaIdent = quoteSchemaIdent(schemaName);
  const client = await connectWithRetry();
  try {
    await client.query(`SET search_path TO ${schemaIdent}, public`);
  } catch (err) {
    client.release();
    throw err;
  }
  return { client, schemaIdent };
};

db.runInTenantContext = function runInTenantContext(client, schemaIdent, next) {
  requestContext.run({ client, schemaIdent }, next);
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
//
// Parameterized by schema name so the exact same table set can be created for a brand new
// family (see db.createFamilySchema below) as is created for Na Ajanbeta's own schema
// ('public') at boot. `schemaIdent` must already be produced by quoteSchemaIdent — every
// caller in this file goes through that.
async function ensureSchema(schemaIdent) {
  const client = await connectWithRetry();
  try {
    await client.query(`SET search_path TO ${schemaIdent}, public`);
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

      CREATE TABLE IF NOT EXISTS archive_likes (
        id TEXT PRIMARY KEY,
        archive_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        created_at TEXT,
        UNIQUE(archive_id, person_id)
      );

      CREATE TABLE IF NOT EXISTS archive_comments (
        id TEXT PRIMARY KEY,
        archive_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS feedback_messages (
        id TEXT PRIMARY KEY,
        person_id TEXT,
        body TEXT NOT NULL,
        created_at TEXT
      );

      -- a scheduled family happening (wedding, reunion, funeral, ...) with a date/time and
      -- location — distinct from archive.event_type, which just tags an existing post
      -- (photo/audio/video) as being *about* an event. reminder_*_sent flags let the daily
      -- cron job (GET /cron/event-reminders in server/routes.js) fire each reminder exactly
      -- once as its threshold is crossed, without needing a separate reminders table.
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        location TEXT,
        event_at TEXT NOT NULL,
        description TEXT,
        person_id TEXT,
        created_by TEXT,
        created_at TEXT,
        approval_status TEXT DEFAULT 'pending',
        reviewed_by TEXT,
        reviewed_at TEXT,
        reminder_month_sent BOOLEAN DEFAULT false,
        reminder_week_sent BOOLEAN DEFAULT false,
        reminder_day_sent BOOLEAN DEFAULT false
      );

      CREATE TABLE IF NOT EXISTS analytics_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        person_id TEXT,
        role TEXT,
        page TEXT,
        meta TEXT,
        load_ms INTEGER,
        created_at TEXT
      );

      ALTER TABLE archive ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'photo';
      ALTER TABLE archive ADD COLUMN IF NOT EXISTS file_path TEXT;
      ALTER TABLE archive ADD COLUMN IF NOT EXISTS person_id TEXT;
      ALTER TABLE archive ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
      ALTER TABLE archive ADD COLUMN IF NOT EXISTS reviewed_at TEXT;
      ALTER TABLE archive ADD COLUMN IF NOT EXISTS event_type TEXT;
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS resolved_person_id TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TEXT;
      -- when this user last opened the notification bell — "new" items are anything that
      -- went live (was approved) after this, computed on the fly rather than a separate
      -- per-user-per-item read-tracking table
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_seen_at TEXT;
      -- 'en' or 'fr' — refreshed on every login from the device's/browser's current language
      -- (see currentLang() in public/app.js), and set at account-creation time from whatever
      -- language the requester's own device was in. Used to send every outbound email (server/
      -- routes.js's emailT()/groupEmailsByLang()) in the recipient's own language instead of a
      -- single hardcoded one.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT 'en';
    `);
    console.log(`[db] schema ready (postgres) — ${schemaIdent}`);
  } finally {
    client.release();
  }
}

// platform-level tables — always in the literal `public` schema regardless of any tenant's
// schema, and always referred to with an explicit `public.` prefix in queries (never through
// `search_path`), since these describe the families themselves rather than belonging to one.
async function ensurePlatformSchema() {
  const client = await connectWithRetry();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.families (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        schema_name TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        owner_username TEXT,
        owner_email TEXT,
        hero_image_path TEXT,
        created_at TEXT,
        approved_at TEXT,
        reviewed_by TEXT
      );

      CREATE TABLE IF NOT EXISTS public.platform_requests (
        id TEXT PRIMARY KEY,
        type TEXT,
        payload TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT,
        reviewed_by TEXT,
        reviewed_at TEXT,
        review_note TEXT
      );
    `);
    // one-time rename: the family ID was originally 'najambeta' — existing production rows
    // still say that. A no-op on every run after the first, and must run *before* the insert
    // below so a fresh database (nothing to rename yet) still ends up with the right slug.
    await client.query(`UPDATE public.families SET slug = 'nahadjambethe' WHERE slug = 'najambeta'`);
    // Na Ajanbeta is family #1, living in the pre-existing 'public' schema — inserted once,
    // idempotently, so every existing deployment's data is immediately addressable the same
    // way any newly-approved family's data is.
    await client.query(
      `INSERT INTO public.families (id, slug, schema_name, name, status, created_at, approved_at)
       VALUES ('najambeta', 'nahadjambethe', 'public', 'Nah Adja Mbethe', 'active', NOW()::text, NOW()::text)
       ON CONFLICT (slug) DO NOTHING`
    );
    // one-time role rename: the platform owner used to be called 'superadmin' — existing
    // production rows still say that. A no-op on every run after the first.
    await client.query(`UPDATE public.users SET role = 'platform_owner' WHERE role = 'superadmin'`);
    // one-time default: preserve Na Ajanbeta's existing hardcoded login-page photo as its
    // *explicit* setting, now that the login page's fallback (see server/routes.js
    // GET /settings/hero-image and public/login.html) is a neutral placeholder for any family
    // that hasn't set their own yet — without this, Na Ajanbeta would suddenly show that
    // placeholder too, since it never went through the new "admin uploads a photo" flow.
    await client.query(
      `INSERT INTO public.settings (key, value) VALUES ('hero_image_path', '/family-photo.jpg') ON CONFLICT (key) DO NOTHING`
    );
    console.log('[db] platform schema ready (public.families, public.platform_requests)');
    await notifyExistingAdminsOfFamilyLinkOnce(client);
  } finally {
    client.release();
  }
}

// one-time notice to every existing Na Ajanbeta admin that URLs are now family-scoped — not a
// credential reset (their existing username/password keep working unchanged), just pointing
// them at the same `/f/<slug>/admin-login` link a newly-approved family's admin gets. Gated on
// a settings flag in Na Ajanbeta's own (public) schema so it only ever sends once, however many
// times the app cold-starts. Keyed 'v2' since the slug itself changed after the first notice
// already went out (najambeta -> nahadjambethe) — this resends once with the corrected link,
// rather than silently leaving admins with a now-broken bookmark from the first notice.
async function notifyExistingAdminsOfFamilyLinkOnce(client) {
  const flag = await client.query(`SELECT value FROM public.settings WHERE key = 'nahadjambethe_link_notice_sent_v2'`);
  if (flag.rows[0]) return;
  const admins = await client.query(
    `SELECT username, email FROM public.users WHERE role IN ('admin','platform_owner') AND email IS NOT NULL AND email != ''`
  );
  const base = process.env.PUBLIC_BASE_URL || '';
  const link = `${base}/f/nahadjambethe/admin-login`;
  for (const a of admins.rows) {
    await sendEmail({
      to: a.email,
      subject: '[Nah Adja Mbethe] Your family\'s address has changed slightly',
      html: `<p>Hello ${a.username},</p><p>Your family's dedicated web address is now:</p><p><a href="${link}">${link}</a></p><p>If you'd already bookmarked the previous "/f/najambeta/" link, please update it to this one instead. Nothing else changes — your existing username and password keep working exactly as before.</p>`,
    }).catch(() => {});
  }
  await client.query(
    `INSERT INTO public.settings (key, value) VALUES ('nahadjambethe_link_notice_sent_v2', 'true') ON CONFLICT (key) DO UPDATE SET value = excluded.value`
  );
}

// creates a brand new family's schema and tables — called once, at family-creation-approval
// time (see server/routes.js processCreateFamily). Idempotent like everything else here, but
// in practice only ever called once per family.
db.createFamilySchema = async function createFamilySchema(schemaName) {
  const schemaIdent = quoteSchemaIdent(schemaName);
  const client = await connectWithRetry();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaIdent}`);
  } finally {
    client.release();
  }
  await ensureSchema(schemaIdent);
};

// Belt-and-suspenders on top of removing the advisory lock above: every request awaits
// db.ready before doing anything else (see the gate middleware in app.js), so this promise
// must never hang forever, no matter what goes wrong inside ensureSchema() in the future.
// Cap it at 15s and resolve (not reject) either way — worst case a route hits a real error
// against a not-yet-migrated table and returns a normal 500, instead of every request on
// the site hanging until Vercel's unrelated 300s function timeout kills it.
db.ready = Promise.race([
  (async () => { await ensureSchema(quoteSchemaIdent('public')); await ensurePlatformSchema(); })()
    .catch(err => { console.error('[db] schema init failed', err); }),
  new Promise(resolve => setTimeout(() => { console.error('[db] schema init exceeded 15s, proceeding anyway'); resolve(); }, 15000)),
]);
db.pool = pool;

module.exports = db;
