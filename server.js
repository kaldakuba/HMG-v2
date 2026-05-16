const express = require('express');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

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

// ── PostgreSQL pool ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

// ── Validace ──
function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
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
      role          TEXT NOT NULL DEFAULT 'viewer',
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
  `);

  // Vytvoř výchozího admina pokud neexistuje
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'hmg2026';
  const existing = await pool.query('SELECT id FROM users WHERE username = $1', [adminUser]);
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash(adminPass, 12);
    await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
      [adminUser, hash, 'admin']
    );
    console.log(`Vytvořen admin účet: ${adminUser}`);
  }
}

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ── Sessions ──
app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dní
    httpOnly: true,
    sameSite: 'lax',
    secure: false  // Railway proxy řeší HTTPS
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
  if (req.session && req.session.userId) return next();
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
  res.redirect('/');
}

// ── Stránky ──
app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  res.cookie('csrf', csrfToken, { httpOnly: false, sameSite: 'lax' });
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/month', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'month.html'));
});

app.get('/inputs', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'inputs.html'));
});

app.get('/month-view', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'month-view.html'));
});

// ── Auth API ──
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password, _csrf } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Vyplňte jméno a heslo' });
    const csrfCookie = req.cookies['csrf'];
    if (!_csrf || !csrfCookie || _csrf !== csrfCookie) {
      return res.status(403).json({ error: 'Neplatný bezpečnostní token. Obnovte stránku.' });
    }
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
    await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);
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

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.session.username, role: req.session.role });
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
  r.rows.forEach(row => obj[row.key] = row.value);
  res.json(obj);
});

app.post('/api/settings', requireAuth, requireAdmin, async (req, res) => {
  const allowed = ['hmg_max_daily', 'plant_rate'];
  for (const [k, v] of Object.entries(req.body)) {
    if (!allowed.includes(k)) continue;
    if (k === 'hmg_max_daily' || k === 'plant_rate') {
      const n = parseInt(v, 10);
      if (isNaN(n) || n <= 0 || n > 1000000) return res.status(400).json({ error: `${k} musí být kladné číslo` });
    }
    await pool.query(
      `INSERT INTO settings (key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
      [k, String(v)]
    );
  }
  res.json({ ok: true });
});

app.get('/api/export', requireAuth, async (req, res) => {
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
        `INSERT INTO inputs (id,rows_json,updated_at) VALUES(1,$1,NOW()) ON CONFLICT(id) DO NOTHING`,
        [JSON.stringify(receptury)]
      );
    }
    for (const [ws, rows] of Object.entries(weekMap)) {
      await pool.query(
        `INSERT INTO week_data (week_start,rows_json,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(week_start) DO NOTHING`,
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

// ── Globální error handler ──
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Interní chyba serveru' });
  }
  res.status(500).send('Interní chyba serveru');
});


// ── Emailová záloha ──
async function sendBackup() {
  try {
    const [weeks, inputs, companies, settings] = await Promise.all([
      pool.query('SELECT week_start,rows_json FROM week_data ORDER BY week_start'),
      pool.query('SELECT rows_json FROM inputs WHERE id=1'),
      pool.query('SELECT data_json FROM companies WHERE id=1'),
      pool.query('SELECT key,value FROM settings')
    ]);

    const settingsObj = {};
    settings.rows.forEach(r => settingsObj[r.key] = r.value);

    const backup = {
      version: 2,
      created: new Date().toISOString(),
      weeks: weeks.rows.map(r => ({ start: r.week_start, rows: JSON.parse(r.rows_json) })),
      inputs: inputs.rows[0] ? JSON.parse(inputs.rows[0].rows_json) : [],
      companies: companies.rows[0] ? JSON.parse(companies.rows[0].data_json) : [],
      settings: settingsObj
    };

    const date = new Date().toISOString().slice(0, 10);
    const filename = `hmg_zaloha_${date}.xlsx`;

    // Sestavit Excel soubor
    const wb = XLSX.utils.book_new();

    // List 1: Týdny
    backup.weeks.forEach(w => {
      const rows = w.rows.map(r => ({
        cislo: r.cislo||'', lokalita: r.lokalita||'', objednavka: r.objednavka||'',
        smes: r.smes||'', itt: r.itt||'', ceta: r.ceta||'',
        Po: r.d0||'', Ut: r.d1||'', St: r.d2||'', Ct: r.d3||'',
        Pa: r.d4||'', So: r.d5||'', Ne: r.d6||''
      }));
      if (rows.length > 0) {
        const ws = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, w.start.slice(5)); // MM-DD jako název listu
      }
    });

    // List 2: Receptury
    if (backup.inputs.length > 0) {
      const wsInputs = XLSX.utils.json_to_sheet(backup.inputs);
      XLSX.utils.book_append_sheet(wb, wsInputs, 'Receptury');
    }

    const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    await transporter.sendMail({
      from: `"HMG Záloha" <${process.env.GMAIL_USER}>`,
      to: process.env.BACKUP_EMAIL,
      subject: `HMG záloha ${date} — ${backup.weeks.length} týdnů`,
      text: `Automatická záloha dat harmonogramu výroby.\n\nObsah:\n- Týdnů: ${backup.weeks.length}\n- Receptur: ${backup.inputs.length}\n- Datum: ${date}`,
      attachments: [{
        filename,
        content: xlsxBuffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }]
    });

    console.log(`Záloha odeslána: ${filename}`);
    await pool.query("INSERT INTO settings (key,value) VALUES ('last_backup',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [new Date().toISOString()]);
  } catch (err) {
    console.error('Chyba zálohy:', err.message);
  }
}

// Spustit zálohu každý den v 18:00 (UTC+2 = 16:00 UTC)
function scheduleBackup() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(16, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  setTimeout(() => {
    sendBackup();
    setInterval(sendBackup, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`Záloha naplánována za ${Math.round(msUntil/60000)} minut`);
}

// Manuální spuštění zálohy (jen pro admina)
app.post('/api/backup/run', requireAuth, requireAdmin, async (req, res) => {
  sendBackup().then(() => res.json({ ok: true })).catch(e => res.status(500).json({ error: e.message }));
});

app.get('/settings', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});


app.get('/api/export-excel', requireAuth, async (req, res) => {
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
app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ════════════════════════════════════════════
// STRÁNKA NASTAVENÍ
// ════════════════════════════════════════════

// ── Správa uživatelů ──
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.username, u.role, u.created_at, u.last_seen,
      (SELECT COUNT(*) FROM session s WHERE s.sess->>'userId' = u.id::text AND s.expire > NOW()) as session_count
    FROM users u ORDER BY u.created_at
  `);
  res.json(r.rows);
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Vyplňte jméno a heslo' });
    if (!['admin','viewer'].includes(role)) return res.status(400).json({ error: 'Neplatná role' });
    if (username.length < 3 || username.length > 50) return res.status(400).json({ error: 'Jméno 3-50 znaků' });
    if (password.length < 6) return res.status(400).json({ error: 'Heslo min. 6 znaků' });
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id,username,role',
      [username.trim(), hash, role]
    );
    res.json({ ok: true, user: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Uživatel již existuje' });
    throw err;
  }
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

// ── Záloha - poslední datum ──
app.get('/api/backup/last', requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query("SELECT value FROM settings WHERE key='last_backup'");
  res.json({ last: r.rows[0] ? r.rows[0].value : null });
});


// ── Start ──
initDb()
  .then(() => { app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`)); if(process.env.GMAIL_USER) scheduleBackup(); })
  .catch(err => { console.error('DB init error:', err); process.exit(1); });
