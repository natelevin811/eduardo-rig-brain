#!/usr/bin/env node
// build-shells.mjs — generate the two .amxd device shells for eduardo-rig-brain.
//
// WHY THIS EXISTS
//   SHELL-BUILD.md asks a human to hand-wire two Max for Live devices in the
//   Max editor — the worst of it being a grab pool of 24 (CONDUCTOR) / 7
//   (SENTINEL) identical live.remote~ columns, each with its own patch cords.
//   That is exactly the kind of repetitive, error-prone work a script should do.
//
// HOW IT WORKS
//   A .amxd file is a tiny chunked wrapper around a Max patcher, which is just
//   JSON: { "patcher": { boxes:[...], lines:[...] } }. We clone Ableton's own
//   empty "Max Audio Effect.amxd" template (keeping ALL of its device metadata
//   and the plugin~->plugout~ audio passthrough), append our generated objects
//   and patch cords with fresh ids, recompute the ptch chunk length, and write
//   the new device. The .js brains hot-reload (autowatch=1), so the shell is
//   built once and never touched again.
//
// USAGE
//   node tools/build-shells.mjs            # writes build/CONDUCTOR.amxd + SENTINEL.amxd
//   MAX_TEMPLATE=/path/to/AudioEffect.amxd node tools/build-shells.mjs
//
// Target runtime: Max for Live 9.0.9 (bundled in Ableton Live 12). Verified the
// patcher schema + plugsync~ outlet map against that exact bundle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'build');

const DEFAULT_TEMPLATE =
  '/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Misc/Max Devices/Max Audio Effect.amxd';
const TEMPLATE = process.env.MAX_TEMPLATE || DEFAULT_TEMPLATE;

// plugsync~ outlet map (Max 9.0.9, confirmed against the bundled help patch):
//   0 play/stop · 1 bar · 2 beat · 3 tick · 4 timesig · 5 tempo
//   6 raw ticks (cumulative, float) · 7 sample count · 8 flags
// Cumulative beats = raw_ticks / 480 (Live/Max PPQ). Tempo-independent.
const PLUGSYNC_RAWTICKS_OUTLET = 6;
const TICKS_PER_BEAT = 480;

// ---------------------------------------------------------------------------
// .amxd chunk read/write
// ---------------------------------------------------------------------------
// Layout: "ampf" u32(4) <typecode:4> "meta" u32(len) <meta> "ptch" u32(len) <json>
// ptch is the final chunk and runs to EOF. We splice a new json payload in and
// recompute its length; everything before the ptch length field is preserved
// byte-for-byte (device type code, meta, etc.).

function readTemplate(file) {
  const data = fs.readFileSync(file);
  if (data.subarray(0, 4).toString('latin1') !== 'ampf') {
    throw new Error('not a .amxd (missing ampf magic): ' + file);
  }
  const tag = data.indexOf(Buffer.from('ptch', 'latin1'));
  if (tag < 0) throw new Error('no ptch chunk in template');
  const lenOff = tag + 4;
  const jsonOff = lenOff + 4;
  const jsonLen = data.readUInt32LE(lenOff);
  let jsonStr = data.subarray(jsonOff, jsonOff + jsonLen).toString('utf8');
  // template ptch payload carries a trailing newline past the json; trim to the
  // last closing brace so JSON.parse is happy.
  jsonStr = jsonStr.slice(0, jsonStr.lastIndexOf('}') + 1);
  return {
    headerThroughPtchTag: data.subarray(0, lenOff), // up to & incl "ptch"
    patcher: JSON.parse(jsonStr).patcher,
  };
}

