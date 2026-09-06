const express = require('express');
const router = express.Router();
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { put } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');
const { sendEmail } = require('./email');
const { isValidSlug, schemaNameForSlug, lookupFamilyBySlug } = require('./tenant');

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

// A session cookie is shared across every family's pages on this one domain (there's no
// per-family subdomain) — without this check, staying logged into one family in a browser tab
// and then visiting a different family's `/f/<slug>/...` URL would let that stale session's
// cached role (e.g. 'admin') authorize writes against a completely different family's schema,
// even though `req.session.user.id` refers to a row that only exists in the *other* family's
// `users` table. `familySlug` is stamped onto the session at login (see handleLogin below) and
// checked against `req.family` (set per-request by the tenant-resolution middleware in
// server/tenant.js) on every one of the guard functions below, so a mismatched session is
// treated as simply not logged in for this particular request — it isn't destroyed, so it's
// still valid back on the family it actually belongs to.
function sessionMatchesFamily(req){
  return !!(req.session.user && req.family && req.session.user.familySlug === req.family.slug);
}

function requireAdmin(req,res){
  if (!sessionMatchesFamily(req)){ res.status(401).json({error:'not logged in'}); return false; }
  if (!req.session.user.role || req.session.user.role==='member'){ res.status(403).json({error:'forbidden'}); return false; }
  return true;
}

// the platform owner — the original bootstrapped account (role 'platform_owner', created by
// server/seed.js) plus, conceptually, whoever else that account promotes to the role in the
// future. Stricter than requireAdmin: family-level admins (role 'admin') pass requireAdmin
// but not this — owner-only actions are adding/managing admins, resolving their locked-out
// password-reset requests, and reviewing family creation/deletion requests. Always a row in
// Na Ajanbeta's own schema (`public`) — reached the same way any un-prefixed request is (see
// server/tenant.js's DEFAULT_FAMILY), so `sessionMatchesFamily` holds for it exactly the same
// way it does for any family-level admin.
function requirePlatformOwner(req,res){
  if (!sessionMatchesFamily(req)){ res.status(401).json({error:'not logged in'}); return false; }
  if (req.session.user.role !== 'platform_owner'){ res.status(403).json({error:'forbidden'}); return false; }
  return true;
}

function generateTempPassword(){
  return Math.random().toString(36).slice(-10) + Math.random().toString(36).slice(-2).toUpperCase();
}

// every current admin/owner with an email on file — used to fan out "something needs review"
// notifications. An admin who hasn't yet logged in and set their own password (still on the
// owner-issued temp one) is excluded — they're not a confirmed working account yet, so there's
// no point notifying an inbox nobody's checking through the app. The owner is always included
// regardless of their own must_change_password state, since they're the one who set everything
// up. Admins without an email set (the original bootstrapped account, until the owner sets
// one) simply don't get emailed, same as before this feature existed.
async function getAdminRecipients(){
  const rows = await db.prepare("SELECT email FROM users WHERE ((role = 'admin' AND must_change_password = false) OR role = 'platform_owner') AND email IS NOT NULL AND email != ''").all();
  return rows.map(r=>r.email);
}

// members who opted in with an email address at registration — notified once something they
// submitted for review actually goes live (approved), not at submission time (that's what
// getAdminRecipients() is for). Admins/owner are added separately by each call site that
// wants them too, rather than folded in here, so a caller can choose member-only vs. everyone.
async function getMemberRecipients(){
  const rows = await db.prepare("SELECT email FROM users WHERE role = 'member' AND email IS NOT NULL AND email != ''").all();
  return rows.map(r=>r.email);
}

// field-by-field diff between a person's current record and a pending update_person
// payload, so an admin reviewing the request can see exactly what's being changed instead
// of just "so-and-so wants to update their profile". Only stores machine-readable {field,
// old, new} entries (no pre-rendered text) so the email (server-side, no i18n) and the
// admin.html UI (client-side, needs French too) can each label fields in their own language
// from the same data.
const PROFILE_DIFF_FIELDS = ['full_name', 'gender', 'birth_date', 'death_date', 'occupation', 'residence', 'phone'];
function buildProfileChangeSummary(current, updated, photoChanged, heirNames){
  const changes = [];
  PROFILE_DIFF_FIELDS.forEach(field=>{
    const oldVal = current[field] || null;
    const newVal = updated[field] || null;
    if (oldVal !== newVal) changes.push({ field, old: oldVal, new: newVal });
  });
  if (photoChanged) changes.push({ field: 'photo' });
  if (heirNames && heirNames.length) changes.push({ field: 'heir_of', added: heirNames });
  return changes;
}

const PROFILE_DIFF_LABELS_EN = {
  full_name: 'Full name', gender: 'Gender', birth_date: 'Birth date', death_date: 'Date of death',
  occupation: 'Occupation', residence: 'Residence', phone: 'Phone', photo: 'Photo', heir_of: 'Heritage',
  email: 'Email',
};
// plain-English HTML summary for the admin notification email (no client-side i18n available here)
function changeSummaryToHtml(changes){
  if (!changes || !changes.length) return '';
  const items = changes.map(c=>{
    const label = PROFILE_DIFF_LABELS_EN[c.field] || c.field;
    if (c.field === 'photo') return `<li>${label} updated</li>`;
    if (c.added) return `<li>${label}: claiming heritage from ${c.added.join(', ')}</li>`;
    return `<li>${label}: "${c.old || '(empty)'}" → "${c.new || '(empty)'}"</li>`;
  }).join('');
  return `<p><strong>What changed:</strong></p><ul>${items}</ul>`;
}

// fire-and-forget notification for a newly-pending request/archive post — never allowed to
// break the request that triggered it, so every failure is swallowed after logging
async function notifyAdmins(req, { subject, bodyHtml, highlightParam, highlightId }){
  try{
    const recipients = await getAdminRecipients();
    if (!recipients.length) return;
    const link = `${req.protocol}://${req.get('host')}/admin.html?${highlightParam}=${encodeURIComponent(highlightId)}`;
    await sendEmail({ to: recipients, subject: `[Nah Adja Mbethe] ${subject}`, html: `${bodyHtml}<p><a href="${link}">Review and respond</a></p>` });
  }catch(e){ console.error('[notify] failed', e && e.message || e); }
}

// fire-and-forget notification for something that just went *live* (approved) — opted-in
// members only (getMemberRecipients()), separate from notifyAdmins() above which fires at
// *submission* time to admins for review. A post/event can be approved with zero opted-in
// members and this is just a silent no-op, same failure-swallowing as notifyAdmins.
async function notifyMembers(req, { subject, bodyHtml, link }){
  try{
    const recipients = await getMemberRecipients();
    if (!recipients.length) return;
    const fullLink = `${req.protocol}://${req.get('host')}${link}`;
    await sendEmail({ to: recipients, subject: `[Nah Adja Mbethe] ${subject}`, html: `${bodyHtml}<p><a href="${fullLink}">View it</a></p>` });
  }catch(e){ console.error('[notify] failed', e && e.message || e); }
}

// any logged-in account with a linked profile (i.e. a real person, not a bare admin login)
function requireLoggedInPerson(req,res){
  if (!sessionMatchesFamily(req)){ res.status(401).json({error:'not logged in'}); return false; }
  if (!req.session.user.person_id){ res.status(403).json({error:'no linked profile'}); return false; }
  return true;
}

// like requireLoggedInPerson, but also lets an admin/owner through even without a linked
// profile — the platform owner in particular is often not linked to anyone in the family
// tree, and still needs to browse/moderate content (view the tree, view archive posts,
// delete a comment). Only for read/moderate routes — actions attributed to a person (liking,
// commenting) still need a real person_id and keep using requireLoggedInPerson.
function requireViewerAccess(req,res){
  if (!sessionMatchesFamily(req)){ res.status(401).json({error:'not logged in'}); return false; }
  if (req.session.user.person_id) return true;
  if (req.session.user.role && req.session.user.role !== 'member') return true;
  res.status(403).json({error:'no linked profile'}); return false;
}

