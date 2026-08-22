const express = require('express');
const router = express.Router();
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const upload = multer({ dest: path.join(__dirname, 'uploads') });

function now(){ return new Date().toISOString(); }

// helper: normalize name for tolerant matching
function normalizeName(s){ return (s||'').trim().toLowerCase().replace(/\s+/g,' '); }

// settings key/value helpers (used for e.g. the family tree root profile)
function getSetting(key){ const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return row ? row.value : null; }
function setSetting(key, value){ db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }

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

function isUsernameTaken(username){
  if (!username) return false;
  if (db.prepare('SELECT id FROM people WHERE username = ?').get(username)) return true;
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return true;
  const pending = db.prepare("SELECT payload FROM requests WHERE status = 'pending'").all();
  return pending.some(r=>{ try{ return JSON.parse(r.payload).username === username; }catch(e){ return false; } });
}

// this person's father/mother, classified by gender among their recorded parents
function getParentIds(personId){
  const rows = db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'parent'").all(personId);
  let fatherId = null, motherId = null;
  rows.forEach(r=>{
    const p = db.prepare('SELECT gender FROM people WHERE id = ?').get(r.relative_id);
    const g = ((p && p.gender) || '').toLowerCase();
    if (g === 'male' && !fatherId) fatherId = r.relative_id;
    else if (g === 'female' && !motherId) motherId = r.relative_id;
  });
  return { fatherId, motherId };
}

function getSpouseIds(personId){
  return db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'spouse'").all(personId).map(r=>r.relative_id);
}

// Login by username + password — used for both members and admins. Username is each
// person's unique login id (assigned at registration, or by an admin for accounts they
// create directly).
function handleLogin(req, res){
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid' });
  req.session.user = { id: user.id, role: user.role, person_id: user.person_id };
  return res.json({ ok:true, role: user.role, person_id: user.person_id });
}
router.post('/auth/login', handleLogin);
// kept as an alias so the existing admin-login page keeps working unchanged
router.post('/auth/admin-login', handleLogin);

router.post('/auth/logout',(req,res)=>{ req.session.destroy(()=>res.json({ok:true})); });

// get current session
router.get('/auth/me',(req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(req.session.user.person_id);
  res.json({ user: req.session.user, person });
});

// list approved people
router.get('/people', (req,res)=>{
  const rows = db.prepare("SELECT * FROM people WHERE approval_status = 'approved'").all();
  res.json(rows);
});

// search approved people by (partial) name — used to match parents typed during registration
router.get('/people/search', (req,res)=>{
  const q = normalizeName(req.query.name || req.query.q || '');
  if (!q) return res.json([]);
  const rows = db.prepare("SELECT * FROM people WHERE approval_status = 'approved'").all();
  const matches = rows.filter(p => normalizeName(p.full_name).includes(q));
  res.json(matches.slice(0, 20));
});

// get a single person
router.get('/people/:id', (req,res)=>{
  const p = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({error:'not found'});
  res.json(p);
});

// create request (generic pending change)
router.post('/requests', upload.single('photo'), (req,res)=>{
  const payload = req.body;
  if (req.file) payload.photo_path = '/uploads/' + path.basename(req.file.path);
  const id = uuidv4();
  db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, payload.type || 'create_person', JSON.stringify(payload), 'pending', req.session.user?req.session.user.id:'anonymous', now());
  res.json({ok:true, id});
});

// self-registration: creates a pending create_person request
router.post('/auth/register', upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'father_photo', maxCount: 1 },
  { name: 'mother_photo', maxCount: 1 }
]), (req,res)=>{
  const body = req.body || {};
  const files = req.files || {};

  // username/password are mandatory — the username becomes this person's unique login id.
  if (!body.username || !body.password) return res.status(400).json({ error: 'Username and password are required.' });
  if (isUsernameTaken(body.username)) return res.status(409).json({ error: 'That username is already taken. Please choose another.' });

  if (files.photo && files.photo[0]) body.photo_path = '/uploads/' + path.basename(files.photo[0].path);
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
        photo_path: files.father_photo && files.father_photo[0] ? '/uploads/' + path.basename(files.father_photo[0].path) : null
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
        photo_path: files.mother_photo && files.mother_photo[0] ? '/uploads/' + path.basename(files.mother_photo[0].path) : null
      }
    });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'create_person', JSON.stringify(payload), 'pending', 'self-register', now());
  res.json({ ok:true, id });
});

