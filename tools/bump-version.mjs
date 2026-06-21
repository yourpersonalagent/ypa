#!/usr/bin/env bun
// Bump the canonical project version (repo-root VERSION) and sync every
// package.json that carries a version field. VERSION is the single source of
// truth — see AGENTS.md. This script does NOT commit or tag; it prints the
// suggested git commands so cutting a release stays an explicit, reviewable
// action.
//
// Usage:
//   bun run release            bump patch (default)
//   bun run release patch
//   bun run release minor
//   bun run release major
//   bun run release 2.4.0      set an explicit version
//   bun run version:show       print current version, make no changes

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = join(ROOT, 'VERSION');

// package.json files that should track the canonical version.
const PKG_FILES = [
  join(ROOT, 'frontend', 'package.json'),
  join(ROOT, 'bridge', 'package.json'),
  join(ROOT, 'bridge', 'mcp', 'package.json'),
];

function readVersion() {
  try {
    return readFileSync(VERSION_FILE, 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`current VERSION "${v}" is not a plain x.y.z semver`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function computeNext(current, arg) {
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg; // explicit version
  const [maj, min, pat] = parseSemver(current);
  switch (arg) {
    case 'major':
      return `${maj + 1}.0.0`;
    case 'minor':
      return `${maj}.${min + 1}.0`;
    case 'patch':
      return `${maj}.${min}.${pat + 1}`;
    default:
      throw new Error(`unknown bump "${arg}" — use major | minor | patch | x.y.z`);
  }
}

const cmd = process.argv[2] ?? 'patch';

if (cmd === 'show' || cmd === '--show' || cmd === 'current') {
  console.log(readVersion());
  process.exit(0);
}

const current = readVersion();
const next = computeNext(current, cmd);

if (next === current) {
  console.log(`VERSION already ${current} — nothing to do.`);
  process.exit(0);
}

// Trailing newline matches the POSIX text-file convention the VERSION file uses.
writeFileSync(VERSION_FILE, next + '\n');
console.log(`VERSION  ${current} -> ${next}`);

for (const file of PKG_FILES) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    console.warn(`  (skip) ${file} not found`);
    continue;
  }
  const pkg = JSON.parse(raw);
  const before = pkg.version;
  pkg.version = next;
  // Preserve 2-space indent + trailing newline (matches the repo's package.json style).
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
  console.log(`  ${rel}  ${before} -> ${next}`);
}

console.log('');
console.log('Next steps (not run automatically):');
console.log('  git add VERSION frontend/package.json bridge/package.json bridge/mcp/package.json');
console.log(`  git commit -m "release: v${next}"`);
console.log(`  git tag v${next}`);
console.log('  git push && git push --tags');
