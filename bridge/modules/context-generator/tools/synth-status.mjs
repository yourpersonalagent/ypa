#!/usr/bin/env node
/**
 * synth-status.mjs — staleness checker for the synthesis bucket of any cwd.
 *
 * Lives inside the bridge that hosts the knowledge-memory MCP. Given a cwd,
 * resolves the bucket at <knowledge-root>/dirs/<slug>/synthesis/ where
 * <knowledge-root> is `bridge/knowledge/` (legacy / pre-Q16) or
 * `bridge/users/<email>/knowledge/` (post Q16 per-user migration). Slug =
 * absolute cwd path, leading '/' stripped, '/' replaced with '___'.
 * Reads each page's YAML frontmatter, and compares its `source_sha` against
 * git history in that cwd. Stale pages are listed with the commits that
 * landed since the last refresh.
 *
 * The default below points at the legacy location; pass --dir / set
 * YHA_SYNTH_DIR to override when the bucket lives under the per-user folder.
 *
 * The bucket is the editable source of truth — synthesis pages are read and
 * written directly here, served back to future sessions via the knowledge-
 * memory MCP. There is no separate "review" folder.
 *
 * Usage:
 *   node bridge/modules/context-generator/tools/synth-status.mjs
 *       # check the bucket for process.cwd()
 *
 *   node bridge/modules/context-generator/tools/synth-status.mjs --cwd <path>
 *       # check the bucket for an arbitrary cwd
 *
 *   node bridge/modules/context-generator/tools/synth-status.mjs --dir <bucket>
 *       # explicit bucket path (overrides --cwd resolution)
 *
 *   YHA_SYNTH_CWD=<path> node ... synth-status.mjs
 *   YHA_SYNTH_DIR=<bucket> node ... synth-status.mjs
 *
 * Exit codes: 0 = all current, 1 = at least one stale page, 2 = error.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
// tools/ → context-generator/ → modules/ → bridge/ → repo root
const BRIDGE_ROOT = resolve(TOOL_DIR, '..', '..', '..', '..');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function slugForCwd(cwd) {
  return cwd.replace(/^\//, '').replace(/\//g, '___');
}

function resolveCwd() {
  const fromArg = argValue('--cwd');
  if (fromArg) return resolve(fromArg);
  if (process.env.YHA_SYNTH_CWD) return resolve(process.env.YHA_SYNTH_CWD);
  return process.cwd();
}

function resolveBucket(cwd) {
  const fromArg = argValue('--dir');
  if (fromArg) return resolve(fromArg);
  if (process.env.YHA_SYNTH_DIR) return resolve(process.env.YHA_SYNTH_DIR);
  return join(BRIDGE_ROOT, 'bridge/knowledge/dirs', slugForCwd(cwd), 'synthesis');
}

function walkMarkdown(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full, base));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(relative(base, full));
    }
  }
  return out.sort();
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = raw.slice(3, end).trim();
  const out = {};
  let listKey = null;
  for (const line of block.split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const indented = /^\s+/.test(line);
    const trimmed = line.trim();
    if (!indented) {
      listKey = null;
      const m = trimmed.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2];
      if (val === '' || val === '|' || val === '>') {
        out[key] = [];
        listKey = key;
      } else {
        out[key] = stripQuotes(val);
      }
    } else if (listKey && trimmed.startsWith('- ')) {
      out[listKey].push(stripQuotes(trimmed.slice(2).trim()));
    }
  }
  return out;
}

function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function latestShaForPaths(cwd, paths) {
  if (!paths || paths.length === 0) return '';
  return git(cwd, ['log', '-1', '--format=%H', '--', ...paths]);
}

function commitsSince(cwd, fromSha, paths) {
  if (!fromSha) return [];
  const out = git(cwd, ['log', '--oneline', `${fromSha}..HEAD`, '--', ...paths]);
  return out ? out.split('\n') : [];
}

function shortSha(sha) {
  return sha ? sha.slice(0, 8) : '';
}

function pretty(p, root) {
  return p.startsWith(root) ? p.slice(root.length + 1) : p;
}

function main() {
  const cwd = resolveCwd();
  const bucket = resolveBucket(cwd);

  if (!existsSync(bucket) || !statSync(bucket).isDirectory()) {
    console.error(`No synthesis bucket at ${bucket}`);
    console.error(`(cwd resolved to ${cwd}; bridge root ${BRIDGE_ROOT})`);
    console.error(`Pass --dir <path> or set YHA_SYNTH_DIR to override the bucket location.`);
    process.exit(2);
  }

  const pages = walkMarkdown(bucket).filter((p) => p !== 'index.md' && p !== 'log.md');

  const stale = [];
  const current = [];
  const superseded = [];
  const skipped = [];
  const errors = [];

  for (const filename of pages) {
    const fullPath = join(bucket, filename);
    const raw = readFileSync(fullPath, 'utf8');
    const fm = parseFrontmatter(raw);

    if (!fm) {
      errors.push({ file: filename, msg: 'no frontmatter' });
      continue;
    }

    if (fm.status === 'superseded') {
      superseded.push({ file: filename, by: fm.superseded_by || '?' });
      continue;
    }

    if (!fm.source_sha || !fm.source_paths || fm.source_paths.length === 0) {
      skipped.push({ file: filename, msg: 'missing source_sha or source_paths' });
      continue;
    }

    const docShaFull = git(cwd, ['rev-parse', fm.source_sha]);
    if (!docShaFull) {
      errors.push({
        file: filename,
        msg: `source_sha ${fm.source_sha} not found in git history of ${cwd} (rewritten? squashed? wrong cwd?)`,
      });
      continue;
    }

    const commits = commitsSince(cwd, docShaFull, fm.source_paths);
    if (commits.length === 0) {
      current.push({ file: filename, sha: shortSha(docShaFull) });
    } else {
      const latest = latestShaForPaths(cwd, fm.source_paths);
      stale.push({
        file: filename,
        recorded: shortSha(docShaFull),
        latest: shortSha(latest),
        commits,
        page: fm.page ?? fm.module ?? filename.replace(/\.md$/, ''),
      });
    }
  }

  let exitCode = 0;

  console.log(`Synthesis staleness — ${pages.length} page(s) under ${pretty(bucket, BRIDGE_ROOT)}`);
  console.log(`(checking against git history of ${cwd})\n`);

  if (current.length) {
    console.log(`Up to date (${current.length}):`);
    for (const c of current) console.log(`  ✓ ${c.file}  @ ${c.sha}`);
    console.log('');
  }

  if (stale.length) {
    exitCode = 1;
    console.log(`STALE (${stale.length}):`);
    for (const s of stale) {
      console.log(`  • ${s.file}`);
      console.log(`      page: ${s.page}`);
      console.log(`      source_sha:  ${s.recorded}`);
      console.log(`      latest_sha:  ${s.latest}`);
      console.log(`      commits since last refresh (${s.commits.length}):`);
      for (const line of s.commits) console.log(`        ${line}`);
      console.log('');
    }
  }

  if (superseded.length) {
    console.log(`Superseded (${superseded.length}) — link-preservation stubs:`);
    for (const s of superseded) console.log(`  ~ ${s.file} → ${s.by}`);
    console.log('');
  }

  if (skipped.length) {
    console.log(`Skipped (${skipped.length}) — incomplete frontmatter:`);
    for (const s of skipped) console.log(`  - ${s.file}: ${s.msg}`);
    console.log('');
  }

  if (errors.length) {
    exitCode = exitCode || 2;
    console.log(`Errors (${errors.length}):`);
    for (const e of errors) console.log(`  ! ${e.file}: ${e.msg}`);
    console.log('');
  }

  if (!stale.length && !errors.length) {
    console.log('All synthesis pages are current.');
  }

  process.exit(exitCode);
}

main();
