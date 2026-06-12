#!/usr/bin/env python3
"""verify-set.py — static verification gate for a prepped .als (after prep-set.py).

Checks the OUTPUT set against every invariant the surgery could have broken,
plus the full setmap name-resolution preflight. Run:

    python3 tools/verify-set.py "<prepped.als>" [--baseline "<original.als>"]

With --baseline it also proves nothing unintended changed (element-count
accounting + spot-checks of untouched values).
Exit 0 = clean, 1 = findings.
"""
import gzip
import sys
import xml.etree.ElementTree as ET

BUSES = ["LoDrumsBus", "HiDrumsBus", "PercBus", "BassBus", "PadsBus", "LeadsBus"]


def is_pointee_tag(tag):
    # mirror of prep-set.py — see its docstring for the adversarial-review story
    return (tag == "Pointee"
            or tag.endswith("AutomationTarget")
            or tag.endswith("ModulationTarget")
            or tag.startswith("ControllerTargets."))


def tag_family(tag):
    # normalize dynamic tag names (ControllerTargets.0 ... .130 -> one family)
    head, dot, idx = tag.rpartition(".")
    return head + ".N" if dot and idx.isdigit() else tag
CLIP_NAMES = [
    "WASH 16", "TIDE OUT 32", "BREATH 8", "BLOOM 16", "RISE 16",
    "DISSOLVE 16", "DISSOLVE BACK 8", "CLEAN SLATE",
    "HORIZON 64", "SUNRISE 32", "NIGHTFALL 32", "FOCUS PADS 16",
    "VEIL 8", "SWELL B 16", "PULSE 16",
    "SEQ RISE 16 > CLEAN SLATE > BLOOM 16",
    "SEQ NIGHTFALL 32 > HORIZON 64",
    "SEQ DISSOLVE 16 > BREATH 8 > DISSOLVE BACK 8",
    "SEQ WASH 16 > TIDE OUT 32",
]
# resolve-by-name targets that must exist (from the setmap)
REQUIRED_TRACKS = BUSES + [
    "40 Master FX", "CL#1 Perc", "CL#2 Dr Hi", "CL#3 BASS", "CL#4 PAD",
    "CL#5 LEAD", "CL#6 LEAD", "WhiteNoise", "42-ShephardsTone",
    "HELIX CAPTURE IN", "6 Melodies", "CONDUCTOR",
]
REQUIRED_RETURNS = [
    "A-Small Room | EQ Eight", "B-Large Hall | EQ Eight", "C-Allen-A-Verb",
    "D-Allen-B-Delay", "E-Allen-C-Rubadub", "F-Allen-D-Hangup",
]


def v(el, path):
    e = el.find(path)
    return e.get("Value") if e is not None else None


def load(path):
    return ET.fromstring(gzip.open(path, "rb").read())


