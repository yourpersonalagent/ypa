// ── Provider module barrel ────────────────────────────────────────────────────
'use strict';

module.exports = {
  ...require('./core'),
  ...require('./special'),
  ...require('./claude'),
  ...require('./codex'),
};