// any logged-in account at all, member or admin — used for actions (like changing one's
// own password) that don't need a linked person profile
function requireLoggedIn(req,res){
  if (!sessionMatchesFamily(req)){ res.status(401).json({error:'not logged in'}); return false; }
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
  const username = ((req.body && req.body.username) || '').trim();
  const password = ((req.body && req.body.password) || '').trim();
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  // TRIM() on both sides of the match: a stray leading/trailing space typed or pasted into a
  // username at creation time (there was no trimming there either, now fixed, but this covers
  // any row that predates that fix) would otherwise silently make login impossible — the
  // stored username looks identical to the eye but never matches what anyone actually types.
  const user = await db.prepare('SELECT * FROM users WHERE TRIM(username) = TRIM(?)').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid' });
  req.session.user = { id: user.id, role: user.role, person_id: user.person_id, username: user.username, email: user.email || null, mustChangePassword: !!user.must_change_password, familySlug: req.family.slug };
  return res.json({ ok:true, role: user.role, person_id: user.person_id, mustChangePassword: !!user.must_change_password });
}
router.post('/auth/login', wrap(handleLogin));
// kept as an alias so the existing admin-login page keeps working unchanged
router.post('/auth/admin-login', wrap(handleLogin));

// the owner-only login surface — same credential check as handleLogin, but rejects anyone
// whose account isn't role 'platform_owner', even with a fully valid password, so this page can't
// be used as a second way into a plain admin account
router.post('/auth/owner-login', express.json(), wrap(async (req,res)=>{
  const username = ((req.body && req.body.username) || '').trim();
  const password = ((req.body && req.body.password) || '').trim();
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  const user = await db.prepare('SELECT * FROM users WHERE TRIM(username) = TRIM(?)').get(username);
  if (!user || user.role !== 'platform_owner' || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid' });
  }
  req.session.user = { id: user.id, role: user.role, person_id: user.person_id, username: user.username, email: user.email || null, mustChangePassword: !!user.must_change_password, familySlug: req.family.slug };
  res.json({ ok:true, mustChangePassword: !!user.must_change_password });
}));

// admins request a password reset when locked out (don't know their current password, so the
// existing self-service change-password flow doesn't help) — creates a pending request the
// owner resolves from owner.html. Always responds the same way regardless of whether the
// username exists/is an admin, so this can't be used to enumerate accounts.
router.post('/auth/admin-password-reset-request', express.json(), wrap(async (req,res)=>{
  const username = ((req.body && req.body.username) || '').trim();
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  const user = await db.prepare("SELECT id FROM users WHERE username = ? AND role IN ('admin','platform_owner')").get(username);
  if (user){
    const id = uuidv4();
    const payload = { type: 'admin_password_reset', username, user_id: user.id };
    await db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'admin_password_reset', JSON.stringify(payload), 'pending', 'self-service', now());
    const owners = await db.prepare("SELECT email FROM users WHERE role = 'platform_owner' AND email IS NOT NULL AND email != ''").all();
    if (owners.length){
      const link = `${req.protocol}://${req.get('host')}/owner.html?highlight=${encodeURIComponent(id)}`;
      await sendEmail({
        to: owners.map(o=>o.email),
        subject: '[Nah Adja Mbethe] Administrator password reset requested',
        html: `<p><strong>${username}</strong> is locked out and has requested a password reset.</p><p><a href="${link}">Review and resolve</a></p>`,
      }).catch(()=>{});
    }
  }
  res.json({ ok: true });
}));

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
  if (!sessionMatchesFamily(req)) return res.status(401).json({error:'not logged in'});
  const person = await db.prepare('SELECT * FROM people WHERE id = ?').get(req.session.user.person_id);
  res.json({ user: req.session.user, person });
}));

// list approved people
router.get('/people', wrap(async (req,res)=>{
  const rows = await db.prepare("SELECT * FROM people WHERE approval_status = 'approved'").all();
  res.json(rows);
}));

// search approved people by (partial) name or username — used to match parents typed
// during registration, and to link an existing profile from the admin relation editor. A
// searcher who only remembers someone's login username (not sure how their name is spelled/
// cased) still finds them this way.
router.get('/people/search', wrap(async (req,res)=>{
  const q = normalizeName(req.query.name || req.query.q || '');
  if (!q) return res.json([]);
  const rows = await db.prepare("SELECT * FROM people WHERE approval_status = 'approved'").all();
  const matches = rows.filter(p => normalizeName(p.full_name).includes(q) || normalizeName(p.username).includes(q));
  res.json(matches.slice(0, 20));
}));

// walks straight up the ancestry chain from startId (its own father/mother, their father/
// mother, and so on) — never sideways into siblings/aunts/uncles — collecting every already-
// deceased person found along the way. Used for the "are you an heir" question: heritage in
// this culture only ever passes down from a direct ascendant who has passed away.
async function collectDeceasedAncestors(dbLike, startId){
  const result = [];
  const seen = new Set();
  let frontier = startId ? [startId] : [];
  let depth = 0;
  while (frontier.length && depth < 10){
    const next = [];
    for (const id of frontier){
      if (seen.has(id)) continue;
      seen.add(id);
      const person = await dbLike.prepare('SELECT id, full_name, gender, birth_date, death_date FROM people WHERE id = ?').get(id);
      if (!person) continue;
      if (person.death_date) result.push(person);
      const { fatherId, motherId } = await getParentIds(dbLike, id);
      if (fatherId) next.push(fatherId);
      if (motherId) next.push(motherId);
    }
    frontier = next;
    depth++;
  }
  return result;
}

// candidate ancestors a registrant could be claiming heritage from — combines both parents'
// ancestor chains (a matched father_id and/or mother_id; a freshly-typed, not-yet-existing
// parent contributes nothing here, since there's no ancestry on file to walk yet), deduped.
// Registered before /people/:id — as a static path it would otherwise be shadowed by that
// parameterized route matching "heir-candidates" as an :id (which is exactly what happened
// the first time this shipped: every call silently 404'd as "not found").
router.get('/people/heir-candidates', wrap(async (req,res)=>{
  const fatherId = req.query.father_id || null;
  const motherId = req.query.mother_id || null;
  const fromFather = await collectDeceasedAncestors(db, fatherId);
  const fromMother = await collectDeceasedAncestors(db, motherId);
  const byId = {};
  [...fromFather, ...fromMother].forEach(p => { byId[p.id] = p; });
  res.json(Object.values(byId));
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

  let heirOf = [];
  if (body.heir_of){ try{ const parsed = JSON.parse(body.heir_of); if (Array.isArray(parsed)) heirOf = parsed.filter(Boolean); }catch(e){ heirOf = []; } }

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
    email: (body.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) ? body.email.trim() : null,
    photo_path: body.photo_path || null,
    heir_of: heirOf,
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
  // respond first, notify after — but still inside this same async handler (not truly
  // detached) since a Vercel serverless invocation can be torn down the moment the response
  // is sent, which would silently kill a fire-and-forget promise before it ever sends
  await notifyAdmins(req, {
    subject: 'New account request',
    bodyHtml: `<p><strong>${payload.full_name}</strong> wants to create an account in the family tree.</p>`,
    highlightParam: 'highlight', highlightId: id,
  });
}));

// shared by the listing and counts endpoints below: for the Approved tab, exclude any row
// whose resolved person has since been deleted. An approved request's card offers "Modify
// account"/"Delete account" for the person it resolved to — once that person is deleted, the
// request row itself is untouched (kept as a historical record), so without this filter its
// card would keep showing forever with a Delete button that appears to do nothing (the
// person is already gone). A NULL resolved_person_id (nothing to check) or a still-'approved'
// person both pass.
const APPROVED_STALE_FILTER_SQL = "(resolved_person_id IS NULL OR EXISTS (SELECT 1 FROM people p WHERE p.id = requests.resolved_person_id AND p.approval_status = 'approved'))";

