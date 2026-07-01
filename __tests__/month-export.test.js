// Test exportu měsíčního harmonogramu (lib/month-export.js):
// 12 listů (Leden…Prosinec), info sloupce obarvené dle firmy, BKOM/ostatní bez výplně,
// data sedí s agregací měsíčního pohledu (rowsForMonth).

const { buildMonthWorkbook, rowsForMonth, buildEntries, hexToArgb, MONTH_NAMES }
  = require('../lib/month-export');

// Číselník companies má ZÁMĚRNĚ jiné barvy než CSS tabulka (jako reálná DB:
// Mi Roads #ffbdbf, BKOM #dec9d9) — export je MUSÍ ignorovat a použít barvy napevno.
const companies = [
  { name: 'Colas',    color: '#aaaaaa' },
  { name: 'Firesta',  color: '#bbbbbb' },
  { name: 'Mi Roads', color: '#ffbdbf' },
  { name: 'BKOM',     color: '#dec9d9' },
  { name: 'SÚS',      color: '#123456' },
];

// Týden začínající pondělím 2026-06-01; d0=Po 1.6.2026
const weeks = [{
  start: '2026-06-01',
  rows: [
    { cislo: '101', lokalita: 'Brno',    objednavka: 'OBJ1', smes: 'ACO 11', itt: 'ITT-A', ceta: 'Colas',    d0: '100', d1: '', d2: '', d3: '', d4: '', d5: '', d6: '' },
    { cislo: '102', lokalita: 'Olomouc', objednavka: 'OBJ2', smes: 'ACP 16', itt: 'ITT-B', ceta: 'Firesta',  d0: '50',  d1: '60', d2: '', d3: '', d4: '', d5: '', d6: '' },
    { cislo: '103', lokalita: 'Zlín',    objednavka: 'OBJ3', smes: 'ACL 8',  itt: 'ITT-C', ceta: 'Mi Roads', d0: '',    d1: '70', d2: '', d3: '', d4: '', d5: '', d6: '' },
    { cislo: '104', lokalita: 'Praha',   objednavka: 'OBJ4', smes: 'ACO 16', itt: 'ITT-D', ceta: 'BKOM',     d0: '30',  d1: '', d2: '', d3: '', d4: '', d5: '', d6: '' },
    { cislo: '105', lokalita: 'Vyškov',  objednavka: 'OBJ5', smes: 'ACO 22', itt: 'ITT-E', ceta: 'SÚS',      d0: '40',  d1: '', d2: '', d3: '', d4: '', d5: '', d6: '' },
  ],
}];

describe('lib/month-export — workbook', () => {
  test('hexToArgb převede #rrggbb na FFRRGGBB; prázdné → null', () => {
    expect(hexToArgb('#fff2a8')).toBe('FFFFF2A8');
    expect(hexToArgb('d9ead3')).toBe('FFD9EAD3');
    expect(hexToArgb('')).toBeNull();
    expect(hexToArgb(null)).toBeNull();
    expect(hexToArgb('nesmysl')).toBeNull();
  });

  test('workbook má 12 listů Leden…Prosinec', () => {
    const wb = buildMonthWorkbook({ weeks, companies, year: 2026 });
    const names = wb.worksheets.map(ws => ws.name);
    expect(names).toEqual(MONTH_NAMES);
    expect(names).toHaveLength(12);
  });

  test('list Červen: info sloupce obarvené dle firmy, BKOM bez výplně, data sedí s rowsForMonth', () => {
    const wb = buildMonthWorkbook({ weeks, companies, year: 2026 });
    const ws = wb.getWorksheet('Červen');
    expect(ws).toBeTruthy();

    // Data řádky jsou od 3. řádku (1=Součet, 2=záhlaví). Najdi dle lokality v 2. sloupci.
    const fillArgb = (rowNum, col) => {
      const f = ws.getRow(rowNum).getCell(col).fill;
      return (f && f.fgColor && f.fgColor.argb) || null;
    };
    const findRowByLokalita = (lok) => {
      for (let i = 3; i <= ws.rowCount; i++) {
        if (ws.getRow(i).getCell(2).value === lok) return i;
      }
      return -1;
    };

    const rColas = findRowByLokalita('Brno');
    const rFiresta = findRowByLokalita('Olomouc');
    const rMiRoads = findRowByLokalita('Zlín');
    const rBkom = findRowByLokalita('Praha');
    const rSus = findRowByLokalita('Vyškov');
    expect(rColas).toBeGreaterThan(0);
    expect(rBkom).toBeGreaterThan(0);
    expect(rSus).toBeGreaterThan(0);

    // INFO sloupce (1..6) obarvené NAPEVNO dle CSS tabulky (NE dle číselníku companies)
    expect(fillArgb(rColas, 1)).toBe('FFFFF2A8');
    expect(fillArgb(rColas, 6)).toBe('FFFFF2A8');
    expect(fillArgb(rFiresta, 2)).toBe('FFD9EAD3');
    expect(fillArgb(rMiRoads, 3)).toBe('FFFF7F86'); // ne #ffbdbf z číselníku
    // BKOM i ostatní (SÚS) → bez výplně, i když mají barvu v číselníku
    expect(fillArgb(rBkom, 1)).toBeNull();
    expect(fillArgb(rSus, 1)).toBeNull();

    // Σ (poslední sloupec) řádku Olomouc = 50+60 = 110
    const lastCol = ws.columnCount;
    expect(ws.getRow(rFiresta).getCell(lastCol).value).toBe(110);

    // Shoda s agregací view
    const entries = buildEntries(weeks);
    const rows = rowsForMonth(2026, 5, entries); // červen = index 5
    expect(rows).toHaveLength(5);
    const colas = rows.find(r => r.ceta === 'Colas');
    expect(colas.days[1]).toBe(100); // 1.6. = d0
  });

  test('prázdný rok → stále 12 listů', () => {
    const wb = buildMonthWorkbook({ weeks: [], companies, year: 2030 });
    expect(wb.worksheets.map(w => w.name)).toEqual(MONTH_NAMES);
  });
});

