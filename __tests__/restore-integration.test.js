'use strict';
/**
 * Integrační test obnovy ze snímku — testuje SKUTEČNOU restoreFromSnapshot()
 * Volá přesně tu funkci, kterou volá POST /api/restore.
 * Mocky: pg (DB + transakce), nodemailer. Žádná izolace builderů.
 */

process.env.PORT               = '0';
process.env.GMAIL_USER         = 'test@gmail.com';
process.env.GMAIL_APP_PASSWORD = 'test-password';
process.env.BACKUP_EMAIL       = 'backup@test.com';

// ── Data "aktuální" DB před obnovou (prefixováno MOCK_ — požadavek Jest) ──────
const MOCK_PRE_INPUTS_JSON    = JSON.stringify([{ cislo:'1', smes:'STARA' }]);
const MOCK_PRE_COMPANIES_JSON = JSON.stringify([{ name:'StaraFirma', color:'#aaa' }]);
const MOCK_PRE_SETTINGS = [
  { key:'orders_enabled', value:'true'  },
  { key:'smtp_password',  value:'tajne' }, // NESMÍ být přepsán (snímek má '')
];
const MOCK_PRE_USERS = [
  { id:1, username:'admin', password_hash:'$2b$12$STARY_HASH', role:'admin',
    email:'admin@hmg.cz', firma:null, must_change_password:false,
    created_at:new Date('2026-01-01'), last_seen:null },
];

// ── Zachytávání dotazů z transakce (pool.connect() klient) ──────────────────
// Tyto proměnné jsou v closures mockClient.query — nejsou přímo v jest.mock() factory
const clientQueries = [];
let committed  = false;
let rolledBack = false;

const mockClient = {
  query: jest.fn(async (sql, params) => {
    clientQueries.push({ sql: (sql || '').trim(), params: params || [] });
    if (/COMMIT/i.test(sql))   committed  = true;
    if (/ROLLBACK/i.test(sql)) rolledBack = true;
    if (/setval/i.test(sql))   return { rows:[{ setval:5 }] };
    return { rows:[], rowCount:0 };
  }),
  release: jest.fn(),
};

// ── pg mock: pool.query pro pre-restore zálohu + pool.connect pro transakci ──
// Proměnné přímo v jest.mock() factory musí mít prefix mock (case-insensitive)
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(async (sql) => {
      if (/FROM week_data/i.test(sql))     return { rows:[], rowCount:0 };
      if (/FROM inputs/i.test(sql))        return { rows:[{ rows_json:MOCK_PRE_INPUTS_JSON }], rowCount:1 };
      if (/FROM companies/i.test(sql))     return { rows:[{ data_json:MOCK_PRE_COMPANIES_JSON }], rowCount:1 };
      if (/FROM settings/i.test(sql))      return { rows:MOCK_PRE_SETTINGS, rowCount:MOCK_PRE_SETTINGS.length };
      if (/FROM orders/i.test(sql))        return { rows:[], rowCount:0 };
      if (/FROM users/i.test(sql))         return { rows:MOCK_PRE_USERS, rowCount:MOCK_PRE_USERS.length };
      if (/FROM month_entries/i.test(sql)) return { rows:[], rowCount:0 };
      return { rows:[], rowCount:0 };
    }),
    connect: jest.fn().mockResolvedValue(mockClient),
    on:  jest.fn(),
    end: jest.fn(),
  })),
  types: { setTypeParser: jest.fn() },
}));

jest.mock('connect-pg-simple', () => () => {
  const { EventEmitter } = require('events');
  return class MockPgStore extends EventEmitter {
    constructor() { super(); }
    get(sid, fn)       { fn && fn(null, null); }
    set(sid, sess, fn) { fn && fn(null); }
    destroy(sid, fn)   { fn && fn(null); }
    touch(sid, s, fn)  { fn && fn(null); }
  };
});

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn(async () => ({ messageId:'mock-id' })),
  })),
}));

// ── Snímek pro obnovu ─────────────────────────────────────────────────────────
const SNAPSHOT = {
  version: 3,
  created: '2026-06-05T12:00:00.000Z',
  week_data: [
    { week_start:'2026-06-02',
      rows_json: JSON.stringify([{ cislo:'1', lokalita:'Praha', smes:'AC 11 S', d0:120 }]) },
  ],
  inputs:        [{ cislo:'1', smes:'AC 11 S', zt:'ITT-XY' }],
  companies:     [{ name:'Colas', color:'#fff2a8' }],
  settings: {
    orders_enabled: 'true',
    smtp_password:  '',        // prázdné → NESMÍ přepsat stávající
    last_backup:    '2026-06-05T12:00:00.000Z',
  },
  month_entries: { '2026-06-03': [{ smes:'AC 11 S', tuny:120 }] },
  users: [
    { id:1, username:'admin',
      password_hash:'$2b$12$RESTORED_HASH_ADMIN',
      role:'admin', email:'admin@hmg.cz', firma:null,
      must_change_password:false,
      created_at:'2026-01-01T00:00:00.000Z', last_seen:null },
    { id:2, username:'colas_disp',
      password_hash:'$2b$12$RESTORED_HASH_SHARE',
      role:'hmg_share', email:'disp@colas.cz', firma:'Colas',
      must_change_password:false,
      created_at:'2026-01-15T00:00:00.000Z', last_seen:null },
  ],
  orders: [
    { id:1, order_group_id:'uuid-1', user_id:2, firma:'Colas', datum:'2026-06-03',
      smes:'AC 11 S', itt:'ITT-XY', tuny:120, komentar:null,
      status:'approved', created_at:'2026-06-01T10:00:00.000Z',
      resolved_at:'2026-06-02T08:00:00.000Z', reject_reason:null, lokalita:'Praha' },
    { id:2, order_group_id:'uuid-2', user_id:1, firma:'HMG', datum:'2026-06-10',
      smes:'SMA 11 S', itt:'ITT-AB', tuny:300, komentar:'TEST',
      status:'pending', created_at:'2026-06-05T09:00:00.000Z',
      resolved_at:null, reject_reason:null, lokalita:'Brno' },
  ],
};

