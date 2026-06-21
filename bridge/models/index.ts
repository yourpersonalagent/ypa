// ── Barrel re-export: model detection, fetching, config lookup, list builder ──
'use strict';

module.exports = {
  ...require('./detect'),
  ...require('./config'),
  ...require('./claude-subscription'),
  ...require('./fetch'),
  ...require('./list'),
};
