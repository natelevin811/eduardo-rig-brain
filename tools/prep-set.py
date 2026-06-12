#!/usr/bin/env python3
"""prep-set.py — automated Live-set prep for eduardo-rig-brain (SHELL-BUILD §3).

Operates on a COPY of the .als (gzipped XML). Never touches the source file.

What it does:
  1. SENTRIM ×6 — clones an existing neutral Utility (StereoGain) and appends it
     (named SENTRIM, 0 dB, all audible params neutralized) at the END of each of
     the six bus chains: LoDrumsBus/HiDrumsBus/PercBus/BassBus/PadsBus/LeadsBus.
  2. CONDUCTOR track — clones the simplest MIDI track (42-ShephardsTone), strips
     devices/clips/automation, renames it CONDUCTOR, MIDI output None, collapsed,
     inserts it as the last regular track (before the returns), and fills its
     first 19 scene slots with the empty named command clips from the spec.

Hard-won representation facts (verified against the v5 set, 2026-06-12):
  * Utility Gain `Manual` is stored LINEAR in XML (10^(dB/20)) even though the
    UI and LOM are dB-native. 0 dB == 1.0. (HELIX TRIM 7.78 dB == 2.4484 in XML.)
  * Pointee-space ids (must be globally unique, < NextPointeeId) live on exactly
    three tags: AutomationTarget, ModulationTarget, Pointee. Every cloned subtree
    gets fresh ids and NextPointeeId is bumped.
  * ClipSlot/Scene/device ids are sibling-scoped — cloned values are safe.
  * Track ids share one space (max 166 in v5); new track gets max+1.
  * Donor clips have FollowAction ENABLED (ShephardsTone cycles) — command clips
    must disable it or every launch would chain to the next slot.

Usage:
    python3 tools/prep-set.py "<src.als>" "<out.als>"
"""
import copy
import gzip
import sys
import xml.etree.ElementTree as ET

BUSES = ["LoDrumsBus", "HiDrumsBus", "PercBus", "BassBus", "PadsBus", "LeadsBus"]
DONOR_UTILITY_TRACK = "CptrBssAudio"   # StereoGain with all-default audible params
DONOR_MIDI_TRACK = "42-ShephardsTone"  # simplest MIDI track, no arrangement clips


def is_pointee_tag(tag):
    """Tags whose Id attr draws from the LiveSet's global NextPointeeId counter.

    NOT just AutomationTarget/ModulationTarget/Pointee: adversarial review of a
    first-cut output proved MainSequencer's ControllerTargets.<n> (131 per MIDI
    track) and FreezeSequencer's Volume/Transposition/...ModulationTarget
    variants are allocated from the same counter and MUST be remapped on clone
    (six 42-ShephardsTone clip envelopes reference ControllerTargets.0 by
    PointeeId — a duplicate would risk silently rebinding them).
    """
    return (tag == "Pointee"
            or tag.endswith("AutomationTarget")
            or tag.endswith("ModulationTarget")
            or tag.startswith("ControllerTargets."))

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
CONDUCTOR_COLOR = "12"


def v(el, path):
    e = el.find(path)
    return e.get("Value") if e is not None else None


def setv(el, path, value):
    e = el.find(path)
    if e is None:
        raise RuntimeError(f"missing element {path}")
    e.set("Value", value)


class PointeeAllocator:
    def __init__(self, liveset):
        self.el = liveset.find("NextPointeeId")
        self.next = int(self.el.get("Value"))

    def remap(self, subtree):
        n = 0
        for e in subtree.iter():
            if is_pointee_tag(e.tag) and e.get("Id") is not None:
                e.set("Id", str(self.next))
                self.next += 1
                n += 1
        return n

    def commit(self):
        self.el.set("Value", str(self.next))


def find_track(tracks, name):
    for t in tracks:
        if v(t, "Name/EffectiveName") == name:
            return t
    raise RuntimeError(f"track not found: {name}")


