// moves.js — move + sequence library for CONDUCTOR. Data, not code. ES5.
// Loaded via include("moves.js"). conductor.js owns the engine; this file owns
// the shapes.
//
// A move build returns:
//   { bars: <total move length in bars>,
//     lanes: [ { target, segments, noRestore?, sentry } ],
//     events: [ { atBars, action } ],
//     immediate?: [ actions ]   // CLEAN SLATE only
//   }
//
// Segment: { bars: n, to: spec, curve: 'exp'|'lin' } — bars 0 means snap-on-the-bar.
// Sine segment: { type:'sine', bars: n, depth: normUnits, periodBars: 1 }.
// Value spec: { raw: x }       absolute in the parameter's native units
//             { abs: x }       absolute normalized 0..1 across the param range
//             { rel: dx }      offset from CAPTURED value, normalized units
//             { captured: 1 }  return to the captured value (the restore)
//
// Capture-and-restore is engine law: every lane captures before moving and the
// engine appends nothing — restores are explicit segments here so the shape of
// every move is readable top to bottom in this one file.

// ---------------------------------------------------------------------------
// TUNING — every number a calibration pass might touch lives here.
// CALIBRATION.md walks each one. Values marked VERIFY are guesses until ears
// confirm them in the room.
// ---------------------------------------------------------------------------
var TUNING = {
  // DJ Filter Soft Clip "DJ Control": raw -1..1, center 0.
  // Setmap polarity: negative = LP closes (VERIFY in calibration, fix here + setmap).
  djLpBreath:   -0.62,   // VERIFY by ear: the "underwater inhale" depth
  djLpFocus:    -0.60,   // FOCUS: non-spotlit buses ease 60% low-passed

  // Master FX macros, normalized 0..1 of the macro range. Rest is 0 per setmap.
  lpfDrift:      0.15,   // HORIZON: 15% closed
  lpfGentle:     0.35,   // TIDE OUT: gentle LPF amount (VERIFY)
  lpfFullClosed: 0.85,   // BLOOM start / audible "closed" (VERIFY audible range)
  hpfNarrow:     0.40,   // SUNRISE/NIGHTFALL narrowed band, HPF side (VERIFY)
  lpfNarrow:     0.55,   // SUNRISE/NIGHTFALL narrowed band, LPF side (VERIFY)
  fadeTideOut:   0.92,   // TIDE OUT: Fade macro near-silence point (VERIFY direction!)

  // Sends, raw 0..1.
  washWet:       0.55,   // WASH target for sends B + C (VERIFY)
  bloomSendRel:  0.10,   // BLOOM: send B "rises slightly"
  horizonSendRel:0.07,   // HORIZON: ~+2 dB-ish swell on send B (send taper, VERIFY)
  sunriseSendRel:0.08,   // SUNRISE: send C rises slightly
  veilWet:       0.80,   // VEIL: send F swells hard
  swellWet:      0.50,   // SWELL <return> generic target
  pulseDepth:    0.04,   // PULSE: felt, not heard. Hard cap; do not raise past 0.08.

  // CL lane + riser levels, raw mixer values (0.85 = 0 dB, 0.0 = -inf).
  clZeroDb:      0.85,
  shepSwell:     0.999,  // RISE: ShephardsTone swell-to (rest 0.949 = -0.45 dB)

  // ALIVE drift (conductor.js): hard bounds, normalized units around baseline.
  aliveBound:    0.015,  // +/-1.5%, setmap-law, do not raise
  aliveMinBars:  2,
  aliveMaxBars:  4,

  // Range sentries: captured value must sit inside these RAW windows or the
  // lane is skipped (someone else owns that param right now).
  sentry: {
    djfilter: [-0.30, 0.30],   // near center detent
    macro:    [0.0, 0.45],     // normalized; macros live near rest between moves
    send:     [0.0, 0.92],
    clvol:    [0.0, 1.0],      // CL faders are conductor-owned; any value is ours
    trackvol: [0.4, 1.0],
    risermacro: [0.0, 0.10]
  }
};

// FX buses = the four that pass through Master FX. Bass + LoDrums bypass it
// and are protected by setmap law (no conductor filtering on LoDrums, HP-only
// in BREATH on Bass — and BREATH leaves Bass untouched entirely).
var FX_BUSES   = ['HiDrumsBus', 'PercBus', 'PadsBus', 'LeadsBus'];
var WASH_BUSES = ['PadsBus', 'LeadsBus', 'PercBus'];
var CL_LANES   = ['CL#1 Perc', 'CL#2 Dr Hi', 'CL#3 BASS', 'CL#4 PAD', 'CL#5 LEAD', 'CL#6 LEAD'];