def main():
    out_path = sys.argv[1]
    baseline = sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--baseline" else None
    errs, infos = [], []

    root = load(out_path)
    ls = root.find("LiveSet")
    tracks = ls.find("Tracks")
    names = [v(t, "Name/EffectiveName") for t in tracks]

    # --- tracks present ---
    for nm in REQUIRED_TRACKS:
        if nm not in names:
            errs.append(f"missing track: {nm}")
    rt = [v(t, "Name/EffectiveName") for t in tracks if t.tag == "ReturnTrack"]
    for nm in REQUIRED_RETURNS:
        if nm not in rt:
            errs.append(f"missing return: {nm}")

    # --- SENTRIM on all six buses, end of chain, neutral, 0 dB ---
    for bus in BUSES:
        t = next((x for x in tracks if v(x, "Name/EffectiveName") == bus), None)
        if t is None:
            continue
        devs = t.find("./DeviceChain/DeviceChain/Devices")
        last = list(devs)[-1]
        if last.tag != "StereoGain" or v(last, "UserName") != "SENTRIM":
            errs.append(f"{bus}: last device is {last.tag}/{v(last,'UserName')!r}, want StereoGain SENTRIM")
            continue
        if v(last, "Gain/Manual") != "1":
            errs.append(f"{bus}: SENTRIM Gain Manual={v(last,'Gain/Manual')} (must be 1 == 0 dB linear)")
        if v(last, "On/Manual") != "true":
            errs.append(f"{bus}: SENTRIM is off")
        for p, want in (("Mute/Manual", "false"), ("Mono/Manual", "false"),
                        ("StereoWidth/Manual", "1"), ("Balance/Manual", "0"),
                        ("BassMono/Manual", "false")):
            if v(last, p) != want:
                errs.append(f"{bus}: SENTRIM {p}={v(last,p)} want {want}")
        sib = [d.get("Id") for d in devs]
        if len(sib) != len(set(sib)):
            errs.append(f"{bus}: duplicate sibling device ids {sib}")

    # --- CONDUCTOR track ---
    cond = next((x for x in tracks if v(x, "Name/EffectiveName") == "CONDUCTOR"), None)
    if cond is None:
        errs.append("CONDUCTOR track missing")
    else:
        kids = list(tracks)
        ci = kids.index(cond)
        first_ret = next(i for i, k in enumerate(kids) if k.tag == "ReturnTrack")
        if ci != first_ret - 1:
            errs.append(f"CONDUCTOR at index {ci}, want {first_ret-1} (last regular track)")
        if cond.tag != "MidiTrack":
            errs.append(f"CONDUCTOR is {cond.tag}, want MidiTrack")
        if v(cond, "TrackUnfolded") != "false":
            errs.append("CONDUCTOR not collapsed")
        if v(cond, "DeviceChain/MidiOutputRouting/Target") != "MidiOut/None":
            errs.append("CONDUCTOR MIDI output not None")
        if len(cond.find("./DeviceChain/DeviceChain/Devices")) != 0:
            errs.append("CONDUCTOR has devices")
        if v(cond, "TrackGroupId") != "-1":
            errs.append("CONDUCTOR grouped")
        slots = cond.find(".//MainSequencer/ClipSlotList")
        n_scenes = len(ls.find("Scenes"))
        if len(slots) != n_scenes:
            errs.append(f"CONDUCTOR slot count {len(slots)} != scenes {n_scenes}")
        got = []
        for i, slot in enumerate(slots):
            clip = slot.find("ClipSlot/Value/MidiClip")
            if clip is not None:
                got.append((i, v(clip, "Name")))
                if v(clip, "FollowAction/FollowActionEnabled") != "false":
                    errs.append(f"clip {v(clip,'Name')!r}: FollowAction still enabled")
                kt = clip.find("Notes/KeyTracks")
                if kt is not None and len(kt) != 0:
                    errs.append(f"clip {v(clip,'Name')!r}: has notes")
                if v(clip, "Disabled") != "false":
                    errs.append(f"clip {v(clip,'Name')!r}: disabled")
        if [g[1] for g in got] != CLIP_NAMES:
            errs.append(f"clip names/order mismatch: {[g[1] for g in got]}")
        if got and [g[0] for g in got] != list(range(len(CLIP_NAMES))):
            errs.append(f"clips not in first {len(CLIP_NAMES)} scenes: {[g[0] for g in got]}")
        arr = cond.find(".//MainSequencer/ClipTimeable/ArrangerAutomation/Events")
        if arr is not None and len(arr) != 0:
            errs.append("CONDUCTOR has arrangement clips")

    # --- global id hygiene ---
    tids = [t.get("Id") for t in tracks]
    if len(tids) != len(set(tids)):
        errs.append("duplicate track ids")
    pointees = [int(e.get("Id")) for e in ls.iter()
                if is_pointee_tag(e.tag) and e.get("Id") is not None]
    nxt = int(v(ls, "NextPointeeId"))
    if len(pointees) != len(set(pointees)):
        from collections import Counter
        dups = [k for k, n in Counter(pointees).items() if n > 1][:5]
        errs.append(f"DUPLICATE pointee ids, e.g. {dups}")
    if max(pointees) >= nxt:
        errs.append(f"pointee id {max(pointees)} >= NextPointeeId {nxt}")
    infos.append(f"pointees: {len(pointees)} unique={len(set(pointees))}, NextPointeeId={nxt}")

    # every PointeeId reference must resolve to exactly one pointee element
    id_count = {}
    for e in ls.iter():
        if is_pointee_tag(e.tag) and e.get("Id") is not None:
            id_count[e.get("Id")] = id_count.get(e.get("Id"), 0) + 1
    refs = [e.get("Value") for e in ls.iter() if e.tag == "PointeeId"]
    bad = [r for r in refs if id_count.get(r, 0) != 1]
    if bad:
        errs.append(f"{len(bad)} PointeeId references not uniquely resolvable: {bad[:5]}")
    infos.append(f"PointeeId references: {len(refs)}, all uniquely resolved: {not bad}")

    # --- baseline accounting ---
    if baseline:
        b = load(baseline)
        bls = b.find("LiveSet")
        n_b, n_o = sum(1 for _ in bls.iter()), sum(1 for _ in ls.iter())
        infos.append(f"elements: baseline={n_b} output={n_o} added={n_o-n_b}")
        for path, label in (
            (".//Tracks", "tracks"), (".//Scenes", "scenes"),
        ):
            lb, lo = len(bls.find(path[3:])), len(ls.find(path[3:]))
            infos.append(f"{label}: {lb} -> {lo}")
        # spot-check untouched values survived reserialization
        def helix_gain(r):
            for t in r.find("Tracks"):
                if v(t, "Name/EffectiveName") == "HELIX CAPTURE IN":
                    return [v(d, "Gain/Manual") for d in
                            t.findall("./DeviceChain/DeviceChain/Devices/StereoGain")]
        hb, ho = helix_gain(bls), helix_gain(ls)
        if hb != ho:
            errs.append(f"HELIX gains changed: {hb} -> {ho}")
        else:
            infos.append(f"HELIX TRIM/FADE gains intact: {ho}")
        tb, to = v(bls, "MainTrack/DeviceChain/Mixer/Tempo/Manual"), \
                 v(ls, "MainTrack/DeviceChain/Mixer/Tempo/Manual")
        if tb != to:
            errs.append(f"tempo changed: {tb} -> {to}")
        else:
            infos.append(f"tempo intact: {to}")

        # SAFETY NET against unknown pointee-space tags: any tag FAMILY whose
        # ids are globally unique in the baseline (and numerous enough that
        # uniqueness isn't coincidence) must stay globally unique in the output.
        # This is how the ControllerTargets.N blind spot would have been caught.
        from collections import defaultdict, Counter
        def family_ids(r):
            fams = defaultdict(list)
            for e in r.iter():
                i = e.get("Id")
                if i is not None and i.lstrip("-").isdigit():
                    fams[tag_family(e.tag)].append(i)
            return fams
        fb, fo = family_ids(bls), family_ids(ls)
        derived = [f for f, ids in fb.items()
                   if len(ids) >= 50 and len(ids) == len(set(ids))]
        for fam in derived:
            ids = fo.get(fam, [])
            if len(ids) != len(set(ids)):
                dup = [k for k, n in Counter(ids).items() if n > 1][:5]
                errs.append(f"derived-unique family {fam!r} now has duplicates: {dup}")
        infos.append(f"derived globally-unique families enforced: {sorted(derived)}")

    for i in infos:
        print("  ", i)
    if errs:
        print(f"\n{len(errs)} FINDINGS:")
        for e in errs:
            print("  ERR", e)
        sys.exit(1)
    print("\nCLEAN — set prep verified.")
    sys.exit(0)


main()
