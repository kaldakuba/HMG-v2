// Regresní test: debounce ukládání týdne nesmí zapsat do JINÉHO týdne, než ke kterému
// editace patří (chyba: po přepnutí týdne během čekání na uložení se save svalil na nový týden).
//
// Testuje SDÍLENÝ modul public/week-save-scheduler.js, který používá i index.html.

const createWeekSaveScheduler = require('../public/week-save-scheduler');

describe('week-save-scheduler — zámek cílového týdne + flush', () => {
  let saved;
  const apiSave = (week, rows) => { saved.push({ week, rows: rows.map(r => ({ ...r })) }); };

  beforeEach(() => {
    saved = [];
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('timeout uloží na ZACHYCENÝ týden, ne na aktuální globální stav', () => {
    const sched = createWeekSaveScheduler(apiSave, { delay: 400 });
    const rowsA = [{ lokalita: 'A1' }, { lokalita: 'A2-novy' }];

    sched.schedule('2026-06-01', rowsA); // editace na týdnu A

    // Mezitím by se _weekStart v appce přepnul na B — scheduler ho ale NEČTE.
    jest.advanceTimersByTime(400);

    expect(saved).toHaveLength(1);
    expect(saved[0].week).toBe('2026-06-01');        // (a) uloženo na A
    expect(saved[0].rows).toEqual(rowsA);            // (c) přidaný řádek se neztratil
  });

  test('flush() před přepnutím doulož na PŮVODNÍ týden a nic nepropadne na nový', async () => {
    const sched = createWeekSaveScheduler(apiSave, { delay: 400 });
    const rowsA = [{ lokalita: 'A1' }, { lokalita: 'A2-novy' }];

    sched.schedule('2026-06-01', rowsA);  // editace na A (debounce běží)
    expect(sched.hasPending()).toBe(true);

    await sched.flush();                  // přepínáme na B → flush PŘED změnou týdne

    expect(saved).toHaveLength(1);
    expect(saved[0].week).toBe('2026-06-01');  // (a) uloženo na A
    expect(saved[0].rows).toEqual(rowsA);      // (c) data zachována
    expect(sched.hasPending()).toBe(false);    // debounce zrušen

    // (b) na týden B se z A nic nezapsalo — žádné další uložení po flushi
    jest.advanceTimersByTime(2000);
    expect(saved).toHaveLength(1);
    expect(saved.some(s => s.week !== '2026-06-01')).toBe(false);
  });

  test('opětovná editace téhož týdne uloží jen jednou s posledními daty', () => {
    const sched = createWeekSaveScheduler(apiSave, { delay: 400 });
    sched.schedule('2026-06-01', [{ lokalita: 'x' }]);
    jest.advanceTimersByTime(200);
    sched.schedule('2026-06-01', [{ lokalita: 'y' }]); // re-edit před vypršením
    jest.advanceTimersByTime(400);

    expect(saved).toHaveLength(1);
    expect(saved[0].rows).toEqual([{ lokalita: 'y' }]);
  });

  test('flush() bez čekajícího uložení nic neuloží', async () => {
    const sched = createWeekSaveScheduler(apiSave, { delay: 400 });
    await sched.flush();
    expect(saved).toHaveLength(0);
  });
});
