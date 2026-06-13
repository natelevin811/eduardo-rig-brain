# STATUS.md — build status (updated 2026-06-13, post track-move fix)

## 2026-06-13 — CONDUCTOR track is now position-proof (build `2026-06-13i`)

Eduardo dragged the CONDUCTOR track to track 20 and commands went dead. Root
cause: name resolution was already position-independent, but `Resolver.track`
handed back a LiveAPI pinned to the **index path** (`live_set tracks N`) it
searched with — an index path names a SLOT, so the cached handle and the
command observers built on it silently followed whoever slid into the old slot
after the reorder. Fix, at the bottom of the stack so the whole rig inherits
it: `Resolver.track`/`returnTrack` now return an **id-pinned** handle
(`new LiveAPI('id ' + t.id)`), which follows the named object to any position.
`conductor.js` also binds its `playing_slot_index`/`fired_slot_index` observers
and every clip-slot access by `'id ' + ct.id`, and rebinds if the track's id
changes (delete+recreate). So: **move CONDUCTOR anywhere — by name it works.**
No need to move it back. Sentinel bus-meter reads inherit the same id-pinning.
Link grep re-proven (raw api.set/call only inside Resolver.set/call); ES5 clean;
`node --check` passes. UNVERIFIED on rig: confirm a pad press registers after a
live reorder (drag CONDUCTOR, launch WASH 16). Out-there ideas → GitHub backlog.

Dashboard: DJ-filter rows got a bipolar **deflection fill** (a bar from the
center detent out to the dot) so each hand-ridden filter's direction + amount
reads at a glance instead of a lone floating dot. Read-only telemetry, no rig
risk. Hard-refresh `localhost:7777` to pick it up.

## ⏭ NEXT TEST (Eduardo, at the laptop — single most important thing)

On build `2026-06-13d retrigger` (main `ef98800`, pulled): press TEST once
(re-inits + proves build), play, press **RISE 16 once**, hands off for all 18
bars (~36 s). Read the `drive` alerts at bars 0/4/8/12/16: v climbing toward
127 by bar 12 = moves were always fine (exp curves are back-loaded — judge at
bars 11–16, by ear too); v still ~0 at bar 12 = curve math guilty, fix from
the numbers. Also note whether the G clip (42-She) + noise clip (WhiteNoise)
fire. This is the only open engine question.

## Migration scorecard (2026-06-13, after day-2 session)

