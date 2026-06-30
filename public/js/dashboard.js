// dashboard.js — JS pro dashboard.html (P2 #5: přesun z inline <script>).
// Pořadí kódu zachováno. Inline on* atributy z HTML → addEventListener (sekce DOLE).
// .onclick=/addEventListener uvnitř JS (menu .dash-menu-item) NEJSOU inline atributy → CSP-safe, beze změny.

'use strict';

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

// ── Helpers ──
function fmtDate(isoDate) {
  if (!isoDate) return '–';
  const d = new Date(isoDate + (isoDate.length === 10 ? 'T00:00:00Z' : ''));
  return d.toLocaleDateString('cs-CZ', { timeZone:'UTC', day:'2-digit', month:'2-digit', year:'numeric' });
}
// České zkratky názvů dnů. JS getUTCDay(): 0=ne, 1=po, ..., 6=so.
function weekdayShortCs(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate + (isoDate.length === 10 ? 'T00:00:00Z' : ''));
  return ['ne','po','út','st','čt','pá','so'][d.getUTCDay()] || '';
}
function fmtDateTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleString('cs-CZ', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function badgeHtml(status) {
  const labels = {
    pending:      '⏳ Čeká',
    pre_approved: '👍 Předschváleno',
    pre_rejected: '👎 Předmítnuto',
    approved:     '✅ Schváleno',
    rejected:     '❌ Zamítnuto',
  };
  return `<span class="badge ${status}">${labels[status] || status}</span>`;
}
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function showError(msg) {
  const el = document.getElementById('errorBanner');
  el.textContent = '⚠ ' + msg;
  el.style.display = 'block';
}

// ── Logout ──
async function logout() {
  try { await fetch('/api/logout', { method:'POST' }); } catch(_) {}
  location.href = '/login.html';
}

// ── Sestavení seskupeného pohledu „Potvrzené stavby" ──
// Vstup: pole dodávek { datum, lokalita, smes, itt, ceta/firma, tuny }.
// Výstup: HTML — karty stavby (lokalita), uvnitř dny, uvnitř dodávky.
// Jeden průchod listem; pak O(S log S) řazení staveb (S = počet staveb).
function buildConfirmedView(list, isAdmin) {
  const byL = new Map();  // lokalita -> { firma, total, days: Map<datum, {sum, items[]}> }
  for (const o of list) {
    const lok  = o.lokalita || '–';
    const tuny = Number(o.tuny) || 0;
    let node = byL.get(lok);
    if (!node) { node = { firma: o.firma || o.ceta || '', total: 0, days: new Map() }; byL.set(lok, node); }
    node.total += tuny;
    let day = node.days.get(o.datum);
    if (!day) { day = { sum: 0, items: [] }; node.days.set(o.datum, day); }
    day.sum += tuny;
    day.items.push({ smes: o.smes, itt: o.itt, tuny });
  }

  // Seřaď stavby podle nejmenšího data (chronologicky), dny v rámci stavby vzestupně
  const arr = [];
  for (const [lok, node] of byL) {
    const dayKeys = Array.from(node.days.keys()).sort();   // ISO 'YYYY-MM-DD' lex == chrono
    arr.push({ lok, firma: node.firma, total: node.total, dayKeys, days: node.days, first: dayKeys[0] || '' });
  }
  arr.sort((a, b) => a.first.localeCompare(b.first));

  return arr.map(s => {
    const daysHtml = s.dayKeys.map(d => {
      const day = s.days.get(d);
      const items = day.items.map(dv =>
        `<div class="delivery-row">
           <span class="dv-smes">${esc(dv.smes || '–')}</span>
           <span class="dv-itt">${esc(dv.itt || '')}</span>
           <span class="dv-tuny">${dv.tuny} t</span>
         </div>`
      ).join('');
      return `<div class="day-block">
        <div class="day-head">
          <span class="day-date">${weekdayShortCs(d)} ${fmtDate(d)}</span>
          <span class="day-sum">${day.sum} t</span>
        </div>
        ${items}
      </div>`;
    }).join('');

    return `<div class="stavba-card">
      <div class="stavba-head">
        <div>
          <div class="stavba-name">${esc(s.lok)}</div>
          ${isAdmin && s.firma ? `<div class="stavba-sub">${esc(s.firma)}</div>` : ''}
        </div>
        <div class="stavba-total">Celkem ${s.total} t</div>
      </div>
      <div class="stavba-body">${daysHtml}</div>
    </div>`;
  }).join('');
}

// ── Sestavení záložky „Rozdělení dle směsí" ──
// Vstup: stejné pole dodávek jako buildConfirmedView.
// Výstup: HTML — karty stavby (lokalita), uvnitř ŘÁDKY SMĚSÍ s celkovou tonáží
// (suma přes všechny dny). ITT u směsi se zobrazí jen pokud je v rámci stavby+směsi
// jednotné (množina ITT velikosti 1). Jeden průchod listem.
function buildConfirmedBySmes(list, isAdmin) {
  // lokalita -> { firma, total, first (nejmenší datum pro řazení), smes: Map<smes, {tuny, itts:Set}> }
  const byL = new Map();
  for (const o of list) {
    const lok  = o.lokalita || '–';
    const tuny = Number(o.tuny) || 0;
    let node = byL.get(lok);
    if (!node) { node = { firma: o.firma || o.ceta || '', total: 0, first: '9999-99-99', smesMap: new Map() }; byL.set(lok, node); }
    node.total += tuny;
    if (o.datum && o.datum < node.first) node.first = o.datum;

    const sm = o.smes || '–';
    let sn = node.smesMap.get(sm);
    if (!sn) { sn = { tuny: 0, itts: new Set() }; node.smesMap.set(sm, sn); }
    sn.tuny += tuny;
    if (o.itt) sn.itts.add(o.itt);
  }

  // Řazení staveb dle nejmenšího data (stejně jako buildConfirmedView)
  const arr = Array.from(byL.entries()).map(([lok, n]) => ({ lok, ...n }));
  arr.sort((a, b) => a.first.localeCompare(b.first));

  return arr.map(s => {
    // Směsi v rámci stavby seřaď dle tonáže sestupně (nejvíc nahoru)
    const smesArr = Array.from(s.smesMap.entries()).sort((a, b) => b[1].tuny - a[1].tuny);
    const rows = smesArr.map(([sm, sn]) => {
      const itt = sn.itts.size === 1 ? Array.from(sn.itts)[0] : '';
      return `<div class="delivery-row">
        <span class="dv-smes">${esc(sm)}</span>
        <span class="dv-itt">${esc(itt)}</span>
        <span class="dv-tuny">${sn.tuny} t</span>
      </div>`;
    }).join('');

    return `<div class="stavba-card">
      <div class="stavba-head">
        <div>
          <div class="stavba-name">${esc(s.lok)}</div>
          ${isAdmin && s.firma ? `<div class="stavba-sub">${esc(s.firma)}</div>` : ''}
        </div>
        <div class="stavba-total">Celkem ${s.total} t</div>
      </div>
      <div class="stavba-body" style="padding:10px 18px 12px">${rows}</div>
    </div>`;
  }).join('');
}

// ── Přepínání záložek (čistě klient) ──
function switchTab(tabId) {
  document.querySelectorAll('.dash-menu-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.dash-content > .dash-tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tabId));
}
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.dash-menu-item').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
});