var FOCUS_ALIASES = {
  'PADS': 'PadsBus', 'LEADS': 'LeadsBus', 'PERC': 'PercBus', 'HIDRUMS': 'HiDrumsBus'
};
var SEND_LETTERS = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5 };

// ---------------------------------------------------------------------------
// helpers for terse lane construction
// ---------------------------------------------------------------------------
function laneSend(bus, letter, segments) {
  return { target: { kind: 'send', bus: bus, send: SEND_LETTERS[letter] },
           segments: segments, sentry: 'send' };
}
function laneDj(bus, segments) {
  return { target: { kind: 'djfilter', bus: bus }, segments: segments, sentry: 'djfilter' };
}
function laneMacro(name, segments) {
  return { target: { kind: 'macro', macro: name }, segments: segments, sentry: 'macro' };
}
function laneClVol(lane, segments, noRestore) {
  return { target: { kind: 'clvol', lane: lane }, segments: segments,
           noRestore: !!noRestore, sentry: 'clvol' };
}
function ramp(bars, to, curve) { return { bars: bars, to: to, curve: curve || 'exp' }; }
function hold(bars)            { return { bars: bars, to: null }; }
function restore(bars, curve)  { return { bars: bars, to: { captured: 1 }, curve: curve || 'exp' }; }
function snap(to)              { return { bars: 0, to: to }; }

