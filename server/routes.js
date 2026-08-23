const express = require('express');
const router = express.Router();
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { put } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');

// 4MB backstop for server-routed uploads (photos) — comfortably under Vercel's 4.5MB
// serverless request-body ceiling. Archive audio bypasses this entirely via client-direct
// upload (see POST /archive/upload-token) since voice memos/song clips routinely exceed it.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

// Express 4 does not auto-forward a rejected promise from an async route handler to error
// middleware (that's an Express 5 behavior) — without this, an unhandled async error would
// hang the request instead of producing a response. Wrap every handler with this.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function now(){ return new Date().toISOString(); }

// helper: normalize name for tolerant matching
function normalizeName(s){ return (s||'').trim().toLowerCase().replace(/\s+/g,' '); }

async function uploadPhoto(file, prefix){
  if (!file) return null;
  const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase();
  const blob = await put(`${prefix}/${uuidv4()}${ext}`, file.buffer, {
    access: 'public',
    contentType: file.mimetype,
    addRandomSuffix: false,
  });
  return blob.url;
}

// settings key/value helpers (used for e.g. the family tree root profile)
async function getSetting(key){ const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return row ? row.value : null; }
async function setSetting(key, value){ await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }

function requireAdmin(req,res){
  if (!req.session.user){ res.status(401).json({error:'not logged in'}); return false; }
  if (!req.session.user.role || req.session.user.role==='member'){ res.status(403).json({error:'forbidden'}); return false; }
  return true;
}

// any logged-in account with a linked profile (i.e. a real person, not a bare admin login)
function requireLoggedInPerson(req,res){
  if (!req.session.user){ res.status(401).json({error:'not logged in'}); return false; }
  if (!req.session.user.person_id){ res.status(403).json({error:'no linked profile'}); return false; }
  return true;
}

// any logged-in account at all, member or admin — used for actions (like changing one's
// own password) that don't need a linked person profile
function requireLoggedIn(req,res){
  if (!req.session.user){ res.status(401).json({error:'not logged in'}); return false; }
  return true;
}

async function isUsernameTaken(username){
  if (!username) return false;
  if (await db.prepare('SELECT id FROM people WHERE username = ?').get(username)) return true;
  if (await db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return true;
  const pending = await db.prepare("SELECT payload FROM requests WHERE status = 'pending'").all();
  return pending.some(r=>{ try{ return JSON.parse(r.payload).username === username; }catch(e){ return false; } });
}

// this person's father/mother, classified by gender among their recorded parents.
// `dbLike` is either the module-level pool-bound `db` or a transaction's `tx` — every
// helper below takes it as the first argument so the same logic works identically whether
// called standalone or as part of a multi-write transaction.
async function getParentIds(dbLike, personId){
  const rows = await dbLike.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'parent'").all(personId);
  let fatherId = null, motherId = null;
  for (const r of rows){
    const p = await dbLike.prepare('SELECT gender FROM people WHERE id = ?').get(r.relative_id);
    const g = ((p && p.gender) || '').toLowerCase();
    if (g === 'male' && !fatherId) fatherId = r.relative_id;
    else if (g === 'female' && !motherId) motherId = r.relative_id;
  }
  return { fatherId, motherId };
}

async function getSpouseIds(dbLike, personId){
  const rows = await dbLike.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'spouse'").all(personId);
  return rows.map(r=>r.relative_id);
}

// Login by username + password — used for both members and admins. Username is each
// person's unique login id (assigned at registration, or by an admin for accounts they
// create directly).
async function handleLogin(req, res){
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid' });
  req.session.user = { id: user.id, role: user.role, person_id: user.person_id };
  return res.json({ ok:true, role: user.role, person_id: user.person_id });
}
router.post('/auth/login', wrap(handleLogin));
// kept as an alias so the existing admin-login page keeps working unchanged
router.post('/auth/admin-login', wrap(handleLogin));

router.post('/auth/logout',(req,res)=>{ req.session.destroy(()=>res.json({ok:true})); });

// self-service: "forgot password" — creates a pending request an admin sees in the normal
// requests queue, who then sets a new password via the existing "Modify account" flow and
// tells the member out of band. Always responds the same way regardless of whether the
// username exists, so this can't be used to enumerate valid usernames.
router.post('/auth/request-password-reset', express.json(), wrap(async (req,res)=>{
  const username = ((req.body && req.body.username) || '').trim();
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  const user = await db.prepare('SELECT id, person_id FROM users WHERE username = ?').get(username);
  if (user) {
    let fullName = username;
    if (user.person_id) {
      const person = await db.prepare('SELECT full_name FROM people WHERE id = ?').get(user.person_id);
      if (person) fullName = person.full_name;
    }
    const payload = { type: 'password_reset', username, person_id: user.person_id || null, full_name: fullName };
    await db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), 'password_reset', JSON.stringify(payload), 'pending', 'self-service', now());
  }
  res.json({ ok: true });
}));

// get current session
router.get('/auth/me', wrap(async (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  const person = await db.prepare('SELECT * FROM people WHERE id = ?').get(req.session.user.person_id);
  res.json({ user: req.session.user, person });
}));

// list approved people
router.get('/people', wrap(async (req,res)=>{
  const rows = await db.prepare("SELECT * FROM people WHERE approval_status = 'approved'").all();
  res.json(rows);
}));

// search approved people by (partial) name — used to match parents typed during registration
router.get('/people/search', wrap(async (req,res)=>{
  const q = normalizeName(req.query.name || req.query.q || '');
  if (!q) return res.json([]);
  const rows = await db.prepare("SELECT * FROM people WHERE approval_status = 'approved'").all();
  const matches = rows.filter(p => normalizeName(p.full_name).includes(q));
  res.json(matches.slice(0, 20));
}));

// get a single person
router.get('/people/:id', wrap(async (req,res)=>{
  const p = await db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({error:'not found'});
  res.json(p);
}));

// create request (generic pending change)
router.post('/requests', upload.single('photo'), wrap(async (req,res)=>{
  const payload = req.body;
  if (req.file) payload.photo_path = await uploadPhoto(req.file, 'photos');
  const id = uuidv4();
  await db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, payload.type || 'create_person', JSON.stringify(payload), 'pending', req.session.user?req.session.user.id:'anonymous', now());
  res.json({ok:true, id});
}));

