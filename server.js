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
const helmet = require('helmet');
const { parseVazenky } = require('./lib/vazenky-parser');
const { buildMonthWorkbook } = require('./lib/month-export');
const { migrateObalovny, listObalovny, normalizeModuly, getObalovnaModuly, updateObalovnaModuly } = require('./lib/obalovny');
const { migrateObalovnaId, migrateSingleRowConfigUnique, migrateObalovnaSettings, migrateWeekDataCompositePk } = require('./lib/obalovna-id');
const { migrateAudit, logAudit, listAudit } = require('./lib/audit');

// ── Verze aplikace (jeden zdroj pravdy — zvednout ručně při každém vydání) ──
const APP_VERSION = '4.82';

const app = express();
app.set('trust proxy', 1);

// ── Bezpečnostní hlavičky (helmet) ──
// CSP whitelist odpovídá inventáři externích zdrojů ve public/*.html:
//   - Inline <script>/<style> a inline handlery (onclick) → 'unsafe-inline'
//   - Leaflet (mapa) z unpkg.com; Inter font z Google Fonts; OSM tiles + embed iframe
//   - Geocoding: Mapy.cz + OSM Nominatim
// crossOriginEmbedderPolicy a crossOriginResourcePolicy vypnuté kvůli mapám
// (jinak by se OSM tile servery a Mapy.cz API odmítaly načítat).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      // scriptSrcAttr je v helmet defaults nastavený na 'none' a blokoval by
      // inline onclick/onchange handlery — explicitně povolíme 'unsafe-inline'.
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com"],
      imgSrc:         ["'self'", "data:", "blob:", "https://*.tile.openstreetmap.org", "https://unpkg.com"],
      connectSrc:     ["'self'", "https://api.mapy.cz", "https://nominatim.openstreetmap.org"],
      fontSrc:        ["'self'", "data:", "https://fonts.gstatic.com"],
      frameSrc:       ["'self'", "https://www.openstreetmap.org"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      frameAncestors: ["'none'"],  // anti-clickjacking — appka neběží v iframu
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  // hsts, noSniff, referrerPolicy, frameguard zůstávají na helmet defaults
}));

// ── P2 #5: DIAGNOSTICKÁ Report-Only CSP (NEBLOKUJE) ─────────────────────────────
// Přísná politika BEZ 'unsafe-inline' pro skripty — jen HLÁSÍ porušení (do konzole
// jako "[Report Only] Refused to execute inline…"), NIC nezakazuje. Ostrá CSP výše
// (s 'unsafe-inline') zůstává jediná vynucovaná → nic se nerozbije. Slouží k mapování
// zbývajících inline skriptů/on* handlerů před ostrým zrušením 'unsafe-inline'.
// Zrcadlí ostrou CSP, JEN script-src je bez 'unsafe-inline' a script-src-attr 'none'.
app.use(helmet.contentSecurityPolicy({
  useDefaults: true,
  reportOnly: true,
  directives: {
    defaultSrc:     ["'self'"],
    scriptSrc:      ["'self'", "https://unpkg.com"],   // BEZ 'unsafe-inline' (diagnostika)
    scriptSrcAttr:  ["'none'"],                        // zachytí inline on* handlery
    styleSrc:       ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com"],
    imgSrc:         ["'self'", "data:", "blob:", "https://*.tile.openstreetmap.org", "https://unpkg.com"],
    connectSrc:     ["'self'", "https://api.mapy.cz", "https://nominatim.openstreetmap.org"],
    fontSrc:        ["'self'", "data:", "https://fonts.gstatic.com"],
    frameSrc:       ["'self'", "https://www.openstreetmap.org"],
    objectSrc:      ["'none'"],
    baseUri:        ["'self'"],
    frameAncestors: ["'none'"],
  },
}));

// ── Rate limiting na login (5 pokusů / 5 minut) ──
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    res.status(429).json({ error: 'Příliš mnoho pokusů. Zkuste to za 5 minut.' });
  }
});

// ── Rate-limity na zápisové / upload / backup endpointy (P1 #3) ──────────────────
// Čtecí GET endpointy ZÁMĚRNĚ NElimitujeme (volají se často). 429 se vrací přímo
// z handleru limiteru. Trust proxy (app.set('trust proxy',1)) zajistí limit per reálnou IP.
const TOO_MANY = { error: 'Příliš mnoho požadavků, zkuste za chvíli.' };
const tooManyHandler = (req, res) => res.status(429).json(TOO_MANY);

// a) Upload (multer): 10 / 15 min per IP
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, handler: tooManyHandler });
// b) Zápisové mutace: 60 / 1 min per IP
const writeLimiter  = rateLimit({ windowMs: 60 * 1000,      max: 60, handler: tooManyHandler });
// c) Backup: 5 / 1 h per IP
const backupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5,  handler: tooManyHandler });

// Aplikuje limiter JEN na mutující metody (GET/HEAD/OPTIONS = čtení → bez limitu).
function mutatingOnly(limiter) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return limiter(req, res, next);
  };
}
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

    -- Per-user povolení objednávkového systému (relevantní pro hmg_share) — default vypnuto
    ALTER TABLE users ADD COLUMN IF NOT EXISTS orders_allowed BOOLEAN NOT NULL DEFAULT false;

    -- HMG V5 — vážní data (váženky z exportu váhy)
    CREATE TABLE IF NOT EXISTS vazenky (
      id              SERIAL PRIMARY KEY,
      cislo_vazenky   TEXT NOT NULL UNIQUE,
      datum           DATE NOT NULL,
      cas             TEXT,
      smes            TEXT,
      itt             TEXT,
      tuny            NUMERIC(10,3) NOT NULL,
      spz             TEXT,
      ridic           TEXT,
      stavba          TEXT,
      nazev_partnera  TEXT,
      ico             TEXT,
      firma_taxis     TEXT,
      uploaded_at     TIMESTAMPTZ DEFAULT NOW(),
      uploaded_by     INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_vazenky_datum       ON vazenky(datum);
    CREATE INDEX IF NOT EXISTS idx_vazenky_firma_taxis ON vazenky(firma_taxis);
    CREATE INDEX IF NOT EXISTS idx_vazenky_stavba      ON vazenky(stavba);

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

  // Výchozí hodnota přepínače sdílení "Odebrané stavby" (váženky) pro hmg_share — default vypnuto
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('vazenky_share_enabled', 'false') ON CONFLICT (key) DO NOTHING`
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

  // ── Organizační struktura TAXIS (multi-obalovna) ──
  // Čistě aditivní: založí novou tabulku `obalovny` + první obalovnu Holubice.
  // Idempotentní (IF NOT EXISTS / ON CONFLICT DO NOTHING) — nemění stávající data.
  await migrateObalovny(pool);

  // ── Multi-obalovna krok 2: sloupec obalovna_id do datových tabulek ──
  // Čistě aditivní/idempotentní: ADD COLUMN IF NOT EXISTS ... DEFAULT 'holubice' (+FK, index).
  // V tomto kroku se podle obalovna_id NEFILTRUJE — appka vrací přesně totéž.
  await migrateObalovnaId(pool);

  // ── Audit / log událostí (dávka D) — nová tabulka audit_log (aditivní) ──
  await migrateAudit(pool);

  // ── Krok 3b: single-row config tabulky per-obalovna — UNIQUE(obalovna_id) ──
  await migrateSingleRowConfigUnique(pool);

  // ── Krok 3/6: settings per-obalovna — nová tabulka obalovna_settings (+seed Holubice) ──
  // Běží PO seedech settings (orders_enabled/vazenky_share_enabled výše) i PO migrateObalovny
  // (Holubice existuje pro FK). Aditivní/idempotentní — nemění `settings`.
  await migrateObalovnaSettings(pool);

  // ── week_data: složený PK (week_start, obalovna_id) — oprava globálního PK ──
  // Běží PO migrateObalovnaId (obalovna_id NOT NULL). Idempotentní, aditivní (data se nemění).
  await migrateWeekDataCompositePk(pool);
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
    sameSite: 'strict',
    // secure: true pouze pokud běží za HTTPS (produkce); lokálně false
    secure: process.env.NODE_ENV === 'production' || process.env.HTTPS === 'true'
  }
}));

// Statické soubory (CSS, JS, obrázky) - bez auth
// HTML soubory jsou chráněny přes explicitní routes níže
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,  // Nezobrazovat index.html automaticky
  extensions: [], // Nezkoušet přidat přípony
  setHeaders: (res, filePath) => {
    // PWA manifest se správným MIME (jinak by .json bylo application/json).
    if (filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    }
  }
}));

// ── Rate-limit zápisových mutací (POST/PUT/PATCH/DELETE) na vybrané prefixy ──
// Čtecí GET (např. /api/weeks, /api/companies, /api/inputs, /api/week/:start) NElimitováno
// (mutatingOnly přeskočí GET; navíc /api/weeks není prefix /api/week/). Mountováno PŘED routami.
app.use(['/api/week', '/api/orders', '/api/users', '/api/companies', '/api/inputs'], mutatingOnly(writeLimiter));

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

// Superadmin stojí NAD obalovnami (multi-obalovna, krok 4). NENÍ to admin obalovny —
// requireAdmin ho záměrně NEpustí (a naopak), aby se role nemíchaly. Chrání superadmin
// rozhraní (/api/obalovny a budoucí). Roli nelze nastavit přes API (jen seed skript).
function requireSuperadmin(req, res, next) {
  if (req.session && req.session.role === 'superadmin') return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Nedostatečná oprávnění (jen superadmin)' });
  }
  res.redirect('/login');
}

// Pojistka předatelnosti: posledního/jediného superadmina nelze smazat (systém nesmí
// zůstat bez správce). Čistá funkce kvůli testovatelnosti.
function isLastSuperadmin(superadminCount) {
  return superadminCount <= 1;
}

// Náhodné dočasné heslo (kryptograficky, bez nejednoznačných znaků 0/O/1/l/I).
// Použito při resetu hesla admina superadminem — vrací se JEN superadminovi, NIKDY se neloguje.
function generateTempPassword(length = 14) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += charset[bytes[i] % charset.length];
  return out;
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
// FAIL-CLOSED: při chybě DB raději odmítnout než tiše pustit přes neověřený stav.
async function requireOrdersEnabled(req, res, next) {
  try {
    // KASKÁDA krok 6: STROP obalovny (mod_objednavky) má přednost. Když superadmin modul
    // nepovolil, objednávky jsou vypnuté bez ohledu na settings.orders_enabled.
    const moduly = await getObalovnaModuly(pool, getObalovnaId(req));
    if (!moduly.mod_objednavky) return res.status(403).json({ error: 'Objednávkový modul není pro tuto obalovnu povolen' });
    const oe = await getObalovnaSetting(getObalovnaId(req), 'orders_enabled');  // per-obalovna
    const enabled = oe === null || oe !== 'false';   // chybí řádek = výchozí zapnuto (jako dřív)
    if (!enabled) return res.status(403).json({ error: 'Objednávkový systém je vypnut' });
    // Per-user: hmg_share musí mít navíc orders_allowed=true (admin/operátor neomezeni tímto příznakem).
    // Globální vypnutí má přednost (řeší se výše). Hodnota se bere z DB, nikdy z klienta.
    if (req.session.role === 'hmg_share') {
      const u = await pool.query('SELECT orders_allowed FROM users WHERE id=$1', [req.session.userId]);
      const allowed = !!(u.rows[0] && u.rows[0].orders_allowed === true);
      if (!allowed) return res.status(403).json({ error: 'Objednávky nemáte povolené' });
    }
    next();
  } catch(err) {
    console.error('requireOrdersEnabled: chyba čtení settings.orders_enabled, FAIL-CLOSED:', err.message);
    return res.status(503).json({ error: 'Objednávky dočasně nedostupné (chyba ověření stavu)' });
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
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', requireAuth, (req, res) => {
  // superadmin stojí nad obalovnami → nevstupuje do harmonogramu, ale na rozcestník
  if (req.session.role === 'superadmin') return res.redirect('/superadmin');
  // hmg_share vidí dashboard (má tam tlačítko do month-view)
  if (req.session.role === 'hmg_share') return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rozcestník superadmina (seznam obaloven) — jen pro roli superadmin.
app.get('/superadmin', requireAuth, requireSuperadmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'superadmin.html'));
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

// ── Aktivní obalovna přihlášeného uživatele (multi-obalovna, krok 3) ──
// Zdroj pravdy = session (nastaveno při loginu z users.obalovna_id). Default 'holubice'
// kvůli starším sessions bez tohoto pole i kvůli Holubici. NEzávisí na subdoméně/routingu.
// Slouží jako DALŠÍ podmínka v dotazech vedle stávajícího role/firma scopingu (ne náhrada).
// Superadmin NEMÁ konkrétní obalovnu → vrací null. Datové dotazy mají `obalovna_id = $1`,
// takže s null nevrátí žádný řádek (prázdno) — superadmin nevidí data žádné obalovny jako
// její uživatel. Pro běžné role default 'holubice' (i pro starší sessions bez pole).
function getObalovnaId(req) {
  if (req.session && req.session.role === 'superadmin') return null;
  return (req.session && req.session.obalovnaId) || 'holubice';
}

// ── Auth API ──
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const ipMeta = req.ip || null, hostMeta = req.hostname || null;
    if (!username || !password) return res.status(400).json({ error: 'Vyplňte jméno a heslo' });
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user) {
      // AUDIT: neúspěšný login (jen zadané jméno + ip/hostname; NIKDY heslo).
      logAudit(pool, { typ: 'login_fail', akter: String(username).slice(0, 100), ip: ipMeta, hostname: hostMeta });
      return res.status(401).json({ error: 'Nesprávné jméno nebo heslo' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      logAudit(pool, { typ: 'login_fail', akter: String(username).slice(0, 100), ip: ipMeta, hostname: hostMeta });
      return res.status(401).json({ error: 'Nesprávné jméno nebo heslo' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    // Aktivní obalovna uživatele (multi-obalovna). Default 'holubice' kdyby chybělo.
    req.session.obalovnaId = user.obalovna_id || 'holubice';
    req.session.userAgent = req.headers['user-agent'] || '';
    req.session.loginIp = req.ip || '';
    req.session.mustChangePassword = !!user.must_change_password;
    await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);
    // AUDIT: úspěšný login.
    logAudit(pool, { typ: 'login_ok', akter: user.username, role: user.role,
      obalovna_id: user.role === 'superadmin' ? null : (user.obalovna_id || 'holubice'), ip: ipMeta, hostname: hostMeta });
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
    const r = await pool.query('SELECT firma, orders_allowed FROM users WHERE id=$1', [req.session.userId]);
    const firma = r.rows[0] ? r.rows[0].firma : null;
    const ordersAllowed = !!(r.rows[0] && r.rows[0].orders_allowed === true);
    res.json({
      username: req.session.username,
      role: req.session.role,
      userId: req.session.userId,
      firma,
      orders_allowed: ordersAllowed,
      mustChangePassword: req.session.mustChangePassword || false
    });
  } catch(err) {
    res.json({ username: req.session.username, role: req.session.role, userId: req.session.userId, firma: null });
  }
});

// ── Data API (chráněno přihlášením) ──
app.get('/api/week/:start', requireAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT rows_json FROM week_data WHERE week_start=$1 AND obalovna_id=$2',
    [req.params.start, getObalovnaId(req)]
  );
  res.json(r.rows[0] ? JSON.parse(r.rows[0].rows_json) : null);
});

app.post('/api/week/:start', requireAuth, requireAdmin, async (req, res) => {
  if (req.session.role === 'operator') return res.status(403).json({ error: 'Nedostatečná oprávnění' });
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
    `INSERT INTO week_data (week_start,rows_json,obalovna_id,updated_at) VALUES($1,$2,$3,NOW())
     ON CONFLICT(week_start,obalovna_id) DO UPDATE SET rows_json=EXCLUDED.rows_json, updated_at=NOW()`,
    [req.params.start, JSON.stringify(safeRows), getObalovnaId(req)]
  );
  res.json({ ok: true });
});

app.get('/api/weeks', requireAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT week_start,rows_json FROM week_data WHERE obalovna_id=$1 ORDER BY week_start',
    [getObalovnaId(req)]
  );
  res.json(r.rows.map(r => ({ start: r.week_start, rows: JSON.parse(r.rows_json) })));
});

// Export měsíčního harmonogramu: .xlsx, 12 listů (Leden…Prosinec) pro daný rok (default = aktuální).
// Přístup jako month-view (requireAuth) — vidí admin/operátor/hmg_share, všechny firmy.
app.get('/api/month/export', requireAuth, async (req, res) => {
  // Operátor nemá export harmonogramu (admin a hmg_share beze změny).
  if (req.session.role === 'operator') return res.status(403).json({ error: 'Nemáte oprávnění' });
  try {
    let year = parseInt(req.query.year, 10);
    if (isNaN(year) || year < 2000 || year > 2100) year = new Date().getFullYear();

    const obalovnaId = getObalovnaId(req);
    const [wRes, cRes] = await Promise.all([
      pool.query('SELECT week_start,rows_json FROM week_data WHERE obalovna_id=$1 ORDER BY week_start', [obalovnaId]),
      pool.query('SELECT data_json FROM companies WHERE obalovna_id=$1', [obalovnaId]),
    ]);
    const weeks = wRes.rows.map(r => ({ start: r.week_start, rows: JSON.parse(r.rows_json) }));
    const companies = cRes.rows[0] ? JSON.parse(cRes.rows[0].data_json) : [];

    const wb = buildMonthWorkbook({ weeks, companies, year });
    const buf = await wb.xlsx.writeBuffer();

    const fullName = `harmonogram ${year}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${fullName}"; filename*=UTF-8''${encodeURIComponent(fullName)}`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('GET /api/month/export error:', err);
    res.status(500).json({ error: 'Chyba serveru při generování měsíčního exportu' });
  }
});

