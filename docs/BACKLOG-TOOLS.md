# Overnight backlog build — morning report (2026-06-13)

Built the four tools from `overnightbuildbacklog.md`, in Nate's approved order,
against the real files you dropped in (`v6.als`, `Eduardo2026.hss`). All four
are **offline and read-only** — none of them touch a running Live, Link, audio,
or the network. Link-safety grep over the new code: **zero** tempo/transport/
scene-fire writes, zero `api.set/call`/`live_set`/`outlet`. They parse files.

Nothing here is morning homework you're obligated to read — fire what's useful,
skip the rest. Quick tour:

---

## 1. Set Linter — `tools/lint_set.py`  (zero hands)

```bash
python3 tools/lint_set.py "<set.als>"            # terminal audit
python3 tools/lint_set.py "<set.als>" --jsonl r.jsonl --quiet
```

Parses any `.als` and runs the whole week's hand-audit as permanent tripwires.
RED = gate-failing (exits nonzero), YELLOW = eyeball once, GREEN = passed.

**On the real v6 set: 1 RED, 9 YELLOW.** Highlights (full run in
`out/lint-report.txt`, machine-readable `out/lint-findings.jsonl`):

- **RED — 11 scenes carry an *enabled* tempo** (89/98/106/110/114/115/120/121).
  This is the Link hazard from the spec: launching one re-tempos the whole room.
  The linter lists every scene (index + label-clip name) in the jsonl.
- **YELLOW — `CL#3 BASS` has a Utility at −6.11 dB** — a hidden second gain
  stage on a loop lane (conductor expects 0 dB rest).
- **YELLOW — All-Ins MIDI-From** on `17 Bss Chain` / `18 Pad Chain` /
  `19 Leads Chain` (+ the risers). Exactly the synth-chain leak you fixed once;
  now it can't come back silently.
- **YELLOW — external/old-volume media**: 2313 refs under "Exported from Antares
  Laptop", 126 under `/Volumes/…Live 11…app.Old`. Confirm collected on the gig
  laptop.
- GREEN: all six DJ filters centered (incl. LeadsBus inside its rack), EQ Three
  at unity, plugins limited to Omnisphere + ValhallaVintageVerb.

**Pre-commit gate** (per the doc): `bash tools/install-hooks.sh` points
`core.hooksPath` at `.githooks`. The hook lints any staged `.als` (and any path
in `$RIG_LINT_SET` / `.riglintset`) and blocks the commit on RED. Bypass once
with `git commit --no-verify`, always with `RIG_LINT_SKIP=1`.

**Checks implemented:** scene tempos · CL lane/Utility gains · bus faders ·
monitor states · All-Ins MIDI leaks · DJ-filter detent · EQ-Three unity · send
mismatches · crossfade assign · double compression · unauthorized plugins ·
external media · duplicate track names. New checks are one function each.

---

## 2. Helix Bank Tools — `tools/helix_bank.py`  (your top pick)

```bash
python3 tools/helix_bank.py audit "<bank.hss>" --jsonl out/helix-audit.jsonl
python3 tools/helix_bank.py card  "<bank.hss>" -o out/helix-card.html
python3 tools/helix_bank.py diff  "<old.hss>" "<new.hss>"
```

Reverse-engineered the `.hss` (24-byte header → gzip → tar of `rpshnosj`+JSON
preset slots). Confirmed against your bank: **47 filled presets** of 128 slots.

**Gain-staging audit** flags the "one preset jumps out louder than its
neighbours" problem (full list in `out/helix-audit.jsonl`):

- output **+5 dB** louder: *Tweed BluesBrtWa* (slot 6); **+4 dB**: *GD-ORGAN*
  (slot 47).
- output **−6 dB** quieter: *Cavernous Clean '26* (slot 7).
- cab/IR **+6 dB** jumps: *Double Double*, *Openly Squished*, *!-S:Mlt.Gtr/Snth*,
  the two `BssGtr…` tuned presets.
