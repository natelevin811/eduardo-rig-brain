// server.js — dashboard telemetry process. Runs in node.script inside the
// SENTINEL shell. Modern Node is fine here (node.script, not the js object).
//
// ISOLATION CONTRACT: this process renders state and writes the session log.
// It cannot send control — there is no code path from HTTP back into Max.
// If this process dies, the devices play on unaffected; the browser
// auto-reconnects when it returns.
//
// Transport choice: SSE (Server-Sent Events) rather than a websocket library.
// Same one-way wire the spec demands, but structurally incapable of carrying
// upstream messages, auto-reconnecting via native EventSource, and zero npm
// dependencies — nothing to install, nothing to break at 3 a.m.
//
// Serves http://localhost:7777 — laptop screen or iPad Mini browser tab.

const maxApi = require('max-api');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 7777;
const LOG_DIR = path.join(__dirname, '..', 'logs');

// ---------------------------------------------------------------------------
// session log — every command, ramp, trim and error. Replay the night post-gig.
// ---------------------------------------------------------------------------
const stamp = new Date();
const dateTag = stamp.toISOString().slice(0, 10);
const logPath = path.join(LOG_DIR, `${dateTag}-show.jsonl`);
let logStream = null;
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(JSON.stringify({ t: 'session_start', ts: stamp.toISOString() }) + '\n');
} catch (e) {
  // log failure must never matter to anything else
}

// Ramp events are high-rate; thin them in the log file (full rate still hits the browser).
const LOG_SKIP = { ramp: 4, meters: 8, clock: 8, hb: 4, djstate: 4 };
const logCounters = {};

function logEvent(ev) {
  if (!logStream) return;
  const skip = LOG_SKIP[ev.t];
  if (skip) {
    logCounters[ev.t] = (logCounters[ev.t] || 0) + 1;
    if (logCounters[ev.t] % skip !== 0) return;
  }
  try {
    logStream.write(JSON.stringify({ ts: Date.now(), ...ev }) + '\n');
  } catch (e) { /* never matters */ }
}

// ---------------------------------------------------------------------------
// state cache + SSE fan-out
// ---------------------------------------------------------------------------
const clients = new Set();
const lastByType = {};   // replayed to fresh clients so the page paints instantly
const alertRing = [];    // recent alerts survive a page reload

function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch (e) { clients.delete(res); }
  }
}

function ingest(raw) {
  let ev;
  try { ev = JSON.parse(raw); } catch (e) { return; }
  if (!ev || !ev.t) return;
  const key = ev.t + ':' + (ev.src || '');
  lastByType[key] = ev;
  if (ev.t === 'alert' || ev.t === 'sentry_skip' || ev.t === 'subsystem_down') {
    alertRing.push({ ...ev, ts: Date.now() });
    if (alertRing.length > 50) alertRing.shift();
  }
  logEvent(ev);
  broadcast(ev);
}

// Telemetry arrives from the js objects as a single JSON-string message.
// If Max ever splits it on whitespace, rejoin — JSON.stringify output has
// spaces only inside string values, so a plain space-join reconstructs it.
maxApi.addHandler(maxApi.MESSAGE_TYPES.ALL, (handled, ...args) => {
  const raw = args.map(String).join(' ');
  if (raw.startsWith('{')) ingest(raw);
});

// ---------------------------------------------------------------------------
// http — static page + /events SSE
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 1500\n\n');
    // replay cached state so the dashboard paints without waiting a full cycle
    for (const key of Object.keys(lastByType)) {
      res.write(`data: ${JSON.stringify(lastByType[key])}\n\n`);
    }
    for (const a of alertRing) res.write(`data: ${JSON.stringify(a)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); res.end('dashboard page missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }
  // one-click telemetry export: /log downloads today's session .jsonl, /log?raw=1
  // streams it inline (for copy/paste). Read-only; never blocks the write stream.
  if (req.url === '/log' || req.url.startsWith('/log?')) {
    const inline = /[?&]raw=1/.test(req.url);
    fs.access(logPath, fs.constants.R_OK, (err) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no log yet for ' + dateTag); return; }
      // no Content-Length: the file is being appended live, so stream it chunked
      // to capture a consistent snapshot without truncation.
      res.writeHead(200, {
        'Content-Type': inline ? 'text/plain; charset=utf-8' : 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'Content-Disposition': (inline ? 'inline' : 'attachment') + `; filename="${dateTag}-show.jsonl"`
      });
      fs.createReadStream(logPath).on('error', () => res.end()).pipe(res);
    });
    return;
  }
  // instant fallback to the known-good classic UI — reachable mid-show with no
  // terminal: just type /classic. Never depends on the new UI being healthy.
  if (req.url === '/classic' || req.url === '/index-classic.html') {
    fs.readFile(path.join(__dirname, 'index-classic.html'), (err, buf) => {
      if (err) { res.writeHead(500); res.end('classic page missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on('error', (e) => {
  maxApi.post(`[dashboard] http error: ${e.message}`, maxApi.POST_LEVELS.WARN);
});

server.listen(PORT, () => {
  maxApi.post(`[dashboard] live at http://localhost:${PORT} — log: ${logPath}`);
});

// keepalive comment frame every 15 s so proxies/sleepy iPads keep the stream open
setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); }
  }
}, 15000);
