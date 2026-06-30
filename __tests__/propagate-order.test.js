'use strict';
/**
 * P2 #4 — DRY objednávkový tok. Testy sdílené funkce propagateOrderToWeekData
 * + zachování chování approve (best-effort 200) vs finalize (fatal 500).
 *
 * Mocky: pg, connect-pg-simple, express-session (admin + obalovna 'holubice'), nodemailer.
 */

process.env.PORT           = '0';
process.env.SESSION_SECRET = 'test-secret';
process.env.GMAIL_USER     = 'test@gmail.com';
process.env.BACKUP_EMAIL   = 'backup@test.com';

// ── pg mock pro integrační část (approve/finalize). Flags přes globalThis. ───────
globalThis.__INSERTS = [];
globalThis.__FAIL_INSERT = false;

function mockDispatch(sql, params, isClient) {
  sql = String(sql);
  if (isClient && /BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [], rowCount: 0 };
  // requireOrdersEnabled → getObalovnaModuly (modul objednávky musí být povolen)
  if (/mod_harmonogram/.test(sql)) return { rows: [{ mod_harmonogram: true, mod_vazenky: true, mod_objednavky: true, mod_hod_objednavky: false }], rowCount: 1 };
  // finalize: kontroly počtů
  if (/COUNT\(\*\)::int AS cnt/.test(sql) && /status='pending'/.test(sql)) return { rows: [{ cnt: 0 }], rowCount: 1 };
  if (/COUNT\(\*\)::int AS cnt/.test(sql) && /pre_approved/.test(sql))     return { rows: [{ cnt: 1 }], rowCount: 1 };
  // approve: skupinové součty (kapacita)
  if (/SUM\(tuny\)::int AS group_tuny/.test(sql)) return { rows: [{ datum: '2026-06-03', group_tuny: 120 }], rowCount: 1 };
  // hmg_max_daily → prázdné = maxDaily null (přeskočí kapacitní smyčku)
  if (/hmg_max_daily/.test(sql)) return { rows: [], rowCount: 0 };
  // finalize (client): UPDATE → approved RETURNING datum,...
  if (/UPDATE orders SET status='approved'/.test(sql) && /RETURNING datum/.test(sql))
    return { rows: [{ datum: '2026-06-03', smes: 'AC', itt: 'X', tuny: 120, lokalita: 'Praha', lat: null, lng: null, firma: 'Colas' }], rowCount: 1 };
  // approve: UPDATE → approved RETURNING id
  if (/UPDATE orders SET status='approved'/.test(sql) && /RETURNING id/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
  if (/UPDATE orders SET status='rejected'/.test(sql)) return { rows: [], rowCount: 0 };
  // approve: položky skupiny
  if (/SELECT datum, smes, itt, tuny, lokalita, lat, lng, firma/.test(sql))
    return { rows: [{ datum: '2026-06-03', smes: 'AC', itt: 'X', tuny: 120, lokalita: 'Praha', lat: null, lng: null, firma: 'Colas' }], rowCount: 1 };
  // week_data read
  if (/SELECT rows_json FROM week_data/.test(sql)) return { rows: [], rowCount: 0 };
  // week_data upsert
  if (/INSERT INTO week_data/.test(sql)) {
    globalThis.__INSERTS.push(params);
    if (globalThis.__FAIL_INSERT) throw new Error('simulovaná chyba upsertu week_data');
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(async (sql, params) => mockDispatch(sql, params, false)),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn(async (sql, params) => mockDispatch(sql, params, true)),
      release: jest.fn(),
    }),
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
const { app, propagateOrderToWeekData } = require('../server');

const UUID = '11111111-1111-1111-1111-111111111111';

// Očekávaný výstup ZAMČEN ze současné logiky (charakterizace before/after).
const EXPECT_WEEK1 = '[{"checked":true,"cislo":"X","lokalita":"stara"},{"checked":false,"cislo":"","lokalita":"Praha","objednavka":"Colas","smes":"AC 11 S","itt":"ITT-X","ceta":"Colas","lat":50.1,"lng":14.2,"d0":0,"d1":0,"d2":120,"d3":0,"d4":0,"d5":0,"d6":0},{"checked":false,"cislo":"","lokalita":"Brno","objednavka":"Firesta","smes":"SMA","itt":"ITT-Y","ceta":"Firesta","lat":null,"lng":null,"d0":0,"d1":0,"d2":0,"d3":0,"d4":80,"d5":0,"d6":0}]';
const EXPECT_WEEK2 = '[{"checked":false,"cislo":"","lokalita":"Olomouc","objednavka":"Mi Roads","smes":"AC 11 S","itt":"","ceta":"Mi Roads","lat":null,"lng":null,"d0":0,"d1":0,"d2":50,"d3":0,"d4":0,"d5":0,"d6":0}]';

describe('propagateOrderToWeekData — charakterizace (bajtově identický výstup)', () => {
  const items = [
    { datum: '2026-06-03', smes: 'AC 11 S', itt: 'ITT-X', tuny: '120', lokalita: 'Praha',   lat: 50.1, lng: 14.2, firma: 'Colas' },
    { datum: '2026-06-05', smes: 'SMA',     itt: 'ITT-Y', tuny: 80,    lokalita: 'Brno',    lat: null, lng: null, firma: 'Firesta' },
    { datum: '2026-06-10', smes: 'AC 11 S', itt: '',      tuny: 50,    lokalita: 'Olomouc', lat: null, lng: null, firma: 'Mi Roads' },
  ];

  function fakeDb() {
    const reads = [], inserts = [];
    const db = {
      query: async (sql, params) => {
        if (/SELECT rows_json FROM week_data/.test(sql)) {
          reads.push(params);
          if (params[0] === '2026-06-01') return { rows: [{ rows_json: '[{"checked":true,"cislo":"X","lokalita":"stara"}]' }] };
          return { rows: [] };
        }
        if (/INSERT INTO week_data/.test(sql)) { inserts.push({ sql, params }); return { rows: [], rowCount: 1 }; }
        return { rows: [] };
      },
    };
    return { db, reads, inserts };
  }

  test('rows_json bajtově shodný + weekStart + ON CONFLICT + obalovna_id (read i upsert)', async () => {
    const { db, reads, inserts } = fakeDb();
    const n = await propagateOrderToWeekData(items, 'holubice', db);

    expect(n).toBe(2);
    expect(inserts).toHaveLength(2);

    // weekStart + bajtově identický rows_json
    expect(inserts[0].params[0]).toBe('2026-06-01');
    expect(inserts[0].params[1]).toBe(EXPECT_WEEK1);
    expect(inserts[1].params[0]).toBe('2026-06-08');
    expect(inserts[1].params[1]).toBe(EXPECT_WEEK2);

    // ON CONFLICT (week_start, obalovna_id)
    expect(inserts[0].sql).toMatch(/ON CONFLICT\(week_start,obalovna_id\)/);
    // obalovna_id v upsertu (param $3) i v readu (param $2)
    expect(inserts[0].params[2]).toBe('holubice');
    expect(inserts[1].params[2]).toBe('holubice');
    expect(reads.every(r => r[1] === 'holubice')).toBe(true);
  });
});

describe('propagateOrderToWeekData — cross-tenant pojistka', () => {
  const noop = { query: async () => ({ rows: [] }) };
  test('falsy obalovna_id → throw', async () => {
    await expect(propagateOrderToWeekData([], '', noop)).rejects.toThrow(/obalovna_id/);
    await expect(propagateOrderToWeekData([], null, noop)).rejects.toThrow(/obalovna_id/);
    await expect(propagateOrderToWeekData([], undefined, noop)).rejects.toThrow(/obalovna_id/);
  });
});

describe('Integrace — zachování error-handlingu (approve best-effort vs finalize fatal)', () => {
  beforeEach(() => { globalThis.__INSERTS = []; globalThis.__FAIL_INSERT = false; });

  test('approve OK → 200 a zapsán upsert do week_data', async () => {
    const r = await request(app).patch(`/api/orders/${UUID}/approve`).send({ confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(globalThis.__INSERTS.length).toBeGreaterThan(0);
    expect(globalThis.__INSERTS[0][2]).toBe('holubice'); // obalovna_id v upsertu
  });

  test('approve s chybou propagace → STÁLE 200 (best-effort)', async () => {
    globalThis.__FAIL_INSERT = true;
    const r = await request(app).patch(`/api/orders/${UUID}/approve`).send({ confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test('finalize OK → 200', async () => {
    const r = await request(app).patch(`/api/orders/${UUID}/finalize`).send({});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(globalThis.__INSERTS.length).toBeGreaterThan(0);
  });

  test('finalize s chybou propagace → 500 (fatal po commitu)', async () => {
    globalThis.__FAIL_INSERT = true;
    const r = await request(app).patch(`/api/orders/${UUID}/finalize`).send({});
    expect(r.status).toBe(500);
  });
});