// self-registration: creates a pending create_person request
router.post('/auth/register', upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'father_photo', maxCount: 1 },
  { name: 'mother_photo', maxCount: 1 }
]), wrap(async (req,res)=>{
  const body = req.body || {};
  const files = req.files || {};

  // username/password/full name are mandatory — the username becomes this person's unique
  // login id. A father and mother link (existing profile or new-person details) are also
  // mandatory, since every member's place in the tree comes from that connection.
  if (!body.username || !body.password || !body.full_name) return res.status(400).json({ error: 'Username, password, and full name are required.' });
  if (await isUsernameTaken(body.username)) return res.status(409).json({ error: 'That username is already taken. Please choose another.' });
  if (!body.father_id && !body.father_name) return res.status(400).json({ error: "Your father's name is required — link an existing profile or enter their details." });
  if (!body.mother_id && !body.mother_name) return res.status(400).json({ error: "Your mother's name is required — link an existing profile or enter their details." });

  if (files.photo && files.photo[0]) body.photo_path = await uploadPhoto(files.photo[0], 'photos');
  // prefer full birth_date (YYYY-MM-DD). If only year provided, store as birth_year.
  let birthDate = body.birth_date || null;
  let birthYear = null;
  if (birthDate){
    try{ const d = new Date(birthDate); if (isFinite(d)) birthYear = d.getFullYear(); else birthDate = null; }catch(e){ birthDate = null; }
  }
  if (!birthDate && body.birth_year) birthYear = Number(body.birth_year);

  const payload = {
    type: 'create_person',
    username: body.username || null,
    password: body.password || null,
    full_name: body.full_name,
    gender: body.gender,
    birth_year: birthYear,
    birth_date: birthDate,
    death_date: body.death_date || null,
    occupation: body.occupation || null,
    residence: body.residence || null,
    phone: body.phone || null,
    photo_path: body.photo_path || null,
    relations: []
  };

  // father: either an existing matched profile (father_id) or full details to create a new one
  if (body.father_id){
    payload.relations.push({ type: 'parent', which: 'father', from_family: true, relative_id: body.father_id });
  } else if (body.father_name){
    payload.relations.push({
      type: 'parent', which: 'father',
      from_family: body.father_origin !== 'married',
      relative: {
        full_name: body.father_name,
        birth_year: body.father_birth_year || null,
        birth_date: body.father_birth_date || null,
        occupation: body.father_occupation || null,
        residence: body.father_residence || null,
        phone: body.father_phone || null,
        photo_path: files.father_photo && files.father_photo[0] ? await uploadPhoto(files.father_photo[0], 'photos') : null
      }
    });
  }
  // mother: either an existing matched profile (mother_id) or full details to create a new one
  if (body.mother_id){
    payload.relations.push({ type: 'parent', which: 'mother', from_family: true, relative_id: body.mother_id });
  } else if (body.mother_name){
    payload.relations.push({
      type: 'parent', which: 'mother',
      from_family: body.mother_origin !== 'married',
      relative: {
        full_name: body.mother_name,
        birth_year: body.mother_birth_year || null,
        birth_date: body.mother_birth_date || null,
        occupation: body.mother_occupation || null,
        residence: body.mother_residence || null,
        phone: body.mother_phone || null,
        photo_path: files.mother_photo && files.mother_photo[0] ? await uploadPhoto(files.mother_photo[0], 'photos') : null
      }
    });
  }

  const id = uuidv4();
  await db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'create_person', JSON.stringify(payload), 'pending', 'self-register', now());
  res.json({ ok:true, id });
}));

// admin: list requests (status can be pending|approved|rejected)
router.get('/admin/requests', wrap(async (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  // the Rejected tab (both actual rejections and the "delete account" audit trail — see
  // /admin/people/:id/delete below, which files itself as a rejected delete_person request)
  // is meant to be a brief undo window, not a permanent log — purge anything past 24h.
  // Lazily, on read, rather than via a scheduled job: this app is a single serverless
  // function with no persistent process to run a cron in.
  await db.prepare("DELETE FROM requests WHERE status = 'rejected' AND reviewed_at IS NOT NULL AND reviewed_at::timestamptz < NOW() - INTERVAL '24 hours'").run();
  const status = (req.query.status || 'pending').toLowerCase();
  if (!['pending','approved','rejected'].includes(status)) return res.status(400).json({error:'invalid status'});
  const rows = await db.prepare('SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC').all(status);
  res.json(rows.map(r=> ({...r, payload: JSON.parse(r.payload)})));
}));

// --- shared person/relationship helpers, used by request-approval processors below ---
// Each takes `dbLike` (the pool-bound `db`, or a transaction's `tx`) as its first argument.

async function createPersonRecord(dbLike, p, reviewerId){
  // if username provided and a person already exists with that username, reuse it
  if (p.username){
    const existing = await dbLike.prepare('SELECT id FROM people WHERE username = ?').get(p.username);
    if (existing && existing.id) return existing.id;
  }
  const id = uuidv4();
  // ON CONFLICT (username) DO NOTHING avoids a unique-constraint error if another
  // concurrent request just created the same username; NULL usernames never conflict
  // (Postgres treats each NULL as distinct), so this is a no-op for relative placeholders
  // created without a login.
  await dbLike.prepare('INSERT INTO people (id, username, full_name, gender, birth_year, birth_date, death_date, occupation, residence, phone, photo_path, family_head, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (username) DO NOTHING')
    .run(id, p.username||null, p.full_name, p.gender||null, p.birth_year||null, p.birth_date||null, p.death_date||null, p.occupation||null, p.residence||null, p.phone||null, p.photo_path||null, p.family_head||null, reviewerId, now(), 'approved');
  if (p.username){
    const existingByUser = await dbLike.prepare('SELECT id FROM people WHERE username = ?').get(p.username);
    if (existingByUser && existingByUser.id) return existingByUser.id;
  }
  // otherwise try to find by full_name + birth_date (if available)
  if (p.full_name && p.birth_date){
    const existingByName = await dbLike.prepare('SELECT id FROM people WHERE full_name = ? AND birth_date = ?').get(p.full_name, p.birth_date);
    if (existingByName && existingByName.id) return existingByName.id;
  }
  // fallback to the id we attempted to insert
  return id;
}

