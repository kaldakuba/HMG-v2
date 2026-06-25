// Audit / log událostí (superadmin panel, dávka D). ČISTĚ ADITIVNÍ — nová tabulka audit_log.
// SOUKROMÍ: ukládá jen KDO/KDY/CO (typ akce, aktér, cíl, krátký detail) — NIKDY hesla ani
// obsah dat obalovny (žádné tonáže, ceny, počty/tuny váženek).

const AUDIT_COLUMNS = 'id, ts, typ, akter, role, obalovna_id, cil, detail, ip, hostname';

// Idempotentní migrace tabulky + indexy (ts pro řazení, obalovna_id pro filtr).
async function migrateAudit(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          SERIAL PRIMARY KEY,
      ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
      typ         TEXT NOT NULL,
      akter       TEXT,
      role        TEXT,
      obalovna_id TEXT,
      cil         TEXT,
      detail      TEXT,
      ip          TEXT,
      hostname    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_obalovna ON audit_log(obalovna_id);
  `);
}

// Zápis události. ROBUSTNÍ: chyba auditu NESMÍ shodit hlavní akci → chyby polyká uvnitř.
// Volá se typicky bez await. e: {typ, akter, role, obalovna_id, cil, detail, ip, hostname}.
async function logAudit(pool, e) {
  try {
    e = e || {};
    await pool.query(
      `INSERT INTO audit_log (typ, akter, role, obalovna_id, cil, detail, ip, hostname)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.typ, e.akter || null, e.role || null, e.obalovna_id || null,
       e.cil || null, e.detail || null, e.ip || null, e.hostname || null]
    );
  } catch (err) {
    console.error('logAudit selhal (' + (e && e.typ) + '):', err.message);
  }
}

// Čtení posledních N záznamů (volitelně filtr typ / obalovna_id). Řazeno ts DESC.
async function listAudit(pool, opts = {}) {
  const where = [];
  const params = [];
  if (opts.typ)         { params.push(opts.typ);         where.push(`typ = $${params.length}`); }
  if (opts.obalovna_id) { params.push(opts.obalovna_id); where.push(`obalovna_id = $${params.length}`); }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // limit je celé číslo v rozsahu 1..500 → bezpečné interpolovat.
  const lim = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 500);
  const r = await pool.query(
    `SELECT ${AUDIT_COLUMNS} FROM audit_log ${whereSQL} ORDER BY ts DESC, id DESC LIMIT ${lim}`,
    params
  );
  return r.rows;
}

module.exports = { migrateAudit, logAudit, listAudit, AUDIT_COLUMNS };
