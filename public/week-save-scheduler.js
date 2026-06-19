// Debounce ukládání týdne se ZÁMKEM cílového týdne k okamžiku editace.
// Sdíleno mezi index.html (browser) a tier1 testem (node) přes UMD.
//
// createWeekSaveScheduler(apiSaveWeek, opts) → { schedule, flush, hasPending }
//   apiSaveWeek(week, rows) provede skutečný zápis.
//   schedule(week, rows)  naplánuje (debounce) uložení; week+rows se ZACHYTÍ teď
//                         a po vypršení se použijí TYTO hodnoty — nikdy se nečte
//                         žádný globální/aktuální stav → uložení vždy míří na týden,
//                         ve kterém editace vznikla.
//   flush()               zruší čekající timer a OKAMŽITĚ doulož na původní týden
//                         (vrací Promise). Volat PŘED přepnutím týdne.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.createWeekSaveScheduler = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return function createWeekSaveScheduler(apiSaveWeek, opts) {
    opts = opts || {};
    var delay = typeof opts.delay === 'number' ? opts.delay : 400;
    var timer = null;
    var pending = null; // { week, rows }

    function schedule(week, rows) {
      pending = { week: week, rows: rows };
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        pending = null;
        apiSaveWeek(week, rows); // zachycené hodnoty, ne aktuální globální stav
      }, delay);
    }

    function flush() {
      if (!timer) return Promise.resolve();
      clearTimeout(timer);
      timer = null;
      var p = pending;
      pending = null;
      return p ? Promise.resolve(apiSaveWeek(p.week, p.rows)) : Promise.resolve();
    }

    function hasPending() { return !!timer; }

    return { schedule: schedule, flush: flush, hasPending: hasPending };
  };
});
