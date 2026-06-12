# CONDUCTOR + SENTINEL — Build Spec v2 (overnight scope)
Supersedes v1. Companion: `eduardo-setmap.json`. Same design religion, bigger build.

**What changed from v1:** expanded move library + move sequences, a background ALIVE drift mode, hardened failure handling, session logging, and a live monitoring dashboard served to a browser (laptop screen or iPad Mini tab). Same two .amxd shells; one added Node for Max telemetry process, isolated so its death cannot affect control.

---

## Non-negotiables (unchanged, re-read them)

Name-based resolution with red-text failure. Capture and restore. Grab only during ramps. Hands-off list is law. All logic in `.js` for hot reload. Dry-run mode. The performer's hands always win. Nothing inserts audio processing. If it doesn't pass the living-room run, it stays home and v4 plays the gig.

## Repo layout

```
eduardo-rig-brain/
  CLAUDE.md                       <- session kickoff prompt, bottom of this file
  setmap/eduardo-setmap.json
  shared/resolver.js              <- LOM name resolution, used by both devices
  shared/telemetry.js             <- one-way event emitter to dashboard
  sentinel/sentinel.js
  conductor/conductor.js
  conductor/moves.js              <- move + sequence library (data, not code)
  dashboard/server.js             <- node.script, websocket + static page
  dashboard/index.html            <- single file, no build step
  docs/SHELL-BUILD.md  docs/CALIBRATION.md  docs/RUNBOOK.md
  test/soak-checklist.md
  logs/                           <- session logs land here, timestamped
```

## CONDUCTOR v2

### Move library (full)

Originals: WASH, TIDE OUT, BREATH, BLOOM, RISE, DISSOLVE, DISSOLVE BACK, CLEAN SLATE (definitions in setmap, unchanged).

New:

- **HORIZON 64/128** — the long arc. Imperceptibly slow drift: LPF eases 15% closed and back, send B swells +2 dB and back, one full arc over n bars. For passages where nothing should *happen* but nothing should sit still either.
- **SUNRISE 32** — from veiled to open: starts by snapping HPF+LPF to a narrowed band (on the bar), then opens both fully over n bars while send C rises slightly. The set "waking up."
- **NIGHTFALL 32** — inverse of SUNRISE: slow narrowing into darkness, holds. Pairs with TIDE OUT for the deep hours.
- **FOCUS <bus> 16** — `FOCUS PADS 16`: every other FX bus eases 60% low-passed for n bars, then releases. A spotlight without touching any fader. Never available on BassBus targets (setmap rule stands: bass filters only move in BREATH, HP only).
- **VEIL 8** — send F (Hangup) swells hard on Pads+Leads for n bars then returns: a smeared freeze-wash that dissolves naturally.
- **SWELL <return> 16** — generic single-send gesture: `SWELL B 16` = Large Hall bloom across Pads/Leads/Perc.
- **PULSE 16** — gentle transport-synced sine (1-bar period, small depth) on send D across Perc+Leads for n bars. Subtle rhythmic delay-breathing. Depth capped low in setmap; this is felt, not heard.

### Sequences

Clip name grammar extension: `SEQ name > name > name`, e.g. clip named `SEQ RISE 16 > CLEAN SLATE > BLOOM 16`. The engine runs them back to back on bar boundaries. Ship four pre-built sequence clips:

- `SEQ RISE 16 > CLEAN SLATE > BLOOM 16` — the ceremonial drop: build, vanish, re-bloom.
- `SEQ NIGHTFALL 32 > HORIZON 64` — settle into the deep hours.
- `SEQ DISSOLVE 16 > BREATH 8 > DISSOLVE BACK 8` — loops melt, one inhale, loops return.
- `SEQ WASH 16 > TIDE OUT 32` — wet, then gone.

A new clip-launch mid-sequence supersedes the sequence cleanly. CLEAN SLATE always wins.

### ALIVE mode (toggle, default OFF)

