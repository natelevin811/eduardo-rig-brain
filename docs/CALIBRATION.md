# CALIBRATION.md — the by-ear pass (do this in the living room, not at the gig)

Every tunable lives in **one place**: the `TUNING` block at the top of
`conductor/moves.js`, plus the few sentinel constants called out below. Edit,
save, Max hot-reloads (autowatch), fire the move again. No patching.

Work in REHEARSE mode with DRY-RUN OFF and the dashboard open.

## C0 — clock sanity (do first)

Play transport at 94 BPM. The dashboard bar counter must advance exactly once
per bar. If it runs 480× too fast, plugsync~ is feeding ticks, not beats —
insert a `[/ 480.]` before `[prepend sync]` in both shells. If it counts in
half/double time, you're on the wrong plugsync~ outlet.

## C1 — DJ filter polarity (setmap says VERIFY)

Fire `BREATH 8`. The four FX buses must **darken** (low-pass closing), not
thin out (high-pass). If they thin: flip the signs of `djLpBreath` and
`djLpFocus` in TUNING **and** correct the `polarity` note in the setmap.

## C2 — Fade macro direction (setmap says VERIFY)

Fire `TIDE OUT 32` and watch the first bars. The four FX buses must fade
DOWN. If they get louder, `fadeTideOut: 0.92` is backwards — the macro's
audible direction is inverted; set it near 0.0 instead and note the rest
value implication in the setmap (`rest` may then need to be 1.0 — confirm
what silence vs. unity actually is on this macro before the gig).

## C3 — PingPong Delay rest state (setmap note)

With everything at rest, confirm the PingPong macro at rest = silent (inner
Delay saved at drywet 0.5 — the macro presumably gates it). If rest is NOT
silent, that macro must come out of CLEAN SLATE's `macrosToRest` rest value —
update the setmap rest for it.

## C4 — Metallica macro

`conductor_use: false` in the setmap and no move touches it. Leave it alone
unless calibrated by ear and explicitly added to a move. Nothing to do.

## C5 — move depths (by ear, one per line)

| TUNING key       | move        | listen for |
|------------------|-------------|------------|
| `washWet`        | WASH        | wet but not drowned at the hold |
| `lpfGentle`      | TIDE OUT    | "gentle" — the tide, not a brick wall |
| `lpfFullClosed`  | BLOOM       | properly veiled at bar 0, no silence |
| `hpfNarrow`/`lpfNarrow` | SUNRISE/NIGHTFALL | a band you'd call "veiled", music still present |
| `djLpBreath`     | BREATH      | underwater inhale, kick still anchors (bass untouched) |
| `djLpFocus`      | FOCUS       | spotlight reads, non-focus buses recede not vanish |
| `veilWet`        | VEIL        | hard smear that dissolves cleanly |
| `swellWet`       | SWELL       | bloom, not feedback risk on Rubadub (E)! test every letter you'll use |
| `horizonSendRel`, `bloomSendRel`, `sunriseSendRel` | HORIZON/BLOOM/SUNRISE | imperceptible in the moment, audible over the arc |

## C6 — PULSE depth (spec: set by ear, write to setmap)

Fire `PULSE 16` on a busy passage. `pulseDepth: 0.04` should be FELT not
heard. Raise/lower in 0.01 steps; hard cap 0.08 (comment in TUNING is law).
When settled, copy the final value into a `tuning` note in the setmap so the
number survives this repo.

## C7 — ALIVE bounds (spec: set by ear, write to setmap)

Enable ALIVE, no moves, ten minutes. You should never *notice* it; you should
only notice if you A/B against it off. `aliveBound: 0.015` is the setmap-law
ceiling — go DOWN from here if audible, never up.

## C8 — sentinel meter scale + trim feel

1. `meterDbRel` assumes ~0.025 meter units/dB near the top (0.85 ≈ 0 dB).
   Verify: play a steady loop, pull the bus's SENTRIM by exactly -2 dB by
   hand, watch the bus meter drop ≈ 0.05. If it's way off, adjust the 0.025
   in `sentinel.js` (one constant, one place).
2. Confirm SENTRIM's Gain param is dB-native: in the Max console,
   resolved param min should read ≈ -35/-36. If it reads 0..1, STOP and
   flag — `writeTrim` then needs a mapping (STATUS.md question Q4).
3. Stack 3 loops on Pads, push the level until Main brushes 0.92: trims must
   engage on PADS only (dominance law), at half slew below the ceiling, full
   slew past it, and release over ~12 s after you pull the loops.

## C9 — RITUAL marks

- Set HELIX CAPTURE IN TRIM and FADE where they belong by hand, read the
  values from the param hover, then add to the setmap:

```json
"ritual": {
  "helix_marks": [
    { "track": "<capture track name>", "device": "<TRIM utility name>", "param": "Gain", "value": 0.0 }
  ]
}
```

- Until that block exists, the RITUAL card shows `HELIX capture marks ✗ (no
  setmap.ritual.helix_marks)` — that's the system telling you this page isn't
  done, not a bug.

## C10 — riser pair

Fire `RISE 16`: white-noise clip fires on the bar, KnobRiser macro climbs to
full over 16, clip dies + macro zeros at the top, ShephardsTone swells in
parallel and ducks over 2 bars. If the Shephards swell is too shy, raise
`shepSwell` (max 1.0).
