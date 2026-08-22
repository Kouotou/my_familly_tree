async function api(path, opts={}){
  const merged = Object.assign({}, opts, { credentials: 'same-origin' });
  const res = await fetch('/api'+path, merged);
  const ct = res.headers.get('content-type')||'';
  if (ct.includes('application/json')) return res.json();
  return res.text();
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
  // siblings: persons who share a parent (dedupe full siblings who share both parents)
  const parentIds = edges.filter(e=> e.type==='parent' && e.from===person.id).map(e=>e.to);
  const siblingIds = new Set();
  parentIds.forEach(pid=>{
    edges.forEach(e=>{ if (e.type==='parent' && e.to===pid && e.from!==person.id){ const s = nodeMap[e.from]; if (s && !siblingIds.has(s.id)){ siblingIds.add(s.id); rels.siblings.push(s); } } });
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
    return isFinite(yrs) && yrs>=0 ? (p.death_date ? `${yrs} yrs (at death)` : `${yrs} yrs old`) : '';
  };

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
  if (person.gender) bits.push(person.gender.charAt(0).toUpperCase()+person.gender.slice(1));
  const born = person.birth_date || person.birth_year;
  if (born) bits.push((person.death_date ? `${born} – ${person.death_date}` : `Born ${born}`));
  const ageStr = age(person); if (ageStr) bits.push(ageStr);
  if (person.death_date) bits.push('Deceased');
  sub.textContent = bits.join(' · ');
  headText.appendChild(sub);
  header.appendChild(headText);
  content.appendChild(header);

  const details = document.createElement('div'); details.className = 'profile-details';
  const row = (label, value)=>{ if (!value) return ''; return `<div class="profile-detail-row"><span class="profile-detail-label">${label}</span><span>${value}</span></div>`; };
  details.innerHTML = [
    row('Occupation', person.occupation),
    row('Residence', person.residence),
    row('Phone', person.phone)
  ].filter(Boolean).join('') || '<div class="profile-detail-row profile-detail-empty">No additional details on file</div>';
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
  mkGroup('Father', rels.father);
  mkGroup('Mother', rels.mother);
  mkGroup('Spouse(s)', rels.spouses);
  mkGroup('Children', rels.children);
  mkGroup('Siblings', rels.siblings);
  if (!relSection.children.length){ const none = document.createElement('div'); none.className='profile-detail-row profile-detail-empty'; none.textContent = 'No linked relatives yet'; relSection.appendChild(none); }
  content.appendChild(relSection);

  modal.style.display='flex';
}

const loginForm = document.getElementById('login-form');
if (loginForm){
  loginForm.addEventListener('submit', async e=>{
    e.preventDefault();
    const fullName = document.getElementById('fullName').value;
    const birthDate = document.getElementById('birthDate') ? document.getElementById('birthDate').value : null;
    const feedback = document.getElementById('login-feedback');
    try{
      const r = await api('/auth/login-by-dob',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fullName,birth_date:birthDate})});
      if (r.ok){
        showAppView(r.person);
      } else {
        feedback.textContent = 'No matching profile found. You can create your own profile.';
      }
    }catch(err){
      feedback.textContent = 'No matching profile found. You can create your own profile.';
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

const adminLoginBtn = document.getElementById('adminLoginBtn');
if (adminLoginBtn){
  adminLoginBtn.addEventListener('click', async ()=>{
    const u = document.getElementById('adminUser').value;
    const p = document.getElementById('adminPwd').value;
    const f = document.getElementById('adminFeedback');
    try{
      const r = await api('/auth/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
      if (r.ok){
        if (f) f.textContent = 'Logged in as admin';
        const panel = document.getElementById('adminPanel'); if (panel) panel.classList.remove('hidden');
      } else if (f) f.textContent = 'Login failed';
    }catch(err){ if (f) f.textContent = 'Login failed'; }
  });
}

const viewRequestsBtn = document.getElementById('view-requests');
if (viewRequestsBtn){ viewRequestsBtn.addEventListener('click', async ()=>{ await loadRequests(); }); }

async function loadRequests(){
  const area = document.getElementById('requestsArea');
  area.innerHTML = 'Loading...';
  try{
    const r = await api('/admin/requests');
    if (!Array.isArray(r) || r.length===0){ area.innerHTML = '<div>No pending requests</div>'; return; }
    area.innerHTML = '';
    r.forEach(req=>{
      const container = document.createElement('div');
      container.className = 'request-item';
      const meta = document.createElement('div'); meta.textContent = `ID: ${req.id} — Type: ${req.type} — By: ${req.created_by} — At: ${req.created_at}`;
      const payloadPre = document.createElement('pre'); payloadPre.textContent = JSON.stringify(req.payload, null, 2);
      const btnApprove = document.createElement('button'); btnApprove.textContent = 'Approve'; btnApprove.addEventListener('click', ()=> approveRequest(req.id));
      const btnEdit = document.createElement('button'); btnEdit.textContent = 'Edit & Approve'; btnEdit.addEventListener('click', ()=> editApproveRequest(req.id, req.payload));
      const btnReject = document.createElement('button'); btnReject.textContent = 'Reject'; btnReject.addEventListener('click', ()=> rejectRequest(req.id));
      container.appendChild(meta);
      container.appendChild(payloadPre);
      container.appendChild(btnApprove);
      container.appendChild(btnEdit);
      container.appendChild(btnReject);
      area.appendChild(container);
    });
  }catch(e){ area.innerHTML = 'Error fetching'; }
}

async function approveRequest(id){
  if (!confirm('Approve this request?')) return;
  try{
    const res = await fetch('/api/admin/requests/'+id+'/approve', { method:'POST' });
    const j = await res.json();
    if (j.ok){ alert('Approved'); await loadRequests(); } else alert('Error');
  }catch(e){ alert('Network error'); }
}

async function rejectRequest(id){
  const note = prompt('Optional reason for rejection:','');
  try{
    const res = await fetch('/api/admin/requests/'+id+'/reject', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ note }) });
    const j = await res.json();
    if (j.ok){ alert('Rejected'); await loadRequests(); } else alert('Error');
  }catch(e){ alert('Network error'); }
}

