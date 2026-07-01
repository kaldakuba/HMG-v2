// settings.js — vytaženo z inline <script> v settings.html (P2 #5 CSP, 7e-bis).
// FUNKCE BEZE ZMĚNY. on* atributy převedeny na addEventListener/delegaci (viz sekce DOLE).

// ═══ BLOK 1: verze v patičce ═══
fetch('/api/version').then(r=>r.json()).then(function(d){var v=document.getElementById('footerVersion');if(v&&d.version)v.textContent='TAXIS v'+d.version+' · 2026';}).catch(function(){});

// ═══ BLOK 2: hlavní aplikační logika ═══
function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('sec-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');
  if (name === 'sessions') loadSessions();
  if (name === 'share') loadShareTokens();
  if (name === 'backup') { loadBackupInfo(); loadBackupConfig(); }
  if (name === 'orders') loadOrdersAdmin();
  if (name === 'smtp') loadSmtpSettings();
  if (name === 'system') loadSystemSettings();
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('cs-CZ') + ' ' + d.toLocaleTimeString('cs-CZ', {hour:'2-digit',minute:'2-digit'});
}
function parseUA(ua) {
  if (!ua) return '—';
  let b = 'Prohlížeč', os = '';
  if (/Chrome/.test(ua) && !/Edg/.test(ua)) b = 'Chrome';
  else if (/Firefox/.test(ua)) b = 'Firefox';
  else if (/Safari/.test(ua) && !/Chrome/.test(ua)) b = 'Safari';
  else if (/Edg/.test(ua)) b = 'Edge';
  if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux';
  return b + (os ? ' / ' + os : '');
}
function esc(v) { return String(v||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function api(method, url, body) {
  const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { window.location.href = '/login'; return {}; }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) { window.location.href = '/login'; return {}; }
  return r.json();
}
function initials(name) { return name.split(/[._-]/).map(p=>p[0]||'').join('').toUpperCase().slice(0,2) || name[0].toUpperCase(); }
function avatarColor(role) {
  if (role==='admin') return {bg:'#1a1a2e',color:'#fff'};
  if (role==='operator') return {bg:'#fef9c3',color:'#854d0e'};
  return {bg:'#ede9fe',color:'#5b21b6'};
}
function roleBadge(role) {
  if (role==='admin') return '<span class="role-badge admin">admin</span>';
  if (role==='operator') return '<span class="role-badge operator">operátor</span>';
  return '<span class="role-badge hmg_share">Sdílený přístup</span>';
}

function fmtDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('cs-CZ');
}

