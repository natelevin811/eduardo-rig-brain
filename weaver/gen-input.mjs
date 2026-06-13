// gen-input.mjs — synthetic Push/keyboard performance, so the Weaver sim has
// something to chew on until a real recording is dropped in. Deterministic.
// Shape: held chords (sparse) interleaved with a couple of busier melodic
// passages, so the density rule has both regimes to react to.

import { scalePitchClasses } from './scale.mjs';

function makeRng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// build a diatonic triad rooted at scale degree `deg` near octave `oct`
function triad(key, deg, oct) {
  const pcs = scalePitchClasses(key);
  const root = 12 * oct + pcs[deg % 7];
  return [0, 2, 4].map(s => 12 * oct + pcs[(deg + s) % 7] + (deg + s >= 7 ? 12 : 0))
    .map(p => p);
}

export function genPerformance({ key, bars = 16, ppq = 480, seed = 7 }) {
  const rng = makeRng(seed);
  const beat = ppq, bar = 4 * ppq;
  const notes = [];
  const prog = [0, 5, 3, 4];   // i - vi - iv - v -ish degrees (minor-friendly)
  for (let b = 0; b < bars; b++) {
    const deg = prog[b % prog.length];
    const oct = 4;
    const chord = triad(key, deg, oct);
    const busy = (b % 4 === 3);   // every 4th bar gets a busier right-hand run

    // left/center hand: held chord for the bar (sparse, sustained)
    const start = b * bar;
    for (const p of chord) {
      notes.push({ pitch: p, velocity: 60 + Math.floor(rng() * 12),
        channel: 0, start: start + Math.floor(rng() * (beat / 4)), dur: bar - beat / 2 });
    }
    // occasional melody on top
    if (busy) {
      const pcs = scalePitchClasses(key);
      let t = start;
      while (t < start + bar - beat / 2) {
        const oc = 5 + (rng() < 0.3 ? 1 : 0);
        const p = 12 * oc + pcs[Math.floor(rng() * pcs.length)];
        const d = (rng() < 0.5 ? beat / 4 : beat / 2);
        notes.push({ pitch: p, velocity: 70 + Math.floor(rng() * 20),
          channel: 0, start: t, dur: Math.max(beat / 8, d * 0.9) });
        t += d;
      }
    } else if (rng() < 0.4) {
      // a single grace note in a sparse bar
      const pcs = scalePitchClasses(key);
      notes.push({ pitch: 12 * 5 + pcs[Math.floor(rng() * pcs.length)],
        velocity: 64, channel: 0, start: start + 2 * beat, dur: beat });
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { ppq, notes };
}
