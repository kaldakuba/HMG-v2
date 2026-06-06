// Copyright (c) 2026 Jakub Kalousek. All rights reserved. Proprietary and confidential.
require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

// ── Verze aplikace (jeden zdroj pravdy — zvednout ručně při každém vydání) ──
const APP_VERSION = '3.11';

const app = express();
app.set('trust proxy', 1);

// ── Rate limiting na login (5 pokusů / 5 minut) ──
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    res.status(429).json({ error: 'Příliš mnoho pokusů. Zkuste to za 5 minut.' });
  }
});
const PORT = process.env.PORT || 3000;

// ── Fix: node-postgres vrací DATE sloupce jako plain string (ne JS Date s timezone posunem) ──
const { types } = require('pg');
types.setTypeParser(1082, val => val); // OID 1082 = DATE

// ── PostgreSQL pool ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

// ── Helper: logování chyb s časovým razítkem (konzola + soubor) ─────────────
// Volá se vždy s popisem a chybou; zápis do souboru je best-effort (nikdy nepadne).
const LOG_DIR  = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'error.log');
function logError(label, errOrMsg) {
  const ts  = new Date().toISOString();
  const detail = errOrMsg instanceof Error
    ? (errOrMsg.stack || errOrMsg.message)
    : String(errOrMsg);
  const line = `[${ts}] ${label}\n${detail}`;
  console.error(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n---\n');
  } catch (_) { /* zápis do souboru selhal – konzola stačí */ }
}

// ── Ošetření chyb DB poolu ZA CHODU ──────────────────────────────────────────
// Bez tohoto handleru by neočekávaná chyba idle klienta (výpadek / restart DB
// na Railway) vyhodila uncaughtException a zabila Node.js proces.
pool.on('error', err => {
  logError('POOL ERROR – neočekávaná chyba idle klienta (DB výpadek/restart)', err);
  // Neukončujeme; pg.Pool se pokusí obnovit spojení při dalším dotazu.
});

// ── Globální zachytávání neošetřených chyb ───────────────────────────────────
// Zajišťuje, že ŽÁDNÁ chyba neprojde bez záznamu a neshodí server potichu.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError('UNHANDLED REJECTION', err);
  // Neukončujeme – chyba je zalogována, server pokračuje.
});
process.on('uncaughtException', (err) => {
  logError('UNCAUGHT EXCEPTION', err);
  // Neukončujeme – logujeme a pokračujeme. Railway restartuje kontejner
  // na základě health-checku, pokud se stane něco vážného.
});

// ── Validace ──
function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // Připojíme T00:00:00Z → přísné UTC parsování ISO 8601.
  // Poté porovnáme UTC složky zpět se vstupem: pokud datum "přeteklo"
  // (např. 2026-02-30 → 2026-03-02), složky se budou lišit → odmítneme.
  // Přístup záměrně používá UTC, aby se zamezilo timezone posunu (stejná
  // filosofie jako types.setTypeParser a 'T00:00:00Z' jinde v projektu).
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  const [y, m, day] = s.split('-').map(Number);
  return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m && d.getUTCDate() === day;
}
function isIntOrEmpty(v) {
  if (v === '' || v === null || v === undefined) return true;
  return Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 99999;
}
function sanitizeStr(v, maxLen=255) {
  if (v === null || v === undefined) return '';
  return String(v).slice(0, maxLen).replace(/[<>]/g, '');
}
function validateRows(rows) {
  if (!Array.isArray(rows)) return 'rows musí být pole';
  for (const r of rows) {
    if (typeof r !== 'object' || r === null) return 'každý řádek musí být objekt';
    for (let i = 0; i <= 6; i++) {
      if (!isIntOrEmpty(r[`d${i}`])) return `d${i} musí být celé číslo 0-99999`;
    }
  }
  return null;
}

// ── Inicializace tabulek ──
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS week_data (
      week_start TEXT PRIMARY KEY,
      rows_json  TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS inputs (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      rows_json  TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS companies (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      data_json  TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS month_entries (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      data_json  TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'operator',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      last_seen     TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS session (
      sid    VARCHAR NOT NULL COLLATE "default",
      sess   JSON NOT NULL,
      expire TIMESTAMPTZ NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
    );
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);

    -- HMG V3
    ALTER TABLE users ADD COLUMN IF NOT EXISTS firma TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    CREATE TABLE IF NOT EXISTS orders (
      id              SERIAL PRIMARY KEY,
      order_group_id  UUID NOT NULL,
      user_id         INTEGER REFERENCES users(id),
      firma           TEXT NOT NULL,
      datum           DATE NOT NULL,
      smes            TEXT NOT NULL,
      itt             TEXT NOT NULL,
      tuny            INTEGER NOT NULL,
      komentar        TEXT,
      status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      resolved_at     TIMESTAMPTZ,
      resolved_by     INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_orders_group_id ON orders(order_group_id);
    CREATE INDEX IF NOT EXISTS idx_orders_datum    ON orders(datum);
    CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS reject_reason TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS lokalita TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;

    -- HMG V4 — vynucená změna hesla při prvním přihlášení
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

    -- Migrace: rozšíření CHECK constraintu statusů (pre_approved, pre_rejected)
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE orders DROP CONSTRAINT orders_status_check;
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
      BEGIN
        ALTER TABLE orders ADD CONSTRAINT orders_status_check
          CHECK (status IN ('pending','pre_approved','pre_rejected','approved','rejected'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END $$;
  `);

  // HMG V4 — výchozí hodnota přepínače objednávkového systému
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('orders_enabled', 'true') ON CONFLICT (key) DO NOTHING`
  );

  // HMG V4 — Admin účet z ADMIN_PASSWORD (bez výchozího hesla)
  // a) Admin existuje → NEDĚLEJ NIC (neměň heslo ani příznaky)
  // b) Admin neexistuje + ADMIN_PASSWORD nastaven → vytvoř s must_change_password=true
  // c) Admin neexistuje + ADMIN_PASSWORD NENÍ nastaven → varování, nevytvářej, server pokračuje
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const existing = await pool.query('SELECT id FROM users WHERE username = $1', [adminUser]);
  if (existing.rows.length === 0) {
    const adminPass = process.env.ADMIN_PASSWORD;
    if (adminPass) {
      const hash = await bcrypt.hash(adminPass, 12);
      await pool.query(
        'INSERT INTO users (username, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4)',
        [adminUser, hash, 'admin', true]
      );
      console.log(`Vytvořen admin účet: ${adminUser} (musí změnit heslo při prvním přihlášení)`);
    } else {
      console.warn('VAROVÁNÍ: ADMIN_PASSWORD není nastaveno v .env, admin účet nebyl vytvořen. Nastavte ADMIN_PASSWORD a restartujte server.');
    }
  }
}

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ── Sessions ──
if (!process.env.SESSION_SECRET) {
  console.error('CHYBA: Chybí SESSION_SECRET v .env. Server se nespustí bez nastaveného session secret.');
  process.exit(1);
}
app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dní
    httpOnly: true,
    sameSite: 'lax',
    // secure: true pouze pokud běží za HTTPS (produkce); lokálně false
    secure: process.env.NODE_ENV === 'production' || process.env.HTTPS === 'true'
  }
}));

// Statické soubory (CSS, JS, obrázky) - bez auth
// HTML soubory jsou chráněny přes explicitní routes níže
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,  // Nezobrazovat index.html automaticky
  extensions: [] // Nezkoušet přidat přípony
}));

// ── Auth middleware ──
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    // Pokud uživatel musí změnit heslo: povolíme jen nezbytné endpointy
    if (req.session.mustChangePassword) {
      const ALLOWED = ['/api/change-password', '/api/logout', '/api/me'];
      if (req.path.startsWith('/api/')) {
        if (!ALLOWED.includes(req.path)) {
          return res.status(403).json({ error: 'Musíte nejdříve změnit heslo', must_change_password: true });
        }
      } else {
        // HTML stránky → přesměruj na login (který zobrazí formulář změny hesla)
        return res.redirect('/login');
      }
    }
    return next();
  }
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Nepřihlášen' });
  }
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Nedostatečná oprávnění' });
  }
  res.redirect('/login');
}

// Operator + Admin mohou číst data
function requireOperator(req, res, next) {
  const role = req.session && req.session.role;
  if (role === 'admin' || role === 'operator') return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Nedostatečná oprávnění' });
  }
  res.redirect('/');
}

// Viewer může jen měsíční přehled
function requireViewer(req, res, next) {
  const role = req.session && req.session.role;
  if (role === 'admin' || role === 'operator' || role === 'hmg_share') return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Nedostatečná oprávnění' });
  }
  res.redirect('/login');
}

// Pojistka: objednávkové endpointy odmítají požadavky, když orders_enabled = false
async function requireOrdersEnabled(req, res, next) {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key='orders_enabled'");
    const enabled = r.rows.length === 0 || r.rows[0].value !== 'false';
    if (!enabled) return res.status(403).json({ error: 'Objednávkový systém je vypnut' });
    next();
  } catch(err) {
    next(); // při chybě DB pokračuj (fail-open)
  }
}

// ── Stránky ──
app.get('/login', (req, res) => {
  if (req.session && req.session.userId) {
    // Přihlášený, ale musí změnit heslo → zobraz login stránku s formulářem změny
    if (req.session.mustChangePassword) {
      if (!req.query.change) return res.redirect('/login?change=1');
    } else {
      return res.redirect('/');
    }
  }
  const csrfToken = crypto.randomBytes(24).toString('hex');
  res.cookie('csrf', csrfToken, { httpOnly: false, sameSite: 'lax' });
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', requireAuth, (req, res) => {
  // hmg_share vidí dashboard (má tam tlačítko do month-view)
  if (req.session.role === 'hmg_share') return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/month', requireAuth, requireViewer, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'month.html'));
});

app.get('/inputs', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'inputs.html'));
});

app.get('/month-view', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'month-view.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  if (req.session.role === 'operator') return res.redirect('/index.html');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Auth API ──
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Vyplňte jméno a heslo' });
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Nesprávné jméno nebo heslo' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Nesprávné jméno nebo heslo' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.userAgent = req.headers['user-agent'] || '';
    req.session.loginIp = req.ip || '';
    req.session.mustChangePassword = !!user.must_change_password;
    await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);
    if (user.must_change_password) {
      return res.json({ ok: true, must_change_password: true });
    }
    res.json({ ok: true, role: user.role });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// Vynucená změna hesla (must_change_password = true) — dostupná i při mustChangePassword session
app.post('/api/change-password', requireAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ error: 'Nové heslo musí mít alespoň 6 znaků' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE users SET password_hash=$1, must_change_password=false WHERE id=$2',
      [hash, req.session.userId]
    );
    req.session.mustChangePassword = false;
    console.log(`Uživatel ${req.session.username} si změnil heslo (vynucená změna)`);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/change-password error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT firma FROM users WHERE id=$1', [req.session.userId]);
    const firma = r.rows[0] ? r.rows[0].firma : null;
    res.json({
      username: req.session.username,
      role: req.session.role,
      userId: req.session.userId,
      firma,
      mustChangePassword: req.session.mustChangePassword || false
    });
  } catch(err) {
    res.json({ username: req.session.username, role: req.session.role, userId: req.session.userId, firma: null });
  }
});

// ── Data API (chráněno přihlášením) ──
app.get('/api/week/:start', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT rows_json FROM week_data WHERE week_start=$1', [req.params.start]);
  res.json(r.rows[0] ? JSON.parse(r.rows[0].rows_json) : null);
});

app.post('/api/week/:start', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = req.body;
  if (!isIsoDate(req.params.start)) return res.status(400).json({ error: 'Neplatný formát data týdne' });
  const rowErr = validateRows(rows);
  if (rowErr) return res.status(400).json({ error: rowErr });
  const safeRows = rows.map(r => ({
    ...r,
    cislo: sanitizeStr(r.cislo, 20),
    lokalita: sanitizeStr(r.lokalita, 100),
    objednavka: sanitizeStr(r.objednavka, 100),
    smes: sanitizeStr(r.smes, 200),
    itt: sanitizeStr(r.itt, 50),
    ceta: sanitizeStr(r.ceta, 50),
    lat: (r.lat != null && isFinite(+r.lat)) ? +r.lat : null,
    lng: (r.lng != null && isFinite(+r.lng)) ? +r.lng : null,
  }));
  await pool.query(
    `INSERT INTO week_data (week_start,rows_json,updated_at) VALUES($1,$2,NOW())
     ON CONFLICT(week_start) DO UPDATE SET rows_json=EXCLUDED.rows_json, updated_at=NOW()`,
    [req.params.start, JSON.stringify(safeRows)]
  );
  res.json({ ok: true });
});

app.get('/api/weeks', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT week_start,rows_json FROM week_data ORDER BY week_start');
  res.json(r.rows.map(r => ({ start: r.week_start, rows: JSON.parse(r.rows_json) })));
});

