// FÁZE B/7c — POST /api/orders normalizuje orders.itt při VZNIKU dle receptury (smes klíč).
// orders tabulka nemá cislo → normalizuje se jen itt. Osiřelá smes → itt z klienta (nehádat).
// Zápisová pojistka; tok schvalování/e-maily/propagace beze změny.
//
// Mock: pg (pool = requireOrdersEnabled + kapacita + inputs; client = BEGIN/INSERT/COMMIT),
// session hmg_share + 'holubice', nodemailer.

process.env.PORT           = '0';
process.env.SESSION_SECRET = 'test-secret';
process.env.GMAIL_USER     = 'test@gmail.com';
process.env.BACKUP_EMAIL   = 'backup@test.com';

const RECIPES = [{ cislo: '6', smes: 'ACO 11', zt: '6-2025-Ho' }];

globalThis.__ORDER_INSERTS = [];   // zachycené INSERT INTO orders (params)

function mockPoolDispatch(sql) {
  sql = String(sql);
  if (/mod_harmonogram/.test(sql))                       return { rows: [{ mod_harmonogram: true, mod_vazenky: true, mod_objednavky: true, mod_hod_objednavky: false }] };
  if (/SELECT orders_allowed FROM users/.test(sql))      return { rows: [{ orders_allowed: true }] };
  if (/SELECT firma FROM users/.test(sql))               return { rows: [{ firma: 'Colas' }] };
  if (/FROM obalovna_settings/.test(sql) && /key IN/.test(sql)) return { rows: [] };            // limits prázdné → maxDaily null
  if (/SELECT value FROM obalovna_settings/.test(sql))   return { rows: [{ value: 'true' }] };  // orders_enabled
  if (/SELECT rows_json FROM inputs/.test(sql))          return { rows: [{ rows_json: JSON.stringify(RECIPES) }] };
  if (/SELECT rows_json FROM week_data/.test(sql))       return { rows: [] };
  if (/COALESCE\(SUM\(tuny\),0\)/.test(sql))             return { rows: [{ total: '0' }] };
  return { rows: [], rowCount: 0 };
}

function mockClientDispatch(sql, params) {
  sql = String(sql);
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
  if (/INSERT INTO orders/.test(sql)) { globalThis.__ORDER_INSERTS.push(params); return { rows: [], rowCount: 1 }; }
  return { rows: [] };
}

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(async (sql, params) => mockPoolDispatch(sql, params)),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn(async (sql, params) => mockClientDispatch(sql, params)),
      release: jest.fn(),
    }),
    on: jest.fn(), end: jest.fn(),
  })),
  types: { setTypeParser: jest.fn() },
}));
jest.mock('connect-pg-simple', () => () => {
  const { EventEmitter } = require('events');
  return class S extends EventEmitter { get(s,f){f&&f(null,null);} set(s,v,f){f&&f(null);} destroy(s,f){f&&f(null);} touch(s,v,f){f&&f(null);} };
});
jest.mock('express-session', () => () => (req, res, next) => {
  req.session = { userId: 5, username: 'sharer', role: 'hmg_share', obalovnaId: 'holubice', save: (cb)=>cb&&cb() };
  req.sessionID = 'sid'; next();
});
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn(async () => ({ messageId: 'm' })) })) }));

const request = require('supertest');
const { app } = require('../server');

describe('POST /api/orders — normalizace itt při vzniku (FÁZE B/7c)', () => {
  beforeEach(() => { globalThis.__ORDER_INSERTS = []; });

  test('smes v recepturách → uložený itt dle receptury; osiřelá → itt z klienta', async () => {
    const body = {
      lokalita: 'Stavba A', lat: 49.2, lng: 16.6,
      items: [
        { datum: '2099-01-05', smes: 'ACO 11',  itt: 'STARE-klient', tuny: 100 },
        { datum: '2099-01-05', smes: 'Neznámá', itt: 'X-klient',     tuny: 50 },
      ],
    };
    const r = await request(app).post('/api/orders').send(body);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // INSERT params: [groupId, userId, firma, datum, smes(4), itt(5), tuny, ...]
    expect(globalThis.__ORDER_INSERTS).toHaveLength(2);
    const byMix = {};
    globalThis.__ORDER_INSERTS.forEach(p => { byMix[p[4]] = p[5]; });
    expect(byMix['ACO 11']).toBe('6-2025-Ho');   // dle receptury (NE 'STARE-klient')
    expect(byMix['Neznámá']).toBe('X-klient');   // osiřelá → z klienta beze změny
  });

  test('prázdné itt u známé smes → doplní se z receptury', async () => {
    const body = {
      lokalita: 'Stavba B', lat: 49.2, lng: 16.6,
      items: [{ datum: '2099-01-05', smes: 'ACO 11', tuny: 30 }],   // itt vůbec neposláno
    };
    const r = await request(app).post('/api/orders').send(body);
    expect(r.status).toBe(200);
    expect(globalThis.__ORDER_INSERTS).toHaveLength(1);
    expect(globalThis.__ORDER_INSERTS[0][5]).toBe('6-2025-Ho');   // doplněno z receptury
  });
});
