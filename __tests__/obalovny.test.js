'use strict';
/**
 * Tier 1 — jednotkový test modulu lib/obalovny.js (bez reálné DB).
 * Mockuje pool.query a ověřuje:
 *   - migrace je idempotentní (CREATE TABLE IF NOT EXISTS + INSERT ON CONFLICT DO NOTHING)
 *   - INSERT zakládá Holubici se správnými moduly
 *   - listObalovny vrací řádky z DB
 */

const { migrateObalovny, listObalovny } = require('../lib/obalovny');

function makeMockPool() {
  const calls = [];
  const pool = {
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT[\s\S]*FROM obalovny/i.test(sql)) {
        return {
          rows: [{
            id: 'holubice', nazev: 'Obalovna Holubice', subdomena: 'holubice', stav: 'aktivni',
            mod_harmonogram: true, mod_vazenky: true, mod_objednavky: true, mod_hod_objednavky: false,
            created_at: new Date('2026-06-24T00:00:00Z'),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return { pool, calls };
}

describe('Tier 1 — lib/obalovny', () => {
  test('migrateObalovny: CREATE TABLE je idempotentní a zakládá tabulku obalovny', async () => {
    const { pool, calls } = makeMockPool();
    await migrateObalovny(pool);

    const createSql = calls.map(c => c.sql).find(s => /CREATE TABLE/i.test(s));
    expect(createSql).toBeDefined();
    expect(createSql).toMatch(/CREATE TABLE IF NOT EXISTS obalovny/i);
    // Klíčové sloupce dle specifikace
    expect(createSql).toMatch(/id\s+TEXT PRIMARY KEY/i);
    expect(createSql).toMatch(/subdomena\s+TEXT UNIQUE/i);
    expect(createSql).toMatch(/stav\s+TEXT NOT NULL DEFAULT 'aktivni'/i);
    expect(createSql).toMatch(/mod_harmonogram\s+BOOLEAN NOT NULL DEFAULT true/i);
    expect(createSql).toMatch(/mod_hod_objednavky\s+BOOLEAN NOT NULL DEFAULT false/i);
  });

  test('migrateObalovny: INSERT Holubice je idempotentní (ON CONFLICT DO NOTHING) se správnými moduly', async () => {
    const { pool, calls } = makeMockPool();
    await migrateObalovny(pool);

    const insertSql = calls.map(c => c.sql).find(s => /INSERT INTO obalovny/i.test(s));
    expect(insertSql).toBeDefined();
    expect(insertSql).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
    expect(insertSql).toMatch(/'holubice'/);
    expect(insertSql).toMatch(/'Obalovna Holubice'/);
    // harmonogram + váženky + objednávky = true, hodinové objednávky = false
    expect(insertSql).toMatch(/true,\s*true,\s*true,\s*false/i);
  });

  test('listObalovny: vrací řádek holubice se správnými moduly', async () => {
    const { pool } = makeMockPool();
    const rows = await listObalovny(pool);

    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'holubice',
      nazev: 'Obalovna Holubice',
      subdomena: 'holubice',
      stav: 'aktivni',
      mod_harmonogram: true,
      mod_vazenky: true,
      mod_objednavky: true,
      mod_hod_objednavky: false,
    });
  });
});
