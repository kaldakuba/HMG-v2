// Export měsíčního harmonogramu do .xlsx (ExcelJS) — 12 listů (Leden…Prosinec) pro daný rok.
// Logika dat 1:1 jako month-view.html (buildEntries → rowsForMonth), aby export seděl s pohledem.
// Info sloupce (č./lokalita/objednávka/směs/ITT/četa) se barví výplní podle firmy (četa),
// stejnou paletou jako živá tabulka (companyColor); denní buňky se firmou nebarví.

const ExcelJS = require('exceljs');

const MONTH_NAMES = ['Leden','Únor','Březen','Duben','Květen','Červen','Červenec','Srpen','Září','Říjen','Listopad','Prosinec'];
const FIRMA_ORDER = { 'Colas': 0, 'Firesta': 1, 'Mi Roads': 2 };

// Barvy firem NAPEVNO — shodné s CSS v týdenní/měsíční tabulce na obrazovce.
// Pouze tyto firmy mají výplň; ostatní (BKOM, SÚS, …) zůstávají bílé (bez výplně).
// (Záměrně se NEČTE z číselníku companies, aby export = obrazovka.)
const FIRMA_COLORS = {
  'Colas':    '#fff2a8',
  'Firesta':  '#d9ead3',
  'Mi Roads': '#ff7f86',
};

function n(v) { const x = parseInt(String(v == null ? '' : v).replace(/\D+/g, ''), 10); return isNaN(x) ? 0 : x; }
function pad2(x) { return String(x).padStart(2, '0'); }
function isoYMD(y, m0, d) { return y + '-' + pad2(m0 + 1) + '-' + pad2(d); }
function daysInMonth(y, m0) { return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); }

// Datum jako YYYY-MM-DD posunuté o `days` (deterministicky v UTC, nezávisle na TZ serveru).
function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Pondělí (YYYY-MM-DD) týdne obsahujícího dané datum.
function mondayOfIso(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay();          // 0=Ne … 6=So
  const diff = (dow === 0 ? -6 : 1 - dow);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4,
    f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
    mth = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * mth + 114) / 31),
    da = ((h + l - 7 * mth + 114) % 31) + 1;
  return { m0: mo - 1, d: da, y };
}
// Svátek ČR pro dané datum (y, m0 0-based, d).
function isHoliday(y, m0, d) {
  const fixed = ['01-01','05-01','05-08','07-05','07-06','09-28','10-28','11-17','12-24','12-25','12-26'];
  if (fixed.includes(pad2(m0 + 1) + '-' + pad2(d))) return true;
  const e = easterSunday(y);
  const eIso = isoYMD(e.y, e.m0, e.d);
  const id = isoYMD(y, m0, d);
  return id === addDaysIso(eIso, -2) || id === addDaysIso(eIso, 1); // Velký pátek, Velikonoční pondělí
}
function isWeekend(y, m0, d) { const dow = new Date(Date.UTC(y, m0, d)).getUTCDay(); return dow === 0 || dow === 6; }

// #rrggbb → 'FFRRGGBB' (ARGB pro ExcelJS). Prázdné/neplatné → null (bez výplně).
function hexToArgb(hex) {
  if (!hex) return null;
  const m = String(hex).trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? ('FF' + m[1].toUpperCase()) : null;
}

// week_data → entries[isoDate] = [{lokalita,objednavka,smes,itt,ceta,cislo,tuny}, …] (jako klient)
function buildEntries(weeks) {
  const entries = {};
  (weeks || []).forEach(w => {
    const start = w.start;
    const rows = w.rows || [];
    for (let i = 0; i < 7; i++) {
      const isoStr = addDaysIso(start, i);
      if (!entries[isoStr]) entries[isoStr] = [];
      rows.forEach(r => {
        const tuny = n(r['d' + i]);
        if (tuny > 0) entries[isoStr].push({
          lokalita: r.lokalita || '', objednavka: r.objednavka || '',
          smes: r.smes || '', itt: r.itt || '', ceta: r.ceta || '',
          cislo: r.cislo || '', tuny
        });
      });
    }
  });
  return entries;
}

// Řádky měsíce — identická agregace jako rowsForMonth ve view (klíč BEZ čísla; číslo z 1. záznamu).
function rowsForMonth(y, m0, entries) {
  const weekMap = {};
  Object.keys(entries).sort().forEach(id => {
    const [yy, mm] = id.split('-').map(Number);
    if (yy === y && (mm - 1) === m0) {
      (entries[id] || []).forEach(e => {
        if (!(e.smes || '').trim() || !(e.itt || '').trim() || !(e.ceta || '').trim()) return;
        const ws = mondayOfIso(id);
        if (!weekMap[ws]) weekMap[ws] = {};
        const key = [e.lokalita || '', e.objednavka || '', e.smes || '', e.itt || '', e.ceta || ''].join('|');
        if (!weekMap[ws][key]) weekMap[ws][key] = {
          cislo: e.cislo || '', lokalita: e.lokalita || '', objednavka: e.objednavka || '',
          smes: e.smes || '', itt: e.itt || '', ceta: e.ceta || '', weekStart: ws, days: {}
        };
        const d = Number(id.slice(8, 10));
        weekMap[ws][key].days[d] = (weekMap[ws][key].days[d] || 0) + n(e.tuny);
      });
    }
  });
  const result = [];
  Object.keys(weekMap).sort().forEach(ws => {
    const rows = Object.values(weekMap[ws]);
    rows.sort((a, b) => {
      const oa = FIRMA_ORDER[a.ceta] !== undefined ? FIRMA_ORDER[a.ceta] : 99;
      const ob = FIRMA_ORDER[b.ceta] !== undefined ? FIRMA_ORDER[b.ceta] : 99;
      if (oa !== ob) return oa - ob;
      return (a.lokalita || '').localeCompare(b.lokalita || '', 'cs');
    });
    rows.forEach((r, i) => { r._firstInWeek = (i === 0); });
    result.push(...rows);
  });
  return result;
}