async function linkParentChild(dbLike, childId, parentId, note){
  const existing = await dbLike.prepare("SELECT id FROM relationships WHERE person_id = ? AND relative_id = ? AND type = 'parent'").get(childId, parentId);
  if (existing) return;
  const ins = dbLike.prepare('INSERT INTO relationships (id, person_id, relative_id, type, notes) VALUES (?, ?, ?, ?, ?)');
  await ins.run(uuidv4(), childId, parentId, 'parent', note || null);
  await ins.run(uuidv4(), parentId, childId, 'child', note || null);
}

async function linkSpouse(dbLike, a,b){
  // avoid duplicate spouse links (e.g. both parents already matched to existing profiles)
  const existing = await dbLike.prepare("SELECT id FROM relationships WHERE person_id = ? AND relative_id = ? AND type = 'spouse'").get(a,b);
  if (existing) return;
  const ins = dbLike.prepare('INSERT INTO relationships (id, person_id, relative_id, type) VALUES (?, ?, ?, ?)');
  await ins.run(uuidv4(), a, b, 'spouse');
  await ins.run(uuidv4(), b, a, 'spouse');
}

// used only when two siblings share no recorded parent yet, so there's no shared-parent
// link to hang the relationship off of
async function linkSibling(dbLike, a,b){
  const existing = await dbLike.prepare("SELECT id FROM relationships WHERE person_id = ? AND relative_id = ? AND type = 'sibling'").get(a,b);
  if (existing) return;
  const ins = dbLike.prepare('INSERT INTO relationships (id, person_id, relative_id, type) VALUES (?, ?, ?, ?)');
  await ins.run(uuidv4(), a, b, 'sibling');
  await ins.run(uuidv4(), b, a, 'sibling');
}

async function createLoginForPerson(dbLike, personId, username, password){
  if (!username || !password) return;
  const pwdHash = bcrypt.hashSync(password, 10);
  await dbLike.prepare('INSERT INTO users (id, username, password_hash, role, person_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT (username) DO NOTHING').run(uuidv4(), username, pwdHash, 'member', personId);
  await dbLike.prepare('UPDATE users SET person_id = ? WHERE username = ?').run(personId, username);
}

async function unlinkParentChild(dbLike, childId, parentId){
  await dbLike.prepare("DELETE FROM relationships WHERE (person_id = ? AND relative_id = ? AND type = 'parent') OR (person_id = ? AND relative_id = ? AND type = 'child')").run(childId, parentId, parentId, childId);
}

// admin-only: correct who a person's father/mother actually are, including for a person
// who's already approved and in the tree — unlike processCreatePerson (which only ever
// inserts, since the person is brand new), this must also *remove* a wrong existing link
// before adding the right one. This is what lets the admin fix an isolated account (e.g. a
// parent stub created during someone else's registration, never linked further up) after
// the fact, instead of only being able to set relations once at initial approval.
// `relations` is the same shape used everywhere else: [{type:'parent', which, from_family,
// relative_id} | {type:'parent', which, from_family, relative:{full_name,...}}]. A `which`
// with no entry in `relations` means the admin removed that parent link entirely.
async function applyParentEdits(dbLike, personId, relations, reviewerId){
  if (!Array.isArray(relations)) return;
  const { fatherId: currentFatherId, motherId: currentMotherId } = await getParentIds(dbLike, personId);
  const current = { father: currentFatherId, mother: currentMotherId };

  for (const which of ['father','mother']){
    const rel = relations.find(r=> r.type==='parent' && r.which===which);
    const currentId = current[which];

    if (!rel){
      if (currentId) await unlinkParentChild(dbLike, personId, currentId);
      current[which] = null;
      continue;
    }

    let targetId = rel.relative_id || null;
    if (!targetId){
      const relative = rel.relative || {};
      if (!relative.full_name || !relative.full_name.trim()) continue; // nothing usable submitted for this slot — leave as-is
      targetId = await createPersonRecord(dbLike, {
        full_name: relative.full_name, birth_year: relative.birth_year||null, birth_date: relative.birth_date||null,
        gender: which==='father' ? 'male' : 'female', occupation: relative.occupation||null, residence: relative.residence||null,
        phone: relative.phone||null, photo_path: relative.photo_path||null
      }, reviewerId);
    }

    const note = rel.from_family === false ? 'married-in' : 'blood';
    if (currentId && currentId !== targetId) await unlinkParentChild(dbLike, personId, currentId);
    if (currentId !== targetId) await linkParentChild(dbLike, personId, targetId, note);
    else await dbLike.prepare("UPDATE relationships SET notes = ? WHERE (person_id = ? AND relative_id = ? AND type = 'parent') OR (person_id = ? AND relative_id = ? AND type = 'child')").run(note, personId, targetId, targetId, personId);

    current[which] = targetId;
  }

  if (current.father && current.mother) await linkSpouse(dbLike, current.father, current.mother);
}

// helper to process create_person payload into the DB and return the created person id
async function processCreatePerson(dbLike, payload, reviewerId){
  const personId = await createPersonRecord(dbLike, payload, reviewerId);
  await createLoginForPerson(dbLike, personId, payload.username, payload.password);

  if (Array.isArray(payload.relations)){
    const father = payload.relations.find(r=> r.type==='parent' && r.which==='father');
    const mother = payload.relations.find(r=> r.type==='parent' && r.which==='mother');

    let fatherId = null, motherId = null;
    if (father){
      fatherId = father.relative_id;
      if (!fatherId){
        const frel = father.relative || {};
        fatherId = await createPersonRecord(dbLike, { full_name: frel.full_name || 'Unknown', birth_year: frel.birth_year||null, birth_date: frel.birth_date||null, gender: 'male', occupation: frel.occupation||null, residence: frel.residence||null, phone: frel.phone||null, photo_path: frel.photo_path||null }, reviewerId);
      }
      await linkParentChild(dbLike, personId, fatherId, father.from_family ? 'blood' : 'married-in');
    }
    if (mother){
      motherId = mother.relative_id;
      if (!motherId){
        const mrel = mother.relative || {};
        motherId = await createPersonRecord(dbLike, { full_name: mrel.full_name || 'Unknown', birth_year: mrel.birth_year||null, birth_date: mrel.birth_date||null, gender: 'female', occupation: mrel.occupation||null, residence: mrel.residence||null, phone: mrel.phone||null, photo_path: mrel.photo_path||null }, reviewerId);
      }
      await linkParentChild(dbLike, personId, motherId, mother.from_family ? 'blood' : 'married-in');
    }
    if (fatherId && motherId) await linkSpouse(dbLike, fatherId, motherId);
  }

  return personId;
}

