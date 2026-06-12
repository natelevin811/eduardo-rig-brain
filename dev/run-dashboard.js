// dev/run-dashboard.js — boot dashboard/server.js OUTSIDE Max for smoke testing.
//
//   node dev/run-dashboard.js          # just boots the server (empty state)
//   node dev/run-dashboard.js --demo   # also feeds synthetic telemetry
//
// dashboard/server.js does require('max-api'), which only exists inside Max's
// node.script runtime. Here we redirect that one module id to dev/mock-max-api.js
// so the server boots under plain Node. This is a test harness only — in
// production the dashboard runs inside Max and receives real telemetry from the
// SENTINEL/CONDUCTOR brains. Nothing here can send control into Max; it only
// feeds the dashboard's read-only ingest path.

const Module = require('module');
const path = require('path');

// Redirect require('max-api') -> the local mock, before server.js is loaded.
const mockPath = path.join(__dirname, 'mock-max-api.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'max-api') return mockPath;
  return origResolve.call(this, request, parent, isMain, options);
};

// Boot the real server (it calls server.listen on require).
require(path.join(__dirname, '..', 'dashboard', 'server.js'));

if (!process.argv.includes('--demo')) {
  console.log('[dev] dashboard up at http://localhost:7777 (no demo feed; pass --demo for synthetic data)');
  return;
}

const maxApi = require('max-api'); // resolves to the mock via the override above
const BUSES = ['LoDrumsBus', 'HiDrumsBus', 'PercBus', 'BassBus', 'PadsBus', 'LeadsBus'];
const send = (ev) => maxApi.injectDevMessage(JSON.stringify(ev));

console.log('[dev] --demo: feeding synthetic telemetry');
send({ t: 'mode', mode: 'REHEARSE' });

let beat = 0;
const tempo = 72;

// heartbeat / clock ~ once per beat at 72 BPM
setInterval(() => {
  beat += 1;
  send({ t: 'hb', src: 'conductor', beat, bar: Math.floor(beat / 4) + 1, tempo });
}, 60000 / tempo);

// meters ~10 Hz, gently wandering below the ceiling
let phase = 0;
setInterval(() => {
  phase += 0.12;
  const main = 0.55 + 0.2 * (0.5 + 0.5 * Math.sin(phase));
  const buses = {};
  for (let i = 0; i < BUSES.length; i++) {
    buses[BUSES[i]] = { m: 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(phase + i)) };
  }
  send({ t: 'meters', src: 'sentinel', main, ceiling: 0.92, buses });
}, 100);