const INFO_HEADERS = ['č.', 'lokalita', 'objednávka', 'Směs a průkazná zk. typu', 'ITT', 'četa'];
const INFO_WIDTHS  = [8, 22, 18, 30, 12, 14];

// Strukturální barvy (header/sum/víkend/svátek) — ARGB
const C_HEADER   = 'FF1E293B';
const C_SUM_BG   = 'FFCFE0FA';
const C_WEEKDAY  = 'FFDDE9FA';
const C_WEEKEND  = 'FFE2E2E2';
const C_HOLIDAY  = 'FFDFF5E6';

function dayHeaderArgb(y, m0, d) {
  if (isHoliday(y, m0, d)) return C_HOLIDAY;
  if (isWeekend(y, m0, d)) return C_WEEKEND;
  return C_WEEKDAY;
}

// Sestaví jeden list (měsíc) do workbooku.
function buildMonthSheet(wb, y, m0, entries, companyArgb) {
  const dim = daysInMonth(y, m0);
  const days = Array.from({ length: dim }, (_, i) => i + 1);
  const rows = rowsForMonth(y, m0, entries);
  const nInfo = INFO_HEADERS.length;
  const totalCols = nInfo + dim + 1; // info + dny + Σ

  const ws = wb.addWorksheet(MONTH_NAMES[m0], { views: [{ state: 'frozen', xSplit: nInfo, ySplit: 2 }] });

  // Šířky sloupců
  INFO_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  for (let i = 0; i < dim; i++) ws.getColumn(nInfo + 1 + i).width = 5.5;
  ws.getColumn(totalCols).width = 8;

  // Denní součty (harmonogram)
  const daySumOf = d => (entries[isoYMD(y, m0, d)] || [])
    .filter(e => (e.smes || '').trim() && (e.itt || '').trim() && (e.ceta || '').trim())
    .reduce((s, e) => s + n(e.tuny), 0);

  // ── Řádek 1: Součet t/den ──
  const sumVals = new Array(totalCols).fill('');
  sumVals[0] = 'Součet t/den:';
  let grand = 0;
  days.forEach((d, i) => { const v = daySumOf(d); grand += v; sumVals[nInfo + i] = v || ''; });
  sumVals[totalCols - 1] = grand || '';
  const sumRow = ws.addRow(sumVals);
  ws.mergeCells(1, 1, 1, nInfo);
  sumRow.eachCell({ includeEmpty: true }, (c, col) => {
    c.font = { bold: true, color: { argb: 'FF1E3A8A' } };
    c.alignment = { horizontal: col <= nInfo ? 'right' : 'center', vertical: 'middle' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_SUM_BG } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFB8BCC4' } } };
  });

  // ── Řádek 2: záhlaví (info + datumy + Σ) ──
  const headVals = INFO_HEADERS.slice();
  days.forEach(d => headVals.push(d + '.' + (m0 + 1) + '.'));
  headVals.push('Σ');
  const headRow = ws.addRow(headVals);
  headRow.height = 20;
  headRow.eachCell({ includeEmpty: true }, (c, col) => {
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF334155' } } };
    if (col <= nInfo || col === totalCols) {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER } };
      if (col <= nInfo) c.alignment = { horizontal: 'left', vertical: 'middle' };
    } else {
      const d = col - nInfo;
      c.font = { bold: true, color: { argb: 'FF333333' }, size: 10 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dayHeaderArgb(y, m0, d) } };
    }
  });

  // ── Datové řádky ──
  rows.forEach(r => {
    const vals = [r.cislo || '', r.lokalita || '', r.objednavka || '', r.smes || '', r.itt || '', r.ceta || ''];
    let rowTotal = 0;
    days.forEach(d => { const v = r.days[d] || 0; rowTotal += v; vals.push(v || ''); });
    vals.push(rowTotal || '');
    const row = ws.addRow(vals);
    const argb = companyArgb(r.ceta); // barva firmy (nebo null → bílá)
    row.eachCell({ includeEmpty: true }, (c, col) => {
      c.border = { bottom: { style: 'hair', color: { argb: 'FFD9D9D9' } } };
      if (col <= nInfo) {
        // INFO sloupce: výplň dle firmy
        if (argb) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
        c.alignment = { horizontal: col === 1 ? 'center' : 'left', vertical: 'middle' };
      } else {
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        if (col === totalCols) c.font = { bold: true };
      }
    });
    if (r._firstInWeek) {
      row.eachCell({ includeEmpty: true }, c => {
        c.border = Object.assign({}, c.border, { top: { style: 'medium', color: { argb: 'FF1A1A2E' } } });
      });
    }
  });

  return ws;
}

// Hlavní vstup: { weeks, companies, year } → ExcelJS.Workbook s 12 listy.
function buildMonthWorkbook({ weeks, companies, year }) {
  const entries = buildEntries(weeks);
  // Barvy NAPEVNO dle CSS tabulky (NE z číselníku companies) → export = obrazovka.
  // Firma se určuje z pole „četa"; nenamapované/BKOM → null (bez výplně).
  const companyArgb = name => hexToArgb(FIRMA_COLORS[name]) || null;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'HMG TAXIS';
  wb.created = new Date();
  for (let m0 = 0; m0 < 12; m0++) buildMonthSheet(wb, year, m0, entries, companyArgb);
  return wb;
}

module.exports = {
  buildMonthWorkbook, buildEntries, rowsForMonth,
  hexToArgb, isHoliday, MONTH_NAMES, FIRMA_ORDER, FIRMA_COLORS,
};