app.get('/api/month-entries', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT data_json FROM month_entries WHERE id=1');
  res.json(r.rows[0] ? JSON.parse(r.rows[0].data_json) : {});
});

app.post('/api/month-entries', requireAuth, requireAdmin, async (req, res) => {
  await pool.query(
    `INSERT INTO month_entries (id,data_json,updated_at) VALUES(1,$1,NOW())
     ON CONFLICT(id) DO UPDATE SET data_json=EXCLUDED.data_json, updated_at=NOW()`,
    [JSON.stringify(req.body)]
  );
  res.json({ ok: true });
});

app.get('/api/inputs', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT rows_json FROM inputs WHERE id=1');
  res.json(r.rows[0] ? JSON.parse(r.rows[0].rows_json) : null);
});

app.post('/api/inputs', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = req.body;
  await pool.query(
    `INSERT INTO inputs (id,rows_json,updated_at) VALUES(1,$1,NOW())
     ON CONFLICT(id) DO UPDATE SET rows_json=EXCLUDED.rows_json, updated_at=NOW()`,
    [JSON.stringify(rows)]
  );
  res.json({ ok: true });
});

app.get('/api/companies', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT data_json FROM companies WHERE id=1');
  res.json(r.rows[0] ? JSON.parse(r.rows[0].data_json) : null);
});

app.post('/api/companies', requireAuth, requireAdmin, async (req, res) => {
  const { companies } = req.body;
  if (!Array.isArray(companies) || companies.length > 20) return res.status(400).json({ error: 'companies musí být pole max 20 položek' });
  for (const c of companies) {
    if (!c.name || typeof c.name !== 'string') return res.status(400).json({ error: 'každá firma musí mít name' });
    if (c.color && !/^#[0-9a-fA-F]{3,6}$/.test(c.color)) return res.status(400).json({ error: 'neplatný formát barvy' });
  }
  await pool.query(
    `INSERT INTO companies (id,data_json,updated_at) VALUES(1,$1,NOW())
     ON CONFLICT(id) DO UPDATE SET data_json=EXCLUDED.data_json, updated_at=NOW()`,
    [JSON.stringify(companies)]
  );
  res.json({ ok: true });
});

app.get('/api/settings', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT key,value FROM settings');
  const obj = {};
  // Citlivé klíče (SMTP konfigurace vč. hesla) se nikdy nevracejí v obecném /api/settings.
  // Slouží jen pro admina přes /api/smtp-settings, která má requireAdmin a heslo maskuje.
  const SENSITIVE_PREFIXES = ['smtp_'];
  r.rows.forEach(row => {
    if (SENSITIVE_PREFIXES.some(p => row.key.startsWith(p))) return;
    obj[row.key] = row.value;
  });
  res.json(obj);
});

