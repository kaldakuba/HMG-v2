const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const app = express();
app.set('trust proxy', 1); // Railway reverse proxy
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Railway persistent volume - nastav volume mount path na /data v Railway dashboardu
// Lokálně se použije ./data.db
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? require('path').join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data.db')
  : path.join(__dirname, 'data.db');
console.log('DB path:', DB_PATH);
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS week_data (
    week_start TEXT PRIMARY KEY,
    rows_json TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS inputs (
    id INTEGER PRIMARY KEY,
    rows_json TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS month_entries (
    id INTEGER PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS viewers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    invite_token TEXT,
    invite_used INTEGER DEFAULT 0,
    session_token TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT
  );
`);

app.use(express.static(path.join(__dirname, 'public')));

function requireViewer(req, res, next) {
  try {
    // Token může být v URL (?t=...) nebo v cookie
    const token = req.query.t || (req.cookies && req.cookies.hmg_viewer_token);
    if (!token) return res.redirect('/month-login');
    const viewer = db.prepare('SELECT * FROM viewers WHERE session_token = ? AND status = ?').get(token, 'active');
    if (!viewer) return res.redirect('/month-login');
    try { db.prepare('UPDATE viewers SET last_seen = datetime("now") WHERE id = ?').run(viewer.id); } catch(e){}
    req.viewer = viewer;
    // Uložit token do cookie jako záloha
    try {
      res.cookie('hmg_viewer_token', token, {
        httpOnly: true, maxAge: 365*24*60*60*1000, sameSite: 'lax'
      });
    } catch(e){}
    next();
  } catch(err) {
    console.error('requireViewer error:', err);
    res.redirect('/month-login');
  }
}

app.get("/month", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "month.html"));
});

app.get("/inputs", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "inputs.html"));
});

app.get("/month-view", (req, res) => {
  // Stránka se načte vždy, ověření tokenu probíhá v JS přes /api/viewer-check
  const fp = path.join(__dirname, 'public', 'month-view.html');
  res.sendFile(fp, err => {
    if (err) {
      console.error('month-view sendFile error:', err);
      res.status(500).send('Soubor month-view.html nebyl nalezen na serveru.');
    }
  });
});

app.get('/month-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'month-login.html'));
});

app.get('/api/verify/:token', (req, res) => {
  const { token } = req.params;

  // Nejdřív zkus najít jako invite_token
  let viewer = db.prepare('SELECT * FROM viewers WHERE invite_token = ?').get(token);
  if (viewer) {
    // Aktivuj - invite token se stane session tokenem (NEMAŽ ho - TrendMicro ho spotřebuje dřív)
    db.prepare(`UPDATE viewers SET session_token=?, status='active', last_seen=datetime('now') WHERE id=?`)
      .run(token, viewer.id);
    // Přesměruj s tímto tokenem - platí opakovaně dokud admin neodvolá
    return res.redirect('/month-view?t=' + token);
  }

  // Zkus jako session_token (opakované použití)
  viewer = db.prepare('SELECT * FROM viewers WHERE session_token = ? AND status = ?').get(token, 'active');
  if (viewer) {
    db.prepare('UPDATE viewers SET last_seen = datetime("now") WHERE id = ?').run(viewer.id);
    return res.redirect('/month-view?t=' + token);
  }

  return res.redirect('/month-login?err=invalid');
});

// Ověření tokenu pro month-view
app.get('/api/viewer-check', (req, res) => {
  const token = req.query.t;
  if (!token) return res.json({ ok: false });
  const viewer = db.prepare('SELECT email, status FROM viewers WHERE session_token = ? AND status = ?').get(token, 'active');
  if (!viewer) return res.json({ ok: false });
  db.prepare('UPDATE viewers SET last_seen = datetime("now") WHERE session_token = ?').run(token);
  res.json({ ok: true, email: viewer.email });
});

app.get('/api/viewers', (req, res) => {
  const rows = db.prepare('SELECT id, email, status, invite_used, created_at, last_seen FROM viewers ORDER BY created_at DESC').all();
  res.json(rows);
});

app.post('/api/viewers', (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Neplatný email' });
  const existing = db.prepare('SELECT * FROM viewers WHERE email = ?').get(email);
  const inviteToken = crypto.randomBytes(24).toString('hex');
  if (existing) {
    db.prepare(`UPDATE viewers SET invite_token=?, invite_used=0, session_token=NULL, status='pending', created_at=datetime('now') WHERE email=?`).run(inviteToken, email);
  } else {
    db.prepare(`INSERT INTO viewers (email, invite_token, status) VALUES (?, ?, 'pending')`).run(email, inviteToken);
  }
  const baseUrl = req.protocol + '://' + req.get('host');
  const link = `${baseUrl}/api/verify/${inviteToken}`;
  res.json({ ok: true, link, email });
});

app.post('/api/viewers/:id/revoke', (req, res) => {
  db.prepare(`UPDATE viewers SET status='revoked', session_token=NULL WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/viewers/:id/restore', (req, res) => {
  const inviteToken = crypto.randomBytes(24).toString('hex');
  db.prepare(`UPDATE viewers SET status='pending', invite_token=?, invite_used=0, session_token=NULL WHERE id=?`).run(inviteToken, req.params.id);
  const viewer = db.prepare('SELECT email FROM viewers WHERE id=?').get(req.params.id);
  const baseUrl = req.protocol + '://' + req.get('host');
  const link = `${baseUrl}/api/verify/${inviteToken}`;
  res.json({ ok: true, link, email: viewer.email });
});