// apply an approved self-edit to the person's own record, keeping their existing photo
// unless a new one was uploaded with the request
async function processUpdatePerson(dbLike, payload, reviewerId){
  const current = await dbLike.prepare('SELECT * FROM people WHERE id = ?').get(payload.person_id);
  if (!current) return null;
  const photoPath = payload.photo_path || current.photo_path;
  await dbLike.prepare('UPDATE people SET full_name = ?, gender = ?, birth_year = ?, birth_date = ?, death_date = ?, occupation = ?, residence = ?, phone = ?, photo_path = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?')
    .run(payload.full_name || current.full_name, payload.gender || current.gender, payload.birth_year || null, payload.birth_date || null, payload.death_date || null, payload.occupation || null, payload.residence || null, payload.phone || null, photoPath, reviewerId, now(), current.id);
  return current.id;
}

// approve a member-submitted "add spouse/child/sibling" request: link to an existing
// matched profile, or create the new person (with their own login, if provided) and link
async function processAddRelative(dbLike, payload, reviewerId){
  const requesterId = payload.requester_person_id;
  let relativeId = payload.matched_person_id;
  if (!relativeId){
    relativeId = await createPersonRecord(dbLike, {
      full_name: payload.full_name, gender: payload.gender || null, birth_year: payload.birth_year || null,
      birth_date: payload.birth_date || null, death_date: payload.death_date || null, occupation: payload.occupation || null, residence: payload.residence || null,
      phone: payload.phone || null, photo_path: payload.photo_path || null, username: payload.username || null
    }, reviewerId);
    await createLoginForPerson(dbLike, relativeId, payload.username, payload.password);
  }

  if (payload.relation === 'spouse'){
    await linkSpouse(dbLike, requesterId, relativeId);
  } else if (payload.relation === 'child'){
    await linkParentChild(dbLike, relativeId, requesterId, 'blood');
    if (payload.other_parent_id){
      const validSpouse = await dbLike.prepare("SELECT id FROM relationships WHERE person_id = ? AND relative_id = ? AND type = 'spouse'").get(requesterId, payload.other_parent_id);
      if (validSpouse) await linkParentChild(dbLike, relativeId, payload.other_parent_id, 'blood');
    }
  } else if (payload.relation === 'sibling'){
    const { fatherId, motherId } = await getParentIds(dbLike, requesterId);
    let linked = false;
    if (fatherId && payload.link_via_father !== false){ await linkParentChild(dbLike, relativeId, fatherId, 'blood'); linked = true; }
    if (motherId && payload.link_via_mother !== false){ await linkParentChild(dbLike, relativeId, motherId, 'blood'); linked = true; }
    if (!linked) await linkSibling(dbLike, requesterId, relativeId);
  }

  return relativeId;
}

router.post('/admin/requests/:id/approve', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const id = req.params.id;
  const reqRow = await db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!reqRow) return res.status(404).json({error:'not found'});
  const payload = JSON.parse(reqRow.payload);
  try{
    await db.transaction(async (tx) => {
      // stash the id of whichever person this request actually resolved to, so the admin
      // UI can look them up directly later (for "Modify"/"Delete account" on this approved
      // request) instead of having to re-derive it by fuzzy-matching name/username against
      // the current people table — that guesswork was the cause of a real bug where those
      // buttons failed with "could not locate the person record" for legitimate accounts.
      let resolvedPersonId = null;
      if (payload.type==='create_person' || payload.type==='create'){
        resolvedPersonId = await processCreatePerson(tx, payload, req.session.user.id);
      } else if (payload.type==='update_person'){
        resolvedPersonId = await processUpdatePerson(tx, payload, req.session.user.id);
      } else if (payload.type==='add_relative'){
        resolvedPersonId = await processAddRelative(tx, payload, req.session.user.id);
      }
      await tx.prepare('UPDATE requests SET status = ?, reviewed_by = ?, reviewed_at = ?, resolved_person_id = ? WHERE id = ?').run('approved', req.session.user.id, now(), resolvedPersonId, id);
    });
    res.json({ok:true});
  }catch(err){
    console.error('Approve error', err && err.stack || err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}));

// --- member self-service: edit own profile, change password, add a relative ---

router.get('/member/context', wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const id = req.session.user.person_id;
  const spouseIds = await getSpouseIds(db, id);
  const spouses = (await Promise.all(spouseIds.map(sid=> db.prepare('SELECT id, full_name FROM people WHERE id = ?').get(sid)))).filter(Boolean);
  const { fatherId, motherId } = await getParentIds(db, id);
  const father = fatherId ? await db.prepare('SELECT id, full_name FROM people WHERE id = ?').get(fatherId) : null;
  const mother = motherId ? await db.prepare('SELECT id, full_name FROM people WHERE id = ?').get(motherId) : null;
  res.json({ spouses, father, mother });
}));

// submit a pending request to change one's own profile fields (photo, name, DOB, etc.)
router.post('/member/profile/update', upload.single('photo'), wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const body = req.body || {};
  const personId = req.session.user.person_id;
  const current = await db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!current) return res.status(404).json({ error: 'profile not found' });

  let birthDate = body.birth_date || null;
  let birthYear = null;
  if (birthDate){ try{ const d = new Date(birthDate); if (isFinite(d)) birthYear = d.getFullYear(); else birthDate = null; }catch(e){ birthDate = null; } }

  const payload = {
    type: 'update_person',
    person_id: personId,
    target_name: current.full_name,
    full_name: body.full_name || current.full_name,
    gender: body.gender || current.gender,
    birth_date: birthDate,
    birth_year: birthYear,
    death_date: body.death_date || null,
    occupation: body.occupation || null,
    residence: body.residence || null,
    phone: body.phone || null,
    photo_path: req.file ? await uploadPhoto(req.file, 'photos') : null
  };
  const id = uuidv4();
  await db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'update_person', JSON.stringify(payload), 'pending', req.session.user.id, now());
  res.json({ ok:true, id });
}));

