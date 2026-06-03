'use strict';
/**
 * Tier 1 – Čisté jednotkové testy pomocných funkcí.
 * Nevyžadují databázi ani spuštěný server.
 *
 * Strategie izolace:
 *   - `pg` je mockován → pool.query() nikdy nevytvoří TCP spojení na Railway
 *   - `connect-pg-simple` je mockován → store nevyžaduje skutečnou DB
 *   - `nodemailer` je mockován → žádné SMTP pokusy při startu
 *   - PORT=0 → app.listen() dostane od OS náhodný volný port (žádný konflikt s :3000)
 */

// PORT musí být nastaven PŘED require('../server'), protože
// jest.mock() sice prochází hoistingem, ale process.env = je obyčejný příkaz
// a dotenv.config() nepremaže proměnné, které již existují.
process.env.PORT = '0';

// ── Mocky (hoistovány na začátek souboru) ────────────────────────────────────
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
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
  // Náhrada session store — express-session volá store.on(...) při inicializaci,
  // proto mock musí mít EventEmitter-like metody.
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
  createTransport: jest.fn(() => ({ sendMail: jest.fn() })),
}));

// ── Import testovaných funkcí ────────────────────────────────────────────────
const {
  isIsoDate,
  isIntOrEmpty,
  sanitizeStr,
  validateRows,
  fv,
  fmtDateCz,
  escHtml,
} = require('../server');