// self-heals approved create_person requests that never got a resolved_person_id — either
// because they predate that column, or (a real case found in production) because an earlier
// one-off backfill script explicitly skipped rows whose person was *already* deleted at the
// time, treating that as "not actually broken". That reasoning missed a side effect:
// APPROVED_STALE_FILTER_SQL can only recognize a stale card by checking resolved_person_id —
// with nothing to check, the row (and its "Delete account" button that can now never resolve
// to anyone) keeps showing forever. Runs lazily here, so it heals itself for any future case
// too, not just the ones already found — same reasoning as the 24h rejected-request purge
// below: no scheduled job in a single serverless function, so do it on read.
async function healMissingResolvedPersonIds(){
  const orphans = await db.prepare("SELECT id, payload FROM requests WHERE status = 'approved' AND type IN ('create_person','create') AND resolved_person_id IS NULL").all();
  for (const row of orphans){
    let payload;
    try{ payload = JSON.parse(row.payload); }catch(e){ continue; }
    let person = null;
    if (payload.username) person = await db.prepare('SELECT id FROM people WHERE username = ?').get(payload.username);
    if (!person && payload.full_name && payload.birth_date) person = await db.prepare('SELECT id FROM people WHERE full_name = ? AND birth_date = ?').get(payload.full_name, payload.birth_date);
    if (!person && payload.full_name){
      const candidates = await db.prepare('SELECT id FROM people WHERE full_name = ?').all(payload.full_name);
      if (candidates.length === 1) person = candidates[0];
    }
    if (person) await db.prepare('UPDATE requests SET resolved_person_id = ? WHERE id = ?').run(person.id, row.id);
  }
}

// admin: list requests (status can be pending|approved|rejected)
router.get('/admin/requests', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  // the Rejected tab (both actual rejections and the "delete account" audit trail — see
  // /admin/people/:id/delete below, which files itself as a rejected delete_person request)
  // is meant to be a brief undo window, not a permanent log — purge anything past 24h.
  // Lazily, on read, rather than via a scheduled job: this app is a single serverless
  // function with no persistent process to run a cron in.
  await db.prepare("DELETE FROM requests WHERE status = 'rejected' AND reviewed_at IS NOT NULL AND reviewed_at::timestamptz < NOW() - INTERVAL '24 hours'").run();
  await healMissingResolvedPersonIds();
  const status = (req.query.status || 'pending').toLowerCase();
  if (!['pending','approved','rejected'].includes(status)) return res.status(400).json({error:'invalid status'});
  // admin_password_reset requests are owner-only (see /owner/password-reset-requests) — an
  // admin locked out of their own account isn't something other admins need to see or act on
  let sql = "SELECT * FROM requests WHERE status = ? AND type != 'admin_password_reset'";
  if (status === 'approved') sql += ` AND ${APPROVED_STALE_FILTER_SQL}`;
  sql += ' ORDER BY created_at DESC';
  const rows = await db.prepare(sql).all(status);
  res.json(rows.map(r=> ({...r, payload: JSON.parse(r.payload)})));
}));

// counts for the three tab badges — same filtering as the listing above, so a badge count
// always matches what you'd actually see clicking into that tab
router.get('/admin/requests/counts', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const pending = await db.prepare("SELECT COUNT(*) c FROM requests WHERE status='pending' AND type != 'admin_password_reset'").get();
  const approved = await db.prepare(`SELECT COUNT(*) c FROM requests WHERE status='approved' AND type != 'admin_password_reset' AND ${APPROVED_STALE_FILTER_SQL}`).get();
  const rejected = await db.prepare("SELECT COUNT(*) c FROM requests WHERE status='rejected' AND type != 'admin_password_reset'").get();
  res.json({ pending: Number(pending.c), approved: Number(approved.c), rejected: Number(rejected.c) });
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

async function createLoginForPerson(dbLike, personId, username, password, email){
  if (!username || !password) return;
  const pwdHash = bcrypt.hashSync(password, 10);
  await dbLike.prepare('INSERT INTO users (id, username, password_hash, role, person_id, email) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (username) DO NOTHING').run(uuidv4(), username, pwdHash, 'member', personId, email || null);
  await dbLike.prepare('UPDATE users SET person_id = ?, email = ? WHERE username = ?').run(personId, email || null, username);
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
  await createLoginForPerson(dbLike, personId, payload.username, payload.password, payload.email);

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

  await applyHeirClaims(dbLike, personId, payload.heir_of);

  return personId;
}

// heritage: one relationship row per ancestor claimed, person_id = the heir, relative_id =
// the deceased ancestor they represent. One-directional (no reverse row needed — the tree
// only ever needs to answer "who is X the heir of", never the other way round) and, unlike
// parent/spouse links, there's no single canonical slot to overwrite, so this only ever adds
// rows, never removes ones from an earlier approval. Used both at initial registration and
// from a later profile edit (someone becomes an heir well after their account already
// exists, e.g. an ancestor dies) — the dedupe check is what makes the second case safe to
// resubmit without doubling up a claim already on file.
async function applyHeirClaims(dbLike, personId, heirOfIds){
  if (!Array.isArray(heirOfIds)) return;
  for (const ancestorId of heirOfIds){
    const ancestor = await dbLike.prepare('SELECT id FROM people WHERE id = ?').get(ancestorId);
    if (!ancestor) continue;
    const existing = await dbLike.prepare("SELECT id FROM relationships WHERE person_id = ? AND relative_id = ? AND type = 'heir'").get(personId, ancestor.id);
    if (existing) continue;
    await dbLike.prepare('INSERT INTO relationships (id, person_id, relative_id, type) VALUES (?, ?, ?, ?)').run(uuidv4(), personId, ancestor.id, 'heir');
  }
}

// apply an approved self-edit to the person's own record, keeping their existing photo
// unless a new one was uploaded with the request
async function processUpdatePerson(dbLike, payload, reviewerId){
  const current = await dbLike.prepare('SELECT * FROM people WHERE id = ?').get(payload.person_id);
  if (!current) return null;
  const photoPath = payload.photo_path || current.photo_path;
  await dbLike.prepare('UPDATE people SET full_name = ?, gender = ?, birth_year = ?, birth_date = ?, death_date = ?, occupation = ?, residence = ?, phone = ?, photo_path = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?')
    .run(payload.full_name || current.full_name, payload.gender || current.gender, payload.birth_year || null, payload.birth_date || null, payload.death_date || null, payload.occupation || null, payload.residence || null, payload.phone || null, photoPath, reviewerId, now(), current.id);
  await applyHeirClaims(dbLike, current.id, payload.heir_of);
  // email lives on users, not people — only touched at all if the edit form included it
  // (the owner-editing-someone-else path never does, see buildUpdatePersonPayload)
  if (Object.prototype.hasOwnProperty.call(payload, 'email')){
    await dbLike.prepare('UPDATE users SET email = ? WHERE person_id = ?').run(payload.email, current.id);
  }
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
  // ancestors already claimed as heritage — lets the edit-profile "are you an heir" picker
  // only offer ancestors not already on file, so resubmitting doesn't look like a no-op
  const heirRows = await db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'heir'").all(id);
  const heirOfIds = heirRows.map(r=> r.relative_id);
  res.json({ spouses, father, mother, heirOfIds });
}));

// shared by /member/profile/update (editing yourself) and /owner/people/:id/request-update
// (the owner editing someone else on their behalf) — builds the update_person payload,
// including the field-by-field change summary, from a person's current row + the submitted
// form fields. `currentEmail` is only meaningful (and `body.email` only ever present) on the
// self-edit path — see the callers.
async function buildUpdatePersonPayload(current, body, file, heirOf, currentEmail){
  let birthDate = body.birth_date || null;
  let birthYear = null;
  if (birthDate){ try{ const d = new Date(birthDate); if (isFinite(d)) birthYear = d.getFullYear(); else birthDate = null; }catch(e){ birthDate = null; } }

  const payload = {
    type: 'update_person',
    person_id: current.id,
    target_name: current.full_name,
    full_name: body.full_name || current.full_name,
    gender: body.gender || current.gender,
    birth_date: birthDate,
    birth_year: birthYear,
    death_date: body.death_date || null,
    occupation: body.occupation || null,
    residence: body.residence || null,
    phone: body.phone || null,
    photo_path: file ? await uploadPhoto(file, 'photos') : null,
    heir_of: heirOf
  };

  const heirNames = [];
  for (const ancestorId of heirOf){
    const ancestor = await db.prepare('SELECT full_name FROM people WHERE id = ?').get(ancestorId);
    if (ancestor) heirNames.push(ancestor.full_name);
  }
  payload.changes = buildProfileChangeSummary(current, payload, !!file, heirNames);

  // email lives on users, not people, so it's handled separately from the generic
  // people-table diff above. Only touched when the form actually included the field (the
  // owner-editing-someone-else path never does) — an empty submitted value means "clear it",
  // same optional/opt-out semantics as at registration, not "leave whatever's there".
  if (Object.prototype.hasOwnProperty.call(body, 'email')){
    const trimmed = (body.email || '').trim();
    const isValidEmail = trimmed !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    const newEmail = trimmed === '' ? null : (isValidEmail ? trimmed : (currentEmail || null));
    if (newEmail !== (currentEmail || null)) payload.changes.push({ field: 'email', old: currentEmail || null, new: newEmail });
    payload.email = newEmail;
  }

  return payload;
}

