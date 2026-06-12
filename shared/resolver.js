// resolver.js — shared LOM name resolution for CONDUCTOR + SENTINEL.
// ES5 only (Max js object). Loaded via include("resolver.js") — shared/ must be
// in Max's search path (see docs/SHELL-BUILD.md).
//
// Religion:
//   1. Everything resolves BY NAME at device load. LOM index hints drift; names don't.
//   2. Unresolved names are collected and surfaced as red text. Never fail silently.
//   3. LINK SAFETY CONTRACT enforced here, at the bottom of the stack:
//      Resolver.set / Resolver.call refuse tempo writes, transport writes and
//      scene launches no matter who asks. There is no bypass.

var Resolver = (function () {

  var missing = [];        // [{ kind, name, detail }]
  var onMissing = null;    // optional callback(entry)

  // ---- LINK SAFETY CONTRACT -------------------------------------------------
  // Forbidden property writes, anywhere in the LOM:
  var FORBIDDEN_PROPS = {
    'tempo': 1,                 // never write tempo — shared Link state
    'is_playing': 1,            // transport
    'current_song_time': 1,     // transport position
    'song_tempo': 1
  };
  // Forbidden calls: transport + scene launch. Clip fire is allowed ONLY on the
  // conductor's own track (checked by path), riser track clips included.
  var FORBIDDEN_CALLS = {
    'start_playing': 1,
    'stop_playing': 1,
    'continue_playing': 1,
    'stop_all_clips_global': 1  // (live_set-level stop is a transport-adjacent act)
  };

  function refuse(why, what) {
    var msg = 'LINK-CONTRACT REFUSED: ' + why + ' [' + what + ']';
    noteMissing('contract', what, why);
    error(msg + '\n');
    return null;
  }

  // ---- missing-name bookkeeping ----------------------------------------------
  function noteMissing(kind, name, detail) {
    var e = { kind: kind, name: name, detail: detail || '' };
    missing.push(e);
    if (onMissing) { try { onMissing(e); } catch (err) {} }
  }

  function getMissing() { return missing.slice(0); }
  function clearMissing() { missing = []; }
  function setOnMissing(fn) { onMissing = fn; }

  // ---- setmap loading ----------------------------------------------------------
  // Reads a JSON file from Max's search path.
  function loadSetmap(filename) {
    var f = new File(filename, 'read');
    if (!f.isopen) {
      noteMissing('file', filename, 'setmap file not found in search path');
      return null;
    }
    var s = '';
    f.position = 0;
    while (f.position < f.eof) s += f.readstring(1024);
    f.close();
    try {
      return JSON.parse(s);
    } catch (e) {
      noteMissing('file', filename, 'setmap JSON parse failed: ' + e.message);
      return null;
    }
  }

  // ---- core lookups --------------------------------------------------------------
  function apiName(api) {
    var n = api.get('name');
    if (n === null || n === undefined) return '';
    return String(n);
  }

  // Find a regular track by exact name. Returns LiveAPI or null (noted).
  function track(name) {
    var ls = new LiveAPI('live_set');
    var n = ls.getcount('tracks');
    for (var i = 0; i < n; i++) {
      var t = new LiveAPI('live_set tracks ' + i);
      if (apiName(t) === name) return t;
    }
    noteMissing('track', name, 'no track with this name');
    return null;
  }

  // Find all tracks whose name contains a substring (RITUAL pattern matches only).
  function tracksMatching(substr) {
    var out = [];
    var ls = new LiveAPI('live_set');
    var n = ls.getcount('tracks');
    for (var i = 0; i < n; i++) {
      var t = new LiveAPI('live_set tracks ' + i);
      if (apiName(t).indexOf(substr) !== -1) out.push(t);
    }
    return out;
  }

  function returnTrack(name) {
    var ls = new LiveAPI('live_set');
    var n = ls.getcount('return_tracks');
    for (var i = 0; i < n; i++) {
      var t = new LiveAPI('live_set return_tracks ' + i);
      if (apiName(t) === name) return t;
    }
    noteMissing('return', name, 'no return track with this name');
    return null;
  }

  // Return-track send index by exact name (validates setmap returns_send_index).
  function sendIndexByName(name) {
    var ls = new LiveAPI('live_set');
    var n = ls.getcount('return_tracks');
    for (var i = 0; i < n; i++) {
      var t = new LiveAPI('live_set return_tracks ' + i);
      if (apiName(t) === name) return i;
    }
    noteMissing('return', name, 'send index lookup failed');
    return -1;
  }

  function masterTrack() {
    return new LiveAPI('live_set master_track');
  }

  // Recursive device search: walks devices and rack chains (the LeadsBus DJ filter
  // lives INSIDE the bus rack chain, so top-level search is not enough).
  function findDeviceIn(basePath, deviceName, depth) {
    if (depth > 4) return null;
    var holder = new LiveAPI(basePath);
    var nd = holder.getcount('devices');
    for (var i = 0; i < nd; i++) {
      var dPath = basePath + ' devices ' + i;
      var d = new LiveAPI(dPath);
      if (apiName(d) === deviceName) return d;
      if (parseInt(d.get('can_have_chains'), 10) === 1) {
        var nc = d.getcount('chains');
        for (var c = 0; c < nc; c++) {
          var hit = findDeviceIn(dPath + ' chains ' + c, deviceName, depth + 1);
          if (hit) return hit;
        }
      }
    }
    return null;
  }

  // Device by name on a named track (recursive through racks). trackApi optional reuse.
  function device(trackName, deviceName, trackApi) {
    var t = trackApi || track(trackName);
    if (!t) return null;
    var d = findDeviceIn(t.unquotedpath || t.path.replace(/"/g, ''), deviceName, 0);
    if (!d) noteMissing('device', trackName + ' / ' + deviceName, 'device not found (searched rack chains too)');
    return d;
  }

  // Parameter on a device by name; accepts a single name or an array of candidates.
  function param(deviceApi, nameCandidates, label) {
    if (!deviceApi) return null;
    var cands = (typeof nameCandidates === 'string') ? [nameCandidates] : nameCandidates;
    var np = deviceApi.getcount('parameters');
    var dPath = deviceApi.unquotedpath || deviceApi.path.replace(/"/g, '');
    for (var i = 0; i < np; i++) {
      var p = new LiveAPI(dPath + ' parameters ' + i);
      var pn = apiName(p);
      for (var c = 0; c < cands.length; c++) {
        if (pn === cands[c]) return p;
      }
    }
    noteMissing('param', (label || dPath) + ' / ' + cands.join('|'), 'no parameter with these names');
    return null;
  }

  // Mixer accessors -------------------------------------------------------------
  function trackVolume(trackApi) {
    if (!trackApi) return null;
    var path = trackApi.unquotedpath || trackApi.path.replace(/"/g, '');
    return new LiveAPI(path + ' mixer_device volume');
  }

  function trackSend(trackApi, sendIndex) {
    if (!trackApi || sendIndex < 0) return null;
    var path = trackApi.unquotedpath || trackApi.path.replace(/"/g, '');
    return new LiveAPI(path + ' mixer_device sends ' + sendIndex);
  }

  function crossfader() {
    return new LiveAPI('live_set master_track mixer_device crossfader');
  }

  // Param metadata snapshot used by the ramp engine. paramApi must be a DeviceParameter.
  function paramInfo(paramApi) {
    if (!paramApi) return null;
    return {
      id: paramApi.id,
      name: apiName(paramApi),
      min: parseFloat(paramApi.get('min')),
      max: parseFloat(paramApi.get('max'))
    };
  }

  function byId(id) {
    return new LiveAPI('id ' + id);
  }

  // ---- guarded write layer ----------------------------------------------------------
  // ALL property writes and ALL calls in this codebase go through these two.
  function set(api, prop, value) {
    if (!api) return null;
    if (FORBIDDEN_PROPS[prop] === 1) {
      return refuse('property "' + prop + '" is read-only by contract', api.path);
    }
    api.set(prop, value);
    return true;
  }

  function call(api, method, arg) {
    if (!api) return null;
    if (FORBIDDEN_CALLS[method] === 1) {
      return refuse('call "' + method + '" is forbidden by contract', api.path);
    }
    var p = String(api.path);
    if (method === 'fire' && p.indexOf('scenes') !== -1) {
      return refuse('scene fire is forbidden by contract (11 scenes carry baked tempos)', p);
    }
    if (arg === undefined) api.call(method);
    else api.call(method, arg);
    return true;
  }

  // Tempo is readable (the system listens to the room) — explicit read-only accessor.
  function readTempo() {
    var ls = new LiveAPI('live_set');
    return parseFloat(ls.get('tempo'));
  }

  function readIsPlaying() {
    var ls = new LiveAPI('live_set');
    return parseInt(ls.get('is_playing'), 10);
  }

  function beatsPerBar() {
    var ls = new LiveAPI('live_set');
    var n = parseInt(ls.get('signature_numerator'), 10);
    return (n > 0) ? n : 4;
  }

  return {
    loadSetmap: loadSetmap,
    track: track,
    tracksMatching: tracksMatching,
    returnTrack: returnTrack,
    sendIndexByName: sendIndexByName,
    masterTrack: masterTrack,
    device: device,
    param: param,
    trackVolume: trackVolume,
    trackSend: trackSend,
    crossfader: crossfader,
    paramInfo: paramInfo,
    byId: byId,
    set: set,
    call: call,
    readTempo: readTempo,
    readIsPlaying: readIsPlaying,
    beatsPerBar: beatsPerBar,
    getMissing: getMissing,
    clearMissing: clearMissing,
    setOnMissing: setOnMissing,
    noteMissing: noteMissing
  };
})();
