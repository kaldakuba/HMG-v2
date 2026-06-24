// Organizační struktura TAXIS — číselník obaloven (multi-obalovna).
// ČISTĚ ADITIVNÍ modul: zakládá NOVOU tabulku `obalovny` a poskytuje čtení.
// NESAHÁ na žádnou stávající tabulku, dotaz ani funkci. Stávající instalace
// Holubice musí fungovat beze změny — tento modul jen přidává nová data.
//
// id           = technický klíč obalovny (např. 'holubice', 'rancirov', 'demo')
// nazev        = zobrazovaný název (např. 'Obalovna Holubice')
// subdomena    = subdoména pro routování (UNIQUE)
// stav         = 'aktivni' nebo 'demo'
// mod_*        = přepínače modulů (harmonogram je vždy základ)

// SELECT sloupce držíme explicitně (stabilní pořadí a tvar odpovědi API).
const OBALOVNA_COLUMNS = `
  id, nazev, subdomena, stav,
  mod_harmonogram, mod_vazenky, mod_objednavky, mod_hod_objednavky,
  created_at
`;

// Migrace — idempotentní (CREATE TABLE IF NOT EXISTS + INSERT ON CONFLICT DO NOTHING).
// Bezpečné opakované spuštění při každém startu serveru (jako ostatní tabulky v initDb).
async function migrateObalovny(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS obalovny (
      id                 TEXT PRIMARY KEY,
      nazev              TEXT NOT NULL,
      subdomena          TEXT UNIQUE,
      stav               TEXT NOT NULL DEFAULT 'aktivni'
                           CHECK (stav IN ('aktivni','demo')),
      mod_harmonogram    BOOLEAN NOT NULL DEFAULT true,
      mod_vazenky        BOOLEAN NOT NULL DEFAULT false,
      mod_objednavky     BOOLEAN NOT NULL DEFAULT false,
      mod_hod_objednavky BOOLEAN NOT NULL DEFAULT false,
      created_at         TIMESTAMPTZ DEFAULT now()
    );
  `);

  // První obalovna — Holubice. Dnes reálně používá harmonogram + váženky + objednávky;
  // hodinové objednávky zatím ne. Idempotentně: při existujícím id se nic nepřepisuje.
  await pool.query(`
    INSERT INTO obalovny
      (id, nazev, subdomena, stav,
       mod_harmonogram, mod_vazenky, mod_objednavky, mod_hod_objednavky)
    VALUES
      ('holubice', 'Obalovna Holubice', 'holubice', 'aktivni',
       true, true, true, false)
    ON CONFLICT (id) DO NOTHING;
  `);
}

// Čtení seznamu obaloven (řazeno podle id). Vrací pole řádků.
async function listObalovny(pool) {
  const r = await pool.query(`SELECT ${OBALOVNA_COLUMNS} FROM obalovny ORDER BY id`);
  return r.rows;
}

module.exports = { migrateObalovny, listObalovny, OBALOVNA_COLUMNS };
