'use strict';

const crypto = require('crypto');

// Constant-time string comparison for secrets/tokens. Both inputs are hashed
// to a fixed-length SHA-256 digest before comparison so that:
//   1. crypto.timingSafeEqual never throws on length mismatch (it requires
//      equal-length buffers), and
//   2. the comparison time is independent of the position of the first
//      differing byte — defeating timing oracles that a plain === / !==
//      string compare would expose on secret checks.
// Note: empty-vs-empty returns true, so callers must still reject empty input
// up front (a missing secret should never be treated as a valid one).
function timingSafeEqualStr(a: unknown, b: unknown): boolean {
  const ba = Buffer.from(typeof a === 'string' ? a : String(a ?? ''), 'utf8');
  const bb = Buffer.from(typeof b === 'string' ? b : String(b ?? ''), 'utf8');
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { timingSafeEqualStr };