// ── Helper: obsah buňky Objednávka ──
// Pokud komentar není prázdný → zobraz komentar.
// Pokud komentar je prázdný/null → zobraz "chybí objednávka" červeně.
// Platí pro všechny řádky bez ohledu na status.
function objednavkaTd(o, maxWidth) {
  const mw = maxWidth || '200px';
  const style = `max-width:${mw};overflow:hidden;text-overflow:ellipsis`;
  if (o.komentar) {
    return `<td style="${style}">${esc(o.komentar)}</td>`;
  }
  return `<td style="${style};color:#991b1b">chybí objednávka</td>`;
}

// ── Admin řádek (sekce 2, 3, 4 — stejná struktura) ──
// ── Hlavní funkce: načti a vykresli ──
async function loadDashboard() {
  const loader  = document.getElementById('loader');
  const content = document.getElementById('mainContent');

  try {
    // /api/me — pro username v hlavičce (existující endpoint, stejný zdroj jako jiné stránky)
    // /api/dashboard — data pro karty + záložky
    const [meRes, res] = await Promise.all([
      fetch('/api/me').catch(() => null),
      fetch('/api/dashboard'),
    ]);
    if (res.status === 401) { location.href = '/login.html'; return; }
    if (!res.ok) { showError('Chyba serveru (' + res.status + ')'); loader.style.display='none'; content.style.display='block'; return; }
    const data = await res.json();
    const me   = (meRes && meRes.ok) ? await meRes.json() : {};

    const isAdmin = data.role === 'admin';
    const pageLabel  = isAdmin ? 'Dashboard' : 'Seznam staveb';
    const username   = me.username || '';

    // Název stránky — title tag i hlavička (+ uživatel za | jako na jiných stránkách)
    document.title = 'HARMONOGRAM VÝROBY – ' + pageLabel;
    document.getElementById('userInfo').textContent = username;
    const _ha = document.getElementById('hdrAvatar');
    if (_ha && username) _ha.textContent = username.trim().charAt(0).toUpperCase();
    if (me.firma) { const _fb = document.getElementById('hdrFirma'); if (_fb) { _fb.textContent = me.firma; _fb.style.display = ''; } }

    // ── Navigace v topbaru ──
    buildNav(isAdmin ? 'admin' : 'hmg_share', 'dashboard');

    // Záložka „Odebrané stavby" — pro hmg_share viditelná jen když je přepínač zapnut.
    // Admin a operátor mají přístup vždy (nezávisle na přepínači).
    const odebraneBtn = document.querySelector('.dash-menu-item[data-tab="odebrane"]');
    if (odebraneBtn && data.role === 'hmg_share' && !data.vazenky_share_enabled) {
      odebraneBtn.style.display = 'none';
    }

    // Souhrn vpravo v nadpisu sekce (na OBOU záložkách — plněno přes třídy)
    const confirmedList = data.confirmed_list || [];
    const uniqStaveb    = new Set(confirmedList.map(o => o.lokalita || '–')).size;
    const tonsFormatted = (data.confirmed_tons ?? 0).toLocaleString('cs-CZ') + ' t';
    document.querySelectorAll('.js-card-count').forEach(el => el.textContent = uniqStaveb);
    document.querySelectorAll('.js-card-tons').forEach(el => el.textContent = tonsFormatted);

    // CTA bar „+ Nová objednávka" — skryj když je objednávkový systém vypnut
    // CTA „Nová objednávka" skryj při globálním vypnutí NEBO když hmg_share nemá per-user povolení.
    if (!data.orders_enabled || (data.role === 'hmg_share' && !data.orders_allowed)) {
      document.getElementById('ctaBar').style.display = 'none';
    }

    // ── Záložka 1: Požadované stavby (po stavbách → dnech → dodávkách) ──
    const confirmedBadge = document.getElementById('confirmedBadge');
    const confirmedEmpty = document.getElementById('confirmedEmpty');
    const confirmedCards = document.getElementById('confirmedCards');

    confirmedBadge.textContent = uniqStaveb;

    if (confirmedList.length > 0) {
      confirmedCards.innerHTML = buildConfirmedView(confirmedList, isAdmin);
      confirmedEmpty.style.display = 'none';
      confirmedCards.style.display = 'flex';
    }

    // ── Záložka 2: Rozdělení dle směsí (po stavbách → směsích) ──
    const bySmesBadge = document.getElementById('bySmesBadge');
    const bySmesEmpty = document.getElementById('bySmesEmpty');
    const bySmesCards = document.getElementById('bySmesCards');

    bySmesBadge.textContent = uniqStaveb;

    if (confirmedList.length > 0) {
      bySmesCards.innerHTML = buildConfirmedBySmes(confirmedList, isAdmin);
      bySmesEmpty.style.display = 'none';
      bySmesCards.style.display = 'flex';
    }

    // Zobraz obsah
    loader.style.display  = 'none';
    content.style.display = 'block';

  } catch (err) {
    console.error('loadDashboard error:', err);
    showError('Nepodařilo se načíst data. Zkontrolujte připojení a obnovte stránku.');
    loader.style.display  = 'none';
    content.style.display = 'block';
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Záložka „Odebrané stavby" — vážní data
// ──────────────────────────────────────────────────────────────────────────
let _vzIsAdmin = false;

function buildVzHeader(isAdmin) {
  const thead = document.getElementById('vzThead');
  const cols = isAdmin
    ? ['Firma','Stavba','Datum','Čas','Směs','ITT','Tuny','SPZ','Jméno řidiče']
    : ['Stavba','Datum','Čas','Směs','ITT','Tuny','SPZ','Jméno řidiče'];
  thead.innerHTML = cols.map(c => `<th>${c}</th>`).join('');
}

function fmtDateCs(iso) {
  if (!iso) return '–';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
  return d.toLocaleDateString('cs-CZ', { timeZone:'UTC', day:'2-digit', month:'2-digit', year:'numeric' });
}
function fmtCasShort(s) {
  if (!s) return '–';
  const m = String(s).match(/^(\d{1,2}:\d{2})/);
  return m ? m[1] : String(s);
}

async function loadVazenky() {
  const stavba = document.getElementById('vzStavba').value;
  const od     = document.getElementById('vzOd').value;
  const doD    = document.getElementById('vzDo').value;
  const firma  = document.getElementById('vzFirma').value;   // pouze admin to vidí
  const params = new URLSearchParams();
  if (stavba) params.set('stavba', stavba);
  if (od)     params.set('od', od);
  if (doD)    params.set('do', doD);
  if (firma)  params.set('firma', firma);
  try {
    const r = await fetch('/api/vazenky?' + params.toString());
    if (!r.ok) { console.error('Vazenky load failed', r.status); return; }
    const data = await r.json();

    _vzIsAdmin = data.role === 'admin';
    buildVzHeader(_vzIsAdmin);

    // Viditelnost selectu Firma + jeho naplnění (jen admin)
    const firmaWrap = document.getElementById('vzFirmaWrap');
    firmaWrap.style.display = _vzIsAdmin ? '' : 'none';
    if (_vzIsAdmin) {
      const selF = document.getElementById('vzFirma');
      if (selF.options.length <= 1 || !firma) {
        const current = selF.value;
        selF.innerHTML = '<option value="">— všechny firmy —</option>' +
          (data.firmy || []).map(f => `<option value="${esc(f)}"${f===current?' selected':''}>${esc(f)}</option>`).join('');
      }
    }

    // Naplň <select> stavby (jen pokud je prázdný nebo se filtr zmenšil)
    const sel = document.getElementById('vzStavba');
    if (sel.options.length <= 1 || !stavba) {
      const current = sel.value;
      sel.innerHTML = '<option value="">— všechny —</option>' +
        (data.stavby || []).map(s => `<option value="${esc(s)}"${s===current?' selected':''}>${esc(s)}</option>`).join('');
    }

    // Souhrn vpravo v nadpisu
    document.getElementById('vzCount').textContent = data.rows.length;
    document.getElementById('vzTotal').textContent = (data.total_tuny ?? 0).toLocaleString('cs-CZ') + ' t';

    // Tabulka
    const tbody = document.getElementById('vzBody');
    const empty = document.getElementById('vzEmpty');
    if (!data.rows.length) {
      tbody.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';
    tbody.innerHTML = data.rows.map(r => {
      // Admin: zobraz firma_display (firma_taxis → skutečný název partnera). Nenamapované
      // (bez firma_taxis) odliš třídou, ale text = reálný název partnera, ne „(nepřiřazeno)".
      const firmaCell = _vzIsAdmin
        ? `<td class="${r.firma_taxis ? '' : 'firma-unassigned'}">${esc(r.firma_display || r.firma_taxis || '(neuvedeno)')}</td>`
        : '';
      return `<tr>
        ${firmaCell}
        <td>${esc(r.stavba || '(neuvedeno)')}</td>
        <td>${fmtDateCs(r.datum)}</td>
        <td>${esc(fmtCasShort(r.cas))}</td>
        <td>${esc(r.smes)}</td>
        <td>${esc(r.itt)}</td>
        <td class="num">${Number(r.tuny).toLocaleString('cs-CZ')} t</td>
        <td>${esc(r.spz)}</td>
        <td>${esc(r.ridic)}</td>
      </tr>`;
    }).join('');
  } catch(e) { console.error('loadVazenky error:', e); }
}

function resetVazenkyFilters() {
  document.getElementById('vzStavba').value = '';
  document.getElementById('vzOd').value = '';
  document.getElementById('vzDo').value = '';
  document.getElementById('vzFirma').value = '';   // klient ho stejně nevidí
  loadVazenky();
}

// Export „Potvrzené stavby" — stáhne .xlsx z /api/dashboard/export.
// Scope (admin vs klient) řeší výhradně server.
function exportConfirmed() {
  const a = document.createElement('a');
  a.href = '/api/dashboard/export';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 500);
}

// Export do .xlsx — odešle aktuální filtry na endpoint a stáhne soubor.
// Scope (admin vs hmg_share) řeší výhradně server.
function exportVazenky() {
  const stavba = document.getElementById('vzStavba').value;
  const od     = document.getElementById('vzOd').value;
  const doD    = document.getElementById('vzDo').value;
  const firma  = document.getElementById('vzFirma').value;   // admin-only; server ho pro ne-adminy ignoruje
  const params = new URLSearchParams();
  if (stavba) params.set('stavba', stavba);
  if (od)     params.set('od', od);
  if (doD)    params.set('do', doD);
  if (firma)  params.set('firma', firma);
  // Necitlivý název → datum vygenerování
  const url = '/api/vazenky/export' + (params.toString() ? '?' + params.toString() : '');
  // Prosté navigování přes <a download> spustí stažení (browser respektuje Content-Disposition)
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 500);
}

// Hook: spuštění při přepnutí na záložku „odebrane"
const _origSwitchTab = switchTab;
switchTab = function(tabId) {
  _origSwitchTab(tabId);
  if (tabId === 'odebrane') {
    // Lazy-load při prvním přepnutí
    if (!document.getElementById('vzBody').innerHTML && !document.getElementById('vzEmpty').style.display) {
      loadVazenky();
    }
  }
};

// ── Verze v patičce ──
fetch('/api/version').then(r=>r.json()).then(function(d){var v=document.getElementById('footerVersion');if(v&&d.version)v.textContent='TAXIS v'+d.version+' · 2026';}).catch(function(){});

// ── Start ──
loadDashboard();

// ─────────────────────────────────────────────────────────────────────────────
// NAPOJENÍ INLINE on* ATRIBUTŮ → addEventListener (P2 #5). Soubor je na konci body,
// všechny prvky existují. Funkce/chování beze změny.
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('exportConfirmedBtn').addEventListener('click', exportConfirmed);
document.getElementById('vzFilterBtn').addEventListener('click', loadVazenky);
document.getElementById('vzResetBtn').addEventListener('click', resetVazenkyFilters);
document.getElementById('vzExportBtn').addEventListener('click', exportVazenky);
const _btnNew = document.getElementById('btnNewRequest');
if (_btnNew) {
  _btnNew.addEventListener('mouseover', () => { _btnNew.style.filter = 'brightness(1.1)'; });
  _btnNew.addEventListener('mouseout',  () => { _btnNew.style.filter = ''; });
}
const _logoutBtn = document.getElementById('logoutBtn');
if (_logoutBtn) {
  _logoutBtn.addEventListener('click', logout);
  _logoutBtn.addEventListener('mouseenter', () => { _logoutBtn.style.background = '#fff1f2'; });
  _logoutBtn.addEventListener('mouseleave', () => { _logoutBtn.style.background = 'transparent'; });
}
