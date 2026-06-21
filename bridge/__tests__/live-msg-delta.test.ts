// Regression test for the live-message delta write — the fix for the
// parallel-big-session freeze. Before this, every mid-stream checkpoint
// (~every 2 s per active stream) ran writeSessionFull, which DELETEs and
// re-INSERTs *every* message row. Under several big sessions streaming at
// once that O(messages) rewrite held the shared SQLite write lock long
// enough to starve the bridge event loop and time out go-core's persist
// callbacks. updateLiveMessageRow turns that path into a single-row UPDATE
// matched by (session_id, live_token) — the same handle go-core's
// SQLiteFinalizer uses.
//
// Stand-alone (no test runner). Run with:  bun bridge/__tests__/live-msg-delta.test.ts
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const db = require('../sessions-internal/db');

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? '\n    ' + detail : ''}`);
    console.log(`  ✗ ${label}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yha-live-delta-'));
const dbPath = path.join(tmpDir, 'sessions.db');

function cleanup() {
  try { db.closeDB(); } catch (_) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
  }
  try { fs.rmdirSync(tmpDir); } catch (_) {}
}

try {
  db.openDB(dbPath);

  const sid = 's-delta-test';
  const liveToken = 4242;
  const now = Date.now();

  // A "big-ish" session: a user prompt, a finished assistant turn, then the
  // active streaming placeholder we will checkpoint.
  const session = {
    id: sid,
    name: 'delta',
    createdAt: now,
    lastUsed: now,
    viewedAt: now,
    workingDir: '/tmp',
    messages: [
      { role: 'user', ts: now, text: 'first question' },
      { role: 'assistant', ts: now + 1, blocks: [{ type: 'text', text: 'a prior, finished answer' }], meta: { model: 'm1' } },
      { role: 'user', ts: now + 2, text: 'second question' },
      { role: 'assistant', ts: now + 3, text: '', streaming: true, _liveToken: liveToken, _liveDeadline: now + 1_000_000 },
    ],
  };
  db.writeSessionFull(session);

  const beforeLoad = db.loadSession(sid);
  assert('session persisted with 4 messages', beforeLoad?.messages?.length === 4,
    `got ${beforeLoad?.messages?.length}`);
  assert('placeholder starts streaming', beforeLoad.messages[3].streaming === true);

  // ── The hot path: a mid-stream checkpoint updates ONLY the streaming row. ──
  const updated = db.updateLiveMessageRow(sid, {
    role: 'assistant',
    ts: now + 3,
    streaming: true,
    _liveToken: liveToken,
    _liveDeadline: now + 1_000_000,
    blocks: [{ type: 'text', text: 'partial streamed tokens so far' }],
  });
  assert('updateLiveMessageRow returns true when the row matches', updated === true);

  const afterLoad = db.loadSession(sid);
  assert('no row added or dropped (still 4 messages)', afterLoad.messages.length === 4,
    `got ${afterLoad.messages.length}`);

  // The streaming row got the new content...
  const live = afterLoad.messages[3];
  assert('streaming row content updated', JSON.stringify(live.blocks) === JSON.stringify([{ type: 'text', text: 'partial streamed tokens so far' }]),
    JSON.stringify(live.blocks));
  assert('streaming row still flagged streaming', live.streaming === true);
  assert('streaming row keeps its live token', live._liveToken === liveToken);

  // ...while every sibling row is byte-for-byte untouched (proves it was NOT a
  // full delete+reinsert that could reorder / drop / duplicate).
  assert('row 0 (user) untouched', afterLoad.messages[0].role === 'user' && afterLoad.messages[0].text === 'first question');
  assert('row 1 (prior assistant) untouched',
    JSON.stringify(afterLoad.messages[1].blocks) === JSON.stringify([{ type: 'text', text: 'a prior, finished answer' }]));
  assert('row 2 (user) untouched', afterLoad.messages[2].text === 'second question');

  // ── Fallback signalling: no row matches → false (caller does a full write). ──
  assert('returns false for an unknown live token', db.updateLiveMessageRow(sid, { _liveToken: 999999, blocks: [] }) === false);
  assert('returns false when the message has no live token', db.updateLiveMessageRow(sid, { role: 'assistant', text: 'x' }) === false);
} catch (e) {
  failed++;
  failures.push('threw: ' + (e instanceof Error ? e.stack || e.message : String(e)));
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
