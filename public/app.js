async function api(path, opts={}){
  const merged = Object.assign({}, opts, { credentials: 'same-origin' });
  const res = await fetch('/api'+path, merged);
  const ct = res.headers.get('content-type')||'';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// Downscale a photo client-side before upload (max ~1600px edge, ~80% JPEG quality) so
// phone-camera photos stay comfortably under the server's upload size limit, which itself
// sits under Vercel's fixed 4.5MB serverless request-body ceiling. Falls back to the
// original file untouched if anything goes wrong (e.g. a non-image file slipping through,
// or an older browser lacking canvas support) rather than blocking the upload.
async function downscalePhoto(file, maxEdge=1600, quality=0.8){
  if (!file || !file.type || !file.type.startsWith('image/')) return file;
  try{
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1){ bitmap.close && bitmap.close(); return file; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close && bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return file;
    const newName = file.name ? file.name.replace(/\.\w+$/, '') + '.jpg' : 'photo.jpg';
    return new File([blob], newName, { type: 'image/jpeg' });
  }catch(e){
    console.warn('photo downscale skipped', e);
    return file;
  }
}

function showProfileModal(person, nodeMap, edges){
  let modal = document.getElementById('profile-modal');
  if (!modal){
    modal = document.createElement('div'); modal.id='profile-modal';
    modal.innerHTML = `<div id="profile-card"><button id="profile-close" aria-label="Close">&times;</button><div id="profile-content"></div></div>`;
    document.body.appendChild(modal);
    modal.querySelector('#profile-close').addEventListener('click', ()=> modal.style.display='none');
    modal.addEventListener('click', (e)=>{ if (e.target === modal) modal.style.display='none'; });
  }
  const content = modal.querySelector('#profile-content'); content.innerHTML = '';

  // compute relations from edges. For 'parent' rows, {from,to} mirror the relationships
  // table's {person_id,relative_id}: from = child, to = parent.
  const rels = { father: [], mother: [], siblings: [], spouses: [], children: [] };
  edges.forEach(e=>{
    if (e.type==='parent' && e.from === person.id){ // e.to is this person's parent
      const p = nodeMap[e.to]; if (p){ if ((p.gender||'').toLowerCase()==='male') rels.father.push(p); else if ((p.gender||'').toLowerCase()==='female') rels.mother.push(p); else rels.father.push(p); }
    }
    if (e.type==='parent' && e.to === person.id){ // e.from is this person's child
      const c = nodeMap[e.from]; if (c) rels.children.push(c);
    }
    if (e.type==='spouse' && (e.from===person.id || e.to===person.id)){
      const otherId = e.from===person.id ? e.to : e.from; const o = nodeMap[otherId]; if (o) rels.spouses.push(o);
    }
  });
  // siblings: persons who share a parent (dedupe full siblings who share both parents),
  // plus anyone linked via a direct 'sibling' edge (used when no shared parent is on file)
  const parentIds = edges.filter(e=> e.type==='parent' && e.from===person.id).map(e=>e.to);
  const siblingIds = new Set();
  parentIds.forEach(pid=>{
    edges.forEach(e=>{ if (e.type==='parent' && e.to===pid && e.from!==person.id){ const s = nodeMap[e.from]; if (s && !siblingIds.has(s.id)){ siblingIds.add(s.id); rels.siblings.push(s); } } });
  });
  edges.forEach(e=>{
    if (e.type==='sibling' && (e.from===person.id || e.to===person.id)){
      const otherId = e.from===person.id ? e.to : e.from;
      const s = nodeMap[otherId]; if (s && !siblingIds.has(s.id)){ siblingIds.add(s.id); rels.siblings.push(s); }
    }
  });
  // defensively dedupe every group by id — the underlying data can contain duplicate
  // relationship rows (e.g. from repeated admin edits), but each relative should show once.
  ['father','mother','spouses','children','siblings'].forEach(key=>{
    const seen = new Set();
    rels[key] = rels[key].filter(p=> p && !seen.has(p.id) && seen.add(p.id));
  });

  const age = (p)=>{
    if (!p.birth_year) return '';
    const end = p.death_date ? new Date(p.death_date).getFullYear() : new Date().getFullYear();
    const yrs = end - p.birth_year;
    return isFinite(yrs) && yrs>=0 ? (p.death_date ? t('profile_yrs_at_death',{n:yrs}) : t('profile_yrs_old',{n:yrs})) : '';
  };

  const genderLabel = (g)=>{ const k=(g||'').toLowerCase(); return k==='male'?t('male'):k==='female'?t('female'):(g?t('other'):''); };

  const header = document.createElement('div'); header.className = 'profile-header';
  const img = document.createElement('img'); img.className = 'profile-photo';
  img.src = person.photo_path || '/profile_icons/Female_profile_icon.jfif';
  img.addEventListener('error', ()=>{ img.src = '/profile_icons/Female_profile_icon.jfif'; });
  header.appendChild(img);
  const headText = document.createElement('div');
  const nameRow = document.createElement('h3'); nameRow.className='profile-name'; nameRow.textContent = person.full_name || 'Unknown';
  headText.appendChild(nameRow);
  const sub = document.createElement('div'); sub.className = 'profile-sub';
  const bits = [];
  if (person.gender) bits.push(genderLabel(person.gender));
  const born = person.birth_date || person.birth_year;
  if (born) bits.push((person.death_date ? `${born} – ${person.death_date}` : `${t('profile_born')} ${born}`));
  const ageStr = age(person); if (ageStr) bits.push(ageStr);
  if (person.death_date) bits.push(t('profile_deceased'));
  sub.textContent = bits.join(' · ');
  headText.appendChild(sub);
  header.appendChild(headText);
  content.appendChild(header);

  const details = document.createElement('div'); details.className = 'profile-details';
  const row = (label, value)=>{ if (!value) return ''; return `<div class="profile-detail-row"><span class="profile-detail-label">${label}</span><span>${value}</span></div>`; };
  details.innerHTML = [
    row(t('profile_occupation'), person.occupation),
    row(t('profile_residence'), person.residence),
    row(t('profile_phone'), person.phone)
  ].filter(Boolean).join('') || `<div class="profile-detail-row profile-detail-empty">${t('profile_no_details')}</div>`;
  content.appendChild(details);

  const relSection = document.createElement('div'); relSection.className = 'profile-relations';
  const mkGroup = (label, arr)=>{
    if (!arr.length) return;
    const group = document.createElement('div'); group.className = 'profile-rel-group';
    const lab = document.createElement('div'); lab.className = 'profile-rel-label'; lab.textContent = label; group.appendChild(lab);
    const chips = document.createElement('div'); chips.className = 'profile-rel-chips';
    arr.forEach(p=>{
      const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'profile-rel-chip';
      chip.textContent = p.full_name || 'Unknown';
      chip.addEventListener('click', ()=> showProfileModal(p, nodeMap, edges));
      chips.appendChild(chip);
    });
    group.appendChild(chips);
    relSection.appendChild(group);
  };
  mkGroup(t('profile_father'), rels.father);
  mkGroup(t('profile_mother'), rels.mother);
  mkGroup(t('profile_spouses'), rels.spouses);
  mkGroup(t('profile_children'), rels.children);
  mkGroup(t('profile_siblings'), rels.siblings);
  if (!relSection.children.length){ const none = document.createElement('div'); none.className='profile-detail-row profile-detail-empty'; none.textContent = t('profile_no_relatives'); relSection.appendChild(none); }
  content.appendChild(relSection);

  // self-service actions — only offered when viewing one's own profile
  if (window.myPersonId && person.id === window.myPersonId){
    const actions = document.createElement('div'); actions.className = 'profile-actions';
    const editBtn = document.createElement('button'); editBtn.type='button'; editBtn.textContent = t('profile_edit_btn');
    editBtn.addEventListener('click', ()=>{ modal.style.display='none'; openEditProfileModal(person); });
    actions.appendChild(editBtn);
    const addRow = document.createElement('div'); addRow.className = 'profile-actions-add';
    [['spouse','profile_add_spouse'],['child','profile_add_child'],['sibling','profile_add_sibling']].forEach(([rel,key])=>{
      const btn = document.createElement('button'); btn.type='button'; btn.className='secondary'; btn.textContent = t(key);
      btn.addEventListener('click', ()=>{ modal.style.display='none'; openAddRelativeModal(rel, person); });
      addRow.appendChild(btn);
    });
    actions.appendChild(addRow);
    content.appendChild(actions);
  }

  modal.style.display='flex';
}

// --- password visibility toggle, applied to every password field on every page ---
function eyeIconSVG(open){
  return open
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 4.24A9.9 9.9 0 0 1 12 4c7 0 11 7 11 7a13.2 13.2 0 0 1-3.4 3.9M6.5 6.5C3.9 8.2 2 11 2 11s4 7 11 7c1.4 0 2.7-.3 3.9-.7"/></svg>';
}
function wrapPasswordField(input){
  if (!input || input.dataset.pwToggled) return;
  input.dataset.pwToggled = '1';
  const wrapper = document.createElement('div'); wrapper.className = 'password-field';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'password-toggle'; btn.tabIndex = -1;
  btn.setAttribute('aria-label', 'Show password');
  btn.innerHTML = eyeIconSVG(false);
  btn.addEventListener('click', ()=>{
    const willShow = input.type === 'password';
    input.type = willShow ? 'text' : 'password';
    btn.innerHTML = eyeIconSVG(willShow);
    btn.setAttribute('aria-label', willShow ? 'Hide password' : 'Show password');
  });
  wrapper.appendChild(btn);
}
function initPasswordToggles(root){
  (root || document).querySelectorAll('input[type="password"]').forEach(wrapPasswordField);
}
initPasswordToggles(document);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ()=> initPasswordToggles(document));