function writeAmxd(file, headerThroughPtchTag, patcher) {
  const json = JSON.stringify({ patcher }, null, '\t') + '\n';
  const jsonBuf = Buffer.from(json, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(jsonBuf.length, 0);
  fs.writeFileSync(file, Buffer.concat([headerThroughPtchTag, lenBuf, jsonBuf]));
  return jsonBuf.length;
}

// ---------------------------------------------------------------------------
// Patcher builder
// ---------------------------------------------------------------------------
class Builder {
  constructor(startNum = 100) {
    this.boxes = [];
    this.lines = [];
    this.n = startNum;
  }
  // Generic box. `extra` merges in raw box attributes (e.g. live.* params).
  box(maxclass, text, x, y, ins, outs, extra = {}) {
    const id = 'obj-' + this.n++;
    const w = Math.max(40, (text ? String(text).length * 7.5 : 40) + 16);
    const box = {
      id,
      maxclass,
      numinlets: ins,
      numoutlets: outs,
      patching_rect: [round(x), round(y), round(w), 22],
      ...extra,
    };
    if (text != null) box.text = text;
    if (outs > 0) box.outlettype = new Array(outs).fill('');
    this.boxes.push({ box });
    return id;
  }
  obj(text, x, y, ins, outs, extra) {
    return this.box('newobj', text, x, y, ins, outs, extra);
  }
  msg(text, x, y, extra) {
    return this.box('message', text, x, y, 2, 1, extra);
  }
  comment(text, x, y, w = 200) {
    const id = this.box('comment', text, x, y, 1, 0);
    this.boxes[this.boxes.length - 1].box.patching_rect[2] = w;
    this.boxes[this.boxes.length - 1].box.linecount = Math.max(1, Math.ceil(text.length / (w / 7)));
    return id;
  }
  connect(src, outlet, dst, inlet) {
    this.lines.push({
      patchline: { source: [src, outlet], destination: [dst, inlet], disabled: 0, hidden: 0 },
    });
  }
  appendInto(patcher) {
    patcher.boxes.push(...this.boxes);
    patcher.lines = (patcher.lines || []).concat(this.lines);
  }
}

const round = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Shared shell sections
// ---------------------------------------------------------------------------

// init: live.thisdevice -> deferlow -> [init( -> js  (deferred so LiveAPI is up)
function addInit(B, js, x, y) {
  const dev = B.obj('live.thisdevice', x, y, 0, 3);
  const defer = B.obj('deferlow', x, y + 36, 1, 1);
  const init = B.msg('init', x, y + 72);
  B.connect(dev, 0, defer, 0);
  B.connect(defer, 0, init, 0);
  B.connect(init, 0, js, 0);
}

// clock: plugsync~ [raw ticks] -> [/ 480.] -> [speedlim 33] -> [prepend sync] -> js
function addClock(B, js, x, y) {
  B.comment('CLOCK — beats since song start (raw ticks / 480, ~30Hz).', x, y - 22, 360);
  const ps = B.obj('plugsync~', x, y, 1, 9);
  const div = B.obj('/ ' + TICKS_PER_BEAT + '.', x, y + 40, 2, 1);
  const lim = B.obj('speedlim 33', x, y + 76, 2, 1);
  const pre = B.obj('prepend sync', x, y + 112, 1, 1);
  B.connect(ps, PLUGSYNC_RAWTICKS_OUTLET, div, 0);
  B.connect(div, 0, lim, 0);
  B.connect(lim, 0, pre, 0);
  B.connect(pre, 0, js, 0);
}

// grab pool: js outlet0 -> route 0..N-1 -> per slot (route id val, prepend id,
// live.remote~). freebang -> [id 0( -> every remote (kill-order layer 3).
function addGrabPool(B, js, slots, x, y) {
  B.comment('GRAB POOL — ' + slots + ' live.remote~ slots. js outlet 0 drives them.', x, y - 22, 420);
  const routeArgs = Array.from({ length: slots }, (_, i) => i).join(' ');
  const pool = B.obj('route ' + routeArgs, x, y, 1, slots + 1);
  B.connect(js, 0, pool, 0);

  // freebang -> [id 0( releases all grabs even if js never ran
  const freeb = B.obj('freebang', x - 180, y + 40, 1, 1);
  const idZero = B.msg('id 0', x - 180, y + 76);
  B.connect(freeb, 0, idZero, 0);

  const colW = 150;
  const remotes = [];
  for (let i = 0; i < slots; i++) {
    const cx = x + i * colW;
    const cy = y + 120;
    const riv = B.obj('route id val', cx, cy, 1, 3);
    const pid = B.obj('prepend id', cx, cy + 40, 1, 1);
    // live.remote~ has 2 inlets: 0 = value, 1 = id (bind/unbind) — per the
    // Max 9 refpage and Ableton's own M4L.SignalToLiveParam wiring.
    const rem = B.obj('live.remote~', cx, cy + 80, 2, 0, { varname: 'remote_' + i });
    B.connect(pool, i, riv, 0); // slot i -> its route id val
    B.connect(riv, 0, pid, 0); // id  -> prepend id
    B.connect(pid, 0, rem, 1); // -> live.remote~ RIGHT inlet (binds by LOM id)
    B.connect(riv, 1, rem, 0); // val -> live.remote~ LEFT inlet (drives float)
    B.connect(idZero, 0, rem, 1); // freebang release -> id inlet
    remotes.push(rem);
  }
  return remotes;
}

// UI face-out: js outlet2 -> [route ui] -> [route <keys>] -> display objects.
function addUiOut(B, js, x, y) {
  B.comment('STATUS OUT — js outlet 2 drives the device face (red-text styling is taste; set in inspector).', x, y - 22, 520);
  const routeUi = B.obj('route ui', x, y, 1, 2);
  const keys = ['unresolved', 'missing', 'mode', 'alive', 'dryrun', 'errors', 'disabled'];
  const routeKeys = B.obj('route ' + keys.join(' '), x, y + 36, 1, keys.length + 1);
  B.connect(js, 2, routeUi, 0);
  B.connect(routeUi, 0, routeKeys, 0);

  const disp = {};
  keys.forEach((k, i) => {
    const cx = x + i * 120;
    const cy = y + 90;
    if (k === 'unresolved' || k === 'errors' || k === 'alive' || k === 'dryrun') {
      const nb = B.box('live.numbox', null, cx, cy, 1, 2, { varname: 'ui_' + k });
      B.connect(routeKeys, i, nb, 0);
      disp[k] = nb;
    } else {
      // missing / mode / disabled -> text display via [prepend set] -> live.comment
      const pre = B.obj('prepend set', cx, cy, 1, 1);
      const cm = B.box('live.comment', k.toUpperCase(), cx, cy + 36, 1, 0, { varname: 'ui_' + k });
      B.connect(routeKeys, i, pre, 0);
      B.connect(pre, 0, cm, 0);
      disp[k] = cm;
    }
  });
  return disp;
}

// Device face controls -> messages -> js inlet 0.
// spec: [{kind:'toggle'|'button'|'tab', label, message, tabs?}]
function addFaceControls(B, js, controls, x, y) {
  B.comment('FACE CONTROLS — performer hands -> js inlet.', x, y - 22, 360);
  controls.forEach((c, i) => {
    const cx = x + i * 150;
    const cy = y;
    if (c.kind === 'tab') {
      // live.tab -> sel 0 1 -> [mode A( / [mode B(
      const tab = B.box('live.tab', null, cx, cy, 1, 3, {
        varname: c.varname || 'ctl_' + i,
        saved_attribute_attributes: { valueof: { parameter_enum: c.tabs } },
        parameter_enable: 1,
      });
      const sel = B.obj('sel 0 1', cx, cy + 40, 2, 3);
      const mA = B.msg(c.message + ' ' + c.tabs[0], cx, cy + 76);
      const mB = B.msg(c.message + ' ' + c.tabs[1], cx + 110, cy + 76);
      B.connect(tab, 0, sel, 0);
      B.connect(sel, 0, mA, 0);
      B.connect(sel, 1, mB, 0);
      B.connect(mA, 0, js, 0);
      B.connect(mB, 0, js, 0);
    } else if (c.kind === 'button') {
      // live.text mode 0 = Button (refpage: "0: Button mode 1: Toggle").
      // Button mode emits a BANG from outlet 0 on click (see Ableton's own
      // M4L.PitchScale: live.text(button) -> [b]), so wire straight into the
      // message box — a [sel 1] here would never fire.
      const bt = B.box('live.text', null, cx, cy, 1, 2, {
        varname: c.varname || 'ctl_' + i,
        text: c.label,
        mode: 0, // Button
        parameter_enable: 1,
      });
      const m = B.msg(c.message, cx, cy + 40);
      B.connect(bt, 0, m, 0);
      B.connect(m, 0, js, 0);
    } else {
      // toggle: live.text mode 1 = Toggle -> [message $1(
      const tg = B.box('live.text', null, cx, cy, 1, 2, {
        varname: c.varname || 'ctl_' + i,
        text: c.label,
        mode: 1, // Toggle
        parameter_enable: 1,
      });
      const m = B.msg(c.message + ' $1', cx, cy + 40);
      B.connect(tg, 0, m, 0);
      B.connect(m, 0, js, 0);
    }
  });
}

// pattr (parameter mode) <-> js  for state persistence (getvalueof/setvalueof)
function addPattr(B, js, name, x, y) {
  const p = B.obj('pattr ' + name + ' @invisible 1', x, y, 1, 3, { parameter_enable: 1 });
  // pattr outlet 1 is the "bindto connection" (refpage) — connect MIDDLE outlet
  // to the js left inlet to bind. Outlet 0 just emits values, no binding.
  B.connect(p, 1, js, 0);
  B.comment('pattr ' + name + ' — persists mode/state with the set (middle-outlet bind).', x, y + 30, 320);
}

// ---------------------------------------------------------------------------
// Device definitions
// ---------------------------------------------------------------------------
function buildConductor(patcher) {
  const B = new Builder(100);
  B.comment('CONDUCTOR shell — all logic in conductor.js (autowatch). Lives on the Master FX track.', 40, 360, 640);
  const js = B.obj('js conductor.js', 360, 470, 1, 3);

  addInit(B, js, 40, 410);
  addClock(B, js, 180, 410);
  addGrabPool(B, js, 24, 60, 560);
  addUiOut(B, js, 60, 900);
  addFaceControls(
    B,
    js,
    [
      { kind: 'toggle', label: 'ALIVE', message: 'alive', varname: 'ctl_alive' },
      { kind: 'toggle', label: 'DRY-RUN', message: 'dryrun', varname: 'ctl_dryrun' },
      { kind: 'tab', message: 'mode', tabs: ['REHEARSE', 'SHOW'], varname: 'ctl_mode' },
      { kind: 'button', label: 'ABORT', message: 'abort', varname: 'ctl_abort' },
    ],
    60,
    1050
  );
  addPattr(B, js, 'conductor_state', 700, 470);

  // telemetry: js outlet 1 -> send
  const send = B.obj('s rigbrain-telemetry', 360, 700, 1, 0);
  B.connect(js, 1, send, 0);

  B.appendInto(patcher);
  return B;
}

function buildSentinel(patcher) {
  const B = new Builder(100);
  B.comment('SENTINEL shell — all logic in sentinel.js (autowatch). Lives on the Master track. Hosts the dashboard node process.', 40, 360, 720);
  const js = B.obj('js sentinel.js', 360, 470, 1, 3);

  addInit(B, js, 40, 410);
  addClock(B, js, 180, 410);
  addGrabPool(B, js, 7, 60, 560);
  addUiOut(B, js, 60, 900);
  addFaceControls(
    B,
    js,
    [
      { kind: 'button', label: 'RITUAL', message: 'ritual', varname: 'ctl_ritual' },
      { kind: 'toggle', label: 'NIGHT ARC', message: 'nightarc', varname: 'ctl_nightarc' },
      { kind: 'tab', message: 'mode', tabs: ['REHEARSE', 'SHOW'], varname: 'ctl_mode' },
      { kind: 'toggle', label: 'DRY-RUN', message: 'dryrun', varname: 'ctl_dryrun' },
    ],
    60,
    1050
  );
  addPattr(B, js, 'sentinel_state', 700, 470);

  // telemetry: js outlet 1 AND [r rigbrain-telemetry] (conductor's events) -> node.script
  B.comment('DASHBOARD — node.script hosts dashboard/server.js (http://localhost:7777). Isolated: nothing depends on it.', 360, 670, 560);
  const node = B.obj('node.script server.js @autostart 1 @watch 1', 360, 700, 1, 2);
  const recv = B.obj('r rigbrain-telemetry', 600, 700, 0, 1);
  B.connect(js, 1, node, 0);
  B.connect(recv, 0, node, 0);

  B.appendInto(patcher);
  return B;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function buildDevice(name, buildFn) {
  if (!fs.existsSync(TEMPLATE)) {
    throw new Error(
      'Max Audio Effect template not found:\n  ' + TEMPLATE +
        '\nSet MAX_TEMPLATE=/path/to/"Max Audio Effect.amxd" (inside Live 12: ' +
        'Contents/App-Resources/Misc/Max Devices/).'
    );
  }
  const { headerThroughPtchTag, patcher } = readTemplate(TEMPLATE);
  const before = patcher.boxes.length;
  const B = buildFn(patcher);
  patcher.rect = [120, 120, 900, 1300]; // roomy editor window

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, name + '.amxd');
  const bytes = writeAmxd(out, headerThroughPtchTag, patcher);

  // verify round-trip
  const check = readTemplate(out);
  const ok = check.patcher.boxes.length === patcher.boxes.length;
  console.log(
    `${name}.amxd  ${ok ? 'OK' : 'FAIL'}  ` +
      `(${before} template + ${B.boxes.length} generated = ${patcher.boxes.length} boxes, ` +
      `${B.lines.length} new cords, ${bytes} json bytes)`
  );
  if (!ok) throw new Error(name + ': round-trip box count mismatch');
}

console.log('template:', TEMPLATE);
buildDevice('CONDUCTOR', buildConductor);
buildDevice('SENTINEL', buildSentinel);
console.log('\nWrote build/CONDUCTOR.amxd and build/SENTINEL.amxd');
console.log('Next: add the search-path folders (SHELL-BUILD §0), then drop each device on its track.');
