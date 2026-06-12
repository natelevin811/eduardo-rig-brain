# eduardo-rig-brain — session kickoff

You are building two Max for Live devices and a telemetry dashboard for a professional musician's live ambient looping rig, per `docs/SPEC.md` and `setmap/eduardo-setmap.json`. The gig is in 48–72 hours; reliability outranks every feature.

This laptop shares Ableton Link with other musicians' rigs: the LINK SAFETY CONTRACT in the spec is absolute — no code writes tempo, transport, or launches scenes, ever, and the final self-review must include grep proof.

Rules:

- All device logic in ES5-compatible `.js` for Max's js object (no modern syntax that the js object can't parse; `node.script` files may use modern Node).
- Resolve every Live object by name via `shared/resolver.js`; never hardcode indices. LOM index hints in the setmap are hints only and WILL drift.
- Every entry point exception-wrapped (exception jail, spec safeguard #1).
- Build in the phase order in the spec; RITUAL is part of the sentinel phase.
- After each phase, write a brief STATUS.md update: what's done, what's untested, what needs human hands.
- Do not invent parameters not in the setmap; if the setmap is ambiguous, add a question to STATUS.md and build the rest.
- When all phases are complete, do a full self-review pass against the spec's safeguards list, Link contract, and test plan, then stop.