app.get('/api/month-entries', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT data_json FROM month_entries WHERE obalovna_id=$1', [getObalovnaId(req)]);
  res.json(r.rows[0] ? JSON.parse(r.rows[0].data_json) : {});
});

app.post('/api/month-entries', requireAuth, requireAdmin, async (req, res) => {
  // Krok 3b: upsert podle obalovna_id (NE natvrdo id=1) — cizí obalovna nepřepíše Holubici.
  // id je leftover surrogate PK → novému řádku přidělíme volné MAX+1; u existující obalovny
  // se na konfliktu obalovna_id jen aktualizuje data.
  await pool.query(
    `INSERT INTO month_entries (id,data_json,obalovna_id,updated_at)
     VALUES((SELECT COALESCE(MAX(id),0)+1 FROM month_entries),$1,$2,NOW())
     ON CONFLICT(obalovna_id) DO UPDATE SET data_json=EXCLUDED.data_json, updated_at=NOW()`,
    [JSON.stringify(req.body), getObalovnaId(req)]
  );
  res.json({ ok: true });
});

app.get('/api/inputs', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT rows_json FROM inputs WHERE obalovna_id=$1', [getObalovnaId(req)]);
  res.json(r.rows[0] ? JSON.parse(r.rows[0].rows_json) : null);
});

app.post('/api/inputs', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = req.body;
  // Krok 3b: upsert podle obalovna_id (NE natvrdo id=1).
  await pool.query(
    `INSERT INTO inputs (id,rows_json,obalovna_id,updated_at)
     VALUES((SELECT COALESCE(MAX(id),0)+1 FROM inputs),$1,$2,NOW())
     ON CONFLICT(obalovna_id) DO UPDATE SET rows_json=EXCLUDED.rows_json, updated_at=NOW()`,
    [JSON.stringify(rows), getObalovnaId(req)]
  );
  res.json({ ok: true });
});

app.get('/api/companies', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT data_json FROM companies WHERE obalovna_id=$1', [getObalovnaId(req)]);
  res.json(r.rows[0] ? JSON.parse(r.rows[0].data_json) : null);
});

app.post('/api/companies', requireAuth, requireAdmin, async (req, res) => {
  const { companies } = req.body;
  if (!Array.isArray(companies) || companies.length > 20) return res.status(400).json({ error: 'companies musí být pole max 20 položek' });
  for (const c of companies) {
    if (!c.name || typeof c.name !== 'string') return res.status(400).json({ error: 'každá firma musí mít name' });
    if (c.color && !/^#[0-9a-fA-F]{3,6}$/.test(c.color)) return res.status(400).json({ error: 'neplatný formát barvy' });
  }
  // Krok 3b: upsert podle obalovna_id (NE natvrdo id=1).
  await pool.query(
    `INSERT INTO companies (id,data_json,obalovna_id,updated_at)
     VALUES((SELECT COALESCE(MAX(id),0)+1 FROM companies),$1,$2,NOW())
     ON CONFLICT(obalovna_id) DO UPDATE SET data_json=EXCLUDED.data_json, updated_at=NOW()`,
    [JSON.stringify(companies), getObalovnaId(req)]
  );
  res.json({ ok: true });
});

app.get('/api/settings', requireAuth, async (req, res) => {
  const obalovnaId = getObalovnaId(req);
  const obj = {};
  // 1) Globální nesenzitivní klíče ze `settings` (např. last_backup*). Vyloučíme:
  //    smtp_* (citlivé), share_* (tokeny — vlastní endpoint) a CONFIG_KEYS (per-obalovna níže).
  const g = await pool.query('SELECT key,value FROM settings');
  g.rows.forEach(row => {
    if (row.key.startsWith('smtp_') || row.key.startsWith('share_')) return;
    if (CONFIG_KEYS.includes(row.key)) return;
    obj[row.key] = row.value;
  });
  // 2) Per-obalovna konfigurace aktivní obalovny z `obalovna_settings`.
  if (obalovnaId) {
    const o = await pool.query(
      'SELECT key,value FROM obalovna_settings WHERE obalovna_id=$1 AND key = ANY($2::text[])',
      [obalovnaId, CONFIG_KEYS]
    );
    o.rows.forEach(row => { obj[row.key] = row.value; });
  }
  res.json(obj);
});

app.post('/api/settings', requireAuth, requireAdmin, async (req, res) => {
  const obalovnaId = getObalovnaId(req);
  if (!obalovnaId) return res.status(403).json({ error: 'Superadmin nemá konfiguraci obalovny' });
  const allowed = ['hmg_max_daily', 'hmg_min_daily', 'hmg_plant_rate', 'hmg_gas_capacity', 'orders_enabled', 'vazenky_share_enabled'];
  // KASKÁDA krok 6: zapnout (true) přepínač lze JEN když je odpovídající modul obalovny
  // povolen shora (superadmin strop). Vypnout (false) jde vždy. Holubice má oba moduly true.
  const moduly = await getObalovnaModuly(pool, obalovnaId);
  for (const [k, v] of Object.entries(req.body)) {
    if (!allowed.includes(k)) continue;
    if (['hmg_max_daily', 'hmg_min_daily', 'hmg_plant_rate', 'hmg_gas_capacity'].includes(k)) {
      const n = parseInt(v, 10);
      if (isNaN(n) || n <= 0 || n > 1000000) return res.status(400).json({ error: `${k} musí být kladné číslo` });
    }
    if (k === 'orders_enabled' || k === 'vazenky_share_enabled') {
      if (v !== 'true' && v !== 'false') return res.status(400).json({ error: `${k} musí být true nebo false` });
      if (v === 'true' && k === 'orders_enabled' && !moduly.mod_objednavky) {
        return res.status(403).json({ error: 'Modul Objednávky není pro tuto obalovnu povolen' });
      }
      if (v === 'true' && k === 'vazenky_share_enabled' && !moduly.mod_vazenky) {
        return res.status(403).json({ error: 'Modul Váženky není pro tuto obalovnu povolen' });
      }
    }
    await setObalovnaSetting(obalovnaId, k, v);   // per-obalovna zápis
  }
  res.json({ ok: true });
});

app.get('/api/export', requireAuth, requireOperator, async (req, res) => {
  // Operátor nemá export harmonogramu (jen admin).
  if (req.session.role === 'operator') return res.status(403).json({ error: 'Nemáte oprávnění' });
  const r = await pool.query(
    'SELECT week_start,rows_json FROM week_data WHERE obalovna_id=$1 ORDER BY week_start', [getObalovnaId(req)]);
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
    const obalovnaId = getObalovnaId(req);   // scope: maž JEN týdny vlastní obalovny
    await pool.query('DELETE FROM week_data WHERE obalovna_id=$1', [obalovnaId]);
    await pool.query('DELETE FROM month_entries WHERE obalovna_id=$1', [obalovnaId]);
    console.log(`Admin smazal data týdnů (obalovna ${obalovnaId})`);
    res.json({ ok: true });
  } catch(err) {
    console.error('clear-weeks error:', err);
    res.status(500).json({ ok: false, error: 'Interní chyba serveru' });
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
    res.status(500).json({ ok: false, error: 'Interní chyba serveru' });
  }
});

app.post('/api/import-excel', requireAuth, requireAdmin, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Žádný soubor' });
  try {
    const obalovnaId = getObalovnaId(req);   // krok 3b: zápisy patří aktivní obalovně
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
        `INSERT INTO inputs (id,rows_json,obalovna_id,updated_at)
         VALUES((SELECT COALESCE(MAX(id),0)+1 FROM inputs),$1,$2,NOW())
         ON CONFLICT(obalovna_id) DO UPDATE SET rows_json=EXCLUDED.rows_json,updated_at=NOW()`,
        [JSON.stringify(receptury), obalovnaId]
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
        `INSERT INTO week_data (week_start,rows_json,obalovna_id,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(week_start,obalovna_id) DO UPDATE SET rows_json=EXCLUDED.rows_json,updated_at=NOW()`,
        [ws, JSON.stringify(rows), obalovnaId]
      );
    }
    if (Object.keys(hmgEntries).length > 0) {
      await pool.query(
        `INSERT INTO month_entries (id,data_json,obalovna_id,updated_at)
         VALUES((SELECT COALESCE(MAX(id),0)+1 FROM month_entries),$1,$2,NOW())
         ON CONFLICT(obalovna_id) DO UPDATE SET data_json=EXCLUDED.data_json,updated_at=NOW()`,
        [JSON.stringify(hmgEntries), obalovnaId]
      );
    }
    res.json({ ok: true, receptury: receptury.length, tydnu: Object.keys(weekMap).length, dnu: Object.keys(hmgEntries).length });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: 'Interní chyba serveru' });
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

// ── Seznam obaloven (organizační struktura TAXIS) ──
// Jen pro roli superadmin (krok 4). Běžný admin/operator/hmg_share NEMÁ přístup.
// Čistě čtecí.
app.get('/api/obalovny', requireAuth, requireSuperadmin, async (req, res) => {
  const obalovny = await listObalovny(pool);
  res.json(obalovny);
});