async function editApproveRequest(id, payload){
  const edited = prompt('Edit payload JSON', JSON.stringify(payload, null, 2));
  if (edited === null) return; // cancelled
  let parsed;
  try{ parsed = JSON.parse(edited); }catch(err){ alert('Invalid JSON'); return; }
  try{
    const res = await fetch('/api/admin/requests/'+id+'/edit-approve', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ payload: parsed }) });
    const j = await res.json();
    if (j.ok){ alert('Edited and approved'); await loadRequests(); } else alert('Error');
  }catch(e){ alert('Network error'); }
}

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
    chosen.innerHTML = `<span>Linked to existing profile: <strong>${p.full_name}</strong> (${p.birth_date || p.birth_year || 'no DOB on file'})</span>`;
    const change = document.createElement('button'); change.type = 'button'; change.className = 'secondary'; change.textContent = 'Not them / change';
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
      matchesEl.innerHTML = '<div class="hint">No existing profile found with this name.</div>';
      showNewFields();
      return;
    }
    hideNewFields();
    const list = document.createElement('div'); list.className = 'parent-match-list';
    people.forEach(p=>{
      const row = document.createElement('div'); row.className = 'parent-match-row';
      row.innerHTML = `<span>${p.full_name} <span class="hint">(${p.birth_date || p.birth_year || 'no DOB on file'})</span></span>`;
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'This is them'; btn.addEventListener('click', ()=> selectMatch(p));
      row.appendChild(btn);
      list.appendChild(row);
    });
    const noneBtn = document.createElement('button'); noneBtn.type = 'button'; noneBtn.className = 'secondary'; noneBtn.textContent = 'None of these — create a new profile';
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
    if (photoEl && photoEl.files && photoEl.files[0]) data.append('photo', photoEl.files[0]);

    // parent fields (optional): either linked to an existing matched profile (id set by the
    // matcher UI) or full details for a brand-new profile to be created alongside this one.
    const appendParent = (prefix)=>{
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
      if (photoEl && photoEl.files && photoEl.files[0]) data.append(prefix + '_photo', photoEl.files[0]);
    };
    appendParent('father');
    appendParent('mother');

    const feedback = document.getElementById('register-feedback');
    if (feedback) feedback.textContent = 'Submitting...';
    try{
      const res = await fetch('/api/auth/register', { method:'POST', body: data });
      const j = await res.json();
      if (j.ok){ if (feedback) feedback.textContent = 'Registration submitted and pending admin approval.'; setTimeout(()=>{ location.href = '/'; }, 1400); }
      else if (feedback) feedback.textContent = 'Error: ' + JSON.stringify(j);
    }catch(err){ if (feedback) feedback.textContent = 'Network error'; }
  });
}