app.post('/api/settings', requireAuth, requireAdmin, async (req, res) => {
  const allowed = ['hmg_max_daily', 'hmg_min_daily', 'plant_rate', 'orders_enabled'];
  for (const [k, v] of Object.entries(req.body)) {
    if (!allowed.includes(k)) continue;
    if (['hmg_max_daily', 'hmg_min_daily', 'plant_rate'].includes(k)) {
      const n = parseInt(v, 10);
      if (isNaN(n) || n <= 0 || n > 1000000) return res.status(400).json({ error: `${k} musí být kladné číslo` });
    }
    if (k === 'orders_enabled') {
      if (v !== 'true' && v !== 'false') return res.status(400).json({ error: 'orders_enabled musí být true nebo false' });
    }
    await pool.query(
      `INSERT INTO settings (key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
      [k, String(v)]
    );
  }
  res.json({ ok: true });
});

app.get('/api/export', requireAuth, requireOperator, async (req, res) => {
  const r = await pool.query('SELECT week_start,rows_json FROM week_data ORDER BY week_start');
  res.json({
    version: 2, type: 'HMG_WEEK_DATA',
    created: new Date().toISOString(),
    weeks: r.rows.map(row => ({ start: row.week_start, rows: JSON.parse(row.rows_json) }))
  });
});

// ── Import z Excelu ──
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function xlsxDateToIso(serial) {
  const d = XLSX.SSF.parse_date_code(serial);
  if (!d) return null;
  return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
}

function fv(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'object') return '';
  const n = parseFloat(v);
  return isNaN(n) || n === 0 ? '' : Math.round(n * 10) / 10;
}

// ── Smazat data týdnů ──
// ── Smazat data týdnů (POST i DELETE) ──
app.all('/api/admin/clear-weeks', requireAuth, requireAdmin, async (req, res) => {
  try {
    const password = (req.body && req.body.password) || '';
    if (!password) return res.json({ ok: false, error: 'Heslo je povinné.' });
    const result = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.session.userId]);
    if (!result.rows[0]) return res.json({ ok: false, error: 'Uživatel nenalezen.' });
    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) return res.json({ ok: false, error: 'Nesprávné heslo.' });
    await pool.query('DELETE FROM week_data');
    await pool.query('DELETE FROM month_entries');
    console.log('Admin smazal data týdnů');
    res.json({ ok: true });
  } catch(err) {
    console.error('clear-weeks error:', err);
    res.json({ ok: false, error: 'Chyba serveru: ' + err.message });
  }
});

// ── Smazat receptury (POST i DELETE) ──
app.all('/api/admin/clear-inputs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const password = (req.body && req.body.password) || '';
    if (!password) return res.json({ ok: false, error: 'Heslo je povinné.' });
    const result = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.session.userId]);
    if (!result.rows[0]) return res.json({ ok: false, error: 'Uživatel nenalezen.' });
    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) return res.json({ ok: false, error: 'Nesprávné heslo.' });
    await pool.query('DELETE FROM inputs');
    console.log('Admin smazal receptury');
    res.json({ ok: true });
  } catch(err) {
    console.error('clear-inputs error:', err);
    res.json({ ok: false, error: 'Chyba serveru: ' + err.message });
  }
});

app.post('/api/import-excel', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Žádný soubor' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false, raw: true });
    const recSheet = wb.Sheets['seznam balenéreceptury'];
    if (!recSheet) return res.status(400).json({ error: 'Chybí záložka "seznam balenéreceptury"' });

    const recRows = XLSX.utils.sheet_to_json(recSheet, { header: 1, defval: null, raw: true });
    const receptury = [];
    const ittToCislo = {};

    for (let i = 1; i < recRows.length; i++) {
      const r = recRows[i];
      if (!r[0] || !r[1]) continue;
      const cisloNum = parseFloat(r[0]);
      if (isNaN(cisloNum)) continue;
      const cislo = String(Math.round(cisloNum));
      const smes = String(r[1]).trim();
      const zt = r[2] ? String(r[2]).trim() : '';
      if (zt) ittToCislo[zt] = cislo;
      receptury.push({
        cislo, smes, zt,
        c04: fv(r[3]), c24: fv(r[4]), c48: fv(r[5]), c811: fv(r[6]),
        c1116: fv(r[7]), c1622: fv(r[8]),
        b5070: fv(r[9]), b255560: fv(r[10]), b458065: fv(r[11]), b2030: fv(r[12]),
        prach: fv(r[13]), vapenec: fv(r[14]), addbit: fv(r[15]),
        scel: fv(r[16]), ra16: fv(r[17]), ra22: fv(r[18]), celkem: fv(r[19])
      });
    }

    const weekSheets = wb.SheetNames.filter(s => /^\d+$/.test(s));
    const weekMap = {};
    const hmgEntries = {};

    for (const sheetName of weekSheets) {
      const ws = wb.Sheets[sheetName];
      if (!ws) continue;
      const dates = [];
      for (let ci = 6; ci <= 12; ci++) {
        const addr = XLSX.utils.encode_cell({ r: 1, c: ci });
        const cell = ws[addr];
        if (!cell) { dates.push(null); continue; }
        let iso = null;
        if (cell.t === 'n' && cell.v > 40000) iso = xlsxDateToIso(cell.v);
        else if (cell.t === 'd') {
          const dt = new Date(cell.v);
          iso = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
        }
        dates.push(iso);
      }
      const weekStart = dates[0];
      if (!weekStart) continue;

      const rows = [];
      for (let ri = 2; ri <= 34; ri++) {
        const getCell = (ci) => ws[XLSX.utils.encode_cell({ r: ri, c: ci })] || null;
        const getStr = (ci) => { const c = getCell(ci); return c && c.v !== undefined ? String(c.v).trim() : ''; };
        const getNum = (ci) => { const c = getCell(ci); if (!c || c.v === undefined) return ''; const n = parseFloat(c.v); return (isNaN(n) || n <= 0) ? '' : Math.round(n); };
        const smes = getStr(3); const itt = getStr(4); const ceta = getStr(5);
        if (!smes || !itt) continue;
        let cislo = '';
        const cisloCell = getCell(0);
        if (cisloCell && cisloCell.v !== undefined) { const n = parseFloat(cisloCell.v); if (!isNaN(n) && n > 0) cislo = String(Math.round(n)); }
        if (!cislo) cislo = ittToCislo[itt] || '';
        let objednavka = getStr(2);
        const objCell = getCell(2);
        if (objCell && objCell.t === 'n') objednavka = String(Math.round(objCell.v));
        const entry = {
          checked: false, cislo, lokalita: getStr(1), objednavka, smes, itt, ceta,
          d0: getNum(6), d1: getNum(7), d2: getNum(8), d3: getNum(9),
          d4: getNum(10), d5: getNum(11), d6: getNum(12)
        };
        rows.push(entry);
        for (let di = 0; di <= 6; di++) {
          const tuny = parseInt(entry[`d${di}`]) || 0;
          if (!tuny || !dates[di]) continue;
          if (!hmgEntries[dates[di]]) hmgEntries[dates[di]] = [];
          hmgEntries[dates[di]].push({ lokalita: entry.lokalita, objednavka: entry.objednavka, smes, itt, ceta, tuny });
        }
      }
      if (rows.length > 0) weekMap[weekStart] = rows;
    }

    if (receptury.length > 0) {
      await pool.query(
        `INSERT INTO inputs (id,rows_json,updated_at) VALUES(1,$1,NOW()) ON CONFLICT(id) DO UPDATE SET rows_json=EXCLUDED.rows_json,updated_at=NOW()`,
        [JSON.stringify(receptury)]
      );
    }
    // Přepis pouze od aktuálního týdne dál (pondělí aktuálního týdne)
    const todayMonday = (() => {
      const d = new Date(); const day = d.getDay() || 7;
      d.setDate(d.getDate() - day + 1); d.setHours(0,0,0,0);
      return d.toISOString().slice(0,10);
    })();
    for (const [ws, rows] of Object.entries(weekMap)) {
      if (ws < todayMonday) continue; // přeskoč minulé týdny
      await pool.query(
        `INSERT INTO week_data (week_start,rows_json,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(week_start) DO UPDATE SET rows_json=EXCLUDED.rows_json,updated_at=NOW()`,
        [ws, JSON.stringify(rows)]
      );
    }
    if (Object.keys(hmgEntries).length > 0) {
      await pool.query(
        `INSERT INTO month_entries (id,data_json,updated_at) VALUES(1,$1,NOW()) ON CONFLICT(id) DO UPDATE SET data_json=EXCLUDED.data_json,updated_at=NOW()`,
        [JSON.stringify(hmgEntries)]
      );
    }
    res.json({ ok: true, receptury: receptury.length, tydnu: Object.keys(weekMap).length, dnu: Object.keys(hmgEntries).length });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Verze aplikace (veřejné — nevyžaduje přihlášení, neobsahuje citlivá data) ──
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

// ── Konfigurace pro frontend (Mapy.cz klíč + verze aplikace, chráněno autentizací) ──
app.get('/api/config', requireAuth, (req, res) => {
  res.json({ mapyCzKey: process.env.MAPY_CZ_KEY || '', version: APP_VERSION });
});

// ── Globální error handler ──
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Interní chyba serveru' });
  }
  res.status(500).send('Interní chyba serveru');
});


// ── Sestavení styled Excel zálohy ──
async function buildStyledExcel(weeks, inputs, companies, orders, users) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HMG Záloha';
  wb.created = new Date();

  // Barvy čet — nejdřív z DB, pak fallback
  const dbColors = {};
  (companies || []).forEach(c => { if (c.name && c.color) dbColors[c.name] = c.color; });
  const FALLBACK = { 'Colas': '#fff2a8', 'Firesta': '#d9ead3', 'Mi Roads': '#ffcccb', 'BKOM': '#fed7aa' };
  function cetaArgb(ceta) {
    const hex = ceta && (dbColors[ceta] || FALLBACK[ceta]);
    return hex ? 'FF' + hex.replace('#', '').toUpperCase() : null;
  }

  const THIN = { style: 'thin' };
  const BORDERS = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  const HDR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  const HDR_FONT = { bold: true, size: 10, name: 'Calibri' };
  const DATA_FONT = { size: 10, name: 'Calibri' };

  function styleRow(row, argb, aligns, isHeader) {
    row.height = isHeader ? 18 : 15;
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = isHeader ? HDR_FONT : DATA_FONT;
      cell.border = BORDERS;
      cell.alignment = { horizontal: aligns[col - 1] || 'center', vertical: 'middle' };
      if (isHeader) cell.fill = HDR_FILL;
      else if (argb) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    });
  }

  // ── Týdny ──
  (weeks || []).forEach(w => {
    const ws = wb.addWorksheet(w.start);
    ws.columns = [
      { header: 'Č.',         key: 'cislo',      width: 6  },
      { header: 'Lokalita',   key: 'lokalita',   width: 22 },
      { header: 'Objednávka', key: 'objednavka', width: 16 },
      { header: 'Směs',       key: 'smes',       width: 32 },
      { header: 'ITT',        key: 'itt',        width: 14 },
      { header: 'Četa',       key: 'ceta',       width: 12 },
      { header: 'Po', key: 'd0', width: 7 },
      { header: 'Út', key: 'd1', width: 7 },
      { header: 'St', key: 'd2', width: 7 },
      { header: 'Čt', key: 'd3', width: 7 },
      { header: 'Pá', key: 'd4', width: 7 },
      { header: 'So', key: 'd5', width: 7 },
      { header: 'Ne', key: 'd6', width: 7 },
    ];
    const aligns = ['center','left','left','left','left','center','center','center','center','center','center','center','center'];
    styleRow(ws.getRow(1), null, aligns, true);

    (w.rows || []).forEach(r => {
      const row = ws.addRow({
        cislo: r.cislo||'', lokalita: r.lokalita||'', objednavka: r.objednavka||'',
        smes: r.smes||'', itt: r.itt||'', ceta: r.ceta||'',
        d0: r.d0||'', d1: r.d1||'', d2: r.d2||'', d3: r.d3||'',
        d4: r.d4||'', d5: r.d5||'', d6: r.d6||''
      });
      styleRow(row, cetaArgb(r.ceta), aligns, false);
    });
  });

  // ── Receptury ──
  if (inputs && inputs.length > 0) {
    const ws = wb.addWorksheet('Receptury');
    ws.columns = [
      { header: 'Č.',       key: 'cislo',   width: 6  },
      { header: 'Směs',     key: 'smes',    width: 32 },
      { header: 'ITT',      key: 'zt',      width: 14 },
      { header: '0/4',      key: 'c04',     width: 7  },
      { header: '2/4',      key: 'c24',     width: 7  },
      { header: '4/8',      key: 'c48',     width: 7  },
      { header: '8/11',     key: 'c811',    width: 8  },
      { header: '11/16',    key: 'c1116',   width: 8  },
      { header: '16/22',    key: 'c1622',   width: 8  },
      { header: '50/70',    key: 'b5070',   width: 8  },
      { header: '25/55-60', key: 'b255560', width: 11 },
      { header: '45/80-65', key: 'b458065', width: 11 },
      { header: '20/30',    key: 'b2030',   width: 8  },
      { header: 'Prach',    key: 'prach',   width: 8  },
      { header: 'Vápenec',  key: 'vapenec', width: 9  },
      { header: 'Addbit',   key: 'addbit',  width: 8  },
      { header: 'S-CEL',    key: 'scel',    width: 8  },
      { header: '16RA',     key: 'ra16',    width: 8  },
      { header: '22RA',     key: 'ra22',    width: 8  },
      { header: 'Celkem',   key: 'celkem',  width: 9  },
    ];
    const aligns = ['center','left','left','center','center','center','center','center','center','center','center','center','center','center','center','center','center','center','center','center'];
    styleRow(ws.getRow(1), null, aligns, true);
    inputs.forEach(r => {
      const row = ws.addRow(r);
      styleRow(row, null, aligns, false);
    });
  }

  // ── Objednávky (čitelný přehled — jen ke čtení, ne pro import) ──
  if (orders && orders.length > 0) {
    const STATUS_CZ = {
      pending:      'Čeká',
      pre_approved: 'Předschváleno',
      pre_rejected: 'Předmítnuto',
      approved:     'Schváleno',
      rejected:     'Zamítnuto',
    };
    const wsOrd = wb.addWorksheet('Objednávky');
    wsOrd.columns = [
      { header: 'Lokalita',        key: 'lokalita',      width: 22 },
      { header: 'Firma',           key: 'firma',         width: 18 },
      { header: 'Směs',            key: 'smes',          width: 32 },
      { header: 'ITT',             key: 'itt',           width: 14 },
      { header: 'Datum',           key: 'datum',         width: 12 },
      { header: 'Tuny',            key: 'tuny',          width: 8  },
      { header: 'Stav',            key: 'status',        width: 14 },
      { header: 'Důvod zamítnutí', key: 'reject_reason', width: 30 },
      { header: 'Vytvořeno',       key: 'created_at',    width: 20 },
    ];
    const ordAligns = ['left','left','left','left','center','center','center','left','center'];
    styleRow(wsOrd.getRow(1), null, ordAligns, true);
    orders.forEach(o => {
      const row = wsOrd.addRow({
        lokalita:      o.lokalita || '',
        firma:         o.firma || '',
        smes:          o.smes || '',
        itt:           o.itt || '',
        datum:         o.datum ? String(o.datum).slice(0, 10) : '',
        tuny:          o.tuny != null ? o.tuny : '',
        status:        STATUS_CZ[o.status] || o.status || '',
        reject_reason: o.reject_reason || '',
        created_at:    o.created_at ? new Date(o.created_at).toISOString().slice(0, 16).replace('T', ' ') : '',
      });
      styleRow(row, null, ordAligns, false);
    });
  }

  // ── Uživatelé (čitelný přehled — bez password_hash) ──
  if (users && users.length > 0) {
    const wsUsr = wb.addWorksheet('Uživatelé');
    wsUsr.columns = [
      { header: 'Login',  key: 'username', width: 20 },
      { header: 'Role',   key: 'role',     width: 14 },
      { header: 'E-mail', key: 'email',    width: 28 },
      { header: 'Firma',  key: 'firma',    width: 22 },
    ];
    const usrAligns = ['left', 'center', 'left', 'left'];
    styleRow(wsUsr.getRow(1), null, usrAligns, true);
    users.forEach(u => {
      const row = wsUsr.addRow({
        username: u.username || '',
        role:     u.role || '',
        email:    u.email || '',
        firma:    u.firma || '',
      });
      styleRow(row, null, usrAligns, false);
    });
  }

  if (wb.worksheets.length === 0) {
    const ws = wb.addWorksheet('Info');
    ws.addRow(['Záloha neobsahuje data']);
  }

  const buffer     = await wb.xlsx.writeBuffer();
  const sheetNames = wb.worksheets.map(ws => ws.name);
  return { buffer, sheetNames };
}

// ── Emailová záloha ──
async function sendBackup() {
  const TAG = `[ZÁLOHA v${APP_VERSION}]`;
  console.log(`${TAG} ===== START =====`);

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD || !process.env.BACKUP_EMAIL) {
    const msg = 'Chybí konfigurace emailu (GMAIL_USER, GMAIL_APP_PASSWORD, BACKUP_EMAIL)';
    console.error(`${TAG} CHYBA konfigurace: ${msg}`);
    throw new Error(msg);
  }

  // ── Načteme VŠECHNA data najednou ────────────────────────────────────────────
  let weeks, inputs, companies, settings, ordersRes, usersRes, monthRes;
  try {
    [weeks, inputs, companies, settings, ordersRes, usersRes, monthRes] = await Promise.all([
      pool.query('SELECT week_start,rows_json FROM week_data ORDER BY week_start'),
      pool.query('SELECT rows_json FROM inputs WHERE id=1'),
      pool.query('SELECT data_json FROM companies WHERE id=1'),
      pool.query('SELECT key,value FROM settings'),
      pool.query(
        'SELECT id,order_group_id,user_id,firma,datum,smes,itt,tuny,komentar,' +
        'status,created_at,resolved_at,reject_reason,lokalita FROM orders ORDER BY created_at'
      ),
      pool.query(
        'SELECT id,username,password_hash,role,email,firma,must_change_password,created_at,last_seen FROM users ORDER BY id'
      ),
      pool.query('SELECT data_json FROM month_entries WHERE id=1'),
    ]);
  } catch (dbErr) {
    console.error(`${TAG} CHYBA DB dotazů — záloha se neprovede:`, dbErr.message);
    throw dbErr;
  }

  console.log(
    `${TAG} DB načteno: weeks=${weeks.rows.length}, receptury=${inputs.rows[0] ? 'ANO' : 'prázdné'}, ` +
    `companies=${companies.rows[0] ? 'ANO' : 'prázdné'}, orders=${ordersRes.rows.length}, ` +
    `users=${usersRes.rows.length}, month_entries=${monthRes.rows[0] ? 'ANO' : 'prázdné'}`
  );

  const settingsObj = {};
  settings.rows.forEach(r => { settingsObj[r.key] = r.value; });

  const date = new Date().toISOString().slice(0, 10);

  // ── A) JSON snímek pro plnou obnovu ──────────────────────────────────────────
  const settingsForSnapshot = Object.assign({}, settingsObj);
  if ('smtp_password' in settingsForSnapshot) settingsForSnapshot.smtp_password = '';

  const snapshot = {
    version: 3,
    created: new Date().toISOString(),
    week_data:     weeks.rows.map(r => ({ week_start: r.week_start, rows_json: r.rows_json })),
    inputs:        inputs.rows[0] ? JSON.parse(inputs.rows[0].rows_json) : [],
    companies:     companies.rows[0] ? JSON.parse(companies.rows[0].data_json) : [],
    settings:      settingsForSnapshot,
    month_entries: monthRes.rows[0] ? JSON.parse(monthRes.rows[0].data_json) : {},
    users:         usersRes.rows,
    orders:        ordersRes.rows,
  };

  const snapshotJson     = JSON.stringify(snapshot, null, 2);
  const snapshotFilename = `hmg-snapshot-${date}.json`;

  console.log(
    `${TAG} JSON snímek sestaven: klíče=[${Object.keys(snapshot).join(', ')}], ` +
    `users=${usersRes.rows.length}, orders=${ordersRes.rows.length}, smtp_password redakován=true`
  );

  // Best-effort uložení na disk — selhání NEVYHODÍ zálohu
  try {
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, snapshotFilename), snapshotJson, 'utf8');
    console.log(`${TAG} Snímek uložen na disk: backups/${snapshotFilename}`);
  } catch (diskErr) {
    console.error(`${TAG} Varování: snímek na disk se nepodařilo uložit (záloha e-mailem pokračuje):`, diskErr.message);
  }

  // ── B) Excel se stávajícími listy + Objednávky + Uživatelé ───────────────────
  const backup = {
    weeks:     weeks.rows.map(r => ({ start: r.week_start, rows: JSON.parse(r.rows_json) })),
    inputs:    inputs.rows[0] ? JSON.parse(inputs.rows[0].rows_json) : [],
    companies: companies.rows[0] ? JSON.parse(companies.rows[0].data_json) : [],
  };

  let xlsxBuffer, sheetNames;
  try {
    ({ buffer: xlsxBuffer, sheetNames } = await buildStyledExcel(
      backup.weeks, backup.inputs, backup.companies, ordersRes.rows, usersRes.rows
    ));
  } catch (xlsxErr) {
    console.error(`${TAG} CHYBA sestavení Excelu:`, xlsxErr.message);
    throw xlsxErr;
  }

  const xlsxFilename = `hmg_zaloha_${date}.xlsx`;
  console.log(`${TAG} Excel sestaven: listy=[${sheetNames.join(', ')}], JSON přiložen=true`);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    }
  });

  try {
    await transporter.sendMail({
      from:    `"HMG Záloha" <${process.env.GMAIL_USER}>`,
      to:      process.env.BACKUP_EMAIL,
      subject: `HMG záloha ${date} — ${backup.weeks.length} týdnů`,
      text: (
        `Automatická záloha dat harmonogramu výroby.\n\n` +
        `Obsah:\n` +
        `- Týdnů: ${backup.weeks.length}\n` +
        `- Receptur: ${backup.inputs.length}\n` +
        `- Objednávek: ${ordersRes.rows.length}\n` +
        `- Uživatelů: ${usersRes.rows.length}\n` +
        `- Datum: ${date}\n` +
        `- Excel listy: ${sheetNames.join(', ')}\n\n` +
        `Přílohy:\n` +
        `1. ${xlsxFilename} — čitelný Excel (týdny, receptury, objednávky, uživatelé)\n` +
        `2. ${snapshotFilename} — JSON snímek všech tabulek pro plnou obnovu DB`
      ),
      attachments: [
        {
          filename:    xlsxFilename,
          content:     xlsxBuffer,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        {
          filename:    snapshotFilename,
          content:     Buffer.from(snapshotJson, 'utf8'),
          contentType: 'application/json',
        },
      ],
    });
  } catch (mailErr) {
    console.error(`${TAG} CHYBA odeslání e-mailu:`, mailErr.message);
    throw mailErr;
  }

  console.log(`${TAG} ===== DOKONČENO: ${xlsxFilename} + ${snapshotFilename} =====`);

  await pool.query(
    "INSERT INTO settings (key,value) VALUES ('last_backup',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
    [new Date().toISOString()]
  );
}

// Smaž zamítnuté objednávky starší 30 dní (auto-cleanup)
async function cleanupRejectedOrders() {
  try {
    const r = await pool.query(
      `DELETE FROM orders WHERE status='rejected' AND resolved_at < NOW() - INTERVAL '30 days'`
    );
    if (r.rowCount > 0) {
      console.log(`Auto-cleanup: smazáno ${r.rowCount} zamítnutých objednávek starších 30 dní`);
    }
  } catch (err) {
    console.error('Cleanup rejected orders error:', err.message);
  }
}

// ── Obnova DB ze snímku (transakce + bezpečnostní záloha před zápisem) ───────
async function restoreFromSnapshot(snapshot) {
  const TAG = '[OBNOVA]';

  // 1. Validace struktury snímku
  const REQUIRED_KEYS = ['version','users','orders','week_data','inputs','companies','settings','month_entries'];
  for (const k of REQUIRED_KEYS) {
    if (!(k in snapshot)) throw new Error(`Neplatný snímek: chybí klíč "${k}"`);
  }
  if (!Array.isArray(snapshot.users))     throw new Error('Neplatný snímek: users není pole');
  if (!Array.isArray(snapshot.orders))    throw new Error('Neplatný snímek: orders není pole');
  if (!Array.isArray(snapshot.week_data)) throw new Error('Neplatný snímek: week_data není pole');
  console.log(
    `${TAG} Snímek validní — users=${snapshot.users.length}, orders=${snapshot.orders.length}, ` +
    `weeks=${snapshot.week_data.length}`
  );

  // 2. Bezpečnostní snímek PŘED obnovou (selhání = abort, bezpečnost na prvním místě)
  const preTs   = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const preFile = `pre-restore-${preTs}.json`;
  try {
    const [wk, inp, comp, sett, ord, usr, mo] = await Promise.all([
      pool.query('SELECT week_start,rows_json FROM week_data ORDER BY week_start'),
      pool.query('SELECT rows_json FROM inputs WHERE id=1'),
      pool.query('SELECT data_json FROM companies WHERE id=1'),
      pool.query('SELECT key,value FROM settings'),
      pool.query(
        'SELECT id,order_group_id,user_id,firma,datum,smes,itt,tuny,komentar,' +
        'status,created_at,resolved_at,reject_reason,lokalita FROM orders ORDER BY created_at'
      ),
      pool.query(
        'SELECT id,username,password_hash,role,email,firma,must_change_password,created_at,last_seen FROM users ORDER BY id'
      ),
      pool.query('SELECT data_json FROM month_entries WHERE id=1'),
    ]);
    const sObj = {};
    sett.rows.forEach(r => { sObj[r.key] = r.value; });
    if ('smtp_password' in sObj) sObj.smtp_password = '';
    const preSnap = {
      version: 3, created: new Date().toISOString(),
      note: 'Automatický bezpečnostní snímek před obnovou',
      week_data:     wk.rows,
      inputs:        inp.rows[0] ? JSON.parse(inp.rows[0].rows_json) : [],
      companies:     comp.rows[0] ? JSON.parse(comp.rows[0].data_json) : [],
      settings:      sObj,
      month_entries: mo.rows[0] ? JSON.parse(mo.rows[0].data_json) : {},
      users:         usr.rows,
      orders:        ord.rows,
    };
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, preFile), JSON.stringify(preSnap, null, 2), 'utf8');
    console.log(`${TAG} Bezpečnostní snímek uložen: backups/${preFile}`);
  } catch (preErr) {
    throw new Error(`Nelze vytvořit bezpečnostní snímek před obnovou: ${preErr.message}`);
  }

  // 3. Obnova v jedné transakci — jakákoliv chyba = ROLLBACK
  const client = await pool.connect();
  const summary = {};
  try {
    await client.query('BEGIN');

    // Mazání v pořadí FK závislostí: orders → users, pak single-row tabulky
    await client.query('DELETE FROM orders');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM week_data');
    await client.query('DELETE FROM inputs');
    await client.query('DELETE FROM companies');
    await client.query('DELETE FROM month_entries');

    // week_data — rows_json je již string v snímku (nezparsovávat znovu)
    for (const w of snapshot.week_data) {
      const rj = typeof w.rows_json === 'string' ? w.rows_json : JSON.stringify(w.rows_json);
      await client.query(
        'INSERT INTO week_data (week_start, rows_json) VALUES ($1, $2)',
        [w.week_start, rj]
      );
    }
    summary.week_data = snapshot.week_data.length;

    // inputs — v snímku uloženo jako parsované pole, vrátit jako JSON string
    const inputsData = Array.isArray(snapshot.inputs) ? snapshot.inputs : [];
    await client.query(
      'INSERT INTO inputs (id, rows_json) VALUES (1, $1)',
      [JSON.stringify(inputsData)]
    );
    summary.inputs = inputsData.length;

    // companies — v snímku uloženo jako parsované pole
    const companiesData = Array.isArray(snapshot.companies) ? snapshot.companies : [];
    await client.query(
      'INSERT INTO companies (id, data_json) VALUES (1, $1)',
      [JSON.stringify(companiesData)]
    );
    summary.companies = companiesData.length;

    // month_entries — v snímku uloženo jako parsovaný objekt
    const monthData = (snapshot.month_entries && typeof snapshot.month_entries === 'object')
      ? snapshot.month_entries : {};
    await client.query(
      'INSERT INTO month_entries (id, data_json) VALUES (1, $1)',
      [JSON.stringify(monthData)]
    );
    summary.month_entries = Object.keys(monthData).length;

    // settings — upsert po klíčích; smtp_password prázdný → NEPŘEPISOVAT stávající
    let settCount = 0;
    for (const [key, value] of Object.entries(snapshot.settings || {})) {
      if (key === 'smtp_password' && !value) continue;
      await client.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, String(value)]
      );
      settCount++;
    }
    summary.settings = settCount;

    // users — s původními id (jsou FK target pro orders), vč. password_hash
    for (const u of snapshot.users) {
      await client.query(
        `INSERT INTO users
           (id, username, password_hash, role, email, firma, must_change_password, created_at, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          u.id,
          u.username,
          u.password_hash || null,
          u.role  || 'operator',
          u.email || null,
          u.firma || null,
          u.must_change_password || false,
          u.created_at || new Date().toISOString(),
          u.last_seen  || null,
        ]
      );
    }
    summary.users = snapshot.users.length;
    if (snapshot.users.length > 0) {
      await client.query("SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))");
    }

    // orders — s původními id, FK na users musí být vložena první
    for (const o of snapshot.orders) {
      await client.query(
        `INSERT INTO orders
           (id, order_group_id, user_id, firma, datum, smes, itt, tuny,
            komentar, status, created_at, resolved_at, reject_reason, lokalita)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          o.id, o.order_group_id, o.user_id, o.firma, o.datum, o.smes, o.itt, o.tuny,
          o.komentar      || null,
          o.status,
          o.created_at,
          o.resolved_at   || null,
          o.reject_reason || null,
          o.lokalita      || null,
        ]
      );
    }
    summary.orders = snapshot.orders.length;
    if (snapshot.orders.length > 0) {
      await client.query("SELECT setval('orders_id_seq', (SELECT MAX(id) FROM orders))");
    }

    await client.query('COMMIT');
    console.log(`${TAG} Obnova úspěšně dokončena:`, JSON.stringify(summary));
    return { summary, preBackup: preFile };

  } catch (txErr) {
    await client.query('ROLLBACK');
    console.error(`${TAG} CHYBA — proveden ROLLBACK:`, txErr.message);
    throw txErr;
  } finally {
    client.release();
  }
}

// ── SMTP / Emailové notifikace ─────────────────────────────────────────────────

async function getSmtpSettings() {
  try {
    const r = await pool.query(
      "SELECT key,value FROM settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_password','smtp_from','smtp_admin_emails')"
    );
    const s = {};
    r.rows.forEach(row => { s[row.key] = row.value; });
    return s;
  } catch(err) {
    console.error('getSmtpSettings error:', err.message);
    return {};
  }
}

async function sendNotificationEmail(toAddr, subject, htmlContent, smtpSettings) {
  if (!toAddr) return;
  const settings = smtpSettings || (await getSmtpSettings());
  if (!settings.smtp_host || !settings.smtp_user) {
    console.log(`SMTP nenastaveno, email přeskočen (to: ${toAddr})`);
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: parseInt(settings.smtp_port) || 587,
      secure: parseInt(settings.smtp_port) === 465,
      auth: { user: settings.smtp_user, pass: settings.smtp_password || '' },
      tls: { rejectUnauthorized: false }
    });
    await transporter.sendMail({
      from: settings.smtp_from || settings.smtp_user,
      to: toAddr, subject,
      html: htmlContent,
      text: htmlContent.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    });
    console.log(`Email odeslán → ${toAddr}: ${subject}`);
  } catch(err) {
    console.error(`Email chyba (to:${toAddr}, subject:"${subject}"):`, err.message);
  }
}

function fmtDateCz(d) {
  const s = d instanceof Date ? d.toISOString().slice(0,10) : String(d||'').slice(0,10);
  const [y,m,day] = s.split('-');
  return `${parseInt(day)}.${parseInt(m)}.${y}`;
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function sendOrderCreatedEmails(groupId, firma, username, lokalita, lat, lng, items, userId) {
  try {
    const smtpSettings = await getSmtpSettings();
    const smesMap = {};
    items.forEach(item => { smesMap[item.smes] = (smesMap[item.smes]||0) + (parseInt(item.tuny)||0); });
    const celkem = Object.values(smesMap).reduce((s,v)=>s+v,0);
    const byDatum = {};
    items.forEach(item => { if (!byDatum[item.datum]) byDatum[item.datum]=[]; byDatum[item.datum].push(item); });
    const TS = 'width:100%;border-collapse:collapse;margin-bottom:12px;font-size:14px';
    const TH = 'padding:6px 8px;border:1px solid #d1d5db;background:#f9fafb;text-align:left;font-size:12px;font-weight:600;color:#374151';
    const dnyRows = Object.keys(byDatum).sort().map(datum => {
      const di = byDatum[datum];
      const dt = di.reduce((s,i)=>s+(parseInt(i.tuny)||0),0);
      return `<tr><td style="padding:5px 8px;border:1px solid #e5e7eb">${fmtDateCz(datum)}</td><td style="padding:5px 8px;border:1px solid #e5e7eb">${di.map(i=>`${escHtml(i.smes)}: ${i.tuny} t`).join(', ')}</td><td style="padding:5px 8px;border:1px solid #e5e7eb;text-align:right;font-weight:600">${dt} t</td></tr>`;
    }).join('');
    const smesRows = Object.entries(smesMap).map(([smes,tuny])=>
      `<tr><td style="padding:5px 8px;border:1px solid #e5e7eb">${escHtml(smes)}</td><td style="padding:5px 8px;border:1px solid #e5e7eb;text-align:right;font-weight:600">${tuny} t</td></tr>`
    ).join('');
    const gpsText = (lat&&lng)?`${parseFloat(lat).toFixed(6)}, ${parseFloat(lng).toFixed(6)}`:'—';
    const now = new Date().toLocaleString('cs-CZ',{timeZone:'UTC'});

    // A1 – email adminovi
    const adminEmails = smtpSettings.smtp_admin_emails;
    if (adminEmails) {
      const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111">
        <h2 style="background:#1a1a2e;color:#fff;padding:16px 20px;margin:0;font-size:18px">&#x1F69B; Nov&#225; objedn&#225;vka</h2>
        <div style="padding:20px">
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px">
            <tr><td style="padding:5px 8px;font-weight:600;color:#374151;width:120px">Firma:</td><td style="padding:5px 8px"><strong>${escHtml(firma)}</strong></td></tr>
            <tr><td style="padding:5px 8px;font-weight:600;color:#374151">U&#382;ivatel:</td><td style="padding:5px 8px">${escHtml(username)}</td></tr>
            <tr><td style="padding:5px 8px;font-weight:600;color:#374151">Lokalita:</td><td style="padding:5px 8px">${escHtml(lokalita)}</td></tr>
            <tr><td style="padding:5px 8px;font-weight:600;color:#374151">GPS:</td><td style="padding:5px 8px">${gpsText}</td></tr>
            <tr><td style="padding:5px 8px;font-weight:600;color:#374151">&#268;as zad&#225;n&#237;:</td><td style="padding:5px 8px">${now}</td></tr>
          </table>
          <h3 style="font-size:14px;font-weight:600;color:#374151;margin:12px 0 6px">Dny a sm&#283;si</h3>
          <table style="${TS}"><thead><tr><th style="${TH}">Datum</th><th style="${TH}">Sm&#283;si</th><th style="${TH};text-align:right">Tuny</th></tr></thead><tbody>${dnyRows}</tbody></table>
          <h3 style="font-size:14px;font-weight:600;color:#374151;margin:12px 0 6px">Sou&#269;et sm&#283;s&#237;</h3>
          <table style="${TS}"><thead><tr><th style="${TH}">Sm&#283;s</th><th style="${TH};text-align:right">Tuny celkem</th></tr></thead><tbody>${smesRows}</tbody></table>
          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px;margin-top:8px">
            <span style="font-size:16px;font-weight:700;color:#1d4ed8">Celkem: ${celkem} t</span>
          </div>
        </div>
      </div>`;
      await sendNotificationEmail(adminEmails, `Nová objednávka - ${firma}`, html, smtpSettings);
    }

    // A2 – email uživateli
    const uRes = await pool.query('SELECT email FROM users WHERE id=$1', [userId]);
    const userEmail = uRes.rows[0] ? uRes.rows[0].email : null;
    if (userEmail) {
      const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111">
        <h2 style="background:#16a34a;color:#fff;padding:16px 20px;margin:0;font-size:18px">&#x2713; Objedn&#225;vka odesl&#225;na</h2>
        <div style="padding:20px">
          <p>Va&#353;e objedn&#225;vka pro lokalitu <strong>${escHtml(lokalita)}</strong> byla &#250;sp&#283;&#353;n&#283; odesl&#225;na a &#269;ek&#225; na schv&#225;len&#237; adminem.</p>
          <h3 style="font-size:14px;font-weight:600;color:#374151;margin:12px 0 6px">Dny a sm&#283;si</h3>
          <table style="${TS}"><thead><tr><th style="${TH}">Datum</th><th style="${TH}">Sm&#283;si</th><th style="${TH};text-align:right">Tuny</th></tr></thead><tbody>${dnyRows}</tbody></table>
          <h3 style="font-size:14px;font-weight:600;color:#374151;margin:12px 0 6px">Sou&#269;et sm&#283;s&#237;</h3>
          <table style="${TS}"><thead><tr><th style="${TH}">Sm&#283;s</th><th style="${TH};text-align:right">Tuny celkem</th></tr></thead><tbody>${smesRows}</tbody></table>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px;margin-top:8px">
            <span style="font-size:16px;font-weight:700;color:#16a34a">Celkem: ${celkem} t</span>
          </div>
          <p style="color:#9ca3af;font-size:11px;margin-top:20px">Tato zpr&#225;va byla vygenerov&#225;na automaticky syst&#233;mem HMG.</p>
        </div>
      </div>`;
      await sendNotificationEmail(userEmail, 'Vaše objednávka byla odeslána', html, smtpSettings);
    }
  } catch(err) {
    console.error('sendOrderCreatedEmails error:', err.message);
  }
}

async function sendOrderFinalizedEmail(groupId) {
  try {
    const smtpSettings = await getSmtpSettings();
    const gRes = await pool.query(
      `SELECT o.datum, o.smes, o.tuny, o.status, o.reject_reason, o.lokalita,
              u.email, u.username
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       WHERE o.order_group_id=$1
       ORDER BY o.datum, o.smes`,
      [groupId]
    );
    if (!gRes.rows.length) return;
    const firstRow = gRes.rows[0];
    const userEmail = firstRow.email;
    if (!userEmail) { console.log(`sendOrderFinalizedEmail: ${firstRow.username} nemá email, přeskočeno`); return; }
    const lokalita = firstRow.lokalita || '—';
    const byDatum = {};
    gRes.rows.forEach(row => {
      const datum = row.datum instanceof Date ? row.datum.toISOString().slice(0,10) : String(row.datum).slice(0,10);
      if (!byDatum[datum]) byDatum[datum]=[];
      byDatum[datum].push({...row,datum});
    });
    const TS = 'width:100%;border-collapse:collapse;margin-bottom:12px;font-size:14px';
    const TH = 'padding:6px 8px;border:1px solid #d1d5db;background:#f9fafb;text-align:left;font-size:12px;font-weight:600;color:#374151';
    let approvedTotal = 0, rejectedTotal = 0;
    const dnyRows = Object.keys(byDatum).sort().map(datum => {
      const dr = byDatum[datum];
      const dt = dr.reduce((s,r)=>s+(parseInt(r.tuny)||0),0);
      const smesText = dr.map(r=>`${escHtml(r.smes)}: ${r.tuny} t`).join(', ');
      const status = dr[0].status;
      if (status==='approved') {
        approvedTotal += dt;
        return `<tr style="background:#f0fdf4"><td style="padding:5px 8px;border:1px solid #e5e7eb">${fmtDateCz(datum)}</td><td style="padding:5px 8px;border:1px solid #e5e7eb"><span style="color:#16a34a;font-weight:600">&#x2713; SCHV&#193;LENO</span></td><td style="padding:5px 8px;border:1px solid #e5e7eb">${smesText}</td><td style="padding:5px 8px;border:1px solid #e5e7eb;text-align:right;font-weight:600">${dt} t</td></tr>`;
      } else {
        rejectedTotal += dt;
        const reason = (dr.find(r=>r.reject_reason)||{}).reject_reason || '—';
        return `<tr style="background:#fff5f5"><td style="padding:5px 8px;border:1px solid #e5e7eb">${fmtDateCz(datum)}</td><td style="padding:5px 8px;border:1px solid #e5e7eb"><span style="color:#dc2626;font-weight:600">&#x2717; ZAM&#205;TNUTO</span></td><td style="padding:5px 8px;border:1px solid #e5e7eb">${smesText}</td><td style="padding:5px 8px;border:1px solid #e5e7eb;color:#dc2626">Důvod: ${escHtml(reason)}</td></tr>`;
      }
    }).join('');
    const summaryParts = [];
    if (approvedTotal > 0) summaryParts.push(`<div style="flex:1;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:10px"><div style="font-size:12px;color:#16a34a">Schv&#225;leno</div><div style="font-size:18px;font-weight:700;color:#16a34a">${approvedTotal} t</div></div>`);
    if (rejectedTotal > 0) summaryParts.push(`<div style="flex:1;background:#fff5f5;border:1px solid #fca5a5;border-radius:6px;padding:10px"><div style="font-size:12px;color:#dc2626">Zam&#237;tnuto</div><div style="font-size:18px;font-weight:700;color:#dc2626">${rejectedTotal} t</div></div>`);
    const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111">
      <h2 style="background:#2563eb;color:#fff;padding:16px 20px;margin:0;font-size:18px">&#x1F4CB; Objedn&#225;vka vy&#345;&#237;zena</h2>
      <div style="padding:20px">
        <p>Va&#353;e objedn&#225;vka pro lokalitu <strong>${escHtml(lokalita)}</strong> byla vy&#345;&#237;zena.</p>
        <table style="${TS}"><thead><tr><th style="${TH}">Datum</th><th style="${TH}">Stav</th><th style="${TH}">Sm&#283;si</th><th style="${TH};text-align:right">Tuny / Důvod</th></tr></thead><tbody>${dnyRows}</tbody></table>
        ${summaryParts.length ? `<div style="display:flex;gap:12px;margin-top:12px">${summaryParts.join('')}</div>` : ''}
        <p style="color:#9ca3af;font-size:11px;margin-top:20px">Tato zpr&#225;va byla vygenerov&#225;na automaticky syst&#233;mem HMG.</p>
      </div>
    </div>`;
    await sendNotificationEmail(userEmail, `Objednávka vyřízena - ${lokalita}`, html, smtpSettings);
  } catch(err) {
    console.error('sendOrderFinalizedEmail error:', err.message);
  }
}

// Spustit zálohu každý den v 18:00 (UTC+2 = 16:00 UTC) + cleanup rejected objednávek
function scheduleBackup() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(16, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  const runScheduled = () => {
    sendBackup().catch(err => console.error('Chyba plánované zálohy:', err.message));
    cleanupRejectedOrders();
  };
  setTimeout(() => {
    runScheduled();
    setInterval(runScheduled, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`Záloha naplánována za ${Math.round(msUntil / 60000)} minut (každý den v 18:00)`);
}

// Manuální spuštění zálohy (jen pro admina)
app.post('/api/backup/run', requireAuth, requireAdmin, async (req, res) => {
  try {
    await sendBackup();
    res.json({ ok: true });
  } catch (err) {
    console.error('Manuální záloha selhala:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Obnova ze snímku — jen admin, s ověřením hesla (přepíše celou DB)
app.post('/api/restore', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { snapshotJson, password } = req.body;
    if (!snapshotJson || !password) {
      return res.status(400).json({ ok: false, error: 'Chybí snímek nebo heslo' });
    }
    // Ověř heslo přihlášeného admina (bcrypt)
    const userRow = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.session.userId]);
    if (!userRow.rows[0]) return res.status(401).json({ ok: false, error: 'Relace vypršela' });
    const valid = await bcrypt.compare(password, userRow.rows[0].password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Nesprávné heslo admina' });
    // Parsuj JSON snímek
    let snapshot;
    try { snapshot = JSON.parse(snapshotJson); }
    catch (e) { return res.status(400).json({ ok: false, error: 'Neplatný JSON soubor: ' + e.message }); }
    // Proveď obnovu
    const result = await restoreFromSnapshot(snapshot);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[OBNOVA] Selhání endpointu:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/settings', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});


app.get('/api/export-excel', requireAuth, requireOperator, async (req, res) => {
  const [weeks, inputs] = await Promise.all([
    pool.query('SELECT week_start,rows_json FROM week_data ORDER BY week_start'),
    pool.query('SELECT rows_json FROM inputs WHERE id=1')
  ]);
  const wb = XLSX.utils.book_new();
  weeks.rows.forEach(w => {
    const rows = JSON.parse(w.rows_json).map(r => ({
      cislo: r.cislo||'', lokalita: r.lokalita||'', objednavka: r.objednavka||'',
      smes: r.smes||'', itt: r.itt||'', ceta: r.ceta||'',
      Po: r.d0||'', Ut: r.d1||'', St: r.d2||'', Ct: r.d3||'',
      Pa: r.d4||'', So: r.d5||'', Ne: r.d6||''
    }));
    if (rows.length > 0) {
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, w.week_start.slice(5));
    }
  });
  if (inputs.rows[0]) {
    const wsInputs = XLSX.utils.json_to_sheet(JSON.parse(inputs.rows[0].rows_json));
    XLSX.utils.book_append_sheet(wb, wsInputs, 'Receptury');
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const date = new Date().toISOString().slice(0,10);
  res.setHeader('Content-Disposition', `attachment; filename="hmg_zaloha_${date}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Fallback ──


// ════════════════════════════════════════════
// STRÁNKA NASTAVENÍ
// ════════════════════════════════════════════

// ── Správa uživatelů ──
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.username, u.role, u.firma, u.email, u.created_at, u.last_seen,
      (SELECT COUNT(*) FROM session s WHERE s.sess->>'userId' = u.id::text AND s.expire > NOW()) as session_count
    FROM users u ORDER BY u.created_at
  `);
  res.json(r.rows);
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, password, role, firma, email } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Vyplňte jméno a heslo' });
    if (!['admin','operator','hmg_share'].includes(role)) return res.status(400).json({ error: 'Neplatná role' });
    if (username.length < 3 || username.length > 50) return res.status(400).json({ error: 'Jméno 3-50 znaků' });
    if (password.length < 6) return res.status(400).json({ error: 'Heslo min. 6 znaků' });
    const emailVal = email ? String(email).trim().slice(0, 255) : null;
    if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
      return res.status(400).json({ error: 'Neplatný formát emailu' });
    }
    const firmaVal = (role === 'hmg_share' && firma) ? sanitizeStr(firma, 100) : null;
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      'INSERT INTO users (username, password_hash, role, firma, email) VALUES ($1,$2,$3,$4,$5) RETURNING id,username,role,firma,email',
      [username.trim(), hash, role, firmaVal, emailVal]
    );
    res.json({ ok: true, user: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Uživatel již existuje' });
    throw err;
  }
});

app.put('/api/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'Nemůžeš změnit vlastní roli' });
  const { role } = req.body;
  if (!['admin','operator','hmg_share'].includes(role)) return res.status(400).json({ error: 'Neplatná role' });
  await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, id]);
  // Smazat sessions uživatele aby se znovu přihlásil s novou rolí
  await pool.query("DELETE FROM session WHERE sess->>'userId'=$1", [String(id)]);
  res.json({ ok: true });
});

app.put('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Heslo min. 6 znaků' });
  const hash = await bcrypt.hash(password, 12);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'Nemůžeš smazat sám sebe' });
  await pool.query("DELETE FROM session WHERE sess->>'userId' = $1", [String(id)]);
  await pool.query('DELETE FROM users WHERE id=$1', [id]);
  res.json({ ok: true });
});

app.put('/api/users/:id/firma', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { firma } = req.body;
  const firmaVal = firma ? sanitizeStr(String(firma), 100) : null;
  await pool.query('UPDATE users SET firma=$1 WHERE id=$2', [firmaVal, id]);
  res.json({ ok: true });
});

app.put('/api/users/:id/email', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { email } = req.body;
  const emailVal = email ? String(email).trim().slice(0, 255) : null;
  if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
    return res.status(400).json({ error: 'Neplatný formát emailu' });
  }
  await pool.query('UPDATE users SET email=$1 WHERE id=$2', [emailVal, id]);
  res.json({ ok: true });
});

// ── Správa sessions ──
app.get('/api/sessions', requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT s.sid,
      s.sess->>'userId' as user_id,
      u.username,
      s.sess->>'userAgent' as user_agent,
      s.sess->>'loginIp' as ip,
      s.expire,
      (s.sid = $1) as is_current
    FROM session s
    LEFT JOIN users u ON u.id::text = s.sess->>'userId'
    WHERE s.expire > NOW()
    ORDER BY u.username, s.expire DESC
  `, [req.sessionID]);
  res.json(r.rows);
});