// --- self-service: edit my profile (pending admin approval) ---
function openEditProfileModal(person){
  let modal = document.getElementById('edit-profile-modal');
  if (!modal){
    modal = document.createElement('div'); modal.id = 'edit-profile-modal';
    modal.innerHTML = `
      <div id="edit-profile-card">
        <button id="edit-profile-close" aria-label="Close">&times;</button>
        <h3 data-i18n="ep_title">Edit my profile</h3>
        <form id="edit-profile-form">
          <label data-i18n="ep_photo">Photo<input type="file" id="ep-photo" accept="image/*" /></label>
          <label data-i18n="ep_fullname">Full name<input type="text" id="ep-fullname" required /></label>
          <label data-i18n="ep_gender">Gender<select id="ep-gender"><option value="male" data-i18n="male">Male</option><option value="female" data-i18n="female">Female</option><option value="other" data-i18n="other">Other</option></select></label>
          <label data-i18n="ep_birthdate">Birth date<input type="date" id="ep-birthdate" /></label>
          <label data-i18n="ep_occupation">Occupation<input type="text" id="ep-occupation" /></label>
          <label data-i18n="ep_residence">Residence<input type="text" id="ep-residence" /></label>
          <label data-i18n="ep_phone">Phone<input type="text" id="ep-phone" /></label>
          <button type="submit" data-i18n="ep_submit">Submit for admin approval</button>
        </form>
        <div id="edit-profile-feedback" class="hint"></div>
        <hr />
        <h4 data-i18n="ep_change_password_title">Change password</h4>
        <p class="hint" data-i18n="ep_change_password_hint">This applies immediately — it doesn't need admin approval.</p>
        <form id="change-password-form">
          <label data-i18n="ep_current_password">Current password<input type="password" id="cp-current" required /></label>
          <label data-i18n="ep_new_password">New password<input type="password" id="cp-new" required /></label>
          <label data-i18n="ep_confirm_password">Confirm new password<input type="password" id="cp-confirm" required /></label>
          <button type="submit" data-i18n="ep_change_password_btn">Change password</button>
        </form>
        <div id="change-password-feedback" class="hint"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#edit-profile-close').addEventListener('click', ()=> modal.style.display='none');
    modal.addEventListener('click', (e)=>{ if (e.target === modal) modal.style.display='none'; });
    modal.querySelector('#edit-profile-form').addEventListener('submit', submitEditProfile);
    modal.querySelector('#change-password-form').addEventListener('submit', submitChangePassword);
    initPasswordToggles(modal);
    applyI18n();
  }
  modal.querySelector('#ep-fullname').value = person.full_name || '';
  modal.querySelector('#ep-gender').value = (person.gender || 'male').toLowerCase();
  modal.querySelector('#ep-birthdate').value = person.birth_date || '';
  modal.querySelector('#ep-occupation').value = person.occupation || '';
  modal.querySelector('#ep-residence').value = person.residence || '';
  modal.querySelector('#ep-phone').value = person.phone || '';
  modal.querySelector('#ep-photo').value = '';
  modal.querySelector('#edit-profile-feedback').textContent = '';
  modal.querySelector('#change-password-feedback').textContent = '';
  modal.querySelector('#change-password-form').reset();
  modal.style.display = 'flex';
}

async function submitEditProfile(e){
  e.preventDefault();
  const modal = document.getElementById('edit-profile-modal');
  const feedback = modal.querySelector('#edit-profile-feedback');
  feedback.textContent = t('ep_submitting');
  const data = new FormData();
  data.append('full_name', modal.querySelector('#ep-fullname').value);
  data.append('gender', modal.querySelector('#ep-gender').value);
  data.append('birth_date', modal.querySelector('#ep-birthdate').value);
  data.append('occupation', modal.querySelector('#ep-occupation').value);
  data.append('residence', modal.querySelector('#ep-residence').value);
  data.append('phone', modal.querySelector('#ep-phone').value);
  const photoEl = modal.querySelector('#ep-photo');
  if (photoEl.files && photoEl.files[0]) data.append('photo', await downscalePhoto(photoEl.files[0]));
  try{
    const res = await fetch('/api/member/profile/update', { method:'POST', body:data, credentials:'same-origin' });
    const j = await res.json();
    feedback.textContent = j.ok ? t('ep_submitted_ok') : (j.error || t('ep_error_generic'));
  }catch(err){ feedback.textContent = t('network_error'); }
}

async function submitChangePassword(e){
  e.preventDefault();
  const modal = document.getElementById('edit-profile-modal');
  const feedback = modal.querySelector('#change-password-feedback');
  const current = modal.querySelector('#cp-current').value;
  const nextPwd = modal.querySelector('#cp-new').value;
  const confirmPwd = modal.querySelector('#cp-confirm').value;
  if (nextPwd !== confirmPwd){ feedback.textContent = t('ep_password_mismatch'); return; }
  feedback.textContent = t('ep_password_updating');
  try{
    const res = await fetch('/api/member/password', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify({ current_password: current, new_password: nextPwd }) });
    const j = await res.json();
    if (j.ok){ feedback.textContent = t('ep_password_changed'); e.target.reset(); }
    else feedback.textContent = j.error || t('ep_error_generic');
  }catch(err){ feedback.textContent = t('network_error'); }
}

// --- self-service: add a spouse / child / sibling (pending admin approval) ---
async function openAddRelativeModal(relation, person){
  let modal = document.getElementById('add-relative-modal');
  if (!modal){
    modal = document.createElement('div'); modal.id = 'add-relative-modal';
    modal.innerHTML = `
      <div id="add-relative-card">
        <button id="add-relative-close" aria-label="Close">&times;</button>
        <h3 id="ar-title">Add relative</h3>
        <label data-i18n="ar_fullname">Full name<input type="text" id="ar-name" /></label>
        <div id="ar-matches" class="parent-matches"></div>
        <div id="ar-new-fields" class="parent-new-fields hidden">
          <p class="hint" data-i18n="ar_new_hint">No matching profile found. Fill in what you know — the admin will review it.</p>
          <label data-i18n="ar_gender">Gender<select id="ar-gender"><option value="male" data-i18n="male">Male</option><option value="female" data-i18n="female">Female</option><option value="other" data-i18n="other">Other</option></select></label>
          <label data-i18n="ar_birthdate">Birth date<input type="date" id="ar-birthdate" /></label>
          <label data-i18n="ar_occupation">Occupation<input type="text" id="ar-occupation" /></label>
          <label data-i18n="ar_residence">Residence<input type="text" id="ar-residence" /></label>
          <label data-i18n="ar_phone">Phone<input type="text" id="ar-phone" /></label>
          <label data-i18n="ar_photo">Photo<input type="file" id="ar-photo" accept="image/*" /></label>
          <div id="ar-extra"></div>
          <label data-i18n="ar_username">Username (their login id)<input type="text" id="ar-username" autocomplete="off" /></label>
          <label data-i18n="ar_password">Password<input type="password" id="ar-password" autocomplete="new-password" /></label>
        </div>
        <button type="button" id="ar-submit" data-i18n="ar_submit">Submit for admin approval</button>
        <div id="ar-feedback" class="hint"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#add-relative-close').addEventListener('click', ()=> modal.style.display='none');
    modal.addEventListener('click', (e)=>{ if (e.target === modal) modal.style.display='none'; });
    initPasswordToggles(modal);
    applyI18n();
  }

  const titleKeyMap = { spouse: 'ar_title_spouse', child: 'ar_title_child', sibling: 'ar_title_sibling' };
  modal.querySelector('#ar-title').textContent = t(titleKeyMap[relation]) || 'Add relative';

  const nameInput = modal.querySelector('#ar-name');
  const matchesEl = modal.querySelector('#ar-matches');
  const newFields = modal.querySelector('#ar-new-fields');
  const extraEl = modal.querySelector('#ar-extra');
  const feedback = modal.querySelector('#ar-feedback');
  const submitBtn = modal.querySelector('#ar-submit');

  nameInput.value = '';
  matchesEl.innerHTML = '';
  newFields.classList.add('hidden');
  extraEl.innerHTML = '';
  feedback.textContent = '';
  modal.querySelector('#ar-gender').value = 'male';
  modal.querySelector('#ar-birthdate').value = '';
  modal.querySelector('#ar-occupation').value = '';
  modal.querySelector('#ar-residence').value = '';
  modal.querySelector('#ar-phone').value = '';
  modal.querySelector('#ar-photo').value = '';
  modal.querySelector('#ar-username').value = '';
  modal.querySelector('#ar-password').value = '';
  let matchedId = null;

  // relation-specific extra fields need current family context (existing spouse/parents)
  let context = { spouses: [], father: null, mother: null };
  if (relation === 'child' || relation === 'sibling'){
    try{ context = await api('/member/context'); }catch(e){ /* keep defaults */ }
  }
  if (relation === 'child' && context.spouses && context.spouses.length){
    const label = document.createElement('label'); label.textContent = t('ar_other_parent');
    const select = document.createElement('select'); select.id = 'ar-other-parent';
    const noneOpt = document.createElement('option'); noneOpt.value=''; noneOpt.textContent=t('ar_other_parent_none'); select.appendChild(noneOpt);
    context.spouses.forEach(s=>{ const opt = document.createElement('option'); opt.value=s.id; opt.textContent=s.full_name; select.appendChild(opt); });
    if (context.spouses.length===1) select.value = context.spouses[0].id;
    label.appendChild(select);
    extraEl.appendChild(label);
  }
  if (relation === 'sibling' && (context.father || context.mother)){
    if (context.father){
      const lab = document.createElement('label'); lab.className = 'checkbox-label';
      const cb = document.createElement('input'); cb.type='checkbox'; cb.id='ar-via-father'; cb.checked = true;
      lab.appendChild(cb); lab.append(' ' + t('ar_via_father', {name: context.father.full_name}));
      extraEl.appendChild(lab);
    }
    if (context.mother){
      const lab = document.createElement('label'); lab.className = 'checkbox-label';
      const cb = document.createElement('input'); cb.type='checkbox'; cb.id='ar-via-mother'; cb.checked = true;
      lab.appendChild(cb); lab.append(' ' + t('ar_via_mother', {name: context.mother.full_name}));
      extraEl.appendChild(lab);
    }
  }

  async function runSearch(){
    matchedId = null;
    const q = nameInput.value.trim();
    matchesEl.innerHTML = '';
    if (!q){ newFields.classList.add('hidden'); return; }
    let people = [];
    try{ people = await api('/people/search?name=' + encodeURIComponent(q)); }catch(e){ people = []; }
    if (!Array.isArray(people) || people.length === 0){
      matchesEl.innerHTML = `<div class="hint">${t('parent_match_not_found')}</div>`;
      newFields.classList.remove('hidden');
      return;
    }
    newFields.classList.add('hidden');
    const list = document.createElement('div'); list.className = 'parent-match-list';
    people.forEach(p=>{
      const row = document.createElement('div'); row.className = 'parent-match-row';
      row.innerHTML = `<span>${p.full_name} <span class="hint">(${p.birth_date || p.birth_year || t('parent_match_no_dob')})</span></span>`;
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = t('parent_match_this_is_them');
      btn.addEventListener('click', ()=>{
        matchedId = p.id;
        matchesEl.innerHTML = '';
        const chosen = document.createElement('div'); chosen.className = 'parent-match-chosen';
        chosen.innerHTML = `<span>${t('parent_match_linked')} <strong>${p.full_name}</strong></span>`;
        const change = document.createElement('button'); change.type = 'button'; change.className = 'secondary'; change.textContent = t('parent_match_change');
        change.addEventListener('click', ()=>{ matchedId = null; matchesEl.innerHTML = ''; runSearch(); });
        chosen.appendChild(change);
        matchesEl.appendChild(chosen);
        newFields.classList.add('hidden');
      });
      row.appendChild(btn);
      list.appendChild(row);
    });
    const noneBtn = document.createElement('button'); noneBtn.type = 'button'; noneBtn.className = 'secondary'; noneBtn.textContent = t('parent_match_none');
    noneBtn.addEventListener('click', ()=>{ matchesEl.innerHTML = ''; newFields.classList.remove('hidden'); });
    matchesEl.appendChild(list);
    matchesEl.appendChild(noneBtn);
  }
  nameInput.onblur = runSearch;

  submitBtn.onclick = async ()=>{
    feedback.textContent = t('ar_submitting');
    const data = new FormData();
    data.append('relation', relation);
    if (matchedId){
      data.append('matched_person_id', matchedId);
    } else {
      const name = nameInput.value.trim();
      if (!name){ feedback.textContent = t('ar_error_name_required'); return; }
      const username = modal.querySelector('#ar-username').value.trim();
      const password = modal.querySelector('#ar-password').value;
      if (!username || !password){ feedback.textContent = t('ar_error_creds_required'); return; }
      data.append('full_name', name);
      data.append('gender', modal.querySelector('#ar-gender').value);
      data.append('birth_date', modal.querySelector('#ar-birthdate').value);
      data.append('occupation', modal.querySelector('#ar-occupation').value);
      data.append('residence', modal.querySelector('#ar-residence').value);
      data.append('phone', modal.querySelector('#ar-phone').value);
      data.append('username', username);
      data.append('password', password);
      const photoEl = modal.querySelector('#ar-photo');
      if (photoEl.files && photoEl.files[0]) data.append('photo', await downscalePhoto(photoEl.files[0]));
    }
    if (relation === 'child'){
      const sel = modal.querySelector('#ar-other-parent');
      if (sel && sel.value) data.append('other_parent_id', sel.value);
    }
    if (relation === 'sibling'){
      const fCb = modal.querySelector('#ar-via-father');
      const mCb = modal.querySelector('#ar-via-mother');
      data.append('link_via_father', fCb ? String(fCb.checked) : 'true');
      data.append('link_via_mother', mCb ? String(mCb.checked) : 'true');
    }
    try{
      const res = await fetch('/api/member/relatives/add', { method:'POST', body:data, credentials:'same-origin' });
      const j = await res.json();
      if (j.ok){ feedback.textContent = t('ar_submitted_ok'); setTimeout(()=>{ modal.style.display='none'; }, 1400); }
      else feedback.textContent = j.error || t('ep_error_generic');
    }catch(err){ feedback.textContent = t('network_error'); }
  };

  modal.style.display = 'flex';
}

