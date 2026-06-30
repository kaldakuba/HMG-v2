// FÁZE B/5 — guard mazání receptury: GET /api/inputs/usage počítá použití směsi ve week_data
// (řádky/týdny, scoped na obalovna_id). Mazání receptury (POST /api/inputs) se week_data NEdotýká.
//
// Mock: pg (week_data SELECT vrací 2 týdny; zachytíme všechny SQL), session admin + 'holubice'.

process.env.PORT           = '0';
process.env.SESSION_SECRET = 'test-secret';
process.env.GMAIL_USER     = 'test@gmail.com';
process.env.BACKUP_EMAIL   = 'backup@test.com';

// week_data: týden A má 2 řádky 'ACO 11' + 1 jiný; týden B má 1 'ACO 11'. Celkem 'ACO 11' = 3 / 2 týdny.
const WEEK_DATA = [
  { week_start: '2026-07-06', rows_json: JSON.stringify([
      { smes: 'ACO 11', cislo: '1', itt: 'x' }, { smes: 'ACO 11', cislo: '1', itt: 'x' }, { smes: 'SMA 11', cislo: '2', itt: 'y' } ]) },
  { week_start: '2026-07-13', rows_json: JSON.stringify([
      { smes: 'ACO 11', cislo: '1', itt: 'x' }, { smes: '', cislo: '', itt: '' } ]) },
];

globalThis.__SQL = [];   // všechny zachycené SQL (kvůli ověření, že POST inputs nesahá na week_data)

function mockDispatch(sql) {
  sql = String(sql);
  if (/SELECT week_start, rows_json FROM week_data/.test(sql)) return { rows: WEEK_DATA, rowCount: WEEK_DATA.length };
  if (/INSERT INTO inputs/.test(sql)) return { rows: [], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(async (sql, params) => { globalThis.__SQL.push(String(sql)); return mockDispatch(sql, params); }),
    connect: jest.fn().mockResolvedValue({ query: jest.fn(async () => ({ rows: [] })), release: jest.fn() }),
    on: jest.fn(), end: jest.fn(),
  })),
  types: { setTypeParser: jest.fn() },
}));
jest.mock('connect-pg-simple', () => () => {
  const { EventEmitter } = require('events');
  return class S extends EventEmitter { get(s,f){f&&f(null,null);} set(s,v,f){f&&f(null);} destroy(s,f){f&&f(null);} touch(s,v,f){f&&f(null);} };
});
jest.mock('express-session', () => () => (req, res, next) => {
  req.session = { userId: 1, username: 'admin', role: 'admin', obalovnaId: 'holubice', save: (cb)=>cb&&cb() };
  req.sessionID = 'sid'; next();
});
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn(async () => ({ messageId: 'm' })) })) }));

const request = require('supertest');
const { app } = require('../server');

describe('GET /api/inputs/usage — počítání použití směsi (FÁZE B/5)', () => {
  beforeEach(() => { globalThis.__SQL = []; });

  test('počítá řádky i týdny dle názvu smes; scoped na obalovna_id', async () => {
    const r = await request(app).get('/api/inputs/usage').query({ smes: 'ACO 11' });
    expect(r.status).toBe(200);
    expect(r.body.smes).toBe('ACO 11');
    expect(r.body.rowCount).toBe(3);
    expect(r.body.weeks).toEqual(['2026-07-06', '2026-07-13']);
    // scope: SELECT week_data proběhl s obalovna_id='holubice'
    const wdCall = globalThis.__SQL.find(s => /SELECT week_start, rows_json FROM week_data/.test(s));
    expect(wdCall).toBeTruthy();
  });

  test('směs bez výskytu → rowCount 0, weeks prázdné', async () => {
    const r = await request(app).get('/api/inputs/usage').query({ smes: 'NEEXISTUJE' });
    expect(r.status).toBe(200);
    expect(r.body.rowCount).toBe(0);
    expect(r.body.weeks).toEqual([]);
  });

  test('prázdný smes → rowCount 0, žádný dotaz do week_data', async () => {
    const r = await request(app).get('/api/inputs/usage').query({ smes: '' });
    expect(r.status).toBe(200);
    expect(r.body.rowCount).toBe(0);
    expect(globalThis.__SQL.some(s => /week_data/.test(s))).toBe(false);
  });

  test('POST /api/inputs (mazání receptury) se week_data NEDOTÝKÁ', async () => {
    const novaSada = [{ cislo: '2', smes: 'SMA 11', zt: 'y' }];   // 'ACO 11' odebrána
    const r = await request(app).post('/api/inputs').send({ rows: novaSada });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // žádný SQL dotaz nesmí sahat na week_data (ani SELECT, ani UPDATE/DELETE)
    expect(globalThis.__SQL.some(s => /week_data/.test(s))).toBe(false);
    // a INSERT inputs proběhl
    expect(globalThis.__SQL.some(s => /INSERT INTO inputs/.test(s))).toBe(true);
  });
});
