#!/usr/bin/env python3
"""helix_bank.py — Helix bank tools for eduardo-rig-brain.

Parses a Line 6 HX "Stadium" setlist bank (.hss) and offers three jobs:

    python3 tools/helix_bank.py audit "<bank.hss>" [--jsonl out.jsonl]
    python3 tools/helix_bank.py card  "<bank.hss>" -o out/helix-card.html
    python3 tools/helix_bank.py diff  "<old.hss>" "<new.hss>"

  audit  gain-staging audit across all presets: flags output-block level
         outliers, muted output paths, and cab/IR level jumps — anything that
         will make one preset jump out louder (or vanish) next to its neighbours.
  card   one-page printable card for the music stand: preset names, colour
         chips, snapshot maps, grouped bass / guitar / ambient.
  diff   compares two banks slot-by-slot (names, output gains, presence) — to
         confirm imported presets (GD-ETERNITY, DRONE IN D, …) landed right.

READ-ONLY. Never writes the .hss.

Format (reverse-engineered from the real bank):
  .hss = 24-byte header ("GGGY"…"LTES"… + counts) then a gzip stream; the
  gunzipped payload is a POSIX tar of:
     manifest.json          {"contents":[{"path":".1","type":"application/stadium-preset"|"<null>"}]}
     .1 .2 .3 …             one file per slot. Each preset file is an 8-byte
                            magic ("rpshnosj") followed by UTF-8 JSON:
        meta   {name, color, info, device_id, device_version}
        preset {flow:[path,…], snapshots:[{name,color,tempo,valid}], params,
                sources, commands, clip}
     A slot with type "<null>" / a 1-byte body is an empty slot.
  Inside flow, blocks are keys b00,b01,… each with slot:[{model, params:{...}}].
  Output blocks   : model startswith "P35_Output"  -> params.gain (dB), pan.
  Cab/IR blocks   : model contains "CabMicIr"       -> params.Level (dB).
  Amp blocks      : model contains "Amp"/"Preamp"   -> params.ChVol / gain.
"""
import argparse
import gzip
import io
import json
import os
import re
import statistics
import sys
import tarfile

HSS_HEADER_LEN = 24
PRESET_MAGIC_LEN = 8   # "rpshnosj"

# colour -> rough instrument family (secondary signal; name prefix wins)
COLOR_FAMILY = {
    "dkorange": "bass", "ltorange": "bass",
    "turquoise": "guitar", "blue": "guitar", "white": "guitar",
    "pink": "ambient", "purple": "ambient", "green": "ambient", "auto": "ambient",
}

OUTPUT_OUTLIER_DB = 3.0   # output gain this far from the bank median = flag
CAB_OUTLIER_DB = 4.0      # cab/IR level this far from the bank median = flag
MUTE_DB = -60.0           # at/below this an output path is effectively muted


# ---------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------
class Preset(object):
    def __init__(self, slot, name, color, info, tempo, outputs, cabs, amps,
                 snapshots, n_blocks):
        self.slot = slot
        self.name = name
        self.color = color
        self.info = info
        self.tempo = tempo
        self.outputs = outputs       # [(model, gain_db, pan)]
        self.cabs = cabs             # [(model, level_db)]
        self.amps = amps             # [(model, chvol_or_gain)]
        self.snapshots = snapshots   # [name, ...] valid only
        self.n_blocks = n_blocks

    @property
    def family(self):
        n = self.name.lower()
        if n.startswith("bas:") or "bass" in n or "bss" in n:
            return "bass"
        if (n.startswith(("pad:", "aco:", "gd-", "b&g", "bg ", "ub:"))
                or any(w in n for w in ("ambient", "wash", "dream", "pad",
                                        "cinematic", "swell", "organ", "drone",
                                        "healing", "prism", "whale"))):
            return "ambient"
        return COLOR_FAMILY.get(self.color, "guitar")

    @property
    def max_output_db(self):
        vals = [g for _, g, _ in self.outputs if g is not None]
        return max(vals) if vals else None