const loginForm = document.getElementById('login-form');
if (loginForm){
  loginForm.addEventListener('submit', async e=>{
    e.preventDefault();
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    const feedback = document.getElementById('login-feedback');
    try{
      const r = await api('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
      if (r.ok){
        location.href = (r.role === 'member') ? '/tree.html' : '/admin.html';
      } else {
        feedback.textContent = t('login_feedback_fail');
      }
    }catch(err){
      feedback.textContent = t('login_feedback_fail');
    }
  });
}

const createProfileLink = document.getElementById('create-profile');
if (createProfileLink){
  createProfileLink.addEventListener('click', e=>{
    // link is to /register.html; allow default navigation when present
  });
}

// admin link navigates to /admin-login.html; no inline handler needed
const adminLink = document.getElementById('admin-link');

// --- Registration: parent name matching against existing approved profiles ---
function setupParentMatcher(prefix){
  const nameInput = document.getElementById(prefix + '_name');
  if (!nameInput) return;
  const matchesEl = document.getElementById(prefix + '_matches');
  const idInput = document.getElementById(prefix + '_id');
  const newFields = document.getElementById(prefix + '_new_fields');

  function showNewFields(){ if (newFields) newFields.classList.remove('hidden'); }
  function hideNewFields(){ if (newFields) newFields.classList.add('hidden'); }

  function selectMatch(p){
    idInput.value = p.id;
    hideNewFields();
    matchesEl.innerHTML = '';
    const chosen = document.createElement('div'); chosen.className = 'parent-match-chosen';
    chosen.innerHTML = `<span>${t('parent_match_linked')} <strong>${p.full_name}</strong> (${p.birth_date || p.birth_year || t('parent_match_no_dob')})</span>`;
    const change = document.createElement('button'); change.type = 'button'; change.className = 'secondary'; change.textContent = t('parent_match_change');
    change.addEventListener('click', ()=>{ idInput.value=''; matchesEl.innerHTML=''; runSearch(); });
    chosen.appendChild(change);
    matchesEl.appendChild(chosen);
  }

  async function runSearch(){
    idInput.value = '';
    const q = nameInput.value.trim();
    matchesEl.innerHTML = '';
    if (!q){ hideNewFields(); return; }
    let people = [];
    try{ people = await api('/people/search?name=' + encodeURIComponent(q)); }catch(e){ people = []; }
    if (!Array.isArray(people) || people.length === 0){
      matchesEl.innerHTML = `<div class="hint">${t('parent_match_not_found')}</div>`;
      showNewFields();
      return;
    }
    hideNewFields();
    const list = document.createElement('div'); list.className = 'parent-match-list';
    people.forEach(p=>{
      const row = document.createElement('div'); row.className = 'parent-match-row';
      row.innerHTML = `<span>${p.full_name} <span class="hint">(${p.birth_date || p.birth_year || t('parent_match_no_dob')})</span></span>`;
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = t('parent_match_this_is_them'); btn.addEventListener('click', ()=> selectMatch(p));
      row.appendChild(btn);
      list.appendChild(row);
    });
    const noneBtn = document.createElement('button'); noneBtn.type = 'button'; noneBtn.className = 'secondary'; noneBtn.textContent = t('parent_match_none');
    noneBtn.addEventListener('click', ()=>{ matchesEl.innerHTML=''; showNewFields(); });
    matchesEl.appendChild(list);
    matchesEl.appendChild(noneBtn);
  }

  nameInput.addEventListener('blur', runSearch);
}
setupParentMatcher('father');
setupParentMatcher('mother');

// registration form submit
const registerForm = document.getElementById('register-form');
if (registerForm){
  registerForm.addEventListener('submit', async e=>{
    e.preventDefault();
    const data = new FormData();
    const maybe = id => document.getElementById(id) ? document.getElementById(id).value : '';
    data.append('username', maybe('reg-username'));
    data.append('password', maybe('reg-password'));
    data.append('full_name', maybe('reg-fullname'));
    data.append('gender', maybe('reg-gender'));
    data.append('birth_date', maybe('reg-birthdate'));
    data.append('occupation', maybe('reg-occupation'));
    data.append('residence', maybe('reg-residence'));
    data.append('phone', maybe('reg-phone'));
    const photoEl = document.getElementById('reg-photo');
    if (photoEl && photoEl.files && photoEl.files[0]) data.append('photo', await downscalePhoto(photoEl.files[0]));

    // parent fields (optional): either linked to an existing matched profile (id set by the
    // matcher UI) or full details for a brand-new profile to be created alongside this one.
    const appendParent = async (prefix)=>{
      if (!document.getElementById(prefix + '_name')) return;
      data.append(prefix + '_name', maybe(prefix + '_name'));
      const idVal = maybe(prefix + '_id');
      if (idVal){ data.append(prefix + '_id', idVal); return; }
      data.append(prefix + '_birth_date', maybe(prefix + '_birth_date'));
      data.append(prefix + '_occupation', maybe(prefix + '_occupation'));
      data.append(prefix + '_residence', maybe(prefix + '_residence'));
      data.append(prefix + '_phone', maybe(prefix + '_phone'));
      data.append(prefix + '_origin', maybe(prefix + '_origin'));
      const photoEl = document.getElementById(prefix + '_photo');
      if (photoEl && photoEl.files && photoEl.files[0]) data.append(prefix + '_photo', await downscalePhoto(photoEl.files[0]));
    };
    await appendParent('father');
    await appendParent('mother');

    const feedback = document.getElementById('register-feedback');
    if (feedback) feedback.textContent = t('reg_submitting');
    try{
      const res = await fetch('/api/auth/register', { method:'POST', body: data });
      const j = await res.json();
      if (j.ok){ if (feedback) feedback.textContent = t('reg_submitted_ok'); setTimeout(()=>{ location.href = '/'; }, 1400); }
      else if (feedback) feedback.textContent = j && j.error ? j.error : t('reg_error_generic');
    }catch(err){ if (feedback) feedback.textContent = t('network_error'); }
  });
}

const backToLanding = document.getElementById('back-to-landing');
if (backToLanding){ backToLanding.addEventListener('click', async ()=>{ await api('/auth/logout',{method:'POST'}); location.href = '/'; }); }

async function loadTree(){
  const svg = document.getElementById('tree-svg');
  svg.innerHTML = '';
  const me = await api('/auth/me');
  const person = me.person;
  if (!person) { svg.innerHTML = `<text x="20" y="20">${t('tree_not_logged_in')}</text>`; return; }
  window.myPersonId = person.id;
  // fetch full approved tree so every approved member sees the whole family
  let res = await api('/tree/full');
  // if full-tree endpoint returned no nodes (possible in some runtimes), fall back to simple people list
  if (!res || !Array.isArray(res.nodes) || res.nodes.length === 0){
    try{
      const people = await api('/people');
      res = { nodes: Array.isArray(people)? people : [], edges: [] };
    }catch(e){ res = { nodes: [], edges: [] }; }
  }
  let rootInfo = null;
  try{ rootInfo = await api('/tree/root'); }catch(e){ rootInfo = null; }
  const rootId = rootInfo && rootInfo.root ? rootInfo.root.id : null;
  renderTreeSVG(svg, res, person.id, rootId);
}

// Compute each node's generation relative to an anchor by walking parent/child/spouse
// edges outward (BFS). Ancestors of the anchor get negative levels, descendants positive,
// spouses share their partner's level. Returns { levels, visited(Set) }.
function computeGenerationLevels(anchorId, edges){
  const levels = { [anchorId]: 0 };
  const visited = new Set([anchorId]);
  const queue = [anchorId];
  while (queue.length){
    const id = queue.shift();
    const lvl = levels[id];
    // parents of id: rows where this person (id) is the "from" side of a 'parent' edge
    edges.filter(e=> e.type==='parent' && e.from===id).forEach(e=>{
      const p = e.to;
      if (!visited.has(p)){ visited.add(p); levels[p] = lvl - 1; queue.push(p); }
    });
    // children of id: rows where this person (id) is the "to" side of a 'parent' edge
    edges.filter(e=> e.type==='parent' && e.to===id).forEach(e=>{
      const c = e.from;
      if (!visited.has(c)){ visited.add(c); levels[c] = lvl + 1; queue.push(c); }
    });
    // spouses and directly-declared siblings share the same generation
    edges.filter(e=> (e.type==='spouse' || e.type==='sibling') && (e.from===id || e.to===id)).forEach(e=>{
      const s = e.from===id ? e.to : e.from;
      if (!visited.has(s)){ visited.add(s); levels[s] = lvl; queue.push(s); }
    });
  }
  return { levels, visited };
}

// SVG presentation attributes (fill/stroke) can't follow CSS custom properties, so the
// tree needs its own light/dark color set, chosen at render time from the active theme.
function getTreePalette(){
  const dark = document.body.classList.contains('dark');
  return dark ? {
    cardBg: '#1e2531', cardBg2: '#232b3a', cardBorder: '#333c4d',
    meBg: '#3a2f1c', meBorder: '#e0a458', rootBorder: '#f2bd76',
    text: '#eef1f7', muted: '#93a0b5', spouseBar: '#e0a458', siblingDash: '#7f8aa0', connector: '#414c60',
    infoBoxFill: 'rgba(224,164,88,0.16)', infoBoxStroke: '#e0a458', infoDot: '#f2bd76',
    orphanLabel: '#7f8aa0', cardShadow: 'rgba(0,0,0,0.45)'
  } : {
    cardBg: '#fffaf2', cardBg2: '#ffffff', cardBorder: '#e6d6ba',
    meBg: '#fbead0', meBorder: '#c3924f', rootBorder: '#7a4a20',
    text: '#3c2c1c', muted: '#8a7860', spouseBar: '#c3924f', siblingDash: '#a8927a', connector: '#c3ac86',
    infoBoxFill: 'rgba(169,104,63,0.1)', infoBoxStroke: '#c3924f', infoDot: '#8a4f28',
    orphanLabel: '#a49070', cardShadow: 'rgba(90,62,33,0.12)'
  };
}

function renderTreeSVG(svg, tree, centerId, rootId){
  const palette = getTreePalette();
  const nodes = tree.nodes;
  const edges = tree.edges.filter(e=> e.type==='parent' || e.type==='spouse' || e.type==='sibling');
  const nodeMap = {};
  nodes.forEach(n=> nodeMap[n.id]=n);

  if (nodes.length===0){ svg.innerHTML = `<text x="20" y="20">${t('tree_no_profiles')}</text>`; return; }
  // ensure centerId exists in nodeMap; if not, fall back to first node
  if (!nodeMap[centerId]) centerId = nodes[0].id;
  // anchor the whole layout on the admin-designated root profile so every member sees the
  // same tree, oriented the same way, regardless of who is logged in. Fall back to the
  // logged-in person if no root has been set yet.
  const anchorId = (rootId && nodeMap[rootId]) ? rootId : centerId;

  const { levels, visited } = computeGenerationLevels(anchorId, edges);
  // anyone not reachable from the anchor (disconnected branch) is still shown, grouped
  // separately below the main tree, so approved profiles are never silently hidden.
  const orphanIds = nodes.map(n=>n.id).filter(id => !visited.has(id));

  // group by level
  const groups = {};
  for (const id in levels){ const lv = levels[id]; groups[lv] = groups[lv]||[]; groups[lv].push(id); }

  // layout
  const levelHeight = 160;
  const nodeW = 200, nodeH = 70;
  const spacingX = 230;
  const svgW = svg.clientWidth || 1200;
  const svgH = svg.clientHeight || 800;

  const positions = {};
  const levelKeys = Object.keys(groups).map(Number).sort((a,b)=>a-b);
  const minLevel = levelKeys.length ? levelKeys[0] : 0;
  const topMargin = 60;
  for (const lv of levelKeys){
    const ids = groups[lv];
    // keep spouse pairs adjacent, then sort by birth_year for stable ordering
    const knownIds = ids.filter(id=> !!nodeMap[id]);
    knownIds.sort((a,b)=> (nodeMap[a].birth_year||0) - (nodeMap[b].birth_year||0));
    const ordered = [];
    const placed = new Set();
    knownIds.forEach(id=>{
      if (placed.has(id)) return;
      ordered.push(id); placed.add(id);
      const spouseEdge = edges.find(e=> e.type==='spouse' && (e.from===id || e.to===id) && levels[e.from===id?e.to:e.from]===lv);
      if (spouseEdge){
        const sid = spouseEdge.from===id ? spouseEdge.to : spouseEdge.from;
        if (!placed.has(sid) && nodeMap[sid]){ ordered.push(sid); placed.add(sid); }
      }
    });
    const totalWidth = (ordered.length-1)*spacingX;
    let startX = (svgW - totalWidth)/2;
    for (let i=0;i<ordered.length;i++){
      const id = ordered[i];
      const x = startX + i*spacingX;
      const y = topMargin + (lv - minLevel)*levelHeight;
      positions[id] = { x, y };
    }
  }

  // Lay out any disconnected branches (profiles not yet linked to the root) beneath the
  // main tree. Each disconnected branch still gets its own parent-above-child generation
  // layout, computed the same way as the main tree — it's just anchored on one of its own
  // members instead of the family root.
  let orphanLabelY = null;
  if (orphanIds.length){
    const idSet = new Set(orphanIds);
    const orphanEdges = edges.filter(e=> idSet.has(e.from) && idSet.has(e.to));
    const parentOf = {}; orphanIds.forEach(id=> parentOf[id]=id);
    const find = x=>{ while(parentOf[x]!==x){ parentOf[x]=parentOf[parentOf[x]]; x=parentOf[x]; } return x; };
    orphanEdges.forEach(e=>{ const ra=find(e.from), rb=find(e.to); if (ra!==rb) parentOf[ra]=rb; });
    const compMap = {};
    orphanIds.forEach(id=>{ const r=find(id); (compMap[r]=compMap[r]||[]).push(id); });
    const components = Object.values(compMap).sort((a,b)=> b.length-a.length || (nodeMap[a[0]].full_name||'').localeCompare(nodeMap[b[0]].full_name||''));

    const maxLevel = levelKeys.length ? levelKeys[levelKeys.length-1] : 0;
    let cursorY = topMargin + (maxLevel - minLevel)*levelHeight + levelHeight;
    orphanLabelY = cursorY - 40;

    components.forEach(comp=>{
      const { levels: localLevels } = computeGenerationLevels(comp[0], orphanEdges);
      const localLevelVals = comp.map(id=> localLevels[id]!==undefined ? localLevels[id] : 0);
      const compMin = Math.min(...localLevelVals);
      const compMax = Math.max(...localLevelVals);
      const localGroups = {};
      comp.forEach(id=>{
        const lv = (localLevels[id]!==undefined ? localLevels[id] : 0) - compMin;
        (localGroups[lv]=localGroups[lv]||[]).push(id);
      });
      Object.keys(localGroups).map(Number).sort((a,b)=>a-b).forEach(lv=>{
        const rowIds = localGroups[lv].sort((a,b)=> (nodeMap[a].birth_year||0)-(nodeMap[b].birth_year||0));
        const totalWidth = (rowIds.length-1)*spacingX;
        const startX = (svgW - totalWidth)/2;
        rowIds.forEach((id,i)=>{ positions[id] = { x: startX + i*spacingX, y: cursorY + lv*levelHeight }; });
      });
      cursorY += (compMax - compMin + 1)*levelHeight + 50;
    });
  }

  // create pan/zoom group
  const g = document.createElementNS('http://www.w3.org/2000/svg','g');
  g.setAttribute('id','viewport');
  svg.appendChild(g);

  if (orphanIds.length){
    const label = document.createElementNS('http://www.w3.org/2000/svg','text');
    label.setAttribute('x', String(svgW/2));
    label.setAttribute('y', String(orphanLabelY));
    label.setAttribute('text-anchor','middle');
    label.setAttribute('font-size','13');
    label.setAttribute('fill', palette.orphanLabel);
    label.setAttribute('font-family', "'Iowan Old Style','Palatino Linotype',Georgia,serif");
    label.textContent = t('tree_other_profiles');
    g.appendChild(label);
  }

  // draw spouse links: a short horizontal bar between partners at the same level
  edges.filter(e=> e.type==='spouse').forEach(e=>{
    const from = positions[e.from];
    const to = positions[e.to];
    if (!from || !to) return;
    if (from.y !== to.y) return; // only draw the direct same-generation spouse bar
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    const y = from.y + nodeH/2;
    line.setAttribute('x1', Math.min(from.x,to.x) + nodeW);
    line.setAttribute('y1', y);
    line.setAttribute('x2', Math.max(from.x,to.x));
    line.setAttribute('y2', y);
    line.setAttribute('stroke', palette.spouseBar);
    line.setAttribute('stroke-width', 3);
    g.appendChild(line);
  });

  // draw direct sibling links (used only when no shared parent is on file to hang an
  // elbow connector off of) as a lighter dashed bar, distinct from the marriage bar
  edges.filter(e=> e.type==='sibling').forEach(e=>{
    const from = positions[e.from];
    const to = positions[e.to];
    if (!from || !to || from.y !== to.y || from.x === to.x) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    const y = from.y + nodeH/2;
    line.setAttribute('x1', Math.min(from.x,to.x) + nodeW);
    line.setAttribute('y1', y);
    line.setAttribute('x2', Math.max(from.x,to.x));
    line.setAttribute('y2', y);
    line.setAttribute('stroke', palette.siblingDash);
    line.setAttribute('stroke-width', 2);
    line.setAttribute('stroke-dasharray', '3 4');
    g.appendChild(line);
  });

  // draw parent -> child links as elbow connectors: a couple's children hang off the
  // midpoint between the parents (or a single parent) via a vertical drop + horizontal bar,
  // matching a classic genealogy chart layout instead of crossing diagonal lines.
  const childrenByParentKey = {};
  edges.filter(e=> e.type==='parent').forEach(e=>{
    const childId = e.from, parentId = e.to;
    if (!positions[childId] || !positions[parentId]) return;
    const spouseEdge = edges.find(se=> se.type==='spouse' && (se.from===parentId || se.to===parentId));
    const coParentId = spouseEdge ? (spouseEdge.from===parentId ? spouseEdge.to : spouseEdge.from) : null;
    const key = coParentId && positions[coParentId] ? [parentId, coParentId].sort().join('|') : parentId;
    childrenByParentKey[key] = childrenByParentKey[key] || { parentIds: coParentId && positions[coParentId] ? [parentId, coParentId] : [parentId], children: new Set() };
    childrenByParentKey[key].children.add(childId);
  });

  Object.values(childrenByParentKey).forEach(({ parentIds, children })=>{
    const parentPts = parentIds.map(pid=> positions[pid]).filter(Boolean);
    if (!parentPts.length) return;
    const parentMidX = parentPts.reduce((s,p)=> s+p.x+nodeW/2, 0)/parentPts.length;
    const parentY = parentPts[0].y + nodeH;
    const dropY = parentY + levelHeight/2;
    // trunk line down from the parent(s)
    const trunk = document.createElementNS('http://www.w3.org/2000/svg','line');
    trunk.setAttribute('x1', parentMidX); trunk.setAttribute('y1', parentY);
    trunk.setAttribute('x2', parentMidX); trunk.setAttribute('y2', dropY);
    trunk.setAttribute('stroke', palette.connector); trunk.setAttribute('stroke-width', 2);
    g.appendChild(trunk);

    const childXs = Array.from(children).map(cid=> positions[cid]).filter(Boolean).map(p=> p.x + nodeW/2);
    if (!childXs.length) return;
    const minX = Math.min(parentMidX, ...childXs);
    const maxX = Math.max(parentMidX, ...childXs);
    if (childXs.length>1 || minX!==maxX){
      const bar = document.createElementNS('http://www.w3.org/2000/svg','line');
      bar.setAttribute('x1', String(minX)); bar.setAttribute('y1', String(dropY));
      bar.setAttribute('x2', String(maxX)); bar.setAttribute('y2', String(dropY));
      bar.setAttribute('stroke', palette.connector); bar.setAttribute('stroke-width', 2);
      g.appendChild(bar);
    }
    Array.from(children).forEach(cid=>{
      const cp = positions[cid]; if (!cp) return;
      const cx = cp.x + nodeW/2;
      const drop = document.createElementNS('http://www.w3.org/2000/svg','line');
      drop.setAttribute('x1', String(cx)); drop.setAttribute('y1', String(dropY));
      drop.setAttribute('x2', String(cx)); drop.setAttribute('y2', String(cp.y));
      drop.setAttribute('stroke', palette.connector); drop.setAttribute('stroke-width', 2);
      g.appendChild(drop);
    });
  });

  // draw nodes with standard SVG elements for better cross-browser rendering
  const svgNS = 'http://www.w3.org/2000/svg';
  const defaultAvatar = '/profile_icons/Female_profile_icon.jfif';
  const wrapName = (name)=>{
    const raw = (name || 'Unknown').trim();
    if (!raw) return ['Unknown'];
    const words = raw.split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words){
      const next = current ? current + ' ' + word : word;
      if (next.length <= 14){ current = next; continue; }
      if (current) lines.push(current);
      current = word;
    }
    if (current) lines.push(current);
    return lines.slice(0,2);
  };

  for (const id of Object.keys(positions)){
    const pos = positions[id];
    const n = nodeMap[id];
    if (!n) continue;

    const group = document.createElementNS(svgNS, 'g');
    group.setAttribute('class', 'node' + (id===centerId ? ' me':'') + (id===anchorId ? ' root':''));
    group.dataset.id = id;
    group.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
    group.style.cursor = 'pointer';

    const cardW = 200;
    const cardH = 70;
    const bg = document.createElementNS(svgNS, 'rect');
    bg.setAttribute('x', '0');
    bg.setAttribute('y', '0');
    bg.setAttribute('width', String(cardW));
    bg.setAttribute('height', String(cardH));
    bg.setAttribute('rx', '14');
    bg.setAttribute('ry', '14');
    bg.setAttribute('fill', id === centerId ? palette.meBg : palette.cardBg);
    bg.setAttribute('stroke', id === anchorId ? palette.rootBorder : (id === centerId ? palette.meBorder : palette.cardBorder));
    bg.setAttribute('stroke-width', (id === centerId || id === anchorId) ? '2.5' : '1.2');
    bg.setAttribute('filter', `drop-shadow(0 6px 10px ${palette.cardShadow})`);
    group.appendChild(bg);

    const clipId = `clip-${id.replace(/[^a-zA-Z0-9]/g,'')}`;
    const clip = document.createElementNS(svgNS, 'clipPath');
    clip.setAttribute('id', clipId);
    const clipCircle = document.createElementNS(svgNS, 'circle');
    clipCircle.setAttribute('cx', '30');
    clipCircle.setAttribute('cy', '35');
    clipCircle.setAttribute('r', '20');
    clip.appendChild(clipCircle);
    g.appendChild(clip);

    const img = document.createElementNS(svgNS, 'image');
    img.setAttribute('href', n.photo_path || defaultAvatar);
    img.setAttribute('x', '10');
    img.setAttribute('y', '15');
    img.setAttribute('width', '40');
    img.setAttribute('height', '40');
    img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    img.setAttribute('clip-path', `url(#${clipId})`);
    img.setAttribute('opacity', '1');
    img.addEventListener('error', () => { img.setAttribute('href', defaultAvatar); });
    group.appendChild(img);

    const lines = wrapName(n.full_name || 'Unknown');
    lines.forEach((line, idx)=>{
      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', '62');
      text.setAttribute('y', String(28 + idx * 15));
      text.setAttribute('font-size', idx === 0 ? '13' : '12');
      text.setAttribute('font-weight', idx === 0 ? '700' : '500');
      text.setAttribute('fill', palette.text);
      text.setAttribute('font-family', "'Iowan Old Style','Palatino Linotype',Georgia,serif");
      text.textContent = line;
      group.appendChild(text);
    });

    const genderLabel = document.createElementNS(svgNS, 'text');
    genderLabel.setAttribute('x', '62');
    genderLabel.setAttribute('y', '58');
    genderLabel.setAttribute('font-size', '11');
    genderLabel.setAttribute('fill', palette.muted);
    genderLabel.textContent = n.gender ? t((n.gender||'').toLowerCase()==='male'?'male':(n.gender||'').toLowerCase()==='female'?'female':'other') : '—';
    group.appendChild(genderLabel);

    const infoBtn = document.createElementNS(svgNS, 'g');
    infoBtn.setAttribute('transform', 'translate(170 13)');
    infoBtn.style.cursor = 'pointer';
    infoBtn.addEventListener('click', (evt)=>{ evt.preventDefault(); evt.stopPropagation(); showProfileModal(n, nodeMap, edges); });
    const infoBox = document.createElementNS(svgNS, 'rect');
    infoBox.setAttribute('x', '0');
    infoBox.setAttribute('y', '0');
    infoBox.setAttribute('width', '18');
    infoBox.setAttribute('height', '18');
    infoBox.setAttribute('rx', '5');
    infoBox.setAttribute('fill', palette.infoBoxFill);
    infoBox.setAttribute('stroke', palette.infoBoxStroke);
    infoBtn.appendChild(infoBox);
    for (let i = 0; i < 3; i++){
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', String(9 + i * 0));
      dot.setAttribute('cy', String(9));
      dot.setAttribute('r', '2');
      dot.setAttribute('fill', palette.infoDot);
      infoBtn.appendChild(dot);
    }
    group.appendChild(infoBtn);

    const cardArea = document.createElementNS(svgNS, 'rect');
    cardArea.setAttribute('x', '0');
    cardArea.setAttribute('y', '0');
    cardArea.setAttribute('width', String(cardW));
    cardArea.setAttribute('height', String(cardH));
    cardArea.setAttribute('fill', 'transparent');
    cardArea.style.pointerEvents = 'all';
    group.appendChild(cardArea);

    group.addEventListener('click', (evt)=>{ evt.stopPropagation(); showProfileModal(n, nodeMap, edges); });
    g.appendChild(group);
  }

  // setup pan/zoom, then center the initial view on the logged-in member's own card —
  // otherwise a member whose card lands in a second column (e.g. they're a spouse, not
  // the left-hand member of the pair) can find their own node rendered off-screen,
  // especially on a narrow phone viewport
  const panZoom = initPanZoom(svg, g);
  svg.__panZoom = panZoom;
  const myNode = svg.querySelector(`.node[data-id="${centerId}"]`);
  if (myNode) panZoom.centerOnNode(myNode);
}

