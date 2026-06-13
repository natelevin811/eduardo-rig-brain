// weaver.mjs — the Weaver engine. MIDI-only generative companion.
//
// Consumes Nate's input notes and emits a quiet companion line that:
//   * plays LESS when he plays more (density rule),
//   * plays WHERE he isn't — in time (gaps) and in pitch (free register),
//   * stays locked to the current key (from the label clip / inferred),
//   * only ever rearranges notes he actually played (no invented harmony).
//
// Pure + deterministic given a seed, so sim output is reproducible and
// auditable. The live M4L device would feed real-time note events through the
// same decision core; this file is that core, exercised offline.

import { snapToScale } from './scale.mjs';
import { delayedInversion, octaveDisplacement, koraCascade, sparseEcho }
  from './transforms.mjs';

// seedable RNG (mulberry32)
function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: arr => arr[Math.floor(next() * arr.length)] };
}

export const DEFAULTS = {
  density: 0.5,      // base companion activity (0 quiet .. 1 chatty)
  quietVel: 52,      // companion ceiling velocity (quiet by default)
  maxVoices: 3,      // never a wall of sound
  seed: 1,
  channel: 1,        // companion on its own channel -> its own pad chain
  denseMax: 8,       // input onsets per 2 beats that count as "fully busy"
};

export function weave(input, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { key } = o;
  if (!key) throw new Error('weave: opts.key required');
  const ppq = input.ppq;
  const beat = ppq;
  const step = Math.max(1, Math.round(ppq / 4));     // 16th-note grid
  const notes = input.notes.filter(n => n.velocity > 0);
  if (!notes.length) return { notes: [], stats: { input: 0, output: 0 } };
  const endTick = Math.max(...notes.map(n => n.start + n.dur));
  const onsets = notes.map(n => n.start).sort((a, b) => a - b);

  const rng = makeRng(o.seed);
  const out = [];
  let lastEmit = -1e9;
  let busyAcc = 0, sparseAcc = 0, busyOut = 0, sparseOut = 0;

  for (let t = 0; t <= endTick; t += step) {
    // --- density over the last 2 beats ---
    const lo = t - 2 * beat;
    let dCount = 0;
    for (const s of onsets) { if (s > t) break; if (s >= lo) dCount++; }
    const density = Math.min(1, dCount / o.denseMax);

    // --- register Nate occupies over the last 4 beats ---
    let loIn = null, hiIn = null;
    const recent = [];
    for (const n of notes) {
      if (n.start > t) break;
      if (n.start >= t - 4 * beat) {
        recent.push(n);
        loIn = loIn == null ? n.pitch : Math.min(loIn, n.pitch);
        hiIn = hiIn == null ? n.pitch : Math.max(hiIn, n.pitch);
      }
    }
    // held chord right now
    const chord = notes.filter(n => n.start <= t && n.start + n.dur > t).map(n => n.pitch);

    // --- time-register rule: only play in gaps (no onset within half a step) ---
    const nearOnset = onsets.some(s => Math.abs(s - t) < step * 0.5);
    if (nearOnset) continue;

    // --- density rule: play less when he plays more ---
    const prob = o.density * (1 - density) * 0.22;
    // min gap between emissions grows when busy (companion, not soloist)
    const minGap = beat * (1 + density * 3);
    if (t - lastEmit < minGap) continue;
    if (rng.next() > prob) continue;

    // --- choose a gesture from context ---
    const ctx = {
      key, rng, beat, now: t, loIn, hiIn,
      vel: (scale) => Math.max(1, Math.round(o.quietVel * scale * (1 - 0.45 * density))),
    };
    let emitted = [];
    if (chord.length >= 2 && density < 0.45 && rng.next() < 0.4) {
      emitted = koraCascade(chord, ctx);
    } else if (recent.length >= 2 && rng.next() < 0.5) {
      emitted = delayedInversion(recent, ctx);
    } else if (recent.length) {
      emitted = rng.next() < 0.5
        ? octaveDisplacement(recent[recent.length - 1], ctx)
        : sparseEcho(recent[recent.length - 1], ctx);
    }
    if (!emitted.length) continue;
    lastEmit = t;
    for (const n of emitted) out.push(n);

    if (density >= 0.5) { busyAcc++; busyOut += emitted.length; }
    else { sparseAcc++; sparseOut += emitted.length; }
  }

  // --- post: scale-lock, clamp velocity, channel, voice cap ---
  for (const n of out) {
    n.pitch = Math.max(0, Math.min(127, snapToScale(Math.round(n.pitch), key)));
    n.start = Math.round(n.start);
    n.dur = Math.max(step, Math.round(n.dur));
    n.velocity = Math.max(1, Math.min(o.quietVel, Math.round(n.velocity)));
    n.channel = o.channel;
  }
  out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const capped = voiceCap(out, o.maxVoices);

  const stats = {
    input: notes.length,
    output: capped.length,
    ratio: +(capped.length / notes.length).toFixed(3),
    // proof the density rule works: per-emit-window output should be lower in
    // busy sections than sparse ones.
    outPerWindowBusy: busyAcc ? +(busyOut / busyAcc).toFixed(2) : 0,
    outPerWindowSparse: sparseAcc ? +(sparseOut / sparseAcc).toFixed(2) : 0,
    voicesDroppedToCap: out.length - capped.length,
  };
  return { notes: capped, stats };
}

// drop notes that would exceed maxVoices simultaneously (keep earliest/lowest)
function voiceCap(notes, cap) {
  const active = [];   // end ticks
  const kept = [];
  for (const n of notes) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i] <= n.start) active.splice(i, 1);
    if (active.length < cap) { kept.push(n); active.push(n.start + n.dur); }
  }
  return kept;
}
