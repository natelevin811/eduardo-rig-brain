// demo/driver.js — injected AFTER the dashboard's main script in the hosted demo.
// Pushes a looping stream of synthetic telemetry into the fake EventSource so the
// real dashboard UI animates a believable show (heartbeats, meters, DJ rides, a
// move cycle incl. an I Ching cast, a ritual, a couple alerts). No network, no rig.
(function () {
  var ES = window.__demoES;
  if (!ES) return;
  function send(ev) { if (ES.onmessage) { try { ES.onmessage({ data: JSON.stringify(ev) }); } catch (e) {} } }

  var BUSES = ['LoDrumsBus', 'HiDrumsBus', 'PercBus', 'BassBus', 'PadsBus', 'LeadsBus'];

  // --- neutralize rig-only affordances in the hosted demo ---
  function byId(id) { return document.getElementById(id); }
  var badge = document.createElement('div');
  badge.textContent = 'DEMO · synthetic telemetry';
  badge.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:99;' +
    'font:600 11px/1 ui-monospace,monospace;letter-spacing:.12em;color:#0b0d10;background:#46a89e;' +
    'padding:7px 14px;border-radius:999px;opacity:.92;text-transform:uppercase;pointer-events:none';
  document.body.appendChild(badge);
  function toast(m) { badge.textContent = m; setTimeout(function () { badge.textContent = 'DEMO · synthetic telemetry'; }, 1600); }
  var bc = byId('btnClassic'); if (bc) bc.onclick = function () { toast('classic UI lives on the rig'); };
  var bl = byId('btnLog'); if (bl) bl.onclick = function () { toast('log export needs the rig'); };
  var bcp = byId('btnCopy'); if (bcp) bcp.onclick = function () { toast('log copy needs the rig'); };
  document.addEventListener('keydown', function (e) { if (e.key === '\\') { e.preventDefault(); e.stopPropagation(); } }, true);

  send({ t: 'mode', mode: 'REHEARSE' });
  send({ t: 'hb', src: 'sentinel', frozen: 0, nightArc: 0 });

  // --- bus meter wander + sentinel trims ---
  var ph = {}; for (var i = 0; i < BUSES.length; i++) ph[BUSES[i]] = i * 1.3;
  var layers = { LoDrumsBus: 1, HiDrumsBus: 0, PercBus: 2, BassBus: 1, PadsBus: 3, LeadsBus: 2 };
  var trims = { LoDrumsBus: 0, HiDrumsBus: 0, PercBus: 0, BassBus: 0, PadsBus: 0, LeadsBus: 0 };
  function meters(tsec) {
    var buses = {}, main = 0;
    for (var k = 0; k < BUSES.length; k++) {
      var b = BUSES[k];
      var v = 0.34 + 0.18 * Math.sin(tsec * 0.6 + ph[b]) + 0.09 * Math.sin(tsec * 1.7 + ph[b] * 2);
      if (b === 'PadsBus') v += 0.12;
      v = Math.max(0.05, Math.min(0.9, v));
      buses[b] = { m: v, trim: trims[b], layers: layers[b] };
      if (v > main) main = v;
    }
    main = Math.min(0.97, main + 0.06);
    var hot = main > 0.88;
    for (var j = 0; j < BUSES.length; j++) {
      var bb = BUSES[j];
      var target = (hot && (bb === 'PadsBus' || bb === 'LeadsBus')) ? -1.6 : 0;
      trims[bb] += (target - trims[bb]) * 0.15;
      if (Math.abs(trims[bb]) < 0.03) trims[bb] = 0;
    }
    send({ t: 'meters', ceiling: 0.92, main: main, buses: buses });
  }
  function djstate(tsec) {
    var buses = {};
    buses.PercBus = 0.5 + 0.16 * Math.sin(tsec * 0.4);
    buses.PadsBus = 0.5 - 0.12 * Math.sin(tsec * 0.3 + 1);
    buses.LeadsBus = 0.5 + 0.05 * Math.sin(tsec * 0.5 + 2);
    send({ t: 'djstate', center: 0.5, buses: buses });
  }

  // --- move timeline (schedules drawable by the dashboard) ---
  function washSchedule() { return { total: 16, events: [], lanes: [
    { label: 'PadsBus/sndB', segs: [{ s: 0, e: 8, f: 0.18, t: 0.62 }, { s: 8, e: 12, f: 0.62, t: 0.62 }, { s: 12, e: 16, f: 0.62, t: 0.18 }] },
    { label: 'LeadsBus/sndB', segs: [{ s: 0, e: 8, f: 0.20, t: 0.55 }, { s: 8, e: 12, f: 0.55, t: 0.55 }, { s: 12, e: 16, f: 0.55, t: 0.20 }] },
    { label: 'PercBus/sndC', segs: [{ s: 0, e: 8, f: 0.15, t: 0.50 }, { s: 8, e: 12, f: 0.50, t: 0.50 }, { s: 12, e: 16, f: 0.50, t: 0.15 }] }
  ] }; }
  function breathSchedule() { return { total: 8, events: [], lanes: [
    { label: 'HiDrums/DJ', segs: [{ s: 0, e: 4, f: 0.5, t: 0.22 }, { s: 4, e: 8, f: 0.22, t: 0.5 }] },
    { label: 'Pads/DJ', segs: [{ s: 0, e: 4, f: 0.5, t: 0.20 }, { s: 4, e: 8, f: 0.20, t: 0.5 }] },
    { label: 'Leads/DJ', segs: [{ s: 0, e: 4, f: 0.5, t: 0.24 }, { s: 4, e: 8, f: 0.24, t: 0.5 }] }
  ] }; }
  function ichingSchedule() { return { total: 20, events: [], lanes: [
    { label: 'PadsBus/sndB', segs: [{ s: 0, e: 10, f: 0.20, t: 0.34 }, { s: 10, e: 20, f: 0.34, t: 0.20 }] },
    { label: 'LeadsBus/sndC', segs: [{ s: 0, e: 10, f: 0.18, t: 0.30 }, { s: 10, e: 20, f: 0.30, t: 0.18 }] },
    { label: 'PercBus/sndD', segs: [{ s: 0, e: 20, f: 0.30, t: 0.30, sine: true }] }
  ] }; }
  var ICHING_READING = {
    lines: [{ yang: true, changing: false }, { yang: false, changing: true }, { yang: true, changing: false },
            { yang: true, changing: false }, { yang: false, changing: false }, { yang: false, changing: false }],
    present: { n: 53, name: 'Development', upper: 'WIND', lower: 'MOUNTAIN', upperGlyph: '☴', lowerGlyph: '☶' },
    relating: { n: 39, name: 'Obstruction', upper: 'WATER', lower: 'MOUNTAIN', upperGlyph: '☵', lowerGlyph: '☶' }
  };

  var CYCLE = 64, active = null;
  function onBar(bar) {
    var b = bar % CYCLE;
    if (b === 2) { active = { of: 16, start: bar }; send({ t: 'move', phase: 'start', name: 'WASH 16', bars: 16,
      touching: ['PadsBus/sndB', 'LeadsBus/sndB', 'PercBus/sndC'], skipped: [], next: '', schedule: washSchedule() }); }
    else if (b === 18) { active = null; send({ t: 'move', phase: 'end' }); }
    else if (b === 22) { active = { of: 8, start: bar }; send({ t: 'move', phase: 'start', name: 'BREATH 8', bars: 8,
      touching: ['HiDrums/DJ', 'Pads/DJ', 'Leads/DJ'], skipped: ['Bass/DJ:sentry'], next: '', schedule: breathSchedule() }); }
    else if (b === 30) { active = null; send({ t: 'move', phase: 'end' }); }
    else if (b === 36) { active = { of: 20, start: bar }; send({ t: 'move', phase: 'start', name: 'ICHING 20', bars: 20,
      touching: ['PadsBus/sndB', 'LeadsBus/sndC', 'PercBus/sndD'], skipped: [], next: '', schedule: ichingSchedule(), iching: ICHING_READING }); }
    else if (b === 56) { active = null; send({ t: 'move', phase: 'end' }); }
    else if (b === 60) { send({ t: 'move', phase: 'cleanslate', restored: 3 }); }

    if (active) { var rb = bar - active.start; if (rb >= 0 && rb <= active.of) send({ t: 'ramp', bars: rb, of: active.of }); }

    if (b === 10) send({ t: 'alert', kind: 'drive', detail: 'PadsBus/sndB slot 0 v=0.62 [0..1] cap=0.18' });
    if (b === 31) send({ t: 'sentry_skip', param: 'Bass/DJ', captured: 0.21 });
    if (b === 44) send({ t: 'ritual', fixed: ['DJ filters centered', 'crossfader centered', 'SENTRIM trims zeroed', 'EQ Three unity'],
      failed: [], verify: [{ name: 'HELIX capture marks', ok: 1, detail: 'TRIM 7.78 / FADE -5.89 dB' }, { name: 'buffer size 128', human: true, detail: 'confirm by hand' }] });
  }

  var t0 = Date.now(), BEAT_MS = 460, beat = -1, lastBar = -1;
  setInterval(function () {
    var ms = Date.now() - t0, tsec = ms / 1000;
    var nb = Math.floor(ms / BEAT_MS);
    if (nb !== beat) {
      beat = nb;
      var bar = Math.floor(beat / 4);
      send({ t: 'hb', src: 'conductor', beat: beat, bar: bar + 1, tempo: 81, alive: 0, dry: 0, mode: 'REHEARSE' });
      send({ t: 'hb', src: 'sentinel', frozen: 0, nightArc: 0 });
      if (bar !== lastBar) { lastBar = bar; onBar(bar); }
      if (beat % 4 === 0) djstate(tsec);
    }
    meters(tsec);
  }, 110);
})();