// submit a pending request to change one's own profile fields (photo, name, DOB, etc.)
router.post('/member/profile/update', upload.single('photo'), wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const body = req.body || {};
  const personId = req.session.user.person_id;
  const current = await db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!current) return res.status(404).json({ error: 'profile not found' });

  let heirOf = [];
  if (body.heir_of){ try{ const parsed = JSON.parse(body.heir_of); if (Array.isArray(parsed)) heirOf = parsed.filter(Boolean); }catch(e){ heirOf = []; } }

  const payload = await buildUpdatePersonPayload(current, body, req.file, heirOf, req.session.user.email);
  const id = uuidv4();
  await db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'update_person', JSON.stringify(payload), 'pending', req.session.user.id, now());
  res.json({ ok:true, id });
  await notifyAdmins(req, {
    subject: 'Profile update request',
    bodyHtml: `<p><strong>${current.full_name}</strong> wants to update their profile.</p>${changeSummaryToHtml(payload.changes)}`,
    highlightParam: 'highlight', highlightId: id,
  });
}));

// the platform owner editing someone else's profile directly from the tree — still goes
// through the normal admin-approval queue like any other edit, just tagged as owner-initiated
// (and attributed to the owner's own user id, not the target person) so admins reviewing it
// know it came from the owner, not the person themselves.
router.post('/owner/people/:id/request-update', upload.single('photo'), wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const current = await db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'profile not found' });

  const payload = await buildUpdatePersonPayload(current, req.body || {}, req.file, []);
  payload.owner_initiated = true;

  const id = uuidv4();
  await db.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'update_person', JSON.stringify(payload), 'pending', req.session.user.id, now());
  res.json({ ok:true, id });
  await notifyAdmins(req, {
    subject: 'Profile update request (from the platform owner)',
    bodyHtml: `<p>The platform owner wants to update <strong>${current.full_name}</strong>'s profile.</p>${changeSummaryToHtml(payload.changes)}`,
    highlightParam: 'highlight', highlightId: id,
  });
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
  await db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), false, user.id);
  req.session.user.mustChangePassword = false;
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
  await notifyAdmins(req, {
    subject: 'New relative request',
    bodyHtml: `<p><strong>${requester.full_name}</strong> wants to add a ${payload.relation}.</p>`,
    highlightParam: 'highlight', highlightId: id,
  });
}));

// admin: reject request
router.post('/admin/requests/:id/reject', express.json(), wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const id = req.params.id;
  const note = req.body && req.body.note ? String(req.body.note) : null;
  const reqRow = await db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!reqRow) return res.status(404).json({error:'not found'});
  await db.prepare('UPDATE requests SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?').run('rejected', req.session.user.id, now(), note, id);
  res.json({ ok:true });
}));

// admin: edit payload then approve
router.post('/admin/requests/:id/edit-approve', express.json(), wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
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
  if (!requireAdmin(req,res)) return;
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
  // heritage claims from the original request — see the same field on /auth/register
  if (body.heir_of){
    try{ const parsed = JSON.parse(body.heir_of); payload.heir_of = Array.isArray(parsed) ? parsed : []; }catch(e){ payload.heir_of = []; }
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
  if (!requireAdmin(req,res)) return;
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

// direct relatives of a person — father, mother, spouse(s), children — for the "delete this
// account" confirmation, which lets the admin optionally take any of them down at the same
// time (e.g. a spouse and their shared children) instead of only ever deleting one person
// per click.
router.get('/admin/people/:id/relatives', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const id = req.params.id;
  const { fatherId, motherId } = await getParentIds(db, id);
  const father = fatherId ? await db.prepare('SELECT id, full_name, gender FROM people WHERE id = ?').get(fatherId) : null;
  const mother = motherId ? await db.prepare('SELECT id, full_name, gender FROM people WHERE id = ?').get(motherId) : null;
  const spouseIds = await getSpouseIds(db, id);
  const spouses = (await Promise.all(spouseIds.map(sid=> db.prepare('SELECT id, full_name, gender FROM people WHERE id = ?').get(sid)))).filter(Boolean);
  const childIds = (await db.prepare("SELECT relative_id FROM relationships WHERE person_id = ? AND type = 'child'").all(id)).map(r=>r.relative_id);
  const children = (await Promise.all(childIds.map(cid=> db.prepare('SELECT id, full_name, gender FROM people WHERE id = ?').get(cid)))).filter(Boolean);
  res.json({ father, mother, spouses, children });
}));

// --- owner-only: manage family-level administrators ---

// a visually distinct, monospace block for a username/password so it's unambiguous to select
// and copy in an email client — plain "label: **value**" text sitting inline with a sentence
// is exactly what led to a real failed login (a stray space picked up when manually
// retyping instead of copy-pasting was the likely cause; this doesn't eliminate that risk but
// makes the boundary of what to copy much clearer, and says so explicitly)
function credentialBlockHtml(username, tempPassword){
  const row = (label, value) => `<div style="margin-bottom:6px"><span style="color:#666">${label}:</span> <code style="background:#f3f1ea;padding:2px 8px;border-radius:4px;font-family:monospace;font-size:15px">${value}</code></div>`;
  return `<div style="border:1px solid #ddd;border-radius:8px;padding:14px;margin:12px 0">${row('Username', username)}${row('Temporary password', tempPassword)}</div><p style="color:#666;font-size:13px">Copy and paste these rather than typing them by hand — easy to mistype otherwise.</p>`;
}

async function resetAdminPasswordAndNotify(dbLike, userId){
  const tempPassword = generateTempPassword();
  await dbLike.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(bcrypt.hashSync(tempPassword, 10), true, userId);
  const user = await dbLike.prepare('SELECT username, email FROM users WHERE id = ?').get(userId);
  if (user && user.email){
    await sendEmail({
      to: user.email,
      subject: '[Nah Adja Mbethe] Your administrator password has been reset',
      html: `<p>Your password has been reset by the platform owner.</p>${credentialBlockHtml(user.username, tempPassword)}<p>You'll be asked to set a new password when you next log in.</p>`,
    }).catch(()=>{});
  }
}

router.get('/owner/admins', wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const rows = await db.prepare("SELECT id, username, email, created_at, must_change_password FROM users WHERE role = 'admin' ORDER BY created_at DESC").all();
  res.json(rows);
}));

// the owner's own notification email — separate from admins' emails (set by the owner when
// adding them), since the owner has no one else to set theirs for them
router.post('/owner/email', express.json(), wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const email = ((req.body && req.body.email) || '').trim();
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  await db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.session.user.id);
  req.session.user.email = email;
  res.json({ ok:true });
}));

// the owner's own login username — self-service, same reasoning as /owner/email
router.post('/owner/username', express.json(), wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const username = ((req.body && req.body.username) || '').trim();
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  const current = await db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.user.id);
  if (current && current.username === username) return res.json({ ok:true }); // no-op
  if (await isUsernameTaken(username)) return res.status(409).json({ error: 'That username is already taken.' });
  await db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.session.user.id);
  res.json({ ok:true });
}));

router.post('/owner/admins/create', express.json(), wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const username = ((req.body && req.body.username) || '').trim();
  const email = ((req.body && req.body.email) || '').trim();
  if (!username || !email) return res.status(400).json({ error: 'Username and email are required.' });
  if (await isUsernameTaken(username)) return res.status(409).json({ error: 'That username is already taken.' });
  const tempPassword = generateTempPassword();
  const id = uuidv4();
  await db.prepare('INSERT INTO users (id, username, password_hash, role, email, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, username, bcrypt.hashSync(tempPassword, 10), 'admin', email, true, now());
  const link = `${req.protocol}://${req.get('host')}/admin-login.html`;
  await sendEmail({
    to: email,
    subject: '[Nah Adja Mbethe] You have been added as an administrator',
    html: `<p>You've been added as an administrator for the Nah Adja Mbethe family tree.</p>${credentialBlockHtml(username, tempPassword)}<p>You'll be asked to set a new password the first time you log in.</p><p><a href="${link}">Log in</a></p>`,
  }).catch(()=>{});
  res.json({ ok:true, id });
}));

