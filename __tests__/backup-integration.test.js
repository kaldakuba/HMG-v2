'use strict';
/**
 * Integrační test zálohy — testuje SKUTEČNÝ sendBackup()
 * Volá přesně tu funkci, kterou volá POST /api/backup/run.
 * Mocky: pg (DB), nodemailer (email). Žádná izolace builderu.
 */

process.env.PORT            = '0';
process.env.GMAIL_USER      = 'test@gmail.com';
process.env.GMAIL_APP_PASSWORD = 'test-password';
process.env.BACKUP_EMAIL    = 'backup@test.com';

// ── Ukázková data pro mock DB ─────────────────────────────────────────────────
const MOCK_ORDERS = [
  { id:1, order_group_id:'uuid-1', user_id:2, firma:'Colas', datum:'2026-06-03',
    smes:'AC 11 S', itt:'ITT-XY', tuny:120, komentar:null,
    status:'approved', created_at:new Date('2026-06-01T10:00:00Z'),
    resolved_at:new Date('2026-06-02T08:00:00Z'), reject_reason:null, lokalita:'Praha' },
  { id:2, order_group_id:'uuid-2', user_id:3, firma:'Firesta', datum:'2026-06-10',
    smes:'SMA 11 S', itt:'ITT-AB', tuny:300, komentar:'ASAP',
    status:'rejected', created_at:new Date('2026-06-05T09:00:00Z'),
    resolved_at:new Date('2026-06-05T11:00:00Z'), reject_reason:'Nedostatečná kapacita', lokalita:'Brno' },
];
const MOCK_USERS = [
  { id:1, username:'admin', password_hash:'$2b$12$testhash_admin', role:'admin', email:'admin@hmg.cz', firma:null,
    must_change_password:false, created_at:new Date('2026-01-01'), last_seen:new Date() },
  { id:2, username:'colas_disp', password_hash:'$2b$12$testhash_share', role:'hmg_share', email:'disp@colas.cz', firma:'Colas',
    must_change_password:false, created_at:new Date('2026-01-15'), last_seen:new Date() },
];
const MOCK_WEEKS = [
  { week_start:'2026-06-02', rows_json: JSON.stringify([
    { cislo:'1', lokalita:'Praha', objednavka:'OBJ-001', smes:'AC 11 S', itt:'ITT-XY',
      ceta:'Colas', d0:120, d1:'', d2:80, d3:'', d4:'', d5:'', d6:'' }
  ])},
];
const MOCK_INPUTS_JSON = JSON.stringify([
  { cislo:'1', smes:'AC 11 S', zt:'ITT-XY', c04:0.35, c24:0.20, c48:0.15,
    c811:'', c1116:'', c1622:'', b5070:'', b255560:'', b458065:'', b2030:'',
    prach:0.05, vapenec:0.02, addbit:'', scel:'', ra16:'', ra22:'', celkem:100 }
]);
const MOCK_COMPANIES_JSON = JSON.stringify([{ name:'Colas', color:'#fff2a8' }]);
const MOCK_SETTINGS = [
  { key:'orders_enabled', value:'true' },
  { key:'smtp_password', value:'tajne-heslo' },
  { key:'last_backup', value:'2026-06-01T00:00:00.000Z' },
];
const MOCK_MONTH_JSON = JSON.stringify({ '2026-06-03': [{ smes:'AC 11 S', tuny:120 }] });

// ── pg mock s reálnými daty ────────────────────────────────────────────────────
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(async (sql) => {
      if (/FROM week_data/i.test(sql))       return { rows: MOCK_WEEKS,    rowCount: MOCK_WEEKS.length };
      if (/FROM inputs/i.test(sql))          return { rows: [{ rows_json: MOCK_INPUTS_JSON }], rowCount: 1 };
      if (/FROM companies/i.test(sql))       return { rows: [{ data_json: MOCK_COMPANIES_JSON }], rowCount: 1 };
      if (/FROM settings/i.test(sql) && !/INSERT/i.test(sql)) return { rows: MOCK_SETTINGS, rowCount: MOCK_SETTINGS.length };
      if (/FROM orders/i.test(sql))          return { rows: MOCK_ORDERS,   rowCount: MOCK_ORDERS.length };
      if (/FROM users/i.test(sql))           return { rows: MOCK_USERS,    rowCount: MOCK_USERS.length };
      if (/FROM month_entries/i.test(sql))   return { rows: [{ data_json: MOCK_MONTH_JSON }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    connect: jest.fn().mockResolvedValue({
      query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: jest.fn(),
    }),
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

// ── nodemailer mock — zachytí sendMail argumenty ─────────────────────────────
const capturedMails = [];
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn(async (opts) => {
      capturedMails.push(opts);
      return { messageId: 'mock-id' };
    }),
  })),
}));

