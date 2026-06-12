// conductor.js — CONDUCTOR v2 brain. ES5 (Max js object). Hot-reloadable.
//
// Shell wiring (docs/SHELL-BUILD.md):
//   inlet 0  : messages — init, sync <beats>, alive 0/1, dryrun 0/1,
//              mode REHEARSE|SHOW, abort, panic-from-freebang
//   outlet 0 : grab pool — [slot 'id' paramId] binds, [slot 'val' f] drives,
//              [slot 'id' 0] releases. Patch routes to 24 live.remote~ objects.
//   outlet 1 : telemetry JSON strings → [s rigbrain-telemetry] → sentinel's node.script
//   outlet 2 : UI status for the shell (red text, counters, badges)
//
// Law (from the spec, enforced here):
//   capture-and-restore · grab only during ramps · hands-off list ·
//   exception jail · range sentries · dry-run · LINK CONTRACT (via Resolver only —
//   this file contains no raw api.set / api.call) · performer's hands always win.

autowatch = 1;
inlets = 1;
outlets = 3;

include("resolver.js");
include("telemetry.js");
include("moves.js");

var SETMAP_FILE = "eduardo-setmap.json";
var NUM_REMOTES = 24;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
var S = {
  ready: false,
  setmap: null,
  mode: 'REHEARSE',
  dryRun: false,
  aliveOn: false,
  beatsPerBar: 4,
  lastBeat: -1,          // last integer beat seen (heartbeat edge)
  nowBeats: 0,           // latest beat position from plugsync~
  isPlaying: false,

  activeMove: null,      // engine state, see startMove()
  seqQueue: [],          // remaining steps of a SEQ
  pendingImmediate: null,// CLEAN SLATE waiting for the next bar line
  commandClipSlot: -1,   // session slot of the clip that issued the current command

  slots: [],             // grab pool: slots[i] = paramId or 0
  alive: { targets: [], suspended: false }
};

var REG = {};            // resolved LOM registry, built in init()

// ---------------------------------------------------------------------------
// exception jail — safeguard #1. Every entry point runs inside jailRun.
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
    S.activeMove = null;
    S.seqQueue = [];
    Telemetry.alert('exception', 'conductor/' + label + ': ' + String(e.message || e));
    uiOut('errors', JAIL.total);
    dbg('EXCEPTION in ' + label + ': ' + (e.message || e));
    if (JAIL.stamps.length >= 3) {
      JAIL.disabled = true;
      Telemetry.emit('subsystem_down', { sub: 'conductor', reason: '3 exceptions in 60s' });
      uiOut('disabled', 1);
      dbg('CONDUCTOR SELF-DISABLED — set keeps playing untouched. Re-save js to revive.');
    }
    return undefined;
  }
}

function dbg(s) { if (S.mode !== 'SHOW') post('[conductor] ' + s + '\n'); }
function uiOut() { var a = ['ui']; for (var i = 0; i < arguments.length; i++) a.push(arguments[i]); outlet(2, a); }

// ---------------------------------------------------------------------------
// grab pool — live.remote~ slots, grab only for the duration of a ramp.
// ---------------------------------------------------------------------------
function slotAcquire(paramId) {
  for (var i = 0; i < NUM_REMOTES; i++) {
    if (!S.slots[i]) {
      S.slots[i] = paramId;
      if (!S.dryRun) outlet(0, [i, 'id', paramId]);
      return i;
    }
  }
  Telemetry.alert('grab_pool', 'out of live.remote~ slots (' + NUM_REMOTES + ')');
  return -1;
}

function slotDrive(slot, v) {
  if (slot < 0) return;
  if (!S.dryRun) outlet(0, [slot, 'val', v]);
}

function slotRelease(slot) {
  if (slot < 0 || !S.slots[slot]) return;
  S.slots[slot] = 0;
  if (!S.dryRun) outlet(0, [slot, 'id', 0]);
}

function releaseAllGrabs() {
  for (var i = 0; i < NUM_REMOTES; i++) {
    if (S.slots[i]) { S.slots[i] = 0; outlet(0, [i, 'id', 0]); }
  }
}