app.delete('/api/sessions/:sid', requireAuth, requireAdmin, async (req, res) => {
  if (req.params.sid === req.sessionID) return res.status(400).json({ error: 'Nemůžeš odhlásit aktuální session' });
  await pool.query('DELETE FROM session WHERE sid=$1', [req.params.sid]);
  res.json({ ok: true });
});

app.delete('/api/sessions/user/:id', requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM session WHERE sess->>'userId'=$1 AND sid!=$2", [String(req.params.id), req.sessionID]);
  res.json({ ok: true });
});

// ── Sdílení měsíčního přehledu ──
app.get('/api/share-tokens', requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'share_%'");
  res.json(r.rows.map(r => ({ token: r.key.replace('share_',''), expires: r.value })));
});

app.post('/api/share-tokens', requireAuth, requireAdmin, async (req, res) => {
  const days = parseInt(req.body.days) || 30;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date();
  expires.setDate(expires.getDate() + days);
  await pool.query(
    'INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
    [`share_${token}`, expires.toISOString()]
  );
  res.json({ ok: true, token, expires: expires.toISOString() });
});

app.delete('/api/share-tokens/:token', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM settings WHERE key=$1', [`share_${req.params.token}`]);
  res.json({ ok: true });
});

// Veřejný přístup přes share token
app.get('/share/:token', async (req, res) => {
  const r = await pool.query('SELECT value FROM settings WHERE key=$1', [`share_${req.params.token}`]);
  if (!r.rows[0] || new Date(r.rows[0].value) < new Date()) {
    return res.status(410).send('<h2>Odkaz vypršel nebo neexistuje.</h2>');
  }
  res.sendFile(path.join(__dirname, 'public', 'month.html'));
});

