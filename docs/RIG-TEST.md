# RIG-TEST.md — testing the rig on any machine (gig laptop or studio)

Follow this top to bottom on a fresh machine. Last verified: 2026-06-12,
Live 12.3.5 / bundled Max 9.0.10. Gig laptop was Live 12.3.2 / Max 9.0.9 —
both fine.

## 0. Where everything lives

| Thing | Location |
|---|---|
| Code (brains, setmap, tools, docs) | this repo — `git pull` first, brains hot-reload via autowatch |
| Prepped set (SENTRIM ×6 + CONDUCTOR track + 19 clips) | iCloud Drive: `6.7.3_eduardo_2026_STAGE_v6.als` |
| Untouched fallback set (kill-order layer) | iCloud Drive: `6.7.3_eduardo_2026_STAGE_v5.als` — never modify |
| Finished devices | iCloud Drive: `CONDUCTOR.amxd`, `SENTINEL.amxd` (same files as repo `build/`) |
| Dashboard | http://localhost:7777 once SENTINEL is loaded |

iCloud is the transfer mechanism for set + devices; GitHub for code + docs.

## 1. One-time machine setup (~30 seconds)

Make Max find the brains/setmap with ZERO File Preferences clicking — symlink
the repo into the Max User Library (searched recursively by default):

```
ln -sfn ~/code/natelevin/eduardo-rig-brain ~/Documents/Max\ 9/Library/eduardo-rig-brain
```

(If the machine has `~/Documents/Max 8/Library` instead, link there too. The
manual alternative is SHELL-BUILD §0: add the five repo folders in Max →
Options → File Preferences with subfolders ON.)

Then `git pull` in the repo.

## 2. Load (~2 min)

1. Open `6.7.3_eduardo_2026_STAGE_v6.als`. A "created with a newer version"
   warning is EXPECTED (set was last saved by 12.4.1) — predates our work,
   v5 shows it too.
2. If the set already contains old CONDUCTOR/SENTINEL devices: DELETE them
   first (device replacement resets pattr state — you'll re-set mode below).
3. Drag `CONDUCTOR.amxd` onto the **40 Master FX** track.
4. Drag `SENTINEL.amxd` onto the **Main/Master** track.
5. Device faces should be compact (~480 px). If a device renders as a huge
   full-width canvas, it's a stale pre-presentation build — re-download from
   iCloud or `git pull` + use `build/`.

## 3. Verify boot (~1 min)

- Max console: `all setmap names resolved clean` ×2.
  **Wait ~15 s before believing red text** — devices retry resolution 3× at
  4 s intervals (Live set-load race; SENTRIM/HELIX params can be invisible on
  the first pass).
- Dashboard up at http://localhost:7777, RITUAL card mostly green.
- Set both devices to REHEARSE (pattr state does not survive device swap).
- **Transport running → beat/bar MUST advance on the dashboard.** Both brains
  self-clock off `current_song_time` now; a dead plugsync~ chain can no longer
  freeze the conductor (the 2026-06-12 rig failure).

## 4. Functional tests (in order)

| # | Do | Expect |
|---|---|---|
| 1 | DRY-RUN ON, launch `WASH 16` | dashboard shows move + bars advancing; NOTHING moves in Live |
| 2 | DRY-RUN OFF, launch `WASH 16` | sends B+C on Pads/Leads/Perc visibly ramp 16 bars, hold 4, return |
| 3 | Launch `CLEAN SLATE` | DJ filters land at **center (0%)** — NOT slammed to −100% (the fixed bug) |
| 4 | Launch `BREATH 8` | HiDrums/Perc/Pads/Leads filters close to ~−62% and release; Bass untouched |
| 5 | Press **TEST** on CONDUCTOR face | PadsBus send B wiggles for 1.5 s; step-by-step posts in Max console |
| 6 | Launch `RISE 16` | WhiteNoise clip + riser macro ramp; ShephardsTone letter clip fires + rack **Output** macro swells (track fader does NOT move), ducks 2 bars, clip stops after the duck |
| 7 | Mid-move, press **ABORT** | everything snaps to rest immediately |
| 8 | Stop transport mid-move | all grabs release; move cancels; trims hold |

## 5. Troubleshooting

- **Dashboard ramps but Live knobs don't move** → press **TEST**. Console
  says which half is broken: "knob moved = pool OK" (engine/targets issue) vs
  "knob still = pool broken" (live.remote~ patch cords — re-download device).
- **bar stays 0 / beat–bar dashes while playing** → brains not updated; `git
  pull` (autowatch hot-reloads) or the device is a stale build.
- **`setmap file not found in search path`** → the §1 symlink is missing on
  this machine.
- **unresolved names after 15 s** → real missing name; the red-text list on
  the device face names it. SENTRIM ×6 and the CONDUCTOR track exist in v6,
  so anything unresolved there means the wrong set is open.
- **Filters slammed −100% again** → running OLD code; `git pull`. The center
  is 0.5 raw (law: `setmap.dj_filter_param`).

## 6. Known-fine flags (don't chase these)

- RITUAL: "tempo at opening value (94) now 81" — flag-only; setmap law says 94,
  set is saved at 81. Tell the repo owner which is the real opening tempo.
- RITUAL: "11 scenes carry tempo" — pre-existing in the set, flag-only by
  design (Link contract: we never fix tempo).
- Stale-heartbeat red banner whenever transport is stopped — true, cosmetic.
- "buffer = 128" / "Link Start Stop Sync OFF" — not API-readable; check Live
  prefs by hand once.

## 7. Remote debug loop (performing machine ↔ browser Claude ↔ GitHub)

When debugging from the performance machine with fixes authored elsewhere
(e.g., Claude Code in the browser pushing to this repo), the loop is:

1. **Capture evidence** on the performance machine: copy the Max console lines
   (Max window → right-click device title bar → Open Max Window) and the
   dashboard alert lane text. Paste them to whoever/whatever is writing the fix.
2. **Fix lands on GitHub** (branch or main — agree which).
3. **On the performance machine, pull:**

   ```
   cd ~/code/natelevin/eduardo-rig-brain && git pull
   ```

4. **What happens next depends on WHAT changed** (check the pull output):

   | Files changed | What you do |
   |---|---|
   | `conductor/*.js`, `sentinel/*.js`, `shared/*.js` | **Nothing.** autowatch recompiles and the brains self-re-init ~0.3 s later. Watch the Max console for the re-init posts. Re-set SHOW mode if you were in SHOW (recompile resets to REHEARSE). |
   | `setmap/eduardo-setmap.json` only | Brains re-read the setmap only at init — easiest trigger: `touch conductor/conductor.js sentinel/sentinel.js` (forces recompile → self-init). |
   | `dashboard/server.js` / `index.html` | node.script watches — dashboard restarts itself; reload the browser tab. |
   | `build/*.amxd` | Delete the old device in Live, drag the new one in from `build/`, re-set mode. (Rare — only when the shell wiring itself changed.) |
   | `tools/*` or `docs/*` only | Nothing to do in Live. |

5. **Verify the fix** with the relevant §4 test, paste the new console output
   back if it's still wrong.

Anyone driving the CLI on the performance machine can follow this table
verbatim — it requires no knowledge of the codebase.

## 8. After a good run

Save the set (still as v6 or bump to v7 — v5 stays untouched forever), then
run the full living-room soak: `test/soak-checklist.md`. Living-room law:
doesn't pass → v4 plays the gig.