// ---------------------------------------------------------------------------
// THE LIBRARY
// ---------------------------------------------------------------------------
var MOVES = {

  // -- originals (setmap definitions, unchanged) ----------------------------

  'WASH': { defaultBars: 16, build: function (n, arg, T) {
    var lanes = [], i;
    for (i = 0; i < WASH_BUSES.length; i++) {
      lanes.push(laneSend(WASH_BUSES[i], 'B', [ramp(n, { raw: T.washWet }), hold(4), restore(n / 2)]));
      lanes.push(laneSend(WASH_BUSES[i], 'C', [ramp(n, { raw: T.washWet }), hold(4), restore(n / 2)]));
    }
    return { bars: n + 4 + n / 2, lanes: lanes, events: [] };
  }},

  'TIDE OUT': { defaultBars: 32, build: function (n, arg, T) {
    // Bass + low drums bypass Master FX = the floor keeps breathing under the tide.
    return { bars: n + 2 + n / 2, lanes: [
      laneMacro('Fade', [ramp(n, { abs: T.fadeTideOut }), hold(2), restore(n / 2)]),
      laneMacro('LPF',  [ramp(n, { abs: T.lpfGentle }),   hold(2), restore(n / 2)])
    ], events: [] };
  }},

  'BREATH': { defaultBars: 8, build: function (n, arg, T) {
    // BassBus untouched. The underwater inhale.
    var lanes = [], i;
    for (i = 0; i < FX_BUSES.length; i++) {
      lanes.push(laneDj(FX_BUSES[i], [ramp(n / 2, { raw: T.djLpBreath }), restore(n / 2)]));
    }
    return { bars: n, lanes: lanes, events: [] };
  }},

  'BLOOM': { defaultBars: 16, build: function (n, arg, T) {
    var lanes = [laneMacro('LPF', [snap({ abs: T.lpfFullClosed }), restore(n)])];
    for (var i = 0; i < WASH_BUSES.length; i++) {
      lanes.push(laneSend(WASH_BUSES[i], 'B',
        [ramp(n * 0.75, { rel: T.bloomSendRel }), restore(n * 0.25)]));
    }
    return { bars: n, lanes: lanes, events: [] };
  }},

  'RISE': { defaultBars: 16, build: function (n, arg, T) {
    return { bars: n + 2, lanes: [
      { target: { kind: 'risermacro' }, sentry: 'risermacro',
        segments: [ramp(n, { abs: 1.0 }), snap({ abs: 0.0 }), hold(2)] },
      { target: { kind: 'trackvol', track: '42-ShephardsTone' }, sentry: 'trackvol',
        segments: [ramp(n, { raw: T.shepSwell }), restore(2)] }
    ], events: [
      { atBars: 0, action: 'fireRiser' },
      { atBars: n, action: 'killRiser' }
    ]};
  }},

  'DISSOLVE': { defaultBars: 16, build: function (n, arg, T) {
    // Loops evaporate, live playing through the same buses stays. Faders come
    // back ONLY via DISSOLVE BACK or CLEAN SLATE (noRestore).
    var lanes = [];
    for (var i = 0; i < CL_LANES.length; i++) {
      lanes.push(laneClVol(CL_LANES[i], [ramp(n, { raw: 0.0 })], true));
    }
    return { bars: n, lanes: lanes, events: [] };
  }},

  'DISSOLVE BACK': { defaultBars: 8, build: function (n, arg, T) {
    var lanes = [];
    for (var i = 0; i < CL_LANES.length; i++) {
      lanes.push(laneClVol(CL_LANES[i], [ramp(n, { raw: T.clZeroDb })], true));
    }
    return { bars: n, lanes: lanes, events: [] };
  }},

  'CLEAN SLATE': { defaultBars: 0, build: function (n, arg, T) {
    // Not a ramp. Executes on the next bar line: stop CL clips, restore CL
    // faders to 0 dB, center DJ filters, zero conductor macros, kill risers,
    // release every grab. The reset button. CLEAN SLATE supersedes everything.
    return { bars: 0, lanes: [], events: [], immediate: [
      'stopAllClLanes', 'clFadersToZeroDb', 'centerDjFilters',
      'macrosToRest', 'killRiser', 'shepToRest', 'releaseAllGrabs'
    ]};
  }},

  // -- v2 additions -----------------------------------------------------------

  'HORIZON': { defaultBars: 64, build: function (n, arg, T) {
    // The long arc. Imperceptibly slow; one full breath over n bars.
    var lanes = [laneMacro('LPF', [ramp(n / 2, { rel: T.lpfDrift }, 'lin'), restore(n / 2, 'lin')])];
    var buses = ['PadsBus', 'LeadsBus'];
    for (var i = 0; i < buses.length; i++) {
      lanes.push(laneSend(buses[i], 'B',
        [ramp(n / 2, { rel: T.horizonSendRel }, 'lin'), restore(n / 2, 'lin')]));
    }
    return { bars: n, lanes: lanes, events: [] };
  }},

  'SUNRISE': { defaultBars: 32, build: function (n, arg, T) {
    // Snap to a veiled band on the bar, then the set wakes up over n bars.
    var lanes = [
      laneMacro('HPF', [snap({ abs: T.hpfNarrow }), restore(n)]),
      laneMacro('LPF', [snap({ abs: T.lpfNarrow }), restore(n)])
    ];
    for (var i = 0; i < WASH_BUSES.length; i++) {
      lanes.push(laneSend(WASH_BUSES[i], 'C',
        [ramp(n * 0.75, { rel: T.sunriseSendRel }), restore(n * 0.25)]));
    }
    return { bars: n, lanes: lanes, events: [] };
  }},

  'NIGHTFALL': { defaultBars: 32, build: function (n, arg, T) {
    // Inverse of SUNRISE: slow narrowing into darkness, HOLDS there (noRestore).
    // Release it with SUNRISE, BLOOM, or CLEAN SLATE. Pairs with TIDE OUT.
    return { bars: n, lanes: [
      { target: { kind: 'macro', macro: 'HPF' }, sentry: 'macro', noRestore: true,
        segments: [ramp(n, { abs: T.hpfNarrow }, 'lin')] },
      { target: { kind: 'macro', macro: 'LPF' }, sentry: 'macro', noRestore: true,
        segments: [ramp(n, { abs: T.lpfNarrow }, 'lin')] }
    ], events: [] };
  }},

  'FOCUS': { defaultBars: 16, needsArg: true, build: function (n, arg, T) {
    // FOCUS PADS 16: every OTHER FX bus eases 60% low-passed, then releases.
    // A spotlight without touching any fader. Never available on bass targets.
    var focusBus = FOCUS_ALIASES[arg];
    if (!focusBus) return { invalid: 'FOCUS target must be one of PADS/LEADS/PERC/HIDRUMS (never bass — setmap law)' };
    var lanes = [];
    for (var i = 0; i < FX_BUSES.length; i++) {
      if (FX_BUSES[i] === focusBus) continue;
      lanes.push(laneDj(FX_BUSES[i],
        [ramp(n * 0.25, { raw: T.djLpFocus }), hold(n * 0.5), restore(n * 0.25)]));
    }
    return { bars: n, lanes: lanes, events: [] };
  }},

  'VEIL': { defaultBars: 8, build: function (n, arg, T) {
    // Send F (Hangup) swells hard on Pads+Leads: a smeared freeze-wash that
    // dissolves naturally on the way back down.
    var lanes = [], buses = ['PadsBus', 'LeadsBus'];
    for (var i = 0; i < buses.length; i++) {
      lanes.push(laneSend(buses[i], 'F', [ramp(n / 2, { raw: T.veilWet }), restore(n / 2)]));
    }
    return { bars: n, lanes: lanes, events: [] };
  }},

  'SWELL': { defaultBars: 16, needsArg: true, build: function (n, arg, T) {
    // SWELL B 16 = Large Hall bloom across Pads/Leads/Perc. Generic single-send gesture.
    if (SEND_LETTERS[arg] === undefined) return { invalid: 'SWELL target must be a return letter A-F' };
    var lanes = [];
    for (var i = 0; i < WASH_BUSES.length; i++) {
      lanes.push(laneSend(WASH_BUSES[i], arg, [ramp(n / 2, { raw: T.swellWet }), restore(n / 2)]));
    }
    return { bars: n, lanes: lanes, events: [] };
  }},

  'PULSE': { defaultBars: 16, build: function (n, arg, T) {
    // Transport-synced sine on send D across Perc+Leads. 1-bar period, depth
    // capped low: this is felt, not heard. Ends at the captured value because
    // sin(2*pi*k) = 0 on whole bars.
    var lanes = [], buses = ['PercBus', 'LeadsBus'];
    for (var i = 0; i < buses.length; i++) {
      lanes.push({ target: { kind: 'send', bus: buses[i], send: SEND_LETTERS['D'] },
                   sentry: 'send',
                   segments: [{ type: 'sine', bars: n, depth: T.pulseDepth, periodBars: 1 }] });
    }
    return { bars: n, lanes: lanes, events: [] };
  }}
};

