'use strict';
/**
 * Regresní test (P1): validace číselného id na user-mutačních endpointech.
 * Nečíselné/neplatné id MUSÍ vrátit HTTP 400 (ne 500, ne unhandled rejection / crash).
 * Validní číselné id projde stávající logikou (mock DB → 404, žádný pád).
 *
 * Mocky: pg (DB), connect-pg-simple (session store), express-session (injektuje admin
 * session), nodemailer. Žádná reálná DB, žádný HTTP login flow.
 */

process.env.PORT           = '0';
process.env.SESSION_SECRET = 'test-secret';      // server.js bez něj process.exit(1)
process.env.GMAIL_USER     = 'test@gmail.com';
process.env.BACKUP_EMAIL   = 'backup@test.com';

// ── pg mock: UPDATE/DELETE users vrací rowCount 0 (žádný odpovídající uživatel) ──
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
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
    get(sid, fn)       { fn && fn(null, null); }
    set(sid, sess, fn) { fn && fn(null); }
    destroy(sid, fn)   { fn && fn(null); }
    touch(sid, s, fn)  { fn && fn(null); }
  };
});

// express-session mock → každý požadavek má přihlášeného ADMINA obalovny 'holubice'.
jest.mock('express-session', () => () => (req, res, next) => {
  req.session = {
    userId: 1, username: 'admin', role: 'admin', obalovnaId: 'holubice',
    save: (cb) => cb && cb(), destroy: (cb) => cb && cb(),
  };
  req.sessionID = 'test-sid';
  next();
});

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn(async () => ({ messageId: 'mock-id' })) })),
}));

const request = require('supertest');
const { app } = require('../server');

// Mutační endpointy s číselným id v SQL. (Vynechán DELETE /api/users/:id se self-guard
// pro id=1 — testujeme cizí id; a /password potřebuje validní heslo v body.)
describe('Validace číselného id — nečíselné → 400 (ne 500/crash)', () => {
  const NEPLATNE = ['abc', '1.5', 'NaN', '0', '-3', '%20', 'null'];

  test.each(NEPLATNE)('DELETE /api/users/%s → 400 Neplatné ID', async (bad) => {
    const r = await request(app).delete(`/api/users/${bad}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Neplatné ID');
  });

  test('PUT /api/users/abc/role → 400 (nedojde do SQL)', async () => {
    const r = await request(app).put('/api/users/abc/role').send({ role: 'operator' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Neplatné ID');
  });

  test('PUT /api/users/abc/orders-allowed → 400', async () => {
    const r = await request(app).put('/api/users/abc/orders-allowed').send({ orders_allowed: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Neplatné ID');
  });

  test('DELETE /api/sessions/user/xyz → 400', async () => {
    const r = await request(app).delete('/api/sessions/user/xyz');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Neplatné ID');
  });
});

describe('Validace číselného id — validní id projde stávající logikou (žádný crash)', () => {
  test('DELETE /api/users/5 → 404 (validní id, žádný odpovídající uživatel; NE 400/500)', async () => {
    const r = await request(app).delete('/api/users/5');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Uživatel nenalezen');
  });

  test('PUT /api/users/5/role → 404 (projde validací i scopingem, mock DB nevrátí řádek)', async () => {
    const r = await request(app).put('/api/users/5/role').send({ role: 'operator' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Uživatel nenalezen');
  });
});
