'use strict';
/**
 * Regresní testy (4.3):
 *  NÁLEZ 1 — operátor nemá export harmonogramu: GET /api/month/export → 403 pro operatora,
 *            200 pro admina i hmg_share.
 *  NÁLEZ 2 — neexistující obalovna → 404 (místo 200) na superadmin metriky/obsazení;
 *            existující obalovna → 200.
 *
 * Mocky: pg, connect-pg-simple, express-session (role per test přes globalThis.__TESTROLE),
 * nodemailer. Žádná reálná DB.
 */

process.env.PORT           = '0';
process.env.SESSION_SECRET = 'test-secret';
process.env.GMAIL_USER     = 'test@gmail.com';
process.env.BACKUP_EMAIL   = 'backup@test.com';

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(async (sql, params) => {
      sql = String(sql);
      // Existence obalovny (NÁLEZ 2): jen 'holubice' existuje.
      if (/SELECT 1 FROM obalovny WHERE id=\$1/.test(sql)) {
        const ok = params && params[0] === 'holubice';
        return { rows: ok ? [{ ok: 1 }] : [], rowCount: ok ? 1 : 0 };
      }
      // getObalovnaModuly
      if (/mod_harmonogram/.test(sql)) {
        return { rows: [{ mod_harmonogram: true, mod_vazenky: true, mod_objednavky: true, mod_hod_objednavky: false }], rowCount: 1 };
      }
      // metriky — hlavní agregace
      if (/AS tydny/.test(sql)) {
        return { rows: [{ tydny: 0, wd_last: null, vz_upload: null, vz_datum: null }], rowCount: 1 };
      }
      if (/FROM obalovna_settings/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM orders/.test(sql))            return { rows: [{ n: 0 }], rowCount: 1 };
      if (/FROM users/.test(sql))             return { rows: [], rowCount: 0 };
      if (/FROM week_data/.test(sql))         return { rows: [], rowCount: 0 };
      if (/FROM companies/.test(sql))         return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }),
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

// Role se nastavuje per test přes globalThis.__TESTROLE.
jest.mock('express-session', () => () => (req, res, next) => {
  req.session = {
    userId: 1, username: 'tester',
    role: globalThis.__TESTROLE || 'admin',
    obalovnaId: 'holubice',
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

function asRole(role) { globalThis.__TESTROLE = role; }
afterEach(() => { delete globalThis.__TESTROLE; });

describe('NÁLEZ 1 — export harmonogramu: operátor 403, admin/hmg_share OK', () => {
  test('operator → 403 na GET /api/month/export', async () => {
    asRole('operator');
    const r = await request(app).get('/api/month/export?year=2026');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Nemáte oprávnění');
  });

  test('admin → 200 (export proběhne)', async () => {
    asRole('admin');
    const r = await request(app).get('/api/month/export?year=2026');
    expect(r.status).toBe(200);
  });

  test('hmg_share → 200 (export ponechán)', async () => {
    asRole('hmg_share');
    const r = await request(app).get('/api/month/export?year=2026');
    expect(r.status).toBe(200);
  });

  test('operator → 403 i na GET /api/export (týdenní)', async () => {
    asRole('operator');
    const r = await request(app).get('/api/export');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Nemáte oprávnění');
  });
});

describe('NÁLEZ 2 — superadmin metriky/obsazení: neexistující obalovna 404, existující 200', () => {
  test('metriky neexistující obalovny → 404', async () => {
    asRole('superadmin');
    const r = await request(app).get('/api/superadmin/obalovny/neexistuje/metriky');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Obalovna nenalezena');
  });

  test('obsazení neexistující obalovny → 404', async () => {
    asRole('superadmin');
    const r = await request(app).get('/api/superadmin/obalovny/neexistuje/obsazeni');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Obalovna nenalezena');
  });

  test('metriky EXISTUJÍCÍ obalovny → 200 (beze změny)', async () => {
    asRole('superadmin');
    const r = await request(app).get('/api/superadmin/obalovny/holubice/metriky');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('tydny');
  });

  test('obsazení EXISTUJÍCÍ obalovny → 200 (beze změny)', async () => {
    asRole('superadmin');
    const r = await request(app).get('/api/superadmin/obalovny/holubice/obsazeni');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('obalovna_id', 'holubice');
  });
});
