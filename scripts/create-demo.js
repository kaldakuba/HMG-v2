'use strict';
/**
 * Seed DEMO obaloven (multi-obalovna). Založí 3 demo obalovny s účty a číselníkem firem.
 *
 *  ┌─ BEZPEČNOST ─────────────────────────────────────────────────────────────┐
 *  │ .env míří na PRODUKČNÍ DB. Skript je STRIKTNĚ cílený jen na demo obalovny  │
 *  │ ('demo-colas','demo-miroads','demo-firesta'). VŠECHNY DELETE/UPDATE mají   │
 *  │ WHERE obalovna_id = ANY(DEMO_IDS) a před každým destruktivním během běží    │
 *  │ tvrdá pojistka assertDemoOnly(), která odmítne cokoli mimo demo-* (zejména │
 *  │ 'holubice'). Skript se NIKDY nedotkne obalovny 'holubice'.                  │
 *  └───────────────────────────────────────────────────────────────────────────┘
 *
 * Režimy:
 *   node scripts/create-demo.js            → vytvoří/doplní (idempotentní, nepřepisuje)
 *   node scripts/create-demo.js --reset    → smaže POUZE provozní DATA demo (week_data,
 *                                            vazenky, orders); obalovny/účty/firmy ponechá
 *   node scripts/create-demo.js --remove   → ÚPLNĚ smaže demo obalovny vč. účtů, firem, dat
 *                                            (jen řádky s obalovna_id IN demo-*) + samotné obalovny
 *
 * POZN.: username = heslo je VĚDOMÉ DEMO rozhodnutí (snadné přihlášení do dema). Do ostrých
 *        účtů se to NIKDY nepoužívá — ostré účty zakládá admin/superadmin s vlastním heslem.
 */
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

// ── Definice 3 demo obaloven ─────────────────────────────────────────────────
const DEMO = [
  { id: 'demo-colas',   nazev: 'DEMO – Colas',    subdomena: 'demo-colas',   prefix: 'colas'   },
  { id: 'demo-miroads', nazev: 'DEMO – Mi Roads', subdomena: 'demo-miroads', prefix: 'miroads' },
  { id: 'demo-firesta', nazev: 'DEMO – Firesta',  subdomena: 'demo-firesta', prefix: 'firesta' },
];
const DEMO_IDS = DEMO.map(d => d.id);   // ['demo-colas','demo-miroads','demo-firesta']

// Číselník firem (stejný pro každé demo). Ostatní firmy NEPŘIDÁVAT — doplní admin.
const COMPANIES = [
  { name: 'Colas',    color: '#fff2a8' },
  { name: 'Mi Roads', color: '#ffbdbf' },
  { name: 'Firesta',  color: '#d9ead3' },
];

// Demo účty pro jednu obalovnu. username = heslo (DEMO ONLY). share účty mají orders_allowed.
function demoUsers(prefix) {
  return [
    { username: `${prefix}-admin`,     role: 'admin' },
    { username: `${prefix}-operator1`, role: 'operator' },
    { username: `${prefix}-operator2`, role: 'operator' },
    { username: `${prefix}-share1`,    role: 'hmg_share', firma: 'Colas',    orders_allowed: true },
    { username: `${prefix}-share2`,    role: 'hmg_share', firma: 'Mi Roads', orders_allowed: true },
  ];
}

// ── TVRDÁ POJISTKA ───────────────────────────────────────────────────────────
// Ověří, že cílový seznam obsahuje VÝHRADNĚ demo-* obalovny z DEMO_IDS. Cokoli jiného
// (zejména 'holubice') → vyhodí chybu a destruktivní operace se NEPROVEDE.
function assertDemoOnly(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('POJISTKA: prázdný/neplatný cílový seznam obaloven.');
  }
  for (const id of ids) {
    if (id === 'holubice' || !/^demo-/.test(String(id)) || !DEMO_IDS.includes(id)) {
      throw new Error(`POJISTKA: cílový seznam obsahuje NEPOVOLENOU obalovnu '${id}'. Povoleno jen: ${DEMO_IDS.join(', ')}`);
    }
  }
  return true;
}

