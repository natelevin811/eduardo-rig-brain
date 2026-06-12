# eduardo-rig-brain

Two Max for Live device brains + a read-only telemetry dashboard for a live
ambient looping rig. **CONDUCTOR** performs slow parameter gestures (moves +
sequences) commanded by launching named clips; **SENTINEL** auto-trims bus
levels against a headroom ceiling. Everything resolves by name, captures and
restores, grabs only during ramps, and refuses — at the lowest layer — to ever
write tempo, transport, or fire a scene (the laptop shares Ableton Link with
other musicians' rigs).

- **Test it on any machine: `docs/RIG-TEST.md`** ← start here on the gig laptop
- Spec: `docs/SPEC.md` · Setmap (law): `setmap/eduardo-setmap.json`
- Build the shells: `docs/SHELL-BUILD.md` (generated — `node tools/build-shells.mjs`)
- Calibrate: `docs/CALIBRATION.md` · Show night: `docs/RUNBOOK.md`
- Prove it: `test/soak-checklist.md` · Current state: `STATUS.md`
- Dashboard: `http://localhost:7777` once the SENTINEL shell is loaded
- Session logs: `logs/<date>-show.jsonl`

If it doesn't pass the living-room run, it stays home and v4 plays the gig.