Background micro-drift: ±1.5% slow random walks on send B/C across Pads and Leads, period 2–4 bars, hard-bounded in setmap. Suspends itself during any active move, resumes after. The point: ten hours of static sends is the enemy; this keeps the room breathing when hands and feet are busy. OFF switch on the device and on the dashboard. If in doubt at the gig, it stays off — it must be boring to be correct.

## SENTINEL v2

Unchanged core loop. Added:

- **Trend display**: 60-second sparkline per bus on the dashboard, so "why did it trim Pads" is answerable at a glance.
- **Soft-knee zone**: between -3 dB and -1 dB of headroom, trims engage at half slew. Full slew only past the ceiling.
- **Event log**: every trim engage/release is a telemetry event with the meter values that justified it.

## Safeguards v2 (the hardening pass)

1. **Exception jail**: every js entry point wrapped; an exception increments a visible error counter, releases that subsystem's grabs, and keeps the rest alive. Three exceptions in 60 s = subsystem self-disables, dashboard goes red, set keeps playing untouched.
2. **Heartbeat**: both devices blink a beat-synced heartbeat to the dashboard. A stale heartbeat is a red banner. Silence is never ambiguous.
3. **Range sentries**: before any ramp, captured value must be inside the parameter's expected range from setmap. Outside = someone/something else owns it right now = skip that parameter, log it, run the rest of the move.
4. **Tempo-change resilience**: bar timing re-derives from plugsync~ continuously. A Link tempo jump mid-move bends the ramp, never breaks it.
5. **Transport stop**: all grabs release, sentinel freezes, ALIVE suspends. Transport start resumes sentinel only (moves never auto-resume).
6. **Show mode switch**: REHEARSE / SHOW on both devices. SHOW silences all console posts (CPU), locks dry-run off, locks calibration values, caps telemetry rate.
7. **Session log**: every command, ramp, trim, and error appended to `logs/<date>-show.jsonl` via node.script. Post-gig you can replay the night.
8. **State persistence**: pattr-backed; saved with the set. A mid-show Live crash + reopen recovers trims at safe last values and all moves cleared.
9. **Kill order**: CLEAN SLATE clip (Push grid) → ABORT button (device) → delete device (freebang releases) → v4 fallback set. Four layers, each independent.

## Dashboard (the live monitoring UI)

Node for Max (`node.script`) inside Sentinel's shell serves `http://localhost:7777` — open it on the laptop, or on the iPad Mini in a browser tab next to touchAble. **One-way telemetry only**: the dashboard renders state, it cannot send control. If node dies, devices play on unaffected; dashboard auto-reconnects via websocket.

Layout (single dark screen, readable from standing, no scrolling):

- **Top strip**: beat clock, bar count, tempo, heartbeats (two pulsing dots), SHOW/REHEARSE badge.
- **Bus row**: six meters with SENTRIM values and 60 s sparklines. Main headroom bar with ceiling line.
- **Conductor panel**: active move/sequence name huge, progress bar in bars, what it's touching, next queued step.
- **Alert lane**: unresolved names, exceptions, stale heartbeat, range-sentry skips. Empty = thin green line.
- Aesthetic: near-black warm ground, amber/rust/teal accents, JetBrains Mono numerals, Bricolage display for the move name. No animation except meters and the heartbeat.

## LINK SAFETY CONTRACT (absolute — other musicians' rigs are on this session)

This laptop shares Ableton Link with Eduardo's rig and possibly others. Tempo and transport are **shared state for the whole room**. Therefore:

