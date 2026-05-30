// Copyright (c) 2026 Jakub Kalousek. All rights reserved.
// Sdílená logika schvalování objednávek – index.html + month.html

window.OA = (() => {
  'use strict';

  // ── Barvy skupin (cyklické přiřazení podle order_group_id) ──
  const COLORS = [
    {bg:'#ede9fe',dot:'#7c3aed'},{bg:'#fce7f3',dot:'#be185d'},
    {bg:'#d1fae5',dot:'#047857'},{bg:'#fff7ed',dot:'#c2410c'},
    {bg:'#eff6ff',dot:'#1d4ed8'},{bg:'#ecfdf5',dot:'#065f46'},
    {bg:'#fef9c3',dot:'#a16207'},{bg:'#f3e8ff',dot:'#6d28d9'},
    {bg:'#cffafe',dot:'#0e7490'}
  ];
  const _colorMap = {};
  let _colorIdx = 0;

  function getGroupColor(gid) {
    if (!_colorMap[gid]) {
      _colorMap[gid] = COLORS[_colorIdx % COLORS.length];
      _colorIdx++;
    }
    return _colorMap[gid];
  }

  // ── Stav ──
  let _pendingGroups = [];
  let _onAfterAction = null; // callback → page-specific re-render
  let _navigateFn   = null; // async (datum: string) => void — page poskytne

  // ── Pomocné ──
  function esc(v) {
    return String(v||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }
  function fmtDatum(d) {
    const s = String(d).slice(0,10);
    const [y,m,dd] = s.split('-');
    return parseInt(dd)+'.'+parseInt(m)+'.'+y;
  }
  function fmtDatumShort(d) {
    const s = String(d).slice(0,10);
    const [,m,dd] = s.split('-');
    return parseInt(dd)+'.'+parseInt(m)+'.';
  }
  function statusTextShort(s) {
    if (s==='pending') return 'čeká';
    if (s==='pre_approved') return 'pre OK';
    if (s==='pre_rejected') return 'pre zamít.';
    return 'OK';
  }
  function statusBadgeHtml(s) {
    if (s==='pending')
      return '<span style="background:#fef9c3;color:#d97706;border:1px solid #fde68a;border-radius:3px;padding:1px 6px;font-size:10px;font-weight:700;white-space:nowrap">ČEKÁ</span>';
    if (s==='pre_approved')
      return '<span style="background:#dcfce7;color:#15803d;border:1px dashed #6ee7b7;border-radius:3px;padding:1px 6px;font-size:10px;font-weight:700;white-space:nowrap">PRE OK</span>';
    if (s==='pre_rejected')
      return '<span style="background:#fee2e2;color:#dc2626;border:1px dashed #fca5a5;border-radius:3px;padding:1px 6px;font-size:10px;font-weight:700;white-space:nowrap">PRE ZAMÍT.</span>';
    return '<span style="background:#dcfce7;color:#15803d;border-radius:3px;padding:1px 6px;font-size:10px;font-weight:700">OK</span>';
  }
  function _ctxStatusBadge(s) {
    if (s==='pending')
      return '<span style="background:#fef9c3;color:#d97706;border-radius:3px;padding:1px 5px;font-size:10px;font-weight:700">čeká</span>';
    if (s==='pre_approved')
      return '<span style="background:#dcfce7;color:#15803d;border-radius:3px;padding:1px 5px;font-size:10px;font-weight:700">pre OK</span>';
    if (s==='pre_rejected')
      return '<span style="background:#fee2e2;color:#dc2626;border-radius:3px;padding:1px 5px;font-size:10px;font-weight:700">zamít.</span>';
    if (s==='approved')
      return '<span style="background:#dcfce7;color:#15803d;border-radius:3px;padding:1px 5px;font-size:10px;font-weight:700">HMG</span>';
    return '<span style="background:#f3f4f6;color:#6b7280;border-radius:3px;padding:1px 5px;font-size:10px">—</span>';
  }
  function dayCellStyle(status) {
    if (status==='pending')      return 'border:2px dashed #f59e0b;background:#fffbeb;color:#92400e;font-weight:700';
    if (status==='pre_approved') return 'border:2px dashed #16a34a;background:#f0fdf4;color:#166534;font-weight:700';
    if (status==='pre_rejected') return 'border:2px dashed #dc2626;background:#fff5f5;color:#991b1b;font-weight:700';
    return '';
  }
  function _daysLabel(n) {
    if (n === 1) return '1 den';
    if (n >= 2 && n <= 4) return n + ' dny';
    return n + ' dní';
  }

  // ── API ──
  async function apiCall(method, url, body) {
    const opts = { method, headers: {'Content-Type':'application/json'} };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    return r.json();
  }

  async function loadPendingGroups() {
    try {
      const data = await apiCall('GET', '/api/orders/pending-groups');
      _pendingGroups = Array.isArray(data) ? data : [];
    } catch(e) { _pendingGroups = []; }
    return _pendingGroups;
  }

  function getPendingGroups() { return _pendingGroups; }
  function getGroupInfo(gid) { return _pendingGroups.find(g => g.order_group_id === gid) || null; }

  // ── Banner ──
  let _bannerEl = null;

  // initBanner(el, prepend)
  //   prepend=false (výchozí): vloží banner PŘED el (jako sourozenec) — starý mód
  //   prepend=true:            vloží banner jako PRVNÍ dítě el — inline v liště tlačítek
  function initBanner(el, prepend) {
    if (_bannerEl) return;
    _bannerEl = document.createElement('div');
    _bannerEl.id = 'oa-banner';
    _bannerEl.style.cssText = [
      'display:none',
      'background:#fef9c3',
      'border-left:3px solid #f59e0b',
      'border-radius:4px',
      'padding:5px 11px',
      'font-size:12px',
      'font-weight:600',
      'font-family:Inter,sans-serif',
      'align-items:center',
      'gap:5px',
      'color:#92400e',
      'cursor:pointer',
      'white-space:nowrap',
      'flex-shrink:0',
      'line-height:1',
      'user-select:none'
    ].join(';');
    _bannerEl.innerHTML =
      '<span id="oa-banner-text"></span>' +
      '<span id="oa-banner-arrow" style="font-size:10px;color:#94a3b8;flex-shrink:0;margin-left:2px;transition:transform .15s;display:inline-block">▼</span>';
    _bannerEl.addEventListener('click', _toggleDrop);
    if (prepend) {
      if (el) el.insertBefore(_bannerEl, el.firstChild);
    } else {
      if (el && el.parentNode) el.parentNode.insertBefore(_bannerEl, el);
    }
  }

  function updateBanner(count) {
    if (!_bannerEl) return;
    if (!count || count <= 0) {
      _bannerEl.style.display = 'none';
      _closeDrop();
      return;
    }
    _bannerEl.style.display = 'inline-flex';
    const suffix = count === 1
      ? 'čekající objednávka'
      : count < 5
        ? 'čekající objednávky'
        : 'čekajících objednávek';
    const t = document.getElementById('oa-banner-text');
    if (t) t.textContent = count + ' ' + suffix;
  }

  async function refreshBanner() {
    await loadPendingGroups();
    updateBanner(_pendingGroups.length);
    if (_dropOpen) _renderDrop(); // aktualizuj obsah pokud je otevřen
  }

  // ── Dropdown ──
  let _dropEl   = null;
  let _dropOpen = false;

  function _initDrop() {
    if (_dropEl) return;
    _dropEl = document.createElement('div');
    _dropEl.id = 'oa-drop';
    _dropEl.style.cssText = [
      'position:fixed',
      'z-index:9800',
      'background:#fff',
      'border:1px solid #e5e7eb',
      'border-radius:8px',
      'box-shadow:0 8px 32px rgba(0,0,0,.18)',
      'min-width:320px',
      'max-width:540px',
      'max-height:380px',
      'overflow-y:auto',
      'font-family:Inter,sans-serif',
      'display:none'
    ].join(';');
    document.body.appendChild(_dropEl);

    // Zavři klikem mimo banner i dropdown
    document.addEventListener('click', (e) => {
      if (!_dropOpen) return;
      if (_dropEl && _dropEl.contains(e.target)) return;
      if (_bannerEl && _bannerEl.contains(e.target)) return;
      _closeDrop();
    }, true);
  }

  function _positionDrop() {
    if (!_dropEl || !_bannerEl) return;
    const rect = _bannerEl.getBoundingClientRect();
    const dropW = Math.max(_dropEl.offsetWidth || 360, 320);
    let left = rect.left;
    if (left + dropW > window.innerWidth - 10) {
      left = Math.max(10, window.innerWidth - dropW - 10);
    }
    _dropEl.style.top  = (rect.bottom + 6) + 'px';
    _dropEl.style.left = left + 'px';
  }

  function _openDrop() {
    _initDrop();
    _dropOpen = true;
    const arrow = document.getElementById('oa-banner-arrow');
    if (arrow) arrow.style.transform = 'rotate(180deg)';
    _renderDrop();
    _dropEl.style.display = 'block';
    // Position after render (aby offsetWidth bylo správné)
    requestAnimationFrame(_positionDrop);
  }

  function _closeDrop() {
    if (!_dropOpen && (!_dropEl || _dropEl.style.display === 'none')) return;
    _dropOpen = false;
    const arrow = document.getElementById('oa-banner-arrow');
    if (arrow) arrow.style.transform = '';
    if (_dropEl) _dropEl.style.display = 'none';
  }

  function _toggleDrop() {
    if (_dropOpen) _closeDrop();
    else _openDrop();
  }

  function _renderDrop() {
    if (!_dropEl) return;

    if (!_pendingGroups.length) {
      _dropEl.innerHTML =
        '<div style="padding:14px 16px;color:#9ca3af;font-size:13px;text-align:center">Žádné čekající objednávky</div>';
      return;
    }

    // Seřaď podle created_at vzestupně (kdo objednal první = č. 1)
    const sorted = [..._pendingGroups].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return ta - tb;
    });

    const rowsHtml = sorted.map((g, idx) => {
      const pct      = idx + 1;
      const allDays  = [...new Set((g.rows || []).map(r => String(r.datum).slice(0,10)))];
      const dayCount = allDays.length;
      const totalT   = (g.rows || []).reduce((s, r) => s + (parseInt(r.tuny) || 0), 0);
      const gidSafe  = esc(g.order_group_id);
      const firma    = esc(g.firma || '—');
      const lok      = esc(g.lokalita || '—');

      return '<div class="oa-drop-row" data-gid="'+gidSafe+'" style="'+
        'padding:8px 14px;border-bottom:1px solid #f3f4f6;cursor:pointer;'+
        'font-size:13px;color:#374151;display:flex;align-items:center;gap:6px;" '+
        'onmouseenter="this.style.background=\'#f0f9ff\'" '+
        'onmouseleave="this.style.background=\'\'" '+
        'onclick="OA._dropRowClick(\''+gidSafe+'\')">'+
        '<span style="color:#94a3b8;font-size:11px;min-width:18px;font-weight:700;flex-shrink:0">'+pct+'.</span>'+
        '<span style="font-weight:700;color:#1a1a2e;flex-shrink:0">'+firma+'</span>'+
        '<span style="color:#cbd5e1;flex-shrink:0">/</span>'+
        '<span style="color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0" title="'+lok+'">'+lok+'</span>'+
        '<span style="color:#cbd5e1;flex-shrink:0">/</span>'+
        '<span style="color:#6b7280;white-space:nowrap;flex-shrink:0">'+_daysLabel(dayCount)+'</span>'+
        '<span style="color:#cbd5e1;flex-shrink:0">/</span>'+
        '<span style="font-weight:700;color:#1d4ed8;white-space:nowrap;flex-shrink:0">celkem '+totalT+' t</span>'+
        '</div>';
    }).join('');

    _dropEl.innerHTML =
      '<div style="padding:7px 14px;border-bottom:1px solid #e5e7eb;font-size:10px;font-weight:700;'+
        'color:#9ca3af;text-transform:uppercase;letter-spacing:.6px;background:#f9fafb;'+
        'border-radius:8px 8px 0 0;position:sticky;top:0">'+
        'Čekající objednávky ('+sorted.length+')'+
      '</div>'+
      rowsHtml;
  }

  // Klik na řádek v dropdownu
  async function _dropRowClick(gid) {
    _closeDrop();

    const g = _pendingGroups.find(g => g.order_group_id === gid);
    if (!g) return;

    // Najdi první chronologický pending den
    const pendingDays = (g.rows || [])
      .filter(r => r.status === 'pending')
      .map(r => String(r.datum).slice(0, 10))
      .sort();

    // Fallback: pokud nemá žádný pending den, vezmi první den celé skupiny
    const allDays = [...new Set((g.rows || []).map(r => String(r.datum).slice(0, 10)))].sort();
    const targetDatum = pendingDays[0] || allDays[0];
    if (!targetDatum) return;

    // Naviguj na týden/měsíc obsahující cílový den (page-specific callback)
    if (_navigateFn) {
      await _navigateFn(targetDatum);
    }

    // Krátká pauza pro DOM po re-renderu
    await new Promise(res => setTimeout(res, 100));

    // Najdi a zvýrazni řádky objednávky v tabulce
    const orderRows = document.querySelectorAll('tr.oa-order-row[data-gid="' + gid + '"]');
    if (orderRows.length) {
      orderRows[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      orderRows.forEach(row => {
        const prev = row.style.outline;
        row.style.outline = '3px solid #f59e0b';
        row.style.outlineOffset = '-2px';
        setTimeout(() => {
          row.style.outline = prev || '';
          row.style.outlineOffset = '';
        }, 2000);
      });
    }

    // Otevři popup pro první pending den (nebo jen naviguj bez popupu)
    if (pendingDays[0]) {
      await openDayPopup(gid, pendingDays[0]);
    }
    // Pokud neexistuje pending den, jen navigujeme a neotevíráme popup
  }

  // ── Hover tooltip ──
  let _hoverEl = null;

  function _initHover() {
    if (_hoverEl) return;
    _hoverEl = document.createElement('div');
    _hoverEl.id = 'oa-hover';
    _hoverEl.style.cssText = 'position:fixed;z-index:9500;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.18);padding:10px 14px;max-width:320px;min-width:220px;font-size:12px;font-family:Inter,sans-serif;pointer-events:none;display:none;line-height:1.5;color:#374151';
    document.body.appendChild(_hoverEl);
  }

  function showHover(e, gid, datum) {
    _initHover();
    const g = getGroupInfo(gid);
    if (!g) { hideHover(); return; }

    // Přehled dnů
    const byDay = {};
    (g.rows||[]).forEach(r => {
      const d = String(r.datum).slice(0,10);
      if (!byDay[d] || ['pre_rejected','pre_approved','pending'].indexOf(r.status) > ['pre_rejected','pre_approved','pending'].indexOf(byDay[d]))
        byDay[d] = r.status;
    });
    const daysSummary = Object.entries(byDay).sort(([a],[b])=>a.localeCompare(b))
      .map(([d,s]) => '<b>'+fmtDatumShort(d)+'</b> '+statusTextShort(s)).join(' · ');

    const pendingCount = Object.values(byDay).filter(s=>s==='pending').length;
    const gps = (g.lat!=null&&g.lng!=null)
      ? parseFloat(g.lat).toFixed(4)+', '+parseFloat(g.lng).toFixed(4) : '—';

    _hoverEl.innerHTML =
      '<div style="font-weight:700;color:#111;margin-bottom:3px">'+esc(g.firma)+
        ' <span style="font-weight:400;color:#6b7280;font-size:11px">'+esc(g.username||'')+'</span></div>'+
      '<div style="font-size:10px;color:#6b7280;margin-bottom:5px">📍 '+esc(g.lokalita||'—')+' &nbsp;·&nbsp; GPS: '+esc(gps)+'</div>'+
      '<div style="font-size:11px;color:#374151;margin-bottom:3px"><b>Dny objednávky</b>'+
        (pendingCount?' ('+pendingCount+' čeká)':'')+':</div>'+
      '<div style="font-size:11px">'+daysSummary+'</div>'+
      (datum?'<div style="margin-top:5px;font-size:10px;color:#9ca3af">Klikněte pro rozhodnutí dne '+fmtDatumShort(datum)+'</div>':'');

    _hoverEl.style.display = 'block';
    _positionHover(e);
  }

  function _positionHover(e) {
    if (!_hoverEl) return;
    const x = e.clientX+14, y = e.clientY-10;
    const w = _hoverEl.offsetWidth||280, h = _hoverEl.offsetHeight||120;
    _hoverEl.style.left = (x+w > window.innerWidth ? Math.max(0,window.innerWidth-w-10) : x)+'px';
    _hoverEl.style.top  = (y+h > window.innerHeight ? Math.max(0,y-h-10) : y)+'px';
  }

  function hideHover() { if (_hoverEl) _hoverEl.style.display = 'none'; }

  // ── Day popup (klik) ──
  let _popupEl = null, _curGid = null, _curDatum = null, _rejectMode = null, _curDayCtx = null;

  function _initPopup() {
    if (_popupEl) return;
    _popupEl = document.createElement('div');
    _popupEl.id = 'oa-popup';
    _popupEl.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.52);z-index:10000;align-items:flex-start;justify-content:center;padding:40px 16px 16px;overflow-y:auto';
    _popupEl.innerHTML = '<div id="oa-popup-inner" style="background:#fff;border-radius:12px;max-width:760px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,.28);font-family:Inter,sans-serif;overflow:hidden"></div>';
    _popupEl.addEventListener('click', e => { if (e.target===_popupEl) closeDayPopup(); });
    document.body.appendChild(_popupEl);
  }

  async function _loadDayContext(datum, curGid) {
    try {
      // Vypočti pondělí daného týdne
      const dt = new Date(datum + 'T00:00:00');
      const dow = dt.getDay(); // 0=Ne, 1=Po, ...
      const toMon = dow === 0 ? -6 : 1 - dow;
      dt.setDate(dt.getDate() + toMon);
      const weekStart = dt.toISOString().slice(0, 10);
      const dayIdx = dow === 0 ? 6 : dow - 1; // 0=Po ... 6=Ne
      const dayKey = 'd' + dayIdx;

      const [cap, weekRows] = await Promise.all([
        apiCall('GET', '/api/day-capacity?date=' + datum).catch(() => ({})),
        apiCall('GET', '/api/week/' + weekStart).catch(() => [])
      ]);

      // Ostatní objednávky (ne ta schvalovaná) s řádky na tento den
      const otherOrders = [];
      (_pendingGroups || []).forEach(g => {
        if (g.order_group_id === curGid) return;
        (g.rows || []).forEach(r => {
          if (String(r.datum).slice(0, 10) === datum) {
            otherOrders.push({
              firma: g.firma || '—',
              lokalita: g.lokalita || '—',
              smes: r.smes || '—',
              status: r.status,
              tuny: parseInt(r.tuny) || 0
            });
          }
        });
      });

      // Harmonogram řádky pro tento den (z týdenních dat)
      const hmgRows = [];
      (Array.isArray(weekRows) ? weekRows : []).forEach(row => {
        const t = parseInt(row[dayKey]) || 0;
        if (t > 0) {
          hmgRows.push({
            firma: row.objednavka || row.ceta || '—',
            lokalita: row.lokalita || '—',
            smes: row.smes || '—',
            status: 'approved',
            tuny: t
          });
        }
      });

      const maxDaily = cap.maxDaily != null ? cap.maxDaily
                     : cap.max_daily != null ? cap.max_daily : null;
      const harmTotal = hmgRows.reduce((s, r) => s + r.tuny, 0);
      const otherApprovedTotal = otherOrders
        .filter(o => o.status === 'pre_approved' || o.status === 'approved')
        .reduce((s, o) => s + o.tuny, 0);

      return { otherOrders, hmgRows, maxDaily, harmTotal, otherApprovedTotal };
    } catch (e) {
      console.warn('[OA] _loadDayContext failed:', e);
      return null;
    }
  }

  async function openDayPopup(gid, datum) {
    hideHover();
    _initPopup();
    _curGid = gid; _curDatum = datum; _curDayCtx = null;
    if (!getGroupInfo(gid)) await loadPendingGroups();
    _renderPopup(); // zobraz okamžitě (B+C budou "Načítám…")
    _popupEl.style.display = 'flex';
    _popupEl.scrollTop = 0;
    _curDayCtx = await _loadDayContext(datum, gid);
    _renderPopup(); // překresli s kontextem
  }

  function closeDayPopup() {
    if (_popupEl) _popupEl.style.display = 'none';
    _curGid = null; _curDatum = null; _rejectMode = null; _curDayCtx = null;
  }

  // Přepne kartu na jiný den stejné objednávky (bez zavření/znovuotevření)
  async function _switchDay(d) {
    if (!_curGid || !d) return;
    _curDatum = d;
    _rejectMode = null;
    _curDayCtx = null;
    _renderPopup(); // rychlé překreslení (B+C "Načítám…")
    if (_popupEl) _popupEl.scrollTop = 0;
    _curDayCtx = await _loadDayContext(d, _curGid);
    _renderPopup(); // překresli s kontextem
  }

  function _renderPopup() {
    const inner = document.getElementById('oa-popup-inner');
    if (!inner) return;
    const g = getGroupInfo(_curGid);
    if (!g) { inner.innerHTML = '<div style="padding:24px;text-align:center;color:#dc2626">Objednávka nenalezena.</div>'; return; }

    const datum = _curDatum;
    const dayRows = (g.rows||[]).filter(r => String(r.datum).slice(0,10)===datum);
    const allDays = [...new Set((g.rows||[]).map(r=>String(r.datum).slice(0,10)))].sort();

    // Stav dne (nejhorší = pending)
    const dayStatus = dayRows.length ? dayRows.reduce((w,r) => {
      const ord = ['pre_rejected','pre_approved','pending'];
      return ord.indexOf(r.status) > ord.indexOf(w) ? r.status : w;
    }, dayRows[0].status) : null;
    const dayTuny = dayRows.reduce((s,r) => s+(parseInt(r.tuny)||0), 0);

    // Přehled dnů – badges (klikací, přepínají den v kartě bez zavření)
    const daysHtml = allDays.map(d => {
      const dRows = (g.rows||[]).filter(r => String(r.datum).slice(0,10)===d);
      // Dominantní stav dne: pending > pre_approved > pre_rejected
      const ds = dRows.length ? dRows.reduce((w,r) => {
        const ord = ['pre_rejected','pre_approved','pending'];
        return ord.indexOf(r.status) > ord.indexOf(w) ? r.status : w;
      }, dRows[0].status) : null;
      const isCur = d === datum;
      // Vizuální styl: aktivní den tmavý, ostatní barevně podle stavu
      let bg, col, brd, fw;
      if (isCur) {
        bg = '#1a1a2e'; col = '#fff';     brd = 'none';                   fw = '700';
      } else if (ds === 'pending') {
        bg = '#fef9c3'; col = '#92400e';  brd = '1px solid #fde68a';      fw = '600';
      } else if (ds === 'pre_approved') {
        bg = '#dcfce7'; col = '#15803d';  brd = '1px dashed #6ee7b7';     fw = '600';
      } else if (ds === 'pre_rejected') {
        bg = '#fee2e2'; col = '#991b1b';  brd = '1px dashed #fca5a5';     fw = '600';
      } else {
        bg = '#f3f4f6'; col = '#374151';  brd = 'none';                   fw = '400';
      }
      const dSafe = esc(d);
      const curSafe = esc(datum);
      return '<span style="display:inline-block;margin:2px 3px 2px 0;padding:3px 10px;border-radius:4px;font-size:11px;'+
        'background:'+bg+';color:'+col+';font-weight:'+fw+';cursor:pointer;user-select:none;'+
        (brd !== 'none' ? 'border:'+brd+';' : '')+
        'transition:opacity .12s;" '+
        'onclick="OA._switchDay(\''+dSafe+'\')" '+
        'onmouseenter="if(\''+dSafe+'\'!==\''+curSafe+'\')this.style.opacity=\'0.65\'" '+
        'onmouseleave="this.style.opacity=\'1\'" '+
        'title="Přepnout na '+fmtDatumShort(d)+' ('+statusTextShort(ds||'')+')">'+
        fmtDatumShort(d)+' '+statusTextShort(ds||'')+'</span>';
    }).join('');

    // Tabulka řádků dne
    const rowsHtml = dayRows.map(r =>
      '<tr><td style="padding:5px 10px;border-bottom:1px solid #f3f4f6;text-align:left;font-size:12px">'+esc(r.smes)+'</td>'+
      '<td style="padding:5px 10px;border-bottom:1px solid #f3f4f6;font-size:11px;color:#6b7280">'+esc(r.itt||'')+'</td>'+
      '<td style="padding:5px 10px;border-bottom:1px solid #f3f4f6;font-weight:700;text-align:right;white-space:nowrap">'+r.tuny+' t</td></tr>'
    ).join('');

    // Akce pro den
    const pendingInGroup = (g.rows||[]).filter(r=>r.status==='pending').length;
    const allDecided = pendingInGroup === 0;

    let dayBtns = '';
    if (dayStatus==='pending') {
      dayBtns =
        '<button onclick="OA._doPreapprove()" style="'+_btnStyle('#16a34a')+'">✓ Předběžně schválit den</button>'+
        '<button onclick="OA._showRejectReason(\'day\')" style="'+_btnStyle('#dc2626')+'">✗ Předběžně zamítnout den</button>';
    } else if (dayStatus==='pre_approved') {
      dayBtns =
        '<button onclick="OA._doResetDay()" style="'+_btnStyle('#64748b')+'">↺ Vrátit na čekající</button>'+
        '<button onclick="OA._showRejectReason(\'day\')" style="'+_btnStyle('#dc2626')+'">✗ Zamítnout den</button>';
    } else if (dayStatus==='pre_rejected') {
      dayBtns =
        '<button onclick="OA._doPreapprove()" style="'+_btnStyle('#16a34a')+'">✓ Předběžně schválit den</button>'+
        '<button onclick="OA._doResetDay()" style="'+_btnStyle('#64748b')+'">↺ Vrátit na čekající</button>';
    }

    const dis = allDecided ? '' : 'disabled ';
    const disStyle = allDecided ? '' : 'opacity:.45;cursor:not-allowed;';
    const finalBtns =
      '<button '+dis+'onclick="OA._doFinalize()" style="'+_btnStyle('#1d4ed8')+disStyle+'">✓ Finálně potvrdit objednávku</button>'+
      '<button '+dis+'onclick="OA._showRejectReason(\'all\')" style="'+_btnStyle('#991b1b')+disStyle+'">✗ Zamítnout celou objednávku</button>';

    const gps = (g.lat!=null&&g.lng!=null)
      ? parseFloat(g.lat).toFixed(4)+', '+parseFloat(g.lng).toFixed(4) : '—';

    // ── ČÁST B – Ostatní na tento den ──
    let partBHtml;
    if (!_curDayCtx) {
      partBHtml =
        '<div style="margin-bottom:14px">'+
          '<div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Ostatní na tento den</div>'+
          '<div style="font-size:12px;color:#94a3b8;padding:4px 0;font-style:italic">Načítám…</div>'+
        '</div>';
    } else {
      const allOther = [...(_curDayCtx.hmgRows||[]), ...(_curDayCtx.otherOrders||[])];
      if (!allOther.length) {
        partBHtml =
          '<div style="margin-bottom:14px">'+
            '<div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Ostatní na tento den</div>'+
            '<div style="font-size:12px;color:#9ca3af;padding:4px 0">Žádné ostatní objednávky ani harmonogram pro tento den.</div>'+
          '</div>';
      } else {
        const bRows = allOther.map(o =>
          '<tr>'+
            '<td style="padding:4px 8px;font-size:12px;border-bottom:1px solid #f3f4f6;white-space:nowrap">'+esc(o.firma)+'</td>'+
            '<td style="padding:4px 8px;font-size:11px;color:#6b7280;border-bottom:1px solid #f3f4f6;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(o.lokalita)+'">'+esc(o.lokalita)+'</td>'+
            '<td style="padding:4px 8px;font-size:11px;border-bottom:1px solid #f3f4f6;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(o.smes)+'">'+esc(o.smes)+'</td>'+
            '<td style="padding:4px 8px;border-bottom:1px solid #f3f4f6">'+_ctxStatusBadge(o.status)+'</td>'+
            '<td style="padding:4px 8px;font-weight:700;text-align:right;font-size:12px;border-bottom:1px solid #f3f4f6;white-space:nowrap">'+o.tuny+' t</td>'+
          '</tr>'
        ).join('');
        partBHtml =
          '<div style="margin-bottom:14px">'+
            '<div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Ostatní na tento den ('+allOther.length+')</div>'+
            '<table style="width:100%;border-collapse:collapse">'+
              '<thead><tr style="background:#f9fafb">'+
                '<th style="text-align:left;padding:4px 8px;font-size:10px;font-weight:600;color:#9ca3af;border-bottom:1px solid #e5e7eb">Firma</th>'+
                '<th style="text-align:left;padding:4px 8px;font-size:10px;font-weight:600;color:#9ca3af;border-bottom:1px solid #e5e7eb">Lokalita</th>'+
                '<th style="text-align:left;padding:4px 8px;font-size:10px;font-weight:600;color:#9ca3af;border-bottom:1px solid #e5e7eb">Produkt</th>'+
                '<th style="text-align:left;padding:4px 8px;font-size:10px;font-weight:600;color:#9ca3af;border-bottom:1px solid #e5e7eb">Stav</th>'+
                '<th style="text-align:right;padding:4px 8px;font-size:10px;font-weight:600;color:#9ca3af;border-bottom:1px solid #e5e7eb">Tuny</th>'+
              '</tr></thead>'+
              '<tbody>'+bRows+'</tbody>'+
            '</table>'+
          '</div>';
      }
    }

    // ── ČÁST C – Den po schválení ──
    let partCHtml;
    if (!_curDayCtx || _curDayCtx.maxDaily == null) {
      partCHtml = _curDayCtx === null
        ? '<div style="margin-bottom:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;color:#94a3b8;font-size:12px;font-style:italic">Načítám kapacitu…</div>'
        : '';
    } else {
      const { harmTotal, otherApprovedTotal, maxDaily: mx } = _curDayCtx;
      const projTotal = (harmTotal||0) + (otherApprovedTotal||0) + dayTuny;
      const over = projTotal > mx;
      const cbg  = over ? '#fef2f2' : '#f0fdf4';
      const cbdr = over ? '#fca5a5' : '#86efac';
      const ccol = over ? '#991b1b' : '#166534';
      const cicon = over ? '⚠' : '✓';
      partCHtml =
        '<div style="margin-bottom:14px;background:'+cbg+';border:1.5px solid '+cbdr+';border-radius:8px;padding:10px 14px">'+
          '<div style="font-size:10px;font-weight:700;color:'+ccol+';text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Den po schválení</div>'+
          '<div style="font-size:13px;font-weight:700;color:'+ccol+'">'+cicon+' '+projTotal+' t / max '+mx+' t</div>'+
          '<div style="font-size:11px;color:#6b7280;margin-top:3px">'+
            'Tato objednávka: '+dayTuny+' t &nbsp;·&nbsp; '+
            'Ostatní schválené: '+(otherApprovedTotal||0)+' t &nbsp;·&nbsp; '+
            'Harmonogram: '+(harmTotal||0)+' t'+
          '</div>'+
        '</div>';
    }

    inner.innerHTML =
      // Hlavička
      '<div style="background:#1a1a2e;color:#fff;padding:13px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px">'+
        '<div><div style="font-size:15px;font-weight:700">'+esc(g.firma)+' — '+fmtDatum(datum)+'</div>'+
        '<div style="font-size:11px;color:#94a3b8;margin-top:2px">'+esc(g.username||'?')+' · '+esc(g.lokalita||'—')+' · GPS: '+esc(gps)+'</div></div>'+
        '<button onclick="OA.closeDayPopup()" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:20px;line-height:1;padding:2px 6px;font-family:Inter,sans-serif">✕</button>'+
      '</div>'+

      // Tělo
      '<div style="padding:16px 18px">'+

        // Přehled dnů
        '<div style="margin-bottom:14px">'+
          '<div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Všechny dny objednávky</div>'+
          '<div>'+daysHtml+'</div>'+
        '</div>'+

        // ČÁST A – Schvaluješ
        '<div style="margin-bottom:14px;background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:8px;padding:12px 14px">'+
          '<div style="font-size:10px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">'+
            'Schvaluješ — '+fmtDatumShort(datum)+' · '+dayTuny+' t celkem</div>'+
          '<div style="font-size:11px;color:#1e3a8a;font-weight:600;margin-bottom:8px">'+esc(g.firma)+' · '+esc(g.lokalita||'—')+'</div>'+
          (dayRows.length
            ? '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
                '<thead><tr style="background:rgba(29,78,216,.07)">'+
                  '<th style="text-align:left;padding:4px 8px;border-bottom:1px solid #bfdbfe;font-size:10px;font-weight:600;color:#1d4ed8">Směs</th>'+
                  '<th style="text-align:left;padding:4px 8px;border-bottom:1px solid #bfdbfe;font-size:10px;font-weight:600;color:#1d4ed8">ITT</th>'+
                  '<th style="text-align:right;padding:4px 8px;border-bottom:1px solid #bfdbfe;font-size:10px;font-weight:600;color:#1d4ed8">Tuny</th>'+
                '</tr></thead><tbody>'+
                dayRows.map(r =>
                  '<tr>'+
                    '<td style="padding:4px 8px;border-bottom:1px solid #dbeafe;font-size:12px;color:#1e3a8a">'+esc(r.smes)+'</td>'+
                    '<td style="padding:4px 8px;border-bottom:1px solid #dbeafe;font-size:11px;color:#3b82f6">'+esc(r.itt||'')+'</td>'+
                    '<td style="padding:4px 8px;border-bottom:1px solid #dbeafe;font-weight:700;text-align:right;color:#1d4ed8;white-space:nowrap">'+r.tuny+' t</td>'+
                  '</tr>'
                ).join('')+
                '</tbody></table>'
            : '<div style="color:#6b7280;font-size:12px">Žádné řádky pro tento den.</div>')+
        '</div>'+

        // ČÁST B – Ostatní na tento den
        partBHtml+

        // ČÁST C – Den po schválení
        partCHtml+

        // Denní akce
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">'+dayBtns+'</div>'+

        // Pole pro důvod (skryté)
        '<div id="oa-reason-wrap" style="display:none;background:#fff5f5;border:1px solid #fca5a5;border-radius:6px;padding:10px 12px;margin-bottom:10px">'+
          '<div id="oa-reason-title" style="font-size:11px;font-weight:700;color:#dc2626;margin-bottom:5px">Důvod zamítnutí *</div>'+
          '<textarea id="oa-reason-ta" rows="2" style="width:100%;border:1px solid #fca5a5;border-radius:6px;padding:5px 8px;font-size:12px;font-family:Inter,sans-serif;resize:vertical;outline:none"></textarea>'+
          '<div style="display:flex;gap:6px;margin-top:7px;align-items:center">'+
            '<button onclick="OA._confirmReject()" style="'+_btnStyle('#dc2626')+'">Potvrdit</button>'+
            '<button onclick="document.getElementById(\'oa-reason-wrap\').style.display=\'none\'" style="'+_btnStyle('#6b7280')+'">Zrušit</button>'+
            '<span id="oa-reason-msg" style="font-size:12px;color:#dc2626"></span>'+
          '</div>'+
        '</div>'+

        // Zpráva akce
        '<div id="oa-action-msg" style="font-size:12px;margin-bottom:8px;color:#dc2626;min-height:16px"></div>'+

        // Finální sekce
        '<div style="padding-top:12px;border-top:1px solid #e5e7eb">'+
          '<div style="font-size:11px;color:#6b7280;margin-bottom:7px">Finální rozhodnutí celé objednávky:</div>'+
          '<div style="display:flex;gap:8px;flex-wrap:wrap">'+finalBtns+'</div>'+
          (!allDecided ? '<div style="font-size:11px;color:#f59e0b;margin-top:5px">⚠ Nejdřív rozhodni všechny dny</div>' : '')+
        '</div>'+

      '</div>'; // /tělo
  }

  function _btnStyle(bg) {
    return 'background:'+bg+';color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:Inter,sans-serif;white-space:nowrap;';
  }

  // ── Akce ──
  function _showRejectReason(mode) {
    _rejectMode = mode;
    const wrap = document.getElementById('oa-reason-wrap');
    const title = document.getElementById('oa-reason-title');
    if (title) title.textContent = (mode==='all' ? 'Důvod zamítnutí CELÉ objednávky *' : 'Důvod zamítnutí dne *');
    if (wrap) wrap.style.display = 'block';
    const ta = document.getElementById('oa-reason-ta');
    if (ta) { ta.value = ''; ta.focus(); }
    const msg = document.getElementById('oa-reason-msg');
    if (msg) msg.textContent = '';
  }

  async function _confirmReject() {
    const reason = (document.getElementById('oa-reason-ta')?.value||'').trim();
    const msg = document.getElementById('oa-reason-msg');
    if (!reason) { if(msg) msg.textContent = '⚠ Zadejte důvod'; return; }
    if (msg) msg.textContent = '';
    if (_rejectMode==='all') await _doRejectAll(reason);
    else await _doPrereject(reason);
  }

  async function _doPreapprove() {
    _setActionMsg('');
    const r = await apiCall('PATCH', '/api/orders/'+_curGid+'/day/'+_curDatum+'/preapprove');
    if (r.error) { _setActionMsg('✗ '+r.error); return; }
    if (r.exceedsMax) {
      _setActionMsg('⚠ Upozornění: den '+fmtDatumShort(_curDatum)+' překročí maximum ('+r.total+' t > max '+r.max+' t). Akce provedena.', '#92400e');
    }
    await _afterAction(false);
  }

  async function _doPrereject(reason) {
    const r = await apiCall('PATCH', '/api/orders/'+_curGid+'/day/'+_curDatum+'/prereject', {reason});
    if (r.error) { _setActionMsg('✗ '+r.error); return; }
    await _afterAction(false);
  }

  async function _doResetDay() {
    const r = await apiCall('PATCH', '/api/orders/'+_curGid+'/day/'+_curDatum+'/reset');
    if (r.error) { _setActionMsg('✗ '+r.error); return; }
    await _afterAction(false);
  }

  async function _doFinalize() {
    if (!confirm('Finálně potvrdit objednávku?\nPre-schválené dny se stanou schválenými a propíšou se do harmonogramu.')) return;
    const r = await apiCall('PATCH', '/api/orders/'+_curGid+'/finalize');
    if (r.error) { _setActionMsg('✗ '+r.error); return; }
    closeDayPopup();
    await _afterAction(true);
  }

  async function _doRejectAll(reason) {
    if (!confirm('Zamítnout CELOU objednávku? Všechny dny budou zamítnuty.')) return;
    const r = await apiCall('PATCH', '/api/orders/'+_curGid+'/reject-all', {reason});
    if (r.error) { _setActionMsg('✗ '+r.error); return; }
    closeDayPopup();
    await _afterAction(true);
  }

  function _setActionMsg(msg, color) {
    const el = document.getElementById('oa-action-msg');
    if (el) { el.textContent = msg; el.style.color = color||'#dc2626'; }
  }

  async function _afterAction(fullReload) {
    await loadPendingGroups();
    updateBanner(_pendingGroups.length);
    if (_dropOpen) _renderDrop(); // aktualizuj dropdown pokud je otevřen
    if (!fullReload && _popupEl && _popupEl.style.display!=='none') {
      if (_curGid && _curDatum) {
        _curDayCtx = await _loadDayContext(_curDatum, _curGid);
      }
      _renderPopup(); // překresli popup s novými daty
    }
    if (_onAfterAction) await _onAfterAction(fullReload);
  }

  // ── Generování HTML řádku objednávky pro TÝDENNÍ tabulku (index.html) ──
  // weekDates: ['YYYY-MM-DD', ...] pro d0..d6
  // Vrátí HTML string <tr>...</tr>
  function buildWeekOrderRow(g, mixKey, smes, itt, daysMap, statusMap, weekDates) {
    const gc = getGroupColor(g.order_group_id);

    // Default datum pro klik (první den s daty v týdnu, přednost pending)
    const pendingDays = weekDates.filter(d => daysMap[d] && statusMap[d]==='pending');
    const defaultDatum = pendingDays[0] || weekDates.find(d => daysMap[d]) || weekDates[0];

    const gidSafe = esc(g.order_group_id);

    let tr = '<tr class="oa-order-row" style="border-left:4px solid '+gc.dot+';background:'+gc.bg+';cursor:pointer" '+
      'data-gid="'+gidSafe+'" '+
      'onmouseenter="OA.showHover(event,\''+gidSafe+'\',\''+esc(defaultDatum)+'\')" '+
      'onmouseleave="OA.hideHover()" '+
      'onclick="OA.openDayPopup(\''+gidSafe+'\',\''+esc(defaultDatum)+'\')">';

    // č. (cislo col) — barevný indikátor
    tr += '<td style="background:'+gc.bg+';color:'+gc.dot+';font-size:14px;font-weight:900;text-align:center">●</td>';
    // lokalita
    tr += '<td style="background:'+gc.bg+';text-align:left;padding-left:4px;font-size:11px;overflow:hidden;text-overflow:ellipsis">'+esc(g.lokalita||'')+'</td>';
    // objednávka
    tr += '<td style="background:'+gc.bg+';font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis">'+esc(g.firma||'')+'</td>';
    // smes
    tr += '<td style="background:'+gc.bg+';text-align:left;font-size:11px;overflow:hidden;text-overflow:ellipsis">'+esc(smes||'')+'</td>';
    // itt
    tr += '<td style="background:'+gc.bg+';font-size:11px;overflow:hidden;text-overflow:ellipsis">'+esc(itt||'')+'</td>';
    // ceta – badge stavu
    const overallSt = weekDates.reduce((w,d) => {
      if (!statusMap[d]) return w;
      const ord = ['pre_rejected','pre_approved','pending'];
      return ord.indexOf(statusMap[d]) > ord.indexOf(w) ? statusMap[d] : w;
    }, 'pre_rejected');
    tr += '<td style="background:'+gc.bg+'">'+statusBadgeHtml(overallSt)+'</td>';

    // day cols d0..d6
    weekDates.forEach(d => {
      const tuny = daysMap[d];
      const st = statusMap[d];
      if (tuny) {
        tr += '<td style="'+dayCellStyle(st)+';cursor:pointer" '+
          'onclick="event.stopPropagation();OA.openDayPopup(\''+gidSafe+'\',\''+esc(d)+'\')" '+
          'onmouseenter="event.stopPropagation();OA.showHover(event,\''+gidSafe+'\',\''+esc(d)+'\')" '+
          'onmouseleave="OA.hideHover()">'+tuny+'</td>';
      } else {
        tr += '<td style="background:'+gc.bg+'"></td>';
      }
    });

    // souhrn
    const tot = Object.values(daysMap).reduce((s,v)=>s+v,0);
    tr += '<td style="background:'+gc.bg+';font-weight:700">'+tot+'</td>';
    // sel col
    tr += '<td style="background:'+gc.bg+'"></td>';
    tr += '</tr>';
    return tr;
  }

  // ── Generování HTML řádku objednávky pro MĚSÍČNÍ tabulku (month.html) ──
  // visibleDays: [1,2,...,31] čísla dní (viditelné)
  // y, m: rok a měsíc (0-based)
  function buildMonthOrderRow(g, smes, itt, daysMap, statusMap, visibleDays, y, m) {
    const gc = getGroupColor(g.order_group_id);
    function iso(d) { return y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'); }

    // Default datum pro klik (první den s daty, přednost pending)
    const pendingDays = visibleDays.filter(d => daysMap[d] && statusMap[d]==='pending');
    const defaultDay  = pendingDays[0] || visibleDays.find(d=>daysMap[d]) || visibleDays[0];
    const defaultDatum = iso(defaultDay);
    const gidSafe = esc(g.order_group_id);

    let tr = '<tr class="oa-order-row" style="cursor:pointer" '+
      'data-gid="'+gidSafe+'" '+
      'onmouseenter="OA.showHover(event,\''+gidSafe+'\',\''+esc(defaultDatum)+'\')" '+
      'onmouseleave="OA.hideHover()" '+
      'onclick="OA.openDayPopup(\''+gidSafe+'\',\''+esc(defaultDatum)+'\')">';

    // lokalita (col-lok)
    tr += '<td style="text-align:left;padding-left:6px;background:'+gc.bg+';font-size:11px;font-weight:600;color:#374151;border-left:3px solid '+gc.dot+'">'+
      '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+gc.dot+';margin-right:4px;vertical-align:middle"></span>'+
      esc(g.firma||'')+'</td>';
    // objednávka
    tr += '<td style="background:'+gc.bg+';text-align:center">'+statusBadgeHtml(
      visibleDays.reduce((w,d) => {
        if (!statusMap[d]) return w;
        const ord = ['pre_rejected','pre_approved','pending'];
        return ord.indexOf(statusMap[d])>ord.indexOf(w) ? statusMap[d] : w;
      }, 'pre_rejected')
    )+'</td>';
    // smes
    tr += '<td style="background:'+gc.bg+';text-align:left;padding-left:6px;font-size:12px">'+esc(smes||'')+'</td>';
    // itt
    tr += '<td style="background:'+gc.bg+';font-size:11px">'+esc(itt||'')+'</td>';
    // ceta
    tr += '<td style="background:'+gc.bg+';font-size:11px">'+esc(g.firma||'')+'</td>';

    // day cols
    visibleDays.forEach(d => {
      const tuny = daysMap[d];
      const st = statusMap[d];
      const datum = iso(d);
      if (tuny) {
        tr += '<td style="'+dayCellStyle(st)+';cursor:pointer" '+
          'onclick="event.stopPropagation();OA.openDayPopup(\''+gidSafe+'\',\''+esc(datum)+'\')" '+
          'onmouseenter="event.stopPropagation();OA.showHover(event,\''+gidSafe+'\',\''+esc(datum)+'\')" '+
          'onmouseleave="OA.hideHover()">'+tuny+'</td>';
      } else {
        tr += '<td style="background:'+gc.bg+'"></td>';
      }
    });

    tr += '</tr>';
    return tr;
  }

  // ── Veřejné API ──
  return {
    getGroupColor, loadPendingGroups, getPendingGroups, getGroupInfo,
    initBanner, updateBanner, refreshBanner,
    showHover, hideHover,
    openDayPopup, closeDayPopup,
    statusBadgeHtml, statusTextShort, dayCellStyle,
    fmtDatum, fmtDatumShort, esc,
    buildWeekOrderRow, buildMonthOrderRow,
    setOnAfterAction(fn) { _onAfterAction = fn; },
    setNavigateToDate(fn) { _navigateFn = fn; },
    // Interní volání z popup tlačítek (onclick), dropdown a přepínání dní
    _doPreapprove, _doPrereject, _doResetDay, _doFinalize, _doRejectAll,
    _showRejectReason, _confirmReject, _dropRowClick, _switchDay
  };
})();
