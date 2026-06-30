// index-page.js — přesunuto z inline <script> v index.html (P2 #5, rušení CSP 'unsafe-inline').
// FUNKCE BEZE ZMĚNY. Inline on* atributy převedeny na addEventListener / event delegation.
// Spolupráce s order-approval.js (OA.*) zachována; OA řeší objednávkové řádky přes data-oa-action
// (document-level delegace) — zdejší delegace je scoped na #tbody a používá vlastní data-act.

const dayKeys=['d0','d1','d2','d3','d4','d5','d6'];let undoStack=[];
const mixCols=['c04','c24','c48','c811','c1116','c1622','b5070','b255560','b458065','b2030','prach','vapenec','addbit','scel','ra16','ra22'];
const matLabels={c04:'0/2',c24:'2/4',c48:'4/8',c811:'8/11',c1116:'11/16',c1622:'16/22',b5070:'50/70',b255560:'25/55-60',b458065:'45/80-65',b2030:'20/30',ra16:'16 - RA011',ra22:'22 - RA016',vapenec:'Vápenec',prach:'Vratný prach',addbit:'ANOVA',scel:'S-CEL'};

// ── STAV (v paměti, ne localStorage) ──
let _weekStart = defaultMonday();
let _rows = null;
let _mixes = [];
let _companies = [{name:'Colas',color:'#fff2a8'},{name:'Firesta',color:'#d9ead3'},{name:'Mi Roads',color:'#ff7f86'}];
let _settings = {hmg_plant_rate:'150',hmg_gas_capacity:'10 000',hmg_max_daily:'1000'};
let _loading = false;      // true během načítání týdne → saveRows() se ignoruje
let _role = '';
let _weekOrderDaySums = {d0:0,d1:0,d2:0,d3:0,d4:0,d5:0,d6:0};

function showSaving(){const el=document.getElementById('savingIndicator');el.textContent='Ukládám...';el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1500)}
function showSaved(){const el=document.getElementById('savingIndicator');el.textContent='✓ Uloženo';el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1500)}

