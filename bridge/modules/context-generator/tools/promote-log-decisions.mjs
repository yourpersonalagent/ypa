#!/usr/bin/env node
/**
 * promote-log-decisions.mjs — promote `decision` entries from log.md into
 * standalone `decisions/<date>-<slug>.md` pages.
 *
 * The activity log is append-only prose; decisions buried inside it are
 * invisible to `knowledge_ask`, the synthesis-listing tool, and the staleness
 * checker. This promoter parses every `## [YYYY-MM-DD] decision | <title>`
 * block out of log.md and writes a per-entry markdown file with the same
 * frontmatter shape the staleness checker expects (`source_sha`,
 * `source_paths`, `built_at`).
 *
 * Idempotent: pages that already exist are left alone (so manual edits stick
 * across reruns). Pass `--force` to overwrite existing files.
 *
 * Bucket default: `<bridge-root>/bridge/knowledge/dirs/<slug>/synthesis`
 * (legacy / pre-Q16). Post-migration the bucket lives under
 * `bridge/users/<email>/knowledge/dirs/<slug>/synthesis` — pass --dir or set
 * YHA_SYNTH_DIR to point there.
 *
 * Usage:
 *   node bridge/modules/context-generator/tools/promote-log-decisions.mjs
 *       # promote decisions from the bucket for process.cwd()
 *
 *   node bridge/modules/context-generator/tools/promote-log-decisions.mjs --cwd <path>
 *   node bridge/modules/context-generator/tools/promote-log-decisions.mjs --dir <bucket>
 *   node bridge/modules/context-generator/tools/promote-log-decisions.mjs --force
 *
 * Exit codes: 0 = ok (idempotent), 2 = error (missing bucket / log).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
// tools/ → context-generator/ → modules/ → bridge/ → repo root
const BRIDGE_ROOT = resolve(TOOL_DIR, '..', '..', '..', '..');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function argFlag(name) {
  return process.argv.includes(name);
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

function slugifyTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

// Parse `## [YYYY-MM-DD] decision | <title>` headings and capture the body
// paragraph(s) until the next `## ` heading. We only promote `decision` kind —
// `ingest`, `query`, `lint` stay in the diary.
function parseDecisions(raw) {
  const lines = raw.split('\n');
  const decisions = [];
  let cur = null;
  const headingRe = /^##\s+\[(\d{4}-\d{2}-\d{2})\]\s+(\w+)\s+\|\s+(.+)$/;
  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      if (cur) decisions.push(cur);
      const [, date, kind, title] = m;
      cur = kind === 'decision'
        ? { date, title: title.trim(), body: [] }
        : null;
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) decisions.push(cur);
  // Trim trailing blank lines from each body so the rendered page is tight.
  for (const d of decisions) {
    while (d.body.length && d.body[d.body.length - 1].trim() === '') d.body.pop();
    while (d.body.length && d.body[0].trim() === '') d.body.shift();
  }
  return decisions;
}

function gitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function renderPage(d, sourceLogPath, sourceSha) {
  const builtAt = new Date().toISOString();
  const fmLines = [
    '---',
    `type: decision`,
    `date: ${d.date}`,
    `title: "${d.title.replace(/"/g, '\\"')}"`,
    `source_paths:`,
    `  - ${sourceLogPath}`,
    ...(sourceSha ? [`source_sha: ${sourceSha}`] : []),
    `built_at: ${builtAt}`,
    `promoted_from: log.md`,
    '---',
  ];
  return [
    ...fmLines,
    '',
    `# ${d.title}`,
    '',
    `> Promoted from log.md entry of ${d.date}.`,
    '',
    ...d.body,
    '',
  ].join('\n');
}

function main() {
  const cwd = resolveCwd();
  const bucket = resolveBucket(cwd);
  const force = argFlag('--force');

  if (!existsSync(bucket) || !statSync(bucket).isDirectory()) {
    console.error(`No synthesis bucket at ${bucket}`);
    process.exit(2);
  }

  const logPath = join(bucket, 'log.md');
  if (!existsSync(logPath)) {
    console.error(`No log.md at ${logPath}`);
    process.exit(2);
  }

  const decisionsDir = join(bucket, 'decisions');
  mkdirSync(decisionsDir, { recursive: true });

  const raw = readFileSync(logPath, 'utf8');
  const decisions = parseDecisions(raw);

  if (decisions.length === 0) {
    console.log(`No decision entries found in ${logPath}.`);
    process.exit(0);
  }

  const sourceSha = gitHead(cwd);
  // Path stamped into source_paths is repo-relative when log.md lives inside
  // the workdir, otherwise absolute. The bucket isn't typically inside the
  // workdir, so absolute is the safe default.
  const sourceLogPath = logPath;

  let created = 0;
  let skipped = 0;

  for (const d of decisions) {
    const slug = slugifyTitle(d.title);
    const filename = `${d.date}-${slug}.md`;
    const outPath = join(decisionsDir, filename);
    if (existsSync(outPath) && !force) {
      skipped++;
      continue;
    }
    writeFileSync(outPath, renderPage(d, sourceLogPath, sourceSha));
    created++;
  }

  console.log(`promote-log-decisions: ${created} created, ${skipped} skipped (already existed)${force ? ' [--force]' : ''}`);
  console.log(`  bucket:    ${bucket}`);
  console.log(`  decisions: ${decisionsDir}`);
  console.log(`  source:    ${logPath}`);
  if (sourceSha) console.log(`  source_sha: ${sourceSha.slice(0, 8)}`);
  process.exit(0);
}

main();