router.post('/owner/admins/:id/reset-password', wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const user = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'admin'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  await resetAdminPasswordAndNotify(db, user.id);
  res.json({ ok:true });
}));

router.post('/owner/admins/:id/delete', wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const user = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'admin'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  await db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok:true });
}));

// pending admin_password_reset requests — owner-only, deliberately excluded from the regular
// /admin/requests listing (see below) since these aren't relevant to other admins
router.get('/owner/password-reset-requests', wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const rows = await db.prepare("SELECT * FROM requests WHERE type = 'admin_password_reset' AND status = 'pending' ORDER BY created_at DESC").all();
  res.json(rows.map(r=> ({...r, payload: JSON.parse(r.payload)})));
}));

router.post('/owner/password-reset-requests/:id/resolve', wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const reqRow = await db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!reqRow) return res.status(404).json({ error: 'not found' });
  const payload = JSON.parse(reqRow.payload);
  const user = await db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('admin','platform_owner')").get(payload.user_id);
  if (!user) return res.status(404).json({ error: 'admin account not found' });
  await db.transaction(async (tx) => {
    await resetAdminPasswordAndNotify(tx, user.id);
    await tx.prepare('UPDATE requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run('approved', req.session.user.id, now(), req.params.id);
  });
  res.json({ ok:true });
}));

// --- platform-level: anyone can request a new family, the platform owner approves/rejects
// from owner.html's "Families" tab. These routes deliberately touch only `public.families` and
// `public.platform_requests` (both explicitly schema-qualified, never relying on whatever
// schema happens to be active via search_path for the current request) — a family-creation
// request has no tenant of its own yet, and reviewing/approving it is a platform-wide action,
// not a family-level one. See server/db.js (createFamilySchema, withTenant) and
// server/tenant.js (slug validation, schema naming) for the primitives this builds on.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function isFamilySlugTaken(slug){
  if (await db.prepare('SELECT id FROM public.families WHERE slug = ?').get(slug)) return true;
  const pending = await db.prepare("SELECT payload FROM public.platform_requests WHERE type = 'create_family' AND status = 'pending'").all();
  return pending.some(r=>{ try{ return JSON.parse(r.payload).slug === slug; }catch(e){ return false; } });
}

// public: submit a request for a brand new family — reviewed by the platform owner, never
// auto-approved
router.post('/families/request', express.json(), wrap(async (req,res)=>{
  const body = req.body || {};
  const familyName = (body.family_name || '').trim();
  const slug = (body.slug || '').trim().toLowerCase();
  const adminUsername = (body.admin_username || '').trim();
  const adminEmail = (body.admin_email || '').trim();
  if (!familyName) return res.status(400).json({ error: 'A family name is required.' });
  if (!isValidSlug(slug)) return res.status(400).json({ error: 'Choose a family ID using only lowercase letters, numbers, and hyphens.' });
  if (!adminUsername) return res.status(400).json({ error: 'An admin username is required.' });
  if (!adminEmail || !EMAIL_RE.test(adminEmail)) return res.status(400).json({ error: 'A valid admin email is required.' });
  if (!body.policy_accepted) return res.status(400).json({ error: 'You must confirm you have read and accepted the policy.' });
  if (await isFamilySlugTaken(slug)) return res.status(409).json({ error: 'That family ID is already taken. Please choose another.' });

  const id = uuidv4();
  const payload = { type: 'create_family', family_name: familyName, slug, admin_username: adminUsername, admin_email: adminEmail };
  await db.prepare('INSERT INTO public.platform_requests (id, type, payload, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'create_family', JSON.stringify(payload), 'pending', now());
  res.json({ ok:true, id });

  try{
    const owners = await db.prepare("SELECT email FROM public.users WHERE role = 'platform_owner' AND email IS NOT NULL AND email != ''").all();
    if (owners.length){
      const link = `${req.protocol}://${req.get('host')}/owner.html?highlight=${encodeURIComponent(id)}`;
      await sendEmail({
        to: owners.map(o=>o.email),
        subject: `New family creation request: ${familyName}`,
        html: `<p><strong>${familyName}</strong> (ID: ${slug}) has requested a new family, admin: ${adminUsername} (${adminEmail}).</p><p><a href="${link}">Review and respond</a></p>`,
      });
    }
  }catch(e){ console.error('[notify] failed', e && e.message || e); }
}));

// family-admin-initiated: ask the platform owner to delete this family. Uses req.family (set
// by the tenant-resolution middleware from the URL this request came in on) rather than a
// client-supplied slug, so this can only ever target the admin's own family.
router.post('/families/deletion-request', express.json(), wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const id = uuidv4();
  const payload = { type: 'delete_family', slug: req.family.slug, family_name: req.family.name, requested_by: req.session.user.username };
  await db.prepare('INSERT INTO public.platform_requests (id, type, payload, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'delete_family', JSON.stringify(payload), 'pending', now());
  res.json({ ok:true, id });
  try{
    const owners = await db.prepare("SELECT email FROM public.users WHERE role = 'platform_owner' AND email IS NOT NULL AND email != ''").all();
    if (owners.length){
      await sendEmail({
        to: owners.map(o=>o.email),
        subject: `Family deletion requested: ${req.family.name}`,
        html: `<p><strong>${req.session.user.username}</strong>, an admin of <strong>${req.family.name}</strong> (ID: ${req.family.slug}), has requested this family be deleted.</p>`,
      });
    }
  }catch(e){ console.error('[notify] failed', e && e.message || e); }
}));

router.get('/platform/families/requests', wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const status = (req.query.status || 'pending').toLowerCase();
  if (!['pending','approved','rejected'].includes(status)) return res.status(400).json({error:'invalid status'});
  const rows = await db.prepare('SELECT * FROM public.platform_requests WHERE status = ? ORDER BY created_at DESC').all(status);
  res.json(rows.map(r=> ({...r, payload: JSON.parse(r.payload)})));
}));

// creates the family's schema + tables, its first admin account, records it in
// public.families, and emails the admin their personalized link + temp password. Re-validates
// the slug is still free (a second request for the same name could have been submitted, and
// even approved, while this one sat pending) rather than trusting the check made at submission
// time.
async function processCreateFamily(payload, reviewerId, req){
  if (await isFamilySlugTaken(payload.slug)) throw new Error('That family ID has since been taken by another approved family.');
  const schemaName = schemaNameForSlug(payload.slug);
  await db.createFamilySchema(schemaName);

  const tempPassword = generateTempPassword();
  await db.withTenant(schemaName, async () => {
    await db.prepare('INSERT INTO users (id, username, password_hash, role, email, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), payload.admin_username, bcrypt.hashSync(tempPassword, 10), 'admin', payload.admin_email, true, now());
  });

  const familyId = uuidv4();
  await db.prepare('INSERT INTO public.families (id, slug, schema_name, name, status, owner_username, owner_email, created_at, approved_at, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(familyId, payload.slug, schemaName, payload.family_name, 'active', payload.admin_username, payload.admin_email, now(), now(), reviewerId);

  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const link = `${base}/f/${payload.slug}/admin-login`;
  await sendEmail({
    to: payload.admin_email,
    subject: `Your family "${payload.family_name}" has been approved`,
    html: `<p>Your request to create <strong>${payload.family_name}</strong> has been approved.</p>`
      + credentialBlockHtml(payload.admin_username, tempPassword)
      + `<p><a href="${link}">${link}</a></p>`
      + `<p><strong>Next steps:</strong></p><ol>`
      + `<li>Open the link above and log in as an admin with the username and temporary password shown.</li>`
      + `<li>You'll be asked to set a new password right away — this is required before you can do anything else.</li>`
      + `<li>Create your family's root profile (the founding ancestor everyone else's tree hangs from).</li>`
      + `<li>Share this same link with your family members so they can register their own accounts — each one will need your approval, the same way this one did.</li></ol>`,
  }).catch(()=>{});
}

router.post('/platform/families/requests/:id/approve', wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const reqRow = await db.prepare('SELECT * FROM public.platform_requests WHERE id = ?').get(req.params.id);
  if (!reqRow) return res.status(404).json({ error: 'not found' });
  const payload = JSON.parse(reqRow.payload);
  try{
    if (payload.type === 'create_family'){
      await processCreateFamily(payload, req.session.user.id, req);
    } else if (payload.type === 'delete_family'){
      await db.prepare("UPDATE public.families SET status = 'deleted' WHERE slug = ?").run(payload.slug);
    }
    await db.prepare('UPDATE public.platform_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run('approved', req.session.user.id, now(), req.params.id);
    res.json({ ok:true });
  }catch(err){
    console.error('Family request approve error', err && err.stack || err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}));

router.post('/platform/families/requests/:id/reject', express.json(), wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const note = req.body && req.body.note ? String(req.body.note) : null;
  const reqRow = await db.prepare('SELECT * FROM public.platform_requests WHERE id = ?').get(req.params.id);
  if (!reqRow) return res.status(404).json({ error: 'not found' });
  await db.prepare('UPDATE public.platform_requests SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?').run('rejected', req.session.user.id, now(), note, req.params.id);
  res.json({ ok:true });
}));

// overview for the platform owner's dashboard — every family regardless of status
router.get('/platform/families', wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const rows = await db.prepare('SELECT * FROM public.families ORDER BY created_at DESC').all();
  res.json(rows);
}));

