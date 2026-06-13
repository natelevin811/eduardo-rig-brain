// scale.mjs — key/scale handling for the Weaver.
//
// Key source mirrors the set's cheapest signal: the silent label clips (Cm, Fm,
// F#m, C, …). In the live device this string comes from the playing label clip;
// in the sim it's the --key arg, or inferred from input pitch content.

const NOTE_TO_PC = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5,
  'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11 };
const PC_NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// scale degrees (semitones from tonic)
const SCALES = {
  major:      [0, 2, 4, 5, 7, 9, 11],
  minor:      [0, 2, 3, 5, 7, 8, 10],   // natural minor (aeolian)
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
};

// Parse a label clip name like "Cm", "F#m", "C", "Bbm", "Dm Earth", "Gm Improv".
// Returns { tonic (0-11), mode, name } or null.
export function parseKeyLabel(label) {
  if (!label) return null;
  const m = String(label).trim().match(/^([A-Ga-g])([#b]?)\s*(m|min|maj|dorian|phrygian)?/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2] === '#' ? '#' : (m[2].toLowerCase() === 'b' ? 'B' : '');
  const tonic = NOTE_TO_PC[(letter + acc)];
  if (tonic === undefined) return null;
  let mode = 'major';
  const q = (m[3] || '').toLowerCase();
  if (q === 'm' || q === 'min') mode = 'minor';
  else if (q === 'dorian') mode = 'dorian';
  else if (q === 'phrygian') mode = 'phrygian';
  return { tonic, mode, name: PC_NAME[tonic] + (mode === 'major' ? '' : 'm') };
}

export function scalePitchClasses({ tonic, mode }) {
  return SCALES[mode].map(d => (tonic + d) % 12);
}

// Snap a MIDI pitch to the nearest pitch in the scale (ties -> down).
export function snapToScale(pitch, key) {
  const pcs = scalePitchClasses(key);
  for (let d = 0; d <= 6; d++) {
    if (pcs.includes((pitch - d + 120) % 12)) return pitch - d;
    if (pcs.includes((pitch + d) % 12)) return pitch + d;
  }
  return pitch;
}

// Is this pitch already in the scale?
export function inScale(pitch, key) {
  return scalePitchClasses(key).includes(((pitch % 12) + 12) % 12);
}

// Infer a key from a bag of pitches: pick the tonic+mode whose scale best covers
// the played pitch classes (weighted), tie-broken toward minor (ambient default).
export function inferKey(pitches) {
  const hist = new Array(12).fill(0);
  for (const p of pitches) hist[((p % 12) + 12) % 12]++;
  let best = null, bestScore = -1;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['minor', 'major', 'dorian']) {
      const pcs = SCALES[mode].map(d => (tonic + d) % 12);
      let score = 0;
      for (let pc = 0; pc < 12; pc++) if (pcs.includes(pc)) score += hist[pc];
      // reward tonic + fifth presence
      score += hist[tonic] * 1.5 + hist[(tonic + 7) % 12] * 0.5;
      if (mode === 'minor') score += 0.01;        // ambient tie-break
      if (score > bestScore) { bestScore = score; best = { tonic, mode }; }
    }
  }
  return { tonic: best.tonic, mode: best.mode,
    name: PC_NAME[best.tonic] + (best.mode === 'major' ? '' : 'm') };
}

export { PC_NAME };