// admin: list requests (status can be pending|approved|rejected)
router.get('/admin/requests', (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const status = (req.query.status || 'pending').toLowerCase();
  if (!['pending','approved','rejected'].includes(status)) return res.status(400).json({error:'invalid status'});
  const rows = db.prepare('SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC').all(status);
  res.json(rows.map(r=> ({...r, payload: JSON.parse(r.payload)})));
});

// --- shared person/relationship helpers, used by request-approval processors below ---

function createPersonRecord(p, reviewerId){
  // if username provided and a person already exists with that username, reuse it
  if (p.username){
    const existing = db.prepare('SELECT id FROM people WHERE username = ?').get(p.username);
    if (existing && existing.id) return existing.id;
  }
  const id = uuidv4();
  // Use INSERT OR IGNORE to avoid unique constraint errors; then select the inserted row or fallback to an existing row
  db.prepare('INSERT OR IGNORE INTO people (id, username, full_name, gender, birth_year, birth_date, occupation, residence, phone, photo_path, family_head, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, p.username||null, p.full_name, p.gender||null, p.birth_year||null, p.birth_date||null, p.occupation||null, p.residence||null, p.phone||null, p.photo_path||null, p.family_head||null, reviewerId, now(), 'approved');
  if (p.username){
    const existingByUser = db.prepare('SELECT id FROM people WHERE username = ?').get(p.username);
    if (existingByUser && existingByUser.id) return existingByUser.id;
  }
  // otherwise try to find by full_name + birth_date (if available)
  if (p.full_name && p.birth_date){
    const existingByName = db.prepare('SELECT id FROM people WHERE full_name = ? AND birth_date = ?').get(p.full_name, p.birth_date);
    if (existingByName && existingByName.id) return existingByName.id;
  }
  // fallback to the id we attempted to insert
  return id;
}

function linkParentChild(childId, parentId, note){
  const existing = db.prepare("SELECT id FROM relationships WHERE person_id = ? AND relative_id = ? AND type = 'parent'").get(childId, parentId);
  if (existing) return;
  const ins = db.prepare('INSERT INTO relationships (id, person_id, relative_id, type, notes) VALUES (?, ?, ?, ?, ?)');
  ins.run(uuidv4(), childId, parentId, 'parent', note || null);
  ins.run(uuidv4(), parentId, childId, 'child', note || null);
}

function linkSpouse(a,b){
  // avoid duplicate spouse links (e.g. both parents already matched to existing profiles)
  const existing = db.prepare("SELECT id FROM relationships WHERE person_id = ? AND relative_id = ? AND type = 'spouse'").get(a,b);
  if (existing) return;
  const ins = db.prepare('INSERT INTO relationships (id, person_id, relative_id, type) VALUES (?, ?, ?, ?)');
  ins.run(uuidv4(), a, b, 'spouse');
  ins.run(uuidv4(), b, a, 'spouse');
}

// used only when two siblings share no recorded parent yet, so there's no shared-parent
// link to hang the relationship off of
function linkSibling(a,b){
  const existing = db.prepare("SELECT id FROM relationships WHERE person_id = ? AND relative_id = ? AND type = 'sibling'").get(a,b);
  if (existing) return;
  const ins = db.prepare('INSERT INTO relationships (id, person_id, relative_id, type) VALUES (?, ?, ?, ?)');
  ins.run(uuidv4(), a, b, 'sibling');
  ins.run(uuidv4(), b, a, 'sibling');
}

function createLoginForPerson(personId, username, password){
  if (!username || !password) return;
  const pwdHash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT OR IGNORE INTO users (id, username, password_hash, role, person_id) VALUES (?, ?, ?, ?, ?)').run(uuidv4(), username, pwdHash, 'member', personId);
  db.prepare('UPDATE users SET person_id = ? WHERE username = ?').run(personId, username);
}

// helper to process create_person payload into the DB and return the created person id
function processCreatePerson(payload, reviewerId){
  const personId = createPersonRecord(payload, reviewerId);
  createLoginForPerson(personId, payload.username, payload.password);

  if (Array.isArray(payload.relations)){
    const father = payload.relations.find(r=> r.type==='parent' && r.which==='father');
    const mother = payload.relations.find(r=> r.type==='parent' && r.which==='mother');

    let fatherId = null, motherId = null;
    if (father){
      fatherId = father.relative_id;
      if (!fatherId){
        const frel = father.relative || {};
        fatherId = createPersonRecord({ full_name: frel.full_name || 'Unknown', birth_year: frel.birth_year||null, birth_date: frel.birth_date||null, gender: 'male', occupation: frel.occupation||null, residence: frel.residence||null, phone: frel.phone||null, photo_path: frel.photo_path||null }, reviewerId);
      }
      linkParentChild(personId, fatherId, father.from_family ? 'blood' : 'married-in');
    }
    if (mother){
      motherId = mother.relative_id;
      if (!motherId){
        const mrel = mother.relative || {};
        motherId = createPersonRecord({ full_name: mrel.full_name || 'Unknown', birth_year: mrel.birth_year||null, birth_date: mrel.birth_date||null, gender: 'female', occupation: mrel.occupation||null, residence: mrel.residence||null, phone: mrel.phone||null, photo_path: mrel.photo_path||null }, reviewerId);
      }
      linkParentChild(personId, motherId, mother.from_family ? 'blood' : 'married-in');
    }
    if (fatherId && motherId) linkSpouse(fatherId, motherId);
  }

  return personId;
}

// apply an approved self-edit to the person's own record, keeping their existing photo
// unless a new one was uploaded with the request
function processUpdatePerson(payload, reviewerId){
  const current = db.prepare('SELECT * FROM people WHERE id = ?').get(payload.person_id);
  if (!current) return;
  const photoPath = payload.photo_path || current.photo_path;
  db.prepare('UPDATE people SET full_name = ?, gender = ?, birth_year = ?, birth_date = ?, occupation = ?, residence = ?, phone = ?, photo_path = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?')
    .run(payload.full_name || current.full_name, payload.gender || current.gender, payload.birth_year || null, payload.birth_date || null, payload.occupation || null, payload.residence || null, payload.phone || null, photoPath, reviewerId, now(), current.id);
}

// approve a member-submitted "add spouse/child/sibling" request: link to an existing
// matched profile, or create the new person (with their own login, if provided) and link
function processAddRelative(payload, reviewerId){
  const requesterId = payload.requester_person_id;
  let relativeId = payload.matched_person_id;
  if (!relativeId){
    relativeId = createPersonRecord({
      full_name: payload.full_name, gender: payload.gender || null, birth_year: payload.birth_year || null,
      birth_date: payload.birth_date || null, occupation: payload.occupation || null, residence: payload.residence || null,
      phone: payload.phone || null, photo_path: payload.photo_path || null, username: payload.username || null
    }, reviewerId);
    createLoginForPerson(relativeId, payload.username, payload.password);
  }

  if (payload.relation === 'spouse'){
    linkSpouse(requesterId, relativeId);
  } else if (payload.relation === 'child'){
    linkParentChild(relativeId, requesterId, 'blood');
    if (payload.other_parent_id){
      const validSpouse = db.prepare("SELECT id FROM relationships WHERE person_id = ? AND relative_id = ? AND type = 'spouse'").get(requesterId, payload.other_parent_id);
      if (validSpouse) linkParentChild(relativeId, payload.other_parent_id, 'blood');
    }
  } else if (payload.relation === 'sibling'){
    const { fatherId, motherId } = getParentIds(requesterId);
    let linked = false;
    if (fatherId && payload.link_via_father !== false){ linkParentChild(relativeId, fatherId, 'blood'); linked = true; }
    if (motherId && payload.link_via_mother !== false){ linkParentChild(relativeId, motherId, 'blood'); linked = true; }
    if (!linked) linkSibling(requesterId, relativeId);
  }

  return relativeId;
}

router.post('/admin/requests/:id/approve', (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const id = req.params.id;
  const reqRow = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!reqRow) return res.status(404).json({error:'not found'});
  const payload = JSON.parse(reqRow.payload);
  try{
    if (payload.type==='create_person' || payload.type==='create'){
      processCreatePerson(payload, req.session.user.id);
    } else if (payload.type==='update_person'){
      processUpdatePerson(payload, req.session.user.id);
    } else if (payload.type==='add_relative'){
      processAddRelative(payload, req.session.user.id);
    }
    db.prepare('UPDATE requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run('approved', req.session.user.id, now(), id);
    res.json({ok:true});
  }catch(err){
    console.error('Approve error', err && err.stack || err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// --- member self-service: edit own profile, change password, add a relative ---

router.get('/member/context', (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const id = req.session.user.person_id;
  const spouses = getSpouseIds(id).map(sid=> db.prepare('SELECT id, full_name FROM people WHERE id = ?').get(sid)).filter(Boolean);
  const { fatherId, motherId } = getParentIds(id);
  const father = fatherId ? db.prepare('SELECT id, full_name FROM people WHERE id = ?').get(fatherId) : null;
  const mother = motherId ? db.prepare('SELECT id, full_name FROM people WHERE id = ?').get(motherId) : null;
  res.json({ spouses, father, mother });
});

// submit a pending request to change one's own profile fields (photo, name, DOB, etc.)
router.post('/member/profile/update', upload.single('photo'), (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const body = req.body || {};
  const personId = req.session.user.person_id;
  const current = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
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
    occupation: body.occupation || null,
    residence: body.residence || null,
    phone: body.phone || null,
    photo_path: req.file ? '/uploads/' + path.basename(req.file.path) : null
  };
  const id = uuidv4();
  db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'update_person', JSON.stringify(payload), 'pending', req.session.user.id, now());
  res.json({ ok:true, id });
});

// change one's own password immediately — a security setting, not tree data, so it
// doesn't go through admin review
router.post('/member/password', express.json(), (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password are required.' });
  if (String(new_password).length < 4) return res.status(400).json({ error: 'New password is too short.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user) return res.status(404).json({ error: 'account not found' });
  if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), user.id);
  res.json({ ok:true });
});

// submit a pending request to add a spouse, child, or sibling — either linked to an
// existing matched profile, or a brand-new one (with its own login) for admin to approve
router.post('/member/relatives/add', upload.single('photo'), (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const body = req.body || {};
  const requesterId = req.session.user.person_id;
  const requester = db.prepare('SELECT * FROM people WHERE id = ?').get(requesterId);
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
    if (!body.username || !body.password) return res.status(400).json({ error: 'Username and password are required for the new profile.' });
    if (isUsernameTaken(body.username)) return res.status(409).json({ error: 'That username is already taken. Please choose another.' });

    let birthDate = body.birth_date || null;
    let birthYear = null;
    if (birthDate){ try{ const d = new Date(birthDate); if (isFinite(d)) birthYear = d.getFullYear(); else birthDate = null; }catch(e){ birthDate = null; } }

    payload.full_name = body.full_name;
    payload.gender = body.gender || null;
    payload.birth_date = birthDate;
    payload.birth_year = birthYear;
    payload.occupation = body.occupation || null;
    payload.residence = body.residence || null;
    payload.phone = body.phone || null;
    payload.photo_path = req.file ? '/uploads/' + path.basename(req.file.path) : null;
    payload.username = body.username;
    payload.password = body.password;
  }

  if (body.relation === 'child' && body.other_parent_id) payload.other_parent_id = body.other_parent_id;
  if (body.relation === 'sibling'){
    payload.link_via_father = body.link_via_father !== 'false';
    payload.link_via_mother = body.link_via_mother !== 'false';
  }

  const id = uuidv4();
  db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'add_relative', JSON.stringify(payload), 'pending', req.session.user.id, now());
  res.json({ ok:true, id });
});

// admin: reject request
router.post('/admin/requests/:id/reject', express.json(), (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  const note = req.body && req.body.note ? String(req.body.note) : null;
  const reqRow = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!reqRow) return res.status(404).json({error:'not found'});
  db.prepare('UPDATE requests SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?').run('rejected', req.session.user.id, now(), note, id);
  res.json({ ok:true });
});