router.post('/platform/families/:id/suspend', wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  await db.prepare("UPDATE public.families SET status = 'suspended' WHERE id = ? AND slug != 'najambeta'").run(req.params.id);
  res.json({ ok:true });
}));

router.post('/platform/families/:id/reactivate', wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  await db.prepare("UPDATE public.families SET status = 'active' WHERE id = ?").run(req.params.id);
  res.json({ ok:true });
}));

// --- lightweight usage telemetry: page views + a handful of key actions, so the owner can
// see what people actually do on the platform. Deliberately best-effort — a failure here
// must never surface as a user-facing error, since it's a background signal, not a feature.
router.post('/analytics/event', express.json(), wrap(async (req,res)=>{
  try{
    const body = req.body || {};
    const eventType = String(body.event_type || '').slice(0, 60);
    if (eventType){
      const personId = req.session.user ? req.session.user.person_id : null;
      const role = req.session.user ? req.session.user.role : null;
      const page = body.page ? String(body.page).slice(0, 200) : null;
      const meta = body.meta != null ? JSON.stringify(body.meta).slice(0, 2000) : null;
      const loadMs = Number.isFinite(body.load_ms) ? Math.round(body.load_ms) : null;
      await db.prepare('INSERT INTO analytics_events (id, event_type, person_id, role, page, meta, load_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uuidv4(), eventType, personId, role, page, meta, loadMs, now());
    }
  }catch(e){ /* telemetry must never break the app */ }
  res.json({ ok:true });
}));

const ANALYTICS_PERIOD_DAYS = { today: 1, '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

router.get('/owner/analytics/summary', wrap(async (req,res)=>{
  if (!requirePlatformOwner(req,res)) return;
  const period = req.query.period || '7d';
  const days = ANALYTICS_PERIOD_DAYS[period];
  if (!days) return res.status(400).json({ error: 'invalid period' });
  const cutoff = new Date(Date.now() - days*24*60*60*1000).toISOString();

  const totalsRows = await db.prepare('SELECT event_type, COUNT(*) AS c FROM analytics_events WHERE created_at >= ? GROUP BY event_type ORDER BY c DESC').all(cutoff);
  const totals = {};
  totalsRows.forEach(r=> { totals[r.event_type] = Number(r.c); });

  const topPages = await db.prepare("SELECT page, COUNT(*) AS c FROM analytics_events WHERE created_at >= ? AND event_type = 'page_view' AND page IS NOT NULL GROUP BY page ORDER BY c DESC LIMIT 10").all(cutoff);

  const perPersonRows = await db.prepare(`
    SELECT p.full_name AS name, a.person_id,
      COUNT(*) FILTER (WHERE a.event_type = 'login') AS logins,
      COUNT(*) FILTER (WHERE a.event_type = 'page_view') AS page_views,
      AVG(a.load_ms) FILTER (WHERE a.event_type = 'page_view' AND a.load_ms IS NOT NULL) AS avg_load_ms,
      MAX(a.created_at) AS last_active
    FROM analytics_events a LEFT JOIN people p ON p.id = a.person_id
    WHERE a.created_at >= ? AND a.person_id IS NOT NULL
    GROUP BY p.full_name, a.person_id
    ORDER BY last_active DESC
    LIMIT 50
  `).all(cutoff);

  res.json({
    period, cutoff,
    totals,
    topPages: topPages.map(r=> ({ page: r.page, count: Number(r.c) })),
    perPerson: perPersonRows.map(r=> ({
      name: r.name || 'Unknown', logins: Number(r.logins), pageViews: Number(r.page_views),
      avgLoadMs: r.avg_load_ms != null ? Math.round(r.avg_load_ms) : null, lastActive: r.last_active,
    })),
  });
}));

// Admin: update person with multipart (photo). Also handles new_password, same as above.
router.post('/admin/people/:id/update-multipart', upload.single('photo'), wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
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

// shared by the single-person and cascading delete paths: soft-delete one person, detach
// their login, drop every relationship row that mentions them (in either direction — a
// deleted person should vanish from everyone else's relatives too, not just lose their own
// links), and file the usual rejected-request audit entry. Deliberately leaves anyone who
// was only related *to* this person otherwise untouched, even if that leaves them with no
// relationships left in the tree — that's expected, not an error state, and the admin can
// always give them new ones later via the relation editor on "Modify account".
async function deletePersonRecord(dbLike, id, reviewerId){
  await dbLike.prepare('UPDATE people SET approval_status = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?').run('deleted', reviewerId, now(), id);
  await dbLike.prepare('UPDATE users SET person_id = NULL WHERE person_id = ?').run(id);
  await dbLike.prepare('DELETE FROM relationships WHERE person_id = ? OR relative_id = ?').run(id, id);
  const rid = uuidv4();
  const payload = { type: 'delete_person', person_id: id, deleted_by: reviewerId, deleted_at: now() };
  await dbLike.prepare('INSERT INTO requests (id, type, payload, status, created_by, created_at, reviewed_by, reviewed_at, review_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(rid, 'delete_person', JSON.stringify(payload), 'rejected', reviewerId, now(), reviewerId, now(), 'deleted by admin');
}

// Admin: delete person (soft-delete and cleanup relationships/users), optionally cascading to
// any subset of their direct relatives (father/mother/spouse/children) the admin also chose
// to take down in the same action — see GET /admin/people/:id/relatives, which is what the
// confirmation UI lists them from.
router.post('/admin/people/:id/delete', express.json(), wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const id = req.params.id;
  const alsoDelete = (req.body && Array.isArray(req.body.also_delete)) ? req.body.also_delete.filter(x=> x && x !== id) : [];
  try{
    await db.transaction(async (tx) => {
      for (const targetId of [id, ...new Set(alsoDelete)]){
        await deletePersonRecord(tx, targetId, req.session.user.id);
      }
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
  if (!requireAdmin(req,res)) return;
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

async function withPosterInfo(row, viewerPersonId){
  const person = row.person_id ? await db.prepare('SELECT full_name FROM people WHERE id = ?').get(row.person_id) : null;
  const out = { ...row, posted_by_name: person ? person.full_name : null, youtube_id: row.type === 'video' ? extractYouTubeId(row.url) : null };
  if (row.type === 'photo') out.file_paths = parsePhotoPaths(row.file_path);
  const likeCount = await db.prepare('SELECT COUNT(*) AS c FROM archive_likes WHERE archive_id = ?').get(row.id);
  out.like_count = Number(likeCount && likeCount.c || 0);
  out.liked_by_me = viewerPersonId ? !!(await db.prepare('SELECT id FROM archive_likes WHERE archive_id = ? AND person_id = ?').get(row.id, viewerPersonId)) : false;
  const commentCount = await db.prepare('SELECT COUNT(*) AS c FROM archive_comments WHERE archive_id = ?').get(row.id);
  out.comment_count = Number(commentCount && commentCount.c || 0);
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
  const poster = await db.prepare('SELECT full_name FROM people WHERE id = ?').get(req.session.user.person_id);
  try{
    const recipients = await getAdminRecipients();
    if (recipients.length){
      const link = `${req.protocol}://${req.get('host')}/admin.html?archiveHighlight=${encodeURIComponent(id)}`;
      await sendEmail({
        to: recipients,
        subject: `[Nah Adja Mbethe] New archive post (${type})`,
        html: `<p><strong>${poster ? poster.full_name : 'Someone'}</strong> posted a ${type} to the archive.</p><p><a href="${link}">Review and respond</a></p>`,
      });
    }
  }catch(e){ console.error('[notify] failed', e && e.message || e); }
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
  if (!requireViewerAccess(req,res)) return;
  const type = req.query.type;
  if (!['photo','audio','video'].includes(type)) return res.status(400).json({ error: 'invalid type' });
  const eventType = req.query.event_type && req.query.event_type !== 'all' ? req.query.event_type : null;
  const rows = eventType
    ? await db.prepare("SELECT * FROM archive WHERE type = ? AND approval_status = 'approved' AND event_type = ? ORDER BY created_at DESC").all(type, eventType)
    : await db.prepare("SELECT * FROM archive WHERE type = ? AND approval_status = 'approved' ORDER BY created_at DESC").all(type);
  const viewerPersonId = req.session.user.person_id;
  res.json(await Promise.all(rows.map(r=> withPosterInfo(r, viewerPersonId))));
}));

// toggle a like on an approved post — no admin approval needed, this is instant. Insert to
// like, delete to unlike; the UNIQUE(archive_id, person_id) constraint on archive_likes is
// what makes "like" idempotent per person without needing a boolean column.
router.post('/archive/:id/like', wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const archiveId = req.params.id;
  const personId = req.session.user.person_id;
  const post = await db.prepare('SELECT id FROM archive WHERE id = ?').get(archiveId);
  if (!post) return res.status(404).json({ error: 'not found' });
  const existing = await db.prepare('SELECT id FROM archive_likes WHERE archive_id = ? AND person_id = ?').get(archiveId, personId);
  if (existing){
    await db.prepare('DELETE FROM archive_likes WHERE id = ?').run(existing.id);
  } else {
    await db.prepare('INSERT INTO archive_likes (id, archive_id, person_id, created_at) VALUES (?, ?, ?, ?)').run(uuidv4(), archiveId, personId, now());
  }
  const count = await db.prepare('SELECT COUNT(*) AS c FROM archive_likes WHERE archive_id = ?').get(archiveId);
  res.json({ ok:true, liked: !existing, count: Number(count && count.c || 0) });
}));

router.get('/archive/:id/comments', wrap(async (req,res)=>{
  if (!requireViewerAccess(req,res)) return;
  const rows = await db.prepare(`SELECT c.id, c.body, c.created_at, c.person_id, p.full_name AS author_name
    FROM archive_comments c LEFT JOIN people p ON p.id = c.person_id
    WHERE c.archive_id = ? ORDER BY c.created_at ASC`).all(req.params.id);
  res.json(rows);
}));

// no admin approval needed — comments are visible the instant they're posted
router.post('/archive/:id/comments', express.json(), wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const archiveId = req.params.id;
  const body = ((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment text is required.' });
  const post = await db.prepare('SELECT id FROM archive WHERE id = ?').get(archiveId);
  if (!post) return res.status(404).json({ error: 'not found' });
  const id = uuidv4();
  await db.prepare('INSERT INTO archive_comments (id, archive_id, person_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, archiveId, req.session.user.person_id, body, now());
  const person = await db.prepare('SELECT full_name FROM people WHERE id = ?').get(req.session.user.person_id);
  res.json({ ok:true, id, created_at: now(), author_name: person ? person.full_name : null });
}));

// admin: delete a single comment (e.g. inappropriate content) — no notification to the
// commenter, matches how a post rejection/deletion already works silently
router.post('/admin/archive/comments/:commentId/delete', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  await db.prepare('DELETE FROM archive_comments WHERE id = ?').run(req.params.commentId);
  res.json({ ok:true });
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
  const row = await db.prepare('SELECT * FROM archive WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  await db.prepare("UPDATE archive SET approval_status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(req.session.user.id, now(), req.params.id);
  res.json({ ok:true });
  const poster = row.person_id ? await db.prepare('SELECT full_name FROM people WHERE id = ?').get(row.person_id) : null;
  await notifyMembers(req, {
    subject: `New ${row.type} in the family archive`,
    bodyHtml: `<p><strong>${poster ? poster.full_name : 'Someone'}</strong> posted a new ${row.type} to the family archive.</p>`,
    link: `/archives.html?tab=${row.type}&highlight=${row.id}`,
  });
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

// --- family events: a scheduled happening (wedding, reunion, funeral, ...) with a date/
// time/location — distinct from archive.event_type, which just tags an existing post as
// being *about* an event. Browsable from archives.html's Events tab (full detail, logged-in
// only) and counted down to on the login page and tree.html (title + date only, no location/
// description, visible to anyone since the login page has no session yet). Approval-gated
// exactly like an archive post — its own approval_status, not the generic requests queue.
router.post('/events', express.json(), wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const body = req.body || {};
  const title = (body.title || '').trim();
  const eventAt = body.event_at || null;
  if (!title) return res.status(400).json({ error: 'A title is required.' });
  if (!eventAt || !isFinite(new Date(eventAt))) return res.status(400).json({ error: 'A valid date and time is required.' });

  const id = uuidv4();
  await db.prepare('INSERT INTO events (id, title, location, event_at, description, person_id, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, title, body.location || null, eventAt, body.description || null, req.session.user.person_id, req.session.user.id, now(), 'pending');
  res.json({ ok:true, id });

  const poster = await db.prepare('SELECT full_name FROM people WHERE id = ?').get(req.session.user.person_id);
  try{
    const recipients = await getAdminRecipients();
    if (recipients.length){
      const link = `${req.protocol}://${req.get('host')}/admin.html?eventHighlight=${encodeURIComponent(id)}`;
      await sendEmail({
        to: recipients,
        subject: `[Nah Adja Mbethe] New event proposed: ${title}`,
        html: `<p><strong>${poster ? poster.full_name : 'Someone'}</strong> proposed a new event: <strong>${title}</strong>.</p><p><a href="${link}">Review and respond</a></p>`,
      });
    }
  }catch(e){ console.error('[notify] failed', e && e.message || e); }
}));

// the creator or any admin/owner can edit — re-submits for approval, same as editing an
// archive post, and clears any reminders already sent since the date may have changed
router.post('/events/:id/edit', express.json(), wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const row = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const isOwnEvent = row.person_id === req.session.user.person_id;
  const isStaff = req.session.user.role && req.session.user.role !== 'member';
  if (!isOwnEvent && !isStaff) return res.status(403).json({ error: 'forbidden' });

  const body = req.body || {};
  const title = (body.title || row.title || '').trim();
  const eventAt = body.event_at || row.event_at;
  if (!title) return res.status(400).json({ error: 'A title is required.' });
  if (!isFinite(new Date(eventAt))) return res.status(400).json({ error: 'A valid date and time is required.' });

  await db.prepare(`UPDATE events SET title = ?, location = ?, event_at = ?, description = ?, approval_status = 'pending',
    reviewed_by = NULL, reviewed_at = NULL, reminder_month_sent = false, reminder_week_sent = false, reminder_day_sent = false
    WHERE id = ?`).run(title, body.location || null, eventAt, body.description || null, req.params.id);
  res.json({ ok:true });
}));

// the creator or any admin/owner can delete outright, no approval queue involved
router.post('/events/:id/delete', wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const row = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const isOwnEvent = row.person_id === req.session.user.person_id;
  const isStaff = req.session.user.role && req.session.user.role !== 'member';
  if (!isOwnEvent && !isStaff) return res.status(403).json({ error: 'forbidden' });
  await db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ ok:true });
}));

