// @ts-check
'use strict';

// Self-rescue for MCP child processes when their parent bun/node host
// disappears. The bridge's existing graceful-shutdown path sends SIGTERM
// to each MCP process group, but `bun --watch` can re-exec the parent
// without giving that path time to run — the child wakes up holding a
// half-closed stdio pipe whose peer is gone and busy-loops on readable
// events forever, pegging a CPU.
//
// Three orphan signals are watched:
//   - stdin 'close' / 'error'  — pipe destroyed by peer or kernel
//   - process.ppid === 1       — we got reparented to init (peer exited)
//
// On any of them: run the supplied teardown (best-effort, bounded by a 5 s
// timeout) and process.exit(0).

function installParentWatchdog(teardown) {
  let firing = false;

  function fire(reason) {
    if (firing) return;
    firing = true;
    try {
      process.stderr.write('[parent-watchdog] exit triggered: ' + reason + '\n');
    } catch (_) {}
    const hardExit = setTimeout(() => process.exit(0), 5000);
    if (typeof hardExit.unref === 'function') hardExit.unref();
    try {
      Promise.resolve(typeof teardown === 'function' ? teardown(reason) : undefined)
        .catch(() => {})
        .finally(() => { clearTimeout(hardExit); process.exit(0); });
    } catch (_) {
      clearTimeout(hardExit);
      process.exit(0);
    }
  }

  try { process.stdin.on('close', () => fire('stdin-close')); } catch (_) {}
  try { process.stdin.on('error', () => fire('stdin-error')); } catch (_) {}

  // process.ppid is a snapshot — poll. Unref so the timer alone does not
  // keep the event loop alive past natural exit.
  const t = setInterval(() => {
    try { if (process.ppid === 1) fire('ppid-1'); } catch (_) {}
  }, 2000);
  if (typeof t.unref === 'function') t.unref();
}

module.exports = { installParentWatchdog };
