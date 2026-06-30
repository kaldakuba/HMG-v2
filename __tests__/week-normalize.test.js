// FÁZE B/1 — POST /api/week napojuje normalizeRowsByRecipe.
// Server při uložení týdne srovná cislo/itt každého řádku s recepturou DANÉ obalovny
// (scoped na obalovna_id). Osiřelé směsi (mimo receptury) → cislo/itt beze změny.
//
// Mock: pg (inputs SELECT vrací receptury Holubice; week_data upsert zachytíme),
// connect-pg-simple, express-session (admin + 'holubice'), nodemailer.

process.env.PORT           = '0';
process.env.SESSION_SECRET = 'test-secret';
process.env.GMAIL_USER     = 'test@gmail.com';
process.env.BACKUP_EMAIL   = 'backup@test.com';

// Receptury Holubice (zdroj pravdy pro tento test)
const RECIPES = [
  { cislo: '6',   smes: 'ACP 22S 50/70',    zt: '6-2025-Ho' },
  { cislo: '18',  smes: 'ACL 16S 25/55-60', zt: '18-2025-Ho' },
  { cislo: 'LAK', smes: 'Lakovka',          zt: 'LAK' },
];

// Zachycený upsert do week_data (rows_json string + params)
globalThis.__WEEK_UPSERT = null;

function mockDispatch(sql) {
  sql = String(sql);
  if (/SELECT rows_json FROM inputs/.test(sql)) {
    return { rows: [{ rows_json: JSON.stringify(RECIPES) }], rowCount: 1 };
  }
  if (/INSERT INTO week_data/.test(sql)) {
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
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
const { app } = require('../server');

function emptyDays(over) {
  return Object.assign({ checked: false, cislo: '', lokalita: '', objednavka: '', smes: '', itt: '', ceta: '',
    lat: null, lng: null, d0: '', d1: '', d2: '', d3: '', d4: '', d5: '', d6: '' }, over);
}

describe('POST /api/week — normalizace cislo/itt dle receptury (FÁZE B/1)', () => {
  beforeEach(() => { globalThis.__WEEK_UPSERT = null; });

  test('řádek s nesedícím cislo/itt → po uložení srovnáno dle receptury; ostatní pole netknuta', async () => {
    const rows = [
      emptyDays({ smes: 'ACP 22S 50/70',    cislo: '4',  itt: '4-2025-Ho',  lokalita: 'Zlín',     ceta: 'Mi Roads', d0: '120' }),
      emptyDays({ smes: 'ACL 16S 25/55-60', cislo: '11', itt: '11-2025-Ho', lokalita: 'Hodějice', ceta: 'Firesta',  d1: '80' }),
    ];
    const r = await request(app).post('/api/week/2026-07-20').send({ rows });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    expect(globalThis.__WEEK_UPSERT).not.toBeNull();
    expect(globalThis.__WEEK_UPSERT[0]).toBe('2026-07-20');   // week_start
    expect(globalThis.__WEEK_UPSERT[2]).toBe('holubice');     // obalovna_id ze session

    const saved = JSON.parse(globalThis.__WEEK_UPSERT[1]);
    expect(saved[0].cislo).toBe('6');   expect(saved[0].itt).toBe('6-2025-Ho');
    expect(saved[1].cislo).toBe('18');  expect(saved[1].itt).toBe('18-2025-Ho');
    // ostatní pole beze změny
    expect(saved[0].lokalita).toBe('Zlín');
    expect(saved[0].ceta).toBe('Mi Roads');
    expect(saved[0].d0).toBe('120');
    expect(saved[1].lokalita).toBe('Hodějice');
    expect(saved[1].d1).toBe('80');
    // zobrazovací příznak se NEUKLÁDÁ
    expect(saved[0]).not.toHaveProperty('_osirela');
  });

  test('osiřelá směs (mimo receptury) → cislo/itt beze změny, _osirela se neukládá', async () => {
    const rows = [ emptyDays({ smes: 'Smazaná směs', cislo: '99', itt: '99-2020-Ho', lokalita: 'X', d0: '10' }) ];
    const r = await request(app).post('/api/week/2026-07-27').send({ rows });
    expect(r.status).toBe(200);

    const saved = JSON.parse(globalThis.__WEEK_UPSERT[1]);
    expect(saved[0].cislo).toBe('99');         // ponecháno (historická pravda)
    expect(saved[0].itt).toBe('99-2020-Ho');
    expect(saved[0]).not.toHaveProperty('_osirela');
    expect(saved[0].smes).toBe('Smazaná směs');
  });

  test('už správné cislo/itt → zůstanou; prázdná smes → beze změny', async () => {
    const rows = [
      emptyDays({ smes: 'Lakovka', cislo: 'LAK', itt: 'LAK', d0: '5' }),
      emptyDays({ smes: '', cislo: '7', itt: 'cokoliv' }),
    ];
    const r = await request(app).post('/api/week/2026-08-03').send({ rows });
    expect(r.status).toBe(200);
    const saved = JSON.parse(globalThis.__WEEK_UPSERT[1]);
    expect(saved[0].cislo).toBe('LAK');  expect(saved[0].itt).toBe('LAK');
    expect(saved[1].cislo).toBe('7');    expect(saved[1].itt).toBe('cokoliv'); // prázdná smes netknuta
  });
});