app.delete('/api/viewers/:id', (req, res) => {
  db.prepare('DELETE FROM viewers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/week/:start', (req, res) => {
  const row = db.prepare('SELECT rows_json FROM week_data WHERE week_start=?').get(req.params.start);
  res.json(row ? JSON.parse(row.rows_json) : null);
});
app.post('/api/week/:start', (req, res) => {
  const { rows } = req.body;
  db.prepare(`INSERT INTO week_data (week_start,rows_json,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(week_start) DO UPDATE SET rows_json=excluded.rows_json,updated_at=excluded.updated_at`).run(req.params.start, JSON.stringify(rows));
  res.json({ ok: true });
});
app.get('/api/weeks', (req, res) => {
  const rows = db.prepare('SELECT week_start,rows_json FROM week_data ORDER BY week_start').all();
  res.json(rows.map(r => ({ start: r.week_start, rows: JSON.parse(r.rows_json) })));
});
app.get('/api/month-entries', (req, res) => {
  // Ověř token pokud přichází z month-view (má ?t=)
  if (req.query.t) {
    const viewer = db.prepare('SELECT * FROM viewers WHERE session_token = ? AND status = ?').get(req.query.t, 'active');
    if (!viewer) return res.status(403).json({ error: 'Přístup zamítnut' });
    try { db.prepare('UPDATE viewers SET last_seen = datetime("now") WHERE id = ?').run(viewer.id); } catch(e){}
  }
  const row = db.prepare('SELECT data_json FROM month_entries WHERE id=1').get();
  res.json(row ? JSON.parse(row.data_json) : {});
});
app.post('/api/month-entries', (req, res) => {
  db.prepare(`INSERT INTO month_entries (id,data_json,updated_at) VALUES(1,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at`).run(JSON.stringify(req.body));
  res.json({ ok: true });
});
app.get('/api/inputs', (req, res) => {
  const row = db.prepare('SELECT rows_json FROM inputs WHERE id=1').get();
  res.json(row ? JSON.parse(row.rows_json) : null);
});
app.post('/api/inputs', (req, res) => {
  const { rows } = req.body;
  db.prepare(`INSERT INTO inputs (id,rows_json,updated_at) VALUES(1,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET rows_json=excluded.rows_json,updated_at=excluded.updated_at`).run(JSON.stringify(rows));
  res.json({ ok: true });
});
app.get('/api/companies', (req, res) => {
  const row = db.prepare('SELECT data_json FROM companies WHERE id=1').get();
  res.json(row ? JSON.parse(row.data_json) : null);
});
app.post('/api/companies', (req, res) => {
  const { companies } = req.body;
  db.prepare(`INSERT INTO companies (id,data_json,updated_at) VALUES(1,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at`).run(JSON.stringify(companies));
  res.json({ ok: true });
});
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const obj = {}; rows.forEach(r => obj[r.key]=r.value); res.json(obj);
});
app.post('/api/settings', (req, res) => {
  const upsert = db.prepare(`INSERT INTO settings (key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  Object.entries(req.body).forEach(([k,v]) => upsert.run(k, String(v)));
  res.json({ ok: true });
});
app.get('/api/export', (req, res) => {
  const weeks = db.prepare('SELECT week_start,rows_json FROM week_data ORDER BY week_start').all().map(r=>({start:r.week_start,rows:JSON.parse(r.rows_json)}));
  res.json({ version:2, type:'HMG_WEEK_DATA', created:new Date().toISOString(), weeks });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── IMPORT Z EXCELU (xlsx, cellDates:false = raw serial numbers) ──
const multer = require('multer');
const XLSX = require('xlsx');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function xlsxDateToIso(serial) {
  // Excel serial -> ISO date string
  const d = XLSX.SSF.parse_date_code(serial);
  if (!d) return null;
  return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
}

function fv(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'object') return ''; // datum objekt
  const n = parseFloat(v);
  return isNaN(n) || n === 0 ? '' : Math.round(n * 10) / 10;
}

app.post('/api/import-excel', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Žádný soubor' });
  try {
    // cellDates:false = všechny datumy jako čísla (serial), raw:true = neformátovat
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false, raw: true });

    // ── RECEPTURY ──
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
      const zt   = r[2] ? String(r[2]).trim() : '';
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

    // ── TÝDENNÍ DATA ──
    const weekSheets = wb.SheetNames.filter(s => /^\d+$/.test(s));
    const weekMap = {};
    const hmgEntries = {};

    for (const sheetName of weekSheets) {
      const ws = wb.Sheets[sheetName];
      if (!ws) continue;

      // Řádek 2 (index 1 = row 2): datumy v sloupcích G-M (col index 6-12)
      // S cellDates:false jsou datumy Excel serial čísla
      const dates = [];
      for (let ci = 6; ci <= 12; ci++) {
        const addr = XLSX.utils.encode_cell({ r: 1, c: ci });
        const cell = ws[addr];
        if (!cell) { dates.push(null); continue; }
        // Datum buňka má type 'n' a number_format obsahuje datum
        let iso = null;
        if (cell.t === 'n' && cell.v > 40000) {
          iso = xlsxDateToIso(cell.v);
        } else if (cell.t === 'd') {
          const dt = new Date(cell.v);
          iso = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
        }
        dates.push(iso);
      }

      const weekStart = dates[0];
      if (!weekStart) continue;

      const rows = [];
      // Řádky 3-35 (row index 2-34)
      for (let ri = 2; ri <= 34; ri++) {
        const getCell = (ci) => {
          const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
          return ws[addr] || null;
        };
        const getStr = (ci) => {
          const cell = getCell(ci);
          if (!cell) return '';
          // Pokud je to vzorec (f) s výsledkem (v)
          if (cell.v !== undefined && cell.v !== null) return String(cell.v).trim();
          return '';
        };
        const getNum = (ci) => {
          const cell = getCell(ci);
          if (!cell || cell.v === undefined || cell.v === null) return '';
          const n = parseFloat(cell.v);
          return (isNaN(n) || n <= 0) ? '' : Math.round(n);
        };

        const smes = getStr(3);
        const itt  = getStr(4);
        const ceta = getStr(5);
        if (!smes || !itt) continue;

        // Cislo - může být vzorec, bereme hodnotu nebo z mapy
        let cislo = '';
        const cisloCell = getCell(0);
        if (cisloCell && cisloCell.v !== undefined && cisloCell.v !== null) {
          const n = parseFloat(cisloCell.v);
          if (!isNaN(n) && n > 0) cislo = String(Math.round(n));
        }
        if (!cislo) cislo = ittToCislo[itt] || '';

        // Objednávka
        let objednavka = getStr(2);
        const objCell = getCell(2);
        if (objCell && objCell.t === 'n') objednavka = String(Math.round(objCell.v));

        const entry = {
          checked: false, cislo,
          lokalita: getStr(1), objednavka,
          smes, itt, ceta,
          d0: getNum(6), d1: getNum(7), d2: getNum(8), d3: getNum(9),
          d4: getNum(10), d5: getNum(11), d6: getNum(12)
        };
        rows.push(entry);

        // Měsíční záznamy
        for (let di = 0; di <= 6; di++) {
          const tuny = parseInt(entry[`d${di}`]) || 0;
          if (!tuny || !dates[di]) continue;
          if (!hmgEntries[dates[di]]) hmgEntries[dates[di]] = [];
          hmgEntries[dates[di]].push({
            lokalita: entry.lokalita, objednavka: entry.objednavka,
            smes, itt, ceta, tuny
          });
        }
      }

      if (rows.length > 0) weekMap[weekStart] = rows;
    }

    // ── ULOŽIT DO DB ──
    if (receptury.length > 0) {
      db.prepare(`INSERT INTO inputs (id, rows_json, updated_at) VALUES (1, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET rows_json=excluded.rows_json, updated_at=excluded.updated_at`)
        .run(JSON.stringify(receptury));
    }

    const upsertWeek = db.prepare(`INSERT INTO week_data (week_start, rows_json, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(week_start) DO UPDATE SET rows_json=excluded.rows_json, updated_at=excluded.updated_at`);
    for (const [ws, rows] of Object.entries(weekMap)) {
      upsertWeek.run(ws, JSON.stringify(rows));
    }

    if (Object.keys(hmgEntries).length > 0) {
      db.prepare(`INSERT INTO month_entries (id, data_json, updated_at) VALUES (1, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at`)
        .run(JSON.stringify(hmgEntries));
    }

    res.json({
      ok: true,
      receptury: receptury.length,
      tydnu: Object.keys(weekMap).length,
      dnu: Object.keys(hmgEntries).length,
      zaznamu: Object.values(hmgEntries).reduce((s, a) => s + a.length, 0)
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