def _iter_blocks(flow):
    if not isinstance(flow, list):
        return
    for path in flow:
        if not isinstance(path, dict):
            continue
        for k, blk in path.items():
            if (isinstance(k, str) and k.startswith("b") and k[1:].isdigit()
                    and isinstance(blk, dict) and "slot" in blk):
                for s in (blk.get("slot") or []):
                    if isinstance(s, dict) and "model" in s:
                        yield s


def _param(s, name):
    p = (s.get("params") or {}).get(name)
    if isinstance(p, dict):
        return p.get("value")
    return p


def parse_preset(slot, raw):
    """raw = full slot file bytes (magic + json). Returns Preset or None (empty)."""
    if len(raw) <= PRESET_MAGIC_LEN + 1:
        return None
    try:
        d = json.loads(raw[PRESET_MAGIC_LEN:])
    except Exception:
        return None
    pr = d.get("preset") or {}
    flow = pr.get("flow")
    if not flow:
        return None
    meta = d.get("meta") or {}
    outputs, cabs, amps = [], [], []
    n_blocks = 0
    for s in _iter_blocks(flow):
        n_blocks += 1
        model = s["model"]
        if model.startswith("P35_Output"):
            outputs.append((model, _num(_param(s, "gain")), _num(_param(s, "pan"))))
        elif "CabMicIr" in model:
            cabs.append((model, _num(_param(s, "Level"))))
        elif "Amp" in model or "Preamp" in model:
            amps.append((model, _num(_param(s, "ChVol"))
                         if _param(s, "ChVol") is not None else _num(_param(s, "gain"))))
    snaps = [sn.get("name") for sn in pr.get("snapshots", [])
             if isinstance(sn, dict) and sn.get("valid")]
    tempo = _num((pr.get("params") or {}).get("tempo"))
    return Preset(slot, meta.get("name", "?"), meta.get("color", "auto"),
                  meta.get("info", "") or "", tempo, outputs, cabs, amps,
                  snaps, n_blocks)


def _num(x):
    try:
        return round(float(x), 2)
    except (TypeError, ValueError):
        return None


def read_bank(path):
    """Returns (manifest, [Preset...]) sorted by slot number, filled only."""
    with open(path, "rb") as f:
        blob = f.read()
    if blob[:4] != b"GGGY":
        raise ValueError("not an HX Stadium bank (bad magic): %s" % path)
    inner = gzip.decompress(blob[HSS_HEADER_LEN:])
    presets = []
    manifest = None
    with tarfile.open(fileobj=io.BytesIO(inner)) as tar:
        for m in tar.getmembers():
            fobj = tar.extractfile(m)
            if fobj is None:
                continue
            data = fobj.read()
            if m.name == "manifest.json":
                try:
                    manifest = json.loads(data)
                except Exception:
                    manifest = None
                continue
            mm = re.fullmatch(r"\.(\d+)", m.name)
            if not mm:
                continue
            p = parse_preset(int(mm.group(1)), data)
            if p:
                presets.append(p)
    presets.sort(key=lambda p: p.slot)
    return manifest, presets