// ---------------------------------------------------------------------------
// Command parsing — clip name grammar.
//   "WASH 16" / "TIDE OUT 32" / "FOCUS PADS 16" / "SWELL B 16" / "CLEAN SLATE"
//   "SEQ RISE 16 > CLEAN SLATE > BLOOM 16"
// Returns { steps: [ { move, bars, arg } ] } | { invalid: reason } | null (not ours).
// ---------------------------------------------------------------------------
var MOVE_NAMES_BY_LENGTH = (function () {
  var names = [];
  for (var k in MOVES) { if (MOVES.hasOwnProperty(k)) names.push(k); }
  names.sort(function (a, b) { return b.length - a.length; });
  return names;
})();

function parseOneCommand(s) {
  s = s.replace(/^\s+|\s+$/g, '').toUpperCase();
  if (!s) return null;
  var name = null, rest = '';
  for (var i = 0; i < MOVE_NAMES_BY_LENGTH.length; i++) {
    var m = MOVE_NAMES_BY_LENGTH[i];
    if (s === m || s.indexOf(m + ' ') === 0) {
      name = m;
      rest = s.substring(m.length).replace(/^\s+/, '');
      break;
    }
  }
  if (!name) return null; // not a conductor command — ignore quietly
  var def = MOVES[name];
  var bars = def.defaultBars, arg = null;
  var toks = rest.length ? rest.split(/\s+/) : [];
  for (var t = 0; t < toks.length; t++) {
    if (/^\d+$/.test(toks[t])) bars = parseInt(toks[t], 10);
    else arg = toks[t];
  }
  if (def.needsArg && !arg) return { invalid: name + ' needs a target argument' };
  if (bars < 0 || bars > 256) return { invalid: name + ': bars out of sane range (0-256)' };
  return { move: name, bars: bars, arg: arg };
}

function parseCommand(clipName) {
  var s = String(clipName).replace(/^\s+|\s+$/g, '');
  if (/^SEQ\s+/i.test(s)) {
    var parts = s.substring(4).split('>');
    var steps = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parseOneCommand(parts[i]);
      if (!p) return { invalid: 'SEQ step not recognized: "' + parts[i] + '"' };
      if (p.invalid) return p;
      steps.push(p);
    }
    return steps.length ? { steps: steps } : null;
  }
  var one = parseOneCommand(s);
  if (!one) return null;
  if (one.invalid) return one;
  return { steps: [one] };
}
