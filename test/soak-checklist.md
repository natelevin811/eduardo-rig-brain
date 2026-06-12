# soak-checklist.md — the living-room run. If it doesn't pass, v4 plays the gig.

All in REHEARSE unless stated. Dashboard open throughout. Check boxes or it
didn't happen.

## A. Resolution + boot

- [ ] Fresh open of v5: both consoles post `all setmap names resolved clean`
- [ ] Rename PadsBus → "PadsBusX", reload device: red text on the device,
      `unresolved` alert on dashboard, everything else still works. Rename back.
- [ ] Dashboard up at :7777 on laptop + iPad, both heartbeat dots pulsing with
      transport running

## B. Moves (each: fire → watch → confirm capture/restore)

For every move: nudge the touched params OFF their rest values by hand first,
fire the move, confirm it returns to YOUR values, not factory rest.

- [ ] WASH 16 — sends B+C swell on Pads/Leads/Perc, hold 4, return to captured
- [ ] TIDE OUT 32 — FX buses tide out, bass + low drums keep breathing, restore
- [ ] BREATH 8 — LP close 4 FX buses, bass untouched, release
- [ ] BLOOM 16 — LPF snaps closed ON THE BAR, opens over 16, send B returns
- [ ] RISE 16 — noise clip fires, riser macro full at bar 16, clip dies, macro
      zeros, Shephards swells and ducks over 2
- [ ] DISSOLVE 16 — six CL faders to -inf, live playing unaffected, faders STAY
- [ ] DISSOLVE BACK 8 — CL faders back to 0 dB
- [ ] CLEAN SLATE — CL clips stop, faders 0 dB, filters centered, macros rest,
      risers dead, on the next bar line
- [ ] HORIZON 64 — verify you can NOT hear it happening, only that it happened
- [ ] SUNRISE 32 — veiled snap, full open over 32, send C returns
- [ ] NIGHTFALL 32 — narrows and HOLDS dark; SUNRISE or CLEAN SLATE releases it
- [ ] FOCUS PADS 16 — HiDrums/Perc/Leads recede, Pads untouched, releases
- [ ] FOCUS BASS 16 — REJECTED with bad_command alert (setmap law)
- [ ] VEIL 8 — Hangup smear on Pads+Leads, dissolves back
- [ ] SWELL B 16 — Large Hall bloom across Pads/Leads/Perc
- [ ] PULSE 16 — felt not heard; ends exactly at captured (bar-synced sine)

## C. Sequences

- [ ] SEQ RISE 16 > CLEAN SLATE > BLOOM 16 — the ceremonial drop, back to back
      on bar lines
- [ ] SEQ DISSOLVE 16 > BREATH 8 > DISSOLVE BACK 8
- [ ] **Sequence supersede test** — launch WASH 16 mid-sequence: sequence dies
      cleanly, WASH runs, no orphaned grabs (move any touched param by hand
      after — it must respond)
- [ ] CLEAN SLATE mid-sequence: wins instantly

## D. Safeguards

- [ ] **Range sentry**: park PadsBus DJ filter at -0.8 by hand, fire BREATH —
      Pads lane skipped + logged, other three buses breathe
- [ ] **Dry-run**: DRY-RUN on, fire TIDE OUT — dashboard shows the move,
      nothing in Live moves
- [ ] **SHOW lock**: SHOW mode, try DRY-RUN — refused with alert; console silent
- [ ] **Exception jail**: temporarily add `throw new Error('test')` to top of
      _sync in conductor.js, save: error counter climbs, grabs release, after 3
      in 60 s device self-disables + dashboard red, Live audio NEVER hiccups.
      Remove the line, save, re-init.
- [ ] **Transport stop**: fire HORIZON, stop transport — grabs release
      (params respond to hands instantly), sentinel freezes, ALIVE suspends.
      Start again: sentinel resumes, move does NOT.
- [ ] **Tempo-jump test**: fire HORIZON 64, jump Link tempo 94 → 110 mid-arc —
      ramp bends (finishes in bars, not seconds), no zipper, no error
- [ ] **Node-kill test**: kill the node process mid-move (Activity Monitor or
      script stop in the shell) — control does not flinch; reload page after
      restart, dashboard reconnects
- [ ] **Crash-recovery test**: force-quit Live mid-move. Reopen v5: trims at
      last safe values, no move running, ALIVE off, grabs clear
- [ ] **Heartbeat**: unload conductor device only — dashboard red banner
      within 3 s, sentinel keeps ticking
- [ ] **ABORT**: mid-RISE, hit ABORT — immediate clean slate, no bar wait

## E. Sentinel

- [ ] Stack loops on Pads until Main brushes 0.92: PADS trim engages (dashboard
      trim event shows the justifying meters), other buses untouched
- [ ] Soft knee: hover just below ceiling — trim moves at half speed
- [ ] Pull loops off: trim releases slowly toward 0 after ~12 s of comfort
- [ ] LoDrums trim never exceeds -2 dB; others never exceed -3 dB; nothing
      ever boosts above 0
- [ ] Loop census: 3 loops deep on Pads — dashboard shows "3 loops", trim
      engages earlier than with 1 loop
- [ ] Capture sanity: record a CL loop, let it finish — `capture_sanity` event
      with before/after/delta appears in the log within 8 bars
- [ ] NIGHT ARC on: release bias visible on dashboard, authority never exceeds
      -2 dB. (If it isn't obviously right → ships OFF.)

## F. RITUAL

- [ ] Scramble by hand: DJ filters off-center, EQ3 gains cranked, CL faders
      random, arms off, monitors wrong. Press RITUAL → green board (minus
      flagged HELIX marks until setmap.ritual exists + the two human lines)
- [ ] Ritual card lists baked-tempo scenes correctly (compare against the set)
- [ ] In SHOW mode: RITUAL does NOT auto-run on load; button still works

## G. Link contract audit (grep proof — also run after ANY code edit)

```
cd eduardo-rig-brain
grep -rn "set('tempo'\|set(\"tempo\"\|\"tempo\"," --include=*.js . | grep -v readTempo | grep -v FORBIDDEN
grep -rn "start_playing\|stop_playing\|continue_playing" --include=*.js .   # hits only in resolver's FORBIDDEN list + comments
grep -rn "scenes" --include=*.js .                                          # hits only in resolver guard + sentinel read-only audit
```

- [ ] All three greps clean (guard-list/read-only hits only)

## H. Ten-hour soak

- [ ] Leave v5 running overnight with ALIVE on, PULSE + HORIZON fired
      occasionally, loops cycling: zero exceptions on the counter by morning,
      log file sane, memory flat (check Activity Monitor on the node process)
- [ ] Total CPU delta with both devices + dashboard vs. v4: negligible at
      buffer 128