1. **Tempo is read-only everywhere.** No code path may ever write `live_set tempo`. The resolver hard-refuses to return tempo as a writable target. Phase 6 self-review greps the codebase for tempo writes, `start_playing`, `stop_playing`, and `continue_playing` — any hit is a build failure.
2. **Transport is never written.** Not even on CLEAN SLATE. Clip and parameter operations only; clip launching does not propagate over Link.
3. **No code ever launches scenes.** The conductor fires clips on its own track only. This matters doubly here: 11 scenes in this set carry baked tempos (89–121), and with Link, launching one re-tempos *Eduardo's machine*, not just this one. Human fingers can do that on purpose; code never does it at all.
4. **Start Stop Sync: recommend OFF** in Link preferences, so a stray spacebar on this laptop can't stop the room. RUNBOOK.md documents this as a pre-show settings check (not API-readable, so it's a human line on the ritual board).
5. Tempo jumps arriving *from* Link are inputs the ramp engine bends around (already specced). The system listens to the room's tempo; it never speaks it.

## RITUAL (one-button pre-show automation)

A RITUAL button on Sentinel (auto-runs on set load in REHEARSE mode, manual-only in SHOW). Two halves:

**Fix (parameters the system may set):** center all six DJ Control params and the crossfader; EQ Three on 6 Melodies to unity; CL lane faders to 0 dB; all six CL tracks armed, Monitor Off; capture tracks Monitor In; SENTRIM gains to 0; all conductor-owned macros to rest values; restore HELIX CAPTURE IN TRIM and FADE to the calibrated marks stored in the setmap (ritual-time only — these remain hands-off during performance).

**Verify (display-only, green/red on the dashboard ritual card):** every setmap name resolved; scene-tempo audit (list which scenes carry tempos — flag, never fix, see Link contract); tempo at opening value; ALIVE off; SHOW mode state; plus two human-only lines rendered as checkboxes because the API can't read them: buffer = 128, Link Start Stop Sync = off.

Green board = walk on stage thinking about music. This replaces the manual 30-second ritual entirely except the two human lines.

## Auto-mix upgrades (Sentinel v2.1)

1. **Loop census feedforward.** The API exposes which CL clips are playing. Sentinel counts active loop layers per bus and tightens its deadband as layers stack — it expects level creep at 3 layers deep on Pads and meets it early, instead of reacting late. Free via API, no audio taps.
2. **Capture-level sanity event.** When a CL clip finishes recording, telemetry logs that bus's meter delta over the next 8 bars. Not control — evidence. If a lane consistently comes back hot or cold, CALIBRATION.md gets a number instead of a feeling.
3. **NIGHT ARC (optional, default OFF).** A 10-hour set has an energy shape. Optional governor: a slow target curve for overall level across the night (e.g., -0 dB at midnight, easing -2 dB by 4 a.m.), expressed only through the existing SENTRIM clamps' release bias. ±2 dB total authority, dashboard-visible, one toggle. If it isn't obviously right in rehearsal, it ships disabled and stays a log overlay.
4. **Masking taps — explicitly out of scope.** Band-aware ducking would need analyzer devices in the audio path, which violates rule zero. The static EQ carving on the buses already does this job; the sentinel works the level dimension only.

## Prep, calibration, tests

Manual prep unchanged from v1 (SENTRIM ×6, CONDUCTOR track + clips incl. the four SEQ clips, save as v5). Calibration pass unchanged plus: PULSE depth and ALIVE bounds get set by ear and written to setmap. Test plan unchanged plus: **tempo-jump test** (fire HORIZON, jump Link tempo 94→110 mid-arc), **node-kill test** (kill the dashboard process mid-move; control must not flinch), **sequence supersede test**, **crash-recovery test** (force-quit Live mid-move, reopen, verify state), **Link contract audit** (grep proof that no code writes tempo/transport/scene-fire), and **RITUAL test** (scramble filters, EQ3, CL faders and arm states by hand, press RITUAL, verify a green board).

## Overnight session plan (for the terminal)

Phase 1: resolver.js + dry-run skeletons for both devices, SHELL-BUILD.md. Phase 2: conductor ramp engine + moves.js + sequences. Phase 3: sentinel loop. Phase 4: telemetry + dashboard. Phase 5: hardening pass against the safeguards list. Phase 6: self-review — re-read this spec top to bottom and diff against the code. Human checkpoints: shell build (~15 min in Max editor, follow SHELL-BUILD.md), then calibration, then soak.
