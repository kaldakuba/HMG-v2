'use strict';
/**
 * Parser exportu z váhy — TSV (Windows-1250, CRLF) i .xlsx.
 *
 * Vstup:
 *   - buffer: Buffer s obsahem souboru
 *   - filename: původní název (pro detekci přípony)
 *   - taxisFirmy: pole stringů s názvy firem v TAXIS (pro substring mapping)
 *
 * Výstup: { rows, summary }
 *   - rows:    pole namapovaných váženek (validních pro INSERT)
 *   - summary: { total, valid, skipped_invalid, skipped_neprijem, skipped_storno,
 *                unassigned, by_firma: { 'Colas': N, ... }, sample[] }
 */

const XLSX = require('xlsx');

// ── Sloupcové hlavičky v exportu (přesné texty) ─────────────────────────────
const COL = {
  CISLO_VAZENKY:   'Číslo váženky',
  KOD_ZBOZI:       'Kód zboží',
  NAZEV_ZBOZI:     'Název zboží',
  NETTO:           'Netto',
  DATUM_VAZ_ODJ:   'Datum váž. odj.',
  CAS_VAZ_ODJ:     'Čas váž. odj.',
  ICO:             'IČO part./Kod prod.',
  NAZEV_PART:      'Název part.',
  RIDIC:           'Jméno řidiče',
  SPZ:             'SPZ',
  MISTO:           'Místo určení',
  PRIJEM_VYDEJ:    'Příjem/výdej',
  STORNO:          'Storno/Oprava/Neplatný',
};

// Volby pro selectování řádků
const VALID_PRIJEM_VYDEJ = 'O';  // jen výdej

// ── Detekce formátu ─────────────────────────────────────────────────────────
function detectFormat(filename, buffer) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
  if (lower.endsWith('.tsv') || lower.endsWith('.txt') || lower.endsWith('.csv')) return 'tsv';
  // Sniff: xlsx je ZIP (PK header)
  if (buffer && buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'xlsx';
  return 'tsv';
}

// ── TSV parsing (Windows-1250) ──────────────────────────────────────────────
function parseTSV(buffer) {
  const decoder = new TextDecoder('windows-1250');
  const text = decoder.decode(buffer);
  // CRLF nebo LF
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split('\t');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = cells[c] != null ? cells[c] : '';
    rows.push(obj);
  }
  return rows;
}

// ── XLSX parsing ────────────────────────────────────────────────────────────
function parseXLSX(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false });
}

// ── Normalizace pro substring matching ──────────────────────────────────────
// "COLAS CZ, a.s.*" → "colas cz as", "Mi Roads a.s." → "mi roads as"
function normForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[*,.()/\\]/g, ' ')   // hvězdičky, čárky, tečky, závorky
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Mapování firmy: substring v normalizovaném názvu partnera ───────────────
// Vrací název firmy z TAXIS (přesně jak je v companies) nebo null
function mapFirma(nazevPartnera, taxisFirmy) {
  const norm = normForMatch(nazevPartnera);
  if (!norm) return null;
  for (const firma of taxisFirmy) {
    const f = normForMatch(firma);
    if (f && norm.includes(f)) return firma;
  }
  return null;
}