async function withEventPosterInfo(row){
  const person = row.person_id ? await db.prepare('SELECT full_name FROM people WHERE id = ?').get(row.person_id) : null;
  return { ...row, posted_by_name: person ? person.full_name : null };
}

// full detail (title, location, date, description) — approved only, for the Archives
// "Events" tab. Logged-in members/admins/owner only (requireViewerAccess, same as archive
// browsing) — the public/pre-login view is the separate, deliberately-thinner endpoint below.
router.get('/events', wrap(async (req,res)=>{
  if (!requireViewerAccess(req,res)) return;
  const rows = await db.prepare("SELECT * FROM events WHERE approval_status = 'approved' ORDER BY event_at ASC").all();
  res.json(await Promise.all(rows.map(withEventPosterInfo)));
}));

// no auth at all — shown on the login page to anyone, registered or not. Deliberately
// returns only {id, title, event_at}, never location/description, per the explicit ask that
// pre-login visitors should only see "there's an event coming up", not where/what it is.
router.get('/events/public-upcoming', wrap(async (req,res)=>{
  const rows = await db.prepare("SELECT id, title, event_at FROM events WHERE approval_status = 'approved' AND event_at > ? ORDER BY event_at ASC LIMIT 3").all(now());
  res.json(rows);
}));

// admin: list by status (mirrors GET /admin/archive)
router.get('/admin/events', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const status = (req.query.status || 'pending').toLowerCase();
  if (!['pending','approved','rejected'].includes(status)) return res.status(400).json({ error: 'invalid status' });
  const rows = await db.prepare('SELECT * FROM events WHERE approval_status = ? ORDER BY event_at ASC').all(status);
  res.json(await Promise.all(rows.map(withEventPosterInfo)));
}));

