'use strict';
/**
 * Jest setupFiles pro Tier 2 testy — načte .env.test PŘED importem serveru.
 * Tento soubor se spouští v každém workeru před načtením testovacích modulů.
 */
const path = require('path');

// Načti .env.test a přepiš případné stávající proměnné (.env se mohl načíst dříve)
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.test'), override: true });

// ── Bezpečnostní pojistka ─────────────────────────────────────────────────────
// Tier 2 testy mažou a přepisují DB data — musíme být jisti, že nepíšeme na produkci.
const dbUrl = process.env.DATABASE_URL || '';
const isSafe =
  dbUrl === '' ||
  dbUrl.includes('localhost') ||
  dbUrl.includes('127.0.0.1') ||
  dbUrl.toLowerCase().includes('test') ||
  dbUrl.toLowerCase().includes('dev');

if (!isSafe) {
  throw new Error(
    '\n[BEZPEČNOST] DATABASE_URL v .env.test nevypadá jako testovací DB!\n' +
    'URL musí obsahovat "localhost", "127.0.0.1", "test" nebo "dev".\n' +
    'Zkontrolujte .env.test a NIKDY nepoužívejte produkční DB pro Tier 2 testy.\n'
  );
}
