// move_gallery.mjs — headless Move Gallery for CONDUCTOR.
//
// Loads the REAL conductor/moves.js, reproduces the conductor.js ramp engine
// exactly (ease / specToRaw / laneValueAt — copied verbatim, attributed below),
// simulates every shipped command + sequence, renders each as an SVG curve
// picture, and flags discontinuities / zipper risks. Design-by-looking: see a
// move before it ever touches the set.
//
//   node tools/move_gallery.mjs [--out gallery] [--tempo 94]
//
// Outputs:
//   <out>/<MOVE>.svg          one panel per move/sequence (lanes overlaid)
//   <out>/index.html          contact sheet of every panel
//   <out>/discontinuities.jsonl   machine-readable flags
//
// Headless and read-only — no Max, no Live, no network. Pure math + text.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ---- args ----
const args = process.argv.slice(2);
function arg(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const OUT = path.resolve(REPO, arg('--out', 'gallery'));
const TEMPO = parseFloat(arg('--tempo', '94'));      // BPM, for rate (zipper) math
const SEC_PER_BAR = (4 * 60) / TEMPO;                // 4/4

// ---- the shipped command clips (mirror of prep-set.py CLIP_NAMES) ----
const COMMANDS = [
  'WASH 16', 'TIDE OUT 32', 'BREATH 8', 'BLOOM 16', 'RISE 16',
  'DISSOLVE 16', 'DISSOLVE BACK 8',
  'HORIZON 64', 'SUNRISE 32', 'NIGHTFALL 32', 'FOCUS PADS 16',
  'VEIL 8', 'SWELL B 16', 'PULSE 16',
  'SEQ RISE 16 > CLEAN SLATE > BLOOM 16',
  'SEQ NIGHTFALL 32 > HORIZON 64',
  'SEQ DISSOLVE 16 > BREATH 8 > DISSOLVE BACK 8',
  'SEQ WASH 16 > TIDE OUT 32',
];

// Representative captured baseline + native range per sentry kind. These are the
// values the engine would capture at rest; the curve shape is what matters, and
// each panel prints the baseline it assumed.
const BASELINE = {
  send:       { min: 0, max: 1, captured: 0.10 },
  djfilter:   { min: 0, max: 1, captured: 0.50 },
  macro:      { min: 0, max: 1, captured: 0.00 },
  clvol:      { min: 0, max: 1, captured: 0.85 },
  risermacro: { min: 0, max: 1, captured: 0.00 },
  shepmacro:  { min: 0, max: 1, captured: 0.00 },
};

// zipper threshold: peak ramp speed in normalized units / second above which a
// non-snap move could step audibly. Snaps (0-bar) are reported separately.
const ZIPPER_NORM_PER_SEC = 0.6;

// ===========================================================================
// load moves.js into a sandbox -> MOVES, TUNING, parseCommand, ...
// ===========================================================================
function loadMoves() {
  const src = fs.readFileSync(path.join(REPO, 'conductor', 'moves.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'moves.js' });
  return sandbox;
}
const M = loadMoves();

// ===========================================================================
// engine math — VERBATIM from conductor.js (keep in sync). The gallery must
// draw exactly what the device will drive.
// ===========================================================================
function ease(p, curve) {
  if (curve === 'lin') return p;
  return 0.5 - 0.5 * Math.cos(Math.PI * p);                 // conductor.js:584
}
function specToRaw(spec, captured, info) {                  // conductor.js:466
  const span = info.max - info.min;
  let v;
  if (spec.raw !== undefined) v = spec.raw;
  else if (spec.abs !== undefined) v = info.min + spec.abs * span;
  else if (spec.rel !== undefined) v = captured + spec.rel * span;
  else v = captured;
  return Math.max(info.min, Math.min(info.max, v));
}
// precompute segment endpoints chained from captured (conductor.js:494-510)
function buildSegs(segments, captured, info) {
  const segs = [];
  let from = captured, cum = 0;
  for (const sg of segments) {
    if (sg.type === 'sine') {
      segs.push({ type: 'sine', startBars: cum, endBars: cum + sg.bars,
        center: captured, depth: sg.depth * (info.max - info.min),
        periodBars: sg.periodBars, from, to: from });
      cum += sg.bars; continue;
    }
    const to = (sg.to === null) ? from : specToRaw(sg.to, captured, info);
    segs.push({ startBars: cum, endBars: cum + sg.bars, from, to,
      curve: sg.curve || 'exp' });
    from = to; cum += sg.bars;
  }
  return { segs, laneBars: cum };
}
function laneValueAt(segs, laneBars, captured, bars) {       // conductor.js:590
  if (!segs.length) return captured;
  if (bars >= laneBars) return segs[segs.length - 1].to;
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i];
    if (bars <= sg.endBars || i === segs.length - 1) {
      if (sg.type === 'sine') {
        const local = bars - sg.startBars;
        return sg.center + sg.depth * Math.sin(2 * Math.PI * local / sg.periodBars);
      }
      const len = sg.endBars - sg.startBars;
      if (len <= 0) return sg.to;
      const p = Math.max(0, Math.min(1, (bars - sg.startBars) / len));
      return sg.from + (sg.to - sg.from) * ease(p, sg.curve);
    }
  }
  return segs[segs.length - 1].to;
}

// ===========================================================================
// build a timeline (move or sequence) -> { name, totalBars, lanes, events }
// each lane: { label, info, captured, segs, laneBars, startBars, sentry, noRestore }
// ===========================================================================
function labelOf(target) {
  if (target.kind === 'send') return target.bus + ' send ' + 'ABCDEF'[target.send];
  if (target.kind === 'djfilter') return target.bus + ' DJ';
  if (target.kind === 'macro') return 'macro ' + target.macro;
  if (target.kind === 'clvol') return target.lane;
  if (target.kind === 'risermacro') return 'KnobRiser';
  if (target.kind === 'shepmacro') return 'Shep Output';
  return target.kind;
}
function buildMoveTimeline(move, bars, argv) {
  const def = M.MOVES[move];
  const built = def.build(bars || def.defaultBars, argv, M.TUNING);
  if (built.invalid) return { invalid: built.invalid };
  const lanes = [];
  for (const bl of (built.lanes || [])) {
    const base = BASELINE[bl.sentry] || BASELINE.macro;
    const info = { min: base.min, max: base.max };
    const { segs, laneBars } = buildSegs(bl.segments, base.captured, info);
    lanes.push({ label: labelOf(bl.target), info, captured: base.captured,
      segs, laneBars, startBars: 0, sentry: bl.sentry, noRestore: !!bl.noRestore });
  }
  const events = (built.events || []).map(e => ({ at: e.atBars, a: e.action }));
  // CLEAN SLATE / immediate-only moves have no ramp lanes
  return { totalBars: built.bars, lanes, events, immediate: built.immediate || null };
}
function buildTimeline(command) {
  const parsed = M.parseCommand(command);
  if (!parsed) return { invalid: 'not a command' };
  if (parsed.invalid) return { invalid: parsed.invalid };
  const lanes = [], events = [];
  let offset = 0, immediate = null;
  for (const step of parsed.steps) {
    const tl = buildMoveTimeline(step.move, step.bars, step.arg);
    if (tl.invalid) return { invalid: step.move + ': ' + tl.invalid };
    if (tl.immediate) immediate = (immediate || []).concat(tl.immediate);
    for (const ln of tl.lanes) { ln.startBars += offset; lanes.push(ln); }
    for (const ev of tl.events) events.push({ at: ev.at + offset, a: ev.a });
    if (parsed.steps.length > 1 && offset > 0)
      events.push({ at: offset, a: '|step', boundary: true });
    offset += Math.max(tl.totalBars, 0.0001);
  }
  return { totalBars: offset, lanes, events, immediate };
}

// ===========================================================================
// discontinuity / zipper analysis
// ===========================================================================
function analyzeLane(ln) {
  const flags = [];
  const span = ln.info.max - ln.info.min || 1;
  for (const sg of ln.segs) {
    if (sg.type === 'sine') continue;
    const dur = sg.endBars - sg.startBars;
    const dNorm = Math.abs(sg.to - sg.from) / span;
    if (dur <= 0) {
      if (dNorm > 0.001)
        flags.push({ kind: 'snap', atBars: ln.startBars + sg.startBars,
          deltaNorm: round(dNorm),
          note: 'instant jump (bar-aligned snap) — intended for ' + ln.label });
      continue;
    }
    // peak rate: linear = dNorm/sec; raised-cosine peak = (pi/2)*dNorm/sec
    const durSec = dur * SEC_PER_BAR;
    const peak = (sg.curve === 'lin' ? 1 : Math.PI / 2) * dNorm / durSec;
    if (peak > ZIPPER_NORM_PER_SEC)
      flags.push({ kind: 'zipper', atBars: ln.startBars + sg.startBars,
        peakNormPerSec: round(peak),
        note: ln.label + ': ' + round(peak) + ' norm/s peak ramp (>'
          + ZIPPER_NORM_PER_SEC + ') — check for stepping' });
  }
  return flags;
}
function round(x) { return Math.round(x * 1000) / 1000; }

// ===========================================================================
// SVG rendering
// ===========================================================================
const W = 720, H = 320, PADL = 54, PADR = 150, PADT = 34, PADB = 30;
const PLOTW = W - PADL - PADR, PLOTH = H - PADT - PADB;
const LANE_COLORS = ['#c2622a', '#2bb3a3', '#8a6bd6', '#4caf6e', '#d65a9a',
  '#3b7dd8', '#e3974a', '#d8c84a', '#5ac8d6', '#b85ad6'];

function svgFor(name, tl) {
  const total = tl.totalBars || 1;
  const x = b => PADL + (b / total) * PLOTW;
  const y = norm => PADT + (1 - norm) * PLOTH;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="JetBrains Mono, ui-monospace, monospace">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#15130f"/>`);
  // grid: y 0/.5/1
  for (const g of [0, 0.5, 1]) {
    parts.push(`<line x1="${PADL}" y1="${y(g)}" x2="${PADL + PLOTW}" y2="${y(g)}" stroke="#2a261f"/>`);
    parts.push(`<text x="${PADL - 8}" y="${y(g) + 3}" fill="#7c756a" font-size="10" text-anchor="end">${g.toFixed(1)}</text>`);
  }
  // x bar ticks
  const tick = total > 48 ? 16 : total > 16 ? 8 : 4;
  for (let b = 0; b <= total + 0.01; b += tick) {
    parts.push(`<line x1="${x(b)}" y1="${PADT}" x2="${x(b)}" y2="${PADT + PLOTH}" stroke="#211e18"/>`);
    parts.push(`<text x="${x(b)}" y="${H - 12}" fill="#7c756a" font-size="10" text-anchor="middle">${round(b)}</text>`);
  }
  // events / step boundaries
  for (const ev of tl.events) {
    const col = ev.boundary ? '#e3974a' : '#5a544a';
    parts.push(`<line x1="${x(ev.at)}" y1="${PADT}" x2="${x(ev.at)}" y2="${PADT + PLOTH}" stroke="${col}" stroke-dasharray="3 3" opacity="0.8"/>`);
    parts.push(`<text x="${x(ev.at) + 3}" y="${PADT + 10}" fill="${col}" font-size="9">${ev.a}</text>`);
  }
  // lanes
  const SAMPLES_PER_BAR = 48;
  tl.lanes.forEach((ln, i) => {
    const color = LANE_COLORS[i % LANE_COLORS.length];
    const span = ln.info.max - ln.info.min || 1;
    const pts = [];
    const endBar = ln.startBars + ln.laneBars;
    const n = Math.max(2, Math.round(ln.laneBars * SAMPLES_PER_BAR));
    for (let k = 0; k <= n; k++) {
      const localBar = (k / n) * ln.laneBars;
      const raw = laneValueAt(ln.segs, ln.laneBars, ln.captured, localBar);
      const norm = (raw - ln.info.min) / span;
      pts.push(`${round(x(ln.startBars + localBar))},${round(y(norm))}`);
    }
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2" opacity="0.9"/>`);
    // snap markers
    for (const f of analyzeLane(ln)) {
      if (f.kind === 'snap')
        parts.push(`<circle cx="${x(f.atBars)}" cy="${y((laneValueAt(ln.segs, ln.laneBars, ln.captured, f.atBars - ln.startBars + 0.001) - ln.info.min) / span)}" r="3" fill="#fff"/>`);
    }
    // legend
    const ly = PADT + 4 + i * 15;
    parts.push(`<rect x="${PADL + PLOTW + 12}" y="${ly}" width="10" height="10" fill="${color}"/>`);
    parts.push(`<text x="${PADL + PLOTW + 26}" y="${ly + 9}" fill="#c9bfa9" font-size="10">${esc(ln.label)}</text>`);
  });
  // title + baseline note
  parts.push(`<text x="${PADL}" y="20" fill="#f3ead9" font-size="14" font-weight="700">${esc(name)}</text>`);
  parts.push(`<text x="${PADL + PLOTW}" y="20" fill="#7c756a" font-size="10" text-anchor="end">${round(total)} bars @ ${TEMPO} BPM · y = normalized 0..1</text>`);
  if (tl.immediate)
    parts.push(`<text x="${PADL}" y="${H - 2}" fill="#c2622a" font-size="10">immediate: ${esc(tl.immediate.join(', '))}</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function safeName(cmd) { return cmd.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

// ===========================================================================
// run
// ===========================================================================
fs.mkdirSync(OUT, { recursive: true });
const flagsOut = [];
const cards = [];
let nFlags = 0;

for (const cmd of COMMANDS) {
  const tl = buildTimeline(cmd);
  if (tl.invalid) { console.error('SKIP', cmd, '-', tl.invalid); continue; }
  const file = safeName(cmd) + '.svg';
  fs.writeFileSync(path.join(OUT, file), svgFor(cmd, tl));
  // collect flags
  let laneFlags = [];
  for (const ln of tl.lanes) laneFlags = laneFlags.concat(analyzeLane(ln));
  for (const f of laneFlags) {
    flagsOut.push({ command: cmd, ...f });
    if (f.kind === 'zipper') nFlags++;
  }
  const snaps = laneFlags.filter(f => f.kind === 'snap').length;
  const zips = laneFlags.filter(f => f.kind === 'zipper').length;
  cards.push({ cmd, file, bars: round(tl.totalBars), lanes: tl.lanes.length, snaps, zips });
  console.log(`${cmd.padEnd(40)} ${String(round(tl.totalBars)).padStart(5)} bars  ` +
    `${tl.lanes.length} lanes  ${snaps} snaps  ${zips} zipper`);
}

// CLEAN SLATE is immediate-only — render a note card
{
  const tl = buildTimeline('CLEAN SLATE');
  if (!tl.invalid) {
    fs.writeFileSync(path.join(OUT, 'CLEAN_SLATE.svg'), svgFor('CLEAN SLATE', tl));
    cards.push({ cmd: 'CLEAN SLATE', file: 'CLEAN_SLATE.svg', bars: 0, lanes: 0,
      snaps: 0, zips: 0 });
  }
}

// discontinuities jsonl
fs.writeFileSync(path.join(OUT, 'discontinuities.jsonl'),
  flagsOut.map(f => JSON.stringify(f)).join('\n') + '\n');

// index.html contact sheet
const idx = [`<!doctype html><html><head><meta charset="utf-8"><title>Move Gallery</title>
<style>body{background:#15130f;color:#f3ead9;font-family:JetBrains Mono,ui-monospace,monospace;margin:18px}
h1{font-size:16px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
.c{background:#1b1813;border:1px solid #2a261f;border-radius:6px;padding:6px}
.c img{width:100%;height:auto}.m{font-size:11px;color:#7c756a;padding:4px}
.z{color:#e3974a}</style></head><body>
<h1>CONDUCTOR — Move Gallery <span style="color:#7c756a;font-size:12px">@ ${TEMPO} BPM</span></h1>
<div class="g">`];
for (const c of cards) {
  idx.push(`<div class="c"><img src="${c.file}" alt="${esc(c.cmd)}">
    <div class="m">${esc(c.cmd)} — ${c.bars} bars, ${c.lanes} lanes` +
    (c.snaps ? `, ${c.snaps} snap` : '') +
    (c.zips ? `, <span class="z">${c.zips} zipper</span>` : '') + `</div></div>`);
}
idx.push('</div></body></html>');
fs.writeFileSync(path.join(OUT, 'index.html'), idx.join('\n'));

console.log(`\nwrote ${cards.length} panels + index.html + discontinuities.jsonl -> ${path.relative(REPO, OUT)}/`);
console.log(`${flagsOut.filter(f => f.kind === 'snap').length} snaps (intended), ${nFlags} zipper-risk flags.`);