# ---------------------------------------------------------------------------
# audit
# ---------------------------------------------------------------------------
def cmd_audit(args):
    manifest, presets = read_bank(args.bank)
    findings = []
    n_slots = len(manifest["contents"]) if manifest else "?"
    print("\nHELIX GAIN-STAGING AUDIT — %s" % os.path.basename(args.bank))
    print("  %d filled presets (of %s slots)\n" % (len(presets), n_slots))

    out_vals = [p.max_output_db for p in presets if p.max_output_db is not None]
    med = statistics.median(out_vals) if out_vals else 0.0
    print("  output-gain median across bank: %+.1f dB\n" % med)

    def add(sev, slot, name, msg, data=None):
        findings.append({"severity": sev, "slot": slot, "name": name,
                         "message": msg, "data": data or {}})

    # output level outliers + muted paths
    for p in presets:
        for model, g, pan in p.outputs:
            if g is None:
                continue
            if g <= MUTE_DB:
                add("YELLOW", p.slot, p.name,
                    "output path %s muted (%.0f dB) — intentional dual-path, or dead?"
                    % (model.replace("P35_", ""), g), {"gain": g, "model": model})
        if p.max_output_db is not None and abs(p.max_output_db - med) > OUTPUT_OUTLIER_DB:
            add("RED" if abs(p.max_output_db - med) > 2 * OUTPUT_OUTLIER_DB else "YELLOW",
                p.slot, p.name,
                "output %+.1f dB is %+.1f dB vs bank median — will jump out %s"
                % (p.max_output_db, p.max_output_db - med,
                   "LOUDER" if p.max_output_db > med else "quieter"),
                {"max_output_db": p.max_output_db, "delta": round(p.max_output_db - med, 2)})

    # cab/IR level jumps (within the bank's cab population)
    cab_vals = [lvl for p in presets for _, lvl in p.cabs if lvl is not None]
    if cab_vals:
        cmed = statistics.median(cab_vals)
        for p in presets:
            for model, lvl in p.cabs:
                if lvl is not None and abs(lvl - cmed) > CAB_OUTLIER_DB:
                    add("YELLOW", p.slot, p.name,
                        "cab/IR level %+.1f dB is %+.1f dB vs cab median (%.1f)"
                        % (lvl, lvl - cmed, cmed),
                        {"cab_level_db": lvl, "model": model})

    reds = [f for f in findings if f["severity"] == "RED"]
    yel = [f for f in findings if f["severity"] == "YELLOW"]
    for sev, group in (("RED", reds), ("YELLOW", yel)):
        if not group:
            continue
        print("%s:" % ("LEVEL OUTLIERS (RED)" if sev == "RED" else "WATCH (YELLOW)"))
        for f in sorted(group, key=lambda x: x["slot"]):
            print("  %-6s [slot %3d] %-22s %s"
                  % (f["severity"], f["slot"], f["name"][:22], f["message"]))
        print("")

    if args.jsonl:
        with open(args.jsonl, "w") as fh:
            for f in findings:
                fh.write(json.dumps(f) + "\n")
        print("wrote %d findings -> %s" % (len(findings), args.jsonl))

    print("%d outlier/mute findings (%d RED, %d YELLOW)."
          % (len(findings), len(reds), len(yel)))
    return 1 if reds else 0


# ---------------------------------------------------------------------------
# card
# ---------------------------------------------------------------------------
PALETTE = {
    "dkorange": "#c2622a", "ltorange": "#e3974a", "turquoise": "#2bb3a3",
    "blue": "#3b7dd8", "white": "#d8d8d8", "pink": "#d65a9a",
    "purple": "#8a6bd6", "green": "#4caf6e", "auto": "#8a8f98",
}
FAMILY_ORDER = ["bass", "guitar", "ambient"]
FAMILY_LABEL = {"bass": "BASS  (left)", "guitar": "GUITAR  (center)",
                "ambient": "AMBIENT  (end)"}


def cmd_card(args):
    manifest, presets = read_bank(args.bank)
    out = args.output or "out/helix-card.html"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    groups = {fam: [] for fam in FAMILY_ORDER}
    for p in presets:
        groups[p.family].append(p)

    def chip(color):
        return ('<span class="chip" style="background:%s"></span>'
                % PALETTE.get(color, "#888"))

    def snap_cells(p):
        if not p.snapshots:
            return '<span class="dim">—</span>'
        # hide the boring default SNAPSHOT N names
        named = [s for s in p.snapshots if not re.fullmatch(r"SNAPSHOT \d+", s or "")]
        if not named:
            return '<span class="dim">%d snaps</span>' % len(p.snapshots)
        return " · ".join(named)

    rows = []
    for fam in FAMILY_ORDER:
        ps = groups[fam]
        if not ps:
            continue
        rows.append('<tr class="fam"><td colspan="4">%s</td></tr>' % FAMILY_LABEL[fam])
        for p in sorted(ps, key=lambda x: x.slot):
            tempo = ("%g" % p.tempo) if p.tempo else ""
            rows.append(
                '<tr><td class="slot">%d</td>'
                '<td class="name">%s%s</td>'
                '<td class="tempo">%s</td>'
                '<td class="snaps">%s</td></tr>'
                % (p.slot, chip(p.color),
                   _esc(p.name), tempo, _esc_keep(snap_cells(p))))

    html = _CARD_TEMPLATE % {
        "title": _esc(os.path.basename(args.bank)),
        "count": len(presets),
        "rows": "\n".join(rows),
    }
    with open(out, "w") as fh:
        fh.write(html)
    print("wrote music-stand card (%d presets) -> %s" % (len(presets), out))
    print("open it in a browser and Print / Save-as-PDF for the stand.")
    return 0


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _esc_keep(s):
    # snap_cells already returns safe html (chips/spans) — pass through
    return s


