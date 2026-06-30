// month.js — JS pro month.html (P2 #5: přesun z inline <script>). VEŘEJNÝ/SDÍLENÝ pohled
// (/share, hmg_share) — funkce/větvení dle session/tokenu beze změny. on* → addEventListener
// (statické) a selektor v updateNavButtons přepnut z [onclick*=…] na #prevMonthBtn. Napojení DOLE.
// order-approval.js (externí, OA.*) se řeší samostatně.

const FIRMA_ORDER = {'Colas':0,'Firesta':1,'Mi Roads':2};
let _entries = {};
let _companies = [{name:'Colas',color:'#fef08a',text:'#713f12'},{name:'Firesta',color:'#bbf7d0',text:'#14532d'},{name:'Mi Roads',color:'#fecdd3',text:'#9f1239'}];
let _maxDaily = 1000;
let _minDaily = 0;
let _weekStarts = []; // seřazené pondělky pro určení hranic týdnů
let _isAdmin = false;
let _ordersEnabled = true; // přepínač objednávkového systému (načteno ze settings)
let _monthOrderDaySums = {}; // keyed by iso date – přidané tuny z pending objednávek

function n(v){const x=parseInt(String(v||'').replace(/\D+/g,''),10);return isNaN(x)?0:x}
function cc(name){return _companies.find(x=>x.name===name)||{color:'',text:'#111'}}
function defaultMonth(){const d=new Date();return d.toISOString().slice(0,7)}
function monthName(m){return['LEDEN','ÚNOR','BŘEZEN','DUBEN','KVĚTEN','ČERVEN','ČERVENEC','SRPEN','ZÁŘÍ','ŘÍJEN','LISTOPAD','PROSINEC'][m]}
function iso(y,m,d){return y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0')}
function esc(v){return String(v||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function easterSunday(y){const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1;return new Date(y,mo-1,da)}
function addDays(dt,days){const d=new Date(dt);d.setDate(d.getDate()+days);return d}
function isHoliday(id){
  const[y,m,d]=id.split('-').map(Number);
  const fixed=['01-01','05-01','05-08','07-05','07-06','09-28','10-28','11-17','12-24','12-25','12-26'];
  if(fixed.includes(String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0')))return true;
  const e=easterSunday(y);
  return id===addDays(e,-2).toISOString().slice(0,10)||id===addDays(e,1).toISOString().slice(0,10);
}
function dayClass(id){
  if(isHoliday(id))return 'day-h';
  const dow=new Date(id).getDay();
  return(dow===0||dow===6)?'day-w':'day-b';
}
function daySum(id){return(_entries[id]||[]).reduce((s,e)=>s+n(e.tuny),0)}

// Vrátí pondělí pro daný datum
function mondayOf(id){
  const d=new Date(id);
  const dow=d.getDay();
  const diff=(dow===0?-6:1-dow);
  d.setDate(d.getDate()+diff);
  return d.toISOString().slice(0,10);
}

function rowsForMonth(y,m){
  // Seskupit záznamy po týdnech, uvnitř každého týdne řadit Colas→Firesta→Mi Roads
  const weekMap={};
  Object.keys(_entries).sort().forEach(id=>{
    const dt=new Date(id);
    if(dt.getFullYear()===y&&dt.getMonth()===m){
      (_entries[id]||[]).forEach(e=>{
        if(!(e.smes||'').trim()||!(e.itt||'').trim()||!(e.ceta||'').trim())return;
        const ws=mondayOf(id);
        if(!weekMap[ws])weekMap[ws]={};
        const key=[e.lokalita||'',e.objednavka||'',e.smes||'',e.itt||'',e.ceta||''].join('|');
        if(!weekMap[ws][key])weekMap[ws][key]={lokalita:e.lokalita||'',objednavka:e.objednavka||'',smes:e.smes||'',itt:e.itt||'',ceta:e.ceta||'',weekStart:ws,days:{}};
        const d=dt.getDate();
        weekMap[ws][key].days[d]=(weekMap[ws][key].days[d]||0)+n(e.tuny);
      });
    }
  });
  // Seřadit týdny a uvnitř každého firmy
  const result=[];
  Object.keys(weekMap).sort().forEach(ws=>{
    const rows=Object.values(weekMap[ws]);
    rows.sort((a,b)=>{
      const oa=FIRMA_ORDER[a.ceta]!==undefined?FIRMA_ORDER[a.ceta]:99;
      const ob=FIRMA_ORDER[b.ceta]!==undefined?FIRMA_ORDER[b.ceta]:99;
      if(oa!==ob)return oa-ob;
      return(a.lokalita||'').localeCompare(b.lokalita||'','cs');
    });
    rows.forEach((r,i)=>{r._firstInWeek=(i===0);});
    result.push(...rows);
  });
  return result;
}

function buildMonthOrderRowsHtml(y,m,days){
  _monthOrderDaySums={};
  if(!_isAdmin||typeof OA==='undefined'||_ordersEnabled===false)return '';
  const visibleDays=Array.from({length:days},(_,i)=>i+1);
  const monthStart=iso(y,m,1),monthEnd=iso(y,m,days);
  let html='';
  for(const g of OA.getPendingGroups()){
    const monthRows=(g.rows||[]).filter(r=>{const d=String(r.datum).slice(0,10);return d>=monthStart&&d<=monthEnd;});
    if(!monthRows.length)continue;
    const byMix={};
    monthRows.forEach(r=>{
      const key=(r.smes||'')+'|'+(r.itt||'');
      if(!byMix[key])byMix[key]={smes:r.smes||'',itt:r.itt||'',daysMap:{},statusMap:{}};
      const dayNum=parseInt(String(r.datum).slice(8,10));
      byMix[key].daysMap[dayNum]=(byMix[key].daysMap[dayNum]||0)+(parseInt(r.tuny)||0);
      const ord=['pre_rejected','pre_approved','pending'];
      const cur=byMix[key].statusMap[dayNum];
      if(!cur||ord.indexOf(r.status)>ord.indexOf(cur))byMix[key].statusMap[dayNum]=r.status;
    });
    for(const[mixKey,mx]of Object.entries(byMix)){
      Object.entries(mx.daysMap).forEach(([dayNum,tuny])=>{
        const id=iso(y,m,parseInt(dayNum));
        _monthOrderDaySums[id]=(_monthOrderDaySums[id]||0)+tuny;
      });
      html+=OA.buildMonthOrderRow(g,mx.smes,mx.itt,mx.daysMap,mx.statusMap,visibleDays,y,m);
    }
  }
  return html;
}

function render(){
  const val=monthPick.value||defaultMonth();
  localStorage.setItem('hmg_month_selected',val);
  const[yy,mm]=val.split('-');const y=parseInt(yy),m=parseInt(mm)-1;
  const _mc=document.getElementById('monthContext');if(_mc)_mc.textContent=monthName(m)+' '+y;
  const days=new Date(y,m+1,0).getDate();
  const rows=rowsForMonth(y,m);

  // Hlavička - datumy
  const dayIds=[];
  for(let d=1;d<=days;d++)dayIds.push(iso(y,m,d));
  // Objednávky – aktualizuje _monthOrderDaySums
  const orderHtml=buildMonthOrderRowsHtml(y,m,days);

  // Celkový součet tun za měsíc (včetně pending objednávek)
  const _monthSum=dayIds.reduce((s,id)=>s+daySum(id)+(_monthOrderDaySums[id]||0),0);
  const totalEl=document.getElementById('monthTotal');
  if(totalEl)totalEl.textContent='Celkem: '+_monthSum.toLocaleString('cs-CZ')+' t';

  let h='<table id="monthTable"><thead>';
  // Řádek součtů
  h+='<tr class="sticky-head"><th class="left-head col-lok"></th><th class="left-head col-obj"></th><th class="left-head col-smes"></th><th class="left-head col-itt"></th><th class="left-head col-ceta">Součet t/den:</th>';
  for(let d=1;d<=days;d++){
    const id=iso(y,m,d);
    const ds=daySum(id)+(_monthOrderDaySums[id]||0);
    const overMax=ds>_maxDaily;
    const underMin=ds>0&&_minDaily>0&&ds<_minDaily;
    const dc=dayClass(id);
    const hideDay=_isViewer&&id<todayStr;
    let style=overMax?'background:#fee2e2;color:#991b1b;font-weight:800'
      :underMin?'background:#fef9c3;color:#92400e;font-weight:800'
      :dc==='day-h'?'background:#dff5e6;color:#15803d;font-weight:800'
      :dc==='day-w'?'background:#e2e2e2;color:#374151;font-weight:800'
      :'background:#cfe0fa;color:#1e3a8a;font-weight:800';
    if(hideDay)style+=';display:none';
    h+='<th class="day" style="'+style+'">'+(hideDay?'':ds)+'</th>';
  }
  h+='</tr>';
  // Řádek datumů
  h+='<tr class="sticky-head-2"><th class="col-lok">lokalita</th><th class="col-obj">objednávka</th><th class="col-smes">Směs a průkazná zk. typu</th><th class="col-itt">ITT</th><th class="col-ceta">četa</th>';
  const todayStr=new Date().toISOString().slice(0,10);
  for(let d=1;d<=days;d++){
    const id=iso(y,m,d);
    const dc=dayClass(id);
    const hideCol=_isViewer&&id<todayStr;
    h+='<th class="day '+dc+'" style="font-size:11px'+(hideCol?';display:none':'')+'">'+(hideCol?'':d+'.'+(m+1)+'.')+'</th>';
  }
  h+='</tr></thead><tbody>';

  if(!rows.length){
    for(let i=0;i<20;i++){
      h+='<tr><td></td><td></td><td></td><td></td><td></td>';
      for(let d=1;d<=days;d++){const id=iso(y,m,d);const hideD=_isViewer&&id<todayStr;h+='<td class="'+dayClass(id)+'" style="'+(hideD?'display:none':'')+'">'+'</td>';}
      h+='</tr>';
    }
  } else {
    rows.forEach(r=>{
      const firma=cc(r.ceta);
      const bg=firma.color?'background:'+firma.color+';color:#111;':'';
      const sepClass=r._firstInWeek?'week-sep':'';
      h+='<tr class="'+sepClass+'"><td style="text-align:left;padding-left:8px;'+bg+'">'+esc(r.lokalita)+'</td>';
      h+='<td style="'+((!r.objednavka)?'background:#fff;border:1px solid #374151;':bg)+'">'+esc(r.objednavka)+'</td>';
      h+='<td style="text-align:center;'+bg+'">'+esc(r.smes)+'</td>';
      h+='<td style="font-size:11px;'+bg+'">'+esc(r.itt)+'</td><td style="'+bg+'font-weight:500">'+esc(r.ceta)+'</td>';
      for(let d=1;d<=days;d++){
        const id=iso(y,m,d);
        const dc=dayClass(id);
        h+='<td class="'+dc+'">'+(r.days[d]||'')+'</td>';
      }
      h+='</tr>';
    });
  }
  h+=orderHtml;
  h+='</tbody></table>';
  tableWrap.innerHTML=h;
}

function shiftMonth(delta){const val=monthPick.value||defaultMonth();const[y,m]=val.split('-').map(Number);let ny=y,nm=m-1+delta;if(nm>11){nm=0;ny++;}if(nm<0){nm=11;ny--;}const newVal=ny+'-'+String(nm+1).padStart(2,'0');if(_isViewer&&newVal<_minMonth)return;monthPick.value=newVal;render();updateNavButtons();}
function thisMonth(){monthPick.value=defaultMonth();render()}
function exportMonth(){const table=document.getElementById('monthTable');if(!table)return;const html='<html><head><meta charset="UTF-8"><style>table{border-collapse:collapse;font-family:Arial;font-size:10pt}th,td{border:1px solid #222;padding:4px;text-align:center}.day-b{background:#ddebf7}.day-w{background:#d1d5db}.day-h{background:#86efac}.missing-order{background:#fff;border:1px solid #374151}</style></head><body>'+table.outerHTML+'</body></html>';const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+html],{type:'application/vnd.ms-excel;charset=utf-8'}));a.download='mesicni_harmonogram.xls';document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500)}


// ── Viewer omezení ──
let _isViewer = false;
let _minMonth = ''; // viewer nemůže jít před tento měsíc

async function checkViewerRole() {
  try {
    const me = await fetch('/api/me').then(r=>r.json());
    _isViewer = (me.role === 'hmg_share');
    _isAdmin  = (me.role === 'admin');
    const hu = document.getElementById('hdrUser');
    if (hu && me.username) hu.textContent = me.username;
    const ha = document.getElementById('hdrAvatar');
    if (ha && me.username) ha.textContent = me.username.trim().charAt(0).toUpperCase();
    if (me.firma) { const fb = document.getElementById('hdrFirma'); if (fb) { fb.textContent = me.firma; fb.style.display = ''; } }
    if (_isViewer) {
      // Nastavit minimální měsíc na aktuální
      _minMonth = defaultMonth();
      // Skrýt export tlačítko
      const exportBtn = document.querySelector('.btn.green');
      if (exportBtn) exportBtn.style.display = 'none';
      // Skrýt tlačítko Týdenní kalendář
      const weekBtn = document.querySelector('.btn.week');
      if (weekBtn) weekBtn.style.display = 'none';
      // Skrýt tlačítko Předchozí pokud jsme na aktuálním měsíci
      updateNavButtons();
    }
    // Zobrazit/skrýt settings tlačítko
    const sb = document.getElementById('settingsBtn');
    if (sb && me.role === 'admin') sb.style.display = '';
    const el = document.getElementById('footerUser');
    if (el && me.username) el.textContent = me.username;
  } catch(e) {}
}

function updateNavButtons() {
  if (!_isViewer) return;
  const prevBtn = document.getElementById('prevMonthBtn');   // P2 #5: selektor přes id (dříve [onclick*=…])
  if (prevBtn) {
    const current = monthPick.value || defaultMonth();
    prevBtn.style.display = (current <= _minMonth) ? 'none' : '';
  }
}

async function init(){
  try{
    const[companies,weeks,settings]=await Promise.all([
      fetch('/api/companies').then(r=>r.json()).catch(()=>null),
      fetch('/api/weeks').then(r=>r.json()).catch(()=>[]),
      fetch('/api/settings').then(r=>r.json()).catch(()=>({}))
    ]);
    if(companies)_companies=companies;
    if(settings&&settings.hmg_max_daily){
      _maxDaily=parseInt(settings.hmg_max_daily,10);
      if(isNaN(_maxDaily)||_maxDaily<=0)_maxDaily=1000;
    }
    if(settings&&settings.hmg_min_daily){
      _minDaily=parseInt(settings.hmg_min_daily,10);
      if(isNaN(_minDaily)||_minDaily<0)_minDaily=0;
    }
    if(settings&&settings.orders_enabled!==undefined){
      _ordersEnabled=(settings.orders_enabled!=='false');
    }
    _entries={};
    (weeks||[]).forEach(w=>{
      const start=w.start;
      const rows=w.rows||[];
      for(let i=0;i<7;i++){
        const d=new Date(start);d.setDate(d.getDate()+i);
        const isoStr=d.toISOString().slice(0,10);
        _entries[isoStr]=[];
        rows.forEach(r=>{const tuny=parseInt(r['d'+i]||'0',10);if(tuny>0)_entries[isoStr].push({lokalita:r.lokalita||'',objednavka:r.objednavka||'',smes:r.smes||'',itt:r.itt||'',ceta:r.ceta||'',tuny});});
      }
    });
  }catch(e){console.error(e);}
  const savedMonth = localStorage.getItem('hmg_month_selected') || defaultMonth();
  await checkViewerRole();
  // Viewer začíná na aktuálním měsíci
  monthPick.value = _isViewer ? defaultMonth() : savedMonth;
  // Objednávky – jen admin, jen když je systém zapnut
  if(_isAdmin && typeof OA!=='undefined' && _ordersEnabled){
    OA.initBanner(document.querySelector('.actions'), true);
    await OA.loadPendingGroups();
    OA.updateBanner(OA.getPendingGroups().length);
    OA.setOnAfterAction(async(fullReload)=>{
      if(fullReload){
        const weeks=await fetch('/api/weeks').then(r=>r.json()).catch(()=>[]);
        _entries={};
        (weeks||[]).forEach(w=>{
          const start=w.start;const rows2=w.rows||[];
          for(let i=0;i<7;i++){
            const d=new Date(start);d.setDate(d.getDate()+i);
            const isoStr=d.toISOString().slice(0,10);
            _entries[isoStr]=[];
            rows2.forEach(r=>{const tuny=parseInt(r['d'+i]||'0',10);if(tuny>0)_entries[isoStr].push({lokalita:r.lokalita||'',objednavka:r.objednavka||'',smes:r.smes||'',itt:r.itt||'',ceta:r.ceta||'',tuny});});
          }
        });
      }
      render();
    });
    OA.setNavigateToDate(async(datum)=>{
      // Přepni na měsíc obsahující cílový den
      const newVal=datum.slice(0,7); // 'YYYY-MM'
      if((monthPick.value||defaultMonth())!==newVal){
        monthPick.value=newVal;
        render();
        updateNavButtons();
      }
    });
    setInterval(async()=>{await OA.refreshBanner();render();},60000);
  }
  render();
  if (_isViewer) updateNavButtons();
}
init();


async function doLogout(){
  await fetch('/api/logout',{method:'POST'}).catch(()=>{});
  window.location.href='/login';
}

fetch('/api/me').then(r=>r.json()).then(d=>{
  const el=document.getElementById('footerUser');
  if(el&&d.username)el.textContent=d.username;
  const sb=document.getElementById('settingsBtn');
  if(sb&&d.role==='admin')sb.style.display='';
}).catch(()=>{});

// ── verze v patičce ──
fetch('/api/version').then(r=>r.json()).then(function(d){var v=document.getElementById('footerVersion');if(v&&d.version)v.textContent='TAXIS v'+d.version+' · 2026';}).catch(function(){});

// ─── NAPOJENÍ on* (P2 #5). Soubor je na konci body → prvky existují. ───
const _exportBtn=document.getElementById('exportBtn'); if(_exportBtn) _exportBtn.addEventListener('click', exportMonth);
const _prevBtn=document.getElementById('prevMonthBtn'); if(_prevBtn) _prevBtn.addEventListener('click', () => shiftMonth(-1));
const _thisBtn=document.getElementById('thisMonthBtn'); if(_thisBtn) _thisBtn.addEventListener('click', thisMonth);
const _nextBtn=document.getElementById('nextMonthBtn'); if(_nextBtn) _nextBtn.addEventListener('click', () => shiftMonth(1));
const _monthPick=document.getElementById('monthPick'); if(_monthPick) _monthPick.addEventListener('change', render);
const _logoutBtn=document.getElementById('logoutBtn');
if(_logoutBtn){
  _logoutBtn.addEventListener('click', doLogout);
  _logoutBtn.addEventListener('mouseenter', () => { _logoutBtn.style.background='#fff1f2'; });
  _logoutBtn.addEventListener('mouseleave', () => { _logoutBtn.style.background='transparent'; });
}