// ── HMG V3 — Objednávky ─────────────────────────────────────────────────────

// GET /api/orders?month=2026-06  nebo  GET /api/orders?pending=1 (pouze admin)
app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const { month, pending } = req.query;

    // Admin: načti všechny pending skupiny bez filtru měsíce
    if (pending === '1' && req.session.role === 'admin') {
      const r = await pool.query(
        `SELECT o.*, u.username
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         WHERE o.status = 'pending'
         ORDER BY o.created_at ASC`
      );
      return res.json(r.rows);
    }

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Neplatný formát měsíce (YYYY-MM)' });
    }
    const [year, mon] = month.split('-').map(Number);
    const from = `${year}-${String(mon).padStart(2,'0')}-01`;
    const lastDay = new Date(year, mon, 0).getDate();
    const to   = `${year}-${String(mon).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

    // Všechny role (hmg_share i admin) vidí objednávky VŠECH firem — plná transparentnost.
    // Filtr podle firmy se záměrně NEpoužívá: uživatel vidí cizí objednávky (jen čtení),
    // ale při POST /api/orders se firma bere z users.firma → nemůže objednat za cizí firmu.
    const r = await pool.query(
      `SELECT * FROM orders
       WHERE datum >= $1 AND datum <= $2
         AND status IN ('pending','pre_approved','pre_rejected','approved')
       ORDER BY datum, firma, created_at`,
      [from, to]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('GET /api/orders error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// GET /api/day-capacity?date=YYYY-MM-DD — rozpad obsazenosti dne (přístupné pro hmg_share i admina)
// Vrátí: { harmonogram, orders:[{firma,tuny,status}], maxDaily, minDaily }
app.get('/api/day-capacity', requireAuth, async (req, res) => {
  try {
    const { date } = req.query;
    if (!isIsoDate(date)) return res.status(400).json({ error: 'Neplatné datum' });

    // Harmonogram z week_data
    const d = new Date(date + 'T00:00:00Z');
    const dow = d.getUTCDay();
    const daysFromMonday = (dow + 6) % 7;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - daysFromMonday);
    const weekStart = monday.toISOString().slice(0, 10);
    const di = daysFromMonday;

    const wRes = await pool.query('SELECT rows_json FROM week_data WHERE week_start=$1', [weekStart]);
    let harmonogram = 0;
    if (wRes.rows[0]) {
      const rows = JSON.parse(wRes.rows[0].rows_json);
      harmonogram = rows.reduce((s, r) => s + (parseInt(r[`d${di}`]) || 0), 0);
    }

    // Všechny objednávky pro daný den (bez filtru firmy — plná transparentnost)
    const oRes = await pool.query(
      `SELECT firma, SUM(tuny)::int AS tuny, status
       FROM orders
       WHERE datum=$1 AND status IN ('pending','pre_approved','pre_rejected','approved')
       GROUP BY firma, status
       ORDER BY firma, status`,
      [date]
    );

    // Denní limity
    const sRes = await pool.query(
      "SELECT key,value FROM settings WHERE key IN ('hmg_max_daily','hmg_min_daily')"
    );
    const limits = {};
    sRes.rows.forEach(r => { limits[r.key] = parseInt(r.value); });

    res.json({
      date,
      harmonogram,
      orders: oRes.rows,   // [{firma, tuny, status}]
      maxDaily: limits.hmg_max_daily || null,
      minDaily: limits.hmg_min_daily || null
    });
  } catch (err) {
    console.error('GET /api/day-capacity error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// POST /api/orders — jen pro hmg_share uživatele
// Body: { lokalita, lat, lng, items: [{datum,smes,itt,tuny,komentar},...] }
app.post('/api/orders', requireAuth, requireOrdersEnabled, async (req, res) => {
  if (req.session.role !== 'hmg_share') {
    return res.status(403).json({ error: 'Pouze sdílení uživatelé (hmg_share) mohou podávat objednávky' });
  }
  try {
    const { lokalita, lat, lng, items } = req.body;

    // Validace group-level lokality
    if (!lokalita || typeof lokalita !== 'string' || !lokalita.trim()) {
      return res.status(400).json({ error: 'Chybí nebo prázdná lokalita' });
    }
    const groupLat = parseFloat(lat);
    const groupLng = parseFloat(lng);
    if (isNaN(groupLat) || groupLat < -90 || groupLat > 90) {
      return res.status(400).json({ error: `Neplatná zeměpisná šířka (lat): ${lat}` });
    }
    if (isNaN(groupLng) || groupLng < -180 || groupLng > 180) {
      return res.status(400).json({ error: `Neplatná zeměpisná délka (lng): ${lng}` });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items musí být neprázdné pole' });
    }
    if (items.length > 50) {
      return res.status(400).json({ error: 'Maximálně 50 položek v jedné skupině' });
    }

    // Firma přihlášeného uživatele
    const uRes = await pool.query('SELECT firma FROM users WHERE id=$1', [req.session.userId]);
    const firma = uRes.rows[0] ? uRes.rows[0].firma : null;
    if (!firma) {
      return res.status(400).json({ error: 'Uživatel nemá přiřazenu firmu. Kontaktujte admina.' });
    }

    // Validace každé položky
    for (const item of items) {
      if (!isIsoDate(item.datum)) return res.status(400).json({ error: `Neplatný formát data: ${item.datum}` });
      if (!item.smes || typeof item.smes !== 'string' || !item.smes.trim()) {
        return res.status(400).json({ error: 'Chybí nebo prázdná směs' });
      }
      const tuny = parseInt(item.tuny);
      if (isNaN(tuny) || tuny <= 0 || tuny > 99999) {
        return res.status(400).json({ error: 'Tuny musí být kladné celé číslo (1–99999)' });
      }
    }

    // Načti denní limity
    const sRes = await pool.query(
      "SELECT key,value FROM settings WHERE key IN ('hmg_max_daily','hmg_min_daily')"
    );
    const limits = {};
    sRes.rows.forEach(r => { limits[r.key] = parseInt(r.value); });
    const maxDaily = limits.hmg_max_daily || null;
    const minDaily = limits.hmg_min_daily || null;

    // Kapacitní kontrola per den (server-side bezpečnost)
    const datumSet = [...new Set(items.map(i => i.datum))];
    const warnings = [];
    const errors   = [];

    for (const datum of datumSet) {
      const dayNewTuny = items
        .filter(i => i.datum === datum)
        .reduce((s, i) => s + parseInt(i.tuny), 0);

      const d = new Date(datum + 'T00:00:00Z');
      const dow = d.getUTCDay();
      const daysFromMonday = (dow + 6) % 7;
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - daysFromMonday);
      const weekStart = monday.toISOString().slice(0, 10);
      const di = daysFromMonday;

      const wRes = await pool.query('SELECT rows_json FROM week_data WHERE week_start=$1', [weekStart]);
      let weekTuny = 0;
      if (wRes.rows[0]) {
        const rows = JSON.parse(wRes.rows[0].rows_json);
        weekTuny = rows.reduce((s, r) => s + (parseInt(r[`d${di}`]) || 0), 0);
      }

      const pRes = await pool.query(
        `SELECT COALESCE(SUM(tuny),0) AS total FROM orders
         WHERE datum=$1 AND status IN ('pending','pre_approved','pre_rejected','approved')`,
        [datum]
      );
      const existingTuny = parseInt(pRes.rows[0].total) || 0;

      const totalWithNew = weekTuny + existingTuny + dayNewTuny;

      if (maxDaily && totalWithNew > maxDaily) {
        errors.push(`${datum}: kapacita překročena (${totalWithNew} t > max ${maxDaily} t)`);
      } else if (minDaily && totalWithNew < minDaily) {
        warnings.push(`${datum}: pod minimem (${totalWithNew} t < min ${minDaily} t)`);
      }
    }

    if (errors.length > 0) {
      return res.status(409).json({ error: errors.join('; '), warnings });
    }

    // Uložení celé skupiny v transakci
    const groupId = crypto.randomUUID();
    const lokSafe = sanitizeStr(lokalita.trim(), 200);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of items) {
        await client.query(
          `INSERT INTO orders (order_group_id, user_id, firma, datum, smes, itt, tuny, komentar, lokalita, lat, lng)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            groupId,
            req.session.userId,
            firma,
            item.datum,
            sanitizeStr(item.smes, 200),
            item.itt ? sanitizeStr(item.itt, 50) : '',
            parseInt(item.tuny),
            item.komentar ? sanitizeStr(item.komentar, 500) : null,
            lokSafe,
            groupLat,
            groupLng
          ]
        );
      }
      await client.query('COMMIT');
      console.log(`Nová objednávka ${groupId} od ${firma} — lokalita: ${lokSafe} (${items.length} řádků)`);
      res.json({ ok: true, groupId, warnings });
      // Emailové notifikace — fire & forget, chyba emailu NESMÍ shodit objednávku
      sendOrderCreatedEmails(groupId, firma, req.session.username, lokSafe, groupLat, groupLng, items, req.session.userId)
        .catch(err => console.error('sendOrderCreatedEmails error:', err.message));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/orders error:', err);
    res.status(500).json({ error: 'Chyba serveru: ' + err.message });
  }
});

