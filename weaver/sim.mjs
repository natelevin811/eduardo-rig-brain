// sim.mjs — headless Weaver simulator. Feed it MIDI (recorded Push, or the
// built-in synthetic performance), render Weaver output as .mid to audition.
// Tune density/register rules offline here; the live device comes only after
// this sim is boring-reliable.
//
//   node weaver/sim.mjs [--in perf.mid] [--key Cm] [--out dir]
//                       [--density 0.5] [--seed 1] [--bars 16] [--bpm 84]
//
// Writes into <out> (default weaver/audition):
//   together.mid   track 1 = input (Nate), track 2 = Weaver — audition the duo
//   weaver.mid     Weaver line alone
//   input.mid      the input used (handy when synthetic)
// and prints stats incl. the density-rule proof (output rate busy vs sparse).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMidiFile, writeMidi, bpmToUS } from './midi.mjs';
import { weave } from './weaver.mjs';
import { parseKeyLabel, inferKey } from './scale.mjs';
import { genPerformance } from './gen-input.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const OUT = path.resolve(arg('--out', __dirname + '/audition'));
const BPM = parseFloat(arg('--bpm', '84'));
const SEED = parseInt(arg('--seed', '1'), 10);
const DENSITY = parseFloat(arg('--density', '0.5'));
const BARS = parseInt(arg('--bars', '16'), 10);
const keyArg = arg('--key', null);
const inFile = arg('--in', null);

fs.mkdirSync(OUT, { recursive: true });

// --- input ---
let input, source;
if (inFile) {
  input = readMidiFile(path.resolve(inFile));
  source = `recorded: ${inFile}`;
} else {
  // key needed to synthesize; default to Cm if none given
  const k = parseKeyLabel(keyArg || 'Cm');
  input = genPerformance({ key: k, bars: BARS, ppq: 480, seed: 7 });
  source = `synthetic (${BARS} bars, ${k.name})`;
}

// --- key: label-clip arg wins; else infer from pitch content (Weaver's cheat) ---
let key = parseKeyLabel(keyArg);
let keySource;
if (key) keySource = `label "${keyArg}"`;
else { key = inferKey(input.notes.map(n => n.pitch)); keySource = 'inferred from input'; }

// --- weave ---
const { notes: weaverNotes, stats } = weave(input, {
  key, density: DENSITY, seed: SEED, channel: 1,
});

const ppq = input.ppq, tempoUS = bpmToUS(BPM);
writeMidi(path.join(OUT, 'input.mid'),
  { ppq, tempoUS, tracks: [{ name: 'Nate (input)', notes: input.notes }] });
writeMidi(path.join(OUT, 'weaver.mid'),
  { ppq, tempoUS, tracks: [{ name: 'Weaver', notes: weaverNotes }] });
writeMidi(path.join(OUT, 'together.mid'),
  { ppq, tempoUS, tracks: [
    { name: 'Nate (input)', notes: input.notes },
    { name: 'Weaver', notes: weaverNotes }] });

// --- report ---
console.log('\nWEAVER SIM');
console.log('  input   :', source);
console.log('  key     :', key.name, '(' + keySource + ')');
console.log('  density :', DENSITY, ' seed:', SEED, ' tempo:', BPM, 'BPM');
console.log('  ----');
console.log('  input notes :', stats.input);
console.log('  weaver notes:', stats.output, `(ratio ${stats.ratio} — companion, not soloist)`);
console.log('  density rule: ' +
  `${stats.outPerWindowSparse} notes/emit in SPARSE vs ` +
  `${stats.outPerWindowBusy} in BUSY  ` +
  (stats.outPerWindowSparse >= stats.outPerWindowBusy
    ? '✓ plays less when you play more'
    : '✗ check tuning'));
console.log('  voice cap   :', stats.voicesDroppedToCap, 'overlaps trimmed');
console.log('  wrote       : together.mid / weaver.mid / input.mid ->',
  path.relative(path.resolve(__dirname, '..'), OUT) + '/');
