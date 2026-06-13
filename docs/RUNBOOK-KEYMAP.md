# RUNBOOK — keymap & controls

Everything you can press, what it does, and what is safe to move or rename.
Nothing here writes tempo, transport, or launches scenes — the rig only ever
touches the parameters listed below.

---

## 1. Command clips (the move surface)

Commands are **named MIDI clips on the `CONDUCTOR` track**. Launching a clip
issues the command; the device reads the clip's **name** and runs the move,
then stops the clip when the move finishes (the pad light goes dark on its own).
They appear as labeled pads on Push 3 and both iPads. Global 1-bar quantize
makes every command land on the bar line.

**Grammar:** `MOVE [bars] [arg]` — e.g. `WASH 16`, `FOCUS PADS 16`, `SWELL B 16`,
`CLEAN SLATE`. Leave the number off to use the default. Case-insensitive.

**Sequences:** `SEQ a > b > c` runs steps back-to-back, each superseding the
last cleanly — e.g. `SEQ RISE 16 > CLEAN SLATE > BLOOM 16`.

| Clip name | Default bars | Arg | What it does |
|---|---|---|---|
| `WASH` | 16 | — | Sends B+C swell wet on Pads/Leads/Perc, hold 4, return over n/2. |
| `TIDE OUT` | 32 | — | Master Fade + gentle LPF to near-silence; bass & low drums keep breathing (they bypass Master FX). Restores over n/2. |
| `BREATH` | 8 | — | LP-close DJ filters on HiDrums/Perc/Pads/Leads over n/2, release over n/2. Bass untouched. The underwater inhale. |
| `BLOOM` | 16 | — | Start LPF closed, open over n bars while send B rises slightly. All returned at end. (Also releases a held NIGHTFALL.) |
| `RISE` | 16 | — | Fire WhiteNoise + KnobRiser macro 0→1, ShephardsTone swell in parallel; at bar n duck back over 2 bars and stop the clips. |
| `DISSOLVE` | 16 | — | All six CL loop-layer faders fade to −∞. Loops evaporate, live playing stays. **Holds** — comes back only via `DISSOLVE BACK` or `CLEAN SLATE`. |
| `DISSOLVE BACK` | 8 | — | CL loop faders ramp back to 0 dB. |
| `CLEAN SLATE` | — | — | The reset button. On the next bar line: stop CL clips, CL faders to 0 dB, center all DJ filters, zero conductor macros, kill risers, **and roll every send the conductor moved back to where your hands had it**. Releases all grabs. Supersedes everything. |
| `HORIZON` | 64 | — | The long arc — one imperceptibly slow LPF + send-B breath over n bars, all returned. |
| `SUNRISE` | 32 | — | Snap to a veiled HPF/LPF band on the bar, then the set wakes up (filters + send C open) over n bars. |
| `NIGHTFALL` | 32 | — | Inverse of SUNRISE: slow narrowing into darkness. **Holds there.** Release with `SUNRISE`, `BLOOM`, or `CLEAN SLATE`. Pairs with `TIDE OUT`. |
| `FOCUS` | 16 | **target** | `FOCUS PADS` — every *other* FX bus eases 60% low-passed (a spotlight), then releases. Target ∈ `PADS / LEADS / PERC / HIDRUMS`. **Never bass** (setmap law). |
| `VEIL` | 8 | — | Send **F (Hangup)** swells hard on Pads+Leads — a smeared freeze-wash — then dissolves on the way back down. |
| `SWELL` | 16 | **letter** | `SWELL B` — single-send bloom across Pads/Leads/Perc. Arg is a return letter `A`–`F`. |
| `PULSE` | 16 | — | Transport-synced sine on send D across Perc+Leads, 1-bar period, depth low. Felt, not heard. Ends exactly on the captured value. |
| `ICHING` | 24 | — | **Off by default** — cast a hexagram, rendered in the 7777 window, that gently colors the space. See §6. Bounded, reversible, ABORT-able. |

Every move **captures** the current value of each parameter before it moves it
and returns to *that* value, not an assumed default — so it always honors
wherever your hands left the Twister/XL. A move on a parameter that's parked
outside its safe range is **skipped** (range sentry), shown on the dashboard.

---

## 2. Device-face buttons

### CONDUCTOR (on `40 Master FX`)
| Button | Type | What it does |
|---|---|---|
| **ALIVE** | toggle | Gentle idle drift on Pads/Leads sends so a held mix never sounds frozen. Hands always win; auto-suspends during moves. Off by default. |
| **DRY-RUN** | toggle | Engine runs and the dashboard shows everything, but **nothing is written into Live**. Rehearse silently. Locked off in SHOW. |
| **MODE** | REHEARSE / SHOW | REHEARSE: chatty, auto-RITUAL, full telemetry. SHOW: quiet, rate-capped, nothing automatic (and the dashboard auto-declutters). |
| **ABORT** | button | Kill the current move/sequence **now** — release all grabs, snap params to rest, roll moved sends home. Kill-order layer 2. |
| **TEST** | button | Grab-pool probe + re-resolve: nudges PadsBus send B and PercBus DJ to prove control works, and re-runs name resolution if anything is unresolved. Your one-button recovery after a cold open. |