// ════════════════════════════════════════════════════════════════════════════
// 1. isIsoDate
// ════════════════════════════════════════════════════════════════════════════
describe('isIsoDate', () => {
  test('platná data jsou přijata', () => {
    expect(isIsoDate('2026-06-01')).toBe(true);
    expect(isIsoDate('2025-12-31')).toBe(true);
    expect(isIsoDate('2000-01-01')).toBe(true);
    expect(isIsoDate('1999-02-28')).toBe(true);
  });

  test('nesprávný formát je odmítnut', () => {
    expect(isIsoDate('01.06.2026')).toBe(false);  // česká notace
    expect(isIsoDate('2026-6-1')).toBe(false);    // chybějící nuly
    expect(isIsoDate('2026/06/01')).toBe(false);  // lomítka
    expect(isIsoDate('')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate(20260601)).toBe(false);      // číslo místo řetězce
  });

  test('neexistující kalendářní datum je odmítnut', () => {
    expect(isIsoDate('2026-13-01')).toBe(false);  // měsíc 13
    expect(isIsoDate('2026-00-01')).toBe(false);  // měsíc 0
    expect(isIsoDate('2026-02-30')).toBe(false);  // 30. února
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. isIntOrEmpty
// ════════════════════════════════════════════════════════════════════════════
describe('isIntOrEmpty', () => {
  test('platná celá čísla 0–99999 jsou přijata', () => {
    expect(isIntOrEmpty(0)).toBe(true);
    expect(isIntOrEmpty(1)).toBe(true);
    expect(isIntOrEmpty(99999)).toBe(true);   // horní hranice
    expect(isIntOrEmpty('42')).toBe(true);    // číselný řetězec
    expect(isIntOrEmpty('0')).toBe(true);
  });

  test('prázdné a null hodnoty jsou přijaty', () => {
    expect(isIntOrEmpty('')).toBe(true);
    expect(isIntOrEmpty(null)).toBe(true);
    expect(isIntOrEmpty(undefined)).toBe(true);
  });

  test('záporná, příliš velká a nečíselná jsou odmítnuta', () => {
    expect(isIntOrEmpty(-1)).toBe(false);
    expect(isIntOrEmpty(100000)).toBe(false);   // právě nad limitem
    expect(isIntOrEmpty(3.14)).toBe(false);     // desetinné číslo
    expect(isIntOrEmpty('1.5')).toBe(false);
    expect(isIntOrEmpty('abc')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3a. sanitizeStr
// ════════════════════════════════════════════════════════════════════════════
describe('sanitizeStr', () => {
  test('odstraní < a > (ochrana před vložením HTML tagů)', () => {
    expect(sanitizeStr('<script>alert(1)</script>')).toBe('scriptalert(1)/script');
    expect(sanitizeStr('<b>bold</b>')).toBe('bbold/b');
  });

  test('ořízne na výchozích 255 znaků', () => {
    expect(sanitizeStr('x'.repeat(300))).toHaveLength(255);
  });

  test('ořízne na vlastní délku', () => {
    expect(sanitizeStr('ahoj', 3)).toBe('aho');
    expect(sanitizeStr('hello', 10)).toBe('hello');  // kratší než limit → nezměněno
  });

  test('null a undefined vrátí prázdný řetězec', () => {
    expect(sanitizeStr(null)).toBe('');
    expect(sanitizeStr(undefined)).toBe('');
  });

  test('čísla jsou převedena na řetězce', () => {
    expect(sanitizeStr(42)).toBe('42');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3b. escHtml
// ════════════════════════════════════════════════════════════════════════════
describe('escHtml', () => {
  test('escapuje < > & "', () => {
    expect(escHtml('<b>test</b>')).toBe('&lt;b&gt;test&lt;/b&gt;');
    expect(escHtml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(escHtml('a & b')).toBe('a &amp; b');
  });

  test('kombinace všech speciálních znaků najednou', () => {
    expect(escHtml('<a href="x">text & more</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;text &amp; more&lt;/a&gt;'
    );
  });

  test('null a undefined vrátí prázdný řetězec', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });

  test('čistý text se nezmění', () => {
    expect(escHtml('hello world 123')).toBe('hello world 123');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. validateRows
// ════════════════════════════════════════════════════════════════════════════
describe('validateRows', () => {
  test('prázdné pole je platné (žádné řádky k validaci)', () => {
    expect(validateRows([])).toBeNull();
  });

  test('platný řádek s nulovými hodnotami', () => {
    const row = { d0: 0, d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0 };
    expect(validateRows([row])).toBeNull();
  });

  test('platný řádek s hraničními a prázdnými hodnotami', () => {
    const row = { d0: 99999, d1: '', d2: null, d3: 0, d4: 100, d5: 50, d6: 0 };
    expect(validateRows([row])).toBeNull();
  });

  test('chyba: d0 obsahuje nečíselný řetězec → chybová zpráva zmiňuje "d0"', () => {
    const err = validateRows([{ d0: 'abc', d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0 }]);
    expect(err).toMatch(/d0/);
  });

  test('chyba: d3 přesahuje maximum 99999', () => {
    const err = validateRows([{ d0: 0, d1: 0, d2: 0, d3: 100000, d4: 0, d5: 0, d6: 0 }]);
    expect(err).toMatch(/d3/);
  });

  test('chyba: rows není pole', () => {
    expect(validateRows(null)).toMatch(/pole/);
    expect(validateRows('string')).toMatch(/pole/);
    expect(validateRows({})).toMatch(/pole/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. fv – formátování hodnoty
// ════════════════════════════════════════════════════════════════════════════
describe('fv', () => {
  test('nula a falsy hodnoty vrátí prázdný řetězec ""', () => {
    expect(fv(0)).toBe('');
    expect(fv('0')).toBe('');
    expect(fv(null)).toBe('');
    expect(fv(undefined)).toBe('');
    expect(fv('')).toBe('');
  });

  test('objekty a pole vrátí prázdný řetězec ""', () => {
    expect(fv({})).toBe('');
    expect(fv([])).toBe('');
  });

  test('nečíselný řetězec vrátí prázdný řetězec ""', () => {
    expect(fv('abc')).toBe('');
  });

  test('kladná čísla jsou zaokrouhlena na 1 desetinné místo', () => {
    expect(fv(3.15)).toBe(3.2);
    expect(fv(3.14)).toBe(3.1);
    expect(fv(10)).toBe(10);
    expect(fv(1)).toBe(1);
    expect(fv('42.5')).toBe(42.5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. fmtDateCz – konverze data + TIMEZONE REGRESE
// ════════════════════════════════════════════════════════════════════════════
describe('fmtDateCz – konverze a timezone regrese', () => {
  test('string vstup: základní konverze do českého formátu', () => {
    expect(fmtDateCz('2026-06-01')).toBe('1.6.2026');
    expect(fmtDateCz('2025-12-31')).toBe('31.12.2025');
    expect(fmtDateCz('2026-01-01')).toBe('1.1.2026');
  });

  test('string vstup: odstraní vedoucí nuly z dne a měsíce', () => {
    expect(fmtDateCz('2026-06-01')).toBe('1.6.2026');   // NE "01.06.2026"
    expect(fmtDateCz('2026-09-09')).toBe('9.9.2026');
  });

  test('TIMEZONE REGRESE: string vstupy v době přechodu letního/zimního času se NEPOSUNOU', () => {
    // PostgreSQL vrací DATE jako prostý string (díky types.setTypeParser(1082, val => val)).
    // Funkce smí pracovat pouze se stringem a nesmí procházet přes Date constructor,
    // jinak by se ve středoevropské timezone datum mohlo posunout o den zpět.
    expect(fmtDateCz('2026-03-29')).toBe('29.3.2026');   // přechod SEČ → SELČ (letní čas)
    expect(fmtDateCz('2025-10-26')).toBe('26.10.2025'); // přechod SELČ → SEČ (zimní čas)
    expect(fmtDateCz('2026-12-31')).toBe('31.12.2026'); // konec roku
    expect(fmtDateCz('2026-01-01')).toBe('1.1.2026');   // začátek roku
  });

  test('TIMEZONE REGRESE: Date objekt UTC půlnoc se neposune (toISOString = UTC)', () => {
    // Pokud přijde Date objekt, funkce volá toISOString() = UTC čas.
    // UTC půlnoc → správný den bez ohledu na lokální timezone serveru.
    const d = new Date('2026-06-01T00:00:00.000Z'); // explicitně UTC půlnoc
    expect(fmtDateCz(d)).toBe('1.6.2026');
  });
});
