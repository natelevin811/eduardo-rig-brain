#!/usr/bin/env python3
"""lint_set.py — the Set Linter for eduardo-rig-brain.

Parses any Ableton .als (gzipped XML) and runs the full week's hand-audit
automatically. Everything Nate found by hand this week is encoded here as a
permanent tripwire, so it can never silently come back.

    python3 tools/lint_set.py "<set.als>" [--jsonl out.jsonl] [--quiet] [--strict]

Severities:
    RED     gate-failing. Will hurt the show (or the room). Exit code 1.
    YELLOW  confirm-by-human. Probably fine, but eyeball it once.
    GREEN   informational / passed.

Exit code is nonzero if any RED is found (so it can gate a git pre-commit hook
on the set — see tools/install-hooks.sh). --strict also fails on YELLOW.

This is a READ-ONLY tool. It opens the .als, never writes it. It contains no
Ableton-control code and nothing that could touch tempo/transport — it only
reads XML. (Link safety is irrelevant here but stated for the record.)

Format facts (reverse-engineered + reused from prep-set.py / verify-set.py):
  * .als = gzip(UTF-8 XML). Root/LiveSet/Tracks, /Scenes, /MainTrack.
  * Track gain  : DeviceChain/Mixer/Volume/Manual  (LINEAR; 0 dB == 1.0).
  * Utility gain: StereoGain/Gain/Manual            (LINEAR; 0 dB == 1.0).
  * Monitor     : .//MonitoringEnum  (0=In, 1=Auto, 2=Off).
  * Sends       : .//Mixer/Sends/TrackSendHolder/Send/Manual (LINEAR).
  * Scene tempo : Scenes/Scene/{Tempo, IsTempoEnabled}. IsTempoEnabled==true
                  is the Link hazard — a baked tempo re-tempos the whole room.
  * Crossfade   : .//Mixer/CrossFadeState  (0=A, 1=none, 2=B).
  * MIDI input  : DeviceChain/MidiInputRouting/Target ("MidiIn/External.All/-1"
                  == "All Ins" == the synth-chain MIDI-From leak).
  * Samples     : .//SampleRef/FileRef/{RelativePathType, Path, LivePackId}.
"""
import argparse
import gzip
import json
import math
import os
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict

# ---------------------------------------------------------------------------
# config / law — everything an audit might want to tune lives here
# ---------------------------------------------------------------------------
BUSES = ["LoDrumsBus", "HiDrumsBus", "PercBus", "BassBus", "PadsBus", "LeadsBus"]
CL_LANES = ["CL#1 Perc", "CL#2 Dr Hi", "CL#3 BASS", "CL#4 PAD", "CL#5 LEAD", "CL#6 LEAD"]

# Plugins authorized for this rig. Anything else is flagged (could be a missing
# dependency at the gig or an accidental insert). Match is case-insensitive
# substring so "Omnisphere" covers "Omnisphere 2".
AUTHORIZED_PLUGINS = ["omnisphere", "valhallavintageverb"]

# DJ filter saved-position detent. raw 0..1, center 0.5 (RIG-VERIFIED, see setmap).
DJ_CENTER = 0.5
DJ_DETENT_TOL = 0.02       # |raw-0.5| above this == saved off-center

EQ3_UNITY = 1.0
EQ3_UNITY_TOL = 0.001

SEND_ACTIVE_DB = -40.0     # a send hotter than this is "on"
CL_FADER_TARGET_DB = 0.0   # conductor expects CL lanes resting at 0 dB
CL_FADER_TOL_DB = 0.1
BUS_FADER_FLOOR_DB = -40.0  # a bus quieter than this is suspicious (mute by accident?)

ALL_INS = "MidiIn/External.All/-1"