async function loadUsers() {
  let users;
  try {
    users = await api('GET', '/api/users');
    if (!Array.isArray(users)) throw new Error('bad response');
  } catch(e) {
    document.getElementById('usersBody').innerHTML = '<div style="text-align:center;color:#dc2626;padding:24px;font-size:13px">Chyba načítání uživatelů. Zkuste obnovit stránku.</div>';
    return;
  }

  document.getElementById('badge-users').textContent = users.length;
  document.getElementById('usersCountLabel').textContent = '(' + users.length + ' uživatelů)';

  if (!users.length) {
    document.getElementById('usersBody').innerHTML = '<div style="text-align:center;color:#9ca3af;padding:24px;font-size:13px">Žádní uživatelé</div>';
    return;
  }

  const rows = users.map(u => {
    const isAdmin = u.role === 'admin';
    const firmaCell = u.role === 'hmg_share'
      ? `<button class="btn gray sm" data-act="changeFirma" data-uid="${u.id}" data-uname="${esc(u.username)}" data-firma="${esc(u.firma||'')}" style="margin-right:4px" title="Změnit firmu">${u.firma ? `<span style="font-size:10px;background:#ede9fe;color:#5b21b6;border-radius:10px;padding:1px 7px">${esc(u.firma)}</span>` : '⚠ bez firmy'}</button>`
      : '<span style="color:#d1d5db;font-size:11px">—</span>';
    const emailCell = u.email
      ? `<button data-act="changeEmail" data-uid="${u.id}" data-uname="${esc(u.username)}" data-email="${esc(u.email)}" style="background:none;border:1px solid #dbeafe;border-radius:4px;color:#2563eb;font-size:11px;cursor:pointer;padding:2px 7px;font-family:inherit">${esc(u.email)}</button>`
      : `<button data-act="changeEmail" data-uid="${u.id}" data-uname="${esc(u.username)}" style="background:none;border:1px dashed #d1d5db;border-radius:4px;color:#9ca3af;font-size:10px;cursor:pointer;padding:2px 7px;font-family:inherit">+ email</button>`;
    const ordersCell = u.role === 'hmg_share'
      ? `<label class="toggle-sw" style="transform:scale(.8);transform-origin:left center" title="Povolit objednávkový systém pro tohoto uživatele"><input type="checkbox" ${u.orders_allowed ? 'checked' : ''} data-act="toggleOrders" data-uid="${u.id}"><span class="toggle-sl"></span></label>`
      : '<span style="color:#d1d5db;font-size:11px" title="Relevantní jen pro odběratele (hmg_share)">—</span>';
    const actions = isAdmin
      ? `<button class="btn-soft gray sm" data-act="resetPwd" data-uid="${u.id}" data-uname="${esc(u.username)}" style="margin-right:4px">Heslo</button><span class="cant-delete">nelze smazat</span>`
      : `<button class="btn-soft gray sm" data-act="resetPwd" data-uid="${u.id}" data-uname="${esc(u.username)}" style="margin-right:4px">Heslo</button><button class="btn-soft red sm" data-act="deleteUser" data-uid="${u.id}" data-uname="${esc(u.username)}">Smazat</button>`;
    return `<tr>
      <td class="td-name">${esc(u.username)}</td>
      <td>${roleBadge(u.role)}</td>
      <td>${firmaCell}</td>
      <td>${emailCell}</td>
      <td>${ordersCell}</td>
      <td class="td-date">${fmtDateShort(u.created_at)}</td>
      <td class="td-actions">${actions}</td>
    </tr>`;
  }).join('');

  document.getElementById('usersBody').innerHTML = `
    <table class="users-table">
      <thead>
        <tr>
          <th>Jméno</th>
          <th>Role</th>
          <th>Firma</th>
          <th>Email</th>
          <th>Objednávky</th>
          <th>Vytvořen</th>
          <th>Akce</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Per-user povolení objednávkového systému (jen hmg_share)
async function toggleOrdersAllowed(id, allowed) {
  const r = await api('PUT', `/api/users/${id}/orders-allowed`, { orders_allowed: allowed });
  if (!r.ok) { alert(r.error || 'Nepodařilo se uložit nastavení.'); loadUsers(); }
}

let _companies = [];
async function loadCompanies() {
  try {
    const data = await api('GET', '/api/companies');
    _companies = Array.isArray(data) ? data : [];
  } catch(e) { _companies = []; }
  const sel = document.getElementById('newFirma');
  if (!sel) return;
  sel.innerHTML = '<option value="">— vyberte —</option>' +
    _companies.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
}
function onRoleChange(role) {
  const grp = document.getElementById('firmaGroup');
  grp.style.display = role === 'hmg_share' ? 'flex' : 'none';
}

function toggleAddUser() {
  const f = document.getElementById('addUserForm');
  const btn = document.getElementById('btnAddUser');
  const isOpen = f.style.display === 'block';
  f.style.display = isOpen ? 'none' : 'block';
  btn.textContent = isOpen ? '+ Přidat uživatele' : '✕ Zrušit';
  if (!isOpen) {
    document.getElementById('newUsername').focus();
    document.getElementById('addUserMsg').innerHTML = '';
    document.getElementById('newRole').value = 'operator';
    onRoleChange('operator');
    loadCompanies();
  }
}
async function addUser() {
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const role = document.getElementById('newRole').value;
  const firma = document.getElementById('newFirma').value || undefined;
  const email = document.getElementById('newEmail').value.trim() || undefined;
  const msg = document.getElementById('addUserMsg');
  const r = await api('POST', '/api/users', {username, password, role, firma, email});
  if (r.ok) {
    msg.innerHTML = '<span class="msg-ok">✓ Uživatel přidán</span>';
    document.getElementById('newUsername').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('newEmail').value = '';
    setTimeout(() => {
      document.getElementById('addUserForm').style.display = 'none';
      document.getElementById('btnAddUser').textContent = '+ Přidat uživatele';
      msg.innerHTML = '';
      loadUsers();
    }, 1000);
  } else { msg.innerHTML = `<span class="msg-err">✗ ${esc(r.error)}</span>`; }
}
async function changeEmail(id, name, currentEmail) {
  const newEmail = prompt(`Email pro uživatele "${name}"\nAktuální: ${currentEmail || '—'}\n\nNový email (prázdné = odebrat):`);
  if (newEmail === null) return;
  const r = await api('PUT', `/api/users/${id}/email`, { email: newEmail.trim() });
  if (r.ok) loadUsers(); else alert(r.error || 'Chyba');
}
async function changeFirma(id, name, currentFirma) {
  const companiesList = _companies.length ? _companies.map(c => c.name).join(', ') : 'nejdříve otevřete formulář přidání';
  const newFirma = prompt(`Firma pro uživatele "${name}"\nAktuální: ${currentFirma || '—'}\n\nDostupné firmy: ${companiesList}\n\nNová firma (prázdné = odebrat):`);
  if (newFirma === null) return;
  const r = await api('PUT', `/api/users/${id}/firma`, { firma: newFirma.trim() });
  if (r.ok) loadUsers(); else alert(r.error);
}
async function changeRole(id, name, currentRole) {
  const labels = {operator:'Operátor',hmg_share:'Sdílený přístup',admin:'Admin'};
  const newRole = prompt(`Změnit roli uživatele "${name}"\nAktuální: ${labels[currentRole]}\n\nZadej novou roli:\n- operator\n- hmg_share\n- admin`);
  if (!newRole) return;
  const r = await api('PUT', `/api/users/${id}/role`, {role: newRole.trim()});
  if (r.ok) { alert('Role změněna. Uživatel byl odhlášen.'); loadUsers(); loadSessions(); }
  else alert(r.error);
}
async function deleteUser(id, name) {
  if (!confirm(`Smazat uživatele "${name}"?`)) return;
  const r = await api('DELETE', `/api/users/${id}`);
  if (r.ok) loadUsers(); else alert(r.error);
}
async function resetPassword(id, name) {
  const pw = prompt(`Nové heslo pro "${name}" (min. 6 znaků):`);
  if (!pw) return;
  const r = await api('PUT', `/api/users/${id}/password`, {password: pw});
  if (r.ok) alert('Heslo změněno.'); else alert(r.error);
}

async function loadSessions() {
  const sessions = await api('GET', '/api/sessions');
  document.getElementById('badge-sessions').textContent = sessions.length;
  if (!sessions.length) { document.getElementById('sessionsBody').innerHTML = '<div style="text-align:center;color:#9ca3af;padding:20px;font-size:13px">Žádné aktivní přihlášení</div>'; return; }
  document.getElementById('sessionsBody').innerHTML = sessions.map(s => `
    <div class="session-row">
      <div class="device-icon"><i class="ti ti-${/mobile|Android|iPhone/.test(s.user_agent||'')?'device-mobile':'device-laptop'}" style="font-size:16px;color:#6b7280" aria-hidden="true"></i></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;color:#111">${esc(s.username||'?')}</div>
        <div style="font-size:11px;color:#9ca3af">${parseUA(s.user_agent)} · Vyprší ${fmtDate(s.expire)}</div>
      </div>
      ${s.is_current
        ? '<span style="font-size:10px;padding:2px 8px;border-radius:20px;background:#dbeafe;color:#1e40af;font-weight:500">Aktuální</span>'
        : `<button class="btn red sm" data-act="delSession" data-sid="${esc(s.sid)}">Odhlásit</button>`}
    </div>`).join('');
}
async function deleteSession(sid) {
  if (!confirm('Odhlásit tuto session?')) return;
  const r = await api('DELETE', `/api/sessions/${sid}`);
  if (r.ok) loadSessions(); else alert(r.error);
}

async function loadShareTokens() {
  const tokens = await api('GET', '/api/share-tokens');
  document.getElementById('badge-share').textContent = tokens.filter(t => new Date(t.expires) > new Date()).length || 0;
  const el = document.getElementById('shareTokensList');
  if (!tokens.length) { el.innerHTML = '<div style="color:#9ca3af;font-size:13px;margin-top:8px">Žádné aktivní sdílené odkazy.</div>'; return; }
  el.innerHTML = tokens.map(t => {
    const url = `${location.origin}/share/${t.token}`;
    const expired = new Date(t.expires) < new Date();
    return `<div class="token-card" style="border-color:${expired?'#fca5a5':'#e5e7eb'}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <div>
          <span style="font-size:11px;padding:2px 8px;border-radius:20px;background:${expired?'#fee2e2':'#dcfce7'};color:${expired?'#991b1b':'#15803d'};font-weight:500">${expired?'Vypršel':'Aktivní'}</span>
          <span style="font-size:12px;color:#6b7280;margin-left:8px">do ${fmtDate(t.expires)}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn gray sm" data-act="copyUrl" data-url="${esc(url)}"><i class="ti ti-copy" style="font-size:12px" aria-hidden="true"></i> Kopírovat</button>
          <button class="btn red sm" data-act="delToken" data-token="${esc(t.token)}"><i class="ti ti-trash" style="font-size:12px" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="token-url">${url}</div>
    </div>`;
  }).join('');
}
async function createShareToken() {
  const days = document.getElementById('shareDays').value;
  const r = await api('POST', '/api/share-tokens', {days});
  if (r.ok) { loadShareTokens(); const url=`${location.origin}/share/${r.token}`; if(navigator.clipboard)navigator.clipboard.writeText(url).then(()=>alert('Odkaz zkopírován:\n'+url)); else alert('Vygenerováno:\n'+url); }
}
async function deleteToken(token) {
  if (!confirm('Smazat sdílený odkaz?')) return;
  await api('DELETE', `/api/share-tokens/${token}`);
  loadShareTokens();
}
function copyUrl(url) { if(navigator.clipboard)navigator.clipboard.writeText(url).then(()=>alert('Zkopírováno!')); else{const t=document.createElement('textarea');t.value=url;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();alert('Zkopírováno!');} }

async function settImportFromExcel(event) {
  const file=event.target.files[0]; if(!file)return; event.target.value='';
  if(!confirm('Import přidá data z Excelu. Existující data nepřepíše. Pokračovat?'))return;
  const msg=document.getElementById('importMsg');
  msg.innerHTML='<span style="color:#0369a1;font-weight:500">⏳ Importuji...</span>';
  try{const fd=new FormData();fd.append('file',file);const res=await fetch('/api/import-excel',{method:'POST',body:fd});const d=await res.json();
    if(d.ok)msg.innerHTML=`<span class="msg-ok">✅ Hotovo: ${d.receptury} receptur, ${d.tydnu} týdnů</span>`;
    else msg.innerHTML=`<span class="msg-err">✗ ${d.error}</span>`;
  }catch(e){msg.innerHTML=`<span class="msg-err">✗ ${e.message}</span>`;}
}
function settImportWeekData(ev) {
  const f=ev.target.files[0];if(!f)return;
  const rd=new FileReader();
  rd.onload=e=>{try{const text=e.target.result;const m=text.match(/HMG_WEEK_DATA:([A-Za-z0-9+/=]+)/);if(!m)throw new Error("Soubor neobsahuje HMG_WEEK_DATA.");const payload=JSON.parse(decodeURIComponent(escape(atob(m[1]))));if(!confirm("Import načte "+payload.weeks.length+" týdnů. Pokračovat?"))return;const msg=document.getElementById('importMsg');msg.innerHTML='<span style="color:#0369a1">⏳ Importuji...</span>';Promise.all(payload.weeks.map(w=>fetch('/api/week/'+w.start,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:w.rows})}))).then(()=>{msg.innerHTML=`<span class="msg-ok">✅ Import hotov: ${payload.weeks.length} týdnů</span>`;});}catch(err){alert("Import se nepovedl: "+err.message);}finally{ev.target.value="";}};
  rd.readAsText(f,'utf-8');
}
async function settZalohaDB() {
  const date=new Date().toISOString().slice(0,10);
  const a=document.createElement('a');a.href='/api/export-excel';a.download='hmg_zaloha_'+date+'.xlsx';document.body.appendChild(a);a.click();setTimeout(()=>a.remove(),500);
  document.getElementById('importMsg').innerHTML='<span class="msg-ok">✓ Záloha stažena</span>';
}
let _restoreSnapshotJson = null;
async function restoreStep1(event) {
  const file = event.target.files[0]; if (!file) return; event.target.value = '';
  const msg = document.getElementById('importMsg'); msg.innerHTML = '';
  try {
    const text = await file.text();
    const snap = JSON.parse(text);
    const req = ['version','users','orders','week_data','inputs','companies','settings','month_entries'];
    for (const k of req) {
      if (!(k in snap)) throw new Error(`Chybí klíč "${k}" — toto není platný HMG snímek`);
    }
    _restoreSnapshotJson = text;
    const d = snap.created ? new Date(snap.created).toLocaleString('cs-CZ') : '?';
    document.getElementById('restoreSnapshotInfo').innerHTML =
      `<strong>Soubor:</strong> ${esc(file.name)}<br>` +
      `<strong>Vytvořen:</strong> ${esc(d)}<br>` +
      `<strong>Uživatelů:</strong> ${snap.users.length} &nbsp;·&nbsp; ` +
      `<strong>Objednávek:</strong> ${snap.orders.length} &nbsp;·&nbsp; ` +
      `<strong>Týdnů:</strong> ${snap.week_data.length}`;
    document.getElementById('restoreConfirmPanel').style.display = 'block';
    document.getElementById('restorePassword').value = '';
    document.getElementById('restoreMsg').innerHTML = '';
    document.getElementById('restoreConfirmBtn').disabled = false;
    document.getElementById('restorePassword').focus();
  } catch(e) { msg.innerHTML = `<span class="msg-err">✗ ${esc(e.message)}</span>`; }
}
function restoreCancel() {
  _restoreSnapshotJson = null;
  document.getElementById('restoreConfirmPanel').style.display = 'none';
  document.getElementById('importMsg').innerHTML = '';
}
async function restoreStep2() {
  const password = document.getElementById('restorePassword').value;
  if (!password) { alert('Zadejte heslo admina.'); return; }
  const msg = document.getElementById('restoreMsg');
  const btn = document.getElementById('restoreConfirmBtn');
  msg.innerHTML = '<span style="color:#0369a1">⏳ Obnova probíhá — čekejte, trvá to několik sekund...</span>';
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/restore', { snapshotJson: _restoreSnapshotJson, password });
    if (r.ok) {
      const s = r.summary;
      msg.innerHTML = `<span class="msg-ok">✅ Obnova dokončena! ` +
        `Uživatelů: ${s.users}, Objednávek: ${s.orders}, Týdnů: ${s.week_data}. ` +
        `Stránka se za 3 s načte znovu.</span>`;
      _restoreSnapshotJson = null;
      setTimeout(() => location.reload(), 3000);
    } else {
      msg.innerHTML = `<span class="msg-err">✗ ${esc(r.error || 'Neznámá chyba')}</span>`;
      btn.disabled = false;
    }
  } catch(e) {
    msg.innerHTML = `<span class="msg-err">✗ ${esc(e.message)}</span>`;
    btn.disabled = false;
  }
}

async function loadBackupInfo() {
  const r = await api('GET','/api/backup/last');
  const lastEl  = document.getElementById('lastBackup');
  const badgeEl = document.getElementById('backupBadge');
  const errEl   = document.getElementById('backupError');

  if (r.last) {
    lastEl.textContent = `Poslední záloha: ${fmtDate(r.last)}`;
  } else {
    lastEl.textContent = 'Záloha zatím neproběhla';
  }

  // Badge: červený >48 h / žlutý >36 h / zelený jinak / šedý při chybějící
  if (badgeEl) {
    const ageH = r.age_hours;
    if (ageH === null || ageH === undefined) {
      badgeEl.style.background = '#fee2e2'; badgeEl.style.color = '#991b1b';
      badgeEl.textContent = '⚠ Žádná záloha';
    } else if (ageH > 48) {
      const days = Math.floor(ageH / 24);
      const word = days === 1 ? 'dnem' : (days >= 2 && days <= 4 ? 'dny' : 'dny');
      badgeEl.style.background = '#fee2e2'; badgeEl.style.color = '#991b1b';
      badgeEl.textContent = `⚠ Před ${days} ${word}`;
    } else if (ageH > 36) {
      badgeEl.style.background = '#fef3c7'; badgeEl.style.color = '#92400e';
      badgeEl.textContent = `⚠ ${ageH.toFixed(0)} h`;
    } else {
      badgeEl.style.background = '#dcfce7'; badgeEl.style.color = '#15803d';
      badgeEl.textContent = 'Aktivní';
    }
  }

  // Chyba poslední zálohy
  if (errEl) {
    if (r.last_error) {
      errEl.style.display = '';
      errEl.innerHTML = `<strong>Poslední chyba zálohy:</strong> ${String(r.last_error).replace(/</g,'&lt;')}`;
    } else {
      errEl.style.display = 'none';
      errEl.innerHTML = '';
    }
  }
}
async function runBackup() {
  const btn=document.getElementById('backupBtn');const msg=document.getElementById('backupMsg');
  btn.disabled=true;btn.innerHTML='<i class="ti ti-loader" style="font-size:13px"></i> Odesílám...';msg.innerHTML='';
  const r=await api('POST','/api/backup/run');
  if(r.ok){msg.innerHTML='<span class="msg-ok">✓ Záloha odeslána na email</span>';loadBackupInfo();}
  else msg.innerHTML=`<span class="msg-err">✗ ${r.error||'Chyba'}</span>`;
  btn.disabled=false;btn.innerHTML='<i class="ti ti-player-play" style="font-size:13px"></i> Spustit zálohu teď';
}

// ── Konfigurace zálohy per obalovna (krok 5/6) ──
async function loadBackupConfig() {
  const emailEl = document.getElementById('backupEmail');
  const hourEl  = document.getElementById('backupHour');
  if (!emailEl || !hourEl) return;
  if (!hourEl.options.length) {
    for (let h=0; h<24; h++) {
      const o=document.createElement('option');
      o.value=h; o.textContent=String(h).padStart(2,'0')+':00';
      hourEl.appendChild(o);
    }
  }
  const r = await api('GET','/api/backup/config');
  if (!r) return;
  emailEl.value = r.backup_email || '';
  emailEl.placeholder = r.fallback_email ? `${r.fallback_email} (výchozí)` : 'např. zalohy@firma.cz';
  hourEl.value = (r.backup_hour != null ? r.backup_hour : (r.default_hour != null ? r.default_hour : 18));
}
async function saveBackupConfig() {
  const btn=document.getElementById('backupCfgBtn');const msg=document.getElementById('backupCfgMsg');
  const backup_email=document.getElementById('backupEmail').value.trim();
  const backup_hour=document.getElementById('backupHour').value;
  btn.disabled=true;msg.innerHTML='';
  const r=await api('POST','/api/backup/config',{backup_email,backup_hour});
  if(r&&r.ok){msg.innerHTML='<span class="msg-ok">✓ Uloženo</span>';loadBackupInfo();}
  else msg.innerHTML=`<span class="msg-err">✗ ${(r&&r.error)||'Chyba uložení'}</span>`;
  btn.disabled=false;
}

async function doLogout() { await fetch('/api/logout',{method:'POST'}).catch(()=>{}); window.location.href='/login'; }

// ── Unified navigation ──
const NAV_ITEMS = {
  admin: [
    { key:'weekly',    label:'Týdenní',      href:'/index.html' },
    { key:'monthly',   label:'Měsíční',      href:'/month-view.html' },
    { key:'dashboard', label:'Dashboard',    href:'/dashboard' },
    { key:'inputs',    label:'Vstupy',       href:'/inputs' },
    { key:'settings',  label:'Nastavení',    href:'/settings.html' },
  ],
  operator: [
    { key:'weekly',    label:'Týdenní',      href:'/index.html' },
    { key:'monthly',   label:'Měsíční',      href:'/month-view.html' },
  ],
  hmg_share: [
    { key:'monthly',   label:'Měsíční',      href:'/month-view.html' },
    { key:'dashboard', label:'Seznam staveb',href:'/dashboard' },
  ],
};
function buildNav(role, activePage) {
  const nav = document.getElementById('navMenu');
  if (!nav) return;
  const items = NAV_ITEMS[role] || [];
  nav.innerHTML = items.map(function(item) {
    const active = item.key === activePage;
    return '<a href="' + item.href + '" class="btn nav' + (active ? ' active' : '') + '">' + item.label + '</a>';
  }).join('');
}

fetch('/api/me').then(r=>r.json()).then(d=>{
  buildNav(d.role, 'settings');
  const el=document.getElementById('footerUser');
  if(el&&d.username)el.textContent=d.username;
  const hu=document.getElementById('hdrUser');
  if(hu&&d.username)hu.textContent=d.username;
  const ha=document.getElementById('hdrAvatar');
  if(ha&&d.username)ha.textContent=d.username.trim().charAt(0).toUpperCase();
  // Karta „Nahrát váženky z váhy" — jen admin (server endpoint navíc má requireAdmin)
  if (d.role === 'admin') {
    const c = document.getElementById('card-vazenky-upload');
    if (c) c.style.display = '';
  }
}).catch(()=>{});

// ── Upload váženek z váhy (Nastavení → Data) ──────────────────────────────
function vzSettOnFileChange(ev) {
  const f = ev.target.files && ev.target.files[0];
  document.getElementById('vzSettFileName').textContent =
    f ? f.name + ' (' + Math.round(f.size/1024) + ' kB)' : 'žádný soubor';
  document.getElementById('vzSettUploadBtn').disabled = !f;
}
async function vzSettUpload() {
  const fileInput = document.getElementById('vzSettFile');
  const msg       = document.getElementById('vzSettMsg');
  const f = fileInput.files && fileInput.files[0];
  if (!f) return;
  msg.style.color = '#475569';
  msg.textContent = 'Nahrávám…';
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await fetch('/api/vazenky/upload', { method:'POST', body: fd });
    const d = await r.json();
    if (!r.ok) {
      msg.style.color = '#991b1b';
      msg.textContent = '✗ ' + (d.error || ('Chyba ' + r.status));
      return;
    }
    const s = d.summary;
    msg.style.color = '#15803d';
    msg.innerHTML =
      `✓ Nahráno <strong>${d.inserted}</strong> nových váženek ` +
      `(duplicity: ${d.duplicates}, přeskočeno: ${s.skipped_neprijem + s.skipped_storno + s.skipped_invalid}, ` +
      `nepřiřazeno k firmě: ${s.unassigned}).`;
    fileInput.value = '';
    document.getElementById('vzSettFileName').textContent = 'žádný soubor';
    document.getElementById('vzSettUploadBtn').disabled = true;
  } catch (e) {
    msg.style.color = '#991b1b';
    msg.textContent = '✗ ' + e.message;
  }
}

async function confirmDelete(type) {
  const label = type === 'weeks' ? 'vsechna data tydnu a mesicu' : 'vsechny receptury smesi';
  const password = prompt('Tato akce je nevratna!\nZadejte heslo admina pro smazani: ' + label);
  if (password === null) return;
  if (!password) { alert('Heslo nesmi byt prazdne.'); return; }
  const msg = document.getElementById('deleteMsg');
  msg.innerHTML = '<span style="color:#6b7280;font-size:13px">Probiha mazani...</span>';
  try {
    const res = await fetch('/api/admin/clear-' + type, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ password: password })
    });
    const r = await res.json();
    if (r.ok) {
      msg.innerHTML = '<span style="color:#16a34a;font-size:13px">Data byla uspesne smazana.</span>';
    } else {
      msg.innerHTML = '<span style="color:#dc2626;font-size:13px">Chyba: ' + (r.error || 'Neznama chyba.') + '</span>';
    }
  } catch(e) {
    msg.innerHTML = '<span style="color:#dc2626;font-size:13px">Chyba spojeni: ' + e.message + '</span>';
  }
}

loadUsers();

// ── SMTP nastavení ──
async function loadSmtpSettings() {
  try {
    const r = await api('GET', '/api/smtp-settings');
    document.getElementById('smtpHost').value = r.smtp_host || '';
    document.getElementById('smtpPort').value = r.smtp_port || '';
    document.getElementById('smtpUser').value = r.smtp_user || '';
    document.getElementById('smtpFrom').value = r.smtp_from || '';
    document.getElementById('smtpAdminEmails').value = r.smtp_admin_emails || '';
    const pwEl = document.getElementById('smtpPassword');
    const pwHint = document.getElementById('smtpPasswordHint');
    if (r.smtp_password_set) {
      pwEl.placeholder = '•••• nastaveno (prázdné = ponechat beze změny)';
      pwHint.innerHTML = '<span style="color:#9ca3af">Heslo je nastaveno. Prázdné pole = heslo se nezmění.</span>';
    } else {
      pwEl.placeholder = 'zadejte heslo';
      pwHint.textContent = '';
    }
  } catch(e) { console.error('loadSmtpSettings:', e); }
}
async function saveSmtpSettings() {
  const msg = document.getElementById('smtpMsg');
  const body = {
    smtp_host:         document.getElementById('smtpHost').value.trim(),
    smtp_port:         document.getElementById('smtpPort').value.trim(),
    smtp_user:         document.getElementById('smtpUser').value.trim(),
    smtp_password:     document.getElementById('smtpPassword').value,
    smtp_from:         document.getElementById('smtpFrom').value.trim(),
    smtp_admin_emails: document.getElementById('smtpAdminEmails').value.trim()
  };
  const r = await api('POST', '/api/smtp-settings', body);
  if (r.ok) {
    msg.innerHTML = '<span class="msg-ok">✓ Nastavení uloženo</span>';
    document.getElementById('smtpPassword').value = '';
    loadSmtpSettings();
    setTimeout(() => { msg.innerHTML = ''; }, 3000);
  } else {
    msg.innerHTML = `<span class="msg-err">✗ ${esc(r.error || 'Chyba')}</span>`;
  }
}
async function testSmtpEmail() {
  const msg = document.getElementById('smtpMsg');
  msg.innerHTML = '<span style="color:#0369a1;font-weight:500">⏳ Odesílám testovací email...</span>';
  const r = await api('POST', '/api/smtp-settings/test', {});
  if (r.ok) {
    msg.innerHTML = `<span class="msg-ok">✓ ${esc(r.message || 'Email odeslán')}</span>`;
  } else {
    msg.innerHTML = `<span class="msg-err">✗ ${esc(r.error || 'Chyba odeslání')}</span>`;
  }
}

// ── Objednávkový systém (přepínač) ──
async function loadSystemSettings() {
  try {
    // KASKÁDA krok 6: admin vidí přepínač JEN pro modul povolený superadminem (strop).
    // Co není povolené shora, je skryté a chová se jako vypnuté.
    let moduly = { mod_objednavky: false, mod_vazenky: false };
    try { moduly = await api('GET', '/api/obalovna/moduly') || moduly; } catch(e) {}
    const s = await api('GET', '/api/settings');

    const cardOrders = document.getElementById('card-orders');
    if (cardOrders) cardOrders.style.display = moduly.mod_objednavky ? '' : 'none';
    if (moduly.mod_objednavky) {
      const enabled = s.orders_enabled !== 'false'; // výchozí true
      const toggle = document.getElementById('ordersEnabledToggle');
      if (toggle) toggle.checked = enabled;
      _updateOrdersEnabledUI(enabled);
    }

    const cardVs = document.getElementById('card-vazenky-share');
    if (cardVs) cardVs.style.display = moduly.mod_vazenky ? '' : 'none';
    if (moduly.mod_vazenky) {
      const vsEnabled = s.vazenky_share_enabled === 'true';
      const vsToggle = document.getElementById('vazenkyShareToggle');
      if (vsToggle) vsToggle.checked = vsEnabled;
      _updateVazenkyShareUI(vsEnabled);
    }
  } catch(e) {
    console.error('loadSystemSettings:', e);
  }
}
function _updateVazenkyShareUI(enabled) {
  const lbl  = document.getElementById('vazenkyShareLabel');
  const desc = document.getElementById('vazenkyShareDesc');
  if (lbl)  lbl.textContent  = enabled ? 'Zapnuto' : 'Vypnuto';
  if (lbl)  lbl.style.color  = enabled ? '#16a34a' : '#dc2626';
  if (desc) desc.textContent = enabled
    ? 'Odběratelé vidí záložku „Odebrané stavby" (jen svoji firmu)'
    : 'Záložka „Odebrané stavby" je pro odběratele skryta';
}
async function saveVazenkyShare(enabled) {
  _updateVazenkyShareUI(enabled);
  const msg = document.getElementById('vazenkyShareMsg');
  const r = await api('POST', '/api/settings', { vazenky_share_enabled: enabled ? 'true' : 'false' });
  if (r.ok) {
    msg.innerHTML = '<span class="msg-ok">✓ Nastavení uloženo</span>';
    setTimeout(() => { msg.innerHTML = ''; }, 2500);
  } else {
    msg.innerHTML = `<span class="msg-err">✗ ${esc(r.error || 'Chyba')}</span>`;
    const vsToggle = document.getElementById('vazenkyShareToggle');
    if (vsToggle) vsToggle.checked = !enabled;
    _updateVazenkyShareUI(!enabled);
  }
}
function _updateOrdersEnabledUI(enabled) {
  const lbl  = document.getElementById('ordersEnabledLabel');
  const desc = document.getElementById('ordersEnabledDesc');
  if (lbl)  lbl.textContent  = enabled ? 'Zapnuto' : 'Vypnuto';
  if (lbl)  lbl.style.color  = enabled ? '#16a34a' : '#dc2626';
  if (desc) desc.textContent = enabled
    ? 'Odběratelé mohou zadávat objednávky, admin schvaluje'
    : 'Odběratelé mají jen prohlížení harmonogramu';
}
async function saveOrdersEnabled(enabled) {
  _updateOrdersEnabledUI(enabled);
  const msg = document.getElementById('ordersSystemMsg');
  const r = await api('POST', '/api/settings', { orders_enabled: enabled ? 'true' : 'false' });
  if (r.ok) {
    msg.innerHTML = '<span class="msg-ok">✓ Nastavení uloženo</span>';
    setTimeout(() => { msg.innerHTML = ''; }, 2500);
  } else {
    msg.innerHTML = `<span class="msg-err">✗ ${esc(r.error || 'Chyba')}</span>`;
    // vrátit toggle na původní hodnotu
    const toggle = document.getElementById('ordersEnabledToggle');
    if (toggle) toggle.checked = !enabled;
    _updateOrdersEnabledUI(!enabled);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// NAPOJENÍ on* ATRIBUTŮ → addEventListener / delegace (P2 #5 CSP, 7e-bis).
// Skript je na konci body → prvky existují; funkce jsou hoisted.
// Dynamické prvky (řádky uživatelů / sessions / tokeny) → DELEGACE na stabilní kontejnery.
// ═══════════════════════════════════════════════════════════════════════════
(function wireSettings(){
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  const click = (id, fn) => on(id, 'click', fn);

  // ── Sidenav (data-section) ──
  document.querySelectorAll('.nav-item[data-section]').forEach(el =>
    el.addEventListener('click', () => showSection(el.getAttribute('data-section'))));

  // ── Uživatelé ──
  click('btnAddUser', toggleAddUser);
  click('btnAddUserSubmit', addUser);
  click('btnAddUserCancel', toggleAddUser);
  on('newRole', 'change', function(){ onRoleChange(this.value); });

  // ── Data: import / zálohy / obnova / mazání ──
  click('btnImportXlsx', () => document.getElementById('settImportXlsx').click());
  on('settImportXlsx', 'change', settImportFromExcel);
  click('btnImportWeek', () => document.getElementById('settImportWeek').click());
  on('settImportWeek', 'change', settImportWeekData);
  click('btnZalohaDB', settZalohaDB);
  click('btnObnovaFile', () => document.getElementById('settObnovaFile').click());
  on('settObnovaFile', 'change', restoreStep1);
  click('restoreConfirmBtn', restoreStep2);
  click('btnRestoreCancel', restoreCancel);
  click('btnDeleteWeeks', () => confirmDelete('weeks'));
  click('btnDeleteInputs', () => confirmDelete('inputs'));
  on('vzSettFile', 'change', vzSettOnFileChange);
  click('btnVzSettFile', () => document.getElementById('vzSettFile').click());
  click('vzSettUploadBtn', vzSettUpload);

  // ── Zálohy / SMTP ──
  click('backupCfgBtn', saveBackupConfig);
  click('backupBtn', runBackup);
  click('btnSaveSmtp', saveSmtpSettings);
  click('btnTestSmtp', testSmtpEmail);

  // ── Systém (přepínače) ──
  on('ordersEnabledToggle', 'change', function(){ saveOrdersEnabled(this.checked); });
  on('vazenkyShareToggle',  'change', function(){ saveVazenkyShare(this.checked); });

  // ── Logout ──
  click('logoutBtn', doLogout);

  // ── DELEGACE: řádky uživatelů (usersBody) — click + change ──
  const usersBody = document.getElementById('usersBody');
  if (usersBody) {
    usersBody.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !usersBody.contains(el)) return;
      const uid = Number(el.getAttribute('data-uid')), uname = el.getAttribute('data-uname');
      switch (el.getAttribute('data-act')) {
        case 'changeFirma': changeFirma(uid, uname, el.getAttribute('data-firma') || ''); break;
        case 'changeEmail': changeEmail(uid, uname, el.getAttribute('data-email') || undefined); break;
        case 'resetPwd':    resetPassword(uid, uname); break;
        case 'deleteUser':  deleteUser(uid, uname); break;
      }
    });
    usersBody.addEventListener('change', (e) => {
      const el = e.target.closest('[data-act="toggleOrders"]'); if (!el || !usersBody.contains(el)) return;
      toggleOrdersAllowed(Number(el.getAttribute('data-uid')), el.checked);
    });
  }

  // ── DELEGACE: sessions (sessionsBody) ──
  const sessionsBody = document.getElementById('sessionsBody');
  if (sessionsBody) sessionsBody.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act="delSession"]'); if (!el || !sessionsBody.contains(el)) return;
    deleteSession(el.getAttribute('data-sid'));
  });

  // ── DELEGACE: share tokeny (shareTokensList) ──
  const tokList = document.getElementById('shareTokensList');
  if (tokList) tokList.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el || !tokList.contains(el)) return;
    if (el.getAttribute('data-act') === 'copyUrl')  copyUrl(el.getAttribute('data-url'));
    if (el.getAttribute('data-act') === 'delToken') deleteToken(el.getAttribute('data-token'));
  });
})();
