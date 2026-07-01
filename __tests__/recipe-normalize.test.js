// Test sdíleného modulu lib/recipe-normalize.js (FÁZE 0).
// Čisté funkce „směs → cislo/itt" (vstupy = zdroj pravdy). Nikde se zatím nevolají.

const { normalizeRowsByRecipe, resolveCisloItt, buildRecipeMap, buildRecipeIndex, findRecipe }
  = require('../lib/recipe-normalize');

// Mapa receptur jedné obalovny (jako z buildRecipeMap).
const RECIPE_MAP = {
  'ACP 22S 50/70':    { cislo: '6',   zt: '6-2025-Ho' },
  'ACL 16S 25/55-60': { cislo: '18',  zt: '18-2025-Ho' },
  'Lakovka':          { cislo: 'LAK', zt: 'LAK' },
};

// Pomocník: řádek harmonogramu ve stejném pořadí klíčů, jak se dnes ukládá.
function row(over) {
  return Object.assign({
    checked: false, cislo: '', lokalita: '', objednavka: '',
    smes: '', itt: '', ceta: '', lat: null, lng: null,
    d0: '', d1: '', d2: '', d3: '', d4: '', d5: '', d6: '',
  }, over);
}

describe('normalizeRowsByRecipe', () => {
  test('řádek se směsí v mapě → cislo/itt přepsány na recepturu; ostatní pole netknuta', () => {
    const input = [row({ smes: 'ACP 22S 50/70', cislo: '4', itt: '4-2025-Ho', lokalita: 'Zlín', ceta: 'Mi Roads', d0: '120' })];
    const { rows, zmeneno, osirele } = normalizeRowsByRecipe(input, RECIPE_MAP);
    expect(zmeneno).toBe(1);
    expect(osirele).toEqual([]);
    expect(rows[0].cislo).toBe('6');
    expect(rows[0].itt).toBe('6-2025-Ho');
    // ostatní pole beze změny
    expect(rows[0].lokalita).toBe('Zlín');
    expect(rows[0].ceta).toBe('Mi Roads');
    expect(rows[0].d0).toBe('120');
    expect(rows[0].smes).toBe('ACP 22S 50/70');
    expect(rows[0]._osirela).toBeUndefined();
  });

  test('vstup se NEMUTUJE (pracuje nad kopiemi)', () => {
    const input = [row({ smes: 'ACP 22S 50/70', cislo: '4', itt: '4-2025-Ho' })];
    normalizeRowsByRecipe(input, RECIPE_MAP);
    expect(input[0].cislo).toBe('4');         // originál nezměněn
    expect(input[0].itt).toBe('4-2025-Ho');
    expect(input[0]._osirela).toBeUndefined();
  });

  test('osiřelá směs → cislo/itt beze změny, _osirela=true, je v seznamu osirele', () => {
    const input = [row({ smes: 'Smazaná směs', cislo: '99', itt: '99-2020-Ho' })];
    const { rows, zmeneno, osirele } = normalizeRowsByRecipe(input, RECIPE_MAP);
    expect(zmeneno).toBe(0);
    expect(rows[0].cislo).toBe('99');         // nehádá, nemaže
    expect(rows[0].itt).toBe('99-2020-Ho');
    expect(rows[0]._osirela).toBe(true);
    expect(osirele).toHaveLength(1);
    expect(osirele[0].smes).toBe('Smazaná směs');
  });

  test('prázdná smes → řádek beze změny (a bez _osirela)', () => {
    const input = [row({ smes: '', cislo: '7', itt: 'cokoliv' })];
    const { rows, zmeneno, osirele } = normalizeRowsByRecipe(input, RECIPE_MAP);
    expect(zmeneno).toBe(0);
    expect(osirele).toEqual([]);
    expect(rows[0].cislo).toBe('7');
    expect(rows[0].itt).toBe('cokoliv');
    expect(rows[0]._osirela).toBeUndefined();
  });

  test('idempotence: druhé volání nad výsledkem → zmeneno=0', () => {
    const input = [row({ smes: 'ACL 16S 25/55-60', cislo: '11', itt: '11-2025-Ho' })];
    const first = normalizeRowsByRecipe(input, RECIPE_MAP);
    expect(first.zmeneno).toBe(1);
    const second = normalizeRowsByRecipe(first.rows, RECIPE_MAP);
    expect(second.zmeneno).toBe(0);
    expect(second.rows[0].cislo).toBe('18');
    expect(second.rows[0].itt).toBe('18-2025-Ho');
  });

  test('více řádků různých směsí najednou → každý dle své receptury (žádné křížení)', () => {
    const input = [
      row({ smes: 'ACP 22S 50/70',    cislo: '4',  itt: '4-2025-Ho' }),
      row({ smes: 'ACL 16S 25/55-60', cislo: '11', itt: '11-2025-Ho' }),
      row({ smes: 'Lakovka',          cislo: '11', itt: '11-2025-Ho' }),
      row({ smes: '',                 cislo: '',   itt: '' }),
      row({ smes: 'Neznámá',          cislo: 'X',  itt: 'Y' }),
    ];
    const { rows, zmeneno, osirele } = normalizeRowsByRecipe(input, RECIPE_MAP);
    expect(rows[0].cislo).toBe('6');   expect(rows[0].itt).toBe('6-2025-Ho');
    expect(rows[1].cislo).toBe('18');  expect(rows[1].itt).toBe('18-2025-Ho');
    expect(rows[2].cislo).toBe('LAK'); expect(rows[2].itt).toBe('LAK');
    expect(rows[3].cislo).toBe('');    expect(rows[3].itt).toBe('');         // prázdná smes
    expect(rows[4].cislo).toBe('X');   expect(rows[4]._osirela).toBe(true);  // osiřelá
    expect(zmeneno).toBe(3);
    expect(osirele).toHaveLength(1);
  });

  test('už správný řádek → zmeneno=0 (žádná zbytečná změna)', () => {
    const input = [row({ smes: 'ACP 22S 50/70', cislo: '6', itt: '6-2025-Ho' })];
    const { zmeneno } = normalizeRowsByRecipe(input, RECIPE_MAP);
    expect(zmeneno).toBe(0);
  });

  test('funguje i s recipeMap jako Map', () => {
    const m = new Map(Object.entries(RECIPE_MAP));
    const input = [row({ smes: 'ACP 22S 50/70', cislo: '4', itt: '4-2025-Ho' })];
    const { rows, zmeneno } = normalizeRowsByRecipe(input, m);
    expect(zmeneno).toBe(1);
    expect(rows[0].cislo).toBe('6');
  });
});

