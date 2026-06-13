// midi.mjs — minimal Standard MIDI File read + write. No dependencies.
// Enough for the Weaver simulator: note on/off, tempo, multi-track (format 1).

import fs from 'node:fs';

// ---- read ----------------------------------------------------------------
// Returns { ppq, tempoUS, notes: [{pitch, velocity, channel, start, dur, track}] }
// start/dur in ticks. tempoUS = microseconds per quarter (default 500000 = 120 BPM).
export function readMidi(buf) {
  let pos = 0;
  function u32() { const v = buf.readUInt32BE(pos); pos += 4; return v; }
  function u16() { const v = buf.readUInt16BE(pos); pos += 2; return v; }
  function str(n) { const s = buf.toString('ascii', pos, pos + n); pos += n; return s; }

  if (str(4) !== 'MThd') throw new Error('not a MIDI file (no MThd)');
  u32();                       // header length (6)
  u16();                       // format
  const ntrk = u16();
  const ppq = u16();
  let tempoUS = 500000;
  const notes = [];

  for (let t = 0; t < ntrk; t++) {
    if (str(4) !== 'MTrk') throw new Error('expected MTrk');
    const len = u32();
    const end = pos + len;
    let tick = 0, running = 0;
    const on = {};             // key pitch<<4|chan -> {start, vel}
    while (pos < end) {
      // varlen delta
      let delta = 0, b;
      do { b = buf[pos++]; delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);
      tick += delta;
      let status = buf[pos];
      if (status & 0x80) pos++; else status = running;  // running status
      running = status;
      const hi = status & 0xf0, chan = status & 0x0f;
      if (status === 0xff) {                 // meta
        const type = buf[pos++];
        let mlen = 0, mb;
        do { mb = buf[pos++]; mlen = (mlen << 7) | (mb & 0x7f); } while (mb & 0x80);
        if (type === 0x51 && mlen === 3)
          tempoUS = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
        pos += mlen;
      } else if (status === 0xf0 || status === 0xf7) {  // sysex
        let slen = 0, sb;
        do { sb = buf[pos++]; slen = (slen << 7) | (sb & 0x7f); } while (sb & 0x80);
        pos += slen;
      } else if (hi === 0x90 || hi === 0x80) {
        const pitch = buf[pos++], vel = buf[pos++];
        const key = (pitch << 4) | chan;
        if (hi === 0x90 && vel > 0) {
          on[key] = { start: tick, vel };
        } else {
          const o = on[key];
          if (o) { notes.push({ pitch, velocity: o.vel, channel: chan,
            start: o.start, dur: Math.max(1, tick - o.start), track: t }); delete on[key]; }
        }
      } else if (hi === 0xc0 || hi === 0xd0) { pos += 1; }
      else { pos += 2; }       // 2-byte channel messages
    }
    pos = end;
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { ppq, tempoUS, notes };
}

export function readMidiFile(path) { return readMidi(fs.readFileSync(path)); }

// ---- write ---------------------------------------------------------------
// tracks: array of { name?, notes: [{pitch,velocity,channel,start,dur}] }
// Writes format-1 SMF. First track carries the tempo meta.
export function writeMidi(path, { ppq = 480, tempoUS = 500000, tracks }) {
  const chunks = [header(ppq, tracks.length)];
  tracks.forEach((trk, i) => chunks.push(trackChunk(trk, i === 0 ? tempoUS : null)));
  fs.writeFileSync(path, Buffer.concat(chunks));
}

function header(ppq, ntrk) {
  const b = Buffer.alloc(14);
  b.write('MThd', 0, 'ascii');
  b.writeUInt32BE(6, 4);
  b.writeUInt16BE(1, 8);          // format 1
  b.writeUInt16BE(ntrk, 10);
  b.writeUInt16BE(ppq, 12);
  return b;
}

function varlen(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return bytes;
}

function trackChunk(trk, tempoUS) {
  const ev = [];   // {tick, data:[...]}
  if (trk.name) {
    ev.push({ tick: 0, order: 0,
      data: [0xff, 0x03, trk.name.length, ...Buffer.from(trk.name, 'ascii')] });
  }
  if (tempoUS != null) {
    ev.push({ tick: 0, order: 0,
      data: [0xff, 0x51, 0x03, (tempoUS >> 16) & 0xff, (tempoUS >> 8) & 0xff, tempoUS & 0xff] });
  }
  for (const n of trk.notes) {
    const ch = (n.channel || 0) & 0x0f;
    ev.push({ tick: n.start, order: 1, data: [0x90 | ch, n.pitch, n.velocity] });
    ev.push({ tick: n.start + n.dur, order: 0, data: [0x80 | ch, n.pitch, 0] });
  }
  ev.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body = [];
  let last = 0;
  for (const e of ev) {
    body.push(...varlen(e.tick - last), ...e.data);
    last = e.tick;
  }
  body.push(...varlen(0), 0xff, 0x2f, 0x00);   // end of track
  const head = Buffer.alloc(8);
  head.write('MTrk', 0, 'ascii');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, Buffer.from(body)]);
}

export const bpmToUS = bpm => Math.round(60000000 / bpm);
export const usToBpm = us => Math.round(60000000 / us);
