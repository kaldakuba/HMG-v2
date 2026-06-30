// superadmin.js — JS pro superadmin.html (P2 #5: přesun z inline <script>).
// FUNKCE/AUTORIZACE/API beze změny. Statické on* → addEventListener; dynamicky
// generované on* (seznam obaloven / superadminů) → data-* atributy + event delegation
// na stabilní rodiče (#obList, #saBody). Napojení viz sekce DOLE.

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function showErr(m){ const e=document.getElementById('errBox'); e.textContent=m; e.style.display='block'; }
function show(id,m){ const e=document.getElementById(id); if(m!=null)e.textContent=m; e.style.display='block'; }
function hide(id){ document.getElementById(id).style.display='none'; }
function fmtDate(x){ if(!x) return '—'; try{ return new Date(x).toLocaleDateString('cs-CZ'); }catch(e){ return String(x); } }
function fmtDateTime(x){ if(!x) return '—'; try{ return new Date(x).toLocaleString('cs-CZ'); }catch(e){ return String(x); } }
function toggleForm(id){ const e=document.getElementById(id); e.style.display = e.style.display==='none' ? 'block' : 'none'; }

async function doLogout(){
  try{ await fetch('/api/logout',{method:'POST'}); }catch(e){}
  window.location.href='/login';
}

// ── Globální přehled ──
async function loadPrehled(){
  try{
    const res=await fetch('/api/superadmin/prehled');
    if(!res.ok) return;
    const d=await res.json();
    document.getElementById('stObaloven').textContent = d.obaloven;
    document.getElementById('stAktiv').textContent    = d.aktivnich + ' / ' + d.demo;
    document.getElementById('stUziv').textContent     = d.uzivatelu;
  }catch(e){}
}

// ── Seznam obaloven (bloky s rozklikem) ──
async function load(){
  hide('errBox');
  try{
    const res = await fetch('/api/obalovny');
    if(res.status===401){ window.location.href='/login'; return; }
    if(res.status===403){ showErr('Tato stránka je jen pro superadmina.'); return; }
    if(!res.ok){ showErr('Chyba načtení ('+res.status+').'); return; }
    const rows = await res.json();
    if(!Array.isArray(rows) || rows.length===0){ document.getElementById('empty').style.display='block'; return; }
    const chk = (id,key,label,checked,disabled)=>
      '<label class="modchk'+(disabled?' dis':'')+'"><input type="checkbox" data-ob="'+id+'" data-mod="'+key+'"'
      + (checked?' checked':'')+(disabled?' disabled':'')+'> '+label+'</label>';
    document.getElementById('obList').innerHTML = rows.map(o=>{
      const id = esc(o.id);
      const stav = esc(o.stav);
      const stavCls = stav==='demo' ? 'stav-demo' : 'stav-aktivni';
      const mods = '<label class="modchk dis"><input type="checkbox" checked disabled> Harmonogram</label>'
                 + chk(id,'mod_vazenky','Váženky',o.mod_vazenky,false)
                 + chk(id,'mod_objednavky','Objednávky',o.mod_objednavky,false)
                 + chk(id,'mod_hod_objednavky','Hodinové objednávky',o.mod_hod_objednavky,!o.mod_objednavky);
      return '<div class="ob">'
        + '<div class="ob-head"><div><div class="ob-title">'+esc(o.nazev)+' <span class="stav '+stavCls+'">'+stav+'</span></div>'
        + '<div class="ob-sub">'+id+' · '+esc(o.subdomena)+'</div></div>'
        + '<button class="btn-detail" id="btn-'+id+'" data-action="detail" data-id="'+id+'">Detail</button></div>'
        + '<div class="ob-mods">'+mods+'</div>'
        + '<div class="ob-detail" id="detail-'+id+'" style="display:none"></div>'
        + '</div>';
    }).join('');
  }catch(e){ showErr('Chyba připojení k serveru.'); }
}