// ── HELPERS ──
function defaultMonday(){const d=new Date();const day=d.getDay()||7;d.setDate(d.getDate()-day+1);return localIso(d)}
function getWeekStart(){return _weekStart}
function setWeekStart(v){_weekStart=v;_rows=null}
function localIso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function isoDateFromStart(startIso,i){const d=new Date(startIso);d.setDate(d.getDate()+i);return localIso(d)}
function fmtShort(iso){const d=new Date(iso);return d.getDate()+'.'+(d.getMonth()+1)+'.'}
function fmtTitleRange(start){const a=new Date(start),b=new Date(start);b.setDate(a.getDate()+6);return a.getDate()+'.'+(a.getMonth()+1)+'. – '+b.getDate()+'.'+(b.getMonth()+1)+'.'+b.getFullYear()}
function updateWeekNavBtn(){
  const btn=document.getElementById('currentWeekBtn');if(!btn)return;
  // Na desktopu vždy původní popis, číslo týdne + rozsah dat jen na mobilu
  if(!IS_MOBILE){btn.innerHTML='Tento týden';return;}
  const week=isoWeek(new Date(_weekStart));
  const range=fmtTitleRange(_weekStart);
  const isCurrent=(_weekStart===defaultMonday());
  btn.innerHTML='<span style="display:block;font-size:13px;font-weight:800">Týden '+week+(isCurrent?' ·&nbsp;aktuální':'')+
    '</span><span style="display:block;font-size:10px;font-weight:500;letter-spacing:0;opacity:.9">'+range+'</span>';
}
function isoWeek(date){const d=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()));const day=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()+4-day);const yearStart=new Date(Date.UTC(d.getUTCFullYear(),0,1));return Math.ceil((((d-yearStart)/86400000)+1)/7)}
function _easter(y){const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1;return new Date(y,mo-1,da)}
function isHolidayIso(id){const p=String(id).split('-').map(Number);const y=p[0],m=p[1],d=p[2];const fixed=['01-01','05-01','05-08','07-05','07-06','09-28','10-28','11-17','12-24','12-25','12-26'];if(fixed.includes(String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0')))return true;const e=_easter(y);const gf=new Date(e);gf.setDate(e.getDate()-2);const em=new Date(e);em.setDate(e.getDate()+1);return id===localIso(gf)||id===localIso(em)}
function fmtNum(v,dec){if(v===0||v==="0")return "0";if(!v)return "";const num=parseFloat(String(v).replace(",","."));if(isNaN(num))return v;if(dec!==undefined)return num.toLocaleString("cs-CZ",{minimumFractionDigits:dec,maximumFractionDigits:dec}).replace(/ /g," ");return num.toLocaleString("cs-CZ").replace(/ /g," ");}
function n(v){const x=parseInt(String(v||'').replace(/\D+/g,''),10);return isNaN(x)?0:x}
function dec(v){const x=parseFloat(String(v||'').replace(',','.').replace(/[^0-9.\-]/g,''));return isNaN(x)?0:x}
function intVal(v){return String(n(v)||'')}
function rowSum(r){return dayKeys.reduce((s,k)=>s+n(r[k]),0)}
function daySum(rows,k){return rows.reduce((s,r)=>s+n(r[k]),0)}
function snapshot(){undoStack.push(JSON.stringify(_rows));if(undoStack.length>20)undoStack.shift()}
function loadMixes(){return _mixes}
function loadCompanies(){return _companies}
function companyColor(name){const c=_companies.find(x=>x.name===name);return c?c.color:''}
function mixByNumber(v){return _mixes.find(x=>String(x.cislo||'').trim()===String(v||'').trim())}
function mixByName(v){return _mixes.find(x=>String(x.smes||'').trim()===String(v||'').trim())}
function mixByItt(v){return _mixes.find(x=>String(x.zt||x.itt||'').trim()===String(v||'').trim())}
function applyMix(row,m){if(!m)return;row.cislo=m.cislo||row.cislo||'';row.smes=m.smes||'';row.itt=m.zt||m.itt||''}
function uniq(arr){return [...new Set(arr.filter(x=>String(x||'').trim()!==''))]}
function esc(v){return String(v||'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]))}

function defaultRows(){return Array.from({length:12},()=>({checked:false,cislo:'',lokalita:'',objednavka:'',smes:'',itt:'',ceta:'',d0:'',d1:'',d2:'',d3:'',d4:'',d5:'',d6:'',lat:null,lng:null}))}

// ── API VOLÁNÍ ──
async function apiLoadWeek(start){
  const r=await fetch('/api/week/'+start);
  if(!r.ok)return null;
  return await r.json();
}
async function apiSaveWeek(start,rows){
  showSaving();
  await fetch('/api/week/'+start,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows})});
  // sync měsíc
  const entries=buildMonthEntries(rows,start);
  await fetch('/api/month-entries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(entries)});
  showSaved();
}

function buildMonthEntries(rows,start){
  // načti existující a přepiš jen dny tohoto týdne
  return {_week:start,rows,start};
}

async function loadWeek(start){
  _loading=true;                       // pojistka: během načítání se neukládá
  try{
    const data=await apiLoadWeek(start);
    _rows=data||defaultRows();
  }finally{
    _loading=false;
  }
}

// Scheduler ukládání: zachytí cílový týden + řádky v okamžiku editace (viz week-save-scheduler.js)
const _saveScheduler=createWeekSaveScheduler((w,r)=>apiSaveWeek(w,r),{delay:400});

function saveRows(){
  if(!_rows)return;
  if(_loading)return;                   // neukládej nad polovičně načteným týdnem
  // Zamkni cílový týden + kopii řádků k tomuto naplánovanému uložení (timeout nečte _weekStart)
  _saveScheduler.schedule(_weekStart,[..._rows]);
}

// Flush + cancel: zruš čekající debounce a OKAMŽITĚ doulož na PŮVODNÍ týden.
// Volat PŘED jakoukoli změnou _weekStart a PŘED loadWeek.
async function flushPendingSave(){
  await _saveScheduler.flush();
}

// ── RENDER ──
function renderHead(){
  const start=_weekStart;const rows=_rows||[];const dates=dayKeys.map((_,i)=>isoDateFromStart(start,i));
  const week=isoWeek(new Date(start));
  updateWeekNavBtn();
  const _cl=document.getElementById('calWeekLabel');if(_cl)_cl.textContent=week+'. týden';
  const _ds=k=>daySum(rows,k)+(_weekOrderDaySums[k]||0);
  const total=dayKeys.reduce((s,k)=>s+_ds(k),0);
  const maxDaily=parseInt(_settings.hmg_max_daily||'1000');
  const minDaily=parseInt(_settings.hmg_min_daily||'0')||0;
  const cap=_settings.hmg_gas_capacity||'10 000';
  thead.innerHTML=`<tr><th class="cap-label" colspan="2">Denní kapacita plynu:</th><th class="cap-value">${cap} m3</th><th></th><th class="sum-label" colspan="2">Součet t/den:</th>${dayKeys.map(k=>{const _v=_ds(k);const _oM=_v>maxDaily;const _uM=_v>0&&minDaily>0&&_v<minDaily;return`<th class="sum-head" style="${_oM?'background:#fee2e2!important;color:#991b1b!important;':_uM?'background:#fef9c3!important;color:#92400e!important;':''}">  ${fmtNum(_v)}</th>`;}).join('')}<th class="sum-head">${fmtNum(total)}</th><th class="sel-col"></th></tr><tr style='height:38px'><th>č.</th><th>lokalita</th><th>objednávka</th><th>Směs a průkazná zk. typu</th><th>ITT</th><th>četa</th>${dates.map((d,i)=>{const hol=isHolidayIso(d);const we=i>=5;const cls=hol?'holiday-day':(we?'gray-day':'blue-day');const col=hol?'#15803d':(we?'#9a9a9a':'#555');return `<th class="${cls}" style="color:${col}">${fmtShort(d)}${hol?`<div style="font-size:9px;font-weight:600;color:#15803d;line-height:1">svátek</div>`:''}</th>`;}).join('')}<th>souhrn</th><th class='sel-col'>✓</th></tr>`;
}

function selectOptions(values,current){return `<option value=""></option>${values.map(v=>`<option value="${esc(v)}" ${String(v)===String(current||'')?'selected':''}>${esc(v)}</option>`).join('')}`}

function buildWeekOrderRowsHtml(){
  // Reset per-day order sums (also clears them when non-admin)
  dayKeys.forEach(k=>{_weekOrderDaySums[k]=0;});
  const _ordersEnabledNow=_settings.orders_enabled!=='false';
  if(IS_MOBILE||_role!=='admin'||typeof OA==='undefined'||!_ordersEnabledNow)return '';
  const weekDates=dayKeys.map((_,i)=>isoDateFromStart(_weekStart,i));
  let html='';
  for(const g of OA.getPendingGroups()){
    const weekRows=(g.rows||[]).filter(r=>weekDates.indexOf(String(r.datum).slice(0,10))>=0);
    if(!weekRows.length)continue;
    const byMix={};
    weekRows.forEach(r=>{
      const key=(r.smes||'')+'|'+(r.itt||'');
      if(!byMix[key])byMix[key]={smes:r.smes||'',itt:r.itt||'',daysMap:{},statusMap:{}};
      const d=String(r.datum).slice(0,10);
      byMix[key].daysMap[d]=(byMix[key].daysMap[d]||0)+(parseInt(r.tuny)||0);
      const ord=['pre_rejected','pre_approved','pending'];
      const cur=byMix[key].statusMap[d];
      if(!cur||ord.indexOf(r.status)>ord.indexOf(cur))byMix[key].statusMap[d]=r.status;
    });
    for(const[mixKey,mx]of Object.entries(byMix)){
      weekDates.forEach((d,di)=>{if(mx.daysMap[d])_weekOrderDaySums[dayKeys[di]]+=mx.daysMap[d];});
      html+=OA.buildWeekOrderRow(g,mixKey,mx.smes,mx.itt,mx.daysMap,mx.statusMap,weekDates);
    }
  }
  return html;
}

function render(){
  if(!_rows)return;
  const orderHtml=buildWeekOrderRowsHtml(); // updates _weekOrderDaySums for renderHead
  renderHead();
  const rows=_rows;const nums=uniq(_mixes.map(x=>x.cislo));const smesi=uniq(_mixes.map(x=>x.smes));const itts=uniq(_mixes.map(x=>x.zt||x.itt));
  let html='';
  rows.forEach((r,i)=>{
    const color=companyColor(r.ceta);
    html+=`<tr class="${r.checked?'row-checked':''}" style="${color?'background:'+color:''}"><td style="background:#f8fafc;font-weight:800;font-size:13px"><select class="select-cell" style="font-weight:800" data-act="mix" data-key="cislo" data-i="${i}">${selectOptions(nums,r.cislo)}</select></td><td style="position:relative"><input class="editable" style="padding-right:20px" value="${esc(r.lokalita||'')}" data-act="cell" data-key="lokalita" data-i="${i}"><button class="gps-btn${r.lat?' has-gps':''}" type="button" data-act="gps" data-i="${i}" title="${r.lat?'GPS: '+Number(r.lat).toFixed(4)+', '+Number(r.lng).toFixed(4):'Nastavit GPS'}">📍</button></td><td><input class="editable" value="${esc(r.objednavka||'')}" data-act="cell" data-key="objednavka" data-i="${i}"></td><td><select class="select-cell" data-act="mix" data-key="smes" data-i="${i}">${selectOptions(smesi,r.smes)}</select></td><td><select class="select-cell" data-act="mix" data-key="itt" data-i="${i}">${selectOptions(itts,r.itt)}</select></td><td><select class="select-cell" data-act="cell" data-key="ceta" data-i="${i}"><option value=""></option>${_companies.map(c=>`<option value="${esc(c.name)}" ${c.name===(r.ceta||'')?'selected':''}>${esc(c.name)}</option>`).join('')}</select></td>`;
    dayKeys.forEach((k,di)=>{const dv=r[k]?fmtNum(n(r[k])||0)||"":"";const _d=isoDateFromStart(_weekStart,di);const _cls=isHolidayIso(_d)?'holiday-day':(di>=5?'gray-day':'blue-day');html+=`<td class="${_cls}"><input class="day-input" inputmode="numeric" value="${esc(dv)}" data-act="day" data-key="${k}" data-i="${i}"></td>`;});
    html+=`<td class="row-total">${fmtNum(rowSum(r))}</td><td class="sel-col" style="background:#f8fafc"><input type="checkbox" ${r.checked?'checked':''} data-act="check" data-i="${i}"></td></tr>`;
  });
  tbody.innerHTML=html+orderHtml;renderFoot(rows);renderPanels();updateSelectedInfo();
  // Operátor: deaktivuj všechna vstupní pole v tabulce po každém re-renderu
  if (_role === 'operator') {
    document.querySelectorAll('table input, table select, table textarea').forEach(el => { el.disabled = true; });
  }
}

function renderFoot(rows){
  const rate=n(plantRate.value)||150;
  let html=`<tr class="hours-row"><td colspan="6" style="text-align:left;padding-left:12px;font-size:11px;font-weight:700;letter-spacing:.2px">průměrná doba výroby obalovny (hod.)</td>`;
  dayKeys.forEach(k=>{html+=`<td>${fmtNum(daySum(rows,k)/rate,1)}</td>`;});
  html+=`<td>${fmtNum(dayKeys.reduce((s,k)=>s+daySum(rows,k),0)/rate,1)}</td><td></td></tr>`;
  tfoot.innerHTML=html;
}

function updateSelectedInfo(){
  const checked=(_rows||[]).map((r,i)=>r.checked?i:-1).filter(i=>i>=0);
  const c=checked.length;
  selectedInfo.textContent=c?'Zatrženo řádků: '+c:'Není zatržen žádný řádek';
  // Tlačítka ▲/▼ aktivní jen když je zatržen právě jeden řádek a není na okraji
  const up=document.getElementById('moveUpBtn');
  const dn=document.getElementById('moveDownBtn');
  if(up&&dn){
    const single = (c===1) ? checked[0] : -1;
    up.disabled = (single<=0);
    dn.disabled = (single<0 || single>=(_rows||[]).length-1);
    const hint = c===0 ? 'Nejdřív zatrhni jeden řádek' : c>1 ? 'Označen víc než jeden řádek' : '';
    if (hint) { up.title=hint; dn.title=hint; }
    else { up.title='Přesunout označený řádek nahoru'; dn.title='Přesunout označený řádek dolů'; }
  }
}
// Pomocné: před přesunem vyvolej blur na případně editované buňce,
// aby se její neuložená hodnota dostala přes onchange do _rows.
function _commitEditingCell(){
  const el=document.activeElement;
  if(el && el.closest && el.closest('#weekTable')) el.blur();
}
function moveCheckedUp(){
  _commitEditingCell();
  const checked=_rows.map((r,i)=>r.checked?i:-1).filter(i=>i>=0);
  if(checked.length!==1) return;
  const i=checked[0];
  if(i<=0) return;
  snapshot();
  [_rows[i-1],_rows[i]] = [_rows[i],_rows[i-1]];   // řádek si nese 'checked' s sebou
  render();saveRows();
}
function moveCheckedDown(){
  _commitEditingCell();
  const checked=_rows.map((r,i)=>r.checked?i:-1).filter(i=>i>=0);
  if(checked.length!==1) return;
  const i=checked[0];
  if(i>=_rows.length-1) return;
  snapshot();
  [_rows[i+1],_rows[i]] = [_rows[i],_rows[i+1]];
  render();saveRows();
}
function updateCheck(i,val){_rows[i].checked=val;render();saveRows()}
function updateMixSelect(i,key,val){snapshot();let m=key==='cislo'?mixByNumber(val):key==='smes'?mixByName(val):mixByItt(val);applyMix(_rows[i],m);render();saveRows()}
function updateCell(i,key,val,autofill=false,integer=false){snapshot();_rows[i][key]=integer?intVal(val):val;render();saveRows()}
function addRow(){snapshot();_rows.push({checked:false,cislo:'',lokalita:'',objednavka:'',smes:'',itt:'',ceta:'',d0:'',d1:'',d2:'',d3:'',d4:'',d5:'',d6:'',lat:null,lng:null});render();saveRows()}
function deleteCheckedRows(){if(!_rows.some(r=>r.checked)){alert('Nejdřív zatrhni řádky ke smazání.');return}snapshot();_rows=_rows.filter(r=>!r.checked);render();saveRows()}
function undoLast(){if(!undoStack.length){alert('Není co vrátit zpět.');return}_rows=JSON.parse(undoStack.pop());render();saveRows()}

async function shiftWeek(delta){
  await flushPendingSave();             // doulož rozpracovaný týden, než přepneme
  const d=new Date(_weekStart);d.setDate(d.getDate()+delta*7);
  _weekStart=d.toISOString().slice(0,10);
  await loadWeek(_weekStart);
  if(_role==='admin'&&typeof OA!=='undefined'&&_settings.orders_enabled!=='false')await OA.loadPendingGroups();
  if(IS_MOBILE)renderMobile();else render();
}
async function currentWeek(){
  await flushPendingSave();             // doulož rozpracovaný týden, než přepneme
  _weekStart=defaultMonday();await loadWeek(_weekStart);
  if(_role==='admin'&&typeof OA!=='undefined'&&_settings.orders_enabled!=='false')await OA.loadPendingGroups();
  if(IS_MOBILE)renderMobile();else render();
}

function setPlantRate(v){
  _settings.hmg_plant_rate=v;
  fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hmg_plant_rate:v})});
}