// ---------------------------------------------------------------------------
// init — resolve the whole setmap by name. Red text on anything missing.
// ---------------------------------------------------------------------------
function init() { jailRun('init', _init); }

function _init() {
  Resolver.clearMissing();
  Telemetry.init('conductor', function (s) { outlet(1, s); });
  Telemetry.setMode(S.mode);

  S.setmap = Resolver.loadSetmap(SETMAP_FILE);
  if (!S.setmap) { reportResolution(); return; }

  for (var i = 0; i < NUM_REMOTES; i++) S.slots[i] = 0;
  S.beatsPerBar = Resolver.beatsPerBar();

  REG.liveSet = new LiveAPI('live_set');
  S.isPlaying = Resolver.readIsPlaying() === 1;

  // --- buses: DJ Control + sends -------------------------------------------
  REG.djfilter = {}; REG.send = {}; REG.trackApi = {};
  var buses = S.setmap.buses;
  for (i = 0; i < buses.length; i++) {
    var b = buses[i];
    var t = Resolver.track(b.name);
    if (!t) continue;
    REG.trackApi[b.name] = t;
    if (b.conductor_filter_allowed !== false) {
      var dj = Resolver.device(b.name, b.dj_filter_device, t);
      var djp = Resolver.param(dj, S.setmap.dj_filter_param.param_name_candidates, b.name + ' DJ');
      if (djp) REG.djfilter[b.name] = Resolver.paramInfo(djp);
    }
    REG.send[b.name] = [];
    for (var sx = 0; sx < S.setmap.returns_send_index.length; sx++) {
      var sp = Resolver.trackSend(t, sx);
      REG.send[b.name][sx] = sp ? Resolver.paramInfo(sp) : null;
    }
  }

  // validate the return rack order against the setmap (names are law)
  for (i = 0; i < S.setmap.returns_send_index.length; i++) {
    var r = S.setmap.returns_send_index[i];
    var idx = Resolver.sendIndexByName(r.name);
    if (idx !== -1 && idx !== r.send) {
      Telemetry.alert('setmap_drift', 'return "' + r.name + '" is at index ' + idx + ', setmap says ' + r.send);
    }
  }

  // --- master FX macros ------------------------------------------------------
  REG.macro = {}; REG.macroRest = {};
  var mfx = S.setmap.master_fx;
  var rack = Resolver.device(mfx.track, mfx.rack);
  for (i = 0; i < mfx.macros.length; i++) {
    var m = mfx.macros[i];
    var mp = Resolver.param(rack, m.name, mfx.rack);
    if (mp) { REG.macro[m.name] = Resolver.paramInfo(mp); REG.macroRest[m.name] = m.rest; }
  }

  // --- CL lanes ---------------------------------------------------------------
  REG.clvol = {}; REG.clTrack = {};
  for (i = 0; i < S.setmap.loop_lanes.length; i++) {
    var lane = S.setmap.loop_lanes[i];
    var lt = Resolver.track(lane.name);
    if (!lt) continue;
    REG.clTrack[lane.name] = lt;
    var vp = Resolver.trackVolume(lt);
    if (vp) REG.clvol[lane.name] = Resolver.paramInfo(vp);
  }

  // --- risers --------------------------------------------------------------------
  var wn = S.setmap.risers[0]; // WhiteNoise + KnobRiser macro
  var wt = Resolver.track(wn.name);
  if (wt) {
    REG.riserTrack = wt;
    var krack = Resolver.device(wn.name, wn.instrument_rack, wt);
    var kp = Resolver.param(krack, wn.macro.name, wn.instrument_rack);
    if (kp) REG.risermacro = Resolver.paramInfo(kp);
    REG.riserSlot = firstFilledSlot(wt);
    if (!REG.riserSlot) Telemetry.alert('resolve', 'WhiteNoise: no filled clip slot found');
  }
  var shep = S.setmap.risers[1]; // ShephardsTone — track volume swell
  var st = Resolver.track(shep.name);
  if (st) {
    var svp = Resolver.trackVolume(st);
    if (svp) {
      REG.trackvol = REG.trackvol || {};
      REG.trackvol[shep.name] = Resolver.paramInfo(svp);
    }
  }

  // --- CONDUCTOR command track ------------------------------------------------
  var ct = Resolver.track('CONDUCTOR');
  if (ct) {
    REG.conductorTrack = ct;
    REG.conductorTrackPath = ct.unquotedpath || ct.path.replace(/"/g, '');
    REG.cmdObserver = new LiveAPI(onPlayingSlot, REG.conductorTrackPath);
    REG.cmdObserver.property = 'playing_slot_index';
  }

  // --- transport observer (read-only: we listen, we never speak) ---------------
  REG.playObserver = new LiveAPI(onIsPlaying, 'live_set');
  REG.playObserver.property = 'is_playing';

  // --- ALIVE targets: send B + C on Pads + Leads --------------------------------
  S.alive.targets = [];
  var aliveBuses = ['PadsBus', 'LeadsBus'];
  for (i = 0; i < aliveBuses.length; i++) {
    var sb = ['B', 'C'];
    for (var k = 0; k < sb.length; k++) {
      var info = (REG.send[aliveBuses[i]] || [])[SEND_LETTERS[sb[k]]];
      if (info) S.alive.targets.push({
        info: info, baseline: null, walkTo: null, walkEndBar: 0, lastWritten: null, nextWriteBeat: 0
      });
    }
  }

  S.ready = true;
  reportResolution();
  Telemetry.emit('boot', { sub: 'conductor', missing: Resolver.getMissing().length, mode: S.mode });
}

function firstFilledSlot(trackApi) {
  var path = trackApi.unquotedpath || trackApi.path.replace(/"/g, '');
  var n = trackApi.getcount('clip_slots');
  for (var i = 0; i < n; i++) {
    var cs = new LiveAPI(path + ' clip_slots ' + i);
    if (parseInt(cs.get('has_clip'), 10) === 1) return cs;
  }
  return null;
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
// command intake — clip launches on the CONDUCTOR track are the command surface
// ---------------------------------------------------------------------------
function onPlayingSlot(args) {
  jailRun('command', function () {
    if (String(args[0]) !== 'playing_slot_index') return;
    var slotIdx = parseInt(args[1], 10);
    if (isNaN(slotIdx) || slotIdx < 0 || !S.ready) return;
    var clip = new LiveAPI(REG.conductorTrackPath + ' clip_slots ' + slotIdx + ' clip');
    var name = String(clip.get('name'));
    var parsed = parseCommand(name);
    if (!parsed) return; // unlabeled clip — not ours
    if (parsed.invalid) {
      Telemetry.alert('bad_command', name + ' — ' + parsed.invalid);
      return;
    }
    S.commandClipSlot = slotIdx;
    Telemetry.emit('command', { clip: name, steps: parsed.steps.length });
    // a new clip-launch supersedes whatever is running, cleanly
    supersede();
    S.seqQueue = parsed.steps.slice(0);
    startNextStep();
  });
}

function supersede() {
  if (S.activeMove) {
    // release at current values — no snap-back jumps mid-music
    for (var i = 0; i < S.activeMove.lanes.length; i++) slotRelease(S.activeMove.lanes[i].slot);
    Telemetry.emit('move', { phase: 'superseded', name: S.activeMove.name });
    S.activeMove = null;
  }
  S.seqQueue = [];
  S.pendingImmediate = null;
}

function startNextStep() {
  if (!S.seqQueue.length) { commandDone(); return; }
  var step = S.seqQueue.shift();
  if (step.move === 'CLEAN SLATE') {
    S.pendingImmediate = { atBar: nextBarBeats() };
    Telemetry.emit('move', { phase: 'armed', name: 'CLEAN SLATE', next: seqNextName() });
    return;
  }
  startMove(step);
}

function seqNextName() {
  return S.seqQueue.length ? (S.seqQueue[0].move + ' ' + S.seqQueue[0].bars) : '';
}

function commandDone() {
  // move/sequence complete → stop the command clip so the pad light goes dark
  if (S.commandClipSlot >= 0 && REG.conductorTrackPath) {
    var cs = new LiveAPI(REG.conductorTrackPath + ' clip_slots ' + S.commandClipSlot);
    Resolver.call(cs, 'stop');
    S.commandClipSlot = -1;
  }
  Telemetry.emit('move', { phase: 'idle' });
}

// ---------------------------------------------------------------------------
// move engine
// ---------------------------------------------------------------------------
// Nearest bar line, not next: command clips launch bar-quantized, so the
// observer fires a few ms AFTER the bar. Rounding up would start every move a
// full bar late; rounding to nearest starts it on the bar the clip landed on.
function nextBarBeats() {
  var bpb = S.beatsPerBar;
  return Math.round(S.nowBeats / bpb) * bpb;
}

function resolveTarget(t) {
  if (t.kind === 'djfilter')  return REG.djfilter[t.bus] || null;
  if (t.kind === 'macro')     return REG.macro[t.macro] || null;
  if (t.kind === 'send')      return (REG.send[t.bus] || [])[t.send] || null;
  if (t.kind === 'clvol')     return REG.clvol[t.lane] || null;
  if (t.kind === 'trackvol')  return (REG.trackvol || {})[t.track] || null;
  if (t.kind === 'risermacro') return REG.risermacro || null;
  return null;
}

function targetLabel(t) {
  if (t.kind === 'djfilter') return t.bus + '/DJ';
  if (t.kind === 'macro')    return 'FX/' + t.macro;
  if (t.kind === 'send')     return t.bus + '/snd' + 'ABCDEF'.charAt(t.send);
  if (t.kind === 'clvol')    return t.lane;
  if (t.kind === 'trackvol') return t.track + '/vol';
  if (t.kind === 'risermacro') return 'KnobRiser';
  return '?';
}

// Range sentry — safeguard #3. Outside the window = someone else owns it = skip.
function sentryPass(kind, capturedRaw, info) {
  var w = TUNING.sentry[kind];
  if (!w) return true;
  var v = capturedRaw;
  if (kind === 'macro' || kind === 'risermacro') {
    v = (info.max > info.min) ? (capturedRaw - info.min) / (info.max - info.min) : 0;
  }
  return v >= w[0] && v <= w[1];
}

function specToRaw(spec, captured, info) {
  var span = info.max - info.min;
  var v;
  if (spec.raw !== undefined)      v = spec.raw;
  else if (spec.abs !== undefined) v = info.min + spec.abs * span;
  else if (spec.rel !== undefined) v = captured + spec.rel * span;
  else                             v = captured; // {captured:1}
  return Math.max(info.min, Math.min(info.max, v));
}

function startMove(step) {
  var def = MOVES[step.move];
  var built = def.build(step.bars, step.arg, TUNING);
  if (built.invalid) { Telemetry.alert('bad_command', step.move + ': ' + built.invalid); startNextStep(); return; }

  var startBeat = nextBarBeats();
  var lanes = [], skipped = [];

  for (var i = 0; i < built.lanes.length; i++) {
    var bl = built.lanes[i];
    var info = resolveTarget(bl.target);
    if (!info) { skipped.push(targetLabel(bl.target) + ':unresolved'); continue; }
    var captured = parseFloat(Resolver.byId(info.id).get('value'));
    if (!sentryPass(bl.sentry, captured, info)) {
      skipped.push(targetLabel(bl.target) + ':sentry');
      Telemetry.emit('sentry_skip', { param: targetLabel(bl.target), captured: captured });
      continue;
    }
    // precompute segment endpoints in raw units, chained from the captured value
    var segs = [], from = captured, cum = 0;
    for (var sgi = 0; sgi < bl.segments.length; sgi++) {
      var sg = bl.segments[sgi];
      if (sg.type === 'sine') {
        segs.push({ type: 'sine', startBars: cum, endBars: cum + sg.bars,
                    center: captured, depth: sg.depth * (info.max - info.min),
                    periodBars: sg.periodBars, from: from, to: from });
        cum += sg.bars;
        continue;
      }
      var to = (sg.to === null) ? from : specToRaw(sg.to, captured, info);
      segs.push({ startBars: cum, endBars: cum + sg.bars, from: from, to: to,
                  curve: sg.curve || 'exp' });
      from = to;
      cum += sg.bars;
    }
    var slot = S.dryRun ? -2 : slotAcquire(info.id);
    lanes.push({ info: info, label: targetLabel(bl.target), captured: captured,
                 segs: segs, laneBars: cum, slot: slot, noRestore: !!bl.noRestore, done: false });
  }

  S.activeMove = {
    name: step.move + (step.arg ? ' ' + step.arg : '') + (step.bars ? ' ' + step.bars : ''),
    startBeat: startBeat,
    totalBars: built.bars,
    lanes: lanes,
    events: built.events.slice(0),
    firedEvents: 0
  };
  S.alive.suspended = true;

  Telemetry.emit('move', {
    phase: 'start', name: S.activeMove.name, bars: built.bars,
    touching: laneLabels(lanes), skipped: skipped, next: seqNextName(), dry: S.dryRun ? 1 : 0
  });
  dbg('MOVE ' + S.activeMove.name + ' @ beat ' + startBeat + (S.dryRun ? ' [DRY-RUN]' : ''));
}

function laneLabels(lanes) {
  var out = [];
  for (var i = 0; i < lanes.length; i++) out.push(lanes[i].label);
  return out;
}

function ease(p, curve) {
  if (curve === 'lin') return p;
  // ambient law: slow start, slow end. No linear zipper ramps on filters.
  return 0.5 - 0.5 * Math.cos(Math.PI * p);
}

function laneValueAt(lane, bars) {
  var segs = lane.segs;
  if (!segs.length) return lane.captured;
  if (bars >= lane.laneBars) return segs[segs.length - 1].to;
  for (var i = 0; i < segs.length; i++) {
    var sg = segs[i];
    if (bars <= sg.endBars || i === segs.length - 1) {
      if (sg.type === 'sine') {
        var local = bars - sg.startBars;
        return sg.center + sg.depth * Math.sin(2 * Math.PI * local / sg.periodBars);
      }
      var len = sg.endBars - sg.startBars;
      if (len <= 0) return sg.to; // snap
      var p = Math.max(0, Math.min(1, (bars - sg.startBars) / len));
      return sg.from + (sg.to - sg.from) * ease(p, sg.curve);
    }
  }
  return segs[segs.length - 1].to;
}

// sync <beats> — the engine clock, ~30 Hz from plugsync~ via snapshot~.
// Bar timing derives from beat position continuously: a Link tempo jump mid-move
// bends the ramp (beats stretch), never breaks it. (Safeguard #4.)
function sync(beats) { jailRun('sync', _sync, [beats]); }

function _sync(beats) {
  S.nowBeats = beats;
  if (!S.ready) return;

  var ib = Math.floor(beats);
  if (ib !== S.lastBeat) {
    S.lastBeat = ib;
    Telemetry.heartbeat(ib, {
      bar: Math.floor(ib / S.beatsPerBar) + 1,
      tempo: Math.round(Resolver.readTempo() * 10) / 10,
      mode: S.mode, alive: S.aliveOn ? 1 : 0,
      err: JAIL.total, disabled: JAIL.disabled ? 1 : 0, dry: S.dryRun ? 1 : 0
    });
  }

  if (S.pendingImmediate && beats >= S.pendingImmediate.atBar - 1e-6) {
    S.pendingImmediate = null;
    runCleanSlate();
    startNextStep();
    return;
  }

  var mv = S.activeMove;
  if (mv) {
    var bars = (beats - mv.startBeat) / S.beatsPerBar;
    if (bars < 0) return; // armed, waiting for the bar line

    while (mv.firedEvents < mv.events.length && bars >= mv.events[mv.firedEvents].atBars) {
      runEvent(mv.events[mv.firedEvents].action);
      mv.firedEvents++;
    }

    var allDone = bars >= mv.totalBars;
    for (var i = 0; i < mv.lanes.length; i++) {
      var lane = mv.lanes[i];
      if (lane.done) continue;
      var v = laneValueAt(lane, bars);
      if (bars >= lane.laneBars) {
        slotDrive(lane.slot, v);   // land exactly on the endpoint
        slotRelease(lane.slot);    // grab only during ramps — release immediately
        lane.done = true;
      } else {
        slotDrive(lane.slot, v);
      }
    }

    Telemetry.emit('ramp', { name: mv.name, bars: Math.floor(bars), of: mv.totalBars });

    if (allDone) {
      S.activeMove = null;
      S.alive.suspended = false;
      Telemetry.emit('move', { phase: 'end', name: mv.name, next: seqNextName() });
      startNextStep();
    }
    return;
  }

  aliveTick(beats);
}

function runEvent(action) {
  if (action === 'fireRiser' && REG.riserSlot && !S.dryRun) Resolver.call(REG.riserSlot, 'fire');
  if (action === 'killRiser' && REG.riserSlot && !S.dryRun) Resolver.call(REG.riserSlot, 'stop');
  Telemetry.emit('event', { action: action, dry: S.dryRun ? 1 : 0 });
}

// ---------------------------------------------------------------------------
// CLEAN SLATE — the reset button. Executes on the bar line. Supersedes all.
// Direct API sets (no grabs): these are snaps to known-safe rest values on
// conductor-owned parameters only.
// ---------------------------------------------------------------------------
function runCleanSlate() {
  releaseAllGrabs();
  S.activeMove = null;
  if (S.dryRun) { Telemetry.emit('move', { phase: 'cleanslate', dry: 1 }); return; }

  var name, i;
  for (name in REG.clTrack) {
    if (REG.clTrack.hasOwnProperty(name)) Resolver.call(REG.clTrack[name], 'stop_all_clips');
  }
  for (name in REG.clvol) {
    if (REG.clvol.hasOwnProperty(name)) setParamRaw(REG.clvol[name], TUNING.clZeroDb);
  }
  for (name in REG.djfilter) {
    if (REG.djfilter.hasOwnProperty(name)) setParamRaw(REG.djfilter[name], 0.0); // center detent
  }
  for (name in REG.macro) {
    if (REG.macro.hasOwnProperty(name)) {
      var info = REG.macro[name];
      setParamRaw(info, info.min + REG.macroRest[name] * (info.max - info.min));
    }
  }
  if (REG.riserSlot) Resolver.call(REG.riserSlot, 'stop');
  if (REG.risermacro) setParamRaw(REG.risermacro, REG.risermacro.min);
  if (REG.trackvol && REG.trackvol['42-ShephardsTone']) {
    setParamRaw(REG.trackvol['42-ShephardsTone'], 0.949); // setmap rest: -0.45 dB
  }
  Telemetry.emit('move', { phase: 'cleanslate' });
  dbg('CLEAN SLATE executed');
}

function setParamRaw(info, v) {
  var api = Resolver.byId(info.id);
  Resolver.set(api, 'value', Math.max(info.min, Math.min(info.max, v)));
}

// ---------------------------------------------------------------------------
// ALIVE mode — background micro-drift. Boring is correct. Default OFF.
// Uses gentle API sets (max one write per beat per target), never grabs, so the
// performer's hands always win — and a hand detected on a param re-baselines it.
// ---------------------------------------------------------------------------
function aliveTick(beats) {
  if (!S.aliveOn || S.alive.suspended || !S.isPlaying || S.dryRun) return;
  var bpb = S.beatsPerBar;
  var bar = beats / bpb;
  for (var i = 0; i < S.alive.targets.length; i++) {
    var t = S.alive.targets[i];
    if (beats < t.nextWriteBeat) continue;
    t.nextWriteBeat = Math.floor(beats) + 1;

    var api = Resolver.byId(t.info.id);
    var cur = parseFloat(api.get('value'));
    if (t.baseline === null) { t.baseline = cur; t.lastWritten = cur; }

    // hands win: if the value moved without us, re-baseline and stand down a walk
    if (Math.abs(cur - t.lastWritten) > 0.012) {
      t.baseline = cur; t.lastWritten = cur; t.walkTo = null;
      continue;
    }
    var span = t.info.max - t.info.min;
    var bound = TUNING.aliveBound * span; // hard-bounded, setmap law
    if (t.walkTo === null || bar >= t.walkEndBar) {
      t.walkTo = t.baseline + (Math.random() * 2 - 1) * bound;
      t.walkTo = Math.max(t.info.min, Math.min(t.info.max, t.walkTo));
      t.walkEndBar = bar + TUNING.aliveMinBars + Math.random() * (TUNING.aliveMaxBars - TUNING.aliveMinBars);
    }
    var next = cur + (t.walkTo - cur) * 0.12; // slow exponential approach
    next = Math.max(t.baseline - bound, Math.min(t.baseline + bound, next));
    Resolver.set(api, 'value', next);
    t.lastWritten = next;
  }
}

// ---------------------------------------------------------------------------
// transport — we listen, we never speak. (Safeguard #5 + Link contract.)
// ---------------------------------------------------------------------------
function onIsPlaying(args) {
  jailRun('transport', function () {
    if (String(args[0]) !== 'is_playing') return;
    var playing = parseInt(args[1], 10) === 1;
    if (S.isPlaying && !playing) {
      // stop: all grabs release, ALIVE suspends, moves cleared (never auto-resume)
      releaseAllGrabs();
      S.activeMove = null;
      S.seqQueue = [];
      S.pendingImmediate = null;
      Telemetry.emit('transport', { playing: 0 });
    } else if (!S.isPlaying && playing) {
      Telemetry.emit('transport', { playing: 1 });
    }
    S.isPlaying = playing;
  });
}

// ---------------------------------------------------------------------------
// controls from the shell
// ---------------------------------------------------------------------------
function alive(v) {
  jailRun('alive', function () {
    S.aliveOn = parseInt(v, 10) === 1;
    if (!S.aliveOn) {
      for (var i = 0; i < S.alive.targets.length; i++) {
        S.alive.targets[i].baseline = null; S.alive.targets[i].walkTo = null;
      }
    }
    uiOut('alive', S.aliveOn ? 1 : 0);
    Telemetry.emit('alive', { on: S.aliveOn ? 1 : 0 });
  });
}

function dryrun(v) {
  jailRun('dryrun', function () {
    if (S.mode === 'SHOW') { // SHOW locks dry-run off (safeguard #6)
      Telemetry.alert('locked', 'dry-run is locked off in SHOW mode');
      uiOut('dryrun', 0);
      return;
    }
    S.dryRun = parseInt(v, 10) === 1;
    if (S.dryRun) releaseAllGrabs();
    uiOut('dryrun', S.dryRun ? 1 : 0);
    Telemetry.emit('dryrun', { on: S.dryRun ? 1 : 0 });
  });
}

function mode(m) {
  jailRun('mode', function () {
    m = String(m).toUpperCase();
    if (m !== 'SHOW' && m !== 'REHEARSE') return;
    S.mode = m;
    if (m === 'SHOW' && S.dryRun) { S.dryRun = false; uiOut('dryrun', 0); }
    Telemetry.setMode(m);
    uiOut('mode', m);
    Telemetry.emit('mode', { mode: m });
  });
}

// ABORT button — kill-order layer 2. Immediate clean slate, no bar wait.
function abort() {
  jailRun('abort', function () {
    S.seqQueue = [];
    S.pendingImmediate = null;
    supersede();
    runCleanSlate();
    Telemetry.emit('abort', {});
  });
}

// kill-order layer 3: deleting the device — freebang in the shell also clears
// the live.remote~ ids, this is belt-and-suspenders.
function notifydeleted() {
  releaseAllGrabs();
}

// ---------------------------------------------------------------------------
// pattr persistence — safeguard #8. After a crash+reopen: mode restored,
// every move cleared, ALIVE forced off (it must be boring to be correct).
// ---------------------------------------------------------------------------
function getvalueof() {
  return JSON.stringify({ mode: S.mode });
}

function setvalueof(v) {
  jailRun('setvalueof', function () {
    try {
      var st = JSON.parse(String(v));
      if (st.mode === 'SHOW' || st.mode === 'REHEARSE') { S.mode = st.mode; Telemetry.setMode(st.mode); uiOut('mode', st.mode); }
    } catch (e) {}
    S.aliveOn = false;
    uiOut('alive', 0);
  });
}