// ── REŽIM: create (idempotentní) ─────────────────────────────────────────────
async function createDemo(pool) {
  for (const d of DEMO) {
    // 1) Obalovna (stav=demo; moduly: harmonogram+vazenky+objednavky=true, hodinové=FALSE).
    await pool.query(
      `INSERT INTO obalovny (id, nazev, subdomena, stav,
         mod_harmonogram, mod_vazenky, mod_objednavky, mod_hod_objednavky)
       VALUES ($1, $2, $3, 'demo', true, true, true, false)
       ON CONFLICT (id) DO NOTHING`,
      [d.id, d.nazev, d.subdomena]
    );

    // 2) Číselník firem. companies je single-row tabulka s PK id (holubice drží id=1),
    //    takže demu přidělíme volné id; idempotence přes NOT EXISTS dle obalovna_id.
    await pool.query(
      `INSERT INTO companies (id, data_json, obalovna_id)
       SELECT (SELECT COALESCE(MAX(id),0)+1 FROM companies), $1, $2
       WHERE NOT EXISTS (SELECT 1 FROM companies WHERE obalovna_id = $2)`,
      [JSON.stringify(COMPANIES), d.id]
    );

    // 3) Demo účty (username = heslo, jen DEMO). Idempotentně přes UNIQUE(username).
    for (const u of demoUsers(d.prefix)) {
      const hash = await bcrypt.hash(u.username, 10);   // heslo = username (DEMO ONLY)
      await pool.query(
        `INSERT INTO users (username, password_hash, role, firma, obalovna_id, orders_allowed, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, false)
         ON CONFLICT (username) DO NOTHING`,
        [u.username, hash, u.role, u.firma || null, d.id, u.orders_allowed === true]
      );
    }
    console.log(`✓ demo '${d.id}': obalovna + firmy + ${demoUsers(d.prefix).length} účtů (heslo = username)`);
  }
  // 4) ŽÁDNÁ provozní data (week_data/vazenky zůstávají prázdné) — demo je holé.
  console.log('Hotovo (create). Účty: <prefix>-admin/-operator1/-operator2/-share1/-share2, prefix = colas|miroads|firesta.');
}

// ── REŽIM: reset (smaže jen PROVOZNÍ DATA dema; obalovny/účty/firmy ponechá) ──
async function resetDemo(pool) {
  assertDemoOnly(DEMO_IDS);
  for (const t of ['orders', 'week_data', 'vazenky']) {
    const r = await pool.query(`DELETE FROM ${t} WHERE obalovna_id = ANY($1::text[])`, [DEMO_IDS]);
    console.log(`reset: smazáno ${r.rowCount} řádků z ${t} (demo)`);
  }
  console.log('Hotovo (reset). Obalovny, účty i firmy ZŮSTALY; smazána jen provozní data.');
}

// ── REŽIM: remove (úplné smazání demo obaloven) ──────────────────────────────
async function removeDemo(pool) {
  assertDemoOnly(DEMO_IDS);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Sessions demo uživatelů (session nemá obalovna_id → přes jejich userId).
    await client.query(
      `DELETE FROM session WHERE sess->>'userId' IN (
         SELECT id::text FROM users WHERE obalovna_id = ANY($1::text[]) AND role <> 'superadmin')`,
      [DEMO_IDS]
    );
    // Child řádky (FK obalovna_id → obalovny) PŘED smazáním samotných obaloven.
    for (const t of ['orders', 'week_data', 'vazenky', 'inputs', 'month_entries', 'companies']) {
      await client.query(`DELETE FROM ${t} WHERE obalovna_id = ANY($1::text[])`, [DEMO_IDS]);
    }
    // Účty dema (extra pojistka: NIKDY superadmina).
    await client.query(`DELETE FROM users WHERE obalovna_id = ANY($1::text[]) AND role <> 'superadmin'`, [DEMO_IDS]);
    // Nakonec samotné obalovny.
    await client.query(`DELETE FROM obalovny WHERE id = ANY($1::text[])`, [DEMO_IDS]);
    await client.query('COMMIT');
    console.log('Hotovo (remove). Demo obalovny, účty, firmy a jejich data smazány. (audit_log se nemaže.)');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Spuštění (jen při přímém běhu; require pro testy NEspouští DB) ────────────
async function main() {
  require('dotenv').config();
  if (!process.env.DATABASE_URL) {
    console.error('CHYBA: chybí DATABASE_URL (.env).');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const mode = process.argv.includes('--remove') ? 'remove'
             : process.argv.includes('--reset')  ? 'reset'
             : 'create';
  console.log(`[create-demo] režim: ${mode}; cílové obalovny: ${DEMO_IDS.join(', ')}`);
  try {
    if (mode === 'remove')      await removeDemo(pool);
    else if (mode === 'reset')  await resetDemo(pool);
    else                        await createDemo(pool);
  } catch (err) {
    console.error('CHYBA:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = { DEMO, DEMO_IDS, COMPANIES, demoUsers, assertDemoOnly, createDemo, resetDemo, removeDemo };