// ── PANELY ──
function togglePanel(id){
  const panel=document.getElementById(id);const row=document.getElementById('panelsRow');
  panel.style.display=panel.style.display==='none'?'block':'none';
  const anyVisible=document.getElementById('materialsPanel').style.display!=='none'||document.getElementById('mixesPanel').style.display!=='none';
  row.style.display=anyVisible?'flex':'none';renderPanels();
}
function recipeBySmes(smes,itt){return _mixes.find(m=>String(m.smes||'')===String(smes||'')&&(String(m.zt||m.itt||'')===String(itt||'')||!itt))||_mixes.find(m=>String(m.smes||'')===String(smes||''))||{}}
function renderPanels(){renderMaterials();renderMixes()}
function renderMaterials(){
  const rows=_rows||[];const start=_weekStart;const dates=dayKeys.map((_,i)=>isoDateFromStart(start,i));
  const groups=[['KAMENIVO',['c04','c24','c48','c811','c1116','c1622']],['ASFALT',['b5070','b255560','b458065','b2030']],['R-MAT',['ra16','ra22']],['Přísady',['vapenec','prach','addbit','scel']]];
  const dayTotals=dayKeys.map(()=>({}));const weekTotals={};
  mixCols.forEach(c=>{weekTotals[c]=0;dayKeys.forEach((_,di)=>dayTotals[di][c]=0);});
  rows.forEach(r=>{const rec=recipeBySmes(r.smes,r.itt);dayKeys.forEach((k,di)=>{const t=n(r[k]);if(t>0){mixCols.forEach(c=>{const v=t*dec(rec[c])/100;dayTotals[di][c]=(dayTotals[di][c]||0)+v;weekTotals[c]=(weekTotals[c]||0)+v;});}});});
  let h='<table class="material-table" style="width:auto;table-layout:fixed">';
  h+='<tr><th class="mat-name">materiál</th>';
  dates.forEach((d,i)=>{const dc=i>=5?'gray-day':'blue-day';h+='<th class="mat-val '+dc+'">'+fmtShort(d)+'</th>';});
  h+='<th class="mat-val mix-total">souhrn</th></tr>';
  let grandDay=dayKeys.map(()=>0);let grandTotal=0;
  groups.forEach(g=>{
    h+='<tr><td class="section-head" colspan="'+(dayKeys.length+2)+'">'+g[0]+'</td></tr>';
    g[1].forEach(c=>{const weekV=Math.round(weekTotals[c]||0);if(weekV===0&&dayKeys.every((_,di)=>Math.round(dayTotals[di][c]||0)===0))return;grandTotal+=weekV;h+='<tr><td class="mat-name">'+matLabels[c]+'</td>';dayKeys.forEach((_,di)=>{const v=Math.round(dayTotals[di][c]||0);grandDay[di]+=v;const dc=di>=5?'gray-day':'blue-day';h+='<td class="mat-val '+dc+'">'+(v>0?fmtNum(v):'')+'</td>';});h+='<td class="mat-val mix-total">'+(weekV>0?fmtNum(weekV):'')+'</td></tr>';});
  });
  h+='<tr><td class="mat-name" style="font-weight:900">CELKEM</td>';
  dayKeys.forEach((_,di)=>{const dc=di>=5?'gray-day':'blue-day';h+='<td class="mat-val '+dc+'" style="font-weight:900">'+(grandDay[di]>0?fmtNum(grandDay[di]):'')+'</td>';});
  h+='<td class="mat-val mix-total" style="font-weight:900">'+fmtNum(grandTotal)+'</td></tr></table>';
  materialsArea.innerHTML=h;
}
function renderMixes(){
  const rows=_rows||[];const start=_weekStart;let by={};
  rows.forEach(r=>{const key=(r.smes||'')+'|'+(r.itt||'');if(!r.smes)return;if(!by[key])by[key]={smes:r.smes,itt:r.itt,days:{}};dayKeys.forEach(k=>by[key].days[k]=(by[key].days[k]||0)+n(r[k]))});
  let h='<table class="mix-table"><tr><th>směs</th><th>ITT</th>'+dayKeys.map((k,i)=>'<th class="mix-day">'+fmtShort(isoDateFromStart(start,i))+'</th>').join('')+'<th class="mix-total">celkem</th></tr>';
  Object.values(by).forEach(r=>{h+='<tr><td>'+esc(r.smes)+'</td><td>'+esc(r.itt)+'</td>';let total=0;dayKeys.forEach(k=>{total+=r.days[k]||0;h+='<td class="mix-day">'+(r.days[k]||0)+'</td>'});h+='<td class="mix-total">'+total+'</td></tr>'});
  h+='</table>';mixesArea.innerHTML=h;
}

