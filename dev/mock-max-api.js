// dev/mock-max-api.js — LOCAL DEV MOCK of Cycling '74's `max-api`. NOT the real
// thing. Lets dashboard/server.js boot under plain Node so the HTTP/SSE
// dashboard can be smoke-tested without Max. run-dashboard.js redirects
// require('max-api') here. Inside Max, node.script provides the real max-api
// and this file is never loaded.
//
// Surface = exactly what server.js touches:
//   post(msg, level?)   addHandler(type, fn)   POST_LEVELS   MESSAGE_TYPES
//
// `injectDevMessage(...args)` is a mock-only extra the demo runner uses to feed
// synthetic telemetry into the registered ALL handler.

const handlers = { ALL: [] };

module.exports = {
  POST_LEVELS: { INFO: 0, WARN: 1, ERROR: 2 },
  MESSAGE_TYPES: { ALL: 'ALL', BANG: 'bang', INT: 'int', FLOAT: 'float', LIST: 'list', DICT: 'dict' },

  post(...args) {
    console.log('[max-api:post]', ...args);
  },

  addHandler(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
  },

  // --- mock-only helper, not part of the real API ---
  injectDevMessage(...args) {
    for (const fn of handlers.ALL) fn(true, ...args);
  },
};