// change one's own password immediately — a security setting, not tree data, so it
// doesn't go through admin review
router.post('/member/password', express.json(), wrap(async (req,res)=>{
  if (!requireLoggedIn(req,res)) return;
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password are required.' });
  if (String(new_password).length < 4) return res.status(400).json({ error: 'New password is too short.' });
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user) return res.status(404).json({ error: 'account not found' });
  if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect.' });
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), user.id);
  res.json({ ok:true });
}));

// submit a pending request to add a spouse, child, or sibling — either linked to an
// existing matched profile, or a brand-new one (with its own login) for admin to approve
router.post('/member/relatives/add', upload.single('photo'), wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const body = req.body || {};
  const requesterId = req.session.user.person_id;
  const requester = await db.prepare('SELECT * FROM people WHERE id = ?').get(requesterId);
  if (!requester) return res.status(404).json({ error: 'profile not found' });
  if (!['spouse','child','sibling'].includes(body.relation)) return res.status(400).json({ error: 'invalid relation' });

  const payload = {
    type: 'add_relative',
    relation: body.relation,
    requester_person_id: requesterId,
    requester_name: requester.full_name
  };

  if (body.matched_person_id){
    payload.matched_person_id = body.matched_person_id;
  } else {
    if (!body.full_name) return res.status(400).json({ error: 'Full name is required.' });
    // username/password are optional here — e.g. a deceased relative, or a child, will
    // never log in themselves. If a username IS given, a password must come with it, and
    // it must not collide with an existing one.
    if ((body.username && !body.password) || (!body.username && body.password)) return res.status(400).json({ error: 'Provide both a username and password, or leave both blank.' });
    if (body.username && await isUsernameTaken(body.username)) return res.status(409).json({ error: 'That username is already taken. Please choose another.' });

    let birthDate = body.birth_date || null;
    let birthYear = null;
    if (birthDate){ try{ const d = new Date(birthDate); if (isFinite(d)) birthYear = d.getFullYear(); else birthDate = null; }catch(e){ birthDate = null; } }

    payload.full_name = body.full_name;
    payload.gender = body.gender || null;
    payload.birth_date = birthDate;
    payload.birth_year = birthYear;
    payload.death_date = body.death_date || null;
    payload.occupation = body.occupation || null;
    payload.residence = body.residence || null;
    payload.phone = body.phone || null;
    payload.photo_path = req.file ? await uploadPhoto(req.file, 'photos') : null;
    payload.username = body.username || null;
    payload.password = body.password || null;
  }

  if (body.relation === 'child' && body.other_parent_id) payload.other_parent_id = body.other_parent_id;
  if (body.relation === 'sibling'){
    payload.link_via_father = body.link_via_father !== 'false';
    payload.link_via_mother = body.link_via_mother !== 'false';
  }

  const id = uuidv4();
  await db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'add_relative', JSON.stringify(payload), 'pending', req.session.user.id, now());
  res.json({ ok:true, id });
}));

// admin: reject request
router.post('/admin/requests/:id/reject', express.json(), wrap(async (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  const note = req.body && req.body.note ? String(req.body.note) : null;
  const reqRow = await db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!reqRow) return res.status(404).json({error:'not found'});
  await db.prepare('UPDATE requests SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?').run('rejected', req.session.user.id, now(), note, id);
  res.json({ ok:true });
}));