PROVEN on the performance machine: name resolution all-clean (Utility gain =
`Output` here — setmap candidates), full-green RITUAL incl. HELIX marks, exact
fallback clock (plugsync~ feed is beats-not-ticks on this Max — trust gate
rejects it), FROZEN tracks transport via 2 Hz poll (is_playing observer never
fires here), grab pool physically moves params (send + DJ probes, drive +
restore), command clips arm/supersede/sequence, cold-open recovery (retry
ladder ~3 min + TEST/RITUAL re-resolve + they re-init a blanked brain after a
pull — re-drag is never needed anymore), build stamps everywhere, dashboard
alert lane scrollable with ↻ replay marking, drive-trace mirrors engine
values to the dashboard. Link-contract grep re-proven post-changes (only hits
= resolver's own refusal tables).

UNVERIFIED (rehearsal-grade, needs eyes/ears): the NEXT TEST above; single
press always registering (13d fired_slot_index fix — written, untested);
sentinel trim engage/release (never yet pushed MAIN over the 0.92 ceiling for
4+ s); SENTRIM knobs at 0 dB + HELIX TRIM 7.78 / FADE −5.89 after RITUAL
(Output dB-nativeness eyeball); Fade direction (C2, setmap says VERIFY);
whole move repertoire by ear incl. SEQ clips, CLEAN SLATE, ABORT mid-move,
ALIVE drift; full RIG-TEST.md + soak pass.

LOOSE ENDS: `get: no valid object set` console flood — source unconfirmed
(recheck in a cleared Max window with a single fresh device pair, idle);
EADDRINUSE:7777 after Live restarts (orphan node server — full Live quit
clears; keep exactly one SENTINEL); browser SSE reconnects often (harmless,
↻-marked); human checks: buffer 128, Link Start Stop Sync OFF; performer to
confirm LoDrumsBus −106 dB / PercBus −86 dB faders are intentional and
PadsBus send B home position (probes once stranded it at 1.0).

## Performance-machine migration (2026-06-12 afternoon)

The performance machine's Live build exposes Utility's gain knob to the LOM as
**`Output`**, not `Gain` (param dump: 12 params, `... Balance, Output, Mute,
DC Filter` — no `Gain`). That single rename explained all 7 unresolved names
(SENTRIM ×6 + HELIX TRIM) and the failing HELIX-marks ritual step. Fix:
`sentinel_targets.utility_gain_param_candidates = ["Gain","Output"]` in the
setmap (law), consumed at both Utility-gain call sites in sentinel.js. The
resolver also now lists a device's actual param names whenever a param fails
to resolve — that diagnostic is what caught this.

**Verify on the rig after pulling** (re-drag SENTINEL): ritual should show
HELIX marks ✓ and 0 unresolved; then eyeball that SENTRIM knobs physically sit
at 0 dB and HELIX TRIM at 7.78 dB — dB-nativeness of `Output` on this Live
build is assumed from Q4 but not yet observed (if knobs slam to an extreme,
it's a unit remap, report it). Earlier in the session the same machine was
running pre-fix code via a stale iCloud copy (filters slammed to −100%,
dead clock) — resolved by pulling the branch; treat git, not iCloud, as the
delivery channel.

## First rig test (2026-06-12) — what broke, what's fixed

Live test on the gig laptop surfaced four real failures; all fixed, reviewed
(second-model adversarial pass: verdict SHIP), gates clean:

1. **DJ filter domain inverted (show-killer).** The real "Control" param is raw
   0..1 with CENTER = 0.5 (display −100%..+100%); code modeled −1..1/center 0.
   RITUAL + CLEAN SLATE slammed all six filters to −100%; sentries rejected the
   true center so BREATH/FOCUS could never run. Fixed in setmap law (+ moves
   TUNING re-expressed: breath −62%, focus −60% display; sentry [0.35,0.65]).
2. **Conductor's beat clock dead (show-killer).** plugsync~ chain delivered no
   sync on the rig: moves armed (visible on dashboard) but bar stayed 0 — no
   ramp ever drove. BOTH brains now self-clock by polling live_set
   current_song_time (READ-only — Link-safe; writes to it are refused by
   FORBIDDEN_PROPS): conductor 33 ms Task, sentinel inside its 10 Hz tick. Real
   plugsync~ sync wins when present; fallback stands down.
3. **Load-race unresolved names.** SENTRIM/HELIX Gain params invisible during
   set build at device-load. Both brains retry resolution 3× (4 s apart),
   observers/auto-RITUAL once-guarded, grabs released before each retry pass.
4. **RISE / ShephardsTone reworked (rig directive).** Now fires the first
   letter clip (G/C/F/Ab/C#/F#) and swells the unnamed rack's "Output" macro
   (resolved BY CLASS — rack has no name), ducks 2 bars, stops the clip after
   the duck. Track volume no longer touched. CLEAN SLATE returns the knob to
   its at-load position.

Plus: device faces now open in presentation mode (~480 px tidy face — was the
full 3600 px patching canvas); CONDUCTOR face has a **TEST** button → `grabtest`
probe (wiggles PadsBus send B for 1.5 s with console posts) to isolate
live.remote~ pool failures from engine failures.

**On-rig steps after pulling:** replace BOTH devices with the new iCloud .amxd
(pattr state resets — re-set mode), launch WASH 16 with transport running: bars
must advance now (fallback clock). If dashboard ramps but knobs still don't
move, press TEST and read the Max console. Known-accepted: tempo flag (setmap
says opening 94, set is at 81 — flag-only), stale-heartbeat banner when
transport is stopped.

---

# Original build log — 2026-06-11 overnight session

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

## Set prep — AUTOMATED (2026-06-12)

`tools/prep-set.py` performed the SHELL-BUILD §3 Live-set prep on a copy:
**`6.7.3_eduardo_2026_STAGE_v6.als`** (iCloud, next to v5; v5 untouched =
kill-order layer intact). SENTRIM Utility ×6 appended at end of each bus chain
(0 dB, fully neutral) + CONDUCTOR MIDI track (no output, collapsed, last
position) with all 19 named command clips in the first 19 scenes.

Verified by `tools/verify-set.py` (pointee-id uniqueness incl. the
ControllerTargets.N space, PointeeId reference resolution, baseline diff
accounting) AND by an independent adversarial review agent, whose first pass
caught a real BLOCKER (139 duplicated pointee ids on cloned
ControllerTargets/FreezeSequencer targets — six ShephardsTone clip envelopes
were at rebind risk). Fixed, regenerated, re-reviewed: reviewer removed the
additions from v6 and got a **byte-identical** match to v5. Verdict: SHIP.

Key representation fact discovered: **Utility Gain `Manual` is stored LINEAR in
.als XML** (10^(dB/20); 0 dB == 1.0) even though UI/LOM are dB-native. A naive
"0" would have muted all six buses.

Both finished devices also copied to iCloud next to the sets:
`CONDUCTOR.amxd`, `SENTINEL.amxd`.

## Needs human hands (in order)

1. **Open v6 in Live** (first open of a script-modified set: eyeball tracks,
   audio passes, SENTRIM ×6 visible at chain ends, CONDUCTOR track + 19 clips).
   Note: set was last saved by Live 12.4.1; this machine has 12.3.2 — any
   newer-version warning predates our edits (v5 shows it too).
2. **Max search path** (SHELL-BUILD §0, one time), then drag `CONDUCTOR.amxd`
   onto 40 Master FX and `SENTINEL.amxd` onto Master. Expect "all setmap names
   resolved clean" ×2 — the two previously-missing name groups now exist.
   Confirm `live.*` face controls + pattr param-mode in the inspector (taste).
2. **Calibration pass** (docs/CALIBRATION.md C0–C10) — C0 (plugsync~ scaling),
   C1 (DJ polarity), C2 (Fade direction), C8 (meter scale + SENTRIM dB) are
   load-bearing; the rest are taste.
3. **Soak** (test/soak-checklist.md). Living-room law: doesn't pass → v4 plays.

## Shell-generator review pass (2026-06-12, second-model review)

Narrow review of `tools/build-shells.mjs` output against Max 9.0.9 refpages +
Ableton's shipped M4L patches found and fixed **4 real wiring bugs** in the
first-cut generated shells:

1. **live.remote~ id cords → wrong inlet.** `id` binds via the RIGHT inlet
   (inlet 1; confirmed in M4L.SignalToLiveParam). All 48/14 id + freebang-release
   cords went into inlet 0 → no grab would ever have bound.
2. **pattr bound via outlet 0.** Binding is the MIDDLE outlet (1, "bindto
   connection") → state persistence would silently not bind.
3. **live.text mode inverted.** Refpage: 0=Button, 1=Toggle. ABORT/RITUAL were
   toggles (latching abort!), ALIVE/DRY-RUN/NIGHT ARC were buttons.
4. **Buttons routed through [sel 1].** Button mode emits a *bang* — sel 1 never
   matches → ABORT/RITUAL would never have fired. Now wired direct to messages.

All four are the kind of thing the smoke test would have caught at the gig-prep
table, but now they're caught at build time: `tools/verify-shells.py` is a
permanent static gate (id collisions, real inlet/outlet ranges, the four
semantics above, clock-outlet-6, slot counts). Both devices verify CLEAN.
Remaining true unknowns are runtime-only: does Live accept the injected
template clone, and C0 clock-speed sanity. **Max-editor eyeball still required.**

## Name-resolution pre-flight (static, against v5 set, 2026-06-12)

Parsed `6.7.3_eduardo_2026_STAGE_v5.als` (104 MB XML) and matched every
resolve-by-name target. **Resolves clean (exact names present):** LoDrums/HiDrums/
Perc/Bass/Pads/LeadsBus; `DJ Filter Soft Clip` on all six (LeadsBus's is inside
its rack — resolver's recursive case, confirmed); `40 Master FX` / `Nate & Will
Master FX`; CL#1-6; `WhiteNoise`/`KnobRiser`; `42-ShephardsTone`; all six returns
A–F; `HELIX CAPTURE IN` with `TRIM`+`FADE`; `6 Melodies` EQ Three; REC FEED + Cptr.

**Still absent in the set (the two manual-prep ADDs — expected):**
1. `SENTRIM` Utility on the six buses — **0 found**. SENTINEL will red-text all
   six until added.
2. `CONDUCTOR` MIDI track + named command clips — **0 found** (`WASH 16`, `TIDE
   OUT`, `CLEAN SLATE`, etc. all absent). CONDUCTOR has no track to observe until
   created.

So "all setmap names resolved clean" in the smoke test will NOT pass until those
two ADDs are done — by design, and they'll surface as red text, not silent fail.
Minor: setmap said WhiteNoise has 16 noise clips; set has 8 (`30-P-LASK Noise
Generator 1`). RISE fires *any* clip, so non-blocking.

## Open questions (setmap ambiguities)

### Resolved 2026-06-11 (gig-laptop session, set open)

- **Q1: "6 Melodies" / EQ Three** — ✅ RESOLVED. Track name confirmed `6 Melodies`,
  device `EQ Three`, unity = all three gains 1.0. Added to setmap as
  `ritual.eq_three_unity` (documented law). Code unchanged — the RITUAL fix
  already sets these via `default_value`, which equals unity.
- **Q2: HELIX capture marks** — ✅ RESOLVED. `setmap.ritual.helix_marks` written
  with values read directly off the gig set: track `HELIX CAPTURE IN`,
  `TRIM` Gain **7.78 dB**, `FADE` Gain **−5.89 dB** (param `Gain`). FADE is
  −5.89, not the 0 dB first recalled — confirmed −5.89 is the intended mark.
- **Q4: SENTRIM Gain units** — ✅ RESOLVED by observation. The HELIX Utility
  `Gain` params display in dB in the device UI, so Utility Gain is dB-native.
  SENTRIM is the same Utility device type → dB-native, no `writeTrim` remap
  needed. C8 step 2 remains a formality (confirm min ≈ −35); no mapping expected.
- **Q3: capture tracks** — ✅ RESOLVED against the gig set. Tracks
  `CptrPercAudio/Midi`, `CptrBssAudio/Midi`, `CptrPdAudio`, `CptrLdAudio`
  (match `Cptr`) and groups `PERC/BASS/PAD/LEAD REC FEED` (match `REC FEED`).
  `HELIX CAPTURE IN` also needs Monitor=In but matches neither, so `HELIX
  CAPTURE` was added as a third substring to the RITUAL Monitor-In fix.

### Still open

- **Q5: plugsync~ outlet scaling** — ✅ RESOLVED against the Max 9.0.9 bundle
  (the M4L runtime inside Live 12; the standalone Max 7.3.6 in /Applications is
  unused). `plugsync~` has no signal outlet; **outlet 6 = raw ticks** (cumulative,
  tempo-independent), beats = ticks / **480**. The generator wires exactly this.
  C0 is now just a confirm-the-speed sanity check, not an open question.
- **Q6: BLOOM/SUNRISE send return-shape** — current build returns sends to
  captured over the last quarter of the move (nothing ends displaced except
  NIGHTFALL/DISSOLVE holds). **Resolve in the room** by ear.

### Resolve in the room

- **Reset phases** — RITUAL/restore phase tuning to be finalized in the actual
  venue room (per 2026-06-11 session). Q6 folds into this.
