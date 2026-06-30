// ─────────────────────────────────────────────────────────────────────────────
// inputs.js — JS pro inputs.html (P2 #5: přesun z inline <script> do externího souboru).
// Pořadí kódu zachováno (blok 1 = app logika, blok 2 = nav/me/logout, blok 3 = verze v patičce).
// Inline on* atributy z HTML převedeny na addEventListener (viz sekce DOLE).
// Pozn.: `.onclick=` / addEventListener uvnitř JS (render/legenda/edit) NEJSOU inline atributy
//        → CSP script-src-attr je neřeší → ponechány beze změny.
// ─────────────────────────────────────────────────────────────────────────────

// ── BLOK 1: aplikační logika ──
const cols=['cislo','smes','zt','c04','c24','c48','c811','c1116','c1622','b5070','b255560','b458065','b2030','prach','vapenec','addbit','scel','ra16','ra22','celkem'];
const headers=['číslo','Směs','ITT','0/4','2/4','4/8','8/11','11/16','16/22','50/70','25/55-60','45/80-65','20/30','prach','vápenec','addbit','S-CEL','16RA 0/11','22RA 0/16','celkem'];
const formCols=cols.filter(c=>c!=='celkem');
const sumCols=['c04','c24','c48','c811','c1116','c1622','b5070','b255560','b458065','b2030','prach','vapenec','addbit','scel','ra16','ra22'];
const labels=Object.fromEntries(cols.map((c,i)=>[c,headers[i]]));
const base=[['1','ACO 11+ 50/70','1-2025-Ho','27,0','7,0','30,0','17,0','','','5,3','','','2,0','2,0','0,2','','15,0','',''],['2','ACL 16+ 50/70','2-2025-Ho','25,0','8,0','13,0','13,0','21,0','','3,6','','','','2,0','2,0','0,2','','15,0','',''],['3','ACP 16+ 50/70','3-2025-Ho','24,0','7,0','14,0','14,0','22,0','','3,3','','','','2,0','2,0','0,2','','15,0','',''],['4','ACP 22+ 50/70','4-2025-Ho','28,5','8,0','12,0','8,0','','26,0','3,7','','','','1,0','1,5','0,2','','','15,0',''],['5','ACO 11+ 25/55-60','5-2025-Ho','27,0','7,0','30,0','17,0','','','','5,3','','','2,0','2,0','0,2','','15,0','',''],['10','ACO 8 50/70 (Bez R)','10-2025-Ho','48,8','8,0','36,0','','','','6,3','','','','3,0','5,0','0,2','','','',''],['15','SMA 11S 45/80-65','15-2025-Ho','16,0','9,0','25,0','41,7','','','','','6,8','','3,0','5,0','0,2','0,3','','',''],['20','SMA 16S 45/80-65','20-2025-Ho','16,9','','16,9','18,8','33,8','','','','6,0','','','7,5','0,2','0,3','','',''],['','Laková','LAK','','','','','','','','','','','','','','','','','']].map(a=>Object.fromEntries(cols.map((c,i)=>[c,a[i]||''])));
let selectedIndex=null;let undoStack=[];
function loadRows(){return window._inputRows||base}
function saveRows(r){window._inputRows=r;fetch('/api/inputs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:r})}).catch(()=>{})}
// loadFromDB nahrazeno initInputs()
function fmt(v){if(!v&&v!==0)return'';let n=Math.round(v*10)/10;return Number.isInteger(n)?String(n):String(n).replace('.',',');}
function parseNumber(v){let n=parseFloat(String(v||'').trim().replace(/\s/g,'').replace(',','.'));return isNaN(n)?0:n}
function formatNumber(n){let r=Math.round(n*10)/10;return Number.isInteger(r)?String(r):String(r).replace('.',',')}
function rowTotal(r){let t=0;sumCols.forEach(c=>t+=parseNumber(r[c]));return Math.round(t*10)/10}
function rowTotalOk(r){return Math.abs(rowTotal(r)-100)<0.05}
function renderHead(){document.getElementById('headRow').innerHTML=headers.map((h,i)=>`<th class="${i>=9&&i<=12?'gray':i===17||i===18?'green-cell':''}">${h}</th>`).join('')}
function render(){renderHead();const b=document.getElementById('mixBody');b.innerHTML='';loadRows().forEach((r,idx)=>{r.celkem=formatNumber(rowTotal(r));const tr=document.createElement('tr');if(idx===selectedIndex)tr.classList.add('selected-row');if(['10','15','20','22'].includes(String(r.cislo||'')))tr.classList.add('thick-top');tr.onclick=()=>selectRow(idx);cols.forEach((c,i)=>{const td=document.createElement('td');td.textContent=(c==='celkem')?formatNumber(rowTotal(r)):(r[c]||'');if(i>=9&&i<=12)td.classList.add('gray');if(i===17||i===18)td.classList.add('green-cell');if(c==='celkem')td.classList.add(rowTotalOk(r)?'sum-ok':'sum-bad');tr.appendChild(td)});b.appendChild(tr)});updateSelectedInfo()}
function selectRow(idx){selectedIndex=idx;render()}
function updateSelectedInfo(){selectedInfo.textContent=selectedIndex===null?'Není označen žádný řádek':'Označen řádek: '+(selectedIndex+1)}
function snapshot(){undoStack.push(JSON.stringify(loadRows()));if(undoStack.length>20)undoStack.shift()}
function deleteSelectedRow(){if(selectedIndex===null){alert('Nejdřív klikni na řádek tabulky, který chceš smazat.');return}const rows=loadRows();const r=rows[selectedIndex];if(!confirm('Smazat označený řádek: '+((r&&r.smes)||'bez názvu')+'?'))return;snapshot();rows.splice(selectedIndex,1);saveRows(rows);selectedIndex=null;render()}
function undoLast(){if(!undoStack.length){alert('Není co vrátit zpět.');return}saveRows(JSON.parse(undoStack.pop()));selectedIndex=null;render()}
function updateTotal(){let total=0;sumCols.forEach(c=>total+=parseNumber(document.getElementById('in_'+c)?.value));in_celkem.value=formatNumber(total);in_celkem.classList.toggle('total-ok',Math.abs(total-100)<0.05);in_celkem.classList.toggle('total-bad',Math.abs(total-100)>=0.05)}
function isTotalOk(){return Math.abs(parseNumber(in_celkem.value)-100)<0.05}
function markRequired(){['in_smes','in_zt'].forEach(id=>{const e=document.getElementById(id);if(e)e.classList.toggle('input-error',!e.value.trim())})}
function buildForm(){const g=document.getElementById('inputGrid');g.innerHTML='';formCols.forEach(c=>{const d=document.createElement('div');d.className='field';d.innerHTML=`<label>${labels[c]}</label>`;const i=document.createElement('input');i.id='in_'+c;if(sumCols.includes(c))i.addEventListener('input',updateTotal);if(['smes','zt'].includes(c))i.addEventListener('input',markRequired);d.appendChild(i);g.appendChild(d)});updateTotal()}
function addMix(){updateTotal();markRequired();if(!in_smes.value.trim()||!in_zt.value.trim()){alert('Nelze uložit. Musí být vyplněná Směs a ITT.');return}if(!isTotalOk()){alert('Nelze uložit. Součet v poli celkem musí být přesně 100.');return}snapshot();const r={};cols.forEach(c=>r[c]=(document.getElementById('in_'+c)?.value||'').trim());r.celkem=formatNumber(rowTotal(r));if(!r.cislo)r.cislo=String(loadRows().filter(x=>x.cislo).length+1);const rows=loadRows();rows.push(r);saveRows(rows);clearForm();render();}
function clearForm(){formCols.forEach(c=>{const e=document.getElementById('in_'+c);if(e){e.value='';e.classList.remove('input-error')}});updateTotal()}
function exportExcel(){const rows=loadRows();let css='table{border-collapse:collapse;font-family:Arial;font-size:10pt}th,td{border:1px solid #111;padding:4px 6px;text-align:center}th{background:#f2f2f2}.gray{background:#e7e7e7}.green{background:#d9ead3}.bad{background:#f4cccc;color:#990000;font-weight:bold}.thick td{border-top:3px solid #000}';let s='<html><head><meta charset="UTF-8"><style>'+css+'</style></head><body><table><thead><tr>';headers.forEach((h,i)=>s+=`<th class="${i>=9&&i<=12?'gray':i===17||i===18?'green':''}">${esc(h)}</th>`);s+='</tr></thead><tbody>';rows.forEach(r=>{s+=`<tr class="${['10','15','20','22'].includes(String(r.cislo||''))?'thick':''}">`;cols.forEach((c,i)=>{let val=(c==='celkem')?formatNumber(rowTotal(r)):(r[c]||'');let cls=i>=9&&i<=12?'gray':i===17||i===18?'green':(c==='celkem'&&!rowTotalOk(r))?'bad':'';s+=`<td class="${cls}">${esc(val)}</td>`});s+='</tr>'});s+='</tbody></table></body></html>';downloadBlob(new Blob(['﻿'+s],{type:'application/vnd.ms-excel;charset=utf-8'}),'vstupy_smesi.xls')}
function esc(v){return String(v).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]))}
function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500)}
function importExcel(ev){const f=ev.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=e=>{try{const t=e.target.result;let data=f.name.toLowerCase().endsWith('.csv')?parseCsv(t):parseHtmlTable(t);if(!data.length){alert('V souboru nebyla nalezena tabulka.');return}if(!confirm('Import přepíše aktuální tabulku. Pokračovat?'))return;snapshot();data.forEach(r=>r.celkem=formatNumber(rowTotal(r)));saveRows(data);selectedIndex=null;render();alert('Import hotov. Načteno řádků: '+data.length)}catch(err){alert('Import se nepovedl: '+err.message)}finally{ev.target.value=''}};rd.readAsText(f,'utf-8')}
function parseHtmlTable(t){const doc=new DOMParser().parseFromString(t,'text/html');const trs=[...(doc.querySelector('table')||document.createElement('table')).querySelectorAll('tr')];return trs.slice(1).map(tr=>{const cells=[...tr.querySelectorAll('td,th')].map(td=>td.textContent.trim());const o={};cols.forEach((c,i)=>o[c]=cells[i]||'');o.celkem=formatNumber(rowTotal(o));return o}).filter(o=>Object.values(o).some(v=>v))}
function parseCsv(t){return t.split(/\r?\n/).filter(l=>l.trim()).slice(1).map(line=>{const cells=line.split(';').length>1?line.split(';'):line.split(',');const o={};cols.forEach((c,i)=>o[c]=(cells[i]||'').trim());o.celkem=formatNumber(rowTotal(o));return o}).filter(o=>Object.values(o).some(v=>v))}
function saveSettings(){const data={hmg_plant_rate:document.getElementById('plantRateInput').value||'150',hmg_gas_capacity:document.getElementById('gasCapacityInput').value||'10000',hmg_max_daily:document.getElementById('maxDailyInput').value||'1000',hmg_min_daily:document.getElementById('minDailyInput').value||'0'};fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(()=>{const s=document.getElementById('settingsSaved');s.style.display='inline';setTimeout(()=>s.style.display='none',2000)}).catch(()=>{});}
// settings načteny v initInputs()
const defaultCompanies=[{name:'Colas',color:'#fff2a8'},{name:'Firesta',color:'#d9ead3'},{name:'Mi Roads',color:'#ff7f86'}];
function loadCompanies(){return window._companies||defaultCompanies}
function saveCompanies(c){window._companies=c;fetch('/api/companies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companies:c})}).catch(()=>{})}
let _dragSrcIdx=null;
function darkenHex(hex){try{const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return'rgb('+Math.round(r*.4)+','+Math.round(g*.4)+','+Math.round(b*.4)+')';}catch(e){return'#374151';}}
function renderLegend(){
  const tbody=document.getElementById('companyTbody');
  if(!tbody)return;
  const companies=loadCompanies();
  tbody.innerHTML='';
  companies.forEach((c,idx)=>{
    const tr=document.createElement('tr');
    tr.draggable=true;
    tr.addEventListener('dragstart',e=>{_dragSrcIdx=idx;e.dataTransfer.effectAllowed='move';setTimeout(()=>tr.classList.add('row-dragging'),0);});
    tr.addEventListener('dragend',()=>{tr.classList.remove('row-dragging');document.querySelectorAll('#companyTbody tr').forEach(r=>r.classList.remove('row-drag-over'));_dragSrcIdx=null;});
    tr.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';document.querySelectorAll('#companyTbody tr').forEach(r=>r.classList.remove('row-drag-over'));if(_dragSrcIdx!==idx)tr.classList.add('row-drag-over');});
    tr.addEventListener('drop',e=>{e.preventDefault();if(_dragSrcIdx===null||_dragSrcIdx===idx)return;const arr=loadCompanies();const[moved]=arr.splice(_dragSrcIdx,1);arr.splice(idx,0,moved);saveCompanies(arr);renderLegend();});
    // Drag handle
    const tdH=document.createElement('td');tdH.style.textAlign='center';
    tdH.innerHTML='<span class="cpanel-drag" title="Přetáhni pro změnu pořadí"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg></span>';
    // Name
    const tdN=document.createElement('td');tdN.style.fontWeight='700';tdN.textContent=c.name;
    // Color swatch
    const tdC=document.createElement('td');
    const inp=document.createElement('input');inp.type='color';inp.value=c.color;inp.className='cpanel-swatch';inp.title='Klikni pro výběr barvy';
    inp.addEventListener('mousedown',e=>e.stopPropagation());
    inp.addEventListener('change',()=>{const arr=loadCompanies();arr[idx].color=inp.value;saveCompanies(arr);renderLegend();});
    tdC.appendChild(inp);
    // Badge preview
    const tdP=document.createElement('td');
    const badge=document.createElement('span');badge.className='cpanel-badge';badge.style.background=c.color;badge.style.color=darkenHex(c.color);badge.textContent=c.name;
    tdP.appendChild(badge);
    // Delete
    const tdA=document.createElement('td');
    const del=document.createElement('button');del.className='cpanel-delbtn';del.innerHTML='🗑';del.title='Smazat firmu '+c.name;
    del.addEventListener('mousedown',e=>e.stopPropagation());
    del.onclick=()=>{if(!confirm('Smazat firmu „'+c.name+'"?'))return;saveCompanies(loadCompanies().filter((_,i)=>i!==idx));renderLegend();};
    tdA.appendChild(del);
    tr.append(tdH,tdN,tdC,tdP,tdA);
    tbody.appendChild(tr);
  });
}
function saveCompany(){const name=document.getElementById('companyName').value.trim(),color=document.getElementById('companyColor').value;if(!name){alert('Zadej název firmy.');return}const arr=loadCompanies();const f=arr.find(x=>x.name.toLowerCase()===name.toLowerCase());if(f){f.color=color;}else arr.push({name,color});saveCompanies(arr);document.getElementById('companyName').value='';renderLegend();}
async function initInputs(){
  const rows=await fetch('/api/inputs').then(r=>r.json()).catch(()=>null);
  if(rows)window._inputRows=rows;
  const companies=await fetch('/api/companies').then(r=>r.json()).catch(()=>null);
  if(companies)window._companies=companies;
  const settings=await fetch('/api/settings').then(r=>r.json()).catch(()=>({}));
  if(settings.hmg_plant_rate)document.getElementById('plantRateInput').value=settings.hmg_plant_rate;
  if(settings.hmg_gas_capacity)document.getElementById('gasCapacityInput').value=settings.hmg_gas_capacity;
  if(settings.hmg_max_daily)document.getElementById('maxDailyInput').value=settings.hmg_max_daily;
  if(settings.hmg_min_daily)document.getElementById('minDailyInput').value=settings.hmg_min_daily;
  buildForm();renderLegend();render();
}
initInputs();
let _editMode=false;
function toggleEdit(){_editMode=!_editMode;const btn=document.getElementById('editBtn');const tbody=document.getElementById('mixBody');if(_editMode){btn.textContent='Uložit změny';btn.className='btn-soft orange';tbody.classList.add('edit-mode');renderEditable();}else{btn.textContent='Editovat recepturu';btn.className='btn-soft green';tbody.classList.remove('edit-mode');saveEdits();render();}}
function calcRowTotal(tr){let sum=0;tr.querySelectorAll('.edit-input[data-col]').forEach(inp=>{if(inp.getAttribute('data-col')!=='celkem'){sum+=parseNumber(inp.value);}});return Math.round(sum*10)/10;}
function updateCelkem(tr){const total=calcRowTotal(tr);const ok=Math.abs(total-100)<0.05;const td=tr.querySelector('.celkem-td');if(td){td.textContent=formatNumber(total);td.style.background=ok?'#f0fdf4':'#fee2e2';td.style.color=ok?'#15803d':'#991b1b';td.style.fontWeight='700';}}
function renderEditable(){const rows=loadRows();const b=document.getElementById('mixBody');b.innerHTML='';rows.forEach((r,idx)=>{const tr=document.createElement('tr');if(idx===selectedIndex)tr.classList.add('selected-row');if(['10','15','20','22'].includes(String(r.cislo||'')))tr.classList.add('thick-top');tr.onclick=()=>selectRow(idx);cols.forEach((c,i)=>{const td=document.createElement('td');if(c==='celkem'){td.classList.add('celkem-td');const total=rowTotal(r);const ok=rowTotalOk(r);td.textContent=formatNumber(total);td.style.background=ok?'#f0fdf4':'#fee2e2';td.style.color=ok?'#15803d':'#991b1b';td.style.fontWeight='700';}else if(c!=='celkem'){td.classList.add('editable-cell');const inp=document.createElement('input');inp.className='edit-input';inp.value=r[c]||'';inp.setAttribute('data-row',idx);inp.setAttribute('data-col',c);inp.onclick=e=>e.stopPropagation();if(i>=3)inp.addEventListener('input',()=>updateCelkem(tr));td.appendChild(inp);}else{td.textContent=r[c]||'';}if(i>=9&&i<=12)td.classList.add('gray');if(i===17||i===18)td.classList.add('green-cell');tr.appendChild(td);});b.appendChild(tr);});}
function saveEdits(){snapshot();const rows=loadRows();document.querySelectorAll('.edit-input').forEach(inp=>{const idx=parseInt(inp.getAttribute('data-row'));const col=inp.getAttribute('data-col');if(rows[idx])rows[idx][col]=inp.value;});rows.forEach(r=>r.celkem=formatNumber(rowTotal(r)));saveRows(rows);}
// Pozn.: původní `loadFromDB();` zde bylo MRTVÉ (funkce neexistuje, nahrazena initInputs()) —
// při sloučení skriptů do jednoho souboru odstraněno, aby chyba nezastavila zbytek kódu.

// ── BLOK 2: navigace + uživatel + odhlášení ──
fetch('/api/me').then(r=>r.json()).then(d=>{
  buildNav(d.role, 'inputs');
  const el = document.getElementById('footerUser');
  if(el && d.username) el.textContent = d.username;
  const hu = document.getElementById('hdrUser');
  if(hu && d.username) hu.textContent = d.username;
  const ha = document.getElementById('hdrAvatar');
  if(ha && d.username) ha.textContent = d.username.trim().charAt(0).toUpperCase();
}).catch(()=>{});

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

async function doLogout(){
  await fetch('/api/logout',{method:'POST'}).catch(()=>{});
  window.location.href='/login';
}

// ── BLOK 3: verze v patičce ──
fetch('/api/version').then(r=>r.json()).then(function(d){var v=document.getElementById('footerVersion');if(v&&d.version)v.textContent='TAXIS v'+d.version+' · 2026';}).catch(function(){});

// ─────────────────────────────────────────────────────────────────────────────
// NAPOJENÍ INLINE on* ATRIBUTŮ → addEventListener (P2 #5; soubor je na konci body,
// všechny prvky existují). Funkce/chování beze změny.
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', importExcel);
document.getElementById('exportBtn').addEventListener('click', exportExcel);
document.getElementById('editBtn').addEventListener('click', toggleEdit);
document.getElementById('deleteBtn').addEventListener('click', deleteSelectedRow);
document.getElementById('undoBtn').addEventListener('click', undoLast);
document.getElementById('addMixBtn').addEventListener('click', addMix);
document.getElementById('clearFormBtn').addEventListener('click', clearForm);
document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
document.getElementById('saveCompanyBtn').addEventListener('click', saveCompany);
const _logoutBtn = document.getElementById('logoutBtn');
if (_logoutBtn) {
  _logoutBtn.addEventListener('click', doLogout);
  _logoutBtn.addEventListener('mouseenter', () => { _logoutBtn.style.background = '#fff1f2'; });
  _logoutBtn.addEventListener('mouseleave', () => { _logoutBtn.style.background = 'transparent'; });
}