// admin: edit payload then approve
router.post('/admin/requests/:id/edit-approve', express.json(), wrap(async (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  const newPayload = req.body && req.body.payload ? req.body.payload : null;
  const reqRow = await db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!reqRow) return res.status(404).json({error:'not found'});
  if (!newPayload) return res.status(400).json({error:'missing payload'});
  try{
    await db.transaction(async (tx) => {
      await tx.prepare('UPDATE requests SET payload = ? WHERE id = ?').run(JSON.stringify(newPayload), id);
      let resolvedPersonId = null;
      if (newPayload.type==='create_person' || newPayload.type==='create'){
        resolvedPersonId = await processCreatePerson(tx, newPayload, req.session.user.id);
      }
      await tx.prepare('UPDATE requests SET status = ?, reviewed_by = ?, reviewed_at = ?, resolved_person_id = ? WHERE id = ?').run('approved', req.session.user.id, now(), resolvedPersonId, id);
    });
    res.json({ ok:true });
  }catch(err){
    console.error('Edit-approve error', err && err.stack || err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}));

// Accept multipart edit+photo then approve
router.post('/admin/requests/:id/edit-approve-multipart', upload.single('photo'), wrap(async (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  const reqRow = await db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!reqRow) return res.status(404).json({error:'not found'});

  const body = req.body || {};
  const payload = {
    type: body.type || 'create_person',
    username: body.username || null,
    password: null,
    full_name: body.full_name || null,
    gender: body.gender || null,
    birth_year: body.birth_year ? Number(body.birth_year) : null,
    birth_date: body.birth_date || null,
    death_date: body.death_date || null,
    occupation: body.occupation || null,
    residence: body.residence || null,
    phone: body.phone || null,
    photo_path: null,
    relations: []
  };
  if (req.file) payload.photo_path = await uploadPhoto(req.file, 'photos');

  // relations: expected as JSON string in body.relations
  if (body.relations){
    try{ payload.relations = JSON.parse(body.relations); }catch(e){ payload.relations = []; }
  }

  try{
    await db.transaction(async (tx) => {
      await tx.prepare('UPDATE requests SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id);
      let resolvedPersonId = null;
      if (payload.type==='create_person' || payload.type==='create'){
        resolvedPersonId = await processCreatePerson(tx, payload, req.session.user.id);
      }
      await tx.prepare("UPDATE requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, resolved_person_id = ? WHERE id = ?").run(req.session.user.id, now(), resolvedPersonId, id);
    });
    res.json({ ok:true });
  }catch(err){
    console.error('Edit-approve-multipart error', err && err.stack || err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}));

// Admin: update an existing person (JSON). Also handles setting a temporary password
// (p.new_password) for the linked account, for admin-assisted password resets.
router.post('/admin/people/:id/update', express.json(), wrap(async (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  const p = req.body && req.body.payload ? req.body.payload : req.body;
  if (!p) return res.status(400).json({error:'missing payload'});
  try{
    await db.transaction(async (tx) => {
      await tx.prepare('UPDATE people SET username = ?, full_name = ?, gender = ?, birth_year = ?, birth_date = ?, death_date = ?, occupation = ?, residence = ?, phone = ?, photo_path = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?')
        .run(p.username||null, p.full_name||null, p.gender||null, p.birth_year||null, p.birth_date||null, p.death_date||null, p.occupation||null, p.residence||null, p.phone||null, p.photo_path||null, req.session.user.id, now(), id);
      // ensure users table reflects username change: if username set, link user
      if (p.username){ await tx.prepare('UPDATE users SET person_id = ? WHERE username = ?').run(id, p.username); }
      if (p.new_password){
        if (String(p.new_password).length < 4) throw new Error('New password is too short.');
        await tx.prepare('UPDATE users SET password_hash = ? WHERE person_id = ?').run(bcrypt.hashSync(p.new_password, 10), id);
      }
      if (Array.isArray(p.relations)) await applyParentEdits(tx, id, p.relations, req.session.user.id);
    });
    res.json({ ok:true });
  }catch(err){ console.error('Update person error', err && err.stack || err); res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
}));

// admin: current father/mother of a person, for prefilling the relationship editor when
// modifying an already-approved account (the "Modify account" flow doesn't otherwise know
// who their parents currently are)
router.get('/admin/people/:id/parents', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const { fatherId, motherId } = await getParentIds(db, req.params.id);
  async function withNote(parentId){
    if (!parentId) return null;
    const person = await db.prepare('SELECT * FROM people WHERE id = ?').get(parentId);
    if (!person) return null;
    const rel = await db.prepare("SELECT notes FROM relationships WHERE person_id = ? AND relative_id = ? AND type = 'parent'").get(req.params.id, parentId);
    return Object.assign({}, person, { from_family: !rel || rel.notes !== 'married-in' });
  }
  res.json({ father: await withNote(fatherId), mother: await withNote(motherId) });
}));

// Admin: update person with multipart (photo). Also handles new_password, same as above.
router.post('/admin/people/:id/update-multipart', upload.single('photo'), wrap(async (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  const body = req.body || {};
  const current = await db.prepare('SELECT photo_path FROM people WHERE id = ?').get(id);
  const payload = {
    username: body.username || null,
    full_name: body.full_name || null,
    gender: body.gender || null,
    birth_year: body.birth_year ? Number(body.birth_year) : null,
    birth_date: body.birth_date || null,
    death_date: body.death_date || null,
    occupation: body.occupation || null,
    residence: body.residence || null,
    phone: body.phone || null,
    // keep the existing photo unless a new one was uploaded with this edit
    photo_path: current ? current.photo_path : null
  };
  if (req.file) payload.photo_path = await uploadPhoto(req.file, 'photos');
  // undefined (not []) when the client omits this field entirely — see the relationsLoaded
  // guard in admin.html: relations are only ever submitted after successfully fetching the
  // person's current father/mother, so a missing key here means "don't touch relations",
  // never "the admin removed both parents"
  let relations;
  if (body.relations){ try{ relations = JSON.parse(body.relations); }catch(e){ relations = undefined; } }
  try{
    await db.transaction(async (tx) => {
      await tx.prepare('UPDATE people SET username = ?, full_name = ?, gender = ?, birth_year = ?, birth_date = ?, death_date = ?, occupation = ?, residence = ?, phone = ?, photo_path = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?')
        .run(payload.username||null, payload.full_name||null, payload.gender||null, payload.birth_year||null, payload.birth_date||null, payload.death_date||null, payload.occupation||null, payload.residence||null, payload.phone||null, payload.photo_path||null, req.session.user.id, now(), id);
      if (payload.username){ await tx.prepare('UPDATE users SET person_id = ? WHERE username = ?').run(id, payload.username); }
      if (body.new_password){
        if (String(body.new_password).length < 4) throw new Error('New password is too short.');
        await tx.prepare('UPDATE users SET password_hash = ? WHERE person_id = ?').run(bcrypt.hashSync(body.new_password, 10), id);
      }
      if (Array.isArray(relations)) await applyParentEdits(tx, id, relations, req.session.user.id);
    });
    res.json({ ok:true });
  }catch(err){ console.error('Update person multipart error', err && err.stack || err); res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
}));

// Admin: delete person (soft-delete and cleanup relationships/users)
router.post('/admin/people/:id/delete', wrap(async (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  try{
    await db.transaction(async (tx) => {
      await tx.prepare('UPDATE people SET approval_status = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?').run('deleted', req.session.user.id, now(), id);
      await tx.prepare('UPDATE users SET person_id = NULL WHERE person_id = ?').run(id);
      await tx.prepare('DELETE FROM relationships WHERE person_id = ? OR relative_id = ?').run(id, id);
      // create a rejected request entry so the deleted account appears in Rejected tab for audit
      const rid = uuidv4();
      const payload = { type: 'delete_person', person_id: id, deleted_by: req.session.user.id, deleted_at: now() };
      await tx.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at, reviewed_by, reviewed_at, review_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(rid, 'delete_person', JSON.stringify(payload), 'rejected', req.session.user.id, now(), req.session.user.id, now(), 'deleted by admin');
    });
    res.json({ ok:true });
  }catch(err){ console.error('Delete person error', err && err.stack || err); res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
}));

// admin: create a person directly (already approved) — used e.g. to create the root/founder profile
router.post('/admin/people/create-direct', upload.single('photo'), wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const body = req.body || {};
  if (!body.full_name) return res.status(400).json({ error: 'full_name required' });
  try{
    const id = uuidv4();
    const photoPath = req.file ? await uploadPhoto(req.file, 'photos') : null;
    let birthDate = body.birth_date || null;
    let birthYear = body.birth_year ? Number(body.birth_year) : null;
    if (birthDate && !birthYear){ const d = new Date(birthDate); if (isFinite(d)) birthYear = d.getFullYear(); }
    await db.prepare('INSERT INTO people (id, username, full_name, gender, birth_year, birth_date, death_date, occupation, residence, phone, photo_path, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, null, body.full_name, body.gender||null, birthYear, birthDate, body.death_date||null, body.occupation||null, body.residence||null, body.phone||null, photoPath, req.session.user.id, now(), 'approved');
    if (body.set_as_root === 'on' || body.set_as_root === 'true'){ await setSetting('root_person_id', id); }
    const person = await db.prepare('SELECT * FROM people WHERE id = ?').get(id);
    res.json({ ok:true, person });
  }catch(err){ console.error('create-direct error', err && err.stack || err); res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
}));

// admin: get/set the family tree root profile
router.get('/admin/root', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const rid = await getSetting('root_person_id');
  const person = rid ? await db.prepare('SELECT * FROM people WHERE id = ?').get(rid) : null;
  res.json({ root: person || null });
}));

router.post('/admin/root', express.json(), wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const personId = req.body && req.body.person_id;
  if (!personId) return res.status(400).json({ error: 'missing person_id' });
  const p = await db.prepare('SELECT id FROM people WHERE id = ?').get(personId);
  if (!p) return res.status(404).json({ error: 'person not found' });
  await setSetting('root_person_id', personId);
  res.json({ ok:true });
}));

