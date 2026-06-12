# STATUS.md — build status, 2026-06-11 overnight session

## Phase 1 — resolver + skeletons ✅
**Done:** `shared/resolver.js` (name-based resolution, recursive rack-chain
device search for the LeadsBus case, missing-name collection for red-text UI,
setmap JSON loading, LINK CONTRACT enforced at the write layer — `Resolver.set`
/ `Resolver.call` are the only paths to `api.set`/`api.call` in the codebase
and they refuse tempo writes, transport verbs, and scene fire unconditionally).
`shared/telemetry.js` (one-way emitter, SHOW-mode rate caps, beat heartbeat).
**Untested:** everything until the shells exist — needs Max + the v5 set.

## Phase 2 — conductor ✅
**Done:** `conductor/moves.js` — all 15 moves (8 originals + HORIZON, SUNRISE,
NIGHTFALL, FOCUS, VEIL, SWELL, PULSE) as declarative bar-domain segment data;
clip-name grammar incl. `SEQ a > b > c`, args (`FOCUS PADS`, `SWELL B`),
FOCUS-on-bass rejection. `conductor/conductor.js` — beat-domain ramp engine
(tempo jumps bend ramps for free, since time is counted in beats from
plugsync~), capture/restore with explicit restore segments, live.remote~ grab
pool protocol (grab only during ramps), sequences with clean supersede, CLEAN
SLATE (bar-aligned, supersedes all), ALIVE (API-set micro-drift, hands-win
re-baselining, hard ±1.5% bounds, suspends during moves), range sentries,
dry-run, SHOW/REHEARSE, exception jail, transport-stop release, pattr
persistence (mode survives; moves cleared + ALIVE forced off on restore).
**Untested:** all engine behavior — needs living-room run (test/soak-checklist.md).

## Phase 3 — sentinel ✅
**Done:** `sentinel/sentinel.js` — 10 Hz meter poll, dominant-bus law over the
4 s attack window, soft-knee half-slew below ceiling / full slew past it,
per-bus clamps (-3 dB, LoDrums -2 dB), slow release after the 12 s comfort
window, loop-census feedforward (stacked CL layers widen the engage knee),
capture-level sanity events (8-bar before/after delta, evidence not control),
NIGHT ARC (default OFF, release-bias only, ±2 dB cap), RITUAL (fix + verify,
auto-run on load in REHEARSE only), exception jail, transport freeze, pattr
trim recovery.
**Untested:** all of it; the 0.025-per-dB meter approximation and SENTRIM
Gain dB-nativeness need the C8 calibration check.

## Phase 4 — telemetry + dashboard ✅
**Done:** `dashboard/server.js` (node.script, http://localhost:7777, SSE
fan-out, state replay on connect, session log `logs/<date>-show.jsonl` with
high-rate-event thinning). `dashboard/index.html` (single file: top strip with
beat/bar/tempo/heartbeats/mode, six bus meters + SENTRIM values + 60 s
sparklines, main headroom bar with ceiling line, conductor panel with huge
move name + bar progress + touching/next, alert lane that collapses to a thin
green line when empty, ritual card, stale-heartbeat red banner, auto-reconnect).
**Deviation (deliberate):** spec said "websocket"; built on **SSE** instead —
identical one-way wire, but structurally incapable of carrying control
upstream, native auto-reconnect, and zero npm dependencies inside node.script.
If you want literal websockets it's a 30-line swap, but I'd argue against.

## Phase 5 — hardening ✅
Safeguards 1–9 implemented as specced. Mid-build review fixes: bar-start
rounding (moves were going to start one bar late because the clip observer
fires ms after the quantized bar line), NIGHT ARC reduced to release-bias-only
(first cut actively pulled trims down — spec forbids that), ALIVE telemetry
flood removed, sentinel pattr-restore race fixed (trims arriving before init
are now parked and applied after resolve).

## Phase 6 — self-review ✅
- `node --check` passes on all 6 JS files; ES5 audit clean (no let/const/
  arrows/templates in Max js files; modern Node only in dashboard/server.js).
- **Link contract grep proof** (run 2026-06-11, also in soak-checklist §G):
  - `tempo` writes: zero. Hits are the FORBIDDEN list, `readTempo()` (read),
    sentinel's read-only scene-tempo audit + tempo-at-opening verify.
  - `start_playing|stop_playing|continue_playing`: hits ONLY inside
    resolver.js's FORBIDDEN_CALLS refusal list.
  - `scene`: hits are the resolver's fire-refusal guard and the RITUAL
    read-only audit (`get('tempo')` on scenes; flag, never fix, never fire).
  - raw `api.set(`/`api.call(`: only inside `Resolver.set`/`Resolver.call`
    themselves. No bypass exists.

## Needs human hands (in order)

1. **Shell build** (~15 min, docs/SHELL-BUILD.md) + Live-set prep (SENTRIM ×6,
   CONDUCTOR track + 19 named clips, save as v5).
2. **Calibration pass** (docs/CALIBRATION.md C0–C10) — C0 (plugsync~ scaling),
   C1 (DJ polarity), C2 (Fade direction), C8 (meter scale + SENTRIM dB) are
   load-bearing; the rest are taste.
3. **Soak** (test/soak-checklist.md). Living-room law: doesn't pass → v4 plays.

## Open questions (setmap ambiguities — built around, flagged at runtime)

- **Q1: "6 Melodies" / EQ Three** — named in the spec's RITUAL but absent from
  the setmap. RITUAL resolves it by name and skips with a red card line if
  missing. Add the track/device to the setmap if it should be law.
- **Q2: HELIX capture marks** — RITUAL expects `setmap.ritual.helix_marks`
  (schema in CALIBRATION.md C9). Setmap has no such block yet; the ritual card
  shows the gap until calibrated values are written in.
- **Q3: capture tracks** — "REC FEED and Cptr tracks" have no setmap entries;
  RITUAL pattern-matches track names containing `Cptr` / `REC FEED` for the
  Monitor-In fix. Confirm those substrings match the real track names.
- **Q4: SENTRIM Gain units** — code assumes Utility Gain is dB-native
  (min ≈ -35). C8 step 2 verifies; if it reads 0..1 a mapping is needed in
  `writeTrim` (one function).
- **Q5: plugsync~ outlet scaling** — beats vs ticks differs by Max version;
  C0 catches it (worst case: one `[/ 480.]` in each shell).
- **Q6: BLOOM/SUNRISE send return-shape** — spec says sends "rise slightly";
  I return them to captured over the last quarter of the move (nothing may end
  displaced except NIGHTFALL/DISSOLVE which the spec marks as holds). Confirm
  musically.