// ── Rozklik: obsazení + metriky (lazy) ──
async function toggleDetail(id){
  const panel = document.getElementById('detail-'+id);
  const btn = document.getElementById('btn-'+id);
  if(panel.style.display!=='none'){ panel.style.display='none'; btn.textContent='Detail'; return; }
  panel.style.display='block'; btn.textContent='Skrýt'; panel.innerHTML='<span class="muted">Načítám…</span>';
  try{
    const [oRes,mRes] = await Promise.all([
      fetch('/api/superadmin/obalovny/'+encodeURIComponent(id)+'/obsazeni'),
      fetch('/api/superadmin/obalovny/'+encodeURIComponent(id)+'/metriky'),
    ]);
    const o = await oRes.json(), m = await mRes.json();
    const names = a => (a&&a.length) ? a.map(esc).join(', ') : '—';
    const hmgNames = (m2)=> (m2&&m2.length) ? m2.map(u=>esc(u.username)+(u.firma?' ('+esc(u.firma)+')':'')).join(', ') : '—';
    // Admin: u každého tlačítko pro vygenerování dočasného hesla (reset).
    const adminList = (o.admins&&o.admins.names&&o.admins.names.length)
      ? o.admins.names.map(n=>'<div class="adminrow"><span>'+esc(n)+'</span>'
          + '<button class="btn-mini" data-action="reset-admin" data-ob="'+id+'" data-user="'+esc(n)+'">Vygenerovat dočasné heslo</button></div>').join('')
      : '<div class="muted">—</div>';
    panel.innerHTML =
      '<div class="det-grid">'
      + '<div class="det-col"><div class="det-h">Obsazení</div>'
      +   '<div class="det-row"><strong>Admin:</strong></div>'+adminList
      +   '<div class="resetout" id="resetOut-'+id+'"></div>'
      +   '<div class="det-row" style="margin-top:8px"><strong>Operátoři ('+(o.operatori?o.operatori.count:0)+'):</strong> '+names(o.operatori&&o.operatori.names)+'</div>'
      +   '<div class="det-row"><strong>Sdílené přístupy ('+(o.hmg_share?o.hmg_share.count:0)+'):</strong> '+hmgNames(o.hmg_share&&o.hmg_share.users)+'</div>'
      + '</div>'
      + '<div class="det-col"><div class="det-h">Metriky</div>'
      +   '<div class="det-row"><strong>Týdny v plánu:</strong> '+(m.tydny!=null?m.tydny:'—')+'</div>'
      +   '<div class="det-row"><strong>Poslední aktivita:</strong> '+fmtDate(m.posledniAktivita)+'</div>'
      +   '<div class="det-row"><strong>Poslední nahraná váženka:</strong> '+fmtDate(m.posledniVazenka)+'</div>'
      +   '<div class="det-row"><strong>Nevyřízené objednávky:</strong> '
      +     (m.objednavkySystem ? (m.nevyrizeneObjednavky!=null?m.nevyrizeneObjednavky:'—') : '<span class="muted">— systém vypnut</span>')+'</div>'
      +   '<div class="det-row"><strong>Poslední záloha:</strong> '
      +     (m.posledniZaloha ? fmtDateTime(m.posledniZaloha) : '<span class="muted">zatím neznámo</span>')+'</div>'
      + '</div>'
      + '</div>';
  }catch(e){ panel.innerHTML='<span class="muted">Chyba načtení detailu.</span>'; }
}