// public: the current root profile, so the tree page knows where to anchor the layout
router.get('/tree/root', wrap(async (req,res)=>{
  const rid = await getSetting('root_person_id');
  if (!rid) return res.json({ root: null });
  const p = await db.prepare("SELECT * FROM people WHERE id = ? AND approval_status = 'approved'").get(rid);
  res.json({ root: p || null });
}));

// simple stats for admin
router.get('/admin/stats', wrap(async (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const total = (await db.prepare("SELECT COUNT(1) as c FROM people WHERE approval_status = 'approved'").get()).c;
  const male = (await db.prepare("SELECT COUNT(1) as c FROM people WHERE approval_status = 'approved' AND lower(gender) = 'male'").get()).c;
  const female = (await db.prepare("SELECT COUNT(1) as c FROM people WHERE approval_status = 'approved' AND lower(gender) = 'female'").get()).c;
  const deceased = (await db.prepare("SELECT COUNT(1) as c FROM people WHERE approval_status = 'approved' AND death_date IS NOT NULL").get()).c;
  res.json({ total, male, female, deceased });
}));

// full tree: return all approved people and all relationships between approved people
router.get('/tree/full', wrap(async (req,res)=>{
  const nodes = await db.prepare("SELECT * FROM people WHERE approval_status = 'approved'").all();
  const nodeIds = new Set(nodes.map(n=>n.id));
  const raw = await db.prepare('SELECT person_id, relative_id, type FROM relationships').all();
  const edges = raw.filter(r=> nodeIds.has(r.person_id) && nodeIds.has(r.relative_id)).map(r=> ({ from: r.person_id, to: r.relative_id, type: r.type }));
  res.json({ nodes, edges });
}));

