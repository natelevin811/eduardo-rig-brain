// sentinel.js — SENTINEL v2.1 brain. ES5 (Max js object). Hot-reloadable.
//
// Owns exactly one thing: the SENTRIM utility Gain on each bus. Nothing else.
// Never boosts above 0. Trims only when Main is near ceiling AND one bus has
// held dominant share through the attack window. Releases slowly toward 0
// (or the NIGHT ARC bias) when headroom returns.
//
// Shell wiring (docs/SHELL-BUILD.md):
//   inlet 0  : init, sync <beats>, mode REHEARSE|SHOW, dryrun 0/1, ritual,
//              nightarc 0/1
//   outlet 0 : grab pool — [slot 'id' paramId] / [slot 'val' f] / [slot 'id' 0]
//              → 7 live.remote~ objects (6 SENTRIMs + spare)
//   outlet 1 : telemetry JSON → node.script (dashboard lives in this shell)
//   outlet 2 : UI status for the shell
//
// All writes go through Resolver.set / live.remote~ — the LINK CONTRACT guard
// in resolver.js applies here exactly as it does in the conductor.

autowatch = 1;
inlets = 1;
outlets = 3;

// BUILD stamp: posts on every compile (load AND autowatch recompile) so the
// Max window always shows which file revision is actually running.
var BUILD = '2026-06-12d transport-poll';
(function () {
  var loc = '';
  try {
    var f = new File(jsarguments[0]); // resolves via the search path — shows WHICH copy
    if (f.isopen) { loc = ' @ ' + f.foldername; f.close(); }
  } catch (e) {}
  post('[sentinel] build ' + BUILD + loc + '\n');
})();

include("resolver.js");
include("telemetry.js");

var SETMAP_FILE = "eduardo-setmap.json";
var TICK_MS = 100;            // 10 Hz control loop
var HISTORY_SECONDS = 60;     // sparkline depth

// NIGHT ARC — optional governor, default OFF. ±2 dB total authority, expressed
// only through the release bias of existing trims. If it isn't obviously right
// in rehearsal, it ships disabled and stays a log overlay.
var NIGHT_ARC = {
  startHour: 0,     // midnight: bias 0 dB
  endHour: 4,       // 4 a.m.: bias at full depth
  maxBiasDb: -2.0   // hard cap, spec law
};

var S = {
  ready: false,
  setmap: null,
  mode: 'REHEARSE',
  dryRun: false,
  nightArcOn: false,
  frozen: false,         // transport stopped → sentinel freezes
  beatsPerBar: 4,
  nowBeats: 0,
  lastBeat: -1,
  buses: [],             // control state per bus, see init()
  mainApi: null,
  ceiling: 0.92,
  cfg: null,             // setmap.sentinel_targets
  ritualPending: false
};

var REG = { clLanes: [] };
var TASK = null;

// ---------------------------------------------------------------------------
// exception jail — same law as the conductor. 3 in 60 s = self-disable.
// ---------------------------------------------------------------------------
var JAIL = { stamps: [], total: 0, disabled: false };

function nowMs() { return (new Date()).getTime(); }

function jailRun(label, fn, args) {
  if (JAIL.disabled) return undefined;
  try {
    return fn.apply(null, args || []);
  } catch (e) {
    JAIL.total++;
    var t = nowMs();
    JAIL.stamps.push(t);
    while (JAIL.stamps.length && t - JAIL.stamps[0] > 60000) JAIL.stamps.shift();
    releaseAllGrabs();
    Telemetry.alert('exception', 'sentinel/' + label + ': ' + String(e.message || e));
    uiOut('errors', JAIL.total);
    dbg('EXCEPTION in ' + label + ': ' + (e.message || e));
    if (JAIL.stamps.length >= 3) {
      JAIL.disabled = true;
      if (TASK) TASK.cancel();
      Telemetry.emit('subsystem_down', { sub: 'sentinel', reason: '3 exceptions in 60s' });
      uiOut('disabled', 1);
      dbg('SENTINEL SELF-DISABLED — trims hold at last values, set keeps playing.');
    }
    return undefined;
  }
}

function dbg(s) { if (S.mode !== 'SHOW') post('[sentinel] ' + s + '\n'); }
function uiOut() { var a = ['ui']; for (var i = 0; i < arguments.length; i++) a.push(arguments[i]); outlet(2, a); }