// FÁZE B/7a — B2 v exportu: cislo/itt ŽIVĚ z receptury (recipeMap z `inputs`); osiřelé červeně.
describe('lib/month-export — B2 (cislo/itt z receptury)', () => {
  const RECIPES = [{ cislo: '6', smes: 'ACO 11', zt: '6-2025-Ho' }];
  const b2weeks = [{
    start: '2026-06-01',
    rows: [
      { cislo: '4',  lokalita: 'Brno',    objednavka: 'O1', smes: 'ACO 11',  itt: 'STARE-itt', ceta: 'Colas', d0: '100', d1: '', d2: '', d3: '', d4: '', d5: '', d6: '' },
      { cislo: '99', lokalita: 'Olomouc', objednavka: 'O2', smes: 'Neznámá', itt: 'X-itt',     ceta: 'Colas', d0: '50',  d1: '', d2: '', d3: '', d4: '', d5: '', d6: '' },
    ],
  }];
  const RED = 'FFDC2626';
  const findRow = (ws, lok) => { for (let i = 3; i <= ws.rowCount; i++) { if (ws.getRow(i).getCell(2).value === lok) return i; } return -1; };

  test('běžná smes → cislo/itt ŽIVĚ z receptury (ne z uložené kopie); bez červené', () => {
    const wb = buildMonthWorkbook({ weeks: b2weeks, companies, year: 2026, inputs: RECIPES });
    const ws = wb.getWorksheet('Červen');
    const r = findRow(ws, 'Brno');
    expect(r).toBeGreaterThan(0);
    expect(ws.getRow(r).getCell(1).value).toBe('6');           // cislo z receptury (NE '4')
    expect(ws.getRow(r).getCell(5).value).toBe('6-2025-Ho');   // itt z receptury (NE 'STARE-itt')
    const f = ws.getRow(r).getCell(1).font;
    expect(f && f.color && f.color.argb).not.toBe(RED);
  });

  test('osiřelá smes → uložená hodnota + červené písmo na č.(1)/směs(4)/ITT(5)', () => {
    const wb = buildMonthWorkbook({ weeks: b2weeks, companies, year: 2026, inputs: RECIPES });
    const ws = wb.getWorksheet('Červen');
    const r = findRow(ws, 'Olomouc');
    expect(r).toBeGreaterThan(0);
    expect(ws.getRow(r).getCell(1).value).toBe('99');          // uložené cislo (nehádá)
    expect(ws.getRow(r).getCell(5).value).toBe('X-itt');       // uložené itt
    expect(ws.getRow(r).getCell(1).font.color.argb).toBe(RED);
    expect(ws.getRow(r).getCell(4).font.color.argb).toBe(RED);
    expect(ws.getRow(r).getCell(5).font.color.argb).toBe(RED);
  });

  test('bez inputs → B2 vypnuto (zpětná kompat: uložené hodnoty, bez červené)', () => {
    const wb = buildMonthWorkbook({ weeks: b2weeks, companies, year: 2026 });   // inputs neuveden
    const ws = wb.getWorksheet('Červen');
    const rB = findRow(ws, 'Brno');
    expect(ws.getRow(rB).getCell(1).value).toBe('4');          // uložené (neživé)
    expect(ws.getRow(rB).getCell(5).value).toBe('STARE-itt');
    const rO = findRow(ws, 'Olomouc');
    const f = ws.getRow(rO).getCell(1).font;
    expect(f && f.color && f.color.argb).not.toBe(RED);        // žádné označení osiřelých
  });
});
