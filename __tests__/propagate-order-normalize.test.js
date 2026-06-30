// FÁZE B/2b — propagateOrderToWeekData napojuje normalizeRowsByRecipe.
// Propagovaný řádek dostane cislo/itt dle receptury DANÉ obalovny (svaté pravidlo), ne cislo:''
// + itt z objednávky. Osiřelá smes (mimo receptury) → cislo/itt beze změny. Normalizuje se JEN
// nový řádek (existující řádky týdne netknuty). best-effort/fatal/pool-po-commitu ověřeno
// v propagate-order.test.js (musí zůstat zelené).
//
// Mocky kvůli require('../server') — funkce se ale volá s vlastním fakeDb (nepoužije pool mock).

process.env.PORT           = '0';
process.env.SESSION_SECRET = 'test-secret';
process.env.GMAIL_USER     = 'test@gmail.com';
process.env.BACKUP_EMAIL   = 'backup@test.com';

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: jest.fn().mockResolvedValue({ query: jest.fn(async () => ({ rows: [] })), release: jest.fn() }),
    on: jest.fn(), end: jest.fn(),
  })),
  types: { setTypeParser: jest.fn() },
}));
jest.mock('connect-pg-simple', () => () => {
  const { EventEmitter } = require('events');
  return class MockPgStore extends EventEmitter {
    get(s, fn) { fn && fn(null, null); } set(s, v, fn) { fn && fn(null); }
    destroy(s, fn) { fn && fn(null); } touch(s, v, fn) { fn && fn(null); }
  };
});
jest.mock('express-session', () => () => (req, res, next) => {
  req.session = { userId: 1, username: 'admin', role: 'admin', obalovnaId: 'holubice', save: (cb) => cb && cb() };
  req.sessionID = 'sid'; next();
});
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn(async () => ({ messageId: 'm' })) })) }));

const { propagateOrderToWeekData } = require('../server');

// fakeDb: inputs SELECT vrátí zadané receptury; week_data SELECT prázdné; INSERT zachytí.
function fakeDb(recipes, existingWeekRows) {
  const inserts = [];
  const db = {
    query: async (sql, params) => {
      sql = String(sql);
      if (/SELECT rows_json FROM inputs/.test(sql)) return { rows: [{ rows_json: JSON.stringify(recipes) }] };
      if (/SELECT rows_json FROM week_data/.test(sql)) {
        return existingWeekRows ? { rows: [{ rows_json: JSON.stringify(existingWeekRows) }] } : { rows: [] };
      }
      if (/INSERT INTO week_data/.test(sql)) { inserts.push({ sql, params }); return { rows: [], rowCount: 1 }; }
      return { rows: [] };
    },
  };
  return { db, inserts };
}

const RECIPES = [{ cislo: '6', smes: 'ACP 22S 50/70', zt: '6-2025-Ho' }];

describe('propagateOrderToWeekData — normalizace cislo/itt (FÁZE B/2b)', () => {
  test('smes v recepturách → propagovaný řádek má cislo/itt dle receptury (ne prázdné/z objednávky)', async () => {
    const { db, inserts } = fakeDb(RECIPES);
    const items = [{ datum: '2099-01-05', smes: 'ACP 22S 50/70', itt: 'WRONG-itt', tuny: '120', lokalita: 'Zlín', lat: null, lng: null, firma: 'Colas' }];
    const n = await propagateOrderToWeekData(items, 'holubice', db);
    expect(n).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[2]).toBe('holubice');   // obalovna_id

    const saved = JSON.parse(inserts[0].params[1]);
    const row = saved[saved.length - 1];   // nově přidaný řádek
    expect(row.smes).toBe('ACP 22S 50/70');
    expect(row.cislo).toBe('6');           // dle receptury (NE '')
    expect(row.itt).toBe('6-2025-Ho');     // dle receptury (NE 'WRONG-itt' z objednávky)
    expect(row.objednavka).toBe('Colas');  // ostatní pole netknuta
    expect(row.ceta).toBe('Colas');
    expect(row).not.toHaveProperty('_osirela');
  });

  test('osiřelá smes (mimo receptury) → cislo zůstane prázdné, itt z objednávky, bez _osirela', async () => {
    const { db, inserts } = fakeDb(RECIPES);
    const items = [{ datum: '2099-01-05', smes: 'Neznámá směs', itt: 'X-itt', tuny: 50, lokalita: 'Brno', lat: null, lng: null, firma: 'Firesta' }];
    const n = await propagateOrderToWeekData(items, 'holubice', db);
    expect(n).toBe(1);
    const saved = JSON.parse(inserts[0].params[1]);
    const row = saved[saved.length - 1];
    expect(row.smes).toBe('Neznámá směs');
    expect(row.cislo).toBe('');            // beze změny (objednávka cislo nedává)
    expect(row.itt).toBe('X-itt');         // z objednávky beze změny
    expect(row).not.toHaveProperty('_osirela');
  });

  test('existující řádky týdne se NEdotýkáme — normalizuje se jen nový řádek', async () => {
    // V týdnu je už řádek se „špatným" cislo/itt vůči receptuře; propagace ho NESMÍ změnit.
    const existing = [{ checked: false, cislo: '999', lokalita: 'Stará', smes: 'ACP 22S 50/70', itt: 'STARE-itt', ceta: 'X' }];
    const { db, inserts } = fakeDb(RECIPES, existing);
    const items = [{ datum: '2099-01-05', smes: 'ACP 22S 50/70', itt: 'WRONG', tuny: 10, lokalita: 'Nová', lat: null, lng: null, firma: 'Colas' }];
    await propagateOrderToWeekData(items, 'holubice', db);
    const saved = JSON.parse(inserts[0].params[1]);
    // existující řádek beze změny
    expect(saved[0].cislo).toBe('999');
    expect(saved[0].itt).toBe('STARE-itt');
    // nový řádek normalizován
    expect(saved[1].cislo).toBe('6');
    expect(saved[1].itt).toBe('6-2025-Ho');
  });
});
