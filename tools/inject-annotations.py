import json, struct, sys

ANN = {
 'CONDUCTOR': {
   'ctl_alive':   ('ALIVE',    'Gentle idle drift on Pads/Leads sends so a held mix never sounds frozen. Hands always win; auto-suspends during moves. Off by default.'),
   'ctl_dryrun':  ('DRY-RUN',  'Engine runs and the dashboard shows everything, but nothing is written into Live. Rehearse moves silently. Locked off in SHOW.'),
   'ctl_mode':    ('MODE',     'REHEARSE: chatty, auto-RITUAL, full telemetry. SHOW: quiet, rate-capped, nothing automatic.'),
   'ctl_abort':   ('ABORT',    'Kill the current move/sequence now - release all grabs and snap parameters to rest. Kill-order layer 2.'),
   'ctl_grabtest':('TEST',     'Grab-pool probe + re-resolve: nudges PadsBus send B and PercBus DJ to prove control works, and re-runs name resolution if anything is unresolved.'),
 },
 'SENTINEL': {
   'ctl_ritual':  ('RITUAL',   'Pre-show reset + verify: center DJ filters & crossfader, EQ unity, zero SENTRIM trims, set capture marks, re-resolve names. Run before the set.'),
   'ctl_nightarc':('NIGHT ARC','Slow over-the-night release bias: lets bus trims settle slightly low across the evening (max -2 dB). Off by default.'),
   'ctl_mode':    ('MODE',     'REHEARSE: chatty, auto-RITUAL, full telemetry. SHOW: quiet, rate-capped, nothing automatic.'),
   'ctl_dryrun':  ('DRY-RUN',  'Compute and display headroom trims but write nothing into Live. Rehearse the guard silently.'),
 },
}

def patch(path, name):
    raw = open(path,'rb').read()
    # chunk walk to find ptch
    assert raw[0:4]==b'ampf'
    assert raw[24:28]==b'ptch', 'unexpected layout'
    jstart = 32
    jbytes = raw[jstart:]
    doc = json.loads(jbytes.decode('utf-8'))
    boxes = doc['patcher']['boxes']
    applied = 0
    want = ANN[name]
    for entry in boxes:
        b = entry.get('box', {})
        vn = b.get('varname')
        if vn in want:
            title, text = want[vn]
            b['annotation'] = text
            b['annotation_name'] = title
            applied += 1
    assert applied == len(want), f'{name}: applied {applied} of {len(want)} (varnames missing?)'
    newjson = json.dumps(doc, ensure_ascii=False, indent=1).encode('utf-8')
    header = raw[:28] + struct.pack('<I', len(newjson))
    out = header + newjson
    open(path,'wb').write(out)
    # re-validate: parse back
    r2 = open(path,'rb').read()
    assert r2[24:28]==b'ptch'
    sz = struct.unpack('<I', r2[28:32])[0]
    assert sz == len(r2)-32 == len(newjson), 'size field mismatch'
    json.loads(r2[32:].decode('utf-8'))  # must parse
    print(f'{name}: injected {applied} annotations, ptch size {sz}, file {len(out)} bytes — re-parsed OK')

patch('build/CONDUCTOR.amxd','CONDUCTOR')
patch('build/SENTINEL.amxd','SENTINEL')