// STROP modulů obalovny (superadmin). Harmonogram je vždy true (needitovatelný).
// Pravidlo závislosti (Hodinové jen při Objednávkách) vynucuje normalizeModuly v lib/obalovny.
app.patch('/api/obalovny/:id/moduly', requireAuth, requireSuperadmin, async (req, res) => {
  try {
    const { mod_vazenky, mod_objednavky, mod_hod_objednavky } = req.body;
    const updated = await updateObalovnaModuly(pool, req.params.id, { mod_vazenky, mod_objednavky, mod_hod_objednavky });
    if (!updated) return res.status(404).json({ error: 'Obalovna neexistuje' });
    const onoff = b => b ? 'on' : 'off';
    const detail = `vazenky=${onoff(updated.mod_vazenky)}, objednavky=${onoff(updated.mod_objednavky)}, hod_objednavky=${onoff(updated.mod_hod_objednavky)}`;
    logAudit(pool, { typ: 'obalovna_moduly', akter: req.session.username, role: 'superadmin',
      obalovna_id: req.params.id, detail, ip: req.ip || null, hostname: req.hostname || null });
    res.json({ ok: true, obalovna: updated });
  } catch (err) {
    console.error('PATCH /api/obalovny/:id/moduly error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// Moduly AKTUÁLNÍ obalovny přihlášeného uživatele — pro Nastavení (admin vidí jen povolené).
// Čistě čtecí; pro superadmina (bez obalovny) vrací vše false.
app.get('/api/obalovna/moduly', requireAuth, async (req, res) => {
  const moduly = await getObalovnaModuly(pool, getObalovnaId(req));
  res.json(moduly);
});

// Audit / log událostí (dávka D) — JEN superadmin. Posledních N záznamů (ts DESC),
// volitelně filtr ?typ= a ?obalovna_id=. SOUKROMÍ: žádný obsah dat obalovny, jen kdo/kdy/co.
app.get('/api/superadmin/audit', requireAuth, requireSuperadmin, async (req, res) => {
  try {
    const zaznamy = await listAudit(pool, {
      typ:         (req.query.typ || '').trim() || undefined,
      obalovna_id: (req.query.obalovna_id || '').trim() || undefined,
      limit:       req.query.limit,
    });
    res.json({ zaznamy });
  } catch (err) {
    console.error('GET /api/superadmin/audit error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// ── Superadmin panel — dávka A (čistě čtecí přehledy) ───────────────────────────

// Globální přehled: počet obaloven (z toho aktivních/demo) + počet uživatelů napříč
// obalovnami (superadmin se do počtu NEzahrnuje).
app.get('/api/superadmin/prehled', requireAuth, requireSuperadmin, async (req, res) => {
  try {
    const [ob, us] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS obaloven,
                         COUNT(*) FILTER (WHERE stav='aktivni')::int AS aktivnich,
                         COUNT(*) FILTER (WHERE stav='demo')::int    AS demo
                  FROM obalovny`),
      pool.query(`SELECT COUNT(*)::int AS uzivatelu FROM users WHERE role <> 'superadmin'`),
    ]);
    res.json({
      obaloven:  ob.rows[0].obaloven,
      aktivnich: ob.rows[0].aktivnich,
      demo:      ob.rows[0].demo,
      uzivatelu: us.rows[0].uzivatelu,
    });
  } catch (err) {
    console.error('GET /api/superadmin/prehled error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// Obsazení obalovny: uživatelé podle rolí (jména; u hmg_share i firma). Bez superadmina.
app.get('/api/superadmin/obalovny/:id/obsazeni', requireAuth, requireSuperadmin, async (req, res) => {
  try {
    const exists = await pool.query('SELECT 1 FROM obalovny WHERE id=$1', [req.params.id]);
    if (exists.rowCount === 0) return res.status(404).json({ error: 'Obalovna nenalezena' });
    const r = await pool.query(
      `SELECT username, role, firma FROM users
       WHERE obalovna_id=$1 AND role <> 'superadmin'
       ORDER BY role, username`,
      [req.params.id]
    );
    const admins    = { count: 0, names: [] };
    const operatori = { count: 0, names: [] };
    const hmg_share = { count: 0, users: [] };
    for (const u of r.rows) {
      if (u.role === 'admin')         { admins.count++;    admins.names.push(u.username); }
      else if (u.role === 'operator') { operatori.count++; operatori.names.push(u.username); }
      else if (u.role === 'hmg_share'){ hmg_share.count++; hmg_share.users.push({ username: u.username, firma: u.firma || null }); }
    }
    res.json({ obalovna_id: req.params.id, admins, operatori, hmg_share });
  } catch (err) {
    console.error('GET /api/superadmin/obalovny/:id/obsazeni error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// Souhrnné metriky obalovny. POZOR: superadmin NEVIDÍ počet ani tuny váženek — vrací se
// POUZE datum poslední váženky, poslední aktivita, počet týdnů, počet NEVYŘÍZENÝCH objednávek
// (jen když je systém funkční) a čas poslední úspěšné zálohy. Žádný count/tonáž váženek!
app.get('/api/superadmin/obalovny/:id/metriky', requireAuth, requireSuperadmin, async (req, res) => {
  try {
    const id = req.params.id;
    const exists = await pool.query('SELECT 1 FROM obalovny WHERE id=$1', [id]);
    if (exists.rowCount === 0) return res.status(404).json({ error: 'Obalovna nenalezena' });
    const [r, moduly, oeRes, lbRes] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int      FROM week_data WHERE obalovna_id=$1) AS tydny,
           (SELECT MAX(updated_at)    FROM week_data WHERE obalovna_id=$1) AS wd_last,
           (SELECT MAX(uploaded_at)   FROM vazenky   WHERE obalovna_id=$1) AS vz_upload,
           (SELECT MAX(datum)         FROM vazenky   WHERE obalovna_id=$1) AS vz_datum`,
        [id]
      ),
      getObalovnaModuly(pool, id),
      pool.query("SELECT value FROM obalovna_settings WHERE obalovna_id=$1 AND key='orders_enabled'", [id]),  // per-obalovna
      pool.query("SELECT value FROM obalovna_settings WHERE obalovna_id=$1 AND key='last_backup'", [id]),  // per-obalovna stav zálohy
    ]);
    const row = r.rows[0];
    const toDate = (x) => {
      if (!x) return null;
      if (typeof x === 'string') return x.slice(0, 10);
      try { return new Date(x).toISOString().slice(0, 10); } catch { return null; }
    };
    // Poslední aktivita = novější z (úprava harmonogramu, nahrání váženky) — jako datum.
    const wd = row.wd_last ? new Date(row.wd_last).getTime() : null;
    const vz = row.vz_upload ? new Date(row.vz_upload).getTime() : null;
    let posledniAktivita = null;
    if (wd != null || vz != null) posledniAktivita = toDate(new Date(Math.max(wd || 0, vz || 0)));

    // Nevyřízené objednávky JEN když je systém funkční (mod_objednavky=true AND orders_enabled=true).
    const ordersEnabled = (oeRes.rows[0] ? oeRes.rows[0].value : 'true') === 'true';
    const objednavkySystem = !!moduly.mod_objednavky && ordersEnabled;
    let nevyrizeneObjednavky = null;
    if (objednavkySystem) {
      const p = await pool.query("SELECT COUNT(*)::int AS n FROM orders WHERE obalovna_id=$1 AND status='pending'", [id]);
      nevyrizeneObjednavky = p.rows[0].n;
    }

    // Zdraví: čas poslední úspěšné zálohy (per-instalace/globální). Chybí → null.
    const posledniZaloha = lbRes.rows[0] ? lbRes.rows[0].value : null;

    // ZÁMĚRNĚ se nevrací počet ani tonáž váženek.
    res.json({
      tydny: row.tydny,
      posledniAktivita,
      posledniVazenka: toDate(row.vz_datum),
      objednavkySystem,
      nevyrizeneObjednavky,
      posledniZaloha,
    });
  } catch (err) {
    console.error('GET /api/superadmin/obalovny/:id/metriky error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// Reset hesla ADMINA obalovny (dávka C). Superadmin vygeneruje náhodné DOČASNÉ heslo;
// admin si ho při prvním přihlášení SÁM změní (mustChangePassword=true). Superadmin trvalé
// heslo nezná. Bezpečnost: jen role 'admin' a jen ve zvolené obalovně (ne superadmin, ne cizí
// obalovna, ne jiná role). Mění POUZE heslo + mustChangePassword (ne roli/jiná data).
app.post('/api/superadmin/obalovny/:id/reset-admin-heslo', requireAuth, requireSuperadmin, async (req, res) => {
  try {
    const obalovnaId = req.params.id;
    const username = (req.body && req.body.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Chybí username' });

    // Cílový uživatel MUSÍ být admin TÉTO obalovny (jinak odmítnout).
    const u = await pool.query(
      "SELECT id, role, obalovna_id FROM users WHERE username=$1",
      [username]
    );
    const target = u.rows[0];
    if (!target || target.role !== 'admin' || target.obalovna_id !== obalovnaId) {
      return res.status(404).json({ error: 'Admin se zadaným jménem v této obalovně neexistuje' });
    }

    // Náhodné dočasné heslo → bcrypt hash → mustChangePassword=true. Heslo se NIKAM neloguje.
    const tempPassword = generateTempPassword(14);
    const hash = await bcrypt.hash(tempPassword, 12);
    await pool.query(
      "UPDATE users SET password_hash=$1, must_change_password=true WHERE id=$2 AND role='admin' AND obalovna_id=$3",
      [hash, target.id, obalovnaId]
    );
    // Zruš aktivní sessions, aby se admin musel přihlásit dočasným heslem.
    await pool.query("DELETE FROM session WHERE sess->>'userId' = $1", [String(target.id)]);
    console.log(`Superadmin ${req.session.username} resetoval heslo admina '${username}' (obalovna ${obalovnaId}).`);
    // AUDIT (BEZ hesla): kdo resetoval, komu, v jaké obalovně.
    logAudit(pool, { typ: 'reset_admin_hesla', akter: req.session.username, role: 'superadmin',
      obalovna_id: obalovnaId, cil: username, detail: 'reset hesla admina obalovny',
      ip: req.ip || null, hostname: req.hostname || null });

    // Dočasné heslo se vrací JEN v této odpovědi superadminovi (k jednorázovému předání).
    res.json({ ok: true, username, tempPassword });
  } catch (err) {
    console.error('POST /api/superadmin/obalovny/:id/reset-admin-heslo error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// ── Předatelnost aplikace: správa superadminů (multi-obalovna, krok 5) ──────────
// Vše jen pro roli superadmin (requireSuperadmin). Superadmin existuje VÝHRADNĚ jako
// řádek v DB (users.role='superadmin') → při prodeji přechází s databází. Žádný hardcode.

// Seznam superadmin účtů (pro správu/předání).
app.get('/api/superadmin/list', requireAuth, requireSuperadmin, async (req, res) => {
  const r = await pool.query(
    "SELECT id, username, created_at FROM users WHERE role='superadmin' ORDER BY username"
  );
  res.json({ superadmins: r.rows, currentUserId: req.session.userId });
});

// Změna VLASTNÍHO hesla superadmina. Heslo se NIKDY neloguje.
app.post('/api/superadmin/change-password', requireAuth, requireSuperadmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'Nové heslo musí mít alespoň 8 znaků' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      "UPDATE users SET password_hash=$1, must_change_password=false WHERE id=$2 AND role='superadmin'",
      [hash, req.session.userId]
    );
    console.log(`Superadmin ${req.session.username} si změnil heslo.`);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/superadmin/change-password error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// Založení DALŠÍHO superadmin účtu (pro předání novému majiteli). Heslo se NIKDY neloguje.
// Toto je JEDINÁ API cesta vytvoření superadmina — a je pod requireSuperadmin, takže
// žádná jiná role se nemůže self-povýšit (POST /api/users 'superadmin' nadále odmítá).
app.post('/api/superadmin/create', requireAuth, requireSuperadmin, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 50) {
      return res.status(400).json({ error: 'Uživatelské jméno musí mít 3–50 znaků' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Heslo musí mít alespoň 8 znaků' });
    }
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'superadmin') RETURNING id, username, created_at",
      [username.trim(), hash]
    );
    console.log(`Vytvořen nový superadmin '${r.rows[0].username}' (založil ${req.session.username}).`);
    logAudit(pool, { typ: 'superadmin_create', akter: req.session.username, role: 'superadmin',
      cil: r.rows[0].username, ip: req.ip || null, hostname: req.hostname || null });
    res.json({ ok: true, superadmin: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Uživatel s tímto jménem již existuje' });
    console.error('POST /api/superadmin/create error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// Smazání EXISTUJÍCÍHO superadmina. POJISTKA: nelze smazat posledního/jediného superadmina
// (systém nesmí zůstat bez superadmina). Lze smazat i sám sebe, pokud není poslední.
app.delete('/api/superadmin/:id', requireAuth, requireSuperadmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Neplatné id' });

    const tRes = await pool.query("SELECT role, username FROM users WHERE id=$1", [id]);
    if (!tRes.rows[0] || tRes.rows[0].role !== 'superadmin') {
      return res.status(404).json({ error: 'Superadmin s tímto id neexistuje' });
    }
    const cRes = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='superadmin'");
    if (isLastSuperadmin(cRes.rows[0].n)) {
      return res.status(400).json({ error: 'Nelze smazat posledního superadmina — systém by zůstal bez správce.' });
    }
    await pool.query("DELETE FROM session WHERE sess->>'userId' = $1", [String(id)]);
    await pool.query('DELETE FROM users WHERE id=$1', [id]);
    console.log(`Smazán superadmin id=${id} (smazal ${req.session.username}).`);
    logAudit(pool, { typ: 'superadmin_delete', akter: req.session.username, role: 'superadmin',
      cil: tRes.rows[0].username, ip: req.ip || null, hostname: req.hostname || null });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/superadmin/:id error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
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
// Best-effort zápis/smazání settings — chyby jen logujeme, neházíme
async function setSetting(key, value) {
  try {
    await pool.query(
      "INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [key, value]
    );
  } catch (e) { console.error(`[ZÁLOHA] Nelze uložit settings.${key}:`, e.message); }
}
async function delSetting(key) {
  try { await pool.query("DELETE FROM settings WHERE key=$1", [key]); }
  catch (e) { console.error(`[ZÁLOHA] Nelze smazat settings.${key}:`, e.message); }
}

// ── Per-obalovna settings (krok 3/6) ───────────────────────────────────────────
// Konfigurace per obalovna žije v `obalovna_settings` (PK obalovna_id,key).
// Globální zůstávají: smtp_* (getSmtpSettings) a last_backup* (setSetting/delSetting výše).
// CONFIG_KEYS = per-obalovna konfigurační klíče vystavované přes /api/settings.
const CONFIG_KEYS = [
  'hmg_plant_rate', 'hmg_gas_capacity', 'hmg_max_daily', 'hmg_min_daily',
  'orders_enabled', 'vazenky_share_enabled',
];

async function getObalovnaSetting(obalovnaId, key) {
  if (!obalovnaId) return null;   // superadmin nemá vlastní obalovnu
  const r = await pool.query(
    'SELECT value FROM obalovna_settings WHERE obalovna_id=$1 AND key=$2',
    [obalovnaId, key]
  );
  return r.rows[0] ? r.rows[0].value : null;
}
async function getObalovnaSettingsMap(obalovnaId, keys) {
  const out = {};
  if (!obalovnaId) return out;
  const r = await pool.query(
    'SELECT key,value FROM obalovna_settings WHERE obalovna_id=$1 AND key = ANY($2::text[])',
    [obalovnaId, keys]
  );
  r.rows.forEach(row => { out[row.key] = row.value; });
  return out;
}
async function setObalovnaSetting(obalovnaId, key, value) {
  if (!obalovnaId) throw new Error('setObalovnaSetting: chybí obalovna_id');
  await pool.query(
    `INSERT INTO obalovna_settings (obalovna_id,key,value) VALUES ($1,$2,$3)
     ON CONFLICT (obalovna_id,key) DO UPDATE SET value=EXCLUDED.value`,
    [obalovnaId, key, String(value)]
  );
}
async function delObalovnaSetting(obalovnaId, key) {
  if (!obalovnaId) return;
  await pool.query('DELETE FROM obalovna_settings WHERE obalovna_id=$1 AND key=$2', [obalovnaId, key]);
}

// ── Read-only sběr dat JEDNÉ obalovny pro zálohu (krok 4/6) ─────────────────────
// Žádný zápis, žádné odeslání → testovatelné v paměti. Snímek = JEN data dané obalovny:
// week_data/vazenky/orders/inputs/companies/month_entries scoped přes obalovna_id, její
// uživatelé BEZ superadmina, a config z obalovna_settings BEZ smtp_* a BEZ last_backup*.
async function collectObalovnaSnapshot(obalovnaId) {
  if (!obalovnaId) throw new Error('collectObalovnaSnapshot: chybí obalovna_id');
  const [weeks, vazenky, inputs, companies, monthRes, ordersRes, usersRes, cfgRes] = await Promise.all([
    pool.query('SELECT week_start,rows_json FROM week_data WHERE obalovna_id=$1 ORDER BY week_start', [obalovnaId]),
    pool.query(
      'SELECT id,cislo_vazenky,datum,cas,smes,itt,tuny,spz,ridic,stavba,nazev_partnera,ico,firma_taxis,uploaded_at,uploaded_by ' +
      'FROM vazenky WHERE obalovna_id=$1 ORDER BY id', [obalovnaId]),
    pool.query('SELECT rows_json FROM inputs WHERE obalovna_id=$1', [obalovnaId]),
    pool.query('SELECT data_json FROM companies WHERE obalovna_id=$1', [obalovnaId]),
    pool.query('SELECT data_json FROM month_entries WHERE obalovna_id=$1', [obalovnaId]),
    pool.query(
      'SELECT id,order_group_id,user_id,firma,datum,smes,itt,tuny,komentar,' +
      'status,created_at,resolved_at,reject_reason,lokalita,lat,lng,resolved_by ' +
      'FROM orders WHERE obalovna_id=$1 ORDER BY created_at', [obalovnaId]),
    pool.query(
      "SELECT id,username,password_hash,role,email,firma,must_change_password,created_at,last_seen " +
      "FROM users WHERE obalovna_id=$1 AND role<>'superadmin' ORDER BY id", [obalovnaId]),
    pool.query('SELECT key,value FROM obalovna_settings WHERE obalovna_id=$1', [obalovnaId]),
  ]);

  // Config do snímku: per-obalovna konfigurace BEZ provozního stavu (last_backup*) a BEZ smtp_*.
  const settingsObj = {};
  cfgRes.rows.forEach(r => {
    if (r.key.startsWith('smtp_')) return;          // pojistka — smtp_* do snímku NIKDY
    if (r.key.startsWith('last_backup')) return;    // provozní stav, ne konfigurace
    settingsObj[r.key] = r.value;
  });

  const excel = {
    weeks:     weeks.rows.map(r => ({ start: r.week_start, rows: JSON.parse(r.rows_json) })),
    inputs:    inputs.rows[0] ? JSON.parse(inputs.rows[0].rows_json) : [],
    companies: companies.rows[0] ? JSON.parse(companies.rows[0].data_json) : [],
    orders:    ordersRes.rows,
    users:     usersRes.rows,
  };

  const snapshot = {
    version: 4,
    obalovna_id: obalovnaId,
    created: new Date().toISOString(),
    week_data:     weeks.rows.map(r => ({ week_start: r.week_start, rows_json: r.rows_json })),
    inputs:        excel.inputs,
    companies:     excel.companies,
    settings:      settingsObj,
    month_entries: monthRes.rows[0] ? JSON.parse(monthRes.rows[0].data_json) : {},
    users:         usersRes.rows,
    orders:        ordersRes.rows,
    vazenky:       vazenky.rows,
  };

  const counts = {
    weeks: weeks.rows.length, vazenky: vazenky.rows.length, orders: ordersRes.rows.length,
    users: usersRes.rows.length, companies: excel.companies.length, inputs: excel.inputs.length,
  };
  return { snapshot, excel, counts };
}

async function sendBackup(obalovnaId) {
  if (!obalovnaId) throw new Error('sendBackup: chybí obalovna_id');
  const TAG = `[ZÁLOHA v${APP_VERSION} ${obalovnaId}]`;
  console.log(`${TAG} ===== START =====`);

  // ── Záznam POKUSU (per-obalovna) ──────────────────────────────────────────────
  const attemptIso = new Date().toISOString();
  await setObalovnaSetting(obalovnaId, 'last_backup_attempt', attemptIso);

  // ── SMTP konfigurace: PRIMÁRNĚ z DB (krok 1/6), ENV gmail jako fallback ────────
  const smtpDb = await getSmtpSettings();
  const useDbSmtp = !!(smtpDb.smtp_host && smtpDb.smtp_user);

  // Krok 5/6: příjemce = per-obalovna backup_email, FALLBACK na globální ENV BACKUP_EMAIL.
  const recipient = (await getObalovnaSetting(obalovnaId, 'backup_email')) || process.env.BACKUP_EMAIL;
  if (!recipient) {
    const msg = 'Chybí příjemce zálohy (obalovna nemá backup_email ani není ENV BACKUP_EMAIL)';
    console.error(`${TAG} CHYBA konfigurace: ${msg}`);
    await setObalovnaSetting(obalovnaId, 'last_backup_error', `${new Date().toISOString()} | ${msg}`);
    throw new Error(msg);
  }
  if (!useDbSmtp && (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD)) {
    const msg = 'Chybí SMTP konfigurace (DB smtp_host/smtp_user ani ENV GMAIL_USER/GMAIL_APP_PASSWORD)';
    console.error(`${TAG} CHYBA konfigurace: ${msg}`);
    await setObalovnaSetting(obalovnaId, 'last_backup_error', `${new Date().toISOString()} | ${msg}`);
    throw new Error(msg);
  }

  // ── Sběr dat JEN této obalovny (read-only) ────────────────────────────────────
  let snapshot, excel, counts;
  try {
    ({ snapshot, excel, counts } = await collectObalovnaSnapshot(obalovnaId));
  } catch (dbErr) {
    console.error(`${TAG} CHYBA DB dotazů — záloha se neprovede:`, dbErr.message);
    await setObalovnaSetting(obalovnaId, 'last_backup_error', `${new Date().toISOString()} | DB: ${dbErr.message}`);
    throw dbErr;
  }

  console.log(
    `${TAG} DB načteno: weeks=${counts.weeks}, vazenky=${counts.vazenky}, receptury=${counts.inputs}, ` +
    `companies=${counts.companies}, orders=${counts.orders}, users=${counts.users}`
  );

  const date = new Date().toISOString().slice(0, 10);

  // ── A) JSON snímek pro plnou obnovu (per-obalovna) ────────────────────────────
  const snapshotJson     = JSON.stringify(snapshot, null, 2);
  const snapshotFilename = `hmg-snapshot-${obalovnaId}-${date}.json`;

  console.log(
    `${TAG} JSON snímek sestaven: klíče=[${Object.keys(snapshot).join(', ')}], ` +
    `users=${counts.users}, orders=${counts.orders}, vazenky=${counts.vazenky}, smtp/last_backup VYLOUČENY`
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
  let xlsxBuffer, sheetNames;
  try {
    ({ buffer: xlsxBuffer, sheetNames } = await buildStyledExcel(
      excel.weeks, excel.inputs, excel.companies, excel.orders, excel.users
    ));
  } catch (xlsxErr) {
    console.error(`${TAG} CHYBA sestavení Excelu:`, xlsxErr.message);
    await setObalovnaSetting(obalovnaId, 'last_backup_error', `${new Date().toISOString()} | Excel: ${xlsxErr.message}`);
    throw xlsxErr;
  }

  const xlsxFilename = `hmg_zaloha_${obalovnaId}_${date}.xlsx`;
  console.log(`${TAG} Excel sestaven: listy=[${sheetNames.join(', ')}], JSON přiložen=true`);

  // ── Transport: stejná cesta jako notifikace (DB smtp_*), ENV gmail jen jako fallback ──
  // Timeouty zachovány beze změny (proti zaseknutí na přechodných problémech SMTP/sítě).
  const TIMEOUTS = { connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000 };
  let transporter, mailFrom;
  if (useDbSmtp) {
    const smtpPort = parseInt(smtpDb.smtp_port) || 587;
    transporter = nodemailer.createTransport({
      host:   smtpDb.smtp_host,
      port:   smtpPort,
      secure: smtpPort === 465,        // 465 = implicit TLS, jinak STARTTLS (587)
      auth:   { user: smtpDb.smtp_user, pass: smtpDb.smtp_password || '' },
      tls:    { rejectUnauthorized: false },
      ...TIMEOUTS,
    });
    mailFrom = smtpDb.smtp_from || smtpDb.smtp_user;
    console.log(`${TAG} SMTP transport z DB: host=${smtpDb.smtp_host}, port=${smtpPort}, secure=${smtpPort === 465}`);
  } else {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
      ...TIMEOUTS,
    });
    mailFrom = `"HMG Záloha" <${process.env.GMAIL_USER}>`;
    console.log(`${TAG} SMTP transport FALLBACK na ENV gmail (DB smtp_* nenastaveno)`);
  }

  console.log(`${TAG} Příjemce: ${recipient}${recipient === process.env.BACKUP_EMAIL ? ' (fallback ENV)' : ' (per-obalovna)'}`);
  const mailOptions = {
    from:    mailFrom,
    to:      recipient,
    subject: `HMG záloha [${obalovnaId}] ${date} — ${counts.weeks} týdnů`,
    text: (
      `Automatická záloha dat harmonogramu výroby — obalovna: ${obalovnaId}.\n\n` +
      `Obsah (JEN data této obalovny):\n` +
      `- Týdnů: ${counts.weeks}\n` +
      `- Receptur: ${counts.inputs}\n` +
      `- Objednávek: ${counts.orders}\n` +
      `- Váženek: ${counts.vazenky}\n` +
      `- Uživatelů: ${counts.users}\n` +
      `- Datum: ${date}\n` +
      `- Excel listy: ${sheetNames.join(', ')}\n\n` +
      `Přílohy:\n` +
      `1. ${xlsxFilename} — čitelný Excel (týdny, receptury, objednávky, uživatelé)\n` +
      `2. ${snapshotFilename} — JSON snímek tabulek obalovny pro obnovu`
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
  };

  // ── Retry smyčka: 3 pokusy s pauzami 4 s a 8 s ───────────────────────────────
  // SMTP timeout = mail neodešel; případný duplikát je neškodný.
  const RETRY_DELAYS_MS = [4000, 8000];
  let mailErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await transporter.sendMail(mailOptions);
      mailErr = null;
      if (attempt > 1) console.log(`${TAG} E-mail odeslán napodruhé/napotřetí (pokus ${attempt}/3).`);
      break;
    } catch (err) {
      mailErr = err;
      console.error(`${TAG} Pokus ${attempt}/3 odeslání e-mailu selhal: ${err.message}`);
      if (attempt < 3) {
        const wait = RETRY_DELAYS_MS[attempt - 1];
        console.log(`${TAG} Čekám ${wait} ms před dalším pokusem…`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  if (mailErr) {
    console.error(`${TAG} CHYBA odeslání e-mailu po 3 pokusech:`, mailErr.message);
    await setObalovnaSetting(obalovnaId, 'last_backup_error', `${new Date().toISOString()} | SMTP (3× selhal): ${mailErr.message}`);
    throw mailErr;
  }

  console.log(`${TAG} ===== DOKONČENO: ${xlsxFilename} + ${snapshotFilename} =====`);

  // ── ÚSPĚCH: zapsat last_backup a vyčistit error (per-obalovna) ──────────────
  await setObalovnaSetting(obalovnaId, 'last_backup', new Date().toISOString());
  await delObalovnaSetting(obalovnaId, 'last_backup_error');
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
        'status,created_at,resolved_at,reject_reason,lokalita,lat,lng,resolved_by FROM orders ORDER BY created_at'
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
    // resolved_by je FK na users(id); users jsou již vloženy výše, takže FK projde
    for (const o of snapshot.orders) {
      await client.query(
        `INSERT INTO orders
           (id, order_group_id, user_id, firma, datum, smes, itt, tuny,
            komentar, status, created_at, resolved_at, reject_reason, lokalita,
            lat, lng, resolved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          o.id, o.order_group_id, o.user_id, o.firma, o.datum, o.smes, o.itt, o.tuny,
          o.komentar      || null,
          o.status,
          o.created_at,
          o.resolved_at   || null,
          o.reject_reason || null,
          o.lokalita      || null,
          (o.lat === undefined || o.lat === null || o.lat === '') ? null : o.lat,
          (o.lng === undefined || o.lng === null || o.lng === '') ? null : o.lng,
          (o.resolved_by === undefined || o.resolved_by === null) ? null : o.resolved_by,
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

// ── Které obalovny zálohovat (krok 4/6) ────────────────────────────────────────
// stav='aktivni' VŽDY (i prázdná — je to reálná obalovna); stav='demo' JEN když má data
// (week_data/vazenky/orders) → prázdná dema se přeskočí (žádné zbytečné prázdné e-maily).
async function listObalovnyForBackup() {
  const r = await pool.query(`
    SELECT o.id FROM obalovny o
    WHERE o.stav='aktivni'
       OR EXISTS (SELECT 1 FROM week_data WHERE obalovna_id=o.id)
       OR EXISTS (SELECT 1 FROM vazenky   WHERE obalovna_id=o.id)
       OR EXISTS (SELECT 1 FROM orders    WHERE obalovna_id=o.id)
    ORDER BY o.id
  `);
  return r.rows.map(x => x.id);
}

// ── Pražský čas: vrať {date:'YYYY-MM-DD', hour:0–23} pro dané Date (DST-safe přes Intl) ──
// Krok 5/6: backup_hour je LOKÁLNÍ pražská hodina; plánovač porovnává s aktuální pražskou hodinou,
// takže DST (léto/zima) se řeší automaticky a 18:00 je vždy 18:00 lokálně.
const BACKUP_DEFAULT_HOUR = 18;
function pragueParts(d) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const p = {};
  fmt.formatToParts(d).forEach(x => { p[x.type] = x.value; });
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0;   // některé prostředí vrací '24' o půlnoci
  return { date: `${p.year}-${p.month}-${p.day}`, hour };
}

// Spustit zálohu pro každou obalovnu v JEJÍ backup_hour (lokální Praha, default 18:00).
// Hodinový tick: každou celou hodinu zkontroluj, které obalovny mají právě teď čas zálohy.
let _backupCatchupDone = false;
function scheduleBackup() {
  // Zarovnání na nejbližší celou hodinu, pak interval 1 h.
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  const msUntil = next - now;

  // Krok 4/6 + 5/6: smyčka přes obalovny; každá se zálohuje JEN ve své backup_hour.
  const runDueBackups = async () => {
    const nowParts = pragueParts(new Date());
    let ids = [];
    try { ids = await listObalovnyForBackup(); }
    catch (e) { console.error('[ZÁLOHA] Plánovač: nelze načíst seznam obaloven:', e.message); return; }
    for (const id of ids) {
      try {
        const map = await getObalovnaSettingsMap(id, ['backup_hour', 'last_backup']);
        const hour = map.backup_hour != null ? parseInt(map.backup_hour, 10) : BACKUP_DEFAULT_HOUR;
        if (hour !== nowParts.hour) continue;                     // není čas této obalovny
        if (map.last_backup && pragueParts(new Date(map.last_backup)).date === nowParts.date) {
          continue;                                               // pojistka: už dnes zálohováno
        }
        console.log(`[ZÁLOHA] ${id}: plánovaný čas ${hour}:00 (Praha) → spouštím zálohu.`);
        await sendBackup(id);
      } catch (err) {
        console.error(`[ZÁLOHA] Plánovaná záloha '${id}' selhala:`, err.message);
      }
    }
    // cleanupRejectedOrders má vlastní denní interval ve startServer — zde nevoláme (běží hodinově).
  };

  // ── CATCH-UP (krok 2/6): automatické odeslání po startu VYPNUTO ──────────────
  // Při startu jen ZALOGUJEME varování per obalovna a NIC neodesíláme. Hodinový tick
  // níže zůstává funkční. Ruční zálohu lze spustit přes Nastavení → Zálohy.
  (async () => {
    if (_backupCatchupDone) return;
    _backupCatchupDone = true;
    try {
      const ids = await listObalovnyForBackup();
      for (const id of ids) {
        const lastIso = await getObalovnaSetting(id, 'last_backup');
        const ageH = lastIso ? (Date.now() - Date.parse(lastIso)) / 3600000 : Infinity;
        if (!lastIso || ageH > 24) {
          const reason = lastIso ? `${ageH.toFixed(1)} h` : 'chybí';
          console.warn(`[ZÁLOHA] ${id}: last_backup zastaralý (${reason}) — automatický catch-up je vypnutý, spusť ručně přes Nastavení → Zálohy.`);
        } else {
          console.log(`[ZÁLOHA] ${id}: catch-up nepotřeba (last_backup před ${ageH.toFixed(1)} h).`);
        }
      }
    } catch (e) {
      console.error('[ZÁLOHA] Catch-up: chyba:', e.message);
    }
  })();

  setTimeout(() => {
    runDueBackups();
    setInterval(runDueBackups, 60 * 60 * 1000);
  }, msUntil);
  console.log(`Plánovač zálohy: hodinový tick, první za ${Math.round(msUntil / 60000)} min (každá obalovna ve své backup_hour, default ${BACKUP_DEFAULT_HOUR}:00 Praha).`);
}

// ── Hlídání staré zálohy při startu (best-effort e-mail adminovi) ────────────
// Když je last_backup > 36 h, zaloguj WARNING. UI banner v /settings doplní to,
// co e-mail nezvládne (rozbité SMTP).
async function checkBackupAge() {
  try {
    const ids = await listObalovnyForBackup();
    const smtpSettings = await getSmtpSettings();
    for (const id of ids) {
      const map = await getObalovnaSettingsMap(id, ['last_backup', 'last_backup_error']);
      const lastIso = map.last_backup || null;
      if (!lastIso) {
        console.warn(`[ZÁLOHA] ${id}: WARNING last_backup chybí — žádná úspěšná záloha nezaznamenána.`);
        continue;
      }
      const ageH = (Date.now() - Date.parse(lastIso)) / 3600000;
      if (ageH > 36) {
        const ageDays = (ageH / 24).toFixed(1);
        console.warn(`[ZÁLOHA] ${id}: WARNING poslední úspěšná záloha před ${ageH.toFixed(1)} h (${lastIso}). Zkontroluj SMTP a logy.`);
        if (map.last_backup_error) {
          console.warn(`[ZÁLOHA] ${id}: poslední zaznamenaná chyba: ${map.last_backup_error}`);
        }
        // Best-effort e-mail adminovi přes SMTP (může selhat, proto i UI banner)
        try {
          if (smtpSettings.smtp_admin_emails) {
            await sendNotificationEmail(
              smtpSettings.smtp_admin_emails,
              `[HMG] Záloha zastaralá (${id}): ${ageDays} dní`,
              `<p>Obalovna: <strong>${id}</strong></p>` +
              `<p>Poslední úspěšná záloha: <strong>${lastIso}</strong></p>` +
              `<p>Stáří: <strong>${ageH.toFixed(1)} h</strong> (${ageDays} dní)</p>` +
              (map.last_backup_error ? `<p>Poslední chyba: <code>${String(map.last_backup_error).replace(/</g,'&lt;')}</code></p>` : '') +
              `<p>Zkontroluj logy a SMTP/Gmail konfiguraci.</p>`,
              smtpSettings
            );
            console.log(`[ZÁLOHA] ${id}: varovný e-mail odeslán adminovi.`);
          }
        } catch (e) {
          console.error(`[ZÁLOHA] ${id}: nepodařilo se odeslat varovný e-mail:`, e.message);
        }
      } else {
        console.log(`[ZÁLOHA] ${id}: OK (poslední záloha před ${ageH.toFixed(1)} h).`);
      }
    }
  } catch (e) {
    console.error('[ZÁLOHA] checkBackupAge selhalo:', e.message);
  }
}

// Manuální spuštění zálohy (jen pro admina) — zálohuje JEN obalovnu volajícího
app.post('/api/backup/run', requireAuth, requireAdmin, backupLimiter, async (req, res) => {
  try {
    const obalovnaId = getObalovnaId(req);
    if (!obalovnaId) return res.status(403).json({ ok: false, error: 'Superadmin nemá vlastní obalovnu k záloze' });
    await sendBackup(obalovnaId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Manuální záloha selhala:', err);
    res.status(500).json({ ok: false, error: 'Interní chyba serveru' });
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
    catch (e) { console.error('[OBNOVA] Neplatný JSON snímek:', e); return res.status(400).json({ ok: false, error: 'Neplatný JSON soubor' }); }
    // Proveď obnovu
    const result = await restoreFromSnapshot(snapshot);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[OBNOVA] Selhání endpointu:', err);
    res.status(500).json({ ok: false, error: 'Interní chyba serveru' });
  }
});

app.get('/settings', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});


app.get('/api/export-excel', requireAuth, requireOperator, async (req, res) => {
  // Operátor nemá export harmonogramu (jen admin).
  if (req.session.role === 'operator') return res.status(403).json({ error: 'Nemáte oprávnění' });
  const obalovnaId = getObalovnaId(req);
  const [weeks, inputs] = await Promise.all([
    pool.query('SELECT week_start,rows_json FROM week_data WHERE obalovna_id=$1 ORDER BY week_start', [obalovnaId]),
    pool.query('SELECT rows_json FROM inputs WHERE obalovna_id=$1', [obalovnaId])
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
  // SCOPING: admin vidí JEN uživatele své obalovny; superadmina NIKDY.
  const r = await pool.query(`
    SELECT u.id, u.username, u.role, u.firma, u.email, u.orders_allowed, u.created_at, u.last_seen,
      (SELECT COUNT(*) FROM session s WHERE s.sess->>'userId' = u.id::text AND s.expire > NOW()) as session_count
    FROM users u
    WHERE u.obalovna_id = $1 AND u.role <> 'superadmin'
    ORDER BY u.created_at
  `, [getObalovnaId(req)]);
  res.json(r.rows);
});

// Per-user povolení objednávkového systému (relevantní jen pro hmg_share).
app.put('/api/users/:id/orders-allowed', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Neplatné ID' });
    const allowed = req.body.orders_allowed === true || req.body.orders_allowed === 'true';
    // SCOPING: jen uživatel své obalovny, ne superadmin.
    const r = await pool.query(
      "UPDATE users SET orders_allowed=$1 WHERE id=$2 AND obalovna_id=$3 AND role <> 'superadmin'",
      [allowed, id, getObalovnaId(req)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Uživatel nenalezen' });
    res.json({ ok: true, orders_allowed: allowed });
  } catch (err) {
    console.error('PUT /api/users/:id/orders-allowed error:', err);
    res.status(500).json({ error: 'Interní chyba serveru' });
  }
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
      'INSERT INTO users (username, password_hash, role, firma, email, obalovna_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,username,role,firma,email',
      [username.trim(), hash, role, firmaVal, emailVal, getObalovnaId(req)]
    );
    res.json({ ok: true, user: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Uživatel již existuje' });
    throw err;
  }
});

app.put('/api/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Neplatné ID' });
    if (id === req.session.userId) return res.status(400).json({ error: 'Nemůžeš změnit vlastní roli' });
    const { role } = req.body;
    // 'superadmin' NENÍ v povolených hodnotách → nelze povýšit přes API (jen seed skript).
    if (!['admin','operator','hmg_share'].includes(role)) return res.status(400).json({ error: 'Neplatná role' });
    // SCOPING: měnit lze JEN uživatele své obalovny a NIKDY superadmina (cizí id/superadmin → 404).
    const r = await pool.query(
      "UPDATE users SET role=$1 WHERE id=$2 AND obalovna_id=$3 AND role <> 'superadmin'",
      [role, id, getObalovnaId(req)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Uživatel nenalezen' });
    // Smazat sessions uživatele aby se znovu přihlásil s novou rolí
    await pool.query("DELETE FROM session WHERE sess->>'userId'=$1", [String(id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/users/:id/role error:', err);
    res.status(500).json({ error: 'Interní chyba serveru' });
  }
});

app.put('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Neplatné ID' });
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Heslo min. 6 znaků' });
    const hash = await bcrypt.hash(password, 12);
    // SCOPING: reset hesla jen pro uživatele své obalovny, ne superadmina.
    const r = await pool.query(
      "UPDATE users SET password_hash=$1 WHERE id=$2 AND obalovna_id=$3 AND role <> 'superadmin'",
      [hash, id, getObalovnaId(req)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Uživatel nenalezen' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/users/:id/password error:', err);
    res.status(500).json({ error: 'Interní chyba serveru' });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Neplatné ID' });
    if (id === req.session.userId) return res.status(400).json({ error: 'Nemůžeš smazat sám sebe' });
    // SCOPING: smazat lze JEN uživatele své obalovny, NIKDY superadmina (cizí id → 404).
    const r = await pool.query(
      "DELETE FROM users WHERE id=$1 AND obalovna_id=$2 AND role <> 'superadmin' RETURNING id",
      [id, getObalovnaId(req)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Uživatel nenalezen' });
    await pool.query("DELETE FROM session WHERE sess->>'userId' = $1", [String(id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/users/:id error:', err);
    res.status(500).json({ error: 'Interní chyba serveru' });
  }
});

app.put('/api/users/:id/firma', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Neplatné ID' });
    const { firma } = req.body;
    const firmaVal = firma ? sanitizeStr(String(firma), 100) : null;
    const r = await pool.query(
      "UPDATE users SET firma=$1 WHERE id=$2 AND obalovna_id=$3 AND role <> 'superadmin'",
      [firmaVal, id, getObalovnaId(req)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Uživatel nenalezen' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/users/:id/firma error:', err);
    res.status(500).json({ error: 'Interní chyba serveru' });
  }
});

app.put('/api/users/:id/email', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Neplatné ID' });
    const { email } = req.body;
    const emailVal = email ? String(email).trim().slice(0, 255) : null;
    if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
      return res.status(400).json({ error: 'Neplatný formát emailu' });
    }
    const r = await pool.query(
      "UPDATE users SET email=$1 WHERE id=$2 AND obalovna_id=$3 AND role <> 'superadmin'",
      [emailVal, id, getObalovnaId(req)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Uživatel nenalezen' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/users/:id/email error:', err);
    res.status(500).json({ error: 'Interní chyba serveru' });
  }
});

// ── Správa sessions ──
app.get('/api/sessions', requireAuth, requireAdmin, async (req, res) => {
  // SCOPING: jen sessions uživatelů své obalovny; superadmina ani cizí obalovnu NEukazovat.
  const r = await pool.query(`
    SELECT s.sid,
      s.sess->>'userId' as user_id,
      u.username,
      s.sess->>'userAgent' as user_agent,
      s.sess->>'loginIp' as ip,
      s.expire,
      (s.sid = $1) as is_current
    FROM session s
    JOIN users u ON u.id::text = s.sess->>'userId'
    WHERE s.expire > NOW() AND u.obalovna_id = $2 AND u.role <> 'superadmin'
    ORDER BY u.username, s.expire DESC
  `, [req.sessionID, getObalovnaId(req)]);
  res.json(r.rows);
});

app.delete('/api/sessions/:sid', requireAuth, requireAdmin, async (req, res) => {
  // sid je textový identifikátor session (ne integer) → bez numerické validace.
  try {
    if (req.params.sid === req.sessionID) return res.status(400).json({ error: 'Nemůžeš odhlásit aktuální session' });
    // SCOPING: odhlásit lze jen session uživatele své obalovny (ne superadmina/cizí).
    const r = await pool.query(
      `DELETE FROM session WHERE sid=$1 AND sess->>'userId' IN (
         SELECT id::text FROM users WHERE obalovna_id=$2 AND role <> 'superadmin')`,
      [req.params.sid, getObalovnaId(req)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Session nenalezena' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/sessions/:sid error:', err);
    res.status(500).json({ error: 'Interní chyba serveru' });
  }
});

app.delete('/api/sessions/user/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Neplatné ID' });
    // SCOPING: odhlásit lze jen uživatele své obalovny (ne superadmina/cizí).
    await pool.query(
      `DELETE FROM session WHERE sess->>'userId'=$1 AND sid!=$2 AND sess->>'userId' IN (
         SELECT id::text FROM users WHERE obalovna_id=$3 AND role <> 'superadmin')`,
      [String(id), req.sessionID, getObalovnaId(req)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/sessions/user/:id error:', err);
    res.status(500).json({ error: 'Interní chyba serveru' });
  }
});

// ── Sdílení měsíčního přehledu (share tokeny PER-OBALOVNA) ──
app.get('/api/share-tokens', requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query(
    "SELECT key, value FROM obalovna_settings WHERE obalovna_id=$1 AND key LIKE 'share_%'",
    [getObalovnaId(req)]
  );
  res.json(r.rows.map(r => ({ token: r.key.replace('share_',''), expires: r.value })));
});

app.post('/api/share-tokens', requireAuth, requireAdmin, async (req, res) => {
  const obalovnaId = getObalovnaId(req);
  if (!obalovnaId) return res.status(403).json({ error: 'Superadmin nemá sdílení obalovny' });
  const days = parseInt(req.body.days) || 30;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date();
  expires.setDate(expires.getDate() + days);
  await setObalovnaSetting(obalovnaId, `share_${token}`, expires.toISOString());
  res.json({ ok: true, token, expires: expires.toISOString() });
});

app.delete('/api/share-tokens/:token', requireAuth, requireAdmin, async (req, res) => {
  await delObalovnaSetting(getObalovnaId(req), `share_${req.params.token}`);
  res.json({ ok: true });
});

// Veřejný přístup přes share token (bez session → hledáme token NAPŘÍČ obalovnami;
// token je 32B náhodný a globálně unikátní, takže key sám určuje obalovnu).
app.get('/share/:token', async (req, res) => {
  const r = await pool.query(
    'SELECT value FROM obalovna_settings WHERE key=$1', [`share_${req.params.token}`]
  );
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

    const obalovnaId = getObalovnaId(req);   // multi-obalovna: další podmínka navíc
    // Admin: načti všechny pending skupiny bez filtru měsíce
    if (pending === '1' && req.session.role === 'admin') {
      const r = await pool.query(
        `SELECT o.*, u.username
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         WHERE o.obalovna_id=$1 AND o.status = 'pending'
         ORDER BY o.created_at ASC`,
        [obalovnaId]
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
       WHERE obalovna_id=$3 AND datum >= $1 AND datum <= $2
         AND status IN ('pending','pre_approved','pre_rejected','approved')
       ORDER BY datum, firma, created_at`,
      [from, to, obalovnaId]
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

    const obalovnaId = getObalovnaId(req);   // multi-obalovna: další podmínka navíc
    const wRes = await pool.query(
      'SELECT rows_json FROM week_data WHERE week_start=$1 AND obalovna_id=$2', [weekStart, obalovnaId]);
    let harmonogram = 0;
    if (wRes.rows[0]) {
      const rows = JSON.parse(wRes.rows[0].rows_json);
      harmonogram = rows.reduce((s, r) => s + (parseInt(r[`d${di}`]) || 0), 0);
    }

    // Všechny objednávky pro daný den (bez filtru firmy — plná transparentnost)
    const oRes = await pool.query(
      `SELECT firma, SUM(tuny)::int AS tuny, status
       FROM orders
       WHERE obalovna_id=$2 AND datum=$1 AND status IN ('pending','pre_approved','pre_rejected','approved')
       GROUP BY firma, status
       ORDER BY firma, status`,
      [date, obalovnaId]
    );

    // Denní limity (per-obalovna)
    const sRes = await pool.query(
      "SELECT key,value FROM obalovna_settings WHERE obalovna_id=$1 AND key IN ('hmg_max_daily','hmg_min_daily')",
      [obalovnaId]
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

    // Kapacitní kontrola per den (server-side bezpečnost)
    const obalovnaId = getObalovnaId(req);   // multi-obalovna: scope kapacity i zápisu

    // Načti denní limity (per-obalovna)
    const sRes = await pool.query(
      "SELECT key,value FROM obalovna_settings WHERE obalovna_id=$1 AND key IN ('hmg_max_daily','hmg_min_daily')",
      [obalovnaId]
    );
    const limits = {};
    sRes.rows.forEach(r => { limits[r.key] = parseInt(r.value); });
    const maxDaily = limits.hmg_max_daily || null;
    const minDaily = limits.hmg_min_daily || null;
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

      const wRes = await pool.query(
        'SELECT rows_json FROM week_data WHERE week_start=$1 AND obalovna_id=$2', [weekStart, obalovnaId]);
      let weekTuny = 0;
      if (wRes.rows[0]) {
        const rows = JSON.parse(wRes.rows[0].rows_json);
        weekTuny = rows.reduce((s, r) => s + (parseInt(r[`d${di}`]) || 0), 0);
      }

      const pRes = await pool.query(
        `SELECT COALESCE(SUM(tuny),0) AS total FROM orders
         WHERE obalovna_id=$2 AND datum=$1 AND status IN ('pending','pre_approved','pre_rejected','approved')`,
        [datum, obalovnaId]
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
          `INSERT INTO orders (order_group_id, user_id, firma, datum, smes, itt, tuny, komentar, lokalita, lat, lng, obalovna_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
            groupLng,
            obalovnaId
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
    res.status(500).json({ error: 'Interní chyba serveru' });
  }
});

// ── Sdílená write-propagace objednávky do week_data (P2 #4, DRY) ───────────────
// JEN mechanika zápisu (read-merge-upsert per týden). BEZ try/catch a BEZ logování —
// chování (best-effort vs fatal) i log řídí VOLAJÍCÍ. Zdroj `items` (které řádky) určuje
// volající (approve = celá skupina, finalize = jen nově schválené). `obalovnaId` povinné
// (cross-tenant pojistka). `dbExec` = executor s .query (pool nebo client) — funkce o
// kontextu NErozhoduje; volající předá to, co dnes používá (oba dnes pool).
// items: [{ datum, smes, itt, tuny, lokalita, lat, lng, firma }]. Vrací počet dotčených týdnů.
async function propagateOrderToWeekData(items, obalovnaId, dbExec) {
  if (!obalovnaId) throw new Error('propagateOrderToWeekData: chybí obalovna_id');
  const db = dbExec || pool;
  const byWeek = {};
  for (const item of items) {
    const datum = item.datum instanceof Date
      ? item.datum.toISOString().slice(0, 10)
      : String(item.datum).slice(0, 10);
    const d = new Date(datum + 'T00:00:00Z');
    const daysFromMonday = (d.getUTCDay() + 6) % 7;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - daysFromMonday);
    const weekStart = monday.toISOString().slice(0, 10);
    if (!byWeek[weekStart]) byWeek[weekStart] = [];
    byWeek[weekStart].push({ ...item, datum, di: daysFromMonday });
  }
  for (const [weekStart, weekItems] of Object.entries(byWeek)) {
    const wRes = await db.query('SELECT rows_json FROM week_data WHERE week_start=$1 AND obalovna_id=$2', [weekStart, obalovnaId]);
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
    await db.query(
      `INSERT INTO week_data (week_start, rows_json, obalovna_id, updated_at) VALUES($1, $2, $3, NOW())
       ON CONFLICT(week_start,obalovna_id) DO UPDATE SET rows_json=EXCLUDED.rows_json, updated_at=NOW()`,
      [weekStart, JSON.stringify(rows), obalovnaId]
    );
  }
  return Object.keys(byWeek).length;
}

// PATCH /api/orders/:groupId/approve — admin schválí skupinu
// Bez body (nebo {confirm:false}): jen zkontroluje kapacitu, nic neschvaluje
// S body {confirm:true}: skutečně schválí (vždy, i pokud překračuje max)
app.patch('/api/orders/:groupId/approve', requireAuth, requireAdmin, requireOrdersEnabled, async (req, res) => {
  try {
    const { groupId } = req.params;
    const obalovnaId = getObalovnaId(req);   // week_data scope (multi-obalovna)
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

    // Denní maximum (per-obalovna)
    const sRes = await pool.query("SELECT value FROM obalovna_settings WHERE obalovna_id=$1 AND key='hmg_max_daily'", [getObalovnaId(req)]);
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
        const wRes = await pool.query('SELECT rows_json FROM week_data WHERE week_start=$1 AND obalovna_id=$2', [weekStart, obalovnaId]);
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

    // Propagace schválené objednávky do week_data harmonogramu.
    // BEST-EFFORT: chyba propagace NEshodí approve (request vrátí 200), jen se zaloguje.
    try {
      const itemsRes = await pool.query(
        `SELECT datum, smes, itt, tuny, lokalita, lat, lng, firma
         FROM orders WHERE order_group_id=$1`,
        [groupId]
      );
      const n = await propagateOrderToWeekData(itemsRes.rows, obalovnaId, pool);
      console.log(`Objednávka ${groupId} propsána do ${n} týdnů v harmonogramu`);
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

    const sRes = await pool.query("SELECT value FROM obalovna_settings WHERE obalovna_id=$1 AND key='hmg_max_daily'", [getObalovnaId(req)]);
    const maxDaily = sRes.rows[0] ? parseInt(sRes.rows[0].value) : null;
    let exceedsMax = false, total = 0;
    if (maxDaily) {
      const d = new Date(datum + 'T00:00:00Z');
      const daysFromMonday = (d.getUTCDay() + 6) % 7;
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - daysFromMonday);
      const weekStart = monday.toISOString().slice(0, 10);
      const di = daysFromMonday;
      const wRes = await pool.query('SELECT rows_json FROM week_data WHERE week_start=$1 AND obalovna_id=$2', [weekStart, getObalovnaId(req)]);
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
    const obalovnaId = getObalovnaId(req);   // week_data scope (multi-obalovna)
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

      // Propsat schválené do week_data — přes POOL až PO COMMITu (transakce je uzavřená).
      // FATAL: chyba propagace propadne do vnějšího catch → 500 (ROLLBACK je no-op po commitu).
      if (approvedRows.rows.length > 0) {
        await propagateOrderToWeekData(approvedRows.rows, obalovnaId, pool);
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
    // Mapování na BEZPEČNÝ čitelný text — nikdy err.message/err.stack/cesty/hesla.
    const code = String(err && err.code || '');
    const msg  = String(err && err.message || '').toLowerCase();
    let safe;
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || msg.includes('timeout')) {
      safe = 'Časový limit spojení';
    } else if (code === 'EAUTH' || msg.includes('auth') || msg.includes('credentials') || msg.includes('username') || msg.includes('password')) {
      safe = 'Chybná autentizace';
    } else if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || msg.includes('connect')) {
      safe = 'Nelze se připojit k SMTP serveru';
    } else {
      safe = 'Odeslání selhalo';
    }
    res.status(500).json({ ok: false, error: safe });
  }
});

// ── Záloha - poslední datum + atributy stavu ──
app.get('/api/backup/last', requireAuth, requireAdmin, async (req, res) => {
  // per-obalovna stav zálohy (krok 4/6)
  const map = await getObalovnaSettingsMap(getObalovnaId(req), ['last_backup', 'last_backup_attempt', 'last_backup_error']);
  const last = map.last_backup || null;
  const ageH = last ? (Date.now() - Date.parse(last)) / 3600000 : null;
  res.json({
    last,
    last_attempt: map.last_backup_attempt || null,
    last_error:   map.last_backup_error   || null,
    age_hours:    ageH,
  });
});

// ── Konfigurace zálohy per obalovna (krok 5/6) — příjemce + hodina, JEN admin ──
app.get('/api/backup/config', requireAuth, requireAdmin, async (req, res) => {
  const obalovnaId = getObalovnaId(req);
  if (!obalovnaId) return res.status(403).json({ error: 'Superadmin nemá konfiguraci zálohy obalovny' });
  const map = await getObalovnaSettingsMap(obalovnaId, ['backup_email', 'backup_hour']);
  res.json({
    backup_email:   map.backup_email || null,
    backup_hour:    map.backup_hour != null ? parseInt(map.backup_hour, 10) : null,
    fallback_email: process.env.BACKUP_EMAIL || null,   // placeholder/výchozí příjemce
    default_hour:   BACKUP_DEFAULT_HOUR,
  });
});

app.post('/api/backup/config', requireAuth, requireAdmin, async (req, res) => {
  const obalovnaId = getObalovnaId(req);
  if (!obalovnaId) return res.status(403).json({ error: 'Superadmin nemá konfiguraci zálohy obalovny' });
  const { backup_email, backup_hour } = req.body || {};

  // E-mail: prázdné = smazat (návrat k fallbacku ENV); jinak validovat formát.
  if (backup_email !== undefined) {
    const email = String(backup_email || '').trim();
    if (email === '') {
      await delObalovnaSetting(obalovnaId, 'backup_email');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
      return res.status(400).json({ error: 'Neplatný formát e-mailu' });
    } else {
      await setObalovnaSetting(obalovnaId, 'backup_email', email);
    }
  }

  // Hodina: celé číslo 0–23.
  if (backup_hour !== undefined && String(backup_hour).trim() !== '') {
    const h = parseInt(backup_hour, 10);
    if (isNaN(h) || h < 0 || h > 23) return res.status(400).json({ error: 'Hodina musí být celé číslo 0–23' });
    await setObalovnaSetting(obalovnaId, 'backup_hour', String(h));
  }

  res.json({ ok: true });
});


// ── Vážní data (váženky) — upload + výpis ───────────────────────────────────
// Pomocná: načti firmy z TAXIS (companies)
async function loadTaxisFirmy(obalovnaId) {
  const r = await pool.query('SELECT data_json FROM companies WHERE obalovna_id=$1', [obalovnaId]);
  if (!r.rows[0]) return [];
  try { return (JSON.parse(r.rows[0].data_json) || []).map(c => c.name).filter(Boolean); }
  catch { return []; }
}

// Upload: jen admin. Multer memoryStorage, max 10 MB.
const vazenkyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/vazenky/upload', requireAuth, requireAdmin, uploadLimiter, vazenkyUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chybí soubor' });
  try {
    const taxisFirmy = await loadTaxisFirmy(getObalovnaId(req));
    const { rows, summary } = parseVazenky(req.file.buffer, req.file.originalname || 'upload', taxisFirmy);

    // Idempotentní upsert: UNIQUE na cislo_vazenky → ON CONFLICT DO NOTHING
    let inserted = 0, duplicates = 0;
    for (const r of rows) {
      const ins = await pool.query(
        `INSERT INTO vazenky
          (cislo_vazenky, datum, cas, smes, itt, tuny, spz, ridic, stavba,
           nazev_partnera, ico, firma_taxis, uploaded_by, obalovna_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (cislo_vazenky) DO NOTHING`,
        [r.cislo_vazenky, r.datum, r.cas, r.smes, r.itt, r.tuny, r.spz, r.ridic, r.stavba,
         r.nazev_partnera, r.ico, r.firma_taxis, req.session.userId, getObalovnaId(req)]
      );
      if (ins.rowCount === 1) inserted++; else duplicates++;
    }
    res.json({ ok: true, summary, inserted, duplicates });
  } catch (err) {
    console.error('POST /api/vazenky/upload error:', err);
    res.status(500).json({ error: 'Interní chyba serveru' });
  }
});

// ── Sdílený builder filtr+scope pro /api/vazenky a /api/vazenky/export ──────
// Jediný zdroj pravdy: oba endpointy MUSÍ vidět stejné řádky pro stejné filtry.
async function buildVazenkyQuery(req) {
  const uRes = await pool.query('SELECT role, firma FROM users WHERE id=$1', [req.session.userId]);
  const role  = (uRes.rows[0] && uRes.rows[0].role)  || req.session.role;
  const firma = (uRes.rows[0] && uRes.rows[0].firma) || null;
  const obalovnaId = getObalovnaId(req);   // multi-obalovna: další podmínka navíc

  const stavba = (req.query.stavba || '').trim();
  const od     = (req.query.od     || '').trim();
  const doD    = (req.query.do     || '').trim();

  // Parametr firma — admin-only. Pro ne-adminy se IGNORUJE (scope drží na vlastní firmu).
  const firmaParam = (req.query.firma || '').trim();
  // adminFirma se NIKDY nepoužije pro hmg_share/operatora — viz scope níže.
  const adminFirma = (role === 'admin') ? firmaParam : '';

  const where = [];
  const params = [];

  // MULTI-OBALOVNA: VŽDY první podmínka (klient nemůže obejít parametrem).
  // Je to DALŠÍ omezení vedle role/firma scopingu níže, ne jeho náhrada.
  params.push(obalovnaId);
  where.push(`obalovna_id = $${params.length}`);

  // SCOPE podle role (klient nemůže obejít) — VŽDY před uživatelskými filtry.
  // Pro hmg_share je scope zamčen na users.firma; req.query.firma je IGNOROVÁN.
  if (role === 'hmg_share') {
    // Přepínač viditelnosti "Odebrané stavby" pro odběratele (admin/operátor NEJSOU omezeni).
    // KASKÁDA krok 6: zapnuté JEN když je modul obalovny (mod_vazenky) povolen shora.
    const shRes = await pool.query("SELECT value FROM obalovna_settings WHERE obalovna_id=$1 AND key='vazenky_share_enabled'", [obalovnaId]);
    const moduly = await getObalovnaModuly(pool, obalovnaId);
    const shareEnabled = (shRes.rows[0] ? shRes.rows[0].value : 'false') === 'true' && moduly.mod_vazenky;
    if (!shareEnabled) return { role, firma, stavba, od, doD, firma_filter: '', forbidden: true };
    if (!firma) return { role, firma, stavba, od, doD, firma_filter: '', empty: true };
    params.push(firma);
    where.push(`firma_taxis = $${params.length}`);
  }
  // admin: žádný scope-WHERE; volitelně přidá firma filtr níže.

  // Admin-only filtr firmy: speciální „(nepřiřazeno)" → IS NULL, jinak rovnost.
  if (adminFirma) {
    if (adminFirma === '(nepřiřazeno)') {
      where.push(`firma_taxis IS NULL`);
    } else {
      params.push(adminFirma);
      where.push(`firma_taxis = $${params.length}`);
    }
  }

  if (stavba) { params.push(stavba); where.push(`stavba = $${params.length}`); }
  if (od)     { params.push(od);     where.push(`datum >= $${params.length}`); }
  if (doD)    { params.push(doD);    where.push(`datum <= $${params.length}`); }

  // Bez datumového filtru = CELÁ historie (žádné výchozí časové okno).
  // OD/DO se aplikuje jen když je zadáno; scoping dle role zůstává beze změny.

  return {
    role, firma, stavba, od, doD, obalovnaId,
    firma_filter: adminFirma,    // co se reálně použilo (prázdné = bez filtru)
    empty:    false,
    whereSQL: where.length ? 'WHERE ' + where.join(' AND ') : '',
    params,
  };
}

// Výpis: scoping podle role na SERVERU.
// Filtry: ?stavba=&od=YYYY-MM-DD&do=YYYY-MM-DD (všechny volitelné, kombinují se AND).
// Default (nic): posledních 30 dní.
app.get('/api/vazenky', requireAuth, async (req, res) => {
  try {
    const q = await buildVazenkyQuery(req);
    if (q.forbidden) return res.status(403).json({ error: 'Přístup k odebraným stavbám není povolen.' });
    if (q.empty) return res.json({ role: q.role, rows: [], stavby: [], total_tuny: 0 });

    const dataQ = `
      SELECT cislo_vazenky, datum, cas, smes, itt, tuny, spz, ridic, stavba,
             nazev_partnera, firma_taxis
      FROM vazenky
      ${q.whereSQL}
      ORDER BY datum DESC, cas DESC
      LIMIT 5000
    `;
    // Číselník stavby (pro select v UI) — bez datumového filtru, jen scope.
    // Multi-obalovna: VŽDY scope na obalovna_id ($1) + případně firma_taxis (hmg_share).
    const scopeParams = [q.obalovnaId];
    let   scopeWhere  = `WHERE obalovna_id = $1`;
    if (q.role === 'hmg_share') { scopeParams.push(q.firma); scopeWhere += ` AND firma_taxis = $${scopeParams.length}`; }
    const stavbyQ = `
      SELECT DISTINCT stavba
      FROM vazenky
      ${scopeWhere}
      AND stavba IS NOT NULL AND stavba <> ''
      ORDER BY stavba ASC
    `;

    // Číselník firem — JEN pro admina (klient ho v UI stejně nepoužije)
    const firmyQ = q.role === 'admin'
      ? pool.query(`
          SELECT firma_taxis, COUNT(*)::int AS n
          FROM vazenky
          WHERE obalovna_id = $1
          GROUP BY firma_taxis
          ORDER BY firma_taxis NULLS LAST
        `, [q.obalovnaId])
      : Promise.resolve({ rows: [] });

    const [data, stavby, firmy] = await Promise.all([
      pool.query(dataQ,   q.params),
      pool.query(stavbyQ, scopeParams),
      firmyQ,
    ]);

    const total = data.rows.reduce((s, r) => s + Number(r.tuny || 0), 0);

    // ADMIN: zobrazovaný název firmy = firma_taxis, jinak nazev_partnera (skutečný název
    // partnera z importu), jinak „(neuvedeno)". Žádné „(nepřiřazeno)". Pro ostatní role
    // se nic nepřidává (scoping drží jen vlastní firmu = firma_taxis vždy vyplněna).
    if (q.role === 'admin') {
      data.rows.forEach(r => {
        r.firma_display = r.firma_taxis || r.nazev_partnera || '(neuvedeno)';
      });
    }

    // Sestav admin číselník: distinct firma_taxis + "(nepřiřazeno)" pokud existuje NULL
    let firmyList = [];
    if (q.role === 'admin') {
      firmyList = firmy.rows
        .filter(r => r.firma_taxis !== null)
        .map(r => r.firma_taxis);
      if (firmy.rows.some(r => r.firma_taxis === null)) firmyList.push('(nepřiřazeno)');
    }

    res.json({
      role:         q.role,
      rows:         data.rows,
      stavby:       stavby.rows.map(r => r.stavba),
      firmy:        firmyList,            // jen admin, jinak []
      total_tuny:   Math.round(total * 1000) / 1000,
      firma_filter: q.firma_filter,        // co server reálně použil (admin-only)
    });
  } catch (err) {
    console.error('GET /api/vazenky error:', err);
    res.status(500).json({ error: 'Chyba serveru' });
  }
});

// Export do .xlsx — používá STEJNÝ buildVazenkyQuery → stejný scope+filtr.
app.get('/api/vazenky/export', requireAuth, async (req, res) => {
  try {
    const q = await buildVazenkyQuery(req);
    if (q.forbidden) return res.status(403).json({ error: 'Přístup k odebraným stavbám není povolen.' });
    const rowsRes = q.empty
      ? { rows: [] }
      : await pool.query(
          `SELECT cislo_vazenky, firma_taxis, nazev_partnera, stavba, datum, cas, smes, itt, tuny, spz, ridic
           FROM vazenky
           ${q.whereSQL}
           ORDER BY datum ASC, cas ASC
           LIMIT 50000`,
          q.params
        );

    const isAdmin = q.role === 'admin';

    // Hlavička — „Číslo DL" je VŽDY první sloupec, pak (admin only) Firma, pak zbytek.
    const headers = isAdmin
      ? ['Číslo DL', 'Firma', 'Stavba', 'Datum', 'Čas', 'Směs', 'ITT', 'Tuny', 'SPZ', 'Jméno řidiče']
      : ['Číslo DL',          'Stavba', 'Datum', 'Čas', 'Směs', 'ITT', 'Tuny', 'SPZ', 'Jméno řidiče'];
    // Indexy klíčových sloupců (1-based pro ExcelJS):
    const datumColIdx = isAdmin ? 4 : 3;   // posunuto o +1 (před nimi nově Číslo DL)
    const tunyColIdx  = isAdmin ? 8 : 7;
    const lastCol     = String.fromCharCode(64 + headers.length); // A,B,C…

    const wb = new ExcelJS.Workbook();
    wb.creator = 'HMG TAXIS';
    wb.created = new Date();
    const ws = wb.addWorksheet('Odebrané stavby', { views: [{ state: 'frozen', ySplit: 1 }] });

    // Hlavička — řádek 1 (bez úvodních titulkových řádků)
    const headerRow = ws.addRow(headers);
    headerRow.eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      c.alignment = { vertical: 'middle', horizontal: 'left' };
      c.border = { bottom: { style: 'thin', color: { argb: 'FF334155' } } };
    });
    headerRow.height = 22;

    // Šířky (první = Číslo DL = 14)
    const widths = isAdmin
      ? [14, 16, 28, 12, 8, 22, 14, 10, 12, 22]
      : [14,     28, 12, 8, 22, 14, 10, 12, 22];
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    // „Číslo DL" jako text (Excel ho jinak může vyhodnotit jako číslo a uříznout nuly)
    ws.getColumn(1).numFmt = '@';

    // Datum jako jednotný TEXT 'dd.mm.yyyy' (zabrání zobrazení Excelového sériového čísla).
    // Zvládne Date i string z DB; neplatná/prázdná hodnota → prázdná buňka.
    const fmtDatumCell = (v) => {
      if (v == null || v === '') return '';
      if (typeof v === 'string') {
        const m = v.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return `${m[3]}.${m[2]}.${m[1]}`;
        const d = new Date(v);
        return isNaN(d.getTime()) ? '' : `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
      }
      if (v instanceof Date) {
        return isNaN(v.getTime()) ? '' : `${String(v.getDate()).padStart(2,'0')}.${String(v.getMonth()+1).padStart(2,'0')}.${v.getFullYear()}`;
      }
      return '';
    };

    // Datové řádky
    let total = 0;
    for (const r of rowsRes.rows) {
      const cisloDL = String(r.cislo_vazenky || '');
      // Admin (jediný, kdo má sloupec Firma): firma_taxis → skutečný název partnera → „(neuvedeno)"
      const firmaCell = r.firma_taxis || r.nazev_partnera || '(neuvedeno)';
      const datumStr = fmtDatumCell(r.datum);
      const tuny = Number(r.tuny) || 0;
      total += tuny;
      const values = isAdmin
        ? [cisloDL, firmaCell, r.stavba || '(neuvedeno)', datumStr, r.cas || '', r.smes || '', r.itt || '', tuny, r.spz || '', r.ridic || '']
        : [cisloDL,            r.stavba || '(neuvedeno)', datumStr, r.cas || '', r.smes || '', r.itt || '', tuny, r.spz || '', r.ridic || ''];
      const row = ws.addRow(values);
      // Datum je text → bez numFmt; formátujeme jen Tuny.
      row.getCell(datumColIdx).numFmt = '@';
      row.getCell(tunyColIdx).numFmt  = '#,##0.00';
      row.getCell(tunyColIdx).alignment = { horizontal: 'right' };
    }

    // Součtový řádek: „Celkem" v sloupci o jeden vlevo od Tuny, suma v Tuny.
    const sumValues = new Array(headers.length).fill('');
    sumValues[tunyColIdx - 2] = 'Celkem';
    sumValues[tunyColIdx - 1] = Math.round(total * 1000) / 1000;
    const sumRow = ws.addRow(sumValues);
    sumRow.font = { bold: true };
    sumRow.eachCell(c => {
      c.border = { top: { style: 'medium', color: { argb: 'FF1E293B' } } };
      c.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    });
    sumRow.getCell(tunyColIdx).numFmt = '#,##0.00';
    sumRow.getCell(tunyColIdx).alignment = { horizontal: 'right' };

    // Auto-filtr na hlavičku (řádek 1)
    ws.autoFilter = `A1:${lastCol}1`;

    const buf = await wb.xlsx.writeBuffer();

    // ── Název souboru: "<stavba> export DD-MM-RRRR.xlsx" ────────────────────
    // <stavba> = filtr stavby, fallback "Odebrané stavby", speciál "(neuvedeno)"→"neuvedeno"
    const stavbaRaw = (q.stavba || '').trim();
    let prettyStavba;
    if (!stavbaRaw)                       prettyStavba = 'Odebrané stavby';
    else if (stavbaRaw === '(neuvedeno)') prettyStavba = 'neuvedeno';
    else                                  prettyStavba = stavbaRaw;
    // Sanitizace: zakázané znaky v názvech souborů (\ / : * ? " < > |)
    // a vícenásobné mezery slít do jedné. Diakritika zachována.
    const sanitize = s => String(s || '').replace(/[\\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
    prettyStavba = sanitize(prettyStavba);

    const now = new Date();
    const dd   = String(now.getDate()).padStart(2, '0');
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    const dateStr = `${dd}-${mm}-${yyyy}`;

    const fullName  = `${prettyStavba} export ${dateStr}.xlsx`;
    // ASCII fallback (odstraň diakritiku) pro starší prohlížeče / proxy
    const asciiName = sanitize(fullName.normalize('NFD').replace(/[̀-ͯ]/g, ''));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // RFC 5987: filename="..." (ASCII) + filename*=UTF-8''<percent-encoded> (plný název s diakritikou)
    res.setHeader('Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fullName)}`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('GET /api/vazenky/export error:', err);
    res.status(500).json({ error: 'Chyba serveru při generování exportu' });
  }
});


// ── Sdílený zdroj „Potvrzené stavby" — používá /api/dashboard i /api/dashboard/export ──
// Scope a SELECT MUSÍ být na jednom místě, ať se výpis a export nikdy nemohou rozejít.
// Admin → vidí všechny firmy (vč. sloupce firma); klient (hmg_share) → jen řádky s ceta = users.firma.
async function loadConfirmedForDashboard(req) {
  const uRes = await pool.query('SELECT role, firma FROM users WHERE id=$1', [req.session.userId]);
  const role  = (uRes.rows[0] && uRes.rows[0].role)  || req.session.role;
  const firma = (uRes.rows[0] && uRes.rows[0].firma) || null;
  const isAdmin = role === 'admin';

  const dayVal  = `COALESCE(NULLIF(row_data->>('d' || offs.n::text), '')::numeric, 0)`;
  const baseFROM = `
    FROM week_data wd,
         jsonb_array_elements(wd.rows_json::jsonb) AS row_data,
         (VALUES (0),(1),(2),(3),(4),(5),(6)) AS offs(n)
  `;
  // SCOPE: multi-obalovna (wd.obalovna_id = $1) VŽDY + role/firma scope (klient nemůže obejít).
  // obalovna_id je DALŠÍ podmínka navíc, role/firma scoping zůstává beze změny.
  const obalovnaId = getObalovnaId(req);
  const params = [obalovnaId];
  let whereScope = `WHERE wd.obalovna_id = $1
       AND ${dayVal} > 0
       AND (wd.week_start::date + (offs.n || ' days')::interval)::date >= CURRENT_DATE`;
  if (!isAdmin) { params.push(firma || ''); whereScope += ` AND row_data->>'ceta' = $${params.length}`; }

  // Pole pro výpis — admin má navíc firmu (ceta)
  const selectCols = isAdmin
    ? `SELECT (wd.week_start::date + (offs.n || ' days')::interval)::date::text AS datum,
              row_data->>'lokalita'   AS lokalita,
              row_data->>'smes'       AS smes,
              row_data->>'itt'        AS itt,
              row_data->>'objednavka' AS komentar,
              row_data->>'ceta'       AS firma,
              ${dayVal}               AS tuny`
    : `SELECT (wd.week_start::date + (offs.n || ' days')::interval)::date::text AS datum,
              row_data->>'lokalita'   AS lokalita,
              row_data->>'smes'       AS smes,
              row_data->>'itt'        AS itt,
              row_data->>'objednavka' AS komentar,
              ${dayVal}               AS tuny`;

  const [list, agg] = await Promise.all([
    pool.query(`${selectCols} ${baseFROM} ${whereScope} ORDER BY datum ASC`, params),
    pool.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(${dayVal}), 0) AS tons ${baseFROM} ${whereScope}`, params),
  ]);
  return {
    role, firma,
    confirmedList:  list.rows,
    confirmedTons:  parseInt(agg.rows[0].tons, 10),
    confirmedCount: parseInt(agg.rows[0].cnt,  10),
  };
}

// ── Dashboard API ─────────────────────────────────────────────────────────────
// Vrací agregovaná data pro /dashboard stránku.
// role=admin → vidí objednávky všech firem; ostatní → jen svoji firmu.
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const [confirmedData, oeRes, vsRes, uaRes] = await Promise.all([
      loadConfirmedForDashboard(req),
      pool.query("SELECT value FROM obalovna_settings WHERE obalovna_id=$1 AND key='orders_enabled'", [getObalovnaId(req)]),       // per-obalovna
      pool.query("SELECT value FROM obalovna_settings WHERE obalovna_id=$1 AND key='vazenky_share_enabled'", [getObalovnaId(req)]), // per-obalovna
      pool.query('SELECT orders_allowed FROM users WHERE id=$1', [req.session.userId]),
    ]);
    const { role, firma, confirmedList, confirmedTons, confirmedCount } = confirmedData;
    const obalovnaId = getObalovnaId(req);   // multi-obalovna: další podmínka navíc
    // KASKÁDA krok 6: efektivní stav = strop modulu (obalovna) AND přepínač (settings).
    // Pro Holubici jsou moduly true → efektivní = settings → identické s dneškem.
    const moduly = await getObalovnaModuly(pool, obalovnaId);
    const ordersEnabled = ((oeRes.rows[0] ? oeRes.rows[0].value : 'true') === 'true') && moduly.mod_objednavky;
    const vazenkyShareEnabled = ((vsRes.rows[0] ? vsRes.rows[0].value : 'false') === 'true') && moduly.mod_vazenky;
    const ordersAllowed = !!(uaRes.rows[0] && uaRes.rows[0].orders_allowed === true);

    let pendingList, recentOrders;

    if (role === 'admin') {
      const [pRes, rRes] = await Promise.all([
        pool.query(
          `SELECT o.*, u.username
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           WHERE o.obalovna_id=$1 AND o.status IN ('pending','pre_approved','pre_rejected')
           ORDER BY o.created_at ASC`,
          [obalovnaId]
        ),
        pool.query(
          `SELECT o.*, u.username
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           WHERE o.obalovna_id=$1
           ORDER BY o.created_at DESC LIMIT 10`,
          [obalovnaId]
        ),
      ]);
      pendingList  = pRes.rows;
      recentOrders = rRes.rows;
    } else {
      const firmaParam = firma || '';
      const [pRes, rRes] = await Promise.all([
        pool.query(
          `SELECT * FROM orders
           WHERE obalovna_id=$2 AND firma=$1 AND status IN ('pending','pre_approved','pre_rejected')
           ORDER BY created_at ASC`,
          [firmaParam, obalovnaId]
        ),
        pool.query(
          `SELECT * FROM orders WHERE obalovna_id=$2 AND firma=$1 ORDER BY created_at DESC LIMIT 10`,
          [firmaParam, obalovnaId]
        ),
      ]);
      pendingList  = pRes.rows;
      recentOrders = rRes.rows;
    }

    res.json({
      role,
      firma,
      orders_enabled: ordersEnabled,
      orders_allowed: ordersAllowed,
      vazenky_share_enabled: vazenkyShareEnabled,
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

// ── Export „Potvrzené stavby" do Excelu — používá STEJNÝ loader jako výpis ──
app.get('/api/dashboard/export', requireAuth, async (req, res) => {
  try {
    const { role, firma, confirmedList, confirmedTons } = await loadConfirmedForDashboard(req);
    const isAdmin = role === 'admin';

    // Seskupení lokalita → den → dodávky (identicky jako buildConfirmedView v dashboard.html)
    const byL = new Map();
    for (const o of confirmedList) {
      const lok  = o.lokalita || '–';
      const tuny = Number(o.tuny) || 0;
      let node = byL.get(lok);
      if (!node) { node = { firma: o.firma || '', total: 0, days: new Map() }; byL.set(lok, node); }
      node.total += tuny;
      let day = node.days.get(o.datum);
      if (!day) { day = { sum: 0, items: [] }; node.days.set(o.datum, day); }
      day.sum += tuny;
      day.items.push({ smes: o.smes || '–', itt: o.itt || '', tuny });
    }
    // Řazení staveb dle nejmenšího data — stejně jako na obrazovce
    const stavby = Array.from(byL.entries()).map(([lok, n]) => {
      const dayKeys = Array.from(n.days.keys()).sort();
      return { lok, firma: n.firma, total: n.total, dayKeys, days: n.days, first: dayKeys[0] || '' };
    });
    stavby.sort((a, b) => a.first.localeCompare(b.first));

    // ExcelJS workbook
    const wb = new ExcelJS.Workbook();
    wb.creator = 'HMG TAXIS';
    wb.created = new Date();
    const ws = wb.addWorksheet('Potvrzené stavby');

    // Šířky a numFmt
    ws.getColumn(1).width = 42;   // popis (stavba / datum / směs)
    ws.getColumn(2).width = 18;   // ITT (jen u dodávek)
    ws.getColumn(3).width = 12;   // tuny

    const WEEKDAY = ['ne','po','út','st','čt','pá','so'];
    const fmtDateCs = iso => {
      const d = new Date(iso + 'T00:00:00Z');
      return `${WEEKDAY[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2,'0')}. ${String(d.getUTCMonth()+1).padStart(2,'0')}. ${d.getUTCFullYear()}`;
    };

    // Titulek
    const scopeLabel = isAdmin ? 'Vše (admin)' : (firma || '(bez firmy)');
    ws.mergeCells('A1:C1'); ws.getCell('A1').value = 'Potvrzené stavby — export';
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.mergeCells('A2:C2'); ws.getCell('A2').value = `Rozsah: ${scopeLabel}`;
    ws.getCell('A2').font = { size: 10, color: { argb: 'FF475569' } };
    ws.mergeCells('A3:C3'); ws.getCell('A3').value = `Vygenerováno: ${new Date().toLocaleString('cs-CZ')}`;
    ws.getCell('A3').font = { size: 10, color: { argb: 'FF94A3B8' } };
    ws.addRow([]); // prázdný řádek

    // Pro každou stavbu blok
    for (const s of stavby) {
      // Řádek hlavičky stavby: lokalita | (firma admin) | "Celkem X t"
      const headerLabel = isAdmin && s.firma
        ? `Stavba: ${s.lok}    |    Firma: ${s.firma}`
        : `Stavba: ${s.lok}`;
      const hRow = ws.addRow([headerLabel, '', `Celkem ${s.total} t`]);
      hRow.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      hRow.eachCell(c => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
        c.border = { bottom: { style: 'thin', color: { argb: 'FF334155' } } };
      });
      hRow.getCell(3).alignment = { horizontal: 'right' };
      hRow.height = 22;

      // Dny chronologicky
      for (const d of s.dayKeys) {
        const day = s.days.get(d);
        const dRow = ws.addRow([fmtDateCs(d), '', `${day.sum} t`]);
        dRow.font = { bold: true, color: { argb: 'FF1E40AF' } };
        dRow.eachCell(c => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
        });
        dRow.getCell(3).alignment = { horizontal: 'right' };
        dRow.getCell(3).numFmt    = '#,##0.00" t"';

        // Dodávky (Směs | ITT | Tuny)
        for (const it of day.items) {
          const iRow = ws.addRow([`    ${it.smes}`, it.itt, Number(it.tuny)]);
          iRow.getCell(3).numFmt    = '#,##0.00';
          iRow.getCell(3).alignment = { horizontal: 'right' };
          iRow.getCell(2).font      = { color: { argb: 'FF64748B' }, size: 11 };
        }
      }
      ws.addRow([]); // prázdný oddělovač mezi stavbami
    }

    // CELKOVÝ řádek (= souhrn v nadpisu na obrazovce)
    const totalRow = ws.addRow(['CELKEM', '', `${confirmedTons} t`]);
    totalRow.font = { bold: true, size: 12 };
    totalRow.eachCell(c => {
      c.border = { top: { style: 'medium', color: { argb: 'FF1E293B' } } };
      c.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    });
    totalRow.getCell(3).alignment = { horizontal: 'right' };
    totalRow.getCell(3).numFmt    = '#,##0.00" t"';

    const buf = await wb.xlsx.writeBuffer();

    // Název souboru: "Potvrzené stavby export DD-MM-RRRR.xlsx" (RFC 5987)
    const sanitize = s => String(s || '').replace(/[\\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${now.getFullYear()}`;
    const fullName  = sanitize(`Potvrzené stavby export ${dateStr}.xlsx`);
    const asciiName = sanitize(fullName.normalize('NFD').replace(/[̀-ͯ]/g, ''));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fullName)}`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('GET /api/dashboard/export error:', err);
    res.status(500).json({ error: 'Chyba serveru při generování exportu' });
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
  // Hlídání stáří zálohy — běží vždy, varuje když je last_backup > 36 h
  checkBackupAge();
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
    sendBackup, collectObalovnaSnapshot, listObalovnyForBackup, restoreFromSnapshot,
    // Objednávkový tok — sdílená write-propagace do week_data (Tier 1)
    propagateOrderToWeekData,
    // Multi-obalovna (Tier 1 unit) — aktivní obalovna + superadmin gate + pojistka + moduly
    getObalovnaId, requireSuperadmin, isLastSuperadmin, normalizeModuly, generateTempPassword,
    // HTTP + DB přístup (Tier 2 supertest)
    app, pool, initDb,
  };
}
