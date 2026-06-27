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
//   - session/obalovny: technická / samotný číselník → NEPŘIDÁVAT.
// (inputs doplněno v3.77 — strukturně shodné s month_entries, drží data obalovny.)

// Datové tabulky obalovny, do kterých sloupec patří (jen reálně existující).
const TABLES = ['week_data', 'vazenky', 'users', 'companies', 'month_entries', 'inputs', 'orders'];

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

// ── Krok 3b: single-row konfigurační tabulky PER-OBALOVNA ──────────────────────
// Tyto tabulky dřív držely jeden řádek a klíčovaly se natvrdo přes id=1. Teď je řádek
// jednoznačně identifikován přes obalovna_id → UNIQUE(obalovna_id) umožní upsert podle
// obalovna_id (ON CONFLICT) a brání tomu, aby cizí obalovna přepsala řádek Holubice.
// Pojistka: pokud by tabulka měla >1 řádek na obalovnu, CREATE UNIQUE INDEX selže (hlasitě)
// — proto se před nasazením ověřuje, že je max 1 řádek/obalovnu (dnes ano: jen 'holubice').
const SINGLE_ROW_CONFIG = ['companies', 'inputs', 'month_entries'];
async function migrateSingleRowConfigUnique(pool) {
  for (const t of SINGLE_ROW_CONFIG) {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_${t}_obalovna_id ON ${t}(obalovna_id)`
    );
  }
}

module.exports = { migrateObalovnaId, migrateSingleRowConfigUnique, TABLES, INDEX_TABLES, SINGLE_ROW_CONFIG };