// ---------------------------------------------------------------------------
// meter scale — Live meter floats, approximately 0.025 per dB near the top
// (0.85 ≈ 0 dB, 1.0 ≈ +6 dB). Good enough for headroom math near the ceiling;
// CALIBRATION.md has the verification step.
// ---------------------------------------------------------------------------
function meterDbRel(m, ref) { return (m - ref) / 0.025; }

// ---------------------------------------------------------------------------
// grab pool (sentinel-local) — grabs only while a trim value is in motion.
// ---------------------------------------------------------------------------
function grabOn(b) {
  if (b.grabbed || S.dryRun || !b.trimInfo) return;
  outlet(0, [b.slot, 'id', b.trimInfo.id]);
  b.grabbed = true;
}
function grabOff(b) {
  if (!b.grabbed) return;
  outlet(0, [b.slot, 'id', 0]);
  b.grabbed = false;
}
function releaseAllGrabs() {
  for (var i = 0; i < S.buses.length; i++) {
    if (S.buses[i] && S.buses[i].grabbed) { outlet(0, [S.buses[i].slot, 'id', 0]); S.buses[i].grabbed = false; }
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function init() { jailRun('init', _init); }

function _init() {
  Resolver.clearMissing();
  Telemetry.init('sentinel', function (s) { outlet(1, s); });
  Telemetry.setMode(S.mode);

  S.setmap = Resolver.loadSetmap(SETMAP_FILE);
  if (!S.setmap) { reportResolution(); return; }

  // retry passes re-run _init and rebuild S.buses: release any held grabs
  // BEFORE the rebuild drops the grabbed flags, or bindings orphan.
  releaseAllGrabs();
  S.cfg = S.setmap.sentinel_targets;
  S.ceiling = S.cfg.main_peak_ceiling;
  S.beatsPerBar = Resolver.beatsPerBar();

  var histLen = Math.round(HISTORY_SECONDS * 1000 / TICK_MS);
  var attackLen = Math.round(S.cfg.attack_window_sec * 1000 / TICK_MS);

  S.buses = [];
  for (var i = 0; i < S.setmap.buses.length; i++) {
    var bdef = S.setmap.buses[i];
    var t = Resolver.track(bdef.name);
    if (!t) continue;
    var trimDev = Resolver.device(bdef.name, 'SENTRIM', t);
    var trimParam = Resolver.param(trimDev,
      S.cfg.utility_gain_param_candidates || ['Gain', 'Output'],
      bdef.name + '/SENTRIM');
    var clampLow = (bdef.name === 'LoDrumsBus')
      ? S.cfg.lodrums_trim_clamp_db[0] : S.cfg.bus_trim_clamp_db[0];
    S.buses.push({
      name: bdef.name,
      track: t,
      trimInfo: trimParam ? Resolver.paramInfo(trimParam) : null,
      clampLow: clampLow,
      slot: i,
      grabbed: false,
      trimDb: 0,             // our current authority, dB (<= 0 always)
      meter: 0,
      hist: new Array(histLen),
      histIdx: 0,
      attackLen: attackLen,
      layers: 0,             // loop census
      stableTicks: 0,
      comfortTicks: 0
    });
  }
  S.mainApi = new LiveAPI('live_set master_track');

  // CL lanes for the loop census + capture-sanity events
  REG.clLanes = [];
  for (i = 0; i < S.setmap.loop_lanes.length; i++) {
    var lane = S.setmap.loop_lanes[i];
    var lt = Resolver.track(lane.name);
    if (lt) REG.clLanes.push({
      name: lane.name, bus: lane.bus, track: lt,
      path: lt.unquotedpath || lt.path.replace(/"/g, ''),
      wasRecording: false, watch: null
    });
  }

  // guarded: resolution RETRY re-runs _init; a second observer would double-fire
  if (!REG.playObserver) {
    REG.playObserver = new LiveAPI(onIsPlaying, 'live_set');
    REG.playObserver.property = 'is_playing';
  }
  S.frozen = Resolver.readIsPlaying() !== 1;
  REG.liveSetClock = new LiveAPI('live_set'); // beat-clock fallback reads current_song_time

  if (TASK) TASK.cancel();
  TASK = new Task(tickJail, this);
  TASK.interval = TICK_MS;
  TASK.repeat();

  S.ready = true;
  reportResolution();
  Telemetry.emit('boot', { sub: 'sentinel', missing: Resolver.getMissing().length, mode: S.mode });

  // pattr may have restored trims before we were ready — apply them now
  if (S.pendingTrims) { applyTrims(S.pendingTrims); S.pendingTrims = null; }

  // RITUAL auto-runs on set load in REHEARSE only; manual-only in SHOW.
  // Once-guarded: resolution retries re-run _init and must not re-fire it.
  if (S.mode === 'REHEARSE' && !REG.autoRitualScheduled) {
    REG.autoRitualScheduled = true;
    REG.ritualTask = new Task(function () { jailRun('ritual', _ritual); }, this);
    REG.ritualTask.schedule(3000);
  }

  // load race: M4L devices init while Live is still building the set — names
  // can be invisible on the first pass (seen on the rig 2026-06-12: SENTRIM and
  // HELIX Gain params unresolved at load). Retry; red text stays if real.
  REG.initRetries = REG.initRetries || 0;
  if (Resolver.getMissing().length > 0 && REG.initRetries < 3) {
    REG.initRetries++;
    REG.retryTask = new Task(function () { jailRun('init-retry', _init); }, this);
    REG.retryTask.schedule(4000);
    dbg('unresolved names — retrying resolution in 4s (attempt ' + REG.initRetries + '/3)');
  }
}

function reportResolution() {
  var miss = Resolver.getMissing();
  uiOut('unresolved', miss.length);
  for (var i = 0; i < miss.length; i++) {
    uiOut('missing', miss[i].kind + ':' + miss[i].name);
    Telemetry.alert('unresolved', miss[i].kind + ': ' + miss[i].name + ' — ' + miss[i].detail);
    dbg('UNRESOLVED ' + miss[i].kind + ': ' + miss[i].name + ' — ' + miss[i].detail);
  }
  if (!miss.length) dbg('all setmap names resolved clean');
}

// ---------------------------------------------------------------------------
// the loop — 10 Hz
// ---------------------------------------------------------------------------
var tickCount = 0;

function tickJail() { jailRun('tick', tick); }

function tick() {
  if (!S.ready) return;
  tickCount++;

  // 0) beat clock fallback — see sync() below (rig 2026-06-12)
  clockFallback();

  // 1) meters
  var mainMeter = parseFloat(S.mainApi.get('output_meter_level'));
  var i, b;
  for (i = 0; i < S.buses.length; i++) {
    b = S.buses[i];
    b.meter = parseFloat(b.track.get('output_meter_level'));
    b.hist[b.histIdx % b.hist.length] = b.meter;
    b.histIdx++;
  }

  // 2) loop census every 2 s
  if (tickCount % 20 === 0) census();

  // 2b) transport reconcile (perf machine 2026-06-12): the live_set is_playing
  // observer can silently never fire on some machines — FROZEN then sticks and
  // the control law never re-arms. Poll the same READ at 2 Hz and synthesize
  // the missed callback. Same philosophy as the clock trust gate.
  if (tickCount % 5 === 0) {
    var tPlay = Resolver.readIsPlaying() === 1;
    if (S.frozen !== !tPlay) {
      dbg('transport ' + (tPlay ? 'started' : 'stopped') + ' seen via poll — observer missed it');
      onIsPlaying(['is_playing', tPlay ? 1 : 0]);
    }
  }

  // 3) control law (frozen on transport stop — trims hold, nothing moves)
  if (!S.frozen && !JAIL.disabled) controlLaw(mainMeter);

  // 4) capture-sanity watcher every 500 ms
  if (tickCount % 5 === 0) captureSanity();

  // 5) telemetry — SHOW caps this to 4 Hz inside Telemetry
  var meters = { main: round3(mainMeter), ceiling: S.ceiling, buses: {} };
  for (i = 0; i < S.buses.length; i++) {
    b = S.buses[i];
    meters.buses[b.name] = { m: round3(b.meter), trim: round2(b.trimDb), layers: b.layers };
  }
  meters.nightArc = S.nightArcOn ? round2(nightArcBiasDb()) : 0;
  meters.frozen = S.frozen ? 1 : 0;
  Telemetry.emit('meters', meters);
}

function round3(v) { return Math.round(v * 1000) / 1000; }
function round2(v) { return Math.round(v * 100) / 100; }

// Dominance: a bus must be the loudest in (nearly) every sample of the attack
// window before we lay a finger on it. Reaction is deliberate, not jumpy.
function dominantBus() {
  var n = S.buses.length;
  if (!n) return null;
  var len = S.buses[0].attackLen;
  if (S.buses[0].histIdx < len) return null; // not enough history yet
  var wins = [], i, k;
  for (i = 0; i < n; i++) wins.push(0);
  for (k = 1; k <= len; k++) {
    var best = -1, bestV = -1;
    for (i = 0; i < n; i++) {
      var b = S.buses[i];
      var v = b.hist[(b.histIdx - k) % b.hist.length];
      if (v > bestV) { bestV = v; best = i; }
    }
    if (best >= 0) wins[best]++;
  }
  for (i = 0; i < n; i++) {
    if (wins[i] >= len * 0.9) return S.buses[i];
  }
  return null;
}

function controlLaw(mainMeter) {
  var headroomDb = -meterDbRel(mainMeter, S.ceiling); // positive = below ceiling = safe
  var slewPerTick = S.cfg.slew_max_db_per_sec * TICK_MS / 1000;
  var dom = dominantBus();
  var i, b;

  for (i = 0; i < S.buses.length; i++) {
    b = S.buses[i];
    if (!b.trimInfo) continue;

    // census feedforward: layers stacked on this bus widen its knee — expect
    // the creep at 3 layers deep and meet it early instead of reacting late.
    var kneeTop = 3.0 + Math.min(1.5, 0.5 * Math.max(0, b.layers - 1));

    var wantTrim = false, slew = 0;
    if (dom === b) {
      if (headroomDb <= 0) { wantTrim = true; slew = slewPerTick; }      // past ceiling: full slew
      else if (headroomDb < kneeTop) { wantTrim = true; slew = slewPerTick * 0.5; } // soft knee: half slew
    }

    if (wantTrim) {
      var before = b.trimDb;
      b.trimDb = Math.max(b.clampLow, b.trimDb - slew);
      b.comfortTicks = 0;
      if (b.trimDb !== before) {
        writeTrim(b);
        if (b.stableTicks > 10 || before === 0) {
          Telemetry.emit('trim', { bus: b.name, phase: 'engage', trim: round2(b.trimDb),
                                   main: round3(mainMeter), busMeter: round3(b.meter),
                                   headroom: round2(headroomDb), layers: b.layers,
                                   knee: headroomDb > 0 ? 1 : 0 });
        }
        b.stableTicks = 0;
      }
    } else {
      b.stableTicks++;
      // release: comfortable headroom held through the release window →
      // ease trim toward 0 (or the NIGHT ARC bias) at a quarter of max slew.
      var releaseTarget = S.nightArcOn ? nightArcBiasDb() : 0;
      if (headroomDb > 3.0 + S.cfg.deadband_db) b.comfortTicks++;
      else b.comfortTicks = 0;
      if (b.trimDb < releaseTarget - 0.01 &&
          b.comfortTicks >= S.cfg.release_window_sec * 1000 / TICK_MS) {
        var beforeR = b.trimDb;
        b.trimDb = Math.min(releaseTarget, b.trimDb + slewPerTick * 0.25);
        writeTrim(b);
        if (b.trimDb >= releaseTarget - 0.01) {
          Telemetry.emit('trim', { bus: b.name, phase: 'release', trim: round2(b.trimDb),
                                   main: round3(mainMeter), headroom: round2(headroomDb) });
        }
      } else if (b.grabbed && b.stableTicks > 50) {
        grabOff(b); // idle 5 s at target → hand the param back
      }
      // NIGHT ARC is expressed ONLY through this release target (spec law):
      // trims settle at the bias instead of 0. It never actively pulls down.
    }
  }
}

function writeTrim(b) {
  if (S.dryRun) return;
  // SENTRIM is a Utility: Gain param is dB-native. Clamp to setmap law + param range.
  var v = Math.max(b.trimInfo.min, Math.min(b.trimInfo.max, Math.max(b.clampLow, Math.min(0, b.trimDb))));
  grabOn(b);
  outlet(0, [b.slot, 'val', v]);
}

function nightArcBiasDb() {
  var d = new Date();
  var h = d.getHours() + d.getMinutes() / 60;
  if (h >= NIGHT_ARC.startHour && h <= NIGHT_ARC.endHour) {
    return NIGHT_ARC.maxBiasDb * (h - NIGHT_ARC.startHour) / (NIGHT_ARC.endHour - NIGHT_ARC.startHour);
  }
  if (h > NIGHT_ARC.endHour && h < 12) return NIGHT_ARC.maxBiasDb; // deep hours hold
  return 0;
}

// ---------------------------------------------------------------------------
// loop census — which CL lanes are playing, stacked per bus. Free via API.
// ---------------------------------------------------------------------------
function census() {
  var perBus = {};
  for (var i = 0; i < REG.clLanes.length; i++) {
    var lane = REG.clLanes[i];
    var psi = parseInt(lane.track.get('playing_slot_index'), 10);
    if (psi >= 0) perBus[lane.bus] = (perBus[lane.bus] || 0) + 1;
  }
  for (i = 0; i < S.buses.length; i++) {
    S.buses[i].layers = perBus[S.buses[i].name] || 0;
  }
}

// ---------------------------------------------------------------------------
// capture-level sanity — evidence, not control. When a CL clip finishes
// recording, log that bus's meter delta over the next 8 bars vs the 8 before.
// ---------------------------------------------------------------------------
function captureSanity() {
  for (var i = 0; i < REG.clLanes.length; i++) {
    var lane = REG.clLanes[i];
    var psi = parseInt(lane.track.get('playing_slot_index'), 10);
    var rec = false;
    if (psi >= 0) {
      var clip = new LiveAPI(lane.path + ' clip_slots ' + psi + ' clip');
      rec = parseInt(clip.get('is_recording'), 10) === 1;
    }
    if (lane.wasRecording && !rec) {
      var bus = busByName(lane.bus);
      lane.watch = {
        bus: lane.bus,
        before: bus ? busAvgDb(bus, 8) : 0,
        endBeat: S.nowBeats + 8 * S.beatsPerBar
      };
    }
    if (lane.watch && S.nowBeats >= lane.watch.endBeat) {
      var bus2 = busByName(lane.watch.bus);
      var after = bus2 ? busAvgDb(bus2, 8) : 0;
      Telemetry.emit('capture_sanity', {
        lane: lane.name, bus: lane.watch.bus,
        beforeDb: round2(lane.watch.before), afterDb: round2(after),
        deltaDb: round2(after - lane.watch.before)
      });
      lane.watch = null;
    }
    lane.wasRecording = rec;
  }
}

function busByName(name) {
  for (var i = 0; i < S.buses.length; i++) if (S.buses[i].name === name) return S.buses[i];
  return null;
}

// average bus meter over the trailing n bars, in dB relative to 0.85 (≈0 dB)
function busAvgDb(b, bars) {
  var tempo = Resolver.readTempo();
  var secs = bars * S.beatsPerBar * 60 / Math.max(tempo, 20);
  var samples = Math.min(Math.round(secs * 1000 / TICK_MS), b.hist.length, b.histIdx);
  if (samples < 1) return 0;
  var sum = 0;
  for (var k = 1; k <= samples; k++) sum += b.hist[(b.histIdx - k) % b.hist.length];
  return meterDbRel(sum / samples, 0.85);
}

// ---------------------------------------------------------------------------
// sync + heartbeat
// ---------------------------------------------------------------------------
// FALLBACK CLOCK (rig 2026-06-12): the shell's plugsync~ chain produced no sync
// on the rig — heartbeats never fired. The 10 Hz tick polls live_set
// current_song_time (BEATS — a READ; writes to it are refused by the resolver's
// FORBIDDEN_PROPS) whenever real sync messages go quiet; real plugsync~ wins.
var CLOCK = { lastExtSyncMs: 0, extTrusted: false, checkCount: 0 };

function clockFallback() {
  if (nowMs() - CLOCK.lastExtSyncMs < 500) return;
  var b = parseFloat(REG.liveSetClock ? REG.liveSetClock.get('current_song_time') : NaN);
  if (!isNaN(b)) _sync(b);
}

// TRUST GATE — same law as the conductor's (see conductor.js sync()): external
// plugsync~ sync is believed only while it tracks live_set current_song_time.
function sync(beats) {
  var trustedBefore = CLOCK.extTrusted;
  CLOCK.checkCount++;
  if (!CLOCK.extTrusted || CLOCK.checkCount >= 15) {
    CLOCK.checkCount = 0;
    if (REG.liveSetClock) {
      var cst = parseFloat(REG.liveSetClock.get('current_song_time'));
      if (!isNaN(cst)) CLOCK.extTrusted = Math.abs(beats - cst) <= 2;
    }
    if (CLOCK.extTrusted !== trustedBefore) {
      dbg(CLOCK.extTrusted ? 'ext sync trusted — tracks song_time'
        : 'ext sync REJECTED — does not track song_time; fallback clock takes over');
    }
  }
  if (!CLOCK.extTrusted) return;
  CLOCK.lastExtSyncMs = nowMs();
  jailRun('sync', _sync, [beats]);
}

function _sync(beats) {
  S.nowBeats = beats;
  var ib = Math.floor(beats);
  if (ib !== S.lastBeat) {
    S.lastBeat = ib;
    Telemetry.heartbeat(ib, {
      bar: Math.floor(ib / S.beatsPerBar) + 1,
      mode: S.mode, err: JAIL.total,
      disabled: JAIL.disabled ? 1 : 0, frozen: S.frozen ? 1 : 0,
      nightArc: S.nightArcOn ? 1 : 0, dry: S.dryRun ? 1 : 0
    });
  }
}

function onIsPlaying(args) {
  jailRun('transport', function () {
    if (String(args[0]) !== 'is_playing') return;
    var playing = parseInt(args[1], 10) === 1;
    S.frozen = !playing;          // stop: sentinel freezes; start: sentinel resumes
    if (!playing) releaseAllGrabs();
    Telemetry.emit('transport', { playing: playing ? 1 : 0, sub: 'sentinel' });
  });
}

// ---------------------------------------------------------------------------
// RITUAL — one-button pre-show. Fix what the system may set; verify the rest.
// Green board = walk on stage thinking about music.
// ---------------------------------------------------------------------------
function ritual() { jailRun('ritual', _ritual); }

function _ritual() {
  if (!S.ready) { Telemetry.alert('ritual', 'sentinel not initialized'); return; }
  var fixed = [], failed = [], i;

  function fix(label, fn) {
    try { fn(); fixed.push(label); }
    catch (e) { failed.push(label + ' (' + (e.message || e) + ')'); }
  }
  function setDefaultOrValue(paramApi, explicitValue) {
    if (!paramApi) throw new Error('unresolved');
    var v = explicitValue;
    if (v === undefined || v === null) {
      v = parseFloat(paramApi.get('default_value'));
      if (isNaN(v)) throw new Error('no default_value');
    }
    Resolver.set(paramApi, 'value', v);
  }

  // -- FIX half ------------------------------------------------------------
  for (i = 0; i < S.setmap.buses.length; i++) {
    (function (bdef) {
      fix('DJ center: ' + bdef.name, function () {
        var t = Resolver.track(bdef.name);
        var d = Resolver.device(bdef.name, bdef.dj_filter_device, t);
        var p = Resolver.param(d, S.setmap.dj_filter_param.param_name_candidates, bdef.name);
        setDefaultOrValue(p, S.setmap.dj_filter_param.center_detent);
      });
    })(S.setmap.buses[i]);
  }

  fix('crossfader center', function () {
    var cf = Resolver.crossfader();
    var mn = parseFloat(cf.get('min')), mx = parseFloat(cf.get('max'));
    Resolver.set(cf, 'value', (mn + mx) / 2);
  });

  fix('EQ Three unity (6 Melodies)', function () {
    // NOTE: "6 Melodies" is named in the spec's ritual but absent from the
    // setmap (flagged in STATUS.md). Resolved by name; skips cleanly if absent.
    var t = Resolver.track('6 Melodies');
    if (!t) throw new Error('track not found');
    var d = Resolver.device('6 Melodies', 'EQ Three', t);
    var names = ['GainLo', 'GainMid', 'GainHi'];
    for (var k = 0; k < names.length; k++) {
      setDefaultOrValue(Resolver.param(d, names[k], 'EQ Three'));
    }
  });

  for (i = 0; i < S.setmap.loop_lanes.length; i++) {
    (function (lane) {
      fix('CL lane ready: ' + lane.name, function () {
        var t = Resolver.track(lane.name);
        if (!t) throw new Error('track not found');
        var vol = Resolver.trackVolume(t);
        Resolver.set(vol, 'value', 0.85);                  // 0 dB
        Resolver.set(t, 'arm', 1);
        Resolver.set(t, 'current_monitoring_state', 2);    // Off (LOM: 0=In 1=Auto 2=Off)
      });
    })(S.setmap.loop_lanes[i]);
  }

  fix('capture tracks Monitor In', function () {
    // Cptr* audio/midi tracks, *REC FEED groups, and the HELIX CAPTURE IN track
    // all need Monitor = In pre-show. HELIX CAPTURE IN matches neither Cptr nor
    // REC FEED, so it is listed explicitly (confirmed against the gig set).
    var caps = Resolver.tracksMatching('Cptr')
      .concat(Resolver.tracksMatching('REC FEED'))
      .concat(Resolver.tracksMatching('HELIX CAPTURE'));
    if (!caps.length) throw new Error('no Cptr / REC FEED / HELIX CAPTURE tracks found');
    for (var k = 0; k < caps.length; k++) Resolver.set(caps[k], 'current_monitoring_state', 0); // In
  });

  fix('SENTRIM gains to 0', function () {
    for (var k = 0; k < S.buses.length; k++) {
      var b = S.buses[k];
      if (!b.trimInfo) continue;
      b.trimDb = 0;
      grabOff(b);
      Resolver.set(Resolver.byId(b.trimInfo.id), 'value', 0);
    }
  });

  fix('conductor macros to rest', function () {
    var mfx = S.setmap.master_fx;
    var rack = Resolver.device(mfx.track, mfx.rack);
    for (var k = 0; k < mfx.macros.length; k++) {
      var m = mfx.macros[k];
      var p = Resolver.param(rack, m.name, mfx.rack);
      if (!p) throw new Error('macro ' + m.name);
      var mn = parseFloat(p.get('min')), mx = parseFloat(p.get('max'));
      Resolver.set(p, 'value', mn + m.rest * (mx - mn));
    }
  });

  fix('HELIX capture marks', function () {
    // Ritual-time only — these are hands-off during performance. Marks live in
    // setmap.ritual.helix_marks: [{track, device, param, value}]. Absent = flag.
    var marks = (S.setmap.ritual && S.setmap.ritual.helix_marks) || null;
    if (!marks || !marks.length) throw new Error('no setmap.ritual.helix_marks — add calibrated values');
    for (var k = 0; k < marks.length; k++) {
      var mk = marks[k];
      var t = Resolver.track(mk.track);
      var d = Resolver.device(mk.track, mk.device, t);
      var pNames = (mk.param === 'Gain')
        ? (S.cfg.utility_gain_param_candidates || ['Gain', 'Output'])
        : mk.param;
      var p = Resolver.param(d, pNames, mk.track + '/' + mk.device);
      if (!p) throw new Error(mk.track + '/' + mk.device + '/' + mk.param);
      Resolver.set(p, 'value', mk.value);
    }
  });

  // -- VERIFY half (display-only) -------------------------------------------
  var verify = [];
  var miss = Resolver.getMissing();
  verify.push({ name: 'all setmap names resolved', ok: miss.length === 0 ? 1 : 0,
                detail: miss.length ? miss.length + ' unresolved' : 'clean' });

  // scene-tempo audit: flag, never fix (LINK CONTRACT — launching one re-tempos
  // Eduardo's machine; code never touches scenes at all)
  var ls = new LiveAPI('live_set');
  var nScenes = ls.getcount('scenes');
  var baked = [];
  for (i = 0; i < nScenes; i++) {
    var sc = new LiveAPI('live_set scenes ' + i);
    var st = parseFloat(sc.get('tempo'));
    if (st > 0) baked.push((i + 1) + ':' + Math.round(st));
  }
  verify.push({ name: 'scene-tempo audit (flag only)', ok: 1,
                detail: baked.length ? baked.length + ' scenes carry tempo [' + baked.join(' ') + ']' : 'none' });

  var tempo = Resolver.readTempo();
  verify.push({ name: 'tempo at opening value (' + S.setmap.meta.tempo_default + ')',
                ok: Math.abs(tempo - S.setmap.meta.tempo_default) < 0.05 ? 1 : 0,
                detail: 'now ' + Math.round(tempo * 10) / 10 });

  verify.push({ name: 'ALIVE off', fromDash: 'conductor.alive', ok: -1, detail: 'dashboard reads conductor heartbeat' });
  verify.push({ name: 'mode', ok: 1, detail: S.mode });
  verify.push({ name: 'buffer = 128', human: 1, ok: -1, detail: 'not API-readable — check Live prefs' });
  verify.push({ name: 'Link Start Stop Sync = OFF', human: 1, ok: -1, detail: 'not API-readable — check Live prefs' });

  Telemetry.emit('ritual', { fixed: fixed, failed: failed, verify: verify });
  dbg('RITUAL: ' + fixed.length + ' fixed, ' + failed.length + ' failed');
  for (i = 0; i < failed.length; i++) dbg('  RITUAL FAIL: ' + failed[i]);
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------
function mode(m) {
  jailRun('mode', function () {
    m = String(m).toUpperCase();
    if (m !== 'SHOW' && m !== 'REHEARSE') return;
    S.mode = m;
    if (m === 'SHOW' && S.dryRun) { S.dryRun = false; uiOut('dryrun', 0); }
    Telemetry.setMode(m);
    uiOut('mode', m);
    Telemetry.emit('mode', { mode: m, sub: 'sentinel' });
  });
}

function dryrun(v) {
  jailRun('dryrun', function () {
    if (S.mode === 'SHOW') {
      Telemetry.alert('locked', 'dry-run is locked off in SHOW mode');
      uiOut('dryrun', 0);
      return;
    }
    S.dryRun = parseInt(v, 10) === 1;
    if (S.dryRun) releaseAllGrabs();
    uiOut('dryrun', S.dryRun ? 1 : 0);
  });
}

function nightarc(v) {
  jailRun('nightarc', function () {
    S.nightArcOn = parseInt(v, 10) === 1;
    uiOut('nightarc', S.nightArcOn ? 1 : 0);
    Telemetry.emit('nightarc', { on: S.nightArcOn ? 1 : 0, bias: round2(nightArcBiasDb()) });
  });
}

function notifydeleted() {
  if (TASK) TASK.cancel();
  releaseAllGrabs();
}

// ---------------------------------------------------------------------------
// pattr persistence — crash recovery: trims restored at safe last values.
// ---------------------------------------------------------------------------
function getvalueof() {
  var trims = {};
  for (var i = 0; i < S.buses.length; i++) trims[S.buses[i].name] = round2(S.buses[i].trimDb);
  return JSON.stringify({ mode: S.mode, trims: trims });
}

function setvalueof(v) {
  jailRun('setvalueof', function () {
    var st;
    try { st = JSON.parse(String(v)); } catch (e) { return; }
    if (st.mode === 'SHOW' || st.mode === 'REHEARSE') { S.mode = st.mode; Telemetry.setMode(st.mode); uiOut('mode', st.mode); }
    if (st.trims) {
      if (S.ready) applyTrims(st.trims);
      else S.pendingTrims = st.trims; // restore arrives before init — applied there
    }
  });
}

function applyTrims(trims) {
  for (var i = 0; i < S.buses.length; i++) {
    var b = S.buses[i];
    var saved = trims[b.name];
    if (typeof saved === 'number' && b.trimInfo) {
      b.trimDb = Math.max(b.clampLow, Math.min(0, saved));
      Resolver.set(Resolver.byId(b.trimInfo.id), 'value', b.trimDb);
    }
  }
}

// ---------------------------------------------------------------------------
// self-init on (re)compile — autowatch re-compiles on `git pull` but does NOT
// re-fire the shell's init message; without this a hot-reloaded brain is dead
// until re-init. _init is idempotent (guarded observers/tasks, grab release).
// NOTE: recompile resets state to REHEARSE defaults — re-set SHOW after any
// mid-show hot-reload.
// ---------------------------------------------------------------------------
var BOOT_TASK = new Task(function () { jailRun('compile-init', _init); }, this);
BOOT_TASK.schedule(300);
