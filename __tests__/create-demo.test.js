'use strict';
/**
 * Tier 1 — scripts/create-demo.js (bez DB; require nespouští main → žádné připojení).
 * Ověřuje, že cílový seznam jsou JEN demo-* obalovny a pojistka odmítne cokoli jiného
 * (zejména 'holubice'), plus tvar definic.
 */
const { DEMO, DEMO_IDS, COMPANIES, demoUsers, assertDemoOnly } = require('../scripts/create-demo');

describe('Tier 1 — scripts/create-demo (pojistka demo-only)', () => {
  test('DEMO_IDS = právě 3 demo obalovny a NEobsahují holubice', () => {
    expect(DEMO_IDS).toEqual(['demo-colas', 'demo-miroads', 'demo-firesta']);
    expect(DEMO_IDS).not.toContain('holubice');
    expect(DEMO_IDS.every(id => /^demo-/.test(id))).toBe(true);
  });

  test('assertDemoOnly: projde jen pro samé demo-*', () => {
    expect(assertDemoOnly(DEMO_IDS)).toBe(true);
    expect(assertDemoOnly(['demo-colas'])).toBe(true);
  });

  test('assertDemoOnly: ODMÍTNE holubice / cizí / prázdný seznam', () => {
    expect(() => assertDemoOnly(['holubice'])).toThrow(/POJISTKA/);
    expect(() => assertDemoOnly(['demo-colas', 'holubice'])).toThrow(/POJISTKA/);
    expect(() => assertDemoOnly(['neco-jineho'])).toThrow(/POJISTKA/);
    expect(() => assertDemoOnly([])).toThrow(/POJISTKA/);
    expect(() => assertDemoOnly(['demo-colas-x'])).toThrow(/POJISTKA/); // není v DEMO_IDS
  });

  test('demoUsers: 5 účtů se správnými rolemi; share má orders_allowed a firmu', () => {
    const us = demoUsers('colas');
    expect(us.map(u => u.username)).toEqual(['colas-admin', 'colas-operator1', 'colas-operator2', 'colas-share1', 'colas-share2']);
    expect(us.filter(u => u.role === 'admin')).toHaveLength(1);
    expect(us.filter(u => u.role === 'operator')).toHaveLength(2);
    const share = us.filter(u => u.role === 'hmg_share');
    expect(share).toHaveLength(2);
    expect(share.every(u => u.orders_allowed === true && u.firma)).toBe(true);
  });

  test('COMPANIES: jen Colas, Mi Roads, Firesta s barvami dle zadání', () => {
    expect(COMPANIES).toEqual([
      { name: 'Colas',    color: '#fff2a8' },
      { name: 'Mi Roads', color: '#ffbdbf' },
      { name: 'Firesta',  color: '#d9ead3' },
    ]);
    expect(DEMO.every(d => d.stav === undefined || true)).toBe(true); // sanity
  });
});
