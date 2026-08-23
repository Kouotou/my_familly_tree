const db = require('./db');
const { v4: uuidv4 } = require('uuid');

// local-dev-only sample data: a few sample people/relationships/archive row, so the app has
// something to look at without needing a real registration. Never run this against
// production — it's not wired into any deploy step, and won't create a superadmin account
// (use `npm run init-db` / server/seed.js for that).
function now() { return new Date().toISOString(); }

async function seedDemo() {
  await db.ready;

  const row = await db.prepare('SELECT COUNT(1) as c FROM people').get();
  if (row.c > 0) {
    console.log('[seed-demo] people table is not empty, skipping.');
    await db.pool.end();
    return;
  }

  const headId = uuidv4();
  const aliceId = uuidv4();
  const bobId = uuidv4();

  const insertPerson = db.prepare('INSERT INTO people (id, username, full_name, gender, birth_year, occupation, residence, phone, family_head, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  await insertPerson.run(headId, 'head1', 'Grandpa John', 'male', 1945, 'Farmer', 'Village', '', headId, 'system', now(), 'approved');
  await insertPerson.run(aliceId, null, 'Alice Smith', 'female', 1970, 'Teacher', 'Town', '', headId, 'system', now(), 'approved');
  await insertPerson.run(bobId, null, 'Bob Smith', 'male', 1968, 'Carpenter', 'Town', '', headId, 'system', now(), 'approved');

  const insertRel = db.prepare('INSERT INTO relationships (id, person_id, relative_id, type) VALUES (?, ?, ?, ?)');
  await insertRel.run(uuidv4(), aliceId, headId, 'parent');
  await insertRel.run(uuidv4(), bobId, headId, 'parent');

  const insertArchive = db.prepare('INSERT INTO archive (id, title, url, description, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  await insertArchive.run(uuidv4(), 'Opening Ceremony Video', 'https://youtu.be/dQw4w9WgXcQ', 'Sample family video', 'system', now(), 'approved');

  console.log('[seed-demo] sample data created.');
  await db.pool.end();
}

if (require.main === module) {
  seedDemo().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { seedDemo };