// ── EXPORT ──
async function exportWeeks(){
  const r=await fetch('/api/export');const payload=await r.json();
  let css='table{border-collapse:collapse;font-family:Arial;font-size:10pt;margin-bottom:18px}th,td{border:1px solid #222;padding:4px;text-align:center}th{font-weight:bold;background:#f2f2f2}.blue-day{background:#ddebf7}.gray-day{background:#d9d9d9}.sum-head{background:#fce4d6;font-weight:bold}.cap-value{background:#ffe600;font-weight:bold}.hours-row td{background:#d9d9d9;font-weight:bold}';
  let html='<html><head><meta charset="UTF-8"><style>'+css+'</style></head><body><!--HMG_WEEK_DATA:'+btoa(unescape(encodeURIComponent(JSON.stringify(payload))))+'--><h1>HARMONOGRAM VÝROBY - export týdnů</h1>';
  payload.weeks.forEach(w=>{html+=weekTableHtml(w.start,w.rows)});
  html+='</body></html>';
  downloadBlob(new Blob(['﻿'+html],{type:'application/vnd.ms-excel;charset=utf-8'}),'HMG_export_tydny.xls');
}
function weekTableHtml(start,rows){
  const rate=n(plantRate.value)||150;const week=isoWeek(new Date(start));let dates=dayKeys.map((_,i)=>isoDateFromStart(start,i));let total=dayKeys.reduce((s,k)=>s+daySum(rows,k),0);
  let s='<table><tr><th colspan="15">Kalendářní týden č. '+week+' | '+fmtTitleRange(start)+'</th></tr>';
  s+=`<tr><th colspan="2">Denní kapacita plynu:</th><th>${_settings.hmg_gas_capacity||'10 000'} m3</th><th></th><th colspan="2" style="text-align:right">Součet t/den:</th>${dayKeys.map(k=>`<th class="sum-head">${fmtNum(daySum(rows,k))}</th>`).join('')}<th class="sum-head">${total}</th></tr>`;
  s+='<tr><th>č.</th><th>lokalita</th><th>objednávka</th><th>Směs a průkazná zk. typu</th><th>ITT</th><th>četa</th>'+dates.map((d,i)=>'<th class="'+(i>=5?'gray-day':'blue-day')+'">'+fmtShort(d)+'</th>').join('')+'<th>souhrn</th></tr>';
  rows.forEach(r=>{s+='<tr><td>'+esc(r.cislo)+'</td><td>'+esc(r.lokalita)+'</td><td>'+esc(r.objednavka)+'</td><td>'+esc(r.smes)+'</td><td>'+esc(r.itt)+'</td><td>'+esc(r.ceta)+'</td>';dayKeys.forEach((k,i)=>s+='<td class="'+(i>=5?'gray-day':'blue-day')+'">'+esc(r[k])+'</td>');s+='<td><b>'+rowSum(r)+'</b></td></tr>'});
  s+='<tr class="hours-row"><td colspan="6">průměrná doba výroby obalovny (hod.)</td>'+dayKeys.map(k=>'<td>'+(daySum(rows,k)/rate).toFixed(1).replace('.',',')+'</td>').join('')+'<td>'+(total/rate).toFixed(1).replace('.',',')+'</td></tr></table>';
  return s;
}
function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500)}