// PATCH /api/orders/:groupId/approve — admin schválí skupinu
// Bez body (nebo {confirm:false}): jen zkontroluje kapacitu, nic neschvaluje
// S body {confirm:true}: skutečně schválí (vždy, i pokud překračuje max)
app.patch('/api/orders/:groupId/approve', requireAuth, requireAdmin, requireOrdersEnabled, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(groupId)) {
      return res.status(400).json({ error: 'Neplatné ID skupiny' });
    }
    const doConfirm = !!(req.body && req.body.confirm);

    // Načti položky skupiny (jen pending)
    const gRes = await pool.query(
      `SELECT datum, SUM(tuny)::int AS group_tuny
       FROM orders WHERE order_group_id=$1 AND status='pending'
       GROUP BY datum`,
      [groupId]
    );
    if (gRes.rows.length === 0) {
      return res.status(404).json({ error: 'Skupina nenalezena nebo již vyřešena' });
    }

    // Denní maximum
    const sRes = await pool.query("SELECT value FROM settings WHERE key='hmg_max_daily'");
    const maxDaily = sRes.rows[0] ? parseInt(sRes.rows[0].value) : null;

    // Kapacitní kontrola per datum
    let exceedsMax = false;
    let exceedDetail = null;

    if (maxDaily) {
      for (const row of gRes.rows) {
        const datum = row.datum instanceof Date
          ? row.datum.toISOString().slice(0, 10)
          : String(row.datum).slice(0, 10);
        const thisGroupTuny = parseInt(row.group_tuny) || 0;

        const d = new Date(datum + 'T00:00:00Z');
        const dow = d.getUTCDay();
        const daysFromMonday = (dow + 6) % 7;
        const monday = new Date(d);
        monday.setUTCDate(d.getUTCDate() - daysFromMonday);
        const weekStart = monday.toISOString().slice(0, 10);
        const di = daysFromMonday;

        // Tuny z harmonogramu
        const wRes = await pool.query('SELECT rows_json FROM week_data WHERE week_start=$1', [weekStart]);
        let weekTuny = 0;
        if (wRes.rows[0]) {
          const weekRows = JSON.parse(wRes.rows[0].rows_json);
          weekTuny = weekRows.reduce((s, r) => s + (parseInt(r[`d${di}`]) || 0), 0);
        }

        // Ostatní non-rejected objednávky pro tento den (bez této skupiny)
        const otherRes = await pool.query(
          `SELECT COALESCE(SUM(tuny),0)::int AS total FROM orders
           WHERE datum=$1 AND status IN ('pending','approved') AND order_group_id != $2`,
          [datum, groupId]
        );
        const otherTuny = parseInt(otherRes.rows[0].total) || 0;
        const total = weekTuny + otherTuny + thisGroupTuny;

        if (total > maxDaily) {
          exceedsMax = true;
          if (!exceedDetail || total > exceedDetail.total) {
            exceedDetail = { datum, total, max: maxDaily };
          }
        }
      }
    }

    // Bez potvrzení — vrátí jen výsledek kontroly, neschvaluje
    if (!doConfirm) {
      return res.json({
        checked: true,
        exceedsMax,
        total:  exceedDetail ? exceedDetail.total : null,
        max:    maxDaily,
        datum:  exceedDetail ? exceedDetail.datum : null
      });
    }

    // S potvrzením — schválit vždy
    const r = await pool.query(
      `UPDATE orders SET status='approved', resolved_at=NOW(), resolved_by=$1
       WHERE order_group_id=$2 AND status='pending' RETURNING id`,
      [req.session.userId, groupId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Skupina nenalezena nebo již vyřešena' });
    console.log(`Objednávka ${groupId} schválena adminem ${req.session.username} (exceedsMax:${exceedsMax})`);

    // Propagace schválené objednávky do week_data harmonogramu
    try {
      const itemsRes = await pool.query(
        `SELECT datum, smes, itt, tuny, lokalita, lat, lng, firma
         FROM orders WHERE order_group_id=$1`,
        [groupId]
      );
      const byWeek = {};
      for (const item of itemsRes.rows) {
        const datum = item.datum instanceof Date
          ? item.datum.toISOString().slice(0, 10)
          : String(item.datum).slice(0, 10);
        const d = new Date(datum + 'T00:00:00Z');
        const dow = d.getUTCDay();
        const daysFromMonday = (dow + 6) % 7;
        const monday = new Date(d);
        monday.setUTCDate(d.getUTCDate() - daysFromMonday);
        const weekStart = monday.toISOString().slice(0, 10);
        const di = daysFromMonday;
        if (!byWeek[weekStart]) byWeek[weekStart] = [];
        byWeek[weekStart].push({ ...item, datum, di });
      }
      for (const [weekStart, weekItems] of Object.entries(byWeek)) {
        const wRes = await pool.query('SELECT rows_json FROM week_data WHERE week_start=$1', [weekStart]);
        const rows = wRes.rows[0] ? JSON.parse(wRes.rows[0].rows_json) : [];
        for (const item of weekItems) {
          const newRow = {
            checked: false, cislo: '',
            lokalita: item.lokalita || '',
            objednavka: item.firma || '',
            smes: item.smes || '',
            itt: item.itt || '',
            ceta: item.firma || '',
            lat: item.lat != null ? parseFloat(item.lat) : null,
            lng: item.lng != null ? parseFloat(item.lng) : null,
            d0: 0, d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0
          };
          newRow[`d${item.di}`] = parseInt(item.tuny) || 0;
          rows.push(newRow);
        }
        await pool.query(
          `INSERT INTO week_data (week_start, rows_json, updated_at) VALUES($1, $2, NOW())
           ON CONFLICT(week_start) DO UPDATE SET rows_json=EXCLUDED.rows_json, updated_at=NOW()`,
          [weekStart, JSON.stringify(rows)]
        );
      }
      console.log(`Objednávka ${groupId} propsána do ${Object.keys(byWeek).length} týdnů v harmonogramu`);
    } catch (propErr) {
      console.error(`Chyba při propsání objednávky ${groupId} do harmonogramu:`, propErr.message);
    }

    res.json({ ok: true, updated: r.rowCount, exceedsMax });
  } catch (err) {
    console.error('PATCH approve error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// PATCH /api/orders/:groupId/reject — admin zamítne skupinu (soft reject, uchovává v DB)
app.patch('/api/orders/:groupId/reject', requireAuth, requireAdmin, requireOrdersEnabled, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(groupId)) {
      return res.status(400).json({ error: 'Neplatné ID skupiny' });
    }
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Důvod zamítnutí je povinný' });
    }
    const reasonStr = sanitizeStr(String(reason).trim(), 500);
    const r = await pool.query(
      `UPDATE orders
       SET status='rejected', resolved_at=NOW(), resolved_by=$1, reject_reason=$2
       WHERE order_group_id=$3 AND status='pending' RETURNING id`,
      [req.session.userId, reasonStr, groupId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Skupina nenalezena nebo již vyřešena' });
    console.log(`Objednávka ${groupId} zamítnuta adminem ${req.session.username}: ${reasonStr}`);
    res.json({ ok: true, rejected: r.rowCount });
  } catch (err) {
    console.error('PATCH reject error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// DELETE /api/orders/:groupId — admin smaže skupinu
app.delete('/api/orders/:groupId', requireAuth, requireAdmin, requireOrdersEnabled, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(groupId)) {
      return res.status(400).json({ error: 'Neplatné ID skupiny' });
    }
    const r = await pool.query('DELETE FROM orders WHERE order_group_id=$1 RETURNING id', [groupId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Skupina nenalezena' });
    res.json({ ok: true, deleted: r.rowCount });
  } catch (err) {
    console.error('DELETE orders error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// ── HMG V3 — Dvoufázové schvalování objednávek ──────────────────────────────

// GET /api/orders/pending-groups — skupiny s nevyřízenými řádky (jen admin)
app.get('/api/orders/pending-groups', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        o.order_group_id,
        MAX(o.firma)         AS firma,
        MAX(u.username)      AS username,
        MIN(o.created_at)    AS created_at,
        MAX(o.lokalita)      AS lokalita,
        MAX(o.lat::float)    AS lat,
        MAX(o.lng::float)    AS lng,
        json_agg(
          json_build_object(
            'id',o.id,'datum',o.datum,'smes',o.smes,'itt',o.itt,
            'tuny',o.tuny,'komentar',o.komentar,'status',o.status,
            'reject_reason',o.reject_reason
          ) ORDER BY o.datum, o.smes
        ) AS rows
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE o.status IN ('pending','pre_approved','pre_rejected')
      GROUP BY o.order_group_id
      ORDER BY MIN(o.created_at)
    `);
    res.json(r.rows);
  } catch(err) {
    console.error('GET /api/orders/pending-groups error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// PATCH /api/orders/:groupId/day/:datum/preapprove
app.patch('/api/orders/:groupId/day/:datum/preapprove', requireAuth, requireAdmin, requireOrdersEnabled, async (req, res) => {
  try {
    const { groupId, datum } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(groupId))
      return res.status(400).json({ error: 'Neplatné ID skupiny' });
    if (!isIsoDate(datum)) return res.status(400).json({ error: 'Neplatné datum' });

    const gRes = await pool.query(
      `SELECT COALESCE(SUM(tuny),0)::int AS group_tuny FROM orders
       WHERE order_group_id=$1 AND datum=$2 AND status IN ('pending','pre_rejected')`,
      [groupId, datum]
    );
    const groupDayTuny = parseInt((gRes.rows[0]||{}).group_tuny) || 0;
    if (groupDayTuny === 0)
      return res.status(404).json({ error: 'Žádné pending/pre_rejected řádky pro tento den a skupinu' });

    const sRes = await pool.query("SELECT value FROM settings WHERE key='hmg_max_daily'");
    const maxDaily = sRes.rows[0] ? parseInt(sRes.rows[0].value) : null;
    let exceedsMax = false, total = 0;
    if (maxDaily) {
      const d = new Date(datum + 'T00:00:00Z');
      const daysFromMonday = (d.getUTCDay() + 6) % 7;
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - daysFromMonday);
      const weekStart = monday.toISOString().slice(0, 10);
      const di = daysFromMonday;
      const wRes = await pool.query('SELECT rows_json FROM week_data WHERE week_start=$1', [weekStart]);
      let weekTuny = 0;
      if (wRes.rows[0]) {
        const rows = JSON.parse(wRes.rows[0].rows_json);
        weekTuny = rows.reduce((s, r) => s + (parseInt(r[`d${di}`]) || 0), 0);
      }
      const otherRes = await pool.query(
        `SELECT COALESCE(SUM(tuny),0)::int AS total FROM orders
         WHERE datum=$1 AND status IN ('pending','pre_approved','pre_rejected','approved')
         AND order_group_id != $2`,
        [datum, groupId]
      );
      total = weekTuny + (parseInt(otherRes.rows[0].total)||0) + groupDayTuny;
      exceedsMax = total > maxDaily;
    }

    await pool.query(
      `UPDATE orders SET status='pre_approved'
       WHERE order_group_id=$1 AND datum=$2 AND status IN ('pending','pre_rejected')`,
      [groupId, datum]
    );
    res.json({ ok: true, exceedsMax, total, max: maxDaily });
  } catch(err) {
    console.error('PATCH preapprove error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// PATCH /api/orders/:groupId/day/:datum/prereject
app.patch('/api/orders/:groupId/day/:datum/prereject', requireAuth, requireAdmin, requireOrdersEnabled, async (req, res) => {
  try {
    const { groupId, datum } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(groupId))
      return res.status(400).json({ error: 'Neplatné ID skupiny' });
    if (!isIsoDate(datum)) return res.status(400).json({ error: 'Neplatné datum' });
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Důvod zamítnutí je povinný' });
    const reasonStr = sanitizeStr(String(reason).trim(), 500);
    const r = await pool.query(
      `UPDATE orders SET status='pre_rejected', reject_reason=$1
       WHERE order_group_id=$2 AND datum=$3 AND status IN ('pending','pre_approved') RETURNING id`,
      [reasonStr, groupId, datum]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Žádné aktivní řádky pro tento den a skupinu' });
    res.json({ ok: true, updated: r.rowCount });
  } catch(err) {
    console.error('PATCH prereject error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// PATCH /api/orders/:groupId/day/:datum/reset
app.patch('/api/orders/:groupId/day/:datum/reset', requireAuth, requireAdmin, requireOrdersEnabled, async (req, res) => {
  try {
    const { groupId, datum } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(groupId))
      return res.status(400).json({ error: 'Neplatné ID skupiny' });
    if (!isIsoDate(datum)) return res.status(400).json({ error: 'Neplatné datum' });
    const r = await pool.query(
      `UPDATE orders SET status='pending', reject_reason=NULL
       WHERE order_group_id=$1 AND datum=$2 AND status IN ('pre_approved','pre_rejected') RETURNING id`,
      [groupId, datum]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Žádné předběžně rozhodnuté řádky pro tento den' });
    res.json({ ok: true, updated: r.rowCount });
  } catch(err) {
    console.error('PATCH reset error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// PATCH /api/orders/:groupId/finalize
app.patch('/api/orders/:groupId/finalize', requireAuth, requireAdmin, requireOrdersEnabled, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(groupId))
      return res.status(400).json({ error: 'Neplatné ID skupiny' });

    const pCheck = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM orders WHERE order_group_id=$1 AND status='pending'`, [groupId]
    );
    if (parseInt(pCheck.rows[0].cnt) > 0)
      return res.status(400).json({ error: 'Nelze finalizovat: některé dny jsou stále pending' });

    const activeCheck = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM orders WHERE order_group_id=$1 AND status IN ('pre_approved','pre_rejected')`,
      [groupId]
    );
    if (parseInt(activeCheck.rows[0].cnt) === 0)
      return res.status(404).json({ error: 'Skupina nenalezena nebo již finalizována' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const approvedRows = await client.query(
        `UPDATE orders SET status='approved', resolved_at=NOW(), resolved_by=$1
         WHERE order_group_id=$2 AND status='pre_approved'
         RETURNING datum,smes,itt,tuny,lokalita,lat,lng,firma`,
        [req.session.userId, groupId]
      );
      await client.query(
        `UPDATE orders SET status='rejected', resolved_at=NOW(), resolved_by=$1
         WHERE order_group_id=$2 AND status='pre_rejected'`,
        [req.session.userId, groupId]
      );
      await client.query('COMMIT');

      // Propsat schválené do week_data
      if (approvedRows.rows.length > 0) {
        const byWeek = {};
        for (const item of approvedRows.rows) {
          const datum = item.datum instanceof Date ? item.datum.toISOString().slice(0,10) : String(item.datum).slice(0,10);
          const d = new Date(datum + 'T00:00:00Z');
          const daysFromMonday = (d.getUTCDay() + 6) % 7;
          const monday = new Date(d);
          monday.setUTCDate(d.getUTCDate() - daysFromMonday);
          const weekStart = monday.toISOString().slice(0,10);
          if (!byWeek[weekStart]) byWeek[weekStart] = [];
          byWeek[weekStart].push({ ...item, datum, di: daysFromMonday });
        }
        for (const [weekStart, weekItems] of Object.entries(byWeek)) {
          const wRes = await pool.query('SELECT rows_json FROM week_data WHERE week_start=$1', [weekStart]);
          const rows = wRes.rows[0] ? JSON.parse(wRes.rows[0].rows_json) : [];
          for (const item of weekItems) {
            const newRow = {
              checked:false,cislo:'',lokalita:item.lokalita||'',objednavka:item.firma||'',
              smes:item.smes||'',itt:item.itt||'',ceta:item.firma||'',
              lat:item.lat!=null?parseFloat(item.lat):null,lng:item.lng!=null?parseFloat(item.lng):null,
              d0:0,d1:0,d2:0,d3:0,d4:0,d5:0,d6:0
            };
            newRow[`d${item.di}`] = parseInt(item.tuny)||0;
            rows.push(newRow);
          }
          await pool.query(
            `INSERT INTO week_data(week_start,rows_json,updated_at) VALUES($1,$2,NOW())
             ON CONFLICT(week_start) DO UPDATE SET rows_json=EXCLUDED.rows_json,updated_at=NOW()`,
            [weekStart, JSON.stringify(rows)]
          );
        }
        console.log(`Objednávka ${groupId} finalizována: ${approvedRows.rows.length} řádků do harmonogramu`);
      }
      res.json({ ok: true, approved: approvedRows.rows.length });
      // Email uživateli — fire & forget
      sendOrderFinalizedEmail(groupId)
        .catch(err => console.error('sendOrderFinalizedEmail (finalize) error:', err.message));
    } catch(err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch(err) {
    console.error('PATCH finalize error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// PATCH /api/orders/:groupId/reject-all
app.patch('/api/orders/:groupId/reject-all', requireAuth, requireAdmin, requireOrdersEnabled, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(groupId))
      return res.status(400).json({ error: 'Neplatné ID skupiny' });
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Důvod zamítnutí je povinný' });
    const reasonStr = sanitizeStr(String(reason).trim(), 500);
    const r = await pool.query(
      `UPDATE orders SET status='rejected',resolved_at=NOW(),resolved_by=$1,reject_reason=$2
       WHERE order_group_id=$3 AND status IN ('pending','pre_approved','pre_rejected') RETURNING id`,
      [req.session.userId, reasonStr, groupId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Skupina nenalezena nebo již vyřešena' });
    console.log(`Objednávka ${groupId} celá zamítnuta adminem ${req.session.username}`);
    res.json({ ok: true, rejected: r.rowCount });
    // Email uživateli — fire & forget
    sendOrderFinalizedEmail(groupId)
      .catch(err => console.error('sendOrderFinalizedEmail (reject-all) error:', err.message));
  } catch(err) {
    console.error('PATCH reject-all error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// ── SMTP nastavení (jen admin) ──
app.get('/api/smtp-settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT key,value FROM settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_password','smtp_from','smtp_admin_emails')"
    );
    const s = {};
    r.rows.forEach(row => {
      if (row.key === 'smtp_password') {
        s.smtp_password_set = !!row.value; // heslo nikdy nevracíme
      } else {
        s[row.key] = row.value;
      }
    });
    res.json(s);
  } catch(err) {
    console.error('GET /api/smtp-settings error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

app.post('/api/smtp-settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { smtp_host, smtp_port, smtp_user, smtp_password, smtp_from, smtp_admin_emails } = req.body;
    const fields = {
      smtp_host:         smtp_host         != null ? sanitizeStr(String(smtp_host), 255)         : null,
      smtp_port:         smtp_port         != null ? sanitizeStr(String(smtp_port), 10)           : null,
      smtp_user:         smtp_user         != null ? sanitizeStr(String(smtp_user), 255)          : null,
      smtp_from:         smtp_from         != null ? sanitizeStr(String(smtp_from), 255)          : null,
      smtp_admin_emails: smtp_admin_emails != null ? sanitizeStr(String(smtp_admin_emails), 1000) : null,
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) continue;
      await pool.query(
        "INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
        [k, v]
      );
    }
    // Heslo — ukládáme jen pokud je neprázdné (prázdné pole = neměnit)
    if (smtp_password && String(smtp_password).trim()) {
      await pool.query(
        "INSERT INTO settings (key,value) VALUES ('smtp_password',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
        [String(smtp_password).slice(0, 500)]
      );
    }
    res.json({ ok: true });
  } catch(err) {
    console.error('POST /api/smtp-settings error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

app.post('/api/smtp-settings/test', requireAuth, requireAdmin, async (req, res) => {
  try {
    const settings = await getSmtpSettings();
    if (!settings.smtp_host || !settings.smtp_user) {
      return res.status(400).json({ ok: false, error: 'SMTP není nakonfigurováno (chybí host nebo uživatel)' });
    }
    const adminEmails = settings.smtp_admin_emails;
    if (!adminEmails) {
      return res.status(400).json({ ok: false, error: 'Nejsou nastaveny admin emaily — nevím kam poslat testovací email' });
    }
    const transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: parseInt(settings.smtp_port) || 587,
      secure: parseInt(settings.smtp_port) === 465,
      auth: { user: settings.smtp_user, pass: settings.smtp_password || '' },
      tls: { rejectUnauthorized: false }
    });
    const now = new Date().toLocaleString('cs-CZ', { timeZone: 'UTC' });
    await transporter.sendMail({
      from: settings.smtp_from || settings.smtp_user,
      to: adminEmails,
      subject: 'HMG – testovací email',
      text: `Testovací email z HMG systému.\nOdesláno: ${now}`,
      html: `<p>Testovací email z HMG systému.</p><p>Odesláno: <strong>${now}</strong></p>`
    });
    res.json({ ok: true, message: `Testovací email odeslán na: ${adminEmails}` });
  } catch(err) {
    console.error('POST /api/smtp-settings/test error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Záloha - poslední datum ──
app.get('/api/backup/last', requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query("SELECT value FROM settings WHERE key='last_backup'");
  res.json({ last: r.rows[0] ? r.rows[0].value : null });
});


// ── Dashboard API ─────────────────────────────────────────────────────────────
// Vrací agregovaná data pro /dashboard stránku.
// role=admin → vidí objednávky všech firem; ostatní → jen svoji firmu.
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const uRes = await pool.query('SELECT role, firma FROM users WHERE id=$1', [req.session.userId]);
    const role  = (uRes.rows[0] && uRes.rows[0].role)  || req.session.role;
    const firma = (uRes.rows[0] && uRes.rows[0].firma) || null;

    // "Od dneška" = datum >= dnešní datum (UTC)
    let pendingList, confirmedCount, confirmedList, recentOrders;

    let confirmedTons;

    if (role === 'admin') {
      // Admin: vidí všechny firmy
      const [pRes, cRes, clRes, rRes] = await Promise.all([
        pool.query(
          `SELECT o.*, u.username
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           WHERE o.status IN ('pending','pre_approved','pre_rejected')
           ORDER BY o.created_at ASC`
        ),
        // COUNT + SUM v jednom dotazu — bez extra round-tripu
        pool.query(
          `SELECT COUNT(*) AS cnt,
                  COALESCE(SUM(tuny), 0) AS tons
           FROM orders
           WHERE status = 'approved' AND datum >= CURRENT_DATE`
        ),
        pool.query(
          `SELECT o.*, u.username
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           WHERE o.status = 'approved' AND o.datum >= CURRENT_DATE
           ORDER BY o.datum ASC`
        ),
        pool.query(
          `SELECT o.*, u.username
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           ORDER BY o.created_at DESC LIMIT 10`
        ),
      ]);
      pendingList    = pRes.rows;
      confirmedCount = parseInt(cRes.rows[0].cnt,  10);
      confirmedTons  = parseInt(cRes.rows[0].tons, 10);
      confirmedList  = clRes.rows;
      recentOrders   = rRes.rows;
    } else {
      // hmg_share / ostatní: scoped na firmu uživatele
      const firmaParam = firma || '';
      const [pRes, cRes, clRes, rRes] = await Promise.all([
        pool.query(
          `SELECT * FROM orders
           WHERE firma=$1 AND status IN ('pending','pre_approved','pre_rejected')
           ORDER BY created_at ASC`,
          [firmaParam]
        ),
        // COUNT + SUM v jednom dotazu
        pool.query(
          `SELECT COUNT(*) AS cnt,
                  COALESCE(SUM(tuny), 0) AS tons
           FROM orders
           WHERE firma=$1 AND status = 'approved' AND datum >= CURRENT_DATE`,
          [firmaParam]
        ),
        pool.query(
          `SELECT * FROM orders
           WHERE firma=$1 AND status='approved' AND datum >= CURRENT_DATE
           ORDER BY datum ASC`,
          [firmaParam]
        ),
        pool.query(
          `SELECT * FROM orders WHERE firma=$1 ORDER BY created_at DESC LIMIT 10`,
          [firmaParam]
        ),
      ]);
      pendingList    = pRes.rows;
      confirmedCount = parseInt(cRes.rows[0].cnt,  10);
      confirmedTons  = parseInt(cRes.rows[0].tons, 10);
      confirmedList  = clRes.rows;
      recentOrders   = rRes.rows;
    }

    res.json({
      role,
      firma,
      pending:        pendingList.length,
      pending_list:   pendingList,
      confirmed:      confirmedCount,
      confirmed_list: confirmedList,
      confirmed_tons: confirmedTons,
      recent:         recentOrders,
    });
  } catch (err) {
    console.error('GET /api/dashboard error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// ── Start ──
console.log('=== HMG v2.3 PostgreSQL + Auth ===');
app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start serveru s retry připojením k DB ────────────────────────────────────
// Při startu na Railway DB někdy potřebuje chvíli navíc – místo okamžitého
// pádu zkoušíme připojení MAX_RETRIES-krát s RETRY_DELAY_MS prodlevou.
async function startServer() {
  const MAX_RETRIES = 10;
  const RETRY_DELAY = 3000; // ms

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[${new Date().toISOString()}] Inicializace DB (pokus ${attempt}/${MAX_RETRIES})…`);
      await initDb();
      console.log(`[${new Date().toISOString()}] DB inicializována úspěšně.`);
      break; // ── úspěch → pokračuj za smyčku ──
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.error(`[${new Date().toISOString()}] DB zatím nedostupná (pokus ${attempt}/${MAX_RETRIES}): ${err.message} – zkouším znovu za ${RETRY_DELAY / 1000} s…`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        logError(`DB init selhala po ${MAX_RETRIES} pokusech – server se ukončuje`, err);
        process.exit(1);
      }
    }
  }

  app.listen(PORT, () => console.log(`[${new Date().toISOString()}] Server běží na portu ${PORT}`));
  if (process.env.GMAIL_USER) scheduleBackup();
  // Auto-cleanup rejected objednávek — běží vždy, nezávisle na GMAIL
  const MS_DAY = 24 * 60 * 60 * 1000;
  cleanupRejectedOrders(); // jednou při startu
  setInterval(cleanupRejectedOrders, MS_DAY); // pak každý den
  console.log(`[${new Date().toISOString()}] Auto-cleanup rejected objednávek: nastaven (každých 24h)`);
}

// ── Spuštění nebo export ──────────────────────────────────────────────────────
// require.main === module  →  přímé spuštění `node server.js`  →  startServer()
// require('../server')     →  import z testu                   →  exportuj API
if (require.main === module) {
  startServer();
} else {
  // Tier 1 testy (mocky): importují čisté funkce + sendBackup/restoreFromSnapshot
  // Tier 2 testy (supertest): navíc potřebují app, pool, initDb pro HTTP testy s reálnou DB
  module.exports = {
    // Čisté utility funkce (Tier 1)
    isIsoDate, isIntOrEmpty, sanitizeStr, validateRows, fv, fmtDateCz, escHtml,
    // Záloha + obnova (Tier 1 integrační)
    sendBackup, restoreFromSnapshot,
    // HTTP + DB přístup (Tier 2 supertest)
    app, pool, initDb,
  };
}
