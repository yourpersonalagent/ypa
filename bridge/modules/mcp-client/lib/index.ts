// ── Barrel re-export: MCP state, protocol, discovery, routes ──────────────────
'use strict';

module.exports = {
  ...require('./state'),
  ...require('./protocol'),
  ...require('./discovery'),
  ...require('./routes'),
  ...require('./pid-registry'),
};
