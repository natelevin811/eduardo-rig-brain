// transforms.mjs — the Weaver's note transforms. Pure functions: each takes a
// context and returns companion note events {pitch, start, dur, velocity}.
// Every output pitch is scale-locked by the engine after the fact, but these
// already aim inside the scale. Nothing here invents a pitch Nate didn't imply.
//
// The four gestures from the backlog: delayed inversions, octave displacement,
// slow kora-style cascading arpeggios of the just-voiced chord, sparse echoes.

// pick a register-free landing octave for a pitch, given the band Nate occupies
function intoFreeRegister(pitch, ctx) {
  const { loIn, hiIn } = ctx;
  // prefer above the top of Nate's band; if that's very high, drop below
  let p = pitch;
  if (hiIn != null && p <= hiIn + 2) p += 12 * (1 + Math.floor((hiIn + 2 - p) / 12));
  if (p > 96 && loIn != null) p = (loIn - 5) - (p % 12 === 0 ? 0 : 0);  // too high -> below
  return Math.max(24, Math.min(100, p));
}

// 1) delayed inversion: invert a recent phrase around its centroid, delay, lift.
export function delayedInversion(recent, ctx) {
  if (recent.length < 2) return [];
  const pivot = Math.round(recent.reduce((s, n) => s + n.pitch, 0) / recent.length);
  const delay = ctx.beat * ctx.rng.pick([1.5, 2, 3]);
  const out = [];
  const take = recent.slice(-3);
  take.forEach((n, i) => {
    let p = pivot - (n.pitch - pivot);          // invert interval
    p = intoFreeRegister(p, ctx);
    out.push({ pitch: p, start: ctx.now + delay + i * ctx.beat * 0.5,
      dur: ctx.beat * 1.5, velocity: ctx.vel(0.85) });
  });
  return out;
}

// 2) octave displacement: echo one recent note an octave (or two) away, delayed.
export function octaveDisplacement(note, ctx) {
  if (!note) return [];
  const oct = ctx.rng.pick([12, 12, 24, -12]);
  let p = intoFreeRegister(note.pitch + oct, ctx);
  const delay = ctx.beat * ctx.rng.pick([1, 1.5, 2]);
  return [{ pitch: p, start: ctx.now + delay, dur: ctx.beat * 2, velocity: ctx.vel(0.8) }];
}

// 3) kora cascade: a slow upward arpeggio of the just-voiced chord's tones,
//    placed high, gently decrescendo. The signature "playing-with-you" gesture.
export function koraCascade(chord, ctx) {
  if (chord.length < 2) return [];
  const tones = [...new Set(chord.map(p => p % 12))].sort((a, b) => a - b);
  // build a rising sequence of scale/chord tones across ~1.5 octaves, high
  const baseOct = Math.floor((Math.max(...chord) ) / 12) + 1;  // above the chord
  const seq = [];
  for (let o = 0; o < 2; o++)
    for (const t of tones) seq.push(t + 12 * (baseOct + o));
  const step = ctx.beat * (ctx.rng.pick([0.25, 0.33, 0.5]));   // cascading speed
  const out = [];
  seq.forEach((p, i) => {
    out.push({ pitch: intoFreeRegister(p, ctx),
      start: ctx.now + i * step, dur: step * 2.2,
      velocity: ctx.vel(0.9 - i * 0.06) });    // fade as it climbs
  });
  return out.slice(0, 5);   // never a runaway flurry
}

// 4) sparse echo: a single quiet, scale-locked echo on an offbeat.
export function sparseEcho(note, ctx) {
  if (!note) return [];
  const delay = ctx.beat * ctx.rng.pick([0.5, 0.75, 1, 1.5]);
  return [{ pitch: intoFreeRegister(note.pitch, ctx),
    start: ctx.now + delay, dur: ctx.beat, velocity: ctx.vel(0.7) }];
}
