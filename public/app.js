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
    modal = document.createElement('div'); modal.id='profile-modal'; modal.style.position='fixed'; modal.style.inset='0'; modal.style.background='rgba(0,0,0,0.4)'; modal.style.display='flex'; modal.style.alignItems='center'; modal.style.justifyContent='center'; modal.style.zIndex='80';
    modal.innerHTML = `<div style="background:var(--card);padding:18px;border-radius:10px;max-width:520px;max-height:80vh;overflow:auto;box-shadow:var(--shadow)"><button id="profile-close" style="float:right">Close</button><div id="profile-content"></div></div>`;
    document.body.appendChild(modal);
    modal.querySelector('#profile-close').addEventListener('click', ()=> modal.style.display='none');
  }
  const content = modal.querySelector('#profile-content'); content.innerHTML = '';
  const img = document.createElement('img'); img.src = person.photo_path || '/profile_icons/Female_profile_icon.jfif'; img.style.width='96px'; img.style.height='96px'; img.style.objectFit='cover'; img.style.borderRadius='8px'; img.style.float='left'; img.style.marginRight='12px'; content.appendChild(img);
  const h = document.createElement('h3'); h.textContent = person.full_name || 'Unknown'; content.appendChild(h);
  const details = document.createElement('div'); details.style.marginTop='8px'; details.innerHTML = `
    <div><strong>Born:</strong> ${person.birth_date || person.birth_year || ''}</div>
    <div><strong>Occupation:</strong> ${person.occupation || ''}</div>
    <div><strong>Residence:</strong> ${person.residence || ''}</div>
    <div><strong>Phone:</strong> ${person.phone || ''}</div>
  `;
  content.appendChild(details);

  // compute relations from edges
  const rels = { father: [], mother: [], siblings: [], spouses: [], children: [] };
  edges.forEach(e=>{
    if (e.type==='parent' && e.to === person.id){ // e.from is parent
      const p = nodeMap[e.from]; if (p){ if ((p.gender||'').toLowerCase()==='male') rels.father.push(p); else if ((p.gender||'').toLowerCase()==='female') rels.mother.push(p); else rels.father.push(p); }
    }
    if (e.type==='parent' && e.from === person.id){ // e.to is child
      const c = nodeMap[e.to]; if (c) rels.children.push(c);
    }
    if (e.type==='spouse' && (e.from===person.id || e.to===person.id)){
      const otherId = e.from===person.id ? e.to : e.from; const o = nodeMap[otherId]; if (o) rels.spouses.push(o);
    }
  });
  // siblings: persons who share a parent
  const parentIds = edges.filter(e=> e.type==='parent' && e.to===person.id).map(e=>e.from);
  parentIds.forEach(pid=>{
    edges.forEach(e=>{ if (e.type==='parent' && e.from===pid && e.to!==person.id){ const s = nodeMap[e.to]; if (s) rels.siblings.push(s); } });
  });

  const relDiv = document.createElement('div'); relDiv.style.marginTop='12px';
  const mk = (label, arr)=>{ const d = document.createElement('div'); d.innerHTML = `<strong>${label}:</strong> ` + (arr.length? arr.map(x=> x.full_name).join(', ') : 'None'); return d; };
  relDiv.appendChild(mk('Father', rels.father)); relDiv.appendChild(mk('Mother', rels.mother)); relDiv.appendChild(mk('Spouse(s)', rels.spouses)); relDiv.appendChild(mk('Children', rels.children)); relDiv.appendChild(mk('Siblings', rels.siblings));
  content.appendChild(relDiv);

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

    // parent fields (optional)
    if (document.getElementById('father_name')) data.append('father_name', maybe('father_name'));
    if (document.getElementById('father_birth_year')) data.append('father_birth_year', maybe('father_birth_year'));
    if (document.getElementById('father_from_family') && document.getElementById('father_from_family').checked) data.append('father_from_family','on');
    if (document.getElementById('mother_name')) data.append('mother_name', maybe('mother_name'));
    if (document.getElementById('mother_birth_year')) data.append('mother_birth_year', maybe('mother_birth_year'));
    if (document.getElementById('mother_from_family') && document.getElementById('mother_from_family').checked) data.append('mother_from_family','on');

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
  const res = await api('/tree/full');
  renderTreeSVG(svg, res, person.id);
}

