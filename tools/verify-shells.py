#!/usr/bin/env python3
"""verify-shells.py — static review gate for the generated .amxd shells.

Validates build/*.amxd against the REAL Max 9.0.9 object semantics (verified
from the bundled refpages + Ableton's shipped M4L patches), not the advisory
numinlets/numoutlets written into the patcher JSON:

  - obj-id uniqueness; generated ids must not collide with template ids (<100)
  - every patchline's outlet/inlet index in range for the real object
  - no dangling cords (source/destination box exists)
  - live.remote~: id cords (prepend id / freebang "id 0") -> inlet 1; floats -> inlet 0
  - pattr: binds js via outlet 1 ("bindto connection"), not outlet 0
  - live.text: mode 0 = Button (ABORT/RITUAL), mode 1 = Toggle (everything else)
  - buttons wired straight to message boxes (button mode emits bang; [sel 1] never fires)
  - documented chains present: init (live.thisdevice->deferlow->init->js) and
    clock (plugsync~ outlet 6 -> /480. -> speedlim 33 -> prepend sync -> js)
  - grab-pool slot counts: CONDUCTOR 24, SENTINEL 7

Run after any change to tools/build-shells.mjs:
    node tools/build-shells.mjs && python3 tools/verify-shells.py
Exit 0 = clean, 1 = findings.
"""
import struct, json, glob, sys, os

EXPECT_SLOTS = {"CONDUCTOR": 24, "SENTINEL": 7}
BUTTONS = {"ABORT", "RITUAL"}  # everything else live.text is a toggle

def real_io(maxclass, text):
    t = text or ""
    if maxclass == "newobj":
        parts = t.split()
        head = parts[0] if parts else ""
        if head == "js": return (1, 3)
        if head == "plugsync~": return (1, 9)
        if head == "/": return (2, 1)
        if head == "speedlim": return (2, 1)
        if head == "prepend": return (2, 1)
        if head == "deferlow": return (1, 1)
        if head == "freebang": return (1, 1)
        if head == "route": return (1, len(parts))
        if head == "sel": return ((2, 2) if len(parts) == 2 else (1, len(parts)))
        if head == "pattr": return (1, 3)
        if head == "s": return (1, 0)
        if head == "r": return (0, 1)
        if head == "node.script": return (1, 2)
        if head == "live.thisdevice": return (1, 3)
        if head == "live.remote~": return (2, 0)
        if head == "plugin~": return (1, 2)
        if head == "plugout~": return (3, 2)
        return None
    return {"message": (2, 1), "comment": (1, 0), "live.comment": (1, 0),
            "live.text": (1, 2), "live.tab": (1, 3), "live.numbox": (1, 2)}.get(maxclass)

def load(path):
    d = open(path, "rb").read()
    i = d.find(b"ptch")
    ln = struct.unpack("<I", d[i + 4:i + 8])[0]
    js = d[i + 8:i + 8 + ln].decode()
    return json.loads(js[: js.rfind("}") + 1])["patcher"]

def review(path):
    name = os.path.splitext(os.path.basename(path))[0]
    p = load(path)
    errs = []
    boxes = {}
    for b in p["boxes"]:
        bx = b["box"]
        if bx["id"] in boxes:
            errs.append(f"duplicate id {bx['id']}")
        boxes[bx["id"]] = bx

    txt = lambda b: b.get("text") or ""

    for l in p["lines"]:
        pl = l["patchline"]
        (sid, so), (did, di) = pl["source"], pl["destination"]
        sb, db = boxes.get(sid), boxes.get(did)
        if not sb or not db:
            errs.append(f"dangling cord {sid}->{did}")
            continue
        sio = real_io(sb["maxclass"], txt(sb))
        dio = real_io(db["maxclass"], txt(db))
        if sio and so >= sio[1]:
            errs.append(f"{sid} ({txt(sb) or sb['maxclass']}) outlet {so} out of range (real {sio[1]})")
        if dio and di >= dio[0]:
            errs.append(f"{did} ({txt(db) or db['maxclass']}) inlet {di} out of range (real {dio[0]})")

    def cords():
        for l in p["lines"]:
            pl = l["patchline"]
            yield boxes[pl["source"][0]], pl["source"][1], boxes[pl["destination"][0]], pl["destination"][1]

    for sb, so, db, di in cords():
        st, dt = txt(sb), txt(db)
        if dt.startswith("live.remote~"):
            is_id = st.startswith("prepend id") or (sb["maxclass"] == "message" and st == "id 0")
            if is_id and di != 1:
                errs.append(f"live.remote~ id cord into inlet {di} (must be 1): from '{st}'")
            if st.startswith("route id val") and so == 1 and di != 0:
                errs.append(f"live.remote~ val cord into inlet {di} (must be 0)")
        if st.startswith("pattr") and dt.startswith("js ") and so != 1:
            errs.append(f"pattr binds via outlet {so} (must be 1 = bindto)")
        if sb["maxclass"] == "live.text" and txt(sb) in BUTTONS and dt.startswith("sel"):
            errs.append(f"button '{st}' wired through [sel] — button mode emits bang, sel never fires")

    for b in boxes.values():
        if b["maxclass"] == "live.text":
            want = 0 if txt(b) in BUTTONS else 1
            if b.get("mode") != want:
                errs.append(f"live.text '{txt(b)}' mode={b.get('mode')} (want {want}; 0=Button 1=Toggle)")

    chain = [("live.thisdevice", "deferlow"), ("deferlow", "init"),
             ("plugsync~", "/ 480."), ("/ 480.", "speedlim 33"),
             ("speedlim 33", "prepend sync"), ("prepend sync", "js ")]
    for a, bnm in chain:
        if not any(txt(sb).startswith(a) and (txt(db) or db["maxclass"]).startswith(bnm)
                   for sb, _, db, _ in cords()):
            errs.append(f"missing documented cord {a} -> {bnm}")
    for sb, so, db, _ in cords():
        if txt(sb) == "plugsync~" and so != 6:
            errs.append(f"plugsync~ tapped at outlet {so} (clock must use 6 = raw ticks)")

    n_rem = sum(1 for b in boxes.values() if txt(b).startswith("live.remote~"))
    if name in EXPECT_SLOTS and n_rem != EXPECT_SLOTS[name]:
        errs.append(f"grab pool has {n_rem} live.remote~ (expect {EXPECT_SLOTS[name]})")

    status = "CLEAN" if not errs else f"{len(errs)} FINDINGS"
    print(f"{path}: {len(boxes)} boxes, {len(p['lines'])} cords, {n_rem} remotes — {status}")
    for e in errs:
        print("   ERR", e)
    return not errs

paths = sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "build", "*.amxd")))
if not paths:
    print("no build/*.amxd found — run: node tools/build-shells.mjs")
    sys.exit(1)
sys.exit(0 if all([review(p) for p in paths]) else 1)