// Returns a controller so callers (auto-center on load, the "Center on me" button) can
// move the view without desyncing from the pan/zoom gesture state — setting the SVG
// transform directly from outside, without going through here, would get silently
// overwritten by the next drag/wheel event since this closure wouldn't know about it.
function initPanZoom(svg, viewport){
  let scale = 1; let tx = 0; let ty = 0; let dragging=false; let lastX=0; let lastY=0;
  function apply(){ viewport.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`); }
  svg.addEventListener('wheel', e=>{ e.preventDefault(); const delta = -e.deltaY*0.001; const oldScale = scale; scale = Math.min(3, Math.max(0.2, scale*(1+delta))); // zoom to pointer
    const rect = svg.getBoundingClientRect(); const px = e.clientX - rect.left; const py = e.clientY - rect.top; tx -= (px/oldScale - px/scale); ty -= (py/oldScale - py/scale); apply(); });
  svg.addEventListener('pointerdown', e=>{
    // don't hijack clicks on a node (card body / info button) into a canvas drag —
    // pointer capture retargets the resulting synthetic click away from the node subtree,
    // which silently breaks "open profile" clicks.
    if (e.target && e.target.closest && e.target.closest('.node')) return;
    dragging=true; lastX=e.clientX; lastY=e.clientY; svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e=>{ if (!dragging) return; const dx = e.clientX - lastX; const dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; tx += dx; ty += dy; apply(); });
  svg.addEventListener('pointerup', e=>{ dragging=false; try{ svg.releasePointerCapture(e.pointerId); }catch(_){} });
  return {
    // Center the view on a node, at a given scale (defaults to whatever scale is already
    // in effect). Reads the node's own translate(x,y) directly rather than getBBox() —
    // getBBox() on the node returns its LOCAL content box (~0,0), not its position within
    // #viewport, which silently centered on the wrong point.
    centerOnNode(node, targetScale){
      if (!node) return;
      const m = (node.getAttribute('transform') || '').match(/translate\(([-\d.]+)[,\s]+([-\d.]+)\)/);
      if (!m) return;
      const nodeX = parseFloat(m[1]), nodeY = parseFloat(m[2]);
      const box = node.getBBox(); // local size only (width/height), not position
      if (typeof targetScale === 'number') scale = targetScale;
      const svgW = svg.clientWidth || 1200, svgH = svg.clientHeight || 800;
      tx = svgW/2 - (nodeX + box.width/2) * scale;
      ty = svgH/2 - (nodeY + box.height/2) * scale;
      apply();
    }
  };
}

// --- hamburger sidebar (Archives + Family tree summary) ---
(function initSidebar(){
  const hamburgerBtn = document.getElementById('hamburger-btn');
  const drawer = document.getElementById('sidebar-drawer');
  const overlay = document.getElementById('sidebar-overlay');
  if (!hamburgerBtn || !drawer || !overlay) return;
  const closeBtn = document.getElementById('sidebar-close');
  const open = ()=>{ drawer.classList.add('open'); overlay.classList.add('open'); };
  const close = ()=>{ drawer.classList.remove('open'); overlay.classList.remove('open'); };
  hamburgerBtn.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', close);

  const summaryBtn = document.getElementById('sidebar-tree-summary-btn');
  const summaryPanel = document.getElementById('sidebar-tree-summary-panel');
  if (summaryBtn && summaryPanel){
    summaryBtn.addEventListener('click', ()=> summaryPanel.classList.toggle('open'));
  }
  const imgBtn = document.getElementById('download-tree-image');
  const pdfBtn = document.getElementById('download-tree-pdf');
  if (imgBtn) imgBtn.addEventListener('click', downloadTreeImage);
  if (pdfBtn) pdfBtn.addEventListener('click', downloadTreePdf);
})();

function loadImageFromBlob(blob){
  return new Promise((resolve, reject)=>{
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = ()=> resolve({ img, url });
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('render failed')); };
    img.src = url;
  });
}

// Browsers block an SVG's own external image references from loading when that SVG is
// itself displayed as an <img>/Image() — so every profile photo has to be inlined as a
// data: URI first, or the exported tree renders with empty avatar circles.
async function inlineTreeImages(svgEl){
  const images = Array.from(svgEl.querySelectorAll('image'));
  await Promise.all(images.map(async (imgEl)=>{
    const href = imgEl.getAttribute('href');
    if (!href || href.startsWith('data:')) return;
    try{
      const res = await fetch(href, { credentials: 'same-origin' });
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject)=>{
        const reader = new FileReader();
        reader.onload = ()=> resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      imgEl.setAttribute('href', dataUrl);
    }catch(e){ /* leave the original href — that one avatar just won't render */ }
  }));
}

// Render just the tree's SVG (cards + connectors, none of the surrounding page chrome)
// onto a canvas at the full extent of its content, ignoring current pan/zoom.
async function renderTreeToCanvas(){
  const svg = document.getElementById('tree-svg');
  if (!svg) throw new Error('no tree');
  const viewport = svg.querySelector('#viewport');
  const bbox = (viewport && viewport.getBBox) ? viewport.getBBox() : svg.getBBox();
  if (!bbox || !bbox.width || !bbox.height) throw new Error('empty tree');
  const pad = 40;
  const width = Math.ceil(bbox.width + pad*2);
  const height = Math.ceil(bbox.height + pad*2);

  const clone = svg.cloneNode(true);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `${bbox.x-pad} ${bbox.y-pad} ${width} ${height}`);
  const clonedViewport = clone.querySelector('#viewport');
  if (clonedViewport) clonedViewport.removeAttribute('transform');

  await inlineTreeImages(clone);

  const svgString = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const { img, url } = await loadImageFromBlob(svgBlob);

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width*scale; canvas.height = height*scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = document.body.classList.contains('dark') ? '#1c2330' : '#fffaf2';
  ctx.fillRect(0,0,width,height);
  ctx.drawImage(img, 0, 0, width, height);
  URL.revokeObjectURL(url);
  return canvas;
}

function triggerDownload(blob, filename){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

async function downloadTreeImage(){
  try{
    const canvas = await renderTreeToCanvas();
    canvas.toBlob(blob=> triggerDownload(blob, 'family-tree.png'), 'image/png');
  }catch(e){ alert(t('tree_export_error')); }
}

function dataURLToUint8Array(dataUrl){
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Hand-rolled minimal single-page PDF wrapping one JPEG image via DCTDecode — no
// external library needed since the JPEG bytes can be embedded as-is.
function buildSinglePageImagePdf(jpegBytes, pxWidth, pxHeight){
  const parts = [];
  const offsets = [];
  let byteLen = 0;
  const pushText = (str)=>{ parts.push(str); byteLen += str.length; };
  const pushBytes = (bytes)=>{ parts.push(bytes); byteLen += bytes.length; };
  const markObj = ()=> offsets.push(byteLen);

  pushText('%PDF-1.4\n');
  markObj();
  pushText('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  markObj();
  pushText('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  markObj();
  pushText(`3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /MediaBox [0 0 ${pxWidth} ${pxHeight}] /Contents 5 0 R >>\nendobj\n`);
  markObj();
  pushText(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxWidth} /Height ${pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  pushBytes(jpegBytes);
  pushText('\nendstream\nendobj\n');
  markObj();
  const content = `q ${pxWidth} 0 0 ${pxHeight} 0 0 cm /Im0 Do Q`;
  pushText(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xrefOffset = byteLen;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  offsets.forEach(off=>{ xref += String(off).padStart(10,'0') + ' 00000 n \n'; });
  pushText(xref);
  pushText(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return new Blob(parts, { type: 'application/pdf' });
}

async function downloadTreePdf(){
  try{
    const canvas = await renderTreeToCanvas();
    const jpegBytes = dataURLToUint8Array(canvas.toDataURL('image/jpeg', 0.92));
    const pdfBlob = buildSinglePageImagePdf(jpegBytes, canvas.width, canvas.height);
    triggerDownload(pdfBlob, 'family-tree.pdf');
  }catch(e){ alert(t('tree_export_error')); }
}

const centerBtn = document.getElementById('center-me');
if (centerBtn){
  centerBtn.addEventListener('click', async ()=>{
    const me = await api('/auth/me');
    const svg = document.getElementById('tree-svg');
    if (!svg || !svg.__panZoom) return;
    const node = (me.person && svg.querySelector(`.node[data-id="${me.person.id}"]`)) || svg.querySelector('.node');
    if (!node) return;
    svg.__panZoom.centerOnNode(node, 1);
  });
}

// Theme + language toggles: persist choices in localStorage
function applyTheme(theme){
  if (theme === 'dark') document.body.classList.add('dark'); else document.body.classList.remove('dark');
}

// apply the saved theme on every page, whether or not it has a visible toggle button,
// so the preference set on one page (e.g. the landing page) persists everywhere.
applyTheme(localStorage.getItem('ft_theme') || 'light');

const themeToggle = document.getElementById('theme-toggle');
if (themeToggle){
  themeToggle.addEventListener('click', ()=>{
    const cur = document.body.classList.contains('dark') ? 'dark' : 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('ft_theme', next);
    // the tree's SVG colors are presentation attributes, not CSS — re-render so it
    // picks up the new theme's palette instead of staying stuck in the old one
    if (document.getElementById('tree-svg') && typeof loadTree === 'function') loadTree();
  });
}

// --- Site-wide translation dictionary. Every static label uses data-i18n (text content)
// or data-i18n-placeholder (input placeholder); every JS-built string calls t(key). ---
const I18N = {
  en: {
    brand: 'Famille Nah Adja Mbethe',
    admin_brand: 'Famille Nah Adja Mbethe — Admin',
    male: 'Male', female: 'Female', other: 'Other',
    save: 'Save', cancel: 'Cancel', close: 'Close', back: 'Back',
    network_error: 'Network error.',

    landing_welcome: 'Welcome',
    landing_desc: 'Find your place in the family tree — log in with your username and password.',
    login_username_label: 'Username',
    login_password_label: 'Password',
    login_username_placeholder: 'e.g. jdoe',
    login_btn: 'Log in',
    login_feedback_fail: 'Incorrect username or password.',
    create_profile_link: 'Profile not found — create your own profile',
    admin_link: 'Administrator login',
    right_title: 'Family Tree',
    right_desc: "Explore ancestors, add/update profiles, and submit changes for admin approval. We keep your family's history safe and accurate.",
    admin_logout: 'Logout',
    center_me: 'Center on me',
    pending: 'Pending', approved: 'Approved', rejected: 'Rejected',

    reg_title: 'Create your profile',
    reg_username_label: "Username (this will be your login ID — must be unique)",
    reg_password_label: 'Password',
    reg_fullname_label: 'Full name',
    reg_gender_label: 'Gender',
    reg_birthdate_label: 'Birth date',
    reg_occupation_label: 'Occupation',
    reg_residence_label: 'Residence',
    reg_phone_label: 'Phone',
    reg_photo_label: 'Photo',
    reg_father_legend: 'Father (optional)',
    reg_mother_legend: 'Mother (optional)',
    reg_father_fullname_label: "Father's full name",
    reg_mother_fullname_label: "Mother's full name",
    reg_new_father_hint: 'No matching profile found. Fill in what you know so the admin can add him to the tree alongside your registration.',
    reg_new_mother_hint: 'No matching profile found. Fill in what you know so the admin can add her to the tree alongside your registration.',
    reg_origin_question_father: 'Is he originally from this family, or did he marry into it?',
    reg_origin_question_mother: 'Is she originally from this family, or did she marry into it?',
    reg_origin_family: 'Born into this family (blood relative)',
    reg_origin_married: 'Married into this family',
    reg_submit_btn: 'Submit registration (pending admin approval)',
    reg_back_link: 'Back to login',
    reg_submitting: 'Submitting...',
    reg_submitted_ok: 'Registration submitted and pending admin approval.',
    reg_error_generic: 'Something went wrong. Please try again.',
    parent_match_this_is_them: 'This is them',
    parent_match_none: 'None of these — create a new profile',
    parent_match_linked: 'Linked to existing profile:',
    parent_match_change: 'Not them / change',
    parent_match_no_dob: 'no DOB on file',
    parent_match_not_found: 'No existing profile found with this name.',

    admin_login_title: 'Administrator Login',
    admin_login_btn: 'Login',
    admin_login_failed: 'Login failed',

    admin_root_title: 'Family Tree Root Profile',
    admin_root_desc: "Every member's profile connects into the tree through this person — set them as the top-most ancestor (e.g. the family's great grandparent) so the whole tree hangs together.",
    admin_root_none: 'No root profile set yet — the tree has no fixed top. Choose or create one below.',
    admin_root_edit_btn: "Edit root's info",
    admin_root_choose_btn: 'Choose existing profile',
    admin_root_create_btn: 'Create new root profile',
    admin_root_search_placeholder: 'Search approved profiles by name...',
    admin_root_set_btn: 'Set as root',
    admin_root_no_matches: 'No matches',
    admin_root_set_confirm: 'Set {name} as the family tree root?',
    admin_root_create_fullname: 'Full name',
    admin_root_create_gender: 'Gender',
    admin_root_create_birthdate: 'Birth date',
    admin_root_create_occupation: 'Occupation',
    admin_root_create_residence: 'Residence',
    admin_root_create_photo: 'Photo',
    admin_root_create_submit: 'Create & set as root',
    admin_root_created_ok: 'Root profile created',

    admin_logout_btn: 'Logout',
    admin_refresh_btn: 'Refresh',
    admin_pending_heading: 'Requests',
    admin_no_requests: 'No {status} requests',
    req_new_person: 'New person',
    req_field_fullname: 'Full name', req_field_gender: 'Gender', req_field_birthdate: 'Birth date',
    req_field_birthyear: 'Birth year', req_field_occupation: 'Occupation', req_field_residence: 'Residence',
    req_field_phone: 'Phone', req_field_username: 'Username', req_no_photo: 'No photo',
    req_relations_label: 'Relations:',
    req_linking_existing: 'Linking to existing profile:',
    req_other_parent: 'Other parent:',
    req_not_linked_father: 'Not linked via father',
    req_not_linked_mother: 'Not linked via mother',
    req_update_title: 'Profile update — {name}',
    req_add_relative_title: 'Add {relation} — requested by {name}',
    req_relation_spouse: 'spouse', req_relation_child: 'child', req_relation_sibling: 'sibling',
    req_unknown_person: 'unknown person',
    req_from_family: '(from family)',
    btn_approve: 'Approve', btn_edit_approve: 'Edit & Approve', btn_reject: 'Reject',
    btn_modify_account: 'Modify account', btn_delete_account: 'Delete account',
    confirm_approve: 'Approve this request?',
    confirm_reject: 'Reject this request?',
    confirm_delete_account: 'Delete this account? This removes them (and their relationships) from the family tree.',
    prompt_rejection_reason: 'Reason for rejection',
    alert_approve_failed: 'Approve failed: {msg}',
    alert_reject_failed: 'Reject failed: {msg}',
    alert_delete_failed: 'Delete failed: {msg}',
    alert_person_not_found: 'Could not locate the person record for this approved request',
    edit_modal_title: 'Edit request and approve',
    edit_field_username: 'Username (optional)',
    edit_field_photo: 'Photo (replace)',
    edit_field_new_password: 'Set new password (only applies to an existing member account — leave blank to keep unchanged)',
    edit_relations_heading: 'Relations',
    edit_rel_father: 'Father', edit_rel_mother: 'Mother',
    edit_rel_name_placeholder: 'Name', edit_rel_year_placeholder: 'Birth year',
    edit_rel_from_family: 'From family',
    edit_rel_remove: 'Remove',
    edit_add_relation_btn: 'Add relation',
    edit_save_approve_btn: 'Save & Approve',
    edit_cancel_btn: 'Cancel',
    alert_person_updated: 'Person updated',
    alert_approved_with_edits: 'Approved with edits',
    alert_error_prefix: 'Error: {msg}',
    confirm_yes: 'Yes', confirm_no: 'No',
    reviewed_by_line: 'Reviewed by: {by} — {at}',
    error_loading_root: 'Error loading root profile',
    error_searching: 'Error searching',
    error_loading: 'Error loading',

    profile_born: 'Born',
    profile_deceased: 'Deceased',
    profile_yrs_old: '{n} yrs old',
    profile_yrs_at_death: '{n} yrs (at death)',
    profile_occupation: 'Occupation', profile_residence: 'Residence', profile_phone: 'Phone',
    profile_no_details: 'No additional details on file',
    profile_father: 'Father', profile_mother: 'Mother', profile_spouses: 'Spouse(s)',
    profile_children: 'Children', profile_siblings: 'Siblings',
    profile_no_relatives: 'No linked relatives yet',
    profile_edit_btn: 'Edit my profile',
    profile_add_spouse: '+ Add spouse', profile_add_child: '+ Add child', profile_add_sibling: '+ Add sibling',

    ep_title: 'Edit my profile',
    ep_photo: 'Photo', ep_fullname: 'Full name', ep_gender: 'Gender', ep_birthdate: 'Birth date',
    ep_occupation: 'Occupation', ep_residence: 'Residence', ep_phone: 'Phone',
    ep_submit: 'Submit for admin approval',
    ep_submitting: 'Submitting...',
    ep_submitted_ok: "Submitted — your changes will appear once an admin approves them.",
    ep_change_password_title: 'Change password',
    ep_change_password_hint: "This applies immediately — it doesn't need admin approval.",
    ep_current_password: 'Current password', ep_new_password: 'New password', ep_confirm_password: 'Confirm new password',
    ep_change_password_btn: 'Change password',
    ep_password_mismatch: 'New passwords do not match.',
    ep_password_updating: 'Updating...',
    ep_password_changed: 'Password changed.',
    ep_error_generic: 'Something went wrong.',

    ar_title_spouse: 'Add spouse', ar_title_child: 'Add child', ar_title_sibling: 'Add sibling',
    ar_fullname: 'Full name',
    ar_new_hint: "No matching profile found. Fill in what you know — the admin will review it.",
    ar_gender: 'Gender', ar_birthdate: 'Birth date', ar_occupation: 'Occupation', ar_residence: 'Residence',
    ar_phone: 'Phone', ar_photo: 'Photo',
    ar_username: 'Username (their login id)', ar_password: 'Password',
    ar_other_parent: 'Other parent', ar_other_parent_none: 'None / unknown',
    ar_via_father: 'Also a child of {name} (father)',
    ar_via_mother: 'Also a child of {name} (mother)',
    ar_submit: 'Submit for admin approval',
    ar_submitting: 'Submitting...',
    ar_submitted_ok: 'Submitted — pending admin approval.',
    ar_error_name_required: 'Please enter a full name.',
    ar_error_creds_required: 'Username and password are required for a new profile.',

    tree_hello: 'Hello, {name}',
    tree_logout: 'Logout',
    tree_center_me: 'Center on me',
    tree_no_profiles: 'No approved profiles to display',
    tree_other_profiles: 'Other profiles (not yet linked to the family root)',
    tree_not_logged_in: 'Not logged in',

    sidebar_menu_title: 'Menu',
    sidebar_archives: 'Archives',
    sidebar_tree_summary: 'Family tree summary',
    sidebar_download_image: 'Download as Image',
    sidebar_download_pdf: 'Download as PDF',
    tree_export_error: "Couldn't export the tree. Please try again.",

    archives_title: 'Family Archives',
    archives_back_link: 'Back to tree',
    archives_tab_photos: 'Photos',
    archives_tab_audios: 'Audios',
    archives_tab_videos: 'Videos',
    archives_new_post: '+ New post',
    archives_empty_photos: 'No approved photos yet.',
    archives_empty_audios: 'No approved audio posts yet.',
    archives_empty_videos: 'No approved videos yet.',
    archives_posted_by: 'Posted by {name} — {date}',
    archives_posted_by_unknown: 'Posted by a family member — {date}',
    np_title: 'New post',
    np_type: 'Type',
    np_type_photo: 'Photo', np_type_audio: 'Audio', np_type_video: 'YouTube video link',
    np_file_photo: 'Photo file', np_file_audio: 'Audio file',
    np_youtube_url: 'YouTube link',
    np_caption: 'Write something about this post',
    np_submit: 'Submit for admin approval',
    np_submitting: 'Submitting...',
    np_submitted_ok: 'Submitted — pending admin approval.',
    np_error_generic: 'Something went wrong.',

    admin_archive_tab: 'Archive posts',
    admin_archive_no_photo: 'No thumbnail',
    admin_archive_field_type: 'Type', admin_archive_field_caption: 'Caption',
    admin_archive_field_posted_by: 'Posted by', admin_archive_field_link: 'Link'
  },
  fr: {
    brand: 'Famille Nah Adja Mbethe',
    admin_brand: 'Famille Nah Adja Mbethe — Administration',
    male: 'Homme', female: 'Femme', other: 'Autre',
    save: 'Enregistrer', cancel: 'Annuler', close: 'Fermer', back: 'Retour',
    network_error: 'Erreur réseau.',

    landing_welcome: 'Bienvenue',
    landing_desc: "Trouvez votre place dans l'arbre généalogique — connectez-vous avec votre nom d'utilisateur et votre mot de passe.",
    login_username_label: "Nom d'utilisateur",
    login_password_label: 'Mot de passe',
    login_username_placeholder: 'ex. jdupont',
    login_btn: 'Se connecter',
    login_feedback_fail: "Nom d'utilisateur ou mot de passe incorrect.",
    create_profile_link: 'Profil introuvable — créez votre profil',
    admin_link: 'Connexion administrateur',
    right_title: 'Arbre généalogique',
    right_desc: "Explorez les ancêtres, ajoutez ou mettez à jour des profils, et soumettez des modifications pour approbation par l'administrateur. Nous gardons l'histoire familiale en sécurité.",
    admin_logout: 'Se déconnecter',
    center_me: 'Centrer sur moi',
    pending: 'En attente', approved: 'Approuvé', rejected: 'Rejeté',

    reg_title: 'Créez votre profil',
    reg_username_label: "Nom d'utilisateur (ce sera votre identifiant de connexion — doit être unique)",
    reg_password_label: 'Mot de passe',
    reg_fullname_label: 'Nom complet',
    reg_gender_label: 'Genre',
    reg_birthdate_label: 'Date de naissance',
    reg_occupation_label: 'Profession',
    reg_residence_label: 'Résidence',
    reg_phone_label: 'Téléphone',
    reg_photo_label: 'Photo',
    reg_father_legend: 'Père (optionnel)',
    reg_mother_legend: 'Mère (optionnel)',
    reg_father_fullname_label: 'Nom complet du père',
    reg_mother_fullname_label: 'Nom complet de la mère',
    reg_new_father_hint: "Aucun profil correspondant trouvé. Indiquez ce que vous savez afin que l'administrateur puisse l'ajouter à l'arbre en même temps que votre inscription.",
    reg_new_mother_hint: "Aucun profil correspondant trouvé. Indiquez ce que vous savez afin que l'administrateur puisse l'ajouter à l'arbre en même temps que votre inscription.",
    reg_origin_question_father: 'Est-il originaire de cette famille, ou s\'y est-il marié ?',
    reg_origin_question_mother: 'Est-elle originaire de cette famille, ou s\'y est-elle mariée ?',
    reg_origin_family: 'Né(e) dans cette famille (lien de sang)',
    reg_origin_married: 'Marié(e) dans cette famille',
    reg_submit_btn: "Soumettre l'inscription (en attente d'approbation)",
    reg_back_link: 'Retour à la connexion',
    reg_submitting: 'Envoi en cours...',
    reg_submitted_ok: "Inscription soumise et en attente d'approbation par l'administrateur.",
    reg_error_generic: "Une erreur s'est produite. Veuillez réessayer.",
    parent_match_this_is_them: "C'est bien lui/elle",
    parent_match_none: 'Aucun de ceux-ci — créer un nouveau profil',
    parent_match_linked: 'Lié au profil existant :',
    parent_match_change: 'Ce n\'est pas lui/elle / changer',
    parent_match_no_dob: 'aucune date de naissance enregistrée',
    parent_match_not_found: 'Aucun profil correspondant à ce nom.',

    admin_login_title: 'Connexion administrateur',
    admin_login_btn: 'Connexion',
    admin_login_failed: 'Échec de la connexion',

    admin_root_title: "Profil racine de l'arbre généalogique",
    admin_root_desc: "Le profil de chaque membre se connecte à l'arbre à travers cette personne — définissez-la comme l'ancêtre le plus élevé (par exemple l'arrière-grand-parent) afin que tout l'arbre tienne ensemble.",
    admin_root_none: "Aucun profil racine défini pour le moment — l'arbre n'a pas de sommet fixe. Choisissez-en un ou créez-en un ci-dessous.",
    admin_root_edit_btn: 'Modifier les infos de la racine',
    admin_root_choose_btn: 'Choisir un profil existant',
    admin_root_create_btn: 'Créer un nouveau profil racine',
    admin_root_search_placeholder: 'Rechercher parmi les profils approuvés par nom...',
    admin_root_set_btn: 'Définir comme racine',
    admin_root_no_matches: 'Aucun résultat',
    admin_root_set_confirm: "Définir {name} comme racine de l'arbre généalogique ?",
    admin_root_create_fullname: 'Nom complet',
    admin_root_create_gender: 'Genre',
    admin_root_create_birthdate: 'Date de naissance',
    admin_root_create_occupation: 'Profession',
    admin_root_create_residence: 'Résidence',
    admin_root_create_photo: 'Photo',
    admin_root_create_submit: 'Créer et définir comme racine',
    admin_root_created_ok: 'Profil racine créé',

    admin_logout_btn: 'Déconnexion',
    admin_refresh_btn: 'Actualiser',
    admin_pending_heading: 'Demandes',
    admin_no_requests: 'Aucune demande {status}',
    req_new_person: 'Nouvelle personne',
    req_field_fullname: 'Nom complet', req_field_gender: 'Genre', req_field_birthdate: 'Date de naissance',
    req_field_birthyear: 'Année de naissance', req_field_occupation: 'Profession', req_field_residence: 'Résidence',
    req_field_phone: 'Téléphone', req_field_username: "Nom d'utilisateur", req_no_photo: 'Aucune photo',
    req_relations_label: 'Relations :',
    req_linking_existing: 'Lien vers le profil existant :',
    req_other_parent: 'Autre parent :',
    req_not_linked_father: 'Non lié au père',
    req_not_linked_mother: 'Non lié à la mère',
    req_update_title: 'Mise à jour de profil — {name}',
    req_add_relative_title: 'Ajout de {relation} — demandé par {name}',
    req_relation_spouse: 'conjoint(e)', req_relation_child: 'enfant', req_relation_sibling: 'frère/sœur',
    req_unknown_person: 'personne inconnue',
    req_from_family: '(de la famille)',
    btn_approve: 'Approuver', btn_edit_approve: 'Modifier et approuver', btn_reject: 'Rejeter',
    btn_modify_account: 'Modifier le compte', btn_delete_account: 'Supprimer le compte',
    confirm_approve: 'Approuver cette demande ?',
    confirm_reject: 'Rejeter cette demande ?',
    confirm_delete_account: "Supprimer ce compte ? Cela retire cette personne (et ses relations) de l'arbre généalogique.",
    prompt_rejection_reason: 'Motif du rejet',
    alert_approve_failed: "Échec de l'approbation : {msg}",
    alert_reject_failed: 'Échec du rejet : {msg}',
    alert_delete_failed: 'Échec de la suppression : {msg}',
    alert_person_not_found: "Impossible de localiser la fiche de la personne pour cette demande approuvée",
    edit_modal_title: 'Modifier la demande et approuver',
    edit_field_username: "Nom d'utilisateur (optionnel)",
    edit_field_photo: 'Photo (remplacer)',
    edit_field_new_password: "Définir un nouveau mot de passe (uniquement pour un compte membre existant — laisser vide pour ne pas changer)",
    edit_relations_heading: 'Relations',
    edit_rel_father: 'Père', edit_rel_mother: 'Mère',
    edit_rel_name_placeholder: 'Nom', edit_rel_year_placeholder: 'Année de naissance',
    edit_rel_from_family: 'De la famille',
    edit_rel_remove: 'Retirer',
    edit_add_relation_btn: 'Ajouter une relation',
    edit_save_approve_btn: 'Enregistrer et approuver',
    edit_cancel_btn: 'Annuler',
    alert_person_updated: 'Personne mise à jour',
    alert_approved_with_edits: 'Approuvé avec modifications',
    alert_error_prefix: 'Erreur : {msg}',
    confirm_yes: 'Oui', confirm_no: 'Non',
    reviewed_by_line: 'Vérifié par : {by} — {at}',
    error_loading_root: 'Erreur lors du chargement du profil racine',
    error_searching: 'Erreur lors de la recherche',
    error_loading: 'Erreur de chargement',

    profile_born: 'Né(e) le',
    profile_deceased: 'Décédé(e)',
    profile_yrs_old: '{n} ans',
    profile_yrs_at_death: '{n} ans (au décès)',
    profile_occupation: 'Profession', profile_residence: 'Résidence', profile_phone: 'Téléphone',
    profile_no_details: 'Aucun détail supplémentaire enregistré',
    profile_father: 'Père', profile_mother: 'Mère', profile_spouses: 'Conjoint(e)(s)',
    profile_children: 'Enfants', profile_siblings: 'Frères et sœurs',
    profile_no_relatives: 'Aucun proche lié pour le moment',
    profile_edit_btn: 'Modifier mon profil',
    profile_add_spouse: '+ Ajouter un(e) conjoint(e)', profile_add_child: '+ Ajouter un enfant', profile_add_sibling: '+ Ajouter un frère/une sœur',

    ep_title: 'Modifier mon profil',
    ep_photo: 'Photo', ep_fullname: 'Nom complet', ep_gender: 'Genre', ep_birthdate: 'Date de naissance',
    ep_occupation: 'Profession', ep_residence: 'Résidence', ep_phone: 'Téléphone',
    ep_submit: "Soumettre pour approbation par l'administrateur",
    ep_submitting: 'Envoi en cours...',
    ep_submitted_ok: "Envoyé — vos modifications apparaîtront une fois approuvées par un administrateur.",
    ep_change_password_title: 'Changer le mot de passe',
    ep_change_password_hint: "Ceci s'applique immédiatement — aucune approbation n'est nécessaire.",
    ep_current_password: 'Mot de passe actuel', ep_new_password: 'Nouveau mot de passe', ep_confirm_password: 'Confirmer le nouveau mot de passe',
    ep_change_password_btn: 'Changer le mot de passe',
    ep_password_mismatch: 'Les nouveaux mots de passe ne correspondent pas.',
    ep_password_updating: 'Mise à jour...',
    ep_password_changed: 'Mot de passe modifié.',
    ep_error_generic: "Une erreur s'est produite.",

    ar_title_spouse: 'Ajouter un(e) conjoint(e)', ar_title_child: 'Ajouter un enfant', ar_title_sibling: 'Ajouter un frère/une sœur',
    ar_fullname: 'Nom complet',
    ar_new_hint: "Aucun profil correspondant trouvé. Indiquez ce que vous savez — l'administrateur vérifiera.",
    ar_gender: 'Genre', ar_birthdate: 'Date de naissance', ar_occupation: 'Profession', ar_residence: 'Résidence',
    ar_phone: 'Téléphone', ar_photo: 'Photo',
    ar_username: "Nom d'utilisateur (leur identifiant)", ar_password: 'Mot de passe',
    ar_other_parent: 'Autre parent', ar_other_parent_none: 'Aucun / inconnu',
    ar_via_father: 'Aussi enfant de {name} (père)',
    ar_via_mother: 'Aussi enfant de {name} (mère)',
    ar_submit: "Soumettre pour approbation par l'administrateur",
    ar_submitting: 'Envoi en cours...',
    ar_submitted_ok: "Envoyé — en attente d'approbation par l'administrateur.",
    ar_error_name_required: 'Veuillez saisir un nom complet.',
    ar_error_creds_required: "Un nom d'utilisateur et un mot de passe sont requis pour un nouveau profil.",

    tree_hello: 'Bonjour, {name}',
    tree_logout: 'Déconnexion',
    tree_center_me: 'Centrer sur moi',
    tree_no_profiles: 'Aucun profil approuvé à afficher',
    tree_other_profiles: "Autres profils (pas encore reliés à la racine familiale)",
    tree_not_logged_in: 'Non connecté',

    sidebar_menu_title: 'Menu',
    sidebar_archives: 'Archives',
    sidebar_tree_summary: "Résumé de l'arbre généalogique",
    sidebar_download_image: 'Télécharger en image',
    sidebar_download_pdf: 'Télécharger en PDF',
    tree_export_error: "Impossible d'exporter l'arbre. Veuillez réessayer.",

    archives_title: 'Archives familiales',
    archives_back_link: "Retour à l'arbre",
    archives_tab_photos: 'Photos',
    archives_tab_audios: 'Audios',
    archives_tab_videos: 'Vidéos',
    archives_new_post: '+ Nouvelle publication',
    archives_empty_photos: 'Aucune photo approuvée pour le moment.',
    archives_empty_audios: 'Aucun audio approuvé pour le moment.',
    archives_empty_videos: 'Aucune vidéo approuvée pour le moment.',
    archives_posted_by: 'Publié par {name} — {date}',
    archives_posted_by_unknown: 'Publié par un membre de la famille — {date}',
    np_title: 'Nouvelle publication',
    np_type: 'Type',
    np_type_photo: 'Photo', np_type_audio: 'Audio', np_type_video: 'Lien vidéo YouTube',
    np_file_photo: 'Fichier photo', np_file_audio: 'Fichier audio',
    np_youtube_url: 'Lien YouTube',
    np_caption: 'Écrivez quelque chose à propos de cette publication',
    np_submit: "Soumettre pour approbation par l'administrateur",
    np_submitting: 'Envoi en cours...',
    np_submitted_ok: "Envoyé — en attente d'approbation par l'administrateur.",
    np_error_generic: "Une erreur s'est produite.",

    admin_archive_tab: 'Publications des archives',
    admin_archive_no_photo: 'Aucun aperçu',
    admin_archive_field_type: 'Type', admin_archive_field_caption: 'Légende',
    admin_archive_field_posted_by: 'Publié par', admin_archive_field_link: 'Lien'
  }
};

function currentLang(){ return localStorage.getItem('ft_lang') || 'en'; }

// t('key', {name:'X'}) — looks up the active language, falls back to English, then the
// key itself, and substitutes any {placeholders}.
function t(key, vars){
  const dict = I18N[currentLang()] || I18N.en;
  let str = (dict[key] !== undefined) ? dict[key] : (I18N.en[key] !== undefined ? I18N.en[key] : key);
  if (vars) Object.keys(vars).forEach(k=>{ str = str.replace('{'+k+'}', vars[k]); });
  return str;
}

function applyI18nKey(el, value){
  if (!el) return;
  if (el.children.length === 0){ el.textContent = value; return; }
  // element has child elements too (e.g. <label>Text<input/></label>) — only replace the
  // leading text node so nested controls aren't clobbered
  if (el.childNodes.length && el.childNodes[0].nodeType === Node.TEXT_NODE){
    el.childNodes[0].nodeValue = value;
  } else {
    el.insertBefore(document.createTextNode(value), el.firstChild);
  }
}

function applyI18n(){
  const dict = I18N[currentLang()] || I18N.en;
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const key = el.getAttribute('data-i18n');
    if (dict[key] !== undefined || I18N.en[key] !== undefined) applyI18nKey(el, t(key));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>{
    const key = el.getAttribute('data-i18n-placeholder');
    if (dict[key] !== undefined || I18N.en[key] !== undefined) el.setAttribute('placeholder', t(key));
  });
  document.documentElement.lang = currentLang();
}

applyI18n();
// app.js is loaded before <main> on some pages (e.g. admin.html), so the elements this
// first pass looks for don't exist yet — run it again once the whole page has parsed.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyI18n);

const langToggle = document.getElementById('lang-toggle');
if (langToggle){
  langToggle.addEventListener('click', ()=>{
    const next = currentLang() === 'en' ? 'fr' : 'en';
    localStorage.setItem('ft_lang', next);
    applyI18n();
    // re-render anything already built in JS (request cards, the tree's SVG labels) so
    // it picks up the new language too, not just the static markup
    if (typeof loadRequests === 'function') loadRequests();
    if (typeof loadArchiveRequests === 'function') loadArchiveRequests();
    if (document.getElementById('tree-svg') && typeof loadTree === 'function') loadTree();
  });
}
