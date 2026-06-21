// ── Barrel re-export: Claude binary run + stream execution helpers ────────────
'use strict';

const { runClaude } = require('./claude-run');
const { streamClaude } = require('./claude-stream');

module.exports = {
  runClaude,
  streamClaude,
};