// ── Reset hesla admina obalovny (dávka C) ──
async function resetAdmin(obId, username){
  const out = document.getElementById('resetOut-'+obId);
  if(!confirm('Vygenerovat NOVÉ dočasné heslo pro admina „'+username+'"?\nStávající heslo přestane platit; admin si nové heslo při přihlášení musí změnit.')) return;
  if(out) out.innerHTML='<span class="muted">Generuji…</span>';
  try{
    const res=await fetch('/api/superadmin/obalovny/'+encodeURIComponent(obId)+'/reset-admin-heslo',
      {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username})});
    const d=await res.json();
    if(res.ok&&d.ok){
      out.innerHTML='<div class="pwbox"><div class="muted">Dočasné heslo pro <strong>'+esc(username)+'</strong> (jednorázově, předej adminovi):</div>'
        + '<div class="pwline"><code id="pw-'+obId+'">'+esc(d.tempPassword)+'</code>'
        + '<button class="btn-mini" data-action="copy-pw" data-ob="'+obId+'">Kopírovat</button>'
        + '<button class="btn-mini" data-action="reset-admin" data-ob="'+obId+'" data-user="'+esc(username)+'">Vygenerovat znovu</button></div>'
        + '<div class="muted">Admin si heslo při prvním přihlášení sám změní (vynucená změna).</div></div>';
    } else { out.innerHTML='<span class="err-inline">'+esc(d.error||'Reset selhal.')+'</span>'; }
  }catch(e){ out.innerHTML='<span class="err-inline">Chyba připojení.</span>'; }
}
function copyPw(obId){
  const el=document.getElementById('pw-'+obId); if(!el) return;
  const txt=el.textContent;
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(()=>{el.style.background='#dcfce7';},()=>{}); }
  else { try{ const r=document.createRange(); r.selectNode(el); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy'); s.removeAllRanges(); }catch(e){} }
}

// ── STROP modulů obalovny ── (závislost vynucuje i server; po uložení překreslíme)
async function onMod(el){
  hide('errBox');
  const ob = el.getAttribute('data-ob');
  const boxes = document.querySelectorAll('input[data-ob="'+(window.CSS&&CSS.escape?CSS.escape(ob):ob)+'"][data-mod]');
  const body = {};
  boxes.forEach(b=>{ body[b.getAttribute('data-mod')] = b.checked; });
  try{
    const res = await fetch('/api/obalovny/'+encodeURIComponent(ob)+'/moduly',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!res.ok){ const d=await res.json().catch(()=>({})); showErr(d.error||'Uložení modulů selhalo.'); }
  }catch(e){ showErr('Chyba připojení.'); }
  await load();
}

// ── Změna vlastního hesla ──
async function changePw(){
  hide('pwErr'); hide('pwOk');
  const p1=document.getElementById('newPw').value, p2=document.getElementById('newPw2').value;
  if(!p1 || p1.length<8){ show('pwErr','Heslo musí mít alespoň 8 znaků.'); return; }
  if(p1!==p2){ show('pwErr','Hesla se neshodují.'); return; }
  try{
    const res=await fetch('/api/superadmin/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newPassword:p1})});
    const d=await res.json();
    if(res.ok&&d.ok){ document.getElementById('newPw').value='';document.getElementById('newPw2').value=''; show('pwOk','Heslo změněno.'); }
    else show('pwErr',d.error||'Nepodařilo se změnit heslo.');
  }catch(e){ show('pwErr','Chyba připojení.'); }
}

// ── Správa superadminů ──
let currentUserId=null;
async function loadSa(){
  hide('saErr');
  try{
    const res=await fetch('/api/superadmin/list');
    if(!res.ok){ show('saErr','Chyba načtení superadminů.'); return; }
    const d=await res.json(); currentUserId=d.currentUserId;
    const rows=d.superadmins||[];
    const last = rows.length<=1;
    document.getElementById('saBody').innerHTML = rows.map(s=>{
      const me = s.id===currentUserId ? ' <span class="muted">(já)</span>' : '';
      const created = s.created_at ? new Date(s.created_at).toLocaleDateString('cs-CZ') : '';
      const disabled = last ? 'disabled title="Posledního superadmina nelze smazat"' : '';
      return '<tr><td><strong>'+esc(s.username)+'</strong>'+me+'</td><td class="muted">'+created+'</td>'
           + '<td style="text-align:right"><button class="btn-del" '+disabled+' data-action="del-sa" data-id="'+s.id+'" data-name="'+esc(s.username)+'">Smazat</button></td></tr>';
    }).join('');
    document.getElementById('saTbl').style.display='table';
  }catch(e){ show('saErr','Chyba připojení.'); }
}
async function createSa(){
  hide('saErr'); hide('saOk');
  const u=document.getElementById('saUser').value.trim(), p=document.getElementById('saPw').value;
  if(u.length<3){ show('saErr','Jméno musí mít alespoň 3 znaky.'); return; }
  if(!p || p.length<8){ show('saErr','Heslo musí mít alespoň 8 znaků.'); return; }
  try{
    const res=await fetch('/api/superadmin/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const d=await res.json();
    if(res.ok&&d.ok){ document.getElementById('saUser').value='';document.getElementById('saPw').value=''; show('saOk','Superadmin „'+esc(u)+'" založen.'); loadSa(); }
    else show('saErr',d.error||'Nepodařilo se založit superadmina.');
  }catch(e){ show('saErr','Chyba připojení.'); }
}
async function delSa(id,name){
  hide('saErr'); hide('saOk');
  if(!confirm('Opravdu smazat superadmina „'+name+'"?')) return;
  try{
    const res=await fetch('/api/superadmin/'+id,{method:'DELETE'});
    const d=await res.json();
    if(res.ok&&d.ok){
      show('saOk','Superadmin smazán.');
      if(id===currentUserId){ window.location.href='/login'; return; }
      loadSa();
    } else show('saErr',d.error||'Nepodařilo se smazat.');
  }catch(e){ show('saErr','Chyba připojení.'); }
}

// ── Audit a přihlášení ──
var AUDIT_TYP = {
  login_ok:'Přihlášení OK', login_fail:'Přihlášení – neúspěch', reset_admin_hesla:'Reset hesla admina',
  superadmin_create:'Založení superadmina', superadmin_delete:'Smazání superadmina', obalovna_moduly:'Změna modulů obalovny'
};
async function loadAudit(){
  hide('auditErr');
  const typ = document.getElementById('auditTyp').value;
  try{
    const res = await fetch('/api/superadmin/audit'+(typ?('?typ='+encodeURIComponent(typ)):''));
    if(!res.ok){ show('auditErr','Chyba načtení auditu ('+res.status+').'); return; }
    const d = await res.json();
    const rows = d.zaznamy||[];
    if(rows.length===0){ document.getElementById('auditTbl').style.display='none'; document.getElementById('auditEmpty').style.display='block'; return; }
    document.getElementById('auditEmpty').style.display='none';
    document.getElementById('auditBody').innerHTML = rows.map(z=>{
      const cilDetail = [z.cil, z.detail].filter(Boolean).map(esc).join(' · ') || '—';
      return '<tr><td class="muted">'+fmtDateTime(z.ts)+'</td>'
        + '<td>'+esc(AUDIT_TYP[z.typ]||z.typ)+'</td>'
        + '<td>'+esc(z.akter||'—')+'</td>'
        + '<td>'+esc(z.role||'—')+'</td>'
        + '<td>'+esc(z.obalovna_id||'—')+'</td>'
        + '<td>'+cilDetail+'</td></tr>';
    }).join('');
    document.getElementById('auditTbl').style.display='table';
  }catch(e){ show('auditErr','Chyba připojení.'); }
}

loadPrehled();
load();
loadSa();
loadAudit();

// ─────────────────────────────────────────────────────────────────────────────
// NAPOJENÍ on* (P2 #5). Soubor je na konci body → statické prvky existují.
// ─────────────────────────────────────────────────────────────────────────────
// Statické on* → addEventListener
document.getElementById('logoutBtn').addEventListener('click', doLogout);
document.getElementById('togglePwBtn').addEventListener('click', () => toggleForm('pwForm'));
document.getElementById('toggleNewBtn').addEventListener('click', () => toggleForm('newForm'));
document.getElementById('changePwBtn').addEventListener('click', changePw);
document.getElementById('createSaBtn').addEventListener('click', createSa);
document.getElementById('auditReloadBtn').addEventListener('click', loadAudit);
document.getElementById('auditTyp').addEventListener('change', loadAudit);

// Dynamicky generované prvky (seznam obaloven/superadminů se překresluje) → EVENT DELEGATION
// na stabilní rodiče #obList a #saBody (existují vždy; děti vznikají později).
const _obList = document.getElementById('obList');
if (_obList) {
  // checkbox modulů (původně onchange="onMod(this)")
  _obList.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-ob][data-mod]');
    if (cb) onMod(cb);
  });
  // Detail / reset-admin / kopírovat (původně onclick=…)
  _obList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b || !_obList.contains(b)) return;
    const a = b.dataset.action;
    if (a === 'detail')           toggleDetail(b.dataset.id);
    else if (a === 'reset-admin') resetAdmin(b.dataset.ob, b.dataset.user);
    else if (a === 'copy-pw')     copyPw(b.dataset.ob);
  });
}
const _saBody = document.getElementById('saBody');
if (_saBody) {
  // Smazat superadmina (původně onclick="delSa(id,name)")
  _saBody.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action="del-sa"]');
    if (b) delSa(Number(b.dataset.id), b.dataset.name);
  });
}
