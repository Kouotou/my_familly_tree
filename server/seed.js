const db = require('./db');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

function now() { return new Date().toISOString(); }

function seed() {
  // check if already seeded
  const row = db.prepare('SELECT COUNT(1) as c FROM people').get();
  if (row.c > 0) {
    console.log('DB already seeded');
    return;
  }

  // sample family head
  const headId = uuidv4();
  const aliceId = uuidv4();
  const bobId = uuidv4();

  const insertPerson = db.prepare(`INSERT INTO people (id, username, full_name, gender, birth_year, occupation, residence, phone, family_head, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  insertPerson.run(headId, 'head1', 'Grandpa John', 'male', 1945, 'Farmer', 'Village','', headId, 'system', now(), 'approved');
  insertPerson.run(aliceId, null, 'Alice Smith', 'female', 1970, 'Teacher', 'Town', '', headId, 'system', now(), 'approved');
  insertPerson.run(bobId, null, 'Bob Smith', 'male', 1968, 'Carpenter', 'Town', '', headId, 'system', now(), 'approved');

  const insertRel = db.prepare('INSERT INTO relationships (id, person_id, relative_id, type) VALUES (?, ?, ?, ?)');
  insertRel.run(uuidv4(), aliceId, headId, 'parent');
  insertRel.run(uuidv4(), bobId, headId, 'parent');

  // admin user
  const insertUser = db.prepare('INSERT INTO users (id, username, password_hash, role, person_id) VALUES (?, ?, ?, ?, ?)');
  const pwd = process.env.SUPER_ADMIN_PWD || 'changeme';
  const hash = bcrypt.hashSync(pwd, 10);
  insertUser.run(uuidv4(), process.env.SUPER_ADMIN_USER || 'admin', hash, 'superadmin', null);

  // sample archive
  const insertArchive = db.prepare('INSERT INTO archive (id, title, url, description, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insertArchive.run(uuidv4(), 'Opening Ceremony Video', 'https://youtu.be/dQw4w9WgXcQ', 'Sample family video', 'system', now(), 'approved');

  console.log('Seeded demo data. Admin user:', process.env.SUPER_ADMIN_USER || 'admin', 'password:', process.env.SUPER_ADMIN_PWD || 'changeme');
}

seed();