const { restoreFromSnapshot } = require('../server');

// ═══════════════════════════════════════════════════════════════════════════════
describe('restoreFromSnapshot — integrační test skutečné funkce', () => {
  beforeEach(() => {
    clientQueries.length = 0;
    committed  = false;
    rolledBack = false;
    mockClient.query.mockClear();
    mockClient.release.mockClear();
  });

  // ── Test 1: summary ──────────────────────────────────────────────────────────
  test('vrátí správný souhrn (summary) pro testovací snímek', async () => {
    const result = await restoreFromSnapshot(SNAPSHOT);

    console.log('\n════════════════════════════════════════════');
    console.log('DŮKAZ — restoreFromSnapshot() výstup:');
    console.log('  preBackup:', result.preBackup);
    console.log('  summary:  ', JSON.stringify(result.summary));

    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('preBackup');
    expect(result.preBackup).toMatch(/^pre-restore-/);
    expect(result.summary.users).toBe(2);
    expect(result.summary.orders).toBe(2);
    expect(result.summary.week_data).toBe(1);
    console.log('  users=2 ✓, orders=2 ✓, week_data=1 ✓');
  });

  // ── Test 2: transakce ────────────────────────────────────────────────────────
  test('transakce je COMMITována, nikoli ROLLBACKována, klient uvolněn', async () => {
    await restoreFromSnapshot(SNAPSHOT);

    console.log('\n  COMMIT:', committed, '  ROLLBACK:', rolledBack);
    console.log('  Dotazů v transakci:', clientQueries.length);

    expect(committed).toBe(true);
    expect(rolledBack).toBe(false);
    expect(mockClient.release).toHaveBeenCalled();
    console.log('  COMMIT ✓, žádný ROLLBACK ✓, client.release() ✓');
  });

  // ── Test 3: password_hash ────────────────────────────────────────────────────
  test('INSERT INTO users obsahuje password_hash ze snímku (oba uživatelé)', async () => {
    await restoreFromSnapshot(SNAPSHOT);

    const userInserts = clientQueries.filter(q => /INSERT INTO users/i.test(q.sql));
    console.log('\n  INSERT INTO users — počet:', userInserts.length);
    userInserts.forEach((q, i) => {
      console.log(`  User ${i+1}: id=${q.params[0]}, username=${q.params[1]}, hash=${String(q.params[2]).slice(0,30)}...`);
    });

    expect(userInserts).toHaveLength(2);
    expect(userInserts[0].params[2]).toBe('$2b$12$RESTORED_HASH_ADMIN');
    expect(userInserts[1].params[2]).toBe('$2b$12$RESTORED_HASH_SHARE');
    console.log('  password_hash[0] = RESTORED_HASH_ADMIN ✓');
    console.log('  password_hash[1] = RESTORED_HASH_SHARE ✓');
  });

  // ── Test 4: smtp_password přeskočen ─────────────────────────────────────────
  test('smtp_password="" ve snímku se NEVLOŽÍ do settings', async () => {
    await restoreFromSnapshot(SNAPSHOT);

    const smtpInserts = clientQueries.filter(q =>
      /INSERT INTO settings/i.test(q.sql) && q.params[0] === 'smtp_password'
    );
    const otherSettings = clientQueries.filter(q =>
      /INSERT INTO settings/i.test(q.sql) && q.params[0] !== 'smtp_password'
    );
    console.log('\n  INSERT smtp_password:', smtpInserts.length, 'krát (má být 0)');
    console.log('  Ostatní settings vloženo:', otherSettings.length, 'klíčů');

    expect(smtpInserts).toHaveLength(0);
    expect(otherSettings.length).toBeGreaterThan(0);
    console.log('  smtp_password přeskočen ✓, ostatní settings vloženy ✓');
  });

  // ── Test 5: FK pořadí DELETE ─────────────────────────────────────────────────
  test('DELETE FROM orders proběhne PŘED DELETE FROM users (FK pořadí)', async () => {
    await restoreFromSnapshot(SNAPSHOT);

    const sqls = clientQueries.map(q => q.sql);
    const idxOrders = sqls.findIndex(s => /DELETE FROM orders/i.test(s));
    const idxUsers  = sqls.findIndex(s => /DELETE FROM users/i.test(s));
    console.log('\n  DELETE FROM orders na pozici:', idxOrders);
    console.log('  DELETE FROM users  na pozici:', idxUsers);

    expect(idxOrders).toBeGreaterThanOrEqual(0);
    expect(idxUsers).toBeGreaterThanOrEqual(0);
    expect(idxOrders).toBeLessThan(idxUsers);
    console.log('  FK pořadí DELETE správné ✓');
  });

  // ── Test 6: validace ─────────────────────────────────────────────────────────
  test('odmítne snímek s chybějícím klíčem (bez provedení obnovy)', async () => {
    const bad = { ...SNAPSHOT };
    delete bad.orders;

    await expect(restoreFromSnapshot(bad)).rejects.toThrow('chybí klíč "orders"');
    expect(committed).toBe(false);
    console.log('\n  Validace správně odmítla neplatný snímek ✓');
    console.log('  Transakce nespuštěna ✓');
  });
});