describe('resolveCisloItt', () => {
  test('smes v mapě → živé hodnoty z receptury, osirela=false', () => {
    const r = resolveCisloItt('ACP 22S 50/70', '4', '4-2025-Ho', RECIPE_MAP);
    expect(r).toEqual({ cislo: '6', itt: '6-2025-Ho', osirela: false });
  });

  test('smes NENÍ v mapě → uložené hodnoty, osirela=true', () => {
    const r = resolveCisloItt('Smazaná', '99', '99-2020-Ho', RECIPE_MAP);
    expect(r).toEqual({ cislo: '99', itt: '99-2020-Ho', osirela: true });
  });

  test('prázdná smes → uložené hodnoty, osirela=false', () => {
    const r = resolveCisloItt('', '7', 'X', RECIPE_MAP);
    expect(r).toEqual({ cislo: '7', itt: 'X', osirela: false });
  });

  test('funguje i s recipeMap jako Map', () => {
    const m = new Map(Object.entries(RECIPE_MAP));
    expect(resolveCisloItt('Lakovka', '11', '11-2025-Ho', m))
      .toEqual({ cislo: 'LAK', itt: 'LAK', osirela: false });
  });
});

describe('buildRecipeMap', () => {
  test('sestaví mapu smes → {cislo, zt}', () => {
    const inputs = [
      { cislo: '6',   smes: 'ACP 22S 50/70',    zt: '6-2025-Ho',  c04: '1' },
      { cislo: '18',  smes: 'ACL 16S 25/55-60', zt: '18-2025-Ho' },
      { cislo: 'LAK', smes: 'Lakovka',          zt: 'LAK' },
      { cislo: '',    smes: '',                 zt: '' },          // prázdný název → přeskočit
    ];
    const { map, duplicitniNazvy } = buildRecipeMap(inputs);
    expect(duplicitniNazvy).toEqual([]);
    expect(Object.keys(map)).toHaveLength(3);
    expect(map['ACP 22S 50/70']).toEqual({ cislo: '6', zt: '6-2025-Ho' });
    expect(map['Lakovka']).toEqual({ cislo: 'LAK', zt: 'LAK' });
  });

  test('duplicitní název → poslední vyhrává + varování v duplicitniNazvy', () => {
    const inputs = [
      { cislo: '6',  smes: 'ACP 22S 50/70', zt: '6-2025-Ho' },
      { cislo: '99', smes: 'ACP 22S 50/70', zt: '99-2099-Ho' },  // duplicita
    ];
    const { map, duplicitniNazvy } = buildRecipeMap(inputs);
    expect(duplicitniNazvy).toEqual(['ACP 22S 50/70']);
    expect(map['ACP 22S 50/70']).toEqual({ cislo: '99', zt: '99-2099-Ho' }); // poslední
  });

  test('integrace: buildRecipeMap → normalizeRowsByRecipe', () => {
    const inputs = [{ cislo: '6', smes: 'ACP 22S 50/70', zt: '6-2025-Ho' }];
    const { map } = buildRecipeMap(inputs);
    const { rows, zmeneno } = normalizeRowsByRecipe(
      [row({ smes: 'ACP 22S 50/70', cislo: '4', itt: '4-2025-Ho' })], map);
    expect(zmeneno).toBe(1);
    expect(rows[0].cislo).toBe('6');
    expect(rows[0].itt).toBe('6-2025-Ho');
  });
});

