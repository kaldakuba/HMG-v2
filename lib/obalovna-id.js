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

// ── Krok 3/6: settings PER-OBALOVNA (nová tabulka obalovna_settings) ───────────
// PROČ nová tabulka místo ALTER `settings`: globální `settings` zůstane netknutá
// (drží INSTALAČNÍ klíče smtp_* a stav zálohy last_backup* = globální), takže žádná
// PK-chirurgie ani relabel. Per-obalovna konfigurace (hmg_*, orders_enabled,
// vazenky_share_enabled, share_*) žije zde, klíčovaná (obalovna_id, key).
//
// ČISTĚ ADITIVNÍ + IDEMPOTENTNÍ (běží proti PRODUKČNÍ DB!):
//   - CREATE TABLE IF NOT EXISTS obalovna_settings (PK (obalovna_id,key), FK → obalovny(id)).
//   - SEED 'holubice' ze stávajících globálních hodnot v `settings` (config klíče + share_*),
//     ON CONFLICT DO NOTHING → Holubice čte identické hodnoty jako dnes.
//   - `settings` se NEMĚNÍ, NIC se nemaže ani nepřepisuje. last_backup*/smtp_* tam zůstávají.
//
// last_backup* ZÁMĚRNĚ NEpřesouváme (sendBackup je zatím globální → přesun až krok 4).
const OBALOVNA_SETTING_KEYS = [
  'hmg_plant_rate', 'hmg_gas_capacity', 'hmg_max_daily', 'hmg_min_daily',
  'orders_enabled', 'vazenky_share_enabled',
];
async function migrateObalovnaSettings(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS obalovna_settings (
      obalovna_id TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      PRIMARY KEY (obalovna_id, key)
    )
  `);
  // FK na obalovny(id) — idempotentně (duplicitu spolkne DO blok).
  await pool.query(`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE obalovna_settings ADD CONSTRAINT obalovna_settings_obalovna_id_fkey
          FOREIGN KEY (obalovna_id) REFERENCES obalovny(id);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END $$;
  `);
  // SEED Holubice ze stávajících globálních hodnot. Aditivní (ON CONFLICT DO NOTHING).
  // Krok 4: přidány i last_backup* (per-obalovna stav zálohy) — zkopírují se z globálních
  // settings pro Holubici; ostatní obalovny začínají bez stavu (čistě).
  await pool.query(
    `INSERT INTO obalovna_settings (obalovna_id, key, value)
     SELECT 'holubice', key, value FROM settings
      WHERE key = ANY($1::text[])
         OR key LIKE 'share_%'
         OR key IN ('last_backup','last_backup_attempt','last_backup_error')
     ON CONFLICT (obalovna_id, key) DO NOTHING`,
    [OBALOVNA_SETTING_KEYS]
  );
}

// ── week_data: složený PK (week_start, obalovna_id) ────────────────────────────
// Dřív měl week_data PRIMARY KEY (week_start) = GLOBÁLNÍ → dvě obalovny nemohly mít
// stejný týden (kolize PK) a zápis jedné obalovny mohl přepsat řádek druhé. Sloupec
// obalovna_id existuje (migrateObalovnaId), tady ho jen přidáme do PK.
//
// IDEMPOTENTNÍ: pokud PK už obalovna_id obsahuje, no-op. Běží PO migrateObalovnaId
// (obalovna_id je NOT NULL — nutné pro PK). Aditivní: data se NEMĚNÍ.
async function migrateWeekDataCompositePk(pool) {
  const r = await pool.query(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='week_data'::regclass AND contype='p'"
  );
  const def = r.rows[0] ? r.rows[0].def : '';
  if (/obalovna_id/.test(def)) return;   // PK už je složený → nic nedělat
  await pool.query('ALTER TABLE week_data DROP CONSTRAINT IF EXISTS week_data_pkey');
  await pool.query('ALTER TABLE week_data ADD PRIMARY KEY (week_start, obalovna_id)');
}

module.exports = {
  migrateObalovnaId, migrateSingleRowConfigUnique, migrateObalovnaSettings,
  migrateWeekDataCompositePk,
  TABLES, INDEX_TABLES, SINGLE_ROW_CONFIG, OBALOVNA_SETTING_KEYS,
};