### SENTINEL (on `Master`)
| Button | Type | What it does |
|---|---|---|
| **RITUAL** | button | Pre-show reset + verify: center DJ filters & crossfader, EQ unity, zero SENTRIM trims, set capture marks, re-resolve names. **Run before the set.** |
| **NIGHT ARC** | toggle | Slow over-the-night release bias — bus trims settle slightly low across the evening (max −2 dB). Off by default. |
| **MODE** | REHEARSE / SHOW | Same as conductor. |
| **DRY-RUN** | toggle | Compute & display headroom trims but write nothing. Rehearse the guard silently. |

---

## 3. Dashboard hotkeys (`localhost:7777`)

| Key | Action |
|---|---|
| `F` | STAGE / focus view — giant across-the-room move + headroom + beat. |
| `Tab` / `Shift+Tab` | (in stage) cycle views: Move · Timeline · DJ · Meters. |
| `Space` (hold) | Freeze a reference playhead on the loop timeline. Display only. |
| `E` | Edit layout — drag, resize, hide panels. Layout persists. |
| `Esc` | Exit stage / edit. |
| `C` | Clear the alerts lane. |
| `\` | Toggle between the **new** and **classic** dashboards (works both ways). |

In **SHOW** mode the dashboard hides the Log / Copy / Layout buttons and the
alerts scrollback so the screen is just the performance state. The critical
channel — the **stale-heartbeat / link-down red banner** — always shows.

`/classic` is the instant fallback UI, reachable mid-show with no terminal.

---

## 4. Can I move or rename the CONDUCTOR track & its clips?

**Move the CONDUCTOR track anywhere — yes.** It's resolved by name and pinned
by object id, so dragging it (even to track 20) never breaks commands. You do
not need to move it back. Same for every other named track the rig touches.

**Move the command clips to different scenes/slots — yes.** A command is keyed
by the clip's **name**, not its position, so rearranging which scene a clip
lives in changes nothing.

**Rename a command clip — yes, but the name *is* the command.** Rename
`WASH 16` to `TIDE OUT 32` and that pad now issues TIDE OUT. Rename it to
anything the grammar doesn't recognize and it simply does nothing (an
unrecognized clip is ignored; a recognized-but-malformed one shows a
`bad_command` alert on the dashboard) — it will never misfire. So you can
relabel pads freely; just keep the text a valid command if you want it to act.

**What you cannot do:** invent a *new* move by naming a clip something clever —
the move has to exist in the library above. New moves are code, not clip names.

---

## 6. The I Ching cast (`ICHING`) — optional, safe, killable

A bit of chance you can invite in and throw out. **It does nothing unless you
create a clip named `ICHING`** — there is no automatic casting and nothing fires
on its own.

When you launch it, the rig casts a hexagram the classical way (three-coin
method, six lines bottom-to-top, with changing lines) and:

- **Renders the hexagram in the dashboard** (the `i ching` panel on
  `localhost:7777`): the six lines drawn solid (yang) or broken (yin), changing
  lines marked `◇`, the King Wen number + name and trigram glyphs, and the
  *relating* hexagram it's changing toward. The reading lingers (dimmed) after
  the gesture ends.
- **Plays a bounded gesture** derived from the cast: each yang line gives its bus
  a small, capped send swell; yin lines are stillness; changing lines add one
  slow, barely-there shimmer. Over the move's bars it swells, then **returns
  every send to where your hands had it.**

Why it's safe to use at the gig:

- It's a normal move, so it inherits *everything* — grabs only during the ramp,
  range sentries skip anything you're holding, capture-and-restore, and the Link
  contract (it only touches conductor-owned sends; never tempo/transport/scenes).
- The depths are hard-capped small — a "sour" reading is never more than a wash.
- **If it goes anywhere you don't like, press `ABORT`** (or launch `CLEAN SLATE`):
  the gesture ends instantly and every swelled send rolls back home.
- It's off until you make the clip, and it doesn't change the room for anyone.

## 7. Ableton key map

No new MIDI mappings are required for any of this. Commands ride the session
grid as labeled clips (Push 3 + both iPads), so your existing controller map is
untouched. The rig adds **zero** key/MIDI bindings to the Live set; it only
reads clip launches and writes the listed parameters. Hands on the Twister/XL
always win over ALIVE drift and are honored as the capture baseline for moves.
