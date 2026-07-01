// FÁZE B/7b — B2 na dashboardu (server): itt ŽIVĚ z receptury dle smes.
// (A) Potvrzené stavby (z week_data) i (B) objednávky (pending/recent, orders.itt) → resolveCisloItt.
// Osiřelá smes → uložená hodnota + příznak osirela. recipeMap scoped na obalovnu.
//
// Mock: pg (všechny dotazy /api/dashboard), session admin + 'holubice'.

process.env.PORT           = '0';
process.env.SESSION_SECRET = 'test-secret';
process.env.GMAIL_USER     = 'test@gmail.com';
process.env.BACKUP_EMAIL   = 'backup@test.com';

const RECIPES = [{ cislo: '6', smes: 'ACO 11', zt: '6-2025-Ho' }];
const CONFIRMED = [
  { datum: '2026-07-06', lokalita: 'Brno', smes: 'ACO 11',  itt: 'STARE', komentar: '', firma: 'Colas', tuny: 100 },
  { datum: '2026-07-07', lokalita: 'X',    smes: 'Neznámá', itt: 'ORF',   komentar: '', firma: 'Colas', tuny: 50 },
];
const PENDING = [{ id: 1, smes: 'ACO 11',  itt: 'STARE-o', firma: 'Colas', datum: '2026-07-06', tuny: 20, status: 'pending',  username: 'u' }];
const RECENT  = [{ id: 2, smes: 'Neznámá', itt: 'Y-o',     firma: 'Colas', datum: '2026-07-06', tuny: 10, status: 'approved', username: 'u' }];

function mockDispatch(sql) {
  sql = String(sql);
  if (/SELECT role, firma FROM users/.test(sql))          return { rows: [{ role: 'admin', firma: null }] };
  if (/SELECT orders_allowed FROM users/.test(sql))       return { rows: [{ orders_allowed: true }] };
  if (/mod_harmonogram/.test(sql))                        return { rows: [{ mod_harmonogram: true, mod_vazenky: true, mod_objednavky: true, mod_hod_objednavky: false }] };
  if (/SELECT rows_json FROM inputs/.test(sql))           return { rows: [{ rows_json: JSON.stringify(RECIPES) }] };
  if (/COUNT\(\*\) AS cnt/.test(sql))                     return { rows: [{ cnt: '2', tons: '150' }] };
  if (/AS datum/.test(sql) && /ORDER BY datum/.test(sql)) return { rows: CONFIRMED };
  if (/key='orders_enabled'/.test(sql))                   return { rows: [{ value: 'true' }] };
  if (/key='vazenky_share_enabled'/.test(sql))            return { rows: [{ value: 'false' }] };
  if (/FROM orders/.test(sql) && /status IN \('pending'/.test(sql)) return { rows: PENDING };
  if (/FROM orders/.test(sql) && /LIMIT 10/.test(sql))    return { rows: RECENT };
  return { rows: [], rowCount: 0 };
}

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(async (sql, params) => mockDispatch(sql, params)),
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

describe('GET /api/dashboard — B2 itt z receptury (FÁZE B/7b)', () => {
  test('Potvrzené stavby: běžná smes → itt živě z receptury; osiřelá → uložená + příznak', async () => {
    const r = await request(app).get('/api/dashboard');
    expect(r.status).toBe(200);
    const list = r.body.confirmed_list;
    const aco = list.find(x => x.smes === 'ACO 11');
    const orf = list.find(x => x.smes === 'Neznámá');
    expect(aco.itt).toBe('6-2025-Ho');   // živě z receptury (NE 'STARE')
    expect(aco.osirela).toBe(false);
    expect(orf.itt).toBe('ORF');         // osiřelá → uložená hodnota
    expect(orf.osirela).toBe(true);
  });

  test('Objednávky pending/recent: itt dle receptury (ne zastaralé orders.itt); osiřelá → příznak', async () => {
    const r = await request(app).get('/api/dashboard');
    expect(r.status).toBe(200);
    const pend = r.body.pending_list.find(x => x.smes === 'ACO 11');
    expect(pend.itt).toBe('6-2025-Ho');  // NE 'STARE-o'
    expect(pend.osirela).toBe(false);
    const rec = r.body.recent.find(x => x.smes === 'Neznámá');
    expect(rec.itt).toBe('Y-o');         // osiřelá → uložená
    expect(rec.osirela).toBe(true);
  });

  test('počty/agregace beze změny (jen itt projde resolve)', async () => {
    const r = await request(app).get('/api/dashboard');
    expect(r.body.confirmed).toBe(2);
    expect(r.body.confirmed_tons).toBe(150);
    expect(r.body.pending).toBe(1);
    expect(r.body.confirmed_list).toHaveLength(2);
  });
});
