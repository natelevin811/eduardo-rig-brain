# SHELL-BUILD.md — building the two .amxd shells

## Fastest path: generate them (recommended)

`tools/build-shells.mjs` writes both finished devices by cloning Ableton's own
empty **Max Audio Effect.amxd** and injecting every object + patch cord this doc
describes — including the tedious 24× / 7× `live.remote~` grab pools. No hand-wiring.

```
node tools/build-shells.mjs        # -> build/CONDUCTOR.amxd, build/SENTINEL.amxd
python3 tools/verify-shells.py     # static review gate — must print CLEAN ×2
```

The verifier checks the generated JSON against *real* Max 9 object semantics
(refpages + Ableton's shipped M4L patches): live.remote~ id cords into the
RIGHT inlet, pattr middle-outlet binding, live.text mode 0=Button/1=Toggle,
buttons wired direct to messages (button mode emits bang — [sel 1] never
fires), inlet/outlet ranges, id collisions, the documented init/clock chains,
and 24/7 grab-slot counts. Run it after any generator change.

Then:

1. Do **§0 (search path)** below — one time, still required so the brains and
   `server.js` resolve by name.
2. Drag `build/CONDUCTOR.amxd` onto the **40 Master FX** track, `build/SENTINEL.amxd`
   onto the **Master** track.
3. Do **§3 (Live-set prep)** and **§4 (smoke test)** below.

The generator targets the Max-for-Live runtime **9.0.9** (bundled in Live 12) and
was verified against that bundle's patcher schema + `plugsync~` outlet map. The
clock is wired correctly-by-construction: `plugsync~` **outlet 6 (raw ticks)** →
`[/ 480.]` → `[speedlim 33]` → `[prepend sync]` — this resolves the old Q5/C0
"beats vs ticks" unknown (it's raw ticks; divisor 480). The `.js` brains
hot-reload (`autowatch = 1`), so a generated shell never needs reopening.

Two things to confirm in the Max editor once (taste/polish, not wiring): the
device-face `live.*` controls and status displays may want inspector tweaks
(red text, toggle vs button mode), and `pattr` parameter-mode persistence. Core
function — clock, grabs, telemetry, init — needs nothing.

Re-run the generator any time; it's idempotent and clobbers `build/`.

---

## Manual path (fallback / reference, ~15 min in the Max editor)

Both devices are **Max Audio Effect** (.amxd) shells whose only job is plumbing:
clock in, js brain in the middle, live.remote~ pool and telemetry out. All
logic lives in the `.js` files so everything hot-reloads while the shells stay
untouched (`autowatch = 1` is already set in both brains).

## 0. Search path (once)

**Fastest way — one symlink, no clicking** (Max searches its User Library
recursively by default):

```
ln -sfn ~/code/natelevin/eduardo-rig-brain ~/Documents/Max\ 9/Library/eduardo-rig-brain
```

Manual alternative: Max → Options → File Preferences → add these folders (subfolders ON):

```
eduardo-rig-brain/shared/
eduardo-rig-brain/setmap/
eduardo-rig-brain/conductor/
eduardo-rig-brain/sentinel/
eduardo-rig-brain/dashboard/
```

This is how `include("resolver.js")` and `Resolver.loadSetmap("eduardo-setmap.json")`
find their files. If a brain posts `setmap file not found in search path`, fix
this first.

## 1. CONDUCTOR.amxd

Drop it on the **CONDUCTOR MIDI track's** audio-effect-free neighbor? No —
it's an audio effect: put it on the **40 Master FX** track (post everything,
processes nothing; it only passes audio through untouched).

### Objects

```
[live.thisdevice]                      → bang on load
        |
      [t b b]
        |    \
   (defer)  [message: init] → [js conductor.js] (1 inlet, 3 outlets)

[plugsync~]   outlet 6 = raw ticks (cumulative, float — NOT a signal)
   |
[/ 480.]                                ticks → beats (Live/Max PPQ = 480)
   |
[speedlim 33]                           throttle to ~30 Hz
   |
[prepend sync] → js inlet               sends "sync <beats_float>"
```

Confirmed on Max 9.0.9: `plugsync~` has **no signal outlet**, so there's nothing
for `snapshot~` to sample — drive the chain off **outlet 6 (raw ticks)** instead.
Raw ticks is cumulative since song start and tempo-independent; `/ 480.` converts
to beats. (Outlet map: 0 play/stop · 1 bar · 2 beat · 3 tick · 4 timesig · 5 tempo
· 6 raw ticks · 7 sample count · 8 flags.) If motion runs at the wrong speed,
this divisor is the C0 calibration knob.

### Grab pool (outlet 0)

js outlet 0 emits lists: `<slot> id <paramId>`, `<slot> val <float>`, `<slot> id 0`.

```
js outlet 0
   |
[route 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23]
   |each
[route id val]
   |        \
[prepend id] [live.remote~]    ← one live.remote~ per slot, 24 total
      \________/
   (id messages bind/unbind, val floats drive)
```

Duplicate-paste the slot column 24 times. Tedious once, never again.
**freebang**: add `[freebang] → [id 0( → all live.remote~` so deleting the
device releases every grab even if js never runs (kill-order layer 3).

### Telemetry (outlet 1)

```
js outlet 1 → [s rigbrain-telemetry]
```

### UI (outlet 2)

js outlet 2 emits `ui <key> <value>`. Route to the device face:

```
[route ui] → [route unresolved missing mode alive dryrun errors disabled]
```

- `unresolved <n>`  → if n > 0: set a [live.comment] to red ("n NAMES UNRESOLVED").
- `missing <name>`  → append into a [umenu] or post — the red-text list.
- `errors <n>`      → error counter [live.numbox].
- `disabled 1`      → big red [live.text] "CONDUCTOR DOWN".

Device face controls (all → messages into js inlet):

- [live.text] toggle **ALIVE**     → `alive $1`
- [live.text] toggle **DRY-RUN**   → `dryrun $1`
- [live.tab]  REHEARSE/SHOW        → `mode REHEARSE` / `mode SHOW`
- [live.text] button **ABORT**     → `abort` (kill-order layer 2)

### pattr

```
[pattr conductor_state @bindto nothing] — bind a [pattr] to the js object
   (pattr conductorbrain @invisible 1) → connect middle outlet to js
```
Simplest reliable form: `[pattr state] → [js conductor.js]` left-to-left with
*parameter mode enabled* on the pattr so it saves with the set. The js
implements `getvalueof`/`setvalueof`.

## 2. SENTINEL.amxd

Lives on the **Main/Master track** (it only reads meters and writes SENTRIM
gains — no audio processing; the .amxd passes audio straight through).

Same skeleton as the conductor with these differences:

- `[js sentinel.js]` (1 inlet, 3 outlets)
- Grab pool: **7** live.remote~ slots (route 0-6) — six SENTRIMs + one spare.
- plugsync~/snapshot~/prepend sync → identical.
- Telemetry: js outlet 1 → **node.script directly** AND nothing else (the
  dashboard process lives in this shell):

```
[js sentinel.js] outlet 1 ──┐
[r rigbrain-telemetry] ─────┤ (conductor's events arrive here)
                            ↓
                   [node.script server.js @autostart 1 @watch 1]
```

- Device face: RITUAL button → `ritual`, NIGHT ARC toggle → `nightarc $1`,
  REHEARSE/SHOW tab → `mode ...`, DRY-RUN toggle → `dryrun $1`,
  unresolved/error/disabled UI same as conductor.
- pattr same pattern (persists mode + last trims).

**node.script notes:** set `@defer 1` if message order ever matters; if the
node process dies, [node.script] reports it on its right outlet — optionally
wire that to a comment, but by design nothing else cares (isolation contract).

## 3. Manual Live-set prep (from the spec, unchanged)

1. Add a **Utility named `SENTRIM`** at the END of each of the six bus chains
   (LoDrums/HiDrums/Perc/Bass/Pads/Leads). Name the device itself `SENTRIM`
   (double-click the title bar). Gain at 0.
2. Create MIDI track named **CONDUCTOR**, no output, collapsed, last position.
3. Add empty MIDI clips named exactly:
   - `WASH 16`, `TIDE OUT 32`, `BREATH 8`, `BLOOM 16`, `RISE 16`,
     `DISSOLVE 16`, `DISSOLVE BACK 8`, `CLEAN SLATE`
   - `HORIZON 64`, `SUNRISE 32`, `NIGHTFALL 32`, `FOCUS PADS 16`,
     `VEIL 8`, `SWELL B 16`, `PULSE 16`
   - `SEQ RISE 16 > CLEAN SLATE > BLOOM 16`
   - `SEQ NIGHTFALL 32 > HORIZON 64`
   - `SEQ DISSOLVE 16 > BREATH 8 > DISSOLVE BACK 8`
   - `SEQ WASH 16 > TIDE OUT 32`
4. Global launch quantization: **1 bar** (it already is, per setmap).
5. Save as **v5**. v4 stays untouched on disk — it is kill-order layer 4.

## 4. Smoke test

1. Open v5, add both devices. Max console should post
   `all setmap names resolved clean` twice. Anything else = fix names first.
2. `http://localhost:7777` → dashboard up, two heartbeat dots pulsing once
   transport runs.
3. DRY-RUN on, launch `WASH 16` → dashboard shows the move, bars advance,
   nothing in Live moves. DRY-RUN off → launch again → sends move and return.
4. Press ABORT mid-move → everything snaps to rest on the spot.