def add_sentrims(ls, tracks, alloc):
    donor_track = find_track(tracks, DONOR_UTILITY_TRACK)
    donor = donor_track.find("./DeviceChain/DeviceChain/Devices/StereoGain")
    if donor is None:
        raise RuntimeError("donor StereoGain not found")
    added = 0
    for bus in BUSES:
        t = find_track(tracks, bus)
        devices = t.find("./DeviceChain/DeviceChain/Devices")
        sg = copy.deepcopy(donor)
        # sibling-scoped device id: max existing + 1
        sib = [int(d.get("Id")) for d in devices if d.get("Id", "").lstrip("-").isdigit()]
        sg.set("Id", str(max(sib + [-1]) + 1))
        alloc.remap(sg)
        setv(sg, "UserName", "SENTRIM")
        # neutral + 0 dB. Gain Manual is LINEAR: 0 dB == 1.0 (NOT 0.0 == -inf!)
        setv(sg, "Gain/Manual", "1")
        setv(sg, "On/Manual", "true")
        setv(sg, "Mute/Manual", "false")
        setv(sg, "Mono/Manual", "false")
        setv(sg, "BassMono/Manual", "false")
        setv(sg, "StereoWidth/Manual", "1")
        setv(sg, "Balance/Manual", "0")
        setv(sg, "PhaseInvertL/Manual", "false")
        setv(sg, "PhaseInvertR/Manual", "false")
        setv(sg, "DcFilter/Manual", "false")
        for lom in sg.findall(".//LomId"):
            lom.set("Value", "0")
        devices.append(sg)  # END of chain
        added += 1
    return added


def make_command_clip(donor_clip, name):
    c = copy.deepcopy(donor_clip)
    c.set("Id", "0")
    c.set("Time", "0")
    setv(c, "Name", name)
    setv(c, "CurrentStart", "0")
    setv(c, "CurrentEnd", "4")  # 1 bar in 4/4
    loop = c.find("Loop")
    for k, val in (("LoopStart", "0"), ("LoopEnd", "4"), ("StartRelative", "0"),
                   ("LoopOn", "true"), ("OutMarker", "4"),
                   ("HiddenLoopStart", "0"), ("HiddenLoopEnd", "4")):
        setv(loop, k, val) if loop.find(k) is None else loop.find(k).set("Value", val)
    setv(c, "Disabled", "false")
    setv(c, "LaunchQuantisation", "0")  # global (1 bar per setmap)
    setv(c, "Legato", "false")
    # donor has FollowAction enabled (ShephardsTone cycles) — kill it
    fa = c.find("FollowAction")
    setv(fa, "FollowActionEnabled", "false")
    setv(fa, "FollowActionA", "0")
    setv(fa, "FollowActionB", "0")
    setv(fa, "LoopIterations", "1")
    # strip notes: empty KeyTracks + PerNoteEventStore
    notes = c.find("Notes")
    for tag in ("KeyTracks", "PerNoteEventStore"):
        node = notes.find(tag)
        if node is not None:
            for child in list(node):
                node.remove(child)
    # strip clip envelopes
    env = c.find("Envelopes/Envelopes")
    if env is not None:
        for child in list(env):
            env.remove(child)
    for lom in c.findall(".//LomId"):
        lom.set("Value", "0")
    return c