// ── SEL MODE ──
let _selMode=false;
function toggleSelMode(){
  _selMode=!_selMode;const table=document.getElementById('weekTable');const btn=document.getElementById('selModeBtn');const deleteBtns=document.querySelectorAll('.delete-btn');const moveBtns=document.querySelectorAll('.move-btn');
  if(_selMode){table.classList.remove('sel-hidden');btn.textContent='Označit ✕';btn.classList.remove('gray');btn.classList.add('orange');deleteBtns.forEach(b=>b.style.display='');moveBtns.forEach(b=>b.style.display='');}
  else{table.classList.add('sel-hidden');btn.textContent='Označit';btn.classList.remove('orange');btn.classList.add('gray');deleteBtns.forEach(b=>b.style.display='none');moveBtns.forEach(b=>b.style.display='none');_rows.forEach(r=>r.checked=false);render();saveRows();}
}

// ── MINI KALENDÁŘ ──
let _miniCalY=new Date().getFullYear(),_miniCalM=new Date().getMonth();
const _mcMonths=['Leden','Únor','Březen','Duben','Květen','Červen','Červenec','Srpen','Září','Říjen','Listopad','Prosinec'];
function getMondayStr(d){const x=new Date(d);x.setDate(d.getDate()-((d.getDay()||7)-1));return localIso(x);}
function toggleMiniCal(){const c=document.getElementById('miniCal');if(c.style.display==='none'){const now=new Date();_miniCalY=now.getFullYear();_miniCalM=now.getMonth();c.style.display='block';renderMiniCal();}else{c.style.display='none';}}
document.addEventListener('click',function(e){const cal=document.getElementById('miniCal');const btn=document.getElementById('calToggleBtn');if(cal&&cal.style.display!=='none'&&!cal.contains(e.target)&&!(btn&&btn.contains(e.target))){cal.style.display='none';}});
function shiftMiniCal(d){_miniCalM+=d;if(_miniCalM>11){_miniCalM=0;_miniCalY++;}if(_miniCalM<0){_miniCalM=11;_miniCalY--;}renderMiniCal();}
function renderMiniCal(){
  document.getElementById('miniCalHeader').textContent=_mcMonths[_miniCalM]+' '+_miniCalY;
  const grid=document.getElementById('miniCalGrid');const cells=grid.querySelectorAll('.mc-day');cells.forEach(c=>c.remove());
  const firstDay=new Date(_miniCalY,_miniCalM,1).getDay();const offset=firstDay===0?6:firstDay-1;const dim=new Date(_miniCalY,_miniCalM+1,0).getDate();
  const today=new Date();today.setHours(0,0,0,0);const todayMon=getMondayStr(today);const curStart=_weekStart;
  for(let i=0;i<offset;i++){const el=document.createElement('div');el.className='mc-day';el.style.cssText='padding:5px;font-size:13px;';grid.appendChild(el);}
  for(let d=1;d<=dim;d++){
    const el=document.createElement('div');el.className='mc-day';const dd=new Date(_miniCalY,_miniCalM,d);dd.setHours(0,0,0,0);const mon=getMondayStr(dd);
    const isToday=dd.getTime()===today.getTime();const isTodayWeek=mon===todayMon;const isSelWeek=mon===curStart;const isWe=dd.getDay()===0||dd.getDay()===6;
    let bg=isTodayWeek?'#eff6ff':'transparent';let color=isWe?'#9ca3af':'#111';let fw=isToday?'900':'400';let border=isSelWeek?'2px solid #2563eb':'1px solid transparent';let br=isToday?'50%':'4px';
    if(isToday){bg='#2563eb';color='#fff';}
    el.style.cssText='padding:5px;font-size:13px;text-align:center;border-radius:'+br+';cursor:pointer;background:'+bg+';color:'+color+';font-weight:'+fw+';box-sizing:border-box;border:'+border+';font-family:Inter,sans-serif;';
    el.textContent=d;el.title=dd.toLocaleDateString('cs-CZ');
    el.onclick=(function(m){return async function(){await flushPendingSave();setWeekStart(m);await loadWeek(m);render();document.getElementById('miniCal').style.display='none';};})(mon);
    grid.appendChild(el);
  }
}


