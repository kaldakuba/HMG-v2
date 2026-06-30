// lib/recipe-normalize.js
// ─────────────────────────────────────────────────────────────────────────────
// JEDINÉ místo pro logiku „směs → cislo/itt" (SVATÉ PRAVIDLO: vstupy/receptury jsou
// zdroj pravdy; trojice NÁZEV SMĚSI ↔ CISLO ↔ ITT patří neoddělitelně k sobě).
//
// FÁZE 0: jen čisté funkce + testy. NIKDE se zatím NEVOLAJÍ → žádná změna chování.
//
// Čisté funkce (žádné I/O, žádná DB, žádný console). Nemutují vstupní pole ani jeho
// objekty — pracují nad mělkými kopiemi řádků (zachovávají pořadí klíčů kvůli bajtové
// shodě JSON snímků; přepis EXISTUJÍCÍCH klíčů cislo/itt pořadí nemění).
//
// SCOPE OBALOVNY: tyto funkce scope NEŘEŠÍ. `recipeMap` MUSÍ být sestavena z receptur
// PRÁVĚ JEDNÉ obalovny (volající zodpovídá za správný obalovna_id) — jinak by se
// receptury napříč obalovnami křížily.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// Normalizace hodnoty na string pro POROVNÁNÍ (ne pro zápis): trim, null/undefined → ''.
function _norm(v) { return String(v == null ? '' : v).trim(); }

// Podpora recipeMap jako Map i plain object: vrať recepturu pro přesný název smes.
function _getRec(recipeMap, key) {
  if (!recipeMap) return undefined;
  if (recipeMap instanceof Map) return recipeMap.get(key);
  return Object.prototype.hasOwnProperty.call(recipeMap, key) ? recipeMap[key] : undefined;
}

// ── normalizeRowsByRecipe(rows, recipeMap) ───────────────────────────────────
// Pro ZÁPIS do week_data.rows: srovná cislo/itt KAŽDÉHO řádku se směsí podle PŘESNÉHO
// názvu smes z receptury (zdroj pravdy).
//   - smes nalezena  → row.cislo = rec.cislo, row.itt = rec.zt (ostatní pole NETKNUTA).
//   - smes NEnalezena (osiřelá) → cislo/itt BEZE ZMĚNY, řádek dostane příznak _osirela=true
//     a objeví se v poli `osirele`. NEMAZAT, NEhádat.
//   - prázdná smes  → řádek beze změny.
// Vrací: { rows, zmeneno, osirele } — `rows` jsou nové (mělké kopie), vstup se nemutuje.
// Idempotentní: druhé volání nad výsledkem vrátí zmeneno=0.
//
// Pozn. k _osirela: je to ZOBRAZOVACÍ příznak. Zápisové cesty (B1) by ho neměly ukládat
// do DB — osiřelé řádky mají zůstat beze změny (a vykreslit se červeně přes resolveCisloItt).
function normalizeRowsByRecipe(rows, recipeMap) {
  const out = [];
  let zmeneno = 0;
  const osirele = [];

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const copy = Object.assign({}, row);   // mělká kopie → vstup netknut, pořadí klíčů zachováno
    const smes = _norm(copy.smes);

    if (smes === '') { out.push(copy); continue; }          // prázdná smes → beze změny

    const rec = _getRec(recipeMap, smes);
    if (rec === undefined) {                                // osiřelá → cislo/itt beze změny
      copy._osirela = true;
      osirele.push(copy);
      out.push(copy);
      continue;
    }

    // nalezena → srovnej cislo/itt na recepturu (mění jen při logické odlišnosti)
    const newCislo = rec.cislo;
    const newItt = rec.zt;
    if (_norm(copy.cislo) !== _norm(newCislo) || _norm(copy.itt) !== _norm(newItt)) {
      copy.cislo = newCislo;
      copy.itt = newItt;
      zmeneno++;
    }
    out.push(copy);
  }

  return { rows: out, zmeneno, osirele };
}

// ── resolveCisloItt(smes, ulozeneCislo, ulozeneItt, recipeMap) ────────────────
// Pro ZOBRAZENÍ (render/export/měsíc/dashboard). Vrací živé hodnoty z receptury,
// nebo uložené (osiřelé → volající zobrazí červeně).
//   - smes v recipeMap → { cislo: rec.cislo, itt: rec.zt, osirela: false }
//   - smes NENÍ v mapě  → { cislo: ulozeneCislo, itt: ulozeneItt, osirela: true }
//   - prázdná smes      → { cislo: ulozeneCislo, itt: ulozeneItt, osirela: false }
function resolveCisloItt(smes, ulozeneCislo, ulozeneItt, recipeMap) {
  const key = _norm(smes);
  if (key === '') return { cislo: ulozeneCislo, itt: ulozeneItt, osirela: false };
  const rec = _getRec(recipeMap, key);
  if (rec === undefined) return { cislo: ulozeneCislo, itt: ulozeneItt, osirela: true };
  return { cislo: rec.cislo, itt: rec.zt, osirela: false };
}

// ── buildRecipeMap(inputsRows) ───────────────────────────────────────────────
// Sestaví mapu { '<přesný název smes>': { cislo, zt } } z pole receptur JEDNÉ obalovny.
// Řádky s prázdným názvem smes se přeskakují. Duplicitní názvy (NEMĚLY by nastat):
// POSLEDNÍ VYHRÁVÁ, název se zaznamená do `duplicitniNazvy` (varování pro volajícího).
// Vrací: { map, duplicitniNazvy }.
function buildRecipeMap(inputsRows) {
  const map = {};
  const seen = new Set();
  const dup = new Set();
  for (const r of (Array.isArray(inputsRows) ? inputsRows : [])) {
    const key = _norm(r && r.smes);
    if (key === '') continue;
    if (seen.has(key)) dup.add(key);
    seen.add(key);
    map[key] = { cislo: r.cislo, zt: r.zt };   // poslední vyhrává
  }
  return { map, duplicitniNazvy: Array.from(dup) };
}

// Export: v Node přes require; v prohlížeči (classic <script src="/js/recipe-normalize.js">)
// jsou funkce automaticky globální (window.*), proto export jen když `module` existuje.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeRowsByRecipe, resolveCisloItt, buildRecipeMap };
}
