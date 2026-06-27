'use strict';
/**
 * Tier 1 — jednotkový test modulu lib/obalovna-id.js (bez reálné DB).
 * Mockuje pool.query a ověřuje, že migrace je aditivní + idempotentní:
 *   - ADD COLUMN IF NOT EXISTS obalovna_id TEXT NOT NULL DEFAULT 'holubice' pro každou tabulku
 *   - UPDATE ... WHERE obalovna_id IS NULL (pojistka)
 *   - FK na obalovny(id) přes idempotentní DO blok
 *   - index na velkých tabulkách
 *   - NEsahá na settings / inputs / session
 */

const { migrateObalovnaId, migrateSingleRowConfigUnique, TABLES, INDEX_TABLES, SINGLE_ROW_CONFIG } = require('../lib/obalovna-id');

function makeMockPool() {
  const sqls = [];
  const pool = { query: jest.fn(async (sql) => { sqls.push(sql); return { rows: [], rowCount: 0 }; }) };
  return { pool, sqls };
}

describe('Tier 1 — lib/obalovna-id', () => {
  test('očekávané a vynechané tabulky', () => {
    expect(TABLES).toEqual(['week_data', 'vazenky', 'users', 'companies', 'month_entries', 'inputs', 'orders']);
    // settings (globální) a session (technická) NEjsou zahrnuty
    expect(TABLES).not.toContain('settings');
    expect(TABLES).not.toContain('session');
    expect(INDEX_TABLES).toEqual(['week_data', 'vazenky', 'orders']);
  });

  test('pro každou tabulku: idempotentní ADD COLUMN + UPDATE pojistka + FK', async () => {
    const { pool, sqls } = makeMockPool();
    await migrateObalovnaId(pool);

    for (const t of TABLES) {
      const addCol = sqls.find(s =>
        new RegExp(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS obalovna_id TEXT NOT NULL DEFAULT 'holubice'`, 'i').test(s));
      expect(addCol).toBeDefined();

      const upd = sqls.find(s =>
        new RegExp(`UPDATE ${t} SET obalovna_id='holubice' WHERE obalovna_id IS NULL`, 'i').test(s));
      expect(upd).toBeDefined();

      const fk = sqls.find(s =>
        new RegExp(`ALTER TABLE ${t} ADD CONSTRAINT ${t}_obalovna_id_fkey[\\s\\S]*REFERENCES obalovny\\(id\\)`, 'i').test(s)
        && /DO \$\$/i.test(s));
      expect(fk).toBeDefined();
    }
  });

  test('indexy jen na velkých tabulkách', async () => {
    const { pool, sqls } = makeMockPool();
    await migrateObalovnaId(pool);

    for (const t of INDEX_TABLES) {
      const idx = sqls.find(s =>
        new RegExp(`CREATE INDEX IF NOT EXISTS idx_${t}_obalovna_id ON ${t}\\(obalovna_id\\)`, 'i').test(s));
      expect(idx).toBeDefined();
    }
    // users/companies/month_entries index nemají
    expect(sqls.some(s => /idx_users_obalovna_id/i.test(s))).toBe(false);
    expect(sqls.some(s => /idx_companies_obalovna_id/i.test(s))).toBe(false);
  });

  test('žádný DROP / RENAME / změna typu stávajících sloupců', async () => {
    const { pool, sqls } = makeMockPool();
    await migrateObalovnaId(pool);
    const joined = sqls.join('\n');
    expect(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i.test(joined)).toBe(false);
    expect(/RENAME/i.test(joined)).toBe(false);
    expect(/ALTER COLUMN/i.test(joined)).toBe(false);
    expect(/DELETE\s+FROM/i.test(joined)).toBe(false);
    expect(/TRUNCATE/i.test(joined)).toBe(false);
  });

  test('migrateSingleRowConfigUnique: UNIQUE INDEX IF NOT EXISTS na obalovna_id (companies/inputs/month_entries)', async () => {
    expect(SINGLE_ROW_CONFIG).toEqual(['companies', 'inputs', 'month_entries']);
    const { pool, sqls } = makeMockPool();
    await migrateSingleRowConfigUnique(pool);
    for (const t of SINGLE_ROW_CONFIG) {
      const idx = sqls.find(s =>
        new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS uq_${t}_obalovna_id ON ${t}\\(obalovna_id\\)`, 'i').test(s));
      expect(idx).toBeDefined();
    }
    // čistě aditivní — žádný DROP/DELETE
    const joined = sqls.join('\n');
    expect(/DROP|DELETE|TRUNCATE|RENAME/i.test(joined)).toBe(false);
  });
});