// ══════════════════════════════════════════════════════
// MOBILNÍ READ-ONLY MÓD
// Pokud šířka okna <= 900px, přepne do read-only zobrazení
// ══════════════════════════════════════════════════════
const IS_MOBILE = window.innerWidth <= 900;
if(IS_MOBILE) document.body.classList.add('mobile-ro');

// Kompaktní jednořádkový header pro mobil (hmg_share — pouze týdenní pohled)
function buildMobileHeader(){
  const tb=document.querySelector('.topbar');
  if(!tb)return;
  tb.innerHTML=
    '<span class="hdr-logo">TAXIS</span>'+
    '<span class="hdr-sep"></span>'+
    '<div class="m-weeknav"><button class="m-arrow" data-mnav="-1">‹</button>'+
    '<button class="m-today" data-mnav="today">Tento týden</button>'+
    '<button class="m-arrow" data-mnav="1">›</button></div>'+
    '<div class="m-weekinfo"><span id="mWeekNum"></span><span id="mWeekRange"></span></div>'+
    '<div class="hdr-right"><span class="hdr-firma" id="hdrFirma" style="display:none"></span><span class="hdr-avatar" id="hdrAvatar"></span></div>';
  // CSP: inline onclick → addEventListener (statické po vytvoření prvků)
  tb.querySelectorAll('[data-mnav]').forEach(function(b){
    b.addEventListener('click',function(){
      const v=b.getAttribute('data-mnav');
      if(v==='today')currentWeek();else shiftWeek(parseInt(v,10));
    });
  });
}
async function loadMobileUser(){
  try{
    const me=await fetch('/api/me').then(r=>r.json());
    _role=me.role||'';
    const ha=document.getElementById('hdrAvatar');
    if(ha&&me.username)ha.textContent=me.username.trim().charAt(0).toUpperCase();
    if(me.firma){const f=document.getElementById('hdrFirma');if(f){f.textContent=me.firma;f.style.display='';}}
  }catch(e){}
}
if(IS_MOBILE) buildMobileHeader();

function renderMobileHead(){
  const start=_weekStart;const rows=_rows||[];const dates=dayKeys.map((_,i)=>isoDateFromStart(start,i));
  const week=isoWeek(new Date(start));
  const mn=document.getElementById('mWeekNum');if(mn)mn.textContent=week+'. týden';
  const mr=document.getElementById('mWeekRange');if(mr)mr.textContent=fmtTitleRange(start);
  const total=dayKeys.reduce((s,k)=>s+daySum(rows,k),0);
  const maxDaily=parseInt(_settings.hmg_max_daily||'1000');
  const minDaily=parseInt(_settings.hmg_min_daily||'0')||0;
  // Řádek součtů + řádek datumů
  thead.innerHTML=
    `<tr><th class="sum-label" colspan="4" style="text-align:left;padding-left:6px">Součet t/den:</th>`+
    dayKeys.map(k=>{const s=daySum(rows,k);const overMax=s>maxDaily;const underMin=s>0&&minDaily>0&&s<minDaily;return`<th class="sum-head" style="${overMax?'background:#fee2e2!important;color:#991b1b!important;':underMin?'background:#fef9c3!important;color:#92400e!important;':''}">${s||''}</th>`}).join('')+
    `<th class="sum-head">${fmtNum(total)}</th></tr>`+
    `<tr><th>č.</th><th>lokalita</th><th>směs</th><th>četa</th>`+
    dates.map((d,i)=>`<th class="${i>=5?'gray-day':'blue-day'}" style="${i>=5?'color:#6b7280':'color:#1d4ed8'}">${fmtShort(d)}</th>`).join('')+
    `<th>Σ</th></tr>`;
}

function renderMobile(){
  if(!_rows)return;
  renderMobileHead();
  const rows=_rows;
  let html='';
  rows.forEach((r)=>{
    if(!r.cislo&&!r.lokalita&&!r.smes&&!r.ceta&&dayKeys.every(k=>!r[k]))return; // přeskočit prázdné řádky
    const color=companyColor(r.ceta);
    const bg=color?'background:'+color:'';
    html+=`<tr style="${bg}">`;
    html+=`<td style="font-weight:700;font-size:9px">${esc(r.cislo||'')}</td>`;
    html+=`<td style="text-align:left;padding-left:3px">${esc(r.lokalita||'')}</td>`;
    html+=`<td style="text-align:left;padding-left:3px">${esc(r.smes||'')}</td>`;
    html+=`<td style="font-weight:600">${esc(r.ceta||'')}</td>`;
    dayKeys.forEach((k,di)=>{
      const v=r[k]?fmtNum(n(r[k]))||'':'';
      html+=`<td class="${di>=5?'gray-day':'blue-day'}" style="font-weight:${v?'700':'400'}">${v}</td>`;
    });
    html+=`<td class="row-total">${fmtNum(rowSum(r))||''}</td>`;
    html+=`</tr>`;
  });
  tbody.innerHTML=html;
  // Řádek hodin v patičce - zjednodušený
  const rate=n((document.getElementById('plantRate')||{}).value||'150')||150;
  const total=dayKeys.reduce((s,k)=>s+daySum(rows,k),0);
  tfoot.innerHTML=`<tr class="hours-row"><td colspan="4" style="text-align:left;padding-left:6px">hod. výroby:</td>${dayKeys.map(k=>`<td>${fmtNum(daySum(rows,k)/rate,1)}</td>`).join('')}<td>${fmtNum(total/rate,1)}</td></tr>`;
}


// ── GPS / MAPA (Mapy.cz API v4) ──
// ── GPS stav ──
let _mapyCzKey='';let _mapRowIdx=-1;let _mapTempCoords=null;

async function openMapPopup(rowIdx,e){
  if(e){e.stopPropagation();e.preventDefault();}
  _mapRowIdx=rowIdx;
  const row=_rows[rowIdx];
  _mapTempCoords=(row.lat!=null&&row.lng!=null)?{lat:+row.lat,lng:+row.lng}:null;
  document.getElementById('mapPopupTitle').textContent='📍 '+(row.lokalita||'GPS souřadnice');
  document.getElementById('mapSearchInput').value=row.lokalita||'';
  document.getElementById('mapLatInput').value='';
  document.getElementById('mapLngInput').value='';
  document.getElementById('mapOverlay').classList.add('open');
  if(_mapTempCoords){
    // Máme uložené souřadnice — zobraz rovnou
    updateMapInputs(_mapTempCoords.lat,_mapTempCoords.lng);
    showMapImage(_mapTempCoords.lat,_mapTempCoords.lng);
  } else if(row.lokalita&&row.lokalita.trim()){
    // Geocoduj název lokality
    showMapLoading();
    await geocodeAndShow(row.lokalita);
  } else {
    showMapPlaceholder();
  }
}