// ── Načteme server (volá startServer → initDb → vše mockováno) ────────────────
const { sendBackup } = require('../server');

// ── Pomocné: přečíst listy z Excel bufferu ────────────────────────────────────
async function getSheetNames(buffer) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets.map(ws => ws.name);
}

// ═══════════════════════════════════════════════════════════════════════════════
describe('sendBackup — integrační test skutečné funkce', () => {
  beforeEach(() => { capturedMails.length = 0; });

  test('odešle e-mail se DVĚMA přílohami (Excel + JSON)', async () => {
    await sendBackup();

    expect(capturedMails).toHaveLength(1);
    const mail = capturedMails[0];
    expect(mail.attachments).toHaveLength(2);

    const xlsxAtt = mail.attachments[0];
    const jsonAtt = mail.attachments[1];

    expect(xlsxAtt.filename).toMatch(/\.xlsx$/);
    expect(jsonAtt.filename).toMatch(/\.json$/);

    console.log('\n════════════════════════════════════════════');
    console.log('DŮKAZ — skutečný sendBackup() výstup:');
    console.log('  E-mail from:', mail.from);
    console.log('  E-mail to:',  mail.to);
    console.log('  Subject:',    mail.subject);
    console.log('  Počet příloh:', mail.attachments.length);
    console.log('  Příloha 1 (Excel):', xlsxAtt.filename, '— velikost:', xlsxAtt.content.length, 'bytů');
    console.log('  Příloha 2 (JSON):', jsonAtt.filename,  '— velikost:', jsonAtt.content.length, 'bytů');
  });

  test('Excel obsahuje listy: týden, Receptury, Objednávky, Uživatelé', async () => {
    await sendBackup();

    const mail    = capturedMails[0];
    const xlsxBuf = mail.attachments[0].content;
    const sheets  = await getSheetNames(xlsxBuf);

    console.log('\n  Excel listy:', sheets.join(', '));
    expect(sheets).toContain('Receptury');
    expect(sheets).toContain('Objednávky');
    expect(sheets).toContain('Uživatelé');
    expect(sheets.some(s => /^\d{4}-\d{2}-\d{2}$/.test(s))).toBe(true);
    console.log('  "Receptury"  ✓');
    console.log('  "Objednávky" ✓');
    console.log('  "Uživatelé"  ✓');
    console.log('  Týdenní list ✓');
  });

  test('JSON snímek obsahuje klíče orders a users (smtp_password prázdné)', async () => {
    await sendBackup();

    const mail     = capturedMails[0];
    const jsonBuf  = mail.attachments[1].content;
    const snapshot = JSON.parse(jsonBuf.toString('utf8'));

    console.log('\n  JSON top-level klíče:', Object.keys(snapshot).join(', '));
    console.log('  snapshot.orders.length:', snapshot.orders.length);
    console.log('  snapshot.users.length:', snapshot.users.length);
    console.log('  smtp_password:', JSON.stringify(snapshot.settings.smtp_password));

    expect(snapshot).toHaveProperty('orders');
    expect(snapshot).toHaveProperty('users');
    expect(snapshot).toHaveProperty('week_data');
    expect(snapshot).toHaveProperty('settings');
    expect(snapshot.orders.length).toBeGreaterThan(0);
    expect(snapshot.users.length).toBeGreaterThan(0);
    expect(snapshot.settings.smtp_password).toBe('');
    console.log('  orders ✓, users ✓, smtp_password redakován ✓');
  });
});