_CARD_TEMPLATE = """<!doctype html><html><head><meta charset="utf-8">
<title>Helix Card — %(title)s</title>
<style>
  :root { --ground:#15130f; --ink:#f3ead9; --rust:#c2622a; --teal:#2bb3a3; --dim:#7c756a; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--ground); color:var(--ink);
         font-family:'JetBrains Mono',ui-monospace,Menlo,monospace; padding:18px; }
  h1 { font-size:15px; letter-spacing:.04em; margin:0 0 2px; }
  .sub { color:var(--dim); font-size:11px; margin-bottom:10px; }
  table { width:100%%; border-collapse:collapse; }
  td { padding:2px 6px; font-size:12px; border-bottom:1px solid #2a261f; vertical-align:top; }
  tr.fam td { color:var(--teal); font-size:11px; letter-spacing:.12em; font-weight:700;
              padding-top:10px; border-bottom:1px solid var(--teal); }
  .slot { color:var(--dim); width:34px; text-align:right; }
  .name { font-weight:600; }
  .tempo { color:var(--rust); width:42px; text-align:right; }
  .snaps { color:#c9bfa9; font-size:11px; }
  .dim { color:var(--dim); }
  .chip { display:inline-block; width:9px; height:9px; border-radius:2px;
          margin-right:7px; vertical-align:middle; }
  @media print {
    body { background:#fff; color:#111; padding:0; }
    tr.fam td { color:#000; border-bottom:1px solid #000; }
    .slot,.dim,.sub { color:#666; } .tempo { color:#a33; } .snaps { color:#333; }
    td { border-bottom:1px solid #ddd; }
  }
</style></head><body>
<h1>HELIX BANK — %(title)s</h1>
<div class="sub">%(count)d presets · slot · ●colour · tempo · snapshots · bass→guitar→ambient</div>
<table>%(rows)s</table>
</body></html>"""


# ---------------------------------------------------------------------------
# diff
# ---------------------------------------------------------------------------
def cmd_diff(args):
    _, a = read_bank(args.old)
    _, b = read_bank(args.new)
    ma = {p.slot: p for p in a}
    mb = {p.slot: p for p in b}
    slots = sorted(set(ma) | set(mb))
    print("\nHELIX BANK DIFF")
    print("  old: %s (%d presets)" % (os.path.basename(args.old), len(a)))
    print("  new: %s (%d presets)\n" % (os.path.basename(args.new), len(b)))
    changes = 0
    for s in slots:
        pa, pb = ma.get(s), mb.get(s)
        if pa and not pb:
            print("  - [slot %3d] removed: %s" % (s, pa.name)); changes += 1
        elif pb and not pa:
            print("  + [slot %3d] added:   %s" % (s, pb.name)); changes += 1
        else:
            if pa.name != pb.name:
                print("  ~ [slot %3d] renamed: %r -> %r" % (s, pa.name, pb.name))
                changes += 1
            da, db = pa.max_output_db, pb.max_output_db
            if da is not None and db is not None and abs(da - db) > 0.05:
                print("  ~ [slot %3d] %s output %+.1f -> %+.1f dB"
                      % (s, pb.name[:20], da, db)); changes += 1
    if not changes:
        print("  identical (names + output gains).")
    else:
        print("\n  %d differences." % changes)
    return 0


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Helix bank tools")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pa = sub.add_parser("audit", help="gain-staging audit")
    pa.add_argument("bank")
    pa.add_argument("--jsonl")
    pa.set_defaults(func=cmd_audit)

    pc = sub.add_parser("card", help="printable music-stand card (HTML)")
    pc.add_argument("bank")
    pc.add_argument("-o", "--output")
    pc.set_defaults(func=cmd_card)

    pd = sub.add_parser("diff", help="compare two banks")
    pd.add_argument("old")
    pd.add_argument("new")
    pd.set_defaults(func=cmd_diff)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
