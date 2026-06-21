#!/usr/bin/env node
// yha-rewind-gc — sweep orphaned blobs out of bridge/rewind/blobs/.
//
// A blob is "live" if any persisted baseline OR any JSONL record references
// it. Everything else is collectable. This is the cheap, mark-and-sweep
// equivalent for the rewind CAS — no incremental tracking, just a periodic
// pass when the disk footprint gets uncomfortable.
//
// Safety: we only sweep blobs whose mtime is older than --min-age-seconds
// (default 60s). The bridge writes a blob *before* the record that
// references it, so a brand-new blob may still get referenced moments
// later. The 60s buffer makes a race vanishingly unlikely even with the
// bridge running; pass --min-age-seconds=0 for a tighter sweep when you've
// stopped the bridge.
//
// Usage:
//   node tools/yha-rewind-gc.mjs            # dry run by default
//   node tools/yha-rewind-gc.mjs --apply    # actually delete
//   node tools/yha-rewind-gc.mjs --apply --min-age-seconds=0
//
// Exit 0 on success regardless of how many blobs were swept. Errors on
// individual blobs are logged and counted; they don't abort the pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const REWIND_DIR = path.join(REPO_ROOT, 'bridge', 'rewind');
const BLOBS_DIR = path.join(REWIND_DIR, 'blobs');
const BASELINES_DIR = path.join(REWIND_DIR, 'baselines');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const minAgeArg = [...args].find(a => a.startsWith('--min-age-seconds='));
const MIN_AGE_S = minAgeArg ? Number(minAgeArg.split('=')[1]) : 60;
if (!Number.isFinite(MIN_AGE_S) || MIN_AGE_S < 0) {
  console.error(`bad --min-age-seconds value`);
  process.exit(2);
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(2)} ${u[i]}`;
}

async function collectLiveHashes() {
  const live = new Set();

  // 1. Baselines — `{ files: { rel: sha256 } }`
  if (fs.existsSync(BASELINES_DIR)) {
    for (const name of fs.readdirSync(BASELINES_DIR)) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(BASELINES_DIR, name);
      try {
        const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (obj && obj.files) {
          for (const h of Object.values(obj.files)) {
            if (typeof h === 'string') live.add(h);
          }
        }
      } catch (e) {
        console.warn(`warn: baseline ${name}: ${e.message}`);
      }
    }
  }

  // 2. JSONL edit logs — each record has files[] with before_hash + after_hash.
  if (fs.existsSync(REWIND_DIR)) {
    for (const name of fs.readdirSync(REWIND_DIR)) {
      if (!name.endsWith('.jsonl')) continue;
      const p = path.join(REWIND_DIR, name);
      const rl = readline.createInterface({
        input: fs.createReadStream(p),
        crlfDelay: Infinity,
      });
      let lineNo = 0;
      for await (const raw of rl) {
        lineNo++;
        if (!raw.trim()) continue;
        try {
          const rec = JSON.parse(raw);
          for (const f of rec.files || []) {
            if (typeof f.before_hash === 'string') live.add(f.before_hash);
            if (typeof f.after_hash === 'string') live.add(f.after_hash);
          }
        } catch (e) {
          console.warn(`warn: ${name}:${lineNo}: ${e.message}`);
        }
      }
    }
  }

  return live;
}

async function main() {
  console.log(`yha-rewind-gc — ${APPLY ? 'APPLY' : 'DRY RUN'} — min-age=${MIN_AGE_S}s`);
  console.log(`  blobs:     ${BLOBS_DIR}`);
  console.log(`  baselines: ${BASELINES_DIR}`);

  if (!fs.existsSync(BLOBS_DIR)) {
    console.log('no blobs dir — nothing to do');
    return;
  }

  const t0 = Date.now();
  const live = await collectLiveHashes();
  console.log(`live hash set: ${live.size}`);

  const entries = fs.readdirSync(BLOBS_DIR);
  let kept = 0, sweptCount = 0, sweptBytes = 0, tooYoung = 0, errs = 0, keptBytes = 0;
  let tmpSweptCount = 0, tmpSweptBytes = 0;
  const ageCutoffMs = Date.now() - MIN_AGE_S * 1000;

  for (const name of entries) {
    const p = path.join(BLOBS_DIR, name);

    let st;
    try { st = fs.statSync(p); }
    catch (e) { errs++; console.warn(`stat ${name}: ${e.message}`); continue; }
    if (!st.isFile()) continue;

    // `writeBlob` uses `${dst}.tmp.${pid}.${ts}` and renames in place,
    // so a `.tmp.*` here is always an orphan from a crashed/interrupted
    // write. Safe to sweep once it's older than the min-age window.
    if (/\.tmp\.\d+\.\d+$/.test(name)) {
      if (st.mtimeMs > ageCutoffMs) {
        tooYoung++;
        continue;
      }
      tmpSweptCount++;
      tmpSweptBytes += st.size;
      if (APPLY) {
        try { fs.unlinkSync(p); }
        catch (e) { errs++; console.warn(`unlink tmp ${name}: ${e.message}`); }
      }
      continue;
    }

    if (live.has(name)) {
      kept++;
      keptBytes += st.size;
      continue;
    }
    if (st.mtimeMs > ageCutoffMs) {
      tooYoung++;
      continue;
    }
    sweptCount++;
    sweptBytes += st.size;
    if (APPLY) {
      try { fs.unlinkSync(p); }
      catch (e) { errs++; console.warn(`unlink ${name}: ${e.message}`); }
    }
  }

  const dtMs = Date.now() - t0;
  console.log('');
  console.log(`scanned:     ${entries.length} blobs in ${dtMs} ms`);
  console.log(`kept:        ${kept} (${fmtBytes(keptBytes)})`);
  console.log(`swept:       ${sweptCount} (${fmtBytes(sweptBytes)})${APPLY ? '' : '  [dry run — not deleted]'}`);
  console.log(`swept (tmp): ${tmpSweptCount} (${fmtBytes(tmpSweptBytes)})${APPLY ? '' : '  [dry run — not deleted]'}`);
  console.log(`too young:   ${tooYoung}  (< ${MIN_AGE_S}s old, kept for safety)`);
  if (errs) console.log(`errors:      ${errs}`);
  const totalReclaim = sweptBytes + tmpSweptBytes;
  if (!APPLY && totalReclaim > 0) {
    console.log(`\nTotal reclaimable: ${fmtBytes(totalReclaim)} — re-run with --apply to free it.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
