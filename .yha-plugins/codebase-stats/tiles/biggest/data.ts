// Biggest-files loader.
//
// Walks the CWD tree with fs.readdir (skipping noisy dirs), keeps a top-20
// by size. Walking in JS dodges find's stdout cap and avoids `sort | head`
// shell piping, which `ctx.exec` doesn't support (shell:false for safety).

import * as fs from 'node:fs';
import * as path from 'node:path';

interface Ctx {
  cwd: string;
}

const EXCLUDE_BASENAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.cache',
  '.bun', '.parcel-cache', '.turbo',
]);
const TOP_N = 20;
const MAX_FILES_SCANNED = 200_000; // hard ceiling to keep loader bounded

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

interface FileRow { path: string; size: number; human: string; }

export default async function load(ctx: Ctx) {
  const top: FileRow[] = [];
  let scanned = 0;

  function maybeInsert(rel: string, size: number): void {
    // Only allocate the object once we know the row would make the top-N.
    if (top.length < TOP_N) {
      top.push({ path: rel, size, human: human(size) });
      top.sort((a, b) => b.size - a.size);
      return;
    }
    const smallest = top[top.length - 1];
    if (size <= smallest.size) return;
    top[top.length - 1] = { path: rel, size, human: human(size) };
    top.sort((a, b) => b.size - a.size);
  }

  async function walk(dir: string): Promise<void> {
    if (scanned >= MAX_FILES_SCANNED) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied etc — skip silently
    }
    for (const ent of entries) {
      if (scanned >= MAX_FILES_SCANNED) return;
      if (ent.name.startsWith('.') && EXCLUDE_BASENAMES.has(ent.name)) continue;
      if (EXCLUDE_BASENAMES.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      scanned++;
      let stat: fs.Stats;
      try { stat = await fs.promises.stat(full); } catch { continue; }
      const rel = path.relative(ctx.cwd, full);
      maybeInsert(rel, stat.size);
    }
  }

  await walk(ctx.cwd);
  return { files: top, scanned };
}