const backToLanding = document.getElementById('back-to-landing');
if (backToLanding){ backToLanding.addEventListener('click', async ()=>{ await api('/auth/logout',{method:'POST'}); location.href = '/'; }); }

function showAppView(person){
  // after login, redirect user to dedicated tree page
  // pass no sensitive info in URL — tree page will call /api/auth/me
  location.href = '/tree.html';
}

async function loadTree(){
  const svg = document.getElementById('tree-svg');
  svg.innerHTML = '';
  const me = await api('/auth/me');
  const person = me.person;
  if (!person) { svg.innerHTML = '<text x="20" y="20">Not logged in</text>'; return; }
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
    // spouses share the same generation
    edges.filter(e=> e.type==='spouse' && (e.from===id || e.to===id)).forEach(e=>{
      const s = e.from===id ? e.to : e.from;
      if (!visited.has(s)){ visited.add(s); levels[s] = lvl; queue.push(s); }
    });
  }
  return { levels, visited };
}

function renderTreeSVG(svg, tree, centerId, rootId){
  const nodes = tree.nodes;
  const edges = tree.edges.filter(e=> e.type==='parent' || e.type==='spouse');
  const nodeMap = {};
  nodes.forEach(n=> nodeMap[n.id]=n);

  if (nodes.length===0){ svg.innerHTML = '<text x="20" y="20">No approved profiles to display</text>'; return; }
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
    label.setAttribute('fill','#a49070');
    label.setAttribute('font-family', "'Iowan Old Style','Palatino Linotype',Georgia,serif");
    label.textContent = 'Other profiles (not yet linked to the family root)';
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
    line.setAttribute('stroke', '#c3924f');
    line.setAttribute('stroke-width', 3);
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
    trunk.setAttribute('stroke', '#c3ac86'); trunk.setAttribute('stroke-width', 2);
    g.appendChild(trunk);

    const childXs = Array.from(children).map(cid=> positions[cid]).filter(Boolean).map(p=> p.x + nodeW/2);
    if (!childXs.length) return;
    const minX = Math.min(parentMidX, ...childXs);
    const maxX = Math.max(parentMidX, ...childXs);
    if (childXs.length>1 || minX!==maxX){
      const bar = document.createElementNS('http://www.w3.org/2000/svg','line');
      bar.setAttribute('x1', String(minX)); bar.setAttribute('y1', String(dropY));
      bar.setAttribute('x2', String(maxX)); bar.setAttribute('y2', String(dropY));
      bar.setAttribute('stroke', '#c3ac86'); bar.setAttribute('stroke-width', 2);
      g.appendChild(bar);
    }
    Array.from(children).forEach(cid=>{
      const cp = positions[cid]; if (!cp) return;
      const cx = cp.x + nodeW/2;
      const drop = document.createElementNS('http://www.w3.org/2000/svg','line');
      drop.setAttribute('x1', String(cx)); drop.setAttribute('y1', String(dropY));
      drop.setAttribute('x2', String(cx)); drop.setAttribute('y2', String(cp.y));
      drop.setAttribute('stroke', '#c3ac86'); drop.setAttribute('stroke-width', 2);
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
    bg.setAttribute('fill', id === centerId ? '#fbead0' : '#fffaf2');
    bg.setAttribute('stroke', id === anchorId ? '#7a4a20' : (id === centerId ? '#c3924f' : '#e6d6ba'));
    bg.setAttribute('stroke-width', (id === centerId || id === anchorId) ? '2.5' : '1.2');
    bg.setAttribute('filter', 'drop-shadow(0 6px 10px rgba(90,62,33,0.12))');
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
      text.setAttribute('fill', '#3c2c1c');
      text.setAttribute('font-family', "'Iowan Old Style','Palatino Linotype',Georgia,serif");
      text.textContent = line;
      group.appendChild(text);
    });

    const year = document.createElementNS(svgNS, 'text');
    year.setAttribute('x', '62');
    year.setAttribute('y', '58');
    year.setAttribute('font-size', '11');
    year.setAttribute('fill', '#8a7860');
    year.textContent = n.birth_year || '—';
    group.appendChild(year);

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
    infoBox.setAttribute('fill', 'rgba(169,104,63,0.1)');
    infoBox.setAttribute('stroke', '#c3924f');
    infoBtn.appendChild(infoBox);
    for (let i = 0; i < 3; i++){
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', String(9 + i * 0));
      dot.setAttribute('cy', String(9));
      dot.setAttribute('r', '2');
      dot.setAttribute('fill', '#8a4f28');
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

  // setup pan/zoom
  initPanZoom(svg, g);
}

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
}