# severity ranks
RED, YELLOW, GREEN = "RED", "YELLOW", "GREEN"
_RANK = {RED: 2, YELLOW: 1, GREEN: 0}


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def lin_to_db(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return -120.0 if x <= 0 else round(20.0 * math.log10(x), 2)


def v(el, path):
    if el is None:
        return None
    e = el.find(path)
    return e.get("Value") if e is not None else None


def track_name(t):
    return v(t, "Name/EffectiveName") or v(t, "Name/UserName") or "<unnamed>"


def is_cl(name):
    return name in CL_LANES


def is_capture_in(name):
    # tracks RITUAL forces to Monitor=In: Cptr* + HELIX CAPTURE
    return name.startswith("Cptr") or "HELIX CAPTURE" in name


def is_rec_feed(name):
    return "REC FEED" in name


class Finding:
    __slots__ = ("severity", "check", "track", "message", "data")

    def __init__(self, severity, check, message, track=None, data=None):
        self.severity = severity
        self.check = check
        self.track = track
        self.message = message
        self.data = data or {}

    def as_dict(self):
        return {"severity": self.severity, "check": self.check,
                "track": self.track, "message": self.message, "data": self.data}


# ---------------------------------------------------------------------------
# checks — each takes (ls, tracks, ctx) and yields Findings
# ---------------------------------------------------------------------------
def check_scene_tempos(ls, tracks, ctx):
    """Link hazard: scenes with a baked, ENABLED tempo. Launching one re-tempos
    every machine on this Link session, not just ours. Flag, never fix."""
    scenes = ls.find("Scenes")
    if scenes is None:
        return
    baked = []
    for i, s in enumerate(scenes):
        if v(s, "IsTempoEnabled") == "true":
            baked.append((i, v(s, "Name") or "", v(s, "Tempo")))
    if baked:
        tempos = sorted({float(t[2]) for t in baked})
        yield Finding(RED, "scene_tempos",
                      "%d scenes carry an ENABLED tempo (%s) — LINK HAZARD: "
                      "launching one re-tempos the whole room. Disable the tempo "
                      "on these scenes or never launch them by accident."
                      % (len(baked), "/".join("%g" % x for x in tempos)),
                      data={"scenes": [{"index": i, "name": n, "tempo": t}
                                       for i, n, t in baked]})
    else:
        yield Finding(GREEN, "scene_tempos", "No scene carries an enabled tempo.")


def check_lane_gains(ls, tracks, ctx):
    """CL lane faders + any Utility on the lane should rest at 0 dB (conductor
    owns them; RITUAL parks them at unity). A stray trim hides a layer live."""
    seen = 0
    for t in tracks:
        name = track_name(t)
        if not is_cl(name):
            continue
        seen += 1
        vol = v(t, "DeviceChain/Mixer/Volume/Manual")
        db = lin_to_db(vol)
        if db is None:
            yield Finding(YELLOW, "lane_gains", "no readable fader", track=name)
        elif abs(db - CL_FADER_TARGET_DB) > CL_FADER_TOL_DB:
            yield Finding(RED, "lane_gains",
                          "CL lane fader at %.2f dB, want 0 dB (conductor rest)"
                          % db, track=name, data={"db": db})
        # any Utility on a CL lane that isn't unity is a hidden second gain stage
        for sg in t.findall("./DeviceChain/DeviceChain/Devices/StereoGain"):
            g = lin_to_db(v(sg, "Gain/Manual"))
            if g is not None and abs(g) > CL_FADER_TOL_DB:
                yield Finding(YELLOW, "lane_gains",
                              "Utility %r on CL lane at %.2f dB (second gain stage)"
                              % (v(sg, "UserName") or "Utility", g),
                              track=name, data={"db": g})
    if seen == 0:
        yield Finding(YELLOW, "lane_gains", "no CL#* lanes found in set")


def check_bus_faders(ls, tracks, ctx):
    """Report bus operating points; flag any bus muted-by-accident (very low).
    Bus faders are the performer's mix, not ours — so low is YELLOW, not RED."""
    for t in tracks:
        name = track_name(t)
        if name not in BUSES:
            continue
        db = lin_to_db(v(t, "DeviceChain/Mixer/Volume/Manual"))
        if db is None:
            continue
        if db <= BUS_FADER_FLOOR_DB:
            yield Finding(YELLOW, "bus_faders",
                          "bus fader at %.1f dB — effectively muted; confirm intentional"
                          % db, track=name, data={"db": db})
        else:
            yield Finding(GREEN, "bus_faders", "%.2f dB" % db, track=name,
                          data={"db": db})


def check_monitor_states(ls, tracks, ctx):
    """Wrong Monitor = feedback or silence at the worst moment.
       CL lanes      -> Off (2).   Capture/HELIX CAPTURE -> In (0)."""
    MON = {"0": "In", "1": "Auto", "2": "Off"}
    for t in tracks:
        name = track_name(t)
        mon = None
        me = t.find(".//MonitoringEnum")
        if me is not None:
            mon = me.get("Value")
        if is_cl(name):
            if mon != "2":
                yield Finding(RED, "monitor_states",
                              "CL lane Monitor = %s, want Off (record-arm safe)"
                              % MON.get(mon, mon), track=name, data={"monitor": mon})
        elif is_capture_in(name):
            if mon != "0":
                yield Finding(RED, "monitor_states",
                              "capture track Monitor = %s, want In"
                              % MON.get(mon, mon), track=name, data={"monitor": mon})


def check_midi_from_leaks(ls, tracks, ctx):
    """'All Ins' on an instrument chain = any controller bleeds into it (the
    synth-chain MIDI-From leak Nate fixed). Flag every MIDI track on All Ins;
    instrument-bearing ones are the real risk."""
    for t in tracks:
        if t.tag != "MidiTrack":
            continue
        name = track_name(t)
        tgt = v(t, "DeviceChain/MidiInputRouting/Target")
        if tgt != ALL_INS:
            continue
        # does it actually carry an instrument? (a sound source = real leak risk)
        devs = t.find("./DeviceChain/DeviceChain/Devices")
        has_instrument = devs is not None and any(
            d.tag in ("InstrumentGroupDevice", "PluginDevice", "AuPluginDevice",
                      "OriginalSimpler", "MxDeviceMidiInstrument",
                      "InstrumentVector", "UltraAnalog", "Operator", "Wavetable")
            or "Instrument" in d.tag for d in devs)
        sev = YELLOW if has_instrument else GREEN
        yield Finding(sev, "midi_from_leaks",
                      "MIDI-From = All Ins%s"
                      % (" on an instrument chain (scope to one port)"
                         if has_instrument else " (no instrument; low risk)"),
                      track=name, data={"instrument": has_instrument})


def check_dj_filters(ls, tracks, ctx):
    """DJ Filter Soft Clip saved off center colours the bus the instant the set
    loads. RITUAL recenters live, but a saved offset is a surprise.

    The device is an AutoFilter2 named "DJ Filter Soft Clip" (LeadsBus's lives
    inside the bus rack — iter() reaches it). The bipolar control is stored as
    Filter_DjControl in NATIVE units (-1..1, center 0); the LOM exposes the same
    knob as 0..1/center 0.5. We read native here. display% = native * 100."""
    found = 0
    for t in tracks:
        name = track_name(t)
        if name not in BUSES:
            continue
        for dev in t.iter():
            if dev.tag != "AutoFilter2":
                continue
            un = v(dev, "UserName") or ""
            if "DJ Filter" not in un and "Soft Clip" not in un:
                continue
            found += 1
            native = v(dev, "Filter_DjControl/Manual")
            try:
                nv = float(native)
            except (TypeError, ValueError):
                continue
            if abs(nv) > DJ_DETENT_TOL:
                pct = round(nv * 100)
                yield Finding(YELLOW, "dj_filters",
                              "DJ filter saved at %+d%% (native %.3f), not centered"
                              % (pct, nv), track=name,
                              data={"native": nv, "display_pct": pct})
            else:
                yield Finding(GREEN, "dj_filters", "centered (%.3f)" % nv, track=name)
    if found == 0:
        yield Finding(YELLOW, "dj_filters",
                      "no 'DJ Filter Soft Clip' AutoFilter2 found on any bus")


def check_eq_three(ls, tracks, ctx):
    """6 Melodies EQ Three should sit at unity (1.0) — RITUAL sets it, but a
    saved off-unity is an at-load tone surprise."""
    for t in tracks:
        if track_name(t) != "6 Melodies":
            continue
        for eq in t.iter():
            if eq.tag != "FilterEQ3":  # Live's EQ Three device tag
                continue
            off = False
            for pname in ("GainLo", "GainMid", "GainHi"):
                g = v(eq, "%s/Manual" % pname)
                try:
                    gv = float(g)
                except (TypeError, ValueError):
                    continue
                if abs(gv - EQ3_UNITY) > EQ3_UNITY_TOL:
                    off = True
                    yield Finding(YELLOW, "eq_three",
                                  "EQ Three %s = %.3f, not unity (1.0)" % (pname, gv),
                                  track="6 Melodies", data={pname: gv})
            if not off:
                yield Finding(GREEN, "eq_three", "all bands at unity",
                              track="6 Melodies")


def check_sends(ls, tracks, ctx):
    """Sibling CL lanes on the same bus should send alike; a lopsided send means
    one recorded layer will sit wetter than its twin. Report active sends."""
    by_lane = {}
    for t in tracks:
        name = track_name(t)
        if not is_cl(name):
            continue
        sends = []
        for sh in t.findall(".//Mixer/Sends/TrackSendHolder"):
            sends.append(lin_to_db(v(sh, "Send/Manual")))
        by_lane[name] = sends
    # compare the two LeadsBus lanes (CL#5 / CL#6) — the only same-bus pair
    pair = ("CL#5 LEAD", "CL#6 LEAD")
    if all(p in by_lane for p in pair):
        a, b = by_lane[pair[0]], by_lane[pair[1]]
        for i, (da, db_) in enumerate(zip(a, b)):
            if da is None or db_ is None:
                continue
            on = da > SEND_ACTIVE_DB or db_ > SEND_ACTIVE_DB
            if on and abs(da - db_) > 6.0:
                yield Finding(YELLOW, "sends",
                              "send %s mismatched across LeadsBus lanes: "
                              "%s=%.1f dB vs %s=%.1f dB"
                              % ("ABCDEF"[i], pair[0], da, pair[1], db_),
                              data={"send": "ABCDEF"[i], pair[0]: da, pair[1]: db_})


def check_crossfade_assign(ls, tracks, ctx):
    """Any track assigned to the crossfader (A/B) will vanish when Eduardo rides
    the X-fader for a musical reason — usually not what you want on bus/loop
    tracks."""
    for t in tracks:
        name = track_name(t)
        cf = t.find(".//Mixer/CrossFadeState")
        val = cf.get("Value") if cf is not None else None
        if val in ("0", "2"):
            yield Finding(YELLOW, "crossfade_assign",
                          "assigned to crossfader side %s — confirm musical intent"
                          % ("A" if val == "0" else "B"),
                          track=name, data={"side": val})


def check_double_compression(ls, tracks, ctx):
    """A compressor on a source/loop track feeding a bus that ALSO compresses =
    double glue, pumping you didn't ask for. Report the stack."""
    DYN = ("GlueCompressor", "Compressor2", "Limiter", "MultibandDynamics")
    per_track = {}
    for t in tracks:
        name = track_name(t)
        devs = [d.tag for d in t.iter() if d.tag in DYN]
        if devs:
            per_track[name] = Counter(devs)
    # heuristic: a CL lane / source with a compressor whose target bus also has one
    bus_has = {b: per_track.get(b) for b in BUSES}
    for name, devs in per_track.items():
        if name in BUSES:
            continue
        # which bus does this feed? map CL lanes via known suffix, else skip
        bus = ctx["lane_to_bus"].get(name)
        if bus and bus_has.get(bus):
            yield Finding(YELLOW, "double_compression",
                          "%s compresses (%s) feeding %s which also compresses (%s)"
                          % (name, "+".join(devs), bus,
                             "+".join(bus_has[bus])),
                          track=name, data={"track_dyn": list(devs),
                                            "bus": bus, "bus_dyn": list(bus_has[bus])})


def check_plugins(ls, tracks, ctx):
    """Any plugin outside the authorized list could be missing at the venue or an
    accidental insert (CPU / latency / a forgotten demo timeout)."""
    found = Counter()
    for e in ls.iter():
        if e.tag in ("VstPluginInfo", "Vst3PluginInfo", "AuPluginInfo"):
            nm = v(e, "Name") or v(e, "PlugName") or "<unknown>"
            found[nm] += 1
    for nm, n in sorted(found.items()):
        ok = any(a in nm.lower() for a in AUTHORIZED_PLUGINS)
        if ok:
            yield Finding(GREEN, "plugins", "%s ×%d (authorized)" % (nm, n),
                          data={"plugin": nm, "count": n})
        else:
            yield Finding(RED, "plugins",
                          "UNAUTHORIZED plugin %r ×%d — confirm it's installed at "
                          "the venue or remove it" % (nm, n),
                          data={"plugin": nm, "count": n})


def check_external_media(ls, tracks, ctx):
    """Media that resolves to an external/old volume can go missing the moment
    the set opens on the gig laptop. Flag absolute paths outside the project and
    obvious Time-Machine / old-laptop folders."""
    BAD_HINTS = ["/Volumes/", "Time Machine", ".Trash", "Exported from Antares",
                 "nolivelooping"]
    offenders = Counter()
    examples = {}
    total = 0
    for fr in ls.iter():
        if fr.tag != "FileRef":
            continue
        total += 1
        rel_type = v(fr, "RelativePathType")
        path = v(fr, "Path") or ""
        packid = v(fr, "LivePackId") or ""
        # RelativePathType 0/missing with an absolute external path = portability risk
        hit = next((h for h in BAD_HINTS if h in path), None)
        if hit and not packid:
            offenders[hit] += 1
            examples.setdefault(hit, path)
    if total == 0:
        return
    for hint, n in offenders.most_common():
        yield Finding(YELLOW, "external_media",
                      "%d media refs under %r (e.g. %s) — confirm these are "
                      "collected/available on the gig laptop"
                      % (n, hint, examples[hint]),
                      data={"hint": hint, "count": n, "example": examples[hint]})
    if not offenders:
        yield Finding(GREEN, "external_media",
                      "%d media refs, none on flagged external/old volumes" % total)


def check_duplicate_track_names(ls, tracks, ctx):
    names = [track_name(t) for t in tracks]
    dups = [n for n, c in Counter(names).items() if c > 1]
    for n in dups:
        yield Finding(YELLOW, "duplicate_names",
                      "track name %r appears %d times — name-based resolution is "
                      "ambiguous for it" % (n, names.count(n)), track=n)


CHECKS = [
    check_scene_tempos,        # the big one — Link hazard
    check_lane_gains,
    check_bus_faders,
    check_monitor_states,
    check_midi_from_leaks,
    check_dj_filters,
    check_eq_three,
    check_sends,
    check_crossfade_assign,
    check_double_compression,
    check_plugins,
    check_external_media,
    check_duplicate_track_names,
]


# ---------------------------------------------------------------------------
# runner / reporting
# ---------------------------------------------------------------------------
def load(path):
    with gzip.open(path, "rb") as f:
        return ET.fromstring(f.read())


def colorize(sev, text, use_color):
    if not use_color:
        return text
    code = {RED: "31", YELLOW: "33", GREEN: "32"}.get(sev, "0")
    return "\033[%sm%s\033[0m" % (code, text)


def run(path, jsonl=None, quiet=False, strict=False, color=True):
    root = load(path)
    ls = root.find("LiveSet")
    if ls is None:
        print("not an Ableton set (no LiveSet): %s" % path, file=sys.stderr)
        return 2
    tracks = list(ls.find("Tracks"))

    ctx = {"lane_to_bus": {
        "CL#1 Perc": "PercBus", "CL#2 Dr Hi": "HiDrumsBus", "CL#3 BASS": "BassBus",
        "CL#4 PAD": "PadsBus", "CL#5 LEAD": "LeadsBus", "CL#6 LEAD": "LeadsBus"}}

    findings = []
    for chk in CHECKS:
        try:
            findings.extend(chk(ls, tracks, ctx))
        except Exception as e:  # a broken check must not blind the rest
            findings.append(Finding(YELLOW, chk.__name__,
                                    "check raised %s: %s" % (type(e).__name__, e)))

    reds = [f for f in findings if f.severity == RED]
    yellows = [f for f in findings if f.severity == YELLOW]
    greens = [f for f in findings if f.severity == GREEN]

    # ---- terminal report ----
    print("\nSET LINTER  —  %s" % os.path.basename(path))
    print("  %d tracks, %d scenes" % (len(tracks), len(ls.find("Scenes") or [])))
    print("  %s   %s   %s\n" % (
        colorize(RED, "%d RED" % len(reds), color),
        colorize(YELLOW, "%d YELLOW" % len(yellows), color),
        colorize(GREEN, "%d ok" % len(greens), color)))

    def emit(group, title):
        if not group:
            return
        print(title)
        for f in sorted(group, key=lambda x: x.check):
            tag = colorize(f.severity, "%-6s" % f.severity, color)
            loc = (" [%s]" % f.track) if f.track else ""
            print("  %s %-20s%s %s" % (tag, f.check, loc, f.message))
        print("")

    emit(reds, "FAILURES (RED):")
    emit(yellows, "WARNINGS (YELLOW):")
    if not quiet:
        emit(greens, "PASSED (GREEN):")

    # ---- jsonl ----
    if jsonl:
        with open(jsonl, "w") as fh:
            for f in findings:
                fh.write(json.dumps(f.as_dict()) + "\n")
        print("wrote %d findings -> %s" % (len(findings), jsonl))

    if reds:
        print(colorize(RED, "RED findings present — set is NOT clean.", color))
        return 1
    if strict and yellows:
        print(colorize(YELLOW, "--strict: YELLOW findings present.", color))
        return 1
    print(colorize(GREEN, "No RED findings. Set passes the linter.", color))
    return 0


def main():
    ap = argparse.ArgumentParser(description="Set Linter for eduardo-rig-brain")
    ap.add_argument("als", help="path to the .als set")
    ap.add_argument("--jsonl", help="write all findings as jsonl to this path")
    ap.add_argument("--quiet", action="store_true", help="hide GREEN/passed lines")
    ap.add_argument("--strict", action="store_true", help="exit nonzero on YELLOW too")
    ap.add_argument("--no-color", action="store_true")
    args = ap.parse_args()
    if not os.path.exists(args.als):
        print("no such file: %s" % args.als, file=sys.stderr)
        sys.exit(2)
    sys.exit(run(args.als, jsonl=args.jsonl, quiet=args.quiet,
                 strict=args.strict, color=not args.no_color))


if __name__ == "__main__":
    main()