// dropdown krok 1 — výběr směsi podle kteréhokoli ze tří identifikátorů. Nikde se zatím nevolá.
describe('buildRecipeIndex', () => {
  const INPUTS = [
    { cislo: '6',   smes: 'ACP 22S 50/70',    zt: '6-2025-Ho' },
    { cislo: '18',  smes: 'ACL 16S 25/55-60', zt: '18-2025-Ho' },
    { cislo: 'LAK', smes: 'Lakovka',          zt: 'LAK' },
  ];

  test('sestaví tři mapy bySmes / byCislo / byZt (hodnota = celá receptura)', () => {
    const idx = buildRecipeIndex(INPUTS);
    expect(Object.keys(idx.bySmes)).toHaveLength(3);
    expect(Object.keys(idx.byCislo)).toHaveLength(3);
    expect(Object.keys(idx.byZt)).toHaveLength(3);
    expect(idx.bySmes['ACP 22S 50/70']).toEqual({ smes: 'ACP 22S 50/70', cislo: '6', zt: '6-2025-Ho' });
    expect(idx.byCislo['6']).toEqual({ smes: 'ACP 22S 50/70', cislo: '6', zt: '6-2025-Ho' });
    expect(idx.byZt['18-2025-Ho']).toEqual({ smes: 'ACL 16S 25/55-60', cislo: '18', zt: '18-2025-Ho' });
    expect(idx.duplicitni).toEqual({ smes: [], cislo: [], zt: [] });
  });

  test('prázdné klíče se přeskočí; prázdný vstup → prázdné mapy', () => {
    const idx = buildRecipeIndex([{ cislo: '', smes: '', zt: '' }, { cislo: '9', smes: 'X', zt: '' }]);
    expect(Object.keys(idx.bySmes)).toEqual(['X']);
    expect(Object.keys(idx.byCislo)).toEqual(['9']);
    expect(Object.keys(idx.byZt)).toEqual([]);       // prázdné zt přeskočeno
    const empty = buildRecipeIndex([]);
    expect(empty.bySmes).toEqual({});
    expect(empty.duplicitni).toEqual({ smes: [], cislo: [], zt: [] });
  });

  test('duplicita klíče → poslední vyhrává + varování v duplicitni', () => {
    const idx = buildRecipeIndex([
      { cislo: '6', smes: 'A', zt: 'z1' },
      { cislo: '6', smes: 'B', zt: 'z2' },   // duplicitní cislo '6'
    ]);
    expect(idx.byCislo['6']).toEqual({ smes: 'B', cislo: '6', zt: 'z2' }); // poslední
    expect(idx.duplicitni.cislo).toEqual(['6']);
    expect(idx.duplicitni.smes).toEqual([]);
  });
});

describe('findRecipe', () => {
  const IDX = buildRecipeIndex([
    { cislo: '6',  smes: 'ACP 22S 50/70',    zt: '6-2025-Ho' },
    { cislo: '18', smes: 'ACL 16S 25/55-60', zt: '18-2025-Ho' },
  ]);
  const REC6 = { smes: 'ACP 22S 50/70', cislo: '6', zt: '6-2025-Ho' };

  test('podle smes → doplní cislo/zt', () => {
    expect(findRecipe(IDX, { key: 'smes', val: 'ACP 22S 50/70' })).toEqual(REC6);
  });
  test('podle cislo → doplní smes/zt', () => {
    expect(findRecipe(IDX, { key: 'cislo', val: '6' })).toEqual(REC6);
  });
  test('podle zt (ITT) → doplní smes/cislo', () => {
    expect(findRecipe(IDX, { key: 'zt', val: '6-2025-Ho' })).toEqual(REC6);
  });
  test('trim val', () => {
    expect(findRecipe(IDX, { key: 'cislo', val: '  6 ' })).toEqual(REC6);
  });
  test('nenalezeno → null', () => {
    expect(findRecipe(IDX, { key: 'cislo', val: '999' })).toBeNull();
    expect(findRecipe(IDX, { key: 'smes', val: 'Neznámá' })).toBeNull();
  });
  test('prázdný val / neznámý key / chybějící vstup → null', () => {
    expect(findRecipe(IDX, { key: 'smes', val: '' })).toBeNull();
    expect(findRecipe(IDX, { key: 'itt', val: '6-2025-Ho' })).toBeNull(); // key musí být 'zt', ne 'itt'
    expect(findRecipe(null, { key: 'smes', val: 'X' })).toBeNull();
    expect(findRecipe(IDX, null)).toBeNull();
  });
});
