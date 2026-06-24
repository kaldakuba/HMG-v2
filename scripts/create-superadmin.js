'use strict';
/**
 * Jednorázové bezpečné založení SUPERADMIN účtu (multi-obalovna, krok 4).
 *
 * NENÍ to veřejný endpoint — spouští ho ručně vlastník v terminálu.
 * Heslo se NIKDY neukládá do kódu ani nevypisuje do logu; bere se z proměnné prostředí.
 *
 * Použití (PowerShell):
 *   cd C:\Users\42073\HMG-v2
 *   $env:SUPERADMIN_USERNAME = 'superadmin'
 *   $env:SUPERADMIN_PASSWORD = '<silne-heslo>'
 *   node scripts/create-superadmin.js
 *   Remove-Item Env:SUPERADMIN_PASSWORD   # úklid proměnné po doběhnutí
 *
 * Použití (bash):
 *   SUPERADMIN_USERNAME=superadmin SUPERADMIN_PASSWORD='<silne-heslo>' node scripts/create-superadmin.js
 *
 * Volby:
 *   --force   přepíše heslo, pokud uživatel se zadaným jménem už existuje (a je superadmin).
 *
 * DATABASE_URL se bere z .env (stejně jako server).
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

(async () => {
  const username = (process.env.SUPERADMIN_USERNAME || '').trim();
  const password = process.env.SUPERADMIN_PASSWORD || '';
  const force = process.argv.includes('--force');

  if (!username || !password) {
    console.error('CHYBA: nastav proměnné SUPERADMIN_USERNAME a SUPERADMIN_PASSWORD (viz hlavička skriptu).');
    process.exit(1);
  }
  if (username.length < 3 || username.length > 50) {
    console.error('CHYBA: uživatelské jméno musí mít 3–50 znaků.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('CHYBA: heslo superadmina musí mít alespoň 8 znaků.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('CHYBA: chybí DATABASE_URL (.env).');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const existing = await pool.query('SELECT id, role FROM users WHERE username=$1', [username]);
    const hash = await bcrypt.hash(password, 12);

    if (existing.rows.length > 0) {
      const cur = existing.rows[0];
      if (!force) {
        console.error(`CHYBA: uživatel '${username}' už existuje (role=${cur.role}). Pro reset hesla spusť s --force.`);
        process.exit(1);
      }
      if (cur.role !== 'superadmin') {
        console.error(`CHYBA: uživatel '${username}' existuje, ale není superadmin (role=${cur.role}). Nebudu měnit.`);
        process.exit(1);
      }
      await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, cur.id]);
      console.log(`OK: heslo superadmina '${username}' bylo resetováno.`);
    } else {
      await pool.query(
        `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'superadmin')`,
        [username, hash]
      );
      console.log(`OK: superadmin '${username}' vytvořen.`);
    }
  } catch (err) {
    console.error('CHYBA při zakládání superadmina:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
