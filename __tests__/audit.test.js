'use strict';
/**
 * Tier 1 — lib/audit.js (bez reálné DB, mock pool).
 *   - migrateAudit: idempotentní CREATE TABLE IF NOT EXISTS audit_log + indexy
 *   - logAudit: INSERT s parametry; chyba DB nepropadne (polyká se)
 *   - listAudit: filtr typ/obalovna_id + LIMIT v rozsahu
 */
const { migrateAudit, logAudit, listAudit } = require('../lib/audit');

function mockPool() {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; }),
  };
}

describe('Tier 1 — lib/audit', () => {
  test('migrateAudit: CREATE TABLE IF NOT EXISTS audit_log + indexy', async () => {
    const p = mockPool();
    await migrateAudit(p);
    const sql = p.calls[0].sql;
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS audit_log/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_audit_ts/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_audit_obalovna/i);
  });

  test('logAudit: INSERT s očekávanými sloupci a parametry', async () => {
    const p = mockPool();
    await logAudit(p, { typ: 'login_ok', akter: 'admin', role: 'admin', obalovna_id: 'holubice', ip: '1.2.3.4' });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].sql).toMatch(/INSERT INTO audit_log/i);
    expect(p.calls[0].params[0]).toBe('login_ok');
    expect(p.calls[0].params[1]).toBe('admin');
    // nevyplněné položky jsou null, ne undefined
    expect(p.calls[0].params).toHaveLength(8);
    expect(p.calls[0].params[4]).toBeNull(); // cil
  });

  test('logAudit: chyba DB se nepropaguje (audit nesmí shodit akci)', async () => {
    const p = { query: jest.fn(async () => { throw new Error('DB down'); }) };
    await expect(logAudit(p, { typ: 'login_fail', akter: 'x' })).resolves.toBeUndefined();
  });

  test('listAudit: bez filtru = bez WHERE, s filtry = WHERE typ/obalovna_id', async () => {
    const p1 = mockPool();
    await listAudit(p1, {});
    expect(p1.calls[0].sql).not.toMatch(/WHERE/i);
    expect(p1.calls[0].params).toEqual([]);

    const p2 = mockPool();
    await listAudit(p2, { typ: 'login_ok', obalovna_id: 'holubice' });
    expect(p2.calls[0].sql).toMatch(/WHERE typ = \$1 AND obalovna_id = \$2/i);
    expect(p2.calls[0].params).toEqual(['login_ok', 'holubice']);
  });

  test('listAudit: limit je celé číslo v rozsahu 1..500', async () => {
    const p = mockPool();
    await listAudit(p, { limit: 99999 });
    expect(p.calls[0].sql).toMatch(/LIMIT 500/);
    const p2 = mockPool();
    await listAudit(p2, {});
    expect(p2.calls[0].sql).toMatch(/LIMIT 100/);
  });
});