// admin: edit payload then approve
router.post('/admin/requests/:id/edit-approve', express.json(), (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  const newPayload = req.body && req.body.payload ? req.body.payload : null;
  const reqRow = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!reqRow) return res.status(404).json({error:'not found'});
  if (!newPayload) return res.status(400).json({error:'missing payload'});
  try{
    db.prepare('UPDATE requests SET payload = ? WHERE id = ?').run(JSON.stringify(newPayload), id);
    if (newPayload.type==='create_person' || newPayload.type==='create'){
      processCreatePerson(newPayload, req.session.user.id);
    }
    db.prepare('UPDATE requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run('approved', req.session.user.id, now(), id);
    res.json({ ok:true });
  }catch(err){
    console.error('Edit-approve error', err && err.stack || err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// Accept multipart edit+photo then approve
router.post('/admin/requests/:id/edit-approve-multipart', upload.single('photo'), (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  const reqRow = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!reqRow) return res.status(404).json({error:'not found'});

  const body = req.body || {};
  const payload = {
    type: body.type || 'create_person',
    username: body.username || null,
    password: null,
    full_name: body.full_name || null,
    gender: body.gender || null,
    birth_year: body.birth_year ? Number(body.birth_year) : (body.birth_year === '' ? null : null),
    birth_date: body.birth_date || null,
    occupation: body.occupation || null,
    residence: body.residence || null,
    phone: body.phone || null,
    photo_path: null,
    relations: []
  };
  if (req.file) payload.photo_path = '/uploads/' + path.basename(req.file.path);

  // relations: expected as JSON string in body.relations
  if (body.relations){
    try{ payload.relations = JSON.parse(body.relations); }catch(e){ payload.relations = []; }
  }

  try{
    // update request payload and approve
    db.prepare('UPDATE requests SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id);
    if (payload.type==='create_person' || payload.type==='create'){
      processCreatePerson(payload, req.session.user.id);
    }
    db.prepare("UPDATE requests SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(req.session.user.id, now(), id);
    res.json({ ok:true });
  }catch(err){
    console.error('Edit-approve-multipart error', err && err.stack || err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// Admin: update an existing person (JSON)
router.post('/admin/people/:id/update', express.json(), (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  const p = req.body && req.body.payload ? req.body.payload : req.body;
  if (!p) return res.status(400).json({error:'missing payload'});
  try{
    db.prepare('UPDATE people SET username = ?, full_name = ?, gender = ?, birth_year = ?, birth_date = ?, occupation = ?, residence = ?, phone = ?, photo_path = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?')
      .run(p.username||null, p.full_name||null, p.gender||null, p.birth_year||null, p.birth_date||null, p.occupation||null, p.residence||null, p.phone||null, p.photo_path||null, req.session.user.id, now(), id);
    // ensure users table reflects username change: if username set, link user
    if (p.username){ db.prepare('UPDATE users SET person_id = ? WHERE username = ?').run(id, p.username); }
    res.json({ ok:true });
  }catch(err){ console.error('Update person error', err && err.stack || err); res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
});

// Admin: update person with multipart (photo)
router.post('/admin/people/:id/update-multipart', upload.single('photo'), (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  const body = req.body || {};
  const current = db.prepare('SELECT photo_path FROM people WHERE id = ?').get(id);
  const payload = {
    username: body.username || null,
    full_name: body.full_name || null,
    gender: body.gender || null,
    birth_year: body.birth_year ? Number(body.birth_year) : (body.birth_year === '' ? null : null),
    birth_date: body.birth_date || null,
    occupation: body.occupation || null,
    residence: body.residence || null,
    phone: body.phone || null,
    // keep the existing photo unless a new one was uploaded with this edit
    photo_path: current ? current.photo_path : null
  };
  if (req.file) payload.photo_path = '/uploads/' + path.basename(req.file.path);
  try{
    db.prepare('UPDATE people SET username = ?, full_name = ?, gender = ?, birth_year = ?, birth_date = ?, occupation = ?, residence = ?, phone = ?, photo_path = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?')
      .run(payload.username||null, payload.full_name||null, payload.gender||null, payload.birth_year||null, payload.birth_date||null, payload.occupation||null, payload.residence||null, payload.phone||null, payload.photo_path||null, req.session.user.id, now(), id);
    if (payload.username){ db.prepare('UPDATE users SET person_id = ? WHERE username = ?').run(id, payload.username); }
    res.json({ ok:true });
  }catch(err){ console.error('Update person multipart error', err && err.stack || err); res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
});

// Admin: delete person (soft-delete and cleanup relationships/users)
router.post('/admin/people/:id/delete', (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  try{
    db.prepare('UPDATE people SET approval_status = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?').run('deleted', req.session.user.id, now(), id);
    db.prepare('UPDATE users SET person_id = NULL WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM relationships WHERE person_id = ? OR relative_id = ?').run(id, id);
    // create a rejected request entry so the deleted account appears in Rejected tab for audit
    const rid = uuidv4();
    const payload = { type: 'delete_person', person_id: id, deleted_by: req.session.user.id, deleted_at: now() };
    db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at, reviewed_by, reviewed_at, review_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(rid, 'delete_person', JSON.stringify(payload), 'rejected', req.session.user.id, now(), req.session.user.id, now(), 'deleted by admin');
    res.json({ ok:true });
  }catch(err){ console.error('Delete person error', err && err.stack || err); res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
});

// admin: create a person directly (already approved) — used e.g. to create the root/founder profile
router.post('/admin/people/create-direct', upload.single('photo'), (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const body = req.body || {};
  if (!body.full_name) return res.status(400).json({ error: 'full_name required' });
  try{
    const id = uuidv4();
    const photoPath = req.file ? '/uploads/' + path.basename(req.file.path) : null;
    let birthDate = body.birth_date || null;
    let birthYear = body.birth_year ? Number(body.birth_year) : null;
    if (birthDate && !birthYear){ const d = new Date(birthDate); if (isFinite(d)) birthYear = d.getFullYear(); }
    db.prepare('INSERT INTO people (id, username, full_name, gender, birth_year, birth_date, occupation, residence, phone, photo_path, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, null, body.full_name, body.gender||null, birthYear, birthDate, body.occupation||null, body.residence||null, body.phone||null, photoPath, req.session.user.id, now(), 'approved');
    if (body.set_as_root === 'on' || body.set_as_root === 'true'){ setSetting('root_person_id', id); }
    const person = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
    res.json({ ok:true, person });
  }catch(err){ console.error('create-direct error', err && err.stack || err); res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
});

// admin: get/set the family tree root profile
router.get('/admin/root', (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const rid = getSetting('root_person_id');
  const person = rid ? db.prepare('SELECT * FROM people WHERE id = ?').get(rid) : null;
  res.json({ root: person || null });
});

router.post('/admin/root', express.json(), (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const personId = req.body && req.body.person_id;
  if (!personId) return res.status(400).json({ error: 'missing person_id' });
  const p = db.prepare('SELECT id FROM people WHERE id = ?').get(personId);
  if (!p) return res.status(404).json({ error: 'person not found' });
  setSetting('root_person_id', personId);
  res.json({ ok:true });
});

// public: the current root profile, so the tree page knows where to anchor the layout
router.get('/tree/root', (req,res)=>{
  const rid = getSetting('root_person_id');
  if (!rid) return res.json({ root: null });
  const p = db.prepare("SELECT * FROM people WHERE id = ? AND approval_status = 'approved'").get(rid);
  res.json({ root: p || null });
});

// simple stats for admin
router.get('/admin/stats', (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const total = db.prepare("SELECT COUNT(1) as c FROM people WHERE approval_status = 'approved'").get().c;
  const male = db.prepare("SELECT COUNT(1) as c FROM people WHERE approval_status = 'approved' AND lower(gender) = 'male'").get().c;
  const female = db.prepare("SELECT COUNT(1) as c FROM people WHERE approval_status = 'approved' AND lower(gender) = 'female'").get().c;
  const deceased = db.prepare("SELECT COUNT(1) as c FROM people WHERE approval_status = 'approved' AND death_date IS NOT NULL").get().c;
  res.json({ total, male, female, deceased });
});

// full tree: return all approved people and all relationships between approved people
router.get('/tree/full', (req,res)=>{
  try{
    const nodes = db.prepare("SELECT * FROM people WHERE approval_status = 'approved'").all();
    console.log('[tree/full] approved count:', nodes.length, 'sample', nodes.slice(0,3).map(n=>n.full_name));
    const nodeIds = new Set(nodes.map(n=>n.id));
    const raw = db.prepare('SELECT person_id, relative_id, type FROM relationships').all();
    const edges = raw.filter(r=> nodeIds.has(r.person_id) && nodeIds.has(r.relative_id)).map(r=> ({ from: r.person_id, to: r.relative_id, type: r.type }));
    console.log('[tree/full] edges count:', edges.length);
    res.json({ nodes, edges });
  }catch(err){ console.error('tree/full error', err && err.stack || err); res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
});

// tree endpoint: return nodes and edges around a starting person id
router.get('/tree/:id', (req,res)=>{
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
      const parents = db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'parent'").all(pid).map(r=>r.relative_id);
      for (const p of parents){
        if (!nodesSet.has(p)){
          nodesSet.add(p);
          next.push(p);
        }
        edges.push({ from: p, to: pid, type: 'parent' });
      }
      // also include spouses of these parents
      for (const p of parents){
        const spouses = db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'spouse'").all(p).map(r=>r.relative_id);
        for (const s of spouses){ if (!nodesSet.has(s)){ nodesSet.add(s); } edges.push({ from: p, to: s, type: 'spouse' }); }
      }
      // include siblings: other children of these parents
      for (const p of parents){
        const childrenOfParent = db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'child'").all(p).map(r=>r.relative_id);
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
      const childs = db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'child'").all(pid).map(r=>r.relative_id);
      for (const c of childs){
        if (!nodesSet.has(c)){ nodesSet.add(c); next.push(c); }
        edges.push({ from: pid, to: c, type: 'parent' });
      }
      // spouses of children
      for (const c of childs){
        const spouses = db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'spouse'").all(c).map(r=>r.relative_id);
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
    nodes = db.prepare(q).all(...ids);
  }

  res.json({ nodes, edges });
});

// --- Family archive: member-submitted photo/audio/video-link posts, admin-approved ---

function extractYouTubeId(url){
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function withPosterInfo(row){
  const person = row.person_id ? db.prepare('SELECT full_name FROM people WHERE id = ?').get(row.person_id) : null;
  return { ...row, posted_by_name: person ? person.full_name : null, youtube_id: row.type === 'video' ? extractYouTubeId(row.url) : null };
}

// submit a pending photo / audio / YouTube-link post
router.post('/archive', upload.single('file'), (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const body = req.body || {};
  const type = body.type;
  if (!['photo','audio','video'].includes(type)) return res.status(400).json({ error: 'invalid type' });

  let filePath = null, url = null;
  if (type === 'video'){
    if (!body.url) return res.status(400).json({ error: 'A YouTube link is required.' });
    if (!extractYouTubeId(body.url)) return res.status(400).json({ error: "That doesn't look like a valid YouTube link." });
    url = body.url;
  } else {
    if (!req.file) return res.status(400).json({ error: type === 'photo' ? 'A photo file is required.' : 'An audio file is required.' });
    filePath = '/uploads/' + path.basename(req.file.path);
  }

  const id = uuidv4();
  db.prepare('INSERT INTO archive (id, title, url, description, file_path, type, person_id, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, null, url, body.description || null, filePath, type, req.session.user.person_id, req.session.user.id, now(), 'pending');
  res.json({ ok:true, id });
});

// approved posts for members to browse, one type at a time
router.get('/archive', (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const type = req.query.type;
  if (!['photo','audio','video'].includes(type)) return res.status(400).json({ error: 'invalid type' });
  const rows = db.prepare("SELECT * FROM archive WHERE type = ? AND approval_status = 'approved' ORDER BY created_at DESC").all(type);
  res.json(rows.map(withPosterInfo));
});

// admin: list archive submissions by status
router.get('/admin/archive', (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const status = (req.query.status || 'pending').toLowerCase();
  if (!['pending','approved','rejected'].includes(status)) return res.status(400).json({ error: 'invalid status' });
  const rows = db.prepare('SELECT * FROM archive WHERE approval_status = ? ORDER BY created_at DESC').all(status);
  res.json(rows.map(withPosterInfo));
});

router.post('/admin/archive/:id/approve', (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const row = db.prepare('SELECT id FROM archive WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE archive SET approval_status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(req.session.user.id, now(), req.params.id);
  res.json({ ok:true });
});

router.post('/admin/archive/:id/reject', (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const row = db.prepare('SELECT id FROM archive WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE archive SET approval_status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(req.session.user.id, now(), req.params.id);
  res.json({ ok:true });
});

module.exports = router;

// debug: expose DB file path when needed
try{
  router.get('/debug/dbfile', (req,res)=>{ res.json({ dbfile: require('./db').__dbfile || null }); });
}catch(e){ console.error('Could not add debug route', e); }
