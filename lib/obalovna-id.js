// Multi-obalovna — krok 2: přidání sloupce `obalovna_id` do stávajících datových tabulek.
// ČISTĚ ADITIVNÍ a IDEMPOTENTNÍ (běží proti PRODUKČNÍ DB!):
//   - ALTER TABLE ... ADD COLUMN IF NOT EXISTS obalovna_id TEXT NOT NULL DEFAULT 'holubice'
//     → Postgres existující řádky automaticky naplní 'holubice'.
//   - UPDATE ... WHERE obalovna_id IS NULL (pojistka; s NOT NULL DEFAULT je to no-op).
//   - FK obalovna_id → obalovny(id) (idempotentně přes DO blok; obalovny už existuje
//     díky migrateObalovny, které běží dřív v initDb).
//   - index na obalovna_id u velkých/rostoucích tabulek (kvůli budoucímu filtrování).
//
// V TOMTO KROKU SE PODLE obalovna_id NEFILTRUJE — žádný endpoint/builder se nemění,
// appka vrací přesně totéž. Jde jen o přípravu dat.
//
// NEZAŘAZENO (záměrně):
//   - settings: globální key/value store (PK=key), není per-obalovna → NEPŘIDÁNO.
//   - inputs:   není v zadaném seznamu tabulek → NEPŘIDÁNO (kandidát na další krok,
//               strukturně shodné s month_entries).
//   - session/obalovny: technická / samotný číselník → NEPŘIDÁVAT.

// Datové tabulky obalovny, do kterých sloupec patří (jen reálně existující).
const TABLES = ['week_data', 'vazenky', 'users', 'companies', 'month_entries', 'orders'];

// Velké / rostoucí tabulky → index na obalovna_id (budoucí filtrování).
const INDEX_TABLES = ['week_data', 'vazenky', 'orders'];

async function migrateObalovnaId(pool) {
  for (const t of TABLES) {
    // 1) Sloupec — idempotentně, existující řádky dostanou DEFAULT 'holubice'.
    await pool.query(
      `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS obalovna_id TEXT NOT NULL DEFAULT 'holubice'`
    );
    // 2) Pojistka proti NULL (idempotentní, prakticky no-op kvůli NOT NULL DEFAULT).
    await pool.query(
      `UPDATE ${t} SET obalovna_id='holubice' WHERE obalovna_id IS NULL`
    );
    // 3) FK na obalovny(id) — idempotentně (duplicitu spolkne DO blok).
    await pool.query(`
      DO $$
      BEGIN
        BEGIN
          ALTER TABLE ${t} ADD CONSTRAINT ${t}_obalovna_id_fkey
            FOREIGN KEY (obalovna_id) REFERENCES obalovny(id);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
      END $$;
    `);
  }

  // 4) Indexy na velkých tabulkách.
  for (const t of INDEX_TABLES) {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_${t}_obalovna_id ON ${t}(obalovna_id)`
    );
  }
}

module.exports = { migrateObalovnaId, TABLES, INDEX_TABLES };