function renderTreeSVG(svg, tree, centerId){
  const nodes = tree.nodes;
  const edges = tree.edges;
  const nodeMap = {};
  nodes.forEach(n=> nodeMap[n.id]=n);

  // build level map: BFS ancestors (-) and descendants (+)
  const levels = {};
  // ensure centerId exists in nodeMap; if not, fall back to first node
  if (!nodeMap[centerId]){
    if (nodes.length>0) centerId = nodes[0].id;
    else { svg.innerHTML = '<text x="20" y="20">No approved profiles to display</text>'; return; }
  }
  levels[centerId]=0;
  // ancestors
  let current = [centerId];
  for (let d=1; d<=3; d++){
    const next = [];
    for (const id of current){
      const parents = edges.filter(e=> e.type==='parent' && e.to===id && nodeMap[e.from]).map(e=>e.from);
      for (const p of parents){ if (!(p in levels)){ levels[p] = -d; next.push(p); } }
    }
    current = next;
  }
  // descendants
  current = [centerId];
  for (let d=1; d<=3; d++){
    const next = [];
    for (const id of current){
      const childs = edges.filter(e=> e.type==='parent' && e.from===id && nodeMap[e.to]).map(e=>e.to);
      for (const c of childs){ if (!(c in levels)){ levels[c] = d; next.push(c); } }
    }
    current = next;
  }

  // group by level
  const groups = {};
  for (const id in levels){ const lv = levels[id]; groups[lv] = groups[lv]||[]; groups[lv].push(id); }

  // layout
  const levelHeight = 140;
  const nodeW = 140, nodeH = 60;
  const spacingX = 160;
  const svgW = svg.clientWidth || 1200;
  const svgH = svg.clientHeight || 800;

  const positions = {};
  const levelKeys = Object.keys(groups).map(Number).sort((a,b)=>a-b);
  for (const lv of levelKeys){
    const ids = groups[lv];
    // sort by birth_year
    // filter out unknown ids just in case
    const knownIds = ids.filter(id=> !!nodeMap[id]);
    knownIds.sort((a,b)=> (nodeMap[a].birth_year||0) - (nodeMap[b].birth_year||0));
    const totalWidth = (knownIds.length-1)*spacingX;
    let startX = (svgW - totalWidth)/2;
    for (let i=0;i<knownIds.length;i++){
      const id = knownIds[i];
      const x = startX + i*spacingX;
      const y = svgH/2 + lv*levelHeight;
      positions[id] = { x, y };
    }
  }

  // create pan/zoom group
  const g = document.createElementNS('http://www.w3.org/2000/svg','g');
  g.setAttribute('id','viewport');
  svg.appendChild(g);

  // draw edges
  edges.forEach(e=>{
    const from = positions[e.from];
    const to = positions[e.to];
    if (!from || !to) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1', from.x + nodeW/2);
    line.setAttribute('y1', from.y + nodeH/2);
    line.setAttribute('x2', to.x + nodeW/2);
    line.setAttribute('y2', to.y + nodeH/2);
    line.setAttribute('stroke', e.type==='spouse' ? '#888' : '#444');
    line.setAttribute('stroke-width', 2);
    if (e.type==='spouse') line.setAttribute('stroke-dasharray','4 3');
    g.appendChild(line);
  });

  // draw nodes
  for (const id of Object.keys(positions)){
    const pos = positions[id];
    const n = nodeMap[id];
    if (!n) continue; // defensive: skip unknown node
    const group = document.createElementNS('http://www.w3.org/2000/svg','g');
    group.setAttribute('class','node');
    group.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);

    const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
    rect.setAttribute('width', nodeW);
    rect.setAttribute('height', nodeH);
    rect.setAttribute('rx', 8);
    rect.setAttribute('ry', 8);
    rect.setAttribute('fill', id===centerId? '#fffbdd' : '#fff');
    rect.setAttribute('stroke', '#555');
    group.appendChild(rect);

    const name = document.createElementNS('http://www.w3.org/2000/svg','text');
    name.setAttribute('x', 10);
    name.setAttribute('y', 24);
    name.setAttribute('font-size', '14');
    name.textContent = n.full_name || 'Unknown';
    group.appendChild(name);

    const sub = document.createElementNS('http://www.w3.org/2000/svg','text');
    sub.setAttribute('x', 10);
    sub.setAttribute('y', 44);
    sub.setAttribute('font-size', '12');
    sub.setAttribute('fill','#666');
    sub.textContent = n.birth_year || '';
    group.appendChild(sub);

    // click to show info modal
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
  svg.addEventListener('pointerdown', e=>{ dragging=true; lastX=e.clientX; lastY=e.clientY; svg.setPointerCapture(e.pointerId); });
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
    const node = svg.querySelector('.node');
    if (!node) return; // simple: recenters to first node
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

const themeToggle = document.getElementById('theme-toggle');
if (themeToggle){
  const saved = localStorage.getItem('ft_theme') || 'light';
  applyTheme(saved);
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

const langToggle = document.getElementById('lang-toggle');
if (langToggle){
  const savedLang = localStorage.getItem('ft_lang') || 'en';
  applyLang(savedLang);
  langToggle.addEventListener('click', ()=>{
    const cur = localStorage.getItem('ft_lang') || 'en';
    const next = cur === 'en' ? 'fr' : 'en';
    localStorage.setItem('ft_lang', next);
    applyLang(next);
  });
}