router.post('/admin/events/:id/approve', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const row = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  await db.prepare("UPDATE events SET approval_status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(req.session.user.id, now(), req.params.id);
  res.json({ ok:true });
  await notifyMembers(req, {
    subject: `New event: ${row.title}`,
    bodyHtml: `<p>A new family event has been announced: <strong>${row.title}</strong>, on ${new Date(row.event_at).toLocaleString()}.</p>`,
    link: `/archives.html?tab=events&highlight=${row.id}`,
  });
}));

router.post('/admin/events/:id/reject', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const row = await db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  await db.prepare("UPDATE events SET approval_status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(req.session.user.id, now(), req.params.id);
  res.json({ ok:true });
}));

router.post('/admin/events/:id/delete', wrap(async (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const row = await db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  await db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ ok:true });
}));

// --- feedback board: a single flat, shared chat everyone (member, admin, owner) can post
// and reply into — no approval step, no email notification, visible to any logged-in
// account with a linked profile.
router.get('/feedback', wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const rows = await db.prepare(`SELECT f.id, f.body, f.created_at, f.person_id, p.full_name AS author_name
    FROM feedback_messages f LEFT JOIN people p ON p.id = f.person_id
    ORDER BY f.created_at ASC`).all();
  res.json(rows);
}));

router.post('/feedback', express.json(), wrap(async (req,res)=>{
  if (!requireLoggedInPerson(req,res)) return;
  const body = ((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Message text is required.' });
  const id = uuidv4();
  await db.prepare('INSERT INTO feedback_messages (id, person_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(id, req.session.user.person_id, body, now());
  const person = await db.prepare('SELECT full_name FROM people WHERE id = ?').get(req.session.user.person_id);
  res.json({ ok:true, id, created_at: now(), author_name: person ? person.full_name : null });
}));

// --- notification bell: recent approved archive posts + events, merged and sorted by when
// they went live (approval time, falling back to creation time for older rows with no
// reviewed_at). "New" is whatever's newer than this user's own notifications_seen_at —
// queried fresh here rather than trusted from the session, since it changes on every bell
// open and the session is only refreshed at login.
router.get('/notifications/summary', wrap(async (req,res)=>{
  if (!requireLoggedIn(req,res)) return;
  const posts = await db.prepare(`SELECT id, type, description, COALESCE(reviewed_at, created_at) AS went_live
    FROM archive WHERE approval_status = 'approved' ORDER BY went_live DESC LIMIT 15`).all();
  const events = await db.prepare(`SELECT id, title, COALESCE(reviewed_at, created_at) AS went_live
    FROM events WHERE approval_status = 'approved' ORDER BY went_live DESC LIMIT 15`).all();
  const items = [
    ...posts.map(p => ({ id: p.id, kind: p.type, title: p.description || null, went_live: p.went_live, link: `/archives.html?tab=${p.type}&highlight=${p.id}` })),
    ...events.map(e => ({ id: e.id, kind: 'event', title: e.title, went_live: e.went_live, link: `/archives.html?tab=events&highlight=${e.id}` })),
  ].sort((a,b)=> new Date(b.went_live) - new Date(a.went_live)).slice(0, 10);

  const user = await db.prepare('SELECT notifications_seen_at FROM users WHERE id = ?').get(req.session.user.id);
  const seenAt = user && user.notifications_seen_at ? new Date(user.notifications_seen_at) : null;
  const count = seenAt ? items.filter(i => new Date(i.went_live) > seenAt).length : items.length;
  res.json({ count, items });
}));

router.post('/notifications/seen', wrap(async (req,res)=>{
  if (!requireLoggedIn(req,res)) return;
  await db.prepare('UPDATE users SET notifications_seen_at = ? WHERE id = ?').run(now(), req.session.user.id);
  res.json({ ok:true });
}));

// --- event reminder emails: 1 month / 1 week / 24 hours before, to every opted-in member
// plus every admin/owner. Triggered by Vercel Cron (see vercel.json — daily, since Vercel's
// free/hobby tier only allows daily cron granularity anyway, which is plenty of precision for
// these thresholds) hitting this route with a bearer token matching CRON_SECRET. Each
// reminder_*_sent flag is a one-way latch: once a threshold is crossed and the email goes
// out, it's marked sent and never re-sent, even if the daily check runs again tomorrow and
// the event is still within that same window (e.g. still <30 days out).
const REMINDER_THRESHOLDS = [
  { field: 'reminder_month_sent', days: 30, label: '1 month' },
  { field: 'reminder_week_sent', days: 7, label: '1 week' },
  { field: 'reminder_day_sent', days: 1, label: '24 hours' },
];
// runs entirely within whichever schema is already active on db's current tenant context
// (the caller — the loop in the route below — is responsible for that, via db.withTenant per
// family), so every `db.prepare(...)` call here stays unchanged from the single-family version
// of this route.
async function processEventRemindersForFamily(req, family){
  const events = await db.prepare("SELECT * FROM events WHERE approval_status = 'approved' AND event_at > ?").all(now());
  const memberEmails = await getMemberRecipients();
  const adminEmails = await getAdminRecipients();
  const recipients = Array.from(new Set([...memberEmails, ...adminEmails]));

  let sent = 0;
  for (const ev of events){
    const daysUntil = (new Date(ev.event_at).getTime() - Date.now()) / (24*3600*1000);
    for (const threshold of REMINDER_THRESHOLDS){
      if (ev[threshold.field]) continue;
      if (daysUntil > threshold.days) continue;
      await db.prepare(`UPDATE events SET ${threshold.field} = true WHERE id = ?`).run(ev.id);
      if (!recipients.length) continue;
      try{
        await sendEmail({
          to: recipients,
          subject: `[${family.name}] Reminder: ${ev.title} is in ${threshold.label}`,
          html: `<p><strong>${ev.title}</strong> is coming up in ${threshold.label} — ${new Date(ev.event_at).toLocaleString()}${ev.location ? ` at ${ev.location}` : ''}.</p>`
            + `<p><a href="${req.protocol}://${req.get('host')}/f/${family.slug}/archives.html?tab=events&highlight=${ev.id}">View details</a></p>`,
        });
        sent++;
      }catch(e){ console.error('[cron] reminder email failed', e && e.message || e); }
    }
  }
  return { eventsChecked: events.length, remindersSent: sent };
}

// one cron trigger, every active family — each family's events are only ever reachable
// through its own schema, so this loops db.withTenant() once per row in public.families
// rather than assuming there's just the one family the way this route originally did.
router.get('/cron/event-reminders', wrap(async (req,res)=>{
  const expected = process.env.CRON_SECRET;
  if (expected && req.headers.authorization !== `Bearer ${expected}`) return res.status(401).json({ error: 'unauthorized' });

  const families = await db.prepare("SELECT * FROM public.families WHERE status = 'active'").all();
  let totalEventsChecked = 0, totalRemindersSent = 0;
  for (const family of families){
    try{
      const { eventsChecked, remindersSent } = await db.withTenant(family.schema_name, () => processEventRemindersForFamily(req, family));
      totalEventsChecked += eventsChecked;
      totalRemindersSent += remindersSent;
    }catch(e){ console.error('[cron] reminders failed for family', family.slug, e && e.message || e); }
  }
  res.json({ ok: true, familiesChecked: families.length, eventsChecked: totalEventsChecked, remindersSent: totalRemindersSent });
}));

module.exports = router;