def add_conductor_track(ls, tracks, alloc):
    donor = find_track(tracks, DONOR_MIDI_TRACK)
    donor_clip = donor.find(".//MainSequencer/ClipSlotList//MidiClip")
    if donor_clip is None:
        raise RuntimeError("donor MidiClip not found")

    t = copy.deepcopy(donor)
    track_ids = [int(x.get("Id")) for x in tracks]
    t.set("Id", str(max(track_ids) + 1))
    setv(t, "Name/EffectiveName", "CONDUCTOR")
    setv(t, "Name/UserName", "CONDUCTOR")
    if t.find("Name/MemorizedFirstClipName") is not None:
        setv(t, "Name/MemorizedFirstClipName", "")
    setv(t, "Color", CONDUCTOR_COLOR)
    setv(t, "TrackUnfolded", "false")  # collapsed
    setv(t, "TrackGroupId", "-1")

    # no devices
    devices = t.find("./DeviceChain/DeviceChain/Devices")
    for d in list(devices):
        devices.remove(d)

    # no track automation
    env = t.find("AutomationEnvelopes/Envelopes")
    if env is not None:
        for child in list(env):
            env.remove(child)

    # MIDI output: None (donor already None; assert + enforce)
    mor = t.find("DeviceChain/MidiOutputRouting")
    setv(mor, "Target", "MidiOut/None")
    setv(mor, "UpperDisplayString", "None")
    setv(mor, "LowerDisplayString", "")

    # session slots: empty everything, then fill first 19 with command clips
    slots = t.find(".//MainSequencer/ClipSlotList")
    slot_list = list(slots)
    if len(slot_list) < len(CLIP_NAMES):
        raise RuntimeError(f"only {len(slot_list)} slots for {len(CLIP_NAMES)} clips")
    filled = 0
    for i, slot in enumerate(slot_list):
        value = slot.find("ClipSlot/Value")
        if value is None:
            raise RuntimeError(f"slot {i} has no ClipSlot/Value")
        for child in list(value):
            value.remove(child)
        if i < len(CLIP_NAMES):
            value.append(make_command_clip(donor_clip, CLIP_NAMES[i]))
            filled += 1
        stop = slot.find("HasStop")
        if stop is not None:
            stop.set("Value", "true")

    # no arrangement clips / automation on the timeline
    for path in (".//MainSequencer/ClipTimeable/ArrangerAutomation/Events",):
        node = t.find(path)
        if node is not None:
            for child in list(node):
                node.remove(child)

    # freeze sequencer slots: empty (donor's already are, enforce anyway)
    fz = t.find(".//FreezeSequencer/ClipSlotList")
    if fz is not None:
        for slot in fz:
            value = slot.find("ClipSlot/Value")
            if value is not None:
                for child in list(value):
                    value.remove(child)

    for lom in t.findall(".//LomId"):
        lom.set("Value", "0")
    setv(t, "SavedPlayingSlot", "-1")

    n_pointees = alloc.remap(t)

    # insert as last regular track (before the first ReturnTrack)
    kids = list(tracks)
    insert_at = next(i for i, k in enumerate(kids) if k.tag == "ReturnTrack")
    tracks.insert(insert_at, t)
    return filled, n_pointees


def main():
    src, out = sys.argv[1], sys.argv[2]
    if src == out:
        raise SystemExit("refusing: src and out are the same file")
    print(f"reading {src} ...")
    raw = gzip.open(src, "rb").read()
    root = ET.fromstring(raw)
    ls = root.find("LiveSet")
    tracks = ls.find("Tracks")
    n_scenes = len(ls.find("Scenes"))
    alloc = PointeeAllocator(ls)
    p0 = alloc.next

    n_sent = add_sentrims(ls, tracks, alloc)
    n_clips, n_ptr = add_conductor_track(ls, tracks, alloc)
    alloc.commit()

    print(f"SENTRIM added to {n_sent} buses (Gain=1.0 linear == 0 dB, neutral)")
    print(f"CONDUCTOR track inserted with {n_clips} command clips "
          f"({n_scenes} scene slots aligned)")
    print(f"pointee ids remapped: {alloc.next - p0} fresh "
          f"(NextPointeeId {p0} -> {alloc.next})")

    print(f"writing {out} ...")
    body = ET.tostring(root, encoding="UTF-8", xml_declaration=True)
    with gzip.open(out, "wb", compresslevel=6) as f:
        f.write(body)
    print("done.")


if __name__ == "__main__":
    main()
