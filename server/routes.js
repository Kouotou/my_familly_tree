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

// Public: login by full name + date of birth (ISO string or YYYY-MM-DD)
router.post('/auth/login-by-dob', (req,res)=>{
  const fullName = req.body.fullName || req.body.full_name || '';
  const birthDateRaw = req.body.birth_date || req.body.birthDate || req.body.birth || null;
  if (!fullName || !birthDateRaw) return res.status(400).json({error:'missing'});
  const norm = normalizeName(fullName);
  const people = db.prepare("SELECT * FROM people WHERE approval_status = 'approved'").all();

  // Normalize incoming date to YYYY-MM-DD when possible
  let inDate = null;
  try{ inDate = new Date(birthDateRaw); if (!isFinite(inDate)) inDate = null; }
  catch(e){ inDate = null; }
  const inYear = inDate ? inDate.getFullYear() : (String(birthDateRaw||'').slice(0,4) || null);

  const matches = people.filter(p=>{
    if (normalizeName(p.full_name)!==norm) return false;
    // if person has full birth_date stored, compare full date if provided, otherwise compare year
    if (p.birth_date){
      if (!inDate) return (String(p.birth_year)===String(inYear));
      const pd = new Date(p.birth_date);
      return pd.toISOString().slice(0,10) === inDate.toISOString().slice(0,10);
    }
    // fallback to birth_year
    return String(p.birth_year)===String(inYear);
  });

  if (matches.length===1){
    req.session.user = { id: matches[0].id, role: 'member', person_id: matches[0].id };
    return res.json({ ok:true, person: matches[0] });
  }
  return res.status(404).json({ error: 'no matching profile' });
});

// Admin login username/password
router.post('/auth/admin-login', (req,res)=>{
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid' });
  req.session.user = { id: user.id, role: user.role, person_id: user.person_id };
  return res.json({ ok:true, role: user.role });
});

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

// helper to process create_person payload into the DB and return the created person id
function processCreatePerson(payload, reviewerId){
  function createPerson(p){
    // if username provided and a person already exists with that username, reuse it
    if (p.username){
      const existing = db.prepare('SELECT id FROM people WHERE username = ?').get(p.username);
      if (existing && existing.id) return existing.id;
    }
    const id = uuidv4();
    // Use INSERT OR IGNORE to avoid unique constraint errors; then select the inserted row or fallback to an existing row
    db.prepare('INSERT OR IGNORE INTO people (id, username, full_name, gender, birth_year, birth_date, occupation, residence, phone, photo_path, family_head, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.username||null, p.full_name, p.gender||null, p.birth_year||null, p.birth_date||null, p.occupation||null, p.residence||null, p.phone||null, p.photo_path||null, p.family_head||null, reviewerId, now(), 'approved');
    // if username provided, try to select by username
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
  function addParentChild(childId, parentId, note){
    const ins = db.prepare('INSERT INTO relationships (id, person_id, relative_id, type, notes) VALUES (?, ?, ?, ?, ?)');
    ins.run(uuidv4(), childId, parentId, 'parent', note || null);
    ins.run(uuidv4(), parentId, childId, 'child', note || null);
  }
  function addSpouse(a,b){
    // avoid duplicate spouse links (e.g. both parents already matched to existing profiles)
    const existing = db.prepare("SELECT id FROM relationships WHERE person_id = ? AND relative_id = ? AND type = 'spouse'").get(a,b);
    if (existing) return;
    const ins = db.prepare('INSERT INTO relationships (id, person_id, relative_id, type) VALUES (?, ?, ?, ?)');
    ins.run(uuidv4(), a, b, 'spouse');
    ins.run(uuidv4(), b, a, 'spouse');
  }

  const personId = createPerson(payload);
  if (payload.username && payload.password){
    const pwdHash = bcrypt.hashSync(payload.password, 10);
    // avoid unique constraint error by ignoring if username already exists
    db.prepare('INSERT OR IGNORE INTO users (id, username, password_hash, role, person_id) VALUES (?, ?, ?, ?, ?)').run(uuidv4(), payload.username, pwdHash, 'member', personId);
    // if the user already existed, ensure person_id is set
    db.prepare('UPDATE users SET person_id = ? WHERE username = ?').run(personId, payload.username);
  }

  if (Array.isArray(payload.relations)){
    const father = payload.relations.find(r=> r.type==='parent' && r.which==='father');
    const mother = payload.relations.find(r=> r.type==='parent' && r.which==='mother');

    let fatherId = null, motherId = null;
    if (father){
      fatherId = father.relative_id;
      if (!fatherId){
        const frel = father.relative || {};
        fatherId = createPerson({ full_name: frel.full_name || 'Unknown', birth_year: frel.birth_year||null, birth_date: frel.birth_date||null, gender: 'male', occupation: frel.occupation||null, residence: frel.residence||null, phone: frel.phone||null, photo_path: frel.photo_path||null });
      }
      addParentChild(personId, fatherId, father.from_family ? 'blood' : 'married-in');
    }
    if (mother){
      motherId = mother.relative_id;
      if (!motherId){
        const mrel = mother.relative || {};
        motherId = createPerson({ full_name: mrel.full_name || 'Unknown', birth_year: mrel.birth_year||null, birth_date: mrel.birth_date||null, gender: 'female', occupation: mrel.occupation||null, residence: mrel.residence||null, phone: mrel.phone||null, photo_path: mrel.photo_path||null });
      }
      addParentChild(personId, motherId, mother.from_family ? 'blood' : 'married-in');
    }
    if (fatherId && motherId) addSpouse(fatherId, motherId);
  }

  return personId;
}

router.post('/admin/requests/:id/approve', (req,res)=>{
  if (!req.session.user) return res.status(401).json({error:'not logged in'});
  if (!req.session.user.role || req.session.user.role==='member') return res.status(403).json({error:'forbidden'});
  const id = req.params.id;
  const reqRow = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!reqRow) return res.status(404).json({error:'not found'});
  const payload = JSON.parse(reqRow.payload);
  try{
    if (payload.type==='create_person' || payload.type==='create'){
      processCreatePerson(payload, req.session.user.id);
    }
    db.prepare('UPDATE requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run('approved', req.session.user.id, now(), id);
    res.json({ok:true});
  }catch(err){
    console.error('Approve error', err && err.stack || err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
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
  const payload = {
    username: body.username || null,
    full_name: body.full_name || null,
    gender: body.gender || null,
    birth_year: body.birth_year ? Number(body.birth_year) : (body.birth_year === '' ? null : null),
    birth_date: body.birth_date || null,
    occupation: body.occupation || null,
    residence: body.residence || null,
    phone: body.phone || null,
    photo_path: null
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

module.exports = router;

// debug: expose DB file path when needed
try{
  router.get('/debug/dbfile', (req,res)=>{ res.json({ dbfile: require('./db').__dbfile || null }); });
}catch(e){ console.error('Could not add debug route', e); }