// tree endpoint: return nodes and edges around a starting person id
router.get('/tree/:id', wrap(async (req,res)=>{
  const start = req.params.id;
  const maxDepth = parseInt(req.query.depth||3);
  // gather nodes via BFS for ancestors and descendants
  const nodesSet = new Set();
  const edges = [];

  nodesSet.add(start);

  // ancestors
  let current = [start];
  for (let d=0; d<maxDepth; d++){
    const next = [];
    for (const pid of current){
      const parents = (await db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'parent'").all(pid)).map(r=>r.relative_id);
      for (const p of parents){
        if (!nodesSet.has(p)){
          nodesSet.add(p);
          next.push(p);
        }
        edges.push({ from: p, to: pid, type: 'parent' });
      }
      // also include spouses of these parents
      for (const p of parents){
        const spouses = (await db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'spouse'").all(p)).map(r=>r.relative_id);
        for (const s of spouses){ if (!nodesSet.has(s)){ nodesSet.add(s); } edges.push({ from: p, to: s, type: 'spouse' }); }
      }
      // include siblings: other children of these parents
      for (const p of parents){
        const childrenOfParent = (await db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'child'").all(p)).map(r=>r.relative_id);
        for (const sib of childrenOfParent){ if (!nodesSet.has(sib)){ nodesSet.add(sib); next.push(sib); } edges.push({ from: p, to: sib, type: 'parent' }); }
      }
    }
    current = next;
    if (current.length===0) break;
  }

  // descendants
  current = [start];
  for (let d=0; d<maxDepth; d++){
    const next = [];
    for (const pid of current){
      const childs = (await db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'child'").all(pid)).map(r=>r.relative_id);
      for (const c of childs){
        if (!nodesSet.has(c)){ nodesSet.add(c); next.push(c); }
        edges.push({ from: pid, to: c, type: 'parent' });
      }
      // spouses of children
      for (const c of childs){
        const spouses = (await db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'spouse'").all(c)).map(r=>r.relative_id);
        for (const s of spouses){ if (!nodesSet.has(s)){ nodesSet.add(s); } edges.push({ from: c, to: s, type: 'spouse' }); }
      }
    }
    current = next;
    if (current.length===0) break;
  }

  // finally, fetch node records
  const ids = Array.from(nodesSet);
  let nodes = [];
  if (ids.length>0){
    const q = 'SELECT * FROM people WHERE id IN (' + ids.map(()=>'?').join(',') + ')';
    nodes = await db.prepare(q).all(...ids);
  }

  res.json({ nodes, edges });
}));

// --- Family archive: member-submitted photo/audio/video-link posts, admin-approved ---

function extractYouTubeId(url){
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// a photo post's file_path holds a JSON-encoded array of Blob URLs (supports multiple
// photos per post); older rows created before that change hold a single plain URL string,
// so this normalizes either shape into an array.
function parsePhotoPaths(filePath){
  if (!filePath) return [];
  try{
    const parsed = JSON.parse(filePath);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  }catch(e){
    return [filePath];
  }
}

async function withPosterInfo(row){
  const person = row.person_id ? await db.prepare('SELECT full_name FROM people WHERE id = ?').get(row.person_id) : null;
  const out = { ...row, posted_by_name: person ? person.full_name : null, youtube_id: row.type === 'video' ? extractYouTubeId(row.url) : null };
  if (row.type === 'photo') out.file_paths = parsePhotoPaths(row.file_path);
  return out;
}

// token-exchange handshake for archive audio's client-direct-to-Blob upload — bypasses
// the platform's 4.5MB serverless request-body ceiling entirely (voice memos/song clips
// routinely exceed that). Photos and videos don't need this: photos stay comfortably under
// the multer fileSize limit, and video posts store a YouTube link, not a file.
router.post('/archive/upload-token', express.json(), wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const jsonResponse = await handleUpload({
    body: req.body,
    request: req,
    onBeforeGenerateToken: async () => ({
      allowedContentTypes: ['audio/mpeg','audio/mp4','audio/wav','audio/webm','audio/ogg','audio/x-m4a','audio/aac'],
      addRandomSuffix: true,
      tokenPayload: JSON.stringify({ personId: req.session.user.person_id }),
    }),
    onUploadCompleted: async () => {},
  });
  res.json(jsonResponse);
}));

// submit a pending photo / audio / YouTube-link post. Photos may include multiple files in
// one post (e.g. several shots from one family gathering) instead of forcing one post per
// photo.
router.post('/archive', upload.array('files', 10), wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const body = req.body || {};
  const type = body.type;
  if (!['photo','audio','video'].includes(type)) return res.status(400).json({ error: 'invalid type' });

  let filePath = null, url = null;
  if (type === 'video'){
    if (!body.url) return res.status(400).json({ error: 'A YouTube link is required.' });
    if (!extractYouTubeId(body.url)) return res.status(400).json({ error: "That doesn't look like a valid YouTube link." });
    url = body.url;
  } else if (type === 'audio'){
    // already uploaded directly to Blob by the browser — see POST /archive/upload-token
    if (!body.file_url) return res.status(400).json({ error: 'An audio file is required.' });
    filePath = body.file_url;
  } else {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'At least one photo is required.' });
    const urls = await Promise.all(req.files.map(f => uploadPhoto(f, 'archive')));
    filePath = JSON.stringify(urls);
  }

  const id = uuidv4();
  await db.prepare('INSERT INTO archive (id, title, url, description, file_path, type, person_id, created_by, created_at, approval_status, event_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, null, url, body.description || null, filePath, type, req.session.user.person_id, req.session.user.id, now(), 'pending', body.event_type || null);
  res.json({ ok:true, id });
}));

// owner-only: edit an existing post's caption/event type (and, for photo/audio, optionally
// replace the file(s); for video, optionally replace the link) and send it back through
// admin review — the type itself can't change. File replacement follows the same paths as
// creating a post: photo goes through this server-routed upload (replacing the whole photo
// set if any new files are given), audio was already uploaded directly to Blob by the
// browser (file_url in the body), video re-validates the YouTube link.
router.post('/archive/:id/edit', upload.array('files', 10), wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const id = req.params.id;
  const row = await db.prepare('SELECT * FROM archive WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.person_id !== req.session.user.person_id) return res.status(403).json({ error: 'forbidden' });

  const body = req.body || {};
  let filePath = row.file_path, url = row.url;
  if (row.type === 'video'){
    if (body.url) {
      if (!extractYouTubeId(body.url)) return res.status(400).json({ error: "That doesn't look like a valid YouTube link." });
      url = body.url;
    }
  } else if (row.type === 'audio'){
    if (body.file_url) filePath = body.file_url;
  } else if (row.type === 'photo'){
    if (req.files && req.files.length){
      const urls = await Promise.all(req.files.map(f => uploadPhoto(f, 'archive')));
      filePath = JSON.stringify(urls);
    }
  }

  await db.prepare("UPDATE archive SET description = ?, url = ?, file_path = ?, event_type = ?, approval_status = 'pending', reviewed_by = NULL, reviewed_at = NULL WHERE id = ?")
    .run(body.description || null, url, filePath, body.event_type || row.event_type || null, id);
  res.json({ ok:true });
}));

// approved posts for members to browse, one type at a time — optionally filtered to a
// single event type (e.g. "marriage"); omit/pass "all" to see everything of that type
router.get('/archive', wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const type = req.query.type;
  if (!['photo','audio','video'].includes(type)) return res.status(400).json({ error: 'invalid type' });
  const eventType = req.query.event_type && req.query.event_type !== 'all' ? req.query.event_type : null;
  const rows = eventType
    ? await db.prepare("SELECT * FROM archive WHERE type = ? AND approval_status = 'approved' AND event_type = ? ORDER BY created_at DESC").all(type, eventType)
    : await db.prepare("SELECT * FROM archive WHERE type = ? AND approval_status = 'approved' ORDER BY created_at DESC").all(type);
  res.json(await Promise.all(rows.map(withPosterInfo)));
}));

// admin: list archive submissions by status
router.get('/admin/archive', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const status = (req.query.status || 'pending').toLowerCase();
  if (!['pending','approved','rejected'].includes(status)) return res.status(400).json({ error: 'invalid status' });
  const rows = await db.prepare('SELECT * FROM archive WHERE approval_status = ? ORDER BY created_at DESC').all(status);
  res.json(await Promise.all(rows.map(withPosterInfo)));
}));

router.post('/admin/archive/:id/approve', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const row = await db.prepare('SELECT id FROM archive WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  await db.prepare("UPDATE archive SET approval_status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(req.session.user.id, now(), req.params.id);
  res.json({ ok:true });
}));

router.post('/admin/archive/:id/reject', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const row = await db.prepare('SELECT id FROM archive WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  await db.prepare("UPDATE archive SET approval_status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(req.session.user.id, now(), req.params.id);
  res.json({ ok:true });
}));

// admin: permanently delete a post, even one that was already approved
router.post('/admin/archive/:id/delete', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const row = await db.prepare('SELECT id FROM archive WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  await db.prepare('DELETE FROM archive WHERE id = ?').run(req.params.id);
  res.json({ ok:true });
}));

module.exports = router;