// Geocoding přes Mapy.cz REST API v1
async function geocodeAddress(query){
  const url=`https://api.mapy.cz/v1/geocode?query=${encodeURIComponent(query)}&lang=cs&limit=1&apikey=${_mapyCzKey}`;
  const r=await fetch(url);
  if(!r.ok)throw new Error(`HTTP ${r.status}`);
  const d=await r.json();
  if(d.items&&d.items.length>0){const p=d.items[0].position;return{lat:p.lat,lng:p.lon};}
  return null;
}

async function geocodeAndShow(query){
  try{
    const coords=await geocodeAddress(query);
    if(coords){
      _mapTempCoords=coords;
      updateMapInputs(coords.lat,coords.lng);
      showMapImage(coords.lat,coords.lng);
    } else {
      showMapMsg('⚠️ Adresa nenalezena — zadejte souřadnice ručně nebo upřesněte hledaný výraz.');
    }
  }catch(ex){
    showMapMsg('❌ Chyba geocodingu: '+esc(ex.message));
  }
}

// Mapa jako iframe OpenStreetMap (zobrazí interaktivní mapu s pinem, bez API klíče)
function showMapImage(lat,lng){
  const d=0.008; // bbox padding ~900m
  const bbox=`${lng-d},${lat-d},${lng+d},${lat+d}`;
  const src=`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
  document.getElementById('mapImgArea').innerHTML=
    `<iframe src="${src}" style="width:100%;height:360px;border:none;display:block" loading="lazy" title="Mapa lokality"></iframe>`+
    `<div style="text-align:right;padding:3px 8px;background:#f9fafb;border-top:0.5px solid #e5e7eb;font-size:10px;color:#9ca3af">© <a href="https://www.openstreetmap.org/copyright" target="_blank" style="color:#9ca3af">OpenStreetMap</a></div>`;
}
function showMapLoading(){
  document.getElementById('mapImgArea').innerHTML=
    '<div style="display:flex;align-items:center;justify-content:center;height:360px;color:#6b7280;font-size:13px;gap:8px">⏳ Načítám…</div>';
}
function showMapMsg(msg){
  document.getElementById('mapImgArea').innerHTML=
    `<div style="display:flex;align-items:center;justify-content:center;height:240px;font-size:13px;color:#6b7280;padding:24px;text-align:center">${msg}</div>`;
}
function showMapPlaceholder(){
  document.getElementById('mapImgArea').innerHTML=
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:280px;color:#9ca3af;font-size:13px;gap:10px"><div style="font-size:36px">🗺️</div><div style="text-align:center">Zadejte adresu do vyhledávacího pole<br>nebo souřadnice níže</div></div>';
}
function updateMapInputs(lat,lng){
  document.getElementById('mapLatInput').value=lat.toFixed(6);
  document.getElementById('mapLngInput').value=lng.toFixed(6);
}

async function geocodeSearch(){
  const q=document.getElementById('mapSearchInput').value.trim();
  if(!q)return;
  showMapLoading();
  await geocodeAndShow(q);
}

function applyManualCoords(){
  const lat=parseFloat(document.getElementById('mapLatInput').value);
  const lng=parseFloat(document.getElementById('mapLngInput').value);
  if(isNaN(lat)||isNaN(lng)){alert('Zadejte platné souřadnice.');return;}
  if(lat<-90||lat>90||lng<-180||lng>180){alert('Souřadnice mimo rozsah (lat ±90, lng ±180).');return;}
  _mapTempCoords={lat,lng};
  showMapImage(lat,lng);
}

function saveGpsCoords(){
  // Přečti aktuální hodnoty vstupů (uživatel mohl ručně upravit)
  const latV=parseFloat((document.getElementById('mapLatInput')||{}).value);
  const lngV=parseFloat((document.getElementById('mapLngInput')||{}).value);
  if(!isNaN(latV)&&!isNaN(lngV)&&latV>=-90&&latV<=90&&lngV>=-180&&lngV<=180){
    _mapTempCoords={lat:latV,lng:lngV};
  }
  if(_mapRowIdx>=0&&_rows[_mapRowIdx]){
    snapshot();
    _rows[_mapRowIdx].lat=_mapTempCoords?_mapTempCoords.lat:null;
    _rows[_mapRowIdx].lng=_mapTempCoords?_mapTempCoords.lng:null;
    saveRows();render();
  }
  closeMapPopup();
}

function closeMapPopup(){
  document.getElementById('mapOverlay').classList.remove('open');
  document.getElementById('mapImgArea').innerHTML='';
  _mapRowIdx=-1;_mapTempCoords=null;
}

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

// ── Operátor read-only ──
async function checkOperatorRole() {
  try {
    const me = await fetch('/api/me').then(r=>r.json());
    const role = me.role;
    _role = role;
    // Zobraz username + avatar (a případně firmu) v hlavičce vpravo
    const hu = document.getElementById('hdrUser');
    if (hu && me.username) hu.textContent = me.username;
    const ha = document.getElementById('hdrAvatar');
    if (ha && me.username) ha.textContent = me.username.trim().charAt(0).toUpperCase();
    if (me.firma) {
      const badge = document.getElementById('hdrFirma');
      if (badge) { badge.textContent = me.firma; badge.style.display = ''; }
    }
    // Navigace
    buildNav(role, 'weekly');
    const el = document.getElementById('footerUser');
    if (el && me.username) el.textContent = me.username;
    if (role === 'operator') {
      // Skrýt pouze editační tlačítka (Přidat, Označit, Smazat, ▲/▼, Zpět) - NE panely
      document.querySelectorAll('.controls .btn.green, .controls .btn.red, .controls .move-btn').forEach(b => {
        b.style.display = 'none';
      });
      document.getElementById('selModeBtn').style.display = 'none';
      document.querySelectorAll('.controls .btn.gray').forEach(b => {
        if (b.textContent.trim() === 'Zpět') b.style.display = 'none';
      });
      // Operátor nemá Export dat (harmonogram)
      const exportBtn = document.getElementById('exportWeeksBtn');
      if (exportBtn) exportBtn.style.display = 'none';
      document.body.classList.add('read-only-mode');
    }
  } catch(e) {}
}

// ── CSP: event delegation pro dynamicky generované řádky tabulky ──
// Scoped na #tbody přes data-act (oddělené od OA, která řeší objednávkové řádky
// přes document-level delegaci na [data-oa-action]).
function wireTableDelegation(){
  const tb=document.getElementById('tbody');
  if(!tb)return;
  tb.addEventListener('change',function(e){
    const el=e.target.closest('[data-act]');
    if(!el||!tb.contains(el))return;
    const i=parseInt(el.getAttribute('data-i'),10);
    const act=el.getAttribute('data-act');
    if(act==='mix')updateMixSelect(i,el.getAttribute('data-key'),el.value);
    else if(act==='cell')updateCell(i,el.getAttribute('data-key'),el.value);
    else if(act==='day')updateCell(i,el.getAttribute('data-key'),el.value,false,true);
    else if(act==='check')updateCheck(i,el.checked);
  });
  tb.addEventListener('click',function(e){
    const el=e.target.closest('[data-act="gps"]');
    if(!el||!tb.contains(el))return;
    openMapPopup(parseInt(el.getAttribute('data-i'),10),e);
  });
  tb.addEventListener('focusin',function(e){
    const el=e.target.closest('[data-act="day"]');
    if(!el||!tb.contains(el))return;
    // původní onfocus: zobraz "surovou" hodnotu bez oddělovačů tisíců
    el.value=String(n(el.value.replace(/ /g,''))||el.value);
  });
}

// ── CSP: statické inline on* atributy → addEventListener ──
function wireStaticHandlers(){
  const bind=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,fn);};
  // weekbar
  bind('exportWeeksBtn','click',exportWeeks);
  bind('prevWeekBtn','click',()=>shiftWeek(-1));
  bind('currentWeekBtn','click',currentWeek);
  bind('nextWeekBtn','click',()=>shiftWeek(1));
  bind('calToggleBtn','click',toggleMiniCal);
  bind('miniCalPrevBtn','click',()=>shiftMiniCal(-1));
  bind('miniCalNextBtn','click',()=>shiftMiniCal(1));
  // controls
  bind('plantRate','change',function(){setPlantRate(this.value);render();});
  bind('materialsPanelBtn','click',()=>togglePanel('materialsPanel'));
  bind('mixesPanelBtn','click',()=>togglePanel('mixesPanel'));
  bind('addRowBtn','click',addRow);
  bind('selModeBtn','click',toggleSelMode);
  bind('moveUpBtn','click',moveCheckedUp);
  bind('moveDownBtn','click',moveCheckedDown);
  bind('deleteRowsBtn','click',deleteCheckedRows);
  bind('undoBtn','click',undoLast);
  // mapa / GPS overlay
  bind('mapCloseHdrBtn','click',closeMapPopup);
  bind('mapSearchInput','keydown',function(e){if(e.key==='Enter')geocodeSearch();});
  bind('mapSearchBtn','click',geocodeSearch);
  bind('mapApplyBtn','click',applyManualCoords);
  bind('mapCancelBtn','click',closeMapPopup);
  bind('mapSaveBtn','click',saveGpsCoords);
  // logout (footer)
  bind('logoutBtn','click',doLogout);
}

// ── INIT ──
async function init(){
  // Načti Mapy.cz API klíč
  try{const cfg=await fetch('/api/config').then(r=>r.json());if(cfg&&cfg.mapyCzKey)_mapyCzKey=cfg.mapyCzKey;}catch(ex){}
  // Načti nastavení
  const s=await fetch('/api/settings').then(r=>r.json()).catch(()=>({}));
  if(s&&Object.keys(s).length)_settings=s;
  const _ordersEnabled=_settings.orders_enabled!=='false'; // výchozí true
  document.getElementById('plantRate').value=_settings.hmg_plant_rate||'150';
  // Načti směsi
  const mixes=await fetch('/api/inputs').then(r=>r.json()).catch(()=>null);
  if(mixes)_mixes=mixes;
  // Načti firmy
  const companies=await fetch('/api/companies').then(r=>r.json()).catch(()=>null);
  if(companies)_companies=companies;
  // Načti týden
  await loadWeek(_weekStart);
  // Zjisti roli (před renderem, aby order řádky věděly zda admin)
  if(!IS_MOBILE) await checkOperatorRole();
  else await loadMobileUser();
  if(IS_MOBILE) renderMobile(); else render();
  // Objednávky — jen admin, desktop, jen když je systém zapnut
  if(!IS_MOBILE && _role==='admin' && typeof OA!=='undefined' && _ordersEnabled){
    OA.initBanner(document.querySelector('.actions'), true);
    await OA.loadPendingGroups();
    OA.updateBanner(OA.getPendingGroups().length);
    OA.setOnAfterAction(async(fullReload)=>{
      if(fullReload)await loadWeek(_weekStart);
      render();
    });
    OA.setNavigateToDate(async(datum)=>{
      // Najdi pondělí týdne obsahujícího datum
      const d=new Date(datum+'T00:00:00');
      const day=d.getDay()||7;
      d.setDate(d.getDate()-day+1);
      const targetWeek=localIso(d);
      if(targetWeek!==_weekStart){
        await flushPendingSave();        // doulož rozpracovaný týden, než přepneme
        _weekStart=targetWeek;
        await loadWeek(_weekStart);
        await OA.loadPendingGroups();
        render();
      }
    });
    render(); // překresli s order řádky
    setInterval(async()=>{await OA.refreshBanner();render();},60000);
  }
}
// CSP: nejdřív navázat statické handlery + delegaci, pak spustit init()
wireStaticHandlers();
wireTableDelegation();
init();
// Desktop: hmg_share přesměruj na měsíční přehled. Na mobilu hmg_share zůstává na týdenním pohledu.
fetch('/api/me').then(r=>r.json()).then(d=>{if(!IS_MOBILE && d.role==='hmg_share')window.location.replace('/month');}).catch(()=>{});
async function doLogout(){await fetch('/api/logout',{method:'POST'}).catch(()=>{});window.location.href='/login';}

// ── Footer verze (přesunuto z 2. inline <script> bloku na konci body) ──
fetch('/api/version').then(r=>r.json()).then(function(d){var v=document.getElementById('footerVersion');if(v&&d.version)v.textContent='TAXIS v'+d.version+' · 2026';}).catch(function(){});
