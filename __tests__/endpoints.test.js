'use strict';
/**
 * Tier 2 integrační testy — reálné HTTP endpointy se skutečnou testovací DB.
 *
 * Vyžaduje: .env.test s DATABASE_URL ukazujícím na IZOLOVANOU testovací DB.
 * Spuštění:  npm run test:tier2
 *
 * Co testy dělají:
 *   - Volají initDb() → vytvoří tabulky v testovací DB (idempotentně)
 *   - Vloží testovacího admina (tier2_test_admin) s known heslem
 *   - Testují HTTP odpovědi přes supertest (žádné mocky)
 *   - Po testech smažou testovacího admina a uzavřou pool
 */

const request = require('supertest');
const bcrypt  = require('bcrypt');

// setup-tier2.js již načetl .env.test — server se připojí na testovací DB
const { app, pool, initDb } = require('../server');

// ── Testovací přihlašovací údaje ─────────────────────────────────────────────
const TEST_ADMIN = {
  username: 'tier2_test_admin',
  password: 'Tier2TestPass!123',
};

// supertest agent udržuje session cookies mezi požadavky
let agent;

// ── Příprava testovací DB ─────────────────────────────────────────────────────
beforeAll(async () => {
  // Vytvoř tabulky (CREATE TABLE IF NOT EXISTS — bezpečné opakování)
  await initDb();

  // Vlož nebo aktualizuj testovacího admina
  const hash = await bcrypt.hash(TEST_ADMIN.password, 10);
  await pool.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`,
    [TEST_ADMIN.username, hash]
  );

  // Přihlásí se a uloží session cookie do agenta
  agent = request.agent(app);
  const loginRes = await agent
    .post('/api/login')
    .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });

  if (loginRes.status !== 200) {
    throw new Error(`[beforeAll] Login testovacího admina selhal: ${loginRes.status} — ${JSON.stringify(loginRes.body)}`);
  }
}, 30000 /* 30 s timeout — čeká na DB připojení */);

afterAll(async () => {
  // Vyčistíme testovacího uživatele a zavřeme DB pool
  await pool.query('DELETE FROM users WHERE username = $1', [TEST_ADMIN.username]);
  await pool.end();
}, 15000);

// ═══════════════════════════════════════════════════════════════════════════════
describe('Tier 2 — HTTP endpoint testy (reálná testovací DB)', () => {

  // ── /api/version (bez auth) ─────────────────────────────────────────────────
  test('GET /api/version → 200 s polem version', async () => {
    const res = await request(app).get('/api/version');

    console.log('\n  GET /api/version →', res.status, res.body);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version');
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
    console.log('  version =', res.body.version, '✓');
  });

  // ── /api/login — správné přihlašovací údaje ─────────────────────────────────
  test('POST /api/login se správnými údaji → 200 + ok:true + session cookie', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });

    console.log('\n  POST /api/login (správné) →', res.status, res.body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Session cookie musí být přítomna
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(Array.isArray(cookies) ? cookies.length : 0).toBeGreaterThan(0);
    console.log('  session cookie nastaven ✓');
  });

  // ── /api/login — špatné heslo ───────────────────────────────────────────────
  test('POST /api/login se špatnými údaji → 401', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: TEST_ADMIN.username, password: 'naprosto-spatne-heslo' });

    console.log('\n  POST /api/login (špatné) →', res.status, res.body);
    expect(res.status).toBe(401);
    console.log('  401 ✓');
  });

  // ── /api/settings — bez přihlášení ─────────────────────────────────────────
  test('GET /api/settings bez přihlášení → 401', async () => {
    const res = await request(app).get('/api/settings');

    console.log('\n  GET /api/settings (bez auth) →', res.status);
    expect(res.status).toBe(401);
    console.log('  401 ✓');
  });

  // ── /api/settings — jako admin ──────────────────────────────────────────────
  test('GET /api/settings jako admin → 200, žádný smtp_ klíč v odpovědi', async () => {
    const res = await agent.get('/api/settings');

    console.log('\n  GET /api/settings (admin) →', res.status);
    console.log('  Klíče v odpovědi:', Object.keys(res.body).join(', ') || '(prázdné)');

    expect(res.status).toBe(200);
    // Žádný smtp_ klíč nesmí uniknout přes /api/settings
    const smtpKeys = Object.keys(res.body).filter(k => k.startsWith('smtp_'));
    expect(smtpKeys).toHaveLength(0);
    console.log('  Žádný smtp_ klíč ✓');
  });

  // ── /api/restore — bez přihlášení ───────────────────────────────────────────
  test('POST /api/restore bez přihlášení → 401', async () => {
    const res = await request(app)
      .post('/api/restore')
      .send({ snapshotJson: '{}', password: 'anything' });

    console.log('\n  POST /api/restore (bez auth) →', res.status);
    expect(res.status).toBe(401);
    console.log('  401 ✓');
  });
});
