# The Weaver — simulator scaffold

A MIDI-only generative **companion**. It takes Nate's Push/keyboard MIDI and
echoes transformed variants into a quiet pad chain — something playing back
*with* him while he plays, not a soloist.

**Status: headless simulator only.** Per the backlog, the live Max for Live
device comes *after* this sim earns trust at home. Nothing here touches Live,
Link, audio, or the network. It reads `.mid`, writes `.mid`.

## Why a sim first

> Build backwards from trust. The live device only exists once the sim is
> boring-reliable.

The sim is the decision core the live device will eventually run, exercised
offline where you can audition every output as a `.mid` and tune the rules with
no gig risk.

## Run it

```bash
# synthetic performance (until you have a recording), key from the label clip:
node weaver/sim.mjs --key Cm --bpm 84 --density 0.5

# a real recording (export Push MIDI to a .mid and point at it):
node weaver/sim.mjs --in path/to/push-take.mid --key Fm

# let it read the key from the input instead of telling it:
node weaver/sim.mjs --in take.mid
```

Outputs land in `weaver/audition/`:
- `together.mid` — track 1 = you, track 2 = Weaver. Audition the duo.
- `weaver.mid` — the Weaver line alone.
- `input.mid` — the input it used (handy when synthetic).

Knobs: `--density 0..1`, `--seed N` (deterministic), `--bars`, `--bpm`,
`--out <dir>`.

## The rules (and how they're enforced)

- **MIDI-only, can't mis-key.** Every output pitch is snapped to the current
  scale (`scale.mjs#snapToScale`); the sim verifies 0 out-of-key notes. It only
  ever rearranges pitches you actually played — no invented harmony.
- **Key source = the cheapest signal.** `--key Cm` mirrors reading the playing
  silent label clip (Cm, Fm, …). With no label, `inferKey()` reads the scale
  from input pitch content. (In the live device this string comes from the
  active label clip / key-setting loop.)
- **Plays less when you play more.** Emission probability scales with
  `(1 − local input density)`, and the min gap between gestures grows when
  you're busy. The sim prints the proof: notes-per-emit in *sparse* vs *busy*
  passages (sparse should dominate; busy often drops to zero).
- **Plays where you aren't.** In *time*: only fires in gaps (never within half a
  16th of your onsets). In *pitch*: lands in a free register above/below the
  band you're occupying (`intoFreeRegister`).
- **Companion, not soloist.** Output/input note ratio stays well below 1
  (~0.2–0.5 across the density range), velocity is capped quiet by default
  (≤ 52), and a voice cap (default 3) prevents any wall of sound.

## The transforms (`transforms.mjs`)

The four gestures from the backlog, each a pure function over recent context:

1. **delayed inversions** — invert a recent phrase around its centroid, delay,
   lift into a free register.
2. **octave displacement** — echo a recent note an octave (or two) away.
3. **kora cascade** — a slow upward arpeggio of the *just-voiced chord's* tones,
   placed high, gently decrescendo. The signature with-you gesture.
4. **sparse echo** — a single quiet, scale-locked offbeat echo.

## Files

| file | role |
|---|---|
| `sim.mjs` | CLI harness: load/generate MIDI → weave → render `.mid` + stats |
| `weaver.mjs` | the engine: density/register/key decision core + voice cap |
| `transforms.mjs` | the four note gestures (pure functions) |
| `scale.mjs` | label parsing, scale-lock, key inference |
| `gen-input.mjs` | synthetic Push performance (stand-in for a recording) |
| `midi.mjs` | dependency-free Standard MIDI File read/write |

## When it goes live (not yet)

The live M4L device wraps this same core in an `exception jail`, lives on its
own pad chain scoped to **one input port** (same lesson as the synth-chain
MIDI-From leak the Set Linter now flags), is **quiet by default**, and has **one
mute**. It does not exist until this sim is boring at home. Music is not
homework.