// ── Pomocné konverze ────────────────────────────────────────────────────────
function parseNetto(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(',', '.');
  if (!s) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// Převod "DD.MM.RRRR" → "YYYY-MM-DD" (ISO). Pokud Excel poslal Date, ber to taky.
function parseDatum(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) {
    const yyyy = v.getUTCFullYear();
    const mm   = String(v.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(v.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  const s = String(v).trim();
  // ISO již formátované?
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  // DD.MM.YYYY
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    const dd = m[1].padStart(2,'0');
    const mm = m[2].padStart(2,'0');
    return `${m[3]}-${mm}-${dd}`;
  }
  return null;
}

// "HH:MM:SS" → "HH:MM" (oříznutí na minuty pro zobrazení; uložím plný text)
function parseCas(v) {
  if (!v) return null;
  const s = String(v).trim();
  // HH:MM:SS, HH:MM, .000123 ... ber prvních pár znaků
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1].padStart(2,'0')}:${m[2]}${m[3] ? ':' + m[3] : ''}`;
  return s;
}

// ── Hlavní mapování řádku ───────────────────────────────────────────────────
function mapRow(raw, taxisFirmy) {
  const prijemVydej = String(raw[COL.PRIJEM_VYDEJ] || '').trim();
  const storno      = String(raw[COL.STORNO]       || '').trim();

  // Filtry: jen "O" (výdej) a Storno prázdné
  if (prijemVydej !== VALID_PRIJEM_VYDEJ) return { skip: 'neprijem' };
  if (storno !== '')                       return { skip: 'storno' };

  const cislo  = String(raw[COL.CISLO_VAZENKY] || '').trim();
  const tuny   = parseNetto(raw[COL.NETTO]);
  const datum  = parseDatum(raw[COL.DATUM_VAZ_ODJ]);
  const cas    = parseCas(raw[COL.CAS_VAZ_ODJ]);
  const nazev  = String(raw[COL.NAZEV_PART] || '').trim();
  if (!cislo)             return { skip: 'invalid', reason: 'chybí Číslo váženky' };
  if (tuny == null)       return { skip: 'invalid', reason: 'neplatné Netto' };
  if (!datum)             return { skip: 'invalid', reason: 'neplatný Datum' };
  // (nazev může být prázdný → firma_taxis = null = "nepřiřazeno")

  return {
    skip:           null,
    cislo_vazenky:  cislo,
    datum,
    cas,
    smes:           String(raw[COL.NAZEV_ZBOZI] || '').trim(),
    itt:            String(raw[COL.KOD_ZBOZI]   || '').trim(),
    tuny,
    spz:            String(raw[COL.SPZ]    || '').trim(),
    ridic:          String(raw[COL.RIDIC]  || '').trim(),
    stavba:         String(raw[COL.MISTO]  || '').trim(),
    nazev_partnera: nazev,
    ico:            String(raw[COL.ICO]    || '').trim(),
    firma_taxis:    mapFirma(nazev, taxisFirmy),
  };
}

// ── Veřejné API ─────────────────────────────────────────────────────────────
/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string[]} taxisFirmy
 * @returns {{ rows: object[], summary: object }}
 */
function parseVazenky(buffer, filename, taxisFirmy) {
  const format = detectFormat(filename, buffer);
  const rawRows = format === 'xlsx' ? parseXLSX(buffer) : parseTSV(buffer);

  const summary = {
    format,
    total:            rawRows.length,
    valid:            0,
    skipped_invalid:  0,
    skipped_neprijem: 0,
    skipped_storno:   0,
    unassigned:       0,
    by_firma:         {},
    invalid_reasons:  [],   // ukázka prvních pár chyb
    sample:           [],   // ukázka prvních 3 namapovaných
  };

  const rows = [];
  for (const raw of rawRows) {
    const mapped = mapRow(raw, taxisFirmy);
    if (mapped.skip === 'neprijem') { summary.skipped_neprijem++; continue; }
    if (mapped.skip === 'storno')   { summary.skipped_storno++;   continue; }
    if (mapped.skip === 'invalid')  {
      summary.skipped_invalid++;
      if (summary.invalid_reasons.length < 5) summary.invalid_reasons.push(mapped.reason);
      continue;
    }
    summary.valid++;
    if (mapped.firma_taxis == null) summary.unassigned++;
    const key = mapped.firma_taxis || '(nepřiřazeno)';
    summary.by_firma[key] = (summary.by_firma[key] || 0) + 1;
    if (summary.sample.length < 3) summary.sample.push({
      cislo_vazenky: mapped.cislo_vazenky, datum: mapped.datum, cas: mapped.cas,
      smes: mapped.smes, itt: mapped.itt, tuny: mapped.tuny,
      stavba: mapped.stavba, nazev_partnera: mapped.nazev_partnera,
      firma_taxis: mapped.firma_taxis,
    });
    rows.push(mapped);
  }
  return { rows, summary };
}

module.exports = { parseVazenky, parseTSV, parseXLSX, mapFirma, normForMatch, detectFormat };
