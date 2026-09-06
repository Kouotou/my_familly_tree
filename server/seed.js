const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// idempotent: creates the platform owner account only if one doesn't already exist. Refuses
// to run with a missing or placeholder password, so this can never be the thing that
// accidentally ships `admin`/`changeme` to a real deployment. Always a row in the `public`
// schema (Na Ajanbeta's own schema) — the platform owner isn't scoped to any one family, and
// every un-prefixed request (including the owner dashboard's own login) resolves to `public`
// by default, so no special schema-targeting is needed here.
async function ensureSuperAdmin() {
  await db.ready;

  const username = process.env.SUPER_ADMIN_USER;
  const pwd = process.env.SUPER_ADMIN_PWD;
  if (!username || !pwd) {
    console.error('[seed] SUPER_ADMIN_USER and SUPER_ADMIN_PWD must both be set — refusing to run.');
    process.exitCode = 1;
    return;
  }
  if (pwd === 'changeme') {
    console.error('[seed] SUPER_ADMIN_PWD is still the placeholder "changeme" — set a real password and retry.');
    process.exitCode = 1;
    return;
  }

  const existing = await db.prepare("SELECT id FROM users WHERE role = 'platform_owner' LIMIT 1").get();
  if (existing) {
    console.log('[seed] a platform owner already exists, skipping.');
    await db.pool.end();
    return;
  }

  const hash = bcrypt.hashSync(pwd, 10);
  await db.prepare('INSERT INTO users (id, username, password_hash, role, person_id) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv4(), username, hash, 'platform_owner', null);
  console.log('[seed] platform owner created:', username);
  await db.pool.end();
}

if (require.main === module) {
  ensureSuperAdmin().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { ensureSuperAdmin };
