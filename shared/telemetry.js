// telemetry.js — one-way event emitter to the dashboard. ES5 (Max js object).
// Loaded via include("telemetry.js").
//
// Transport: events are JSON strings sent out a js outlet, through
// [s rigbrain-telemetry] (conductor shell) or directly (sentinel shell) into
// node.script, which fans out to the browser via SSE and appends to the
// session log. STRICTLY one-way: nothing ever comes back down this pipe.
//
// SHOW mode caps per-type emit rate so telemetry can never become a CPU cost.

var Telemetry = (function () {

  var src = '?';
  var sender = null;        // function(jsonString) — wired to an outlet by the device
  var mode = 'REHEARSE';
  var lastEmit = {};        // type -> ms timestamp of last emit
  var seq = 0;

  // Per-type minimum interval (ms) in SHOW mode. 0 = uncapped.
  // Alerts and lifecycle events are never throttled — silence is never ambiguous.
  var SHOW_CAPS = {
    'meters': 250,        // 4 Hz is plenty for eyes
    'clock': 250,
    'ramp': 500,
    'alive': 1000,
    'dryrun': 1000
  };

  function now() { return (new Date()).getTime(); }

  function init(sourceName, sendFn) {
    src = sourceName;
    sender = sendFn;
  }

  function setMode(m) { mode = m; }

  function emit(type, payload) {
    if (!sender) return;
    if (mode === 'SHOW' && SHOW_CAPS[type]) {
      var t = now();
      if (lastEmit[type] && (t - lastEmit[type]) < SHOW_CAPS[type]) return;
      lastEmit[type] = t;
    }
    var ev = payload || {};
    ev.t = type;
    ev.src = src;
    ev.n = ++seq;
    try {
      sender(JSON.stringify(ev));
    } catch (e) {
      // Telemetry must never take down control. Swallow, count nothing, move on.
    }
  }

  // Beat-synced heartbeat. Stale heartbeat = red banner on the dashboard.
  function heartbeat(beat, extra) {
    var p = extra || {};
    p.beat = beat;
    emit('hb', p);
  }

  function alert(kind, detail) {
    emit('alert', { kind: kind, detail: detail });
  }

  return {
    init: init,
    setMode: setMode,
    emit: emit,
    heartbeat: heartbeat,
    alert: alert
  };
})();
