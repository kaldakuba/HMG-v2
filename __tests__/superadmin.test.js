'use strict';
/**
 * Tier 1 — role superadmin (multi-obalovna, krok 4). Bez reálné DB.
 * Mockuje pg (Pool se nepřipojuje) a testuje čisté funkce ze serveru:
 *   - getObalovnaId: superadmin → null (žádná konkrétní obalovna → datové dotazy prázdné)
 *   - requireSuperadmin: pustí jen superadmina, jinak 403 (API) / redirect /login (HTML)
 */
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ query: jest.fn(), connect: jest.fn(), on: jest.fn(), end: jest.fn() })),
  types: { setTypeParser: jest.fn() },
}));

jest.mock('connect-pg-simple', () => () => {
  const { EventEmitter } = require('events');
  return class MockPgStore extends EventEmitter {
    constructor() { super(); }
    get(sid, fn)       { fn && fn(null, null); }
    set(sid, sess, fn) { fn && fn(null); }
    destroy(sid, fn)   { fn && fn(null); }
    touch(sid, s, fn)  { fn && fn(null); }
  };
});

const { getObalovnaId, requireSuperadmin, isLastSuperadmin } = require('../server');

describe('Tier 1 — multi-obalovna: superadmin', () => {
  describe('getObalovnaId', () => {
    test('superadmin → null (nevidí data žádné obalovny jako uživatel)', () => {
      expect(getObalovnaId({ session: { role: 'superadmin', obalovnaId: 'holubice' } })).toBeNull();
    });
    test('běžná role vrací svou obalovnu', () => {
      expect(getObalovnaId({ session: { role: 'admin', obalovnaId: 'holubice' } })).toBe('holubice');
      expect(getObalovnaId({ session: { role: 'hmg_share', obalovnaId: 'rancirov' } })).toBe('rancirov');
    });
    test('chybějící obalovna_id → default holubice', () => {
      expect(getObalovnaId({ session: { role: 'operator' } })).toBe('holubice');
      expect(getObalovnaId({})).toBe('holubice');
    });
  });

  describe('requireSuperadmin', () => {
    function mockRes() {
      return {
        statusCode: null, body: null, redirected: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
        redirect(u) { this.redirected = u; return this; },
      };
    }
    test('superadmin → next()', () => {
      const res = mockRes(); let called = false;
      requireSuperadmin({ session: { role: 'superadmin' }, path: '/api/obalovny' }, res, () => { called = true; });
      expect(called).toBe(true);
      expect(res.statusCode).toBeNull();
    });
    test('běžný admin na /api/ → 403 (nově nevidí /api/obalovny)', () => {
      const res = mockRes(); let called = false;
      requireSuperadmin({ session: { role: 'admin' }, path: '/api/obalovny' }, res, () => { called = true; });
      expect(called).toBe(false);
      expect(res.statusCode).toBe(403);
    });
    test('nepřihlášený na HTML cestě → redirect /login', () => {
      const res = mockRes(); let called = false;
      requireSuperadmin({ session: {}, path: '/superadmin' }, res, () => { called = true; });
      expect(called).toBe(false);
      expect(res.redirected).toBe('/login');
    });
  });

  describe('isLastSuperadmin (pojistka: poslední nejde smazat)', () => {
    test('0 nebo 1 superadmin → poslední (nelze smazat)', () => {
      expect(isLastSuperadmin(1)).toBe(true);
      expect(isLastSuperadmin(0)).toBe(true);
    });
    test('2 a více → smazat lze', () => {
      expect(isLastSuperadmin(2)).toBe(false);
      expect(isLastSuperadmin(5)).toBe(false);
    });
  });
});
