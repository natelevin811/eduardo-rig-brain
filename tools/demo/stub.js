// demo/stub.js — injected BEFORE the dashboard's main script in the hosted demo.
// Replaces the live SSE EventSource with a fake one so the dashboard never tries
// to reach a rig that isn't there. The driver (injected after) feeds it synthetic
// telemetry. This file ships ONLY in the Vercel static demo, never on the rig.
(function () {
  function FakeES(url) {
    this.url = url; this.onmessage = null; this.onopen = null; this.onerror = null;
    window.__demoES = this;
    var self = this;
    setTimeout(function () { if (self.onopen) self.onopen({ type: 'open' }); }, 60);
  }
  FakeES.prototype.close = function () {};
  FakeES.prototype.addEventListener = function (t, fn) {
    if (t === 'message') this.onmessage = fn;
    else if (t === 'open') this.onopen = fn;
    else if (t === 'error') this.onerror = fn;
  };
  window.EventSource = FakeES;
  window.__demo = true;
})();