- one muted output path on *!-S:Mlt.Gtr/Snth* (slot 25 OutputMatrix at −120 dB —
  intentional dual-path, or dead? worth a glance).

**Music-stand card** → `out/helix-card.html`. Open in a browser, Print /
Save-as-PDF for the stand. Presets in setlist order, colour chips, snapshot
names, grouped **bass → guitar → ambient**. Readable standing.

**Diff** confirms imported presets landed (names + output gains) when you point
it at the old 2019 bank vs current.

---

## 3. Move Gallery — `tools/move_gallery.mjs`  (design-by-looking)

```bash
node tools/move_gallery.mjs            # -> gallery/*.svg + index.html
node tools/move_gallery.mjs --tempo 81 # zipper math at a given tempo
```

Loads the **real** `conductor/moves.js` and reproduces the `conductor.js` ramp
engine **verbatim** (`ease`/`specToRaw`/`laneValueAt`), simulates all 18 shipped
commands + the 4 sequences, and renders each as an SVG curve picture. Open
`gallery/index.html` for the contact sheet (GitHub renders the SVGs inline too).

- White dots mark **bar-aligned snaps** (intended — BLOOM/SUNRISE/RISE/CLEAN
  SLATE). 6 found, all expected.
- **0 zipper-risk flags** across the whole library — validates the gentle
  exp-ease ramps (`gallery/discontinuities.jsonl` is the machine record).
- Sequences concatenate with step-boundary marks; PULSE shows its sine on send D.

This is the design surface for new choreography: propose a move, render its curve,
approve it by looking — before it ever touches the set.

---

## 4. The Weaver — `weaver/` (simulator scaffold only)

```bash
node weaver/sim.mjs --key Cm --bpm 84 --density 0.5     # synthetic input
node weaver/sim.mjs --in take.mid --key Fm              # a real Push recording
```

Headless MIDI-only generative **companion** — the decision core the eventual
M4L device will run, exercised offline so you can audition output as `.mid`.
**Living-room rule honoured: no live device until this sim is boring at home.**
Full detail in `weaver/README.md`. Auditioned set in `weaver/audition/`
(`together.mid` = you + Weaver).

Verified properties (the sim prints/asserts these):
- **scale-locked** — 0 out-of-key notes; only rearranges pitches you played.
- key from the **label clip** (`--key`) or **inferred** from pitch content
  (correctly recovered Cm with no hint).
- **plays less when you play more** — busy passages drop toward zero output.
- **plays where you aren't** — gaps in time, free register in pitch.
- **companion, not soloist** — out/in ratio ~0.2–0.5, velocity capped quiet,
  voice cap on.

To audition a real take: export a Push performance to `.mid`, run `--in`.

---

## What needs your hands / real-file validation

1. **Set Linter findings are real but advisory** — I flag, I never fix. The
   11 baked-tempo scenes especially: decide per-scene whether to disable the
   tempo or just never launch by accident (the spec already treats these as a
   human/Link concern).
2. **Helix card** wants a one-time visual once-over: the bass/guitar/ambient
   grouping is heuristic (name prefix + colour). Re-categorise any preset that
   lands wrong and the `COLOR_FAMILY`/name rules are easy to nudge.
3. **Helix `diff`** needs the older bank file to confirm the 2019 imports.
4. **Weaver** wants your ears on `weaver/audition/together.mid`, then a real
   Push take through `--in`. The `--density`/transform mix is tuned by feel from
   here; it is *not* stage-ready and isn't meant to be yet.
5. **Move Gallery** rate (zipper) math assumes 94 BPM by default; the set runs
   ~81 — pass `--tempo 81` if you want the curves judged at gig tempo (it only
   affects the zipper flag threshold, not the shapes).

## Open question

- The Helix bank has **47** filled presets; the backlog said ~66. Likely a
  different/working bank than the full 66-preset one — point the tools at the
  full bank if that's the one for the gig.