const centerBtn = document.getElementById('center-me');
if (centerBtn){
  centerBtn.addEventListener('click', async ()=>{
    const me = await api('/auth/me');
    const svg = document.getElementById('tree-svg');
    if (!svg) return;
    const viewport = svg.querySelector('#viewport');
    if (!viewport) return;
    const node = (me.person && svg.querySelector(`.node[data-id="${me.person.id}"]`)) || svg.querySelector('.node');
    if (!node) return;
    // center logic: compute bbox of node and translate so it's centered in view
    const bbox = node.getBBox();
    const svgW = svg.clientWidth, svgH = svg.clientHeight;
    const tx = svgW/2 - (bbox.x + bbox.width/2);
    const ty = svgH/2 - (bbox.y + bbox.height/2);
    viewport.setAttribute('transform', `translate(${tx},${ty}) scale(1)`);
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
  });
}

// Expanded language support for common UI texts
const translations = {
  en: {
    brand: 'Famille Nah Adja Mbethe',
    welcome: 'Welcome',
    landingDesc: 'Find your place in the family tree — quick login with your name and birth year.',
    loginBtn: 'Log in',
    createProfile: 'Profile not found — create your own profile',
    adminLink: 'Administrator login',
    rightTitle: 'Family Tree',
    rightDesc: "Explore ancestors, add/update profiles, and submit changes for admin approval. We keep your family's history safe and accurate.",
    adminLogout: 'Logout',
    centerMe: 'Center on me',
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    adminLoginTitle: 'Administrator Login',
    username: 'Username',
    password: 'Password'
  },
  fr: {
    brand: 'Famille Nah Adja Mbethe',
    welcome: 'Bienvenue',
    landingDesc: 'Trouvez votre place dans l\'arbre généalogique — connexion rapide avec votre nom et votre date de naissance.',
    loginBtn: 'Se connecter',
    createProfile: 'Profil introuvable — créez votre profil',
    adminLink: 'Connexion administrateur',
    rightTitle: 'Arbre généalogique',
    rightDesc: "Explorez les ancêtres, ajoutez/mettre à jour des profils, et soumettez des modifications pour approbation par l\'administrateur. Nous gardons l\'histoire familiale en sécurité.",
    adminLogout: 'Se déconnecter',
    centerMe: 'Centrer sur moi',
    pending: 'En attente',
    approved: 'Approuvé',
    rejected: 'Rejeté',
    adminLoginTitle: 'Connexion administrateur',
    username: 'Nom d\'utilisateur',
    password: 'Mot de passe'
  }
};

function applyLang(lang){
  const t = translations[lang] || translations.en;
  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  setText('brand', t.brand);
  setText('admin-brand', t.brand ? (t.brand + ' — Admin') : 'Famille Nah Adja Mbethe — Admin');
  setText('landing-title', t.welcome);
  setText('landing-desc', t.landingDesc);
  setText('login-btn', t.loginBtn);
  setText('create-profile', t.createProfile);
  setText('admin-link', t.adminLink);
  setText('right-title', t.rightTitle);
  setText('right-desc', t.rightDesc);
  setText('back-to-landing', t.adminLogout);
  setText('center-me', t.centerMe);
  setText('tab-pending', t.pending);
  setText('tab-approved', t.approved);
  setText('tab-rejected', t.rejected);
  setText('admin-login-title', t.adminLoginTitle);
  // labels inside admin login
  const lu = document.getElementById('label-username'); if (lu) lu.childNodes[0].textContent = t.username + '\n';
  const lp = document.getElementById('label-password'); if (lp) lp.childNodes[0].textContent = t.password + '\n';
}

applyLang(localStorage.getItem('ft_lang') || 'en');

const langToggle = document.getElementById('lang-toggle');
if (langToggle){
  langToggle.addEventListener('click', ()=>{
    const cur = localStorage.getItem('ft_lang') || 'en';
    const next = cur === 'en' ? 'fr' : 'en';
    localStorage.setItem('ft_lang', next);
    applyLang(next);
  });
}
