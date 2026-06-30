// FÁZE B/2a — POST /api/import-excel napojuje normalizeRowsByRecipe.
// Řádky vytvořené importem dostanou cislo/itt podle receptury DANÉ obalovny (svaté pravidlo),
// ne z importního dopočtu (ittToCislo). Osiřelé směsi (mimo receptury) → cislo/itt beze změny.
//
// Mock: pg (inputs SELECT vrací receptury Holubice; week_data upsert zachytíme),
// connect-pg-simple, express-session (admin + 'holubice'), nodemailer.

process.env.PORT           = '0';
process.env.SESSION_SECRET = 'test-secret';
process.env.GMAIL_USER     = 'test@gmail.com';
process.env.BACKUP_EMAIL   = 'backup@test.com';

// Receptury, které „DB vrátí" po importu (zdroj pravdy pro normalizaci)
const DB_RECIPES = [{ cislo: '6', smes: 'ACP 22S 50/70', zt: '6-2025-Ho' }];

globalThis.__WEEK_UPSERT = null;   // zachycený upsert do week_data [start, rows_json, obalovna]

function mockDispatch(sql) {
  sql = String(sql);
  if (/SELECT rows_json FROM inputs/.test(sql)) return { rows: [{ rows_json: JSON.stringify(DB_RECIPES) }], rowCount: 1 };
  return { rows: [], rowCount: 1 };
}

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(async (sql, params) => {
      if (/INSERT INTO week_data/.test(String(sql))) globalThis.__WEEK_UPSERT = params;
      return mockDispatch(sql, params);
    }),
    connect: jest.fn().mockResolvedValue({ query: jest.fn(async () => ({ rows: [] })), release: jest.fn() }),
    on: jest.fn(),
    end: jest.fn(),
  })),
  types: { setTypeParser: jest.fn() },
}));

jest.mock('connect-pg-simple', () => () => {
  const { EventEmitter } = require('events');
  return class MockPgStore extends EventEmitter {
    get(sid, fn) { fn && fn(null, null); }
    set(sid, sess, fn) { fn && fn(null); }
    destroy(sid, fn) { fn && fn(null); }
    touch(sid, s, fn) { fn && fn(null); }
  };
});

jest.mock('express-session', () => () => (req, res, next) => {
  req.session = { userId: 1, username: 'admin', role: 'admin', obalovnaId: 'holubice', save: (cb) => cb && cb() };
  req.sessionID = 'sid';
  next();
});

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn(async () => ({ messageId: 'mock-id' })) })),
}));

const request = require('supertest');
const XLSX = require('xlsx');
const { app } = require('../server');

// Excel serial (epocha 1899-12-30) — datum daleko v budoucnu, ať týden NIKDY není < todayMonday.
function serial(y, m, d) { return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000); }

function buildXlsxBuffer() {
  // Záložka receptur: hlavička (řádek 0, přeskočí se) + 1 receptura. Sloupce: 0=cislo,1=smes,2=zt.
  const recAoa = [
    ['cislo', 'smes', 'zt'],
    [6, 'ACP 22S 50/70', '6-2025-Ho'],
  ];
  const recSheet = XLSX.utils.aoa_to_sheet(recAoa);

  // Týdenní list (název = číslo): r1 = datumy (c6..c12), r2+ = řádky (0=cislo,1=lok,2=obj,3=smes,4=itt,5=ceta).
  const weekAoa = [
    [],                                                              // r0
    [null, null, null, null, null, null, serial(2099, 1, 5)],        // r1: c6 = pondělí 2099-01-05
    [4,  'Zlín', 'OBJ',  'ACP 22S 50/70', '4-2025-Ho',  'Mi Roads'], // r2: cislo/itt NESEDÍ receptuře
    [99, 'X',    'OBJ2', 'Smazaná',       '99-2020-Ho', 'Firesta'],  // r3: osiřelá (smes mimo receptury)
  ];
  const weekSheet = XLSX.utils.aoa_to_sheet(weekAoa);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, recSheet, 'seznam balenéreceptury');
  XLSX.utils.book_append_sheet(wb, weekSheet, '1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('POST /api/import-excel — normalizace cislo/itt dle receptury (FÁZE B/2a)', () => {
  beforeEach(() => { globalThis.__WEEK_UPSERT = null; });

  test('importovaný řádek s nesedícím cislo/itt → srovnán dle receptury; osiřelá zachována; obalovna ze session', async () => {
    const buf = buildXlsxBuffer();
    const r = await request(app).post('/api/import-excel').attach('file', buf, 'import.xlsx');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    expect(globalThis.__WEEK_UPSERT).not.toBeNull();
    expect(globalThis.__WEEK_UPSERT[0]).toBe('2099-01-05');  // week_start (parsováno z Excelu)
    expect(globalThis.__WEEK_UPSERT[2]).toBe('holubice');    // obalovna_id ze session

    const saved = JSON.parse(globalThis.__WEEK_UPSERT[1]);
    expect(saved).toHaveLength(2);
    // řádek 1: srovnán dle receptury (z '4' / '4-2025-Ho' na '6' / '6-2025-Ho')
    expect(saved[0].smes).toBe('ACP 22S 50/70');
    expect(saved[0].cislo).toBe('6');
    expect(saved[0].itt).toBe('6-2025-Ho');
    expect(saved[0].lokalita).toBe('Zlín');   // ostatní pole netknuta
    expect(saved[0].ceta).toBe('Mi Roads');
    expect(saved[0]).not.toHaveProperty('_osirela');
    // řádek 2: osiřelá → cislo/itt beze změny, bez _osirela
    expect(saved[1].smes).toBe('Smazaná');
    expect(saved[1].cislo).toBe('99');
    expect(saved[1].itt).toBe('99-2020-Ho');
    expect(saved[1]).not.toHaveProperty('_osirela');
  });
});
