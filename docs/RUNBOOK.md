# RUNBOOK.md — show night

## Pre-show ritual (T-30 min)

1. Open **v5**. Both devices load; Max console quiet (SHOW silences posts —
   load in REHEARSE first if you want to see the resolution report).
2. Open `http://localhost:7777` on the laptop AND the iPad Mini tab.
3. In REHEARSE, RITUAL runs automatically on load (or press **RITUAL**).
   Watch the ritual card go green.
4. **The two human lines** (the API cannot read these — they are yours):
   - [ ] Audio buffer = **128** (Live → Preferences → Audio)
   - [ ] Link **Start Stop Sync = OFF** (Live → Preferences → Link/Tempo/MIDI)
     — a stray spacebar on this laptop must never stop the room.
5. Scene-tempo audit line on the ritual card: read which scenes carry baked
   tempos (89–121). Those are **human fingers only** — with Link, launching
   one re-tempos Eduardo's machine. The code already refuses; you should too
   unless it's musically on purpose.
6. Flip both devices to **SHOW** (locks dry-run off, silences console, caps
   telemetry). Badge on the dashboard goes rust.
7. ALIVE: decide now. Default **OFF**. If in doubt, it stays off.
8. Green board = walk on stage thinking about music.

## During the set

- Commands are clips on the CONDUCTOR track: Push 3 grid or either iPad.
  Everything lands on the next bar line (global 1-bar quantize).
- The dashboard is read-only. If it dies, **nothing changes** — control does
  not flow through it. Reload the tab; it reconnects by itself.
- Your hands always win: any move you make on a Twister/XL-owned param that a
  move would have touched gets skipped by the range sentry (it logs, the rest
  of the move runs). ALIVE backs off any param it sees you touch.
- Red banner (stale heartbeat) = that brain stopped ticking. The set keeps
  playing. Deal with it between phrases, not mid-gesture.

## Kill order (four layers, each independent)

1. **CLEAN SLATE** clip on the Push grid — resets all conductor territory on
   the next bar.
2. **ABORT** button on the CONDUCTOR device — same reset, immediately, no bar
   wait.
3. **Delete the device(s)** — freebang releases every live.remote~ grab the
   moment the device leaves the chain.
4. **Open v4** — the fallback set that has none of this in it. The gig
   finishes on muscle memory.

## Crash recovery (Live dies mid-show)

1. Reopen v5. pattr restores: SENTINEL trims at their last safe values,
   modes as saved; every move cleared; ALIVE forced off.
2. Transport starts from Link — the room's tempo, not ours (we never speak it).
3. Sentinel resumes on transport start. Moves never auto-resume — re-launch a
   clip when it's musically right.
4. Session log so far is intact: `logs/<date>-show.jsonl` (the node process
   appends; a new Live session appends to the same dated file).

## Post-gig

- `logs/<date>-show.jsonl` replays the night: every command, ramp, trim with
  the meters that justified it, every capture-sanity delta, every error.
- `capture_sanity` events that consistently show a lane coming back hot/cold
  → a number for CALIBRATION.md instead of a feeling.
