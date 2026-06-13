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
  // DJ Filter Soft Clip "Control": raw 0..1, CENTER = 0.5. RIG-VERIFIED
  // 2026-06-12: display% = (raw - 0.5) * 200, so raw 0.0 == -100% == LP
  // slammed shut (exactly what the old -1..1 model did via RITUAL and CLEAN
  // SLATE). LP territory is BELOW 0.5, HP above.
  djLpBreath:    0.19,   // display -62%. VERIFY by ear: the "underwater inhale" depth
  djLpFocus:     0.20,   // display -60%. FOCUS: non-spotlit buses ease low-passed

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

  // I CHING (off by default; ICHING command only). Bounded, gentle, reversible —
  // a cast reading colors the space, it does not take it over. Caps kept small so
  // a "sour" reading is never more than a wash you can ABORT.
  ichingWet:     0.12,   // per yang line: bounded send swell above captured. Hard cap.
  ichingShimmer: 0.03,   // changing line: sine depth on send D. Felt, not heard.

  // CL lane + riser levels, raw mixer values (0.85 = 0 dB, 0.0 = -inf).
  clZeroDb:      0.85,
  shepSwellAbs:  1.0,    // RISE: ShephardsTone rack macro "Output" swell-to,
                         // normalized 0..1 of the macro range (VERIFY by ear).
                         // Rig directive 2026-06-12: drive the Output macro,
                         // NOT the Ableton track volume.

  // ALIVE drift (conductor.js): hard bounds, normalized units around baseline.
  aliveBound:    0.015,  // +/-1.5%, setmap-law, do not raise
  aliveMinBars:  2,
  aliveMaxBars:  4,

  // Range sentries: captured value must sit inside these RAW windows or the
  // lane is skipped (someone else owns that param right now).
  sentry: {
    djfilter: [0.35, 0.65],    // raw 0..1 domain: within +/-30% display of the 0.5 center
    macro:    [0.0, 0.45],     // normalized; macros live near rest between moves
    send:     [0.0, 0.92],
    clvol:    [0.0, 1.0],      // CL faders are conductor-owned; any value is ours
    trackvol: [0.4, 1.0],
    risermacro: [0.0, 0.10],
    shepmacro:  [0.0, 1.0]     // Output macro rest is wherever hands left it — always ours during RISE
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
// I CHING — a cast hexagram, for display + a bounded gesture. Pure data + math;
// no Live access here. The ICHING move turns a cast into normal send lanes, so
// every safety property (grabs, sentries, capture/restore, ABORT/CLEAN SLATE)
// is inherited. This module just casts and names.
// ---------------------------------------------------------------------------
var ICHING = (function () {
  // Trigram value = bottom + mid*2 + top*4 (bottom line is the low bit).
  var TRI = { HEAVEN: 7, LAKE: 3, FIRE: 5, THUNDER: 1, WIND: 6, WATER: 2, MOUNTAIN: 4, EARTH: 0 };
  var TRI_BY_VAL = {}, TRI_GLYPH = {
    HEAVEN: '☰', LAKE: '☱', FIRE: '☲', THUNDER: '☳',
    WIND: '☴', WATER: '☵', MOUNTAIN: '☶', EARTH: '☷'
  };
  for (var tn in TRI) { if (TRI.hasOwnProperty(tn)) TRI_BY_VAL[TRI[tn]] = tn; }

  // King Wen number by [upper trigram][lower trigram]. Verified hexagram-by-
  // hexagram against the standard sequence (anchors: Heaven/Heaven=1, Earth/
  // Earth=2, Earth-over-Heaven=11 Tai, Heaven-over-Earth=12 Pi).
  var KW = {
    HEAVEN:   { HEAVEN: 1, LAKE: 10, FIRE: 13, THUNDER: 25, WIND: 44, WATER: 6,  MOUNTAIN: 33, EARTH: 12 },
    LAKE:     { HEAVEN: 43, LAKE: 58, FIRE: 49, THUNDER: 17, WIND: 28, WATER: 47, MOUNTAIN: 31, EARTH: 45 },
    FIRE:     { HEAVEN: 14, LAKE: 38, FIRE: 30, THUNDER: 21, WIND: 50, WATER: 64, MOUNTAIN: 56, EARTH: 35 },
    THUNDER:  { HEAVEN: 34, LAKE: 54, FIRE: 55, THUNDER: 51, WIND: 32, WATER: 40, MOUNTAIN: 62, EARTH: 16 },
    WIND:     { HEAVEN: 9,  LAKE: 61, FIRE: 37, THUNDER: 42, WIND: 57, WATER: 59, MOUNTAIN: 53, EARTH: 20 },
    WATER:    { HEAVEN: 5,  LAKE: 60, FIRE: 63, THUNDER: 3,  WIND: 48, WATER: 29, MOUNTAIN: 39, EARTH: 8 },
    MOUNTAIN: { HEAVEN: 26, LAKE: 41, FIRE: 22, THUNDER: 27, WIND: 18, WATER: 4,  MOUNTAIN: 52, EARTH: 23 },
    EARTH:    { HEAVEN: 11, LAKE: 19, FIRE: 36, THUNDER: 24, WIND: 46, WATER: 7,  MOUNTAIN: 15, EARTH: 2 }
  };

  var NAMES = [ '',
    'The Creative', 'The Receptive', 'Difficulty at the Beginning', 'Youthful Folly',
    'Waiting', 'Conflict', 'The Army', 'Holding Together', 'Small Taming', 'Treading',
    'Peace', 'Standstill', 'Fellowship', 'Great Possession', 'Modesty', 'Enthusiasm',
    'Following', 'Work on the Decayed', 'Approach', 'Contemplation', 'Biting Through',
    'Grace', 'Splitting Apart', 'Return', 'Innocence', 'Great Taming', 'Nourishment',
    'Great Exceeding', 'The Abysmal Water', 'The Clinging Fire', 'Influence', 'Duration',
    'Retreat', 'Great Power', 'Progress', 'Darkening of the Light', 'The Family',
    'Opposition', 'Obstruction', 'Deliverance', 'Decrease', 'Increase', 'Breakthrough',
    'Coming to Meet', 'Gathering Together', 'Pushing Upward', 'Oppression', 'The Well',
    'Revolution', 'The Cauldron', 'The Arousing', 'Keeping Still', 'Development',
    'The Marrying Maiden', 'Abundance', 'The Wanderer', 'The Gentle', 'The Joyous',
    'Dispersion', 'Limitation', 'Inner Truth', 'Small Exceeding', 'After Completion',
    'Before Completion' ];

  // Three-coin cast: heads=3 tails=2, sum 6..9.
  //   6 = old yin (changing -> yang), 7 = young yang, 8 = young yin, 9 = old yang (changing -> yin)
  function castLine() {
    var s = 0;
    for (var c = 0; c < 3; c++) s += (Math.random() < 0.5 ? 2 : 3);
    return { yang: (s === 7 || s === 9), changing: (s === 6 || s === 9), sum: s };
  }

  // lines bottom-to-top. yangFlags: array of 6 booleans (use future state if relating).
  function hexNumber(yangFlags) {
    var lowV = (yangFlags[0] ? 1 : 0) + (yangFlags[1] ? 2 : 0) + (yangFlags[2] ? 4 : 0);
    var upV  = (yangFlags[3] ? 1 : 0) + (yangFlags[4] ? 2 : 0) + (yangFlags[5] ? 4 : 0);
    var up = TRI_BY_VAL[upV], lo = TRI_BY_VAL[lowV];
    return { n: KW[up][lo], upper: up, lower: lo,
             upperGlyph: TRI_GLYPH[up], lowerGlyph: TRI_GLYPH[lo] };
  }

  function descof(h) { return { n: h.n, name: NAMES[h.n] || '', upper: h.upper, lower: h.lower,
                                upperGlyph: h.upperGlyph, lowerGlyph: h.lowerGlyph }; }

  // Cast a full reading: present hexagram, the changing lines, and the relating
  // hexagram (present with all changing lines flipped). Returns a flat, drawable
  // payload for telemetry.
  function cast() {
    var lines = [], present = [], anyChange = false, future = [];
    for (var i = 0; i < 6; i++) {
      var ln = castLine();
      lines.push({ yang: ln.yang, changing: ln.changing });
      present.push(ln.yang);
      future.push(ln.changing ? !ln.yang : ln.yang);
      if (ln.changing) anyChange = true;
    }
    var p = descof(hexNumber(present));
    var payload = {
      lines: lines,                 // bottom-to-top: {yang, changing}
      present: p,
      relating: anyChange ? descof(hexNumber(future)) : null
    };
    return payload;
  }

  return { cast: cast, hexNumber: hexNumber, NAMES: NAMES, TRI: TRI };
})();

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
    // WhiteNoise riser clip + KnobRiser macro, AND ShephardsTone: fire one of
    // its letter clips and swell the rack's "Output" macro (NOT track volume —
    // rig directive 2026-06-12), duck back over the last 2 bars, stop the clip.
    return { bars: n + 2, lanes: [
      { target: { kind: 'risermacro' }, sentry: 'risermacro',
        segments: [ramp(n, { abs: 1.0 }), snap({ abs: 0.0 }), hold(2)] },
      { target: { kind: 'shepmacro' }, sentry: 'shepmacro',
        segments: [ramp(n, { abs: T.shepSwellAbs }), restore(2)] }
    ], events: [
      { atBars: 0, action: 'fireRiser' },
      { atBars: 0, action: 'fireShep' },
      { atBars: n, action: 'killRiser' },
      { atBars: n + 2, action: 'killShep' } // stop AFTER the 2-bar duck, not at peak swell
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
  }},

  // -- I CHING (off by default; create a clip named "ICHING" to use it) -------
  'ICHING': { defaultBars: 24, build: function (n, arg, T) {
    // Cast a hexagram and let it gently color the space. The six lines map to
    // three WASH buses x two sends (lower trigram -> send B, upper -> send C):
    // a YANG line swells that send a small, bounded amount; a YIN line is
    // stillness (left where the hands had it); a CHANGING line adds one slow,
    // barely-there sine shimmer on send D of that bus. Everything is captured
    // and restored, bounded by tiny caps, and ABORT/CLEAN SLATE end it at once.
    var reading = ICHING.cast();
    var half = n / 2;
    var lanes = [];
    for (var b = 0; b < WASH_BUSES.length; b++) {
      var bus = WASH_BUSES[b];
      var lower = reading.lines[b];       // bottom trigram line -> send B
      var upper = reading.lines[b + 3];   // top trigram line    -> send C
      if (lower.yang) lanes.push(laneSend(bus, 'B', [ramp(half, { rel: T.ichingWet }), restore(n - half)]));
      if (upper.yang) lanes.push(laneSend(bus, 'C', [ramp(half, { rel: T.ichingWet }), restore(n - half)]));
      if (lower.changing || upper.changing) {
        lanes.push({ target: { kind: 'send', bus: bus, send: SEND_LETTERS['D'] }, sentry: 'send',
                     segments: [{ type: 'sine', bars: n, depth: T.ichingShimmer, periodBars: 2 }] });
      }
    }
    // even an all-yin reading is valid (pure stillness) — no lanes, just the
    // hexagram on the dashboard for n bars.
    return { bars: n, lanes: lanes, events: [], iching: reading };
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
