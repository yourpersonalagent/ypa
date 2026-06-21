#!/usr/bin/env bun
// Runs the bridge's stand-alone test scripts (bridge/__tests__/*.test.ts).
//
// These files are NOT bun:test modules — each is a self-contained script with a
// hand-rolled assert harness that calls process.exit(failed > 0 ? 1 : 0). Running
// them under `bun test` reports "Ran 0 tests" and can exit 0 even on failure, so
// they must be invoked directly. This runner discovers them, runs each with `bun`,
// and fails if any exits non-zero.
//
// file-manager.test.ts shells out to the system `zip`/`unzip` binaries and asserts
// POSIX path semantics; it is skipped when `zip`/`unzip` are unavailable (e.g. a
// stock Windows box) so local `verify` stays green. CI runs on Linux where both
// exist, so nothing is skipped there.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const bridgeDir = join(repoRoot, 'bridge');
const testsDir = join(bridgeDir, '__tests__');

const hasBin = (bin) => !spawnSync(bin, ['--version'], { stdio: 'ignore' }).error;
const zipAvailable = hasBin('zip') && hasBin('unzip');

// Tests that need external binaries we can't guarantee on every host.
const needsZip = new Set(['file-manager.test.ts']);

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

let failed = 0;
let skipped = 0;

for (const file of files) {
  if (needsZip.has(file) && !zipAvailable) {
    console.log(`\n[skip] ${file} — requires zip/unzip on PATH (not found)`);
    skipped++;
    continue;
  }
  console.log(`\n[run]  ${file}`);
  const res = spawnSync('bun', [join(testsDir, file)], {
    stdio: 'inherit',
    cwd: bridgeDir,
  });
  if (res.status !== 0) {
    console.error(`[FAIL] ${file} exited with ${res.status ?? res.signal}`);
    failed++;
  }
}

console.log(
  `\nbridge tests: ${files.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`,
);
process.exit(failed > 0 ? 1 : 0);
