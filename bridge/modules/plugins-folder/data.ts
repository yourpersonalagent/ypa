'use strict';

// Bridge-side data loader for declarative tiles.
//
// A tile's `data` manifest field names a Node-side script (e.g. `data.ts`)
// living next to `tile.json`. The script exports a default `async function
// load(ctx)` that returns JSON-serializable data; the host fetches it via
// `GET /v1/plugins/data` and feeds the result into the declarative widget.
//
// Hot-reload: Bun keys its module cache on URL string, so appending
// `?v=<mtime>` to the file URL forces a re-evaluation on edits without
// a bridge restart.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { SLUG_RE, PLUGINS_DIRNAME } = require('./scanner');
const { PLATFORM } = require('../../core/platform');

export interface DataCtx {
  cwd: string;
  query: Record<string, string>;
  // Host OS — lets tile loaders branch (e.g. ps vs Get-Process). Mirrors
  // process.platform: 'linux' | 'darwin' | 'win32' | …
  platform: NodeJS.Platform;
  exec: (
    cmd: string[],
    opts?: { cwd?: string; timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}

export type DataLoader = (ctx: DataCtx) => Promise<unknown>;

// Per-call caps. Tiles that need more should batch or paginate; runaway
// data loaders shouldn't be able to OOM the bridge or hang an event loop.
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BYTES = 1 * 1024 * 1024;
const ALLOWED_DATA_EXT = new Set(['.ts', '.mjs', '.js']);

interface ResolveParams {
  cwdResolved: string;
  plugin: string;
  tile: string;
  dataFile: string;
}

async function resolveDataFile(p: ResolveParams): Promise<{ absPath: string; mtimeMs: number }> {
  if (!SLUG_RE.test(p.plugin)) throw { status: 400, message: 'invalid plugin name' };
  if (!SLUG_RE.test(p.tile)) throw { status: 400, message: 'invalid tile name' };
  if (!p.dataFile || typeof p.dataFile !== 'string') throw { status: 400, message: 'data file missing' };
  if (
    p.dataFile.includes('..') ||
    p.dataFile.startsWith('/') ||
    p.dataFile.includes('\\') ||
    p.dataFile.includes('\0')
  ) {
    throw { status: 400, message: 'invalid data path' };
  }
  const tileRoot = path.join(p.cwdResolved, PLUGINS_DIRNAME, p.plugin, 'tiles', p.tile);
  const resolved = path.resolve(path.join(tileRoot, p.dataFile));
  const rel = path.relative(tileRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw { status: 403, message: 'path escapes tile root' };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_DATA_EXT.has(ext)) throw { status: 400, message: 'unsupported data extension' };
  let stat: any;
  try {
    stat = await fs.promises.lstat(resolved);
  } catch {
    throw { status: 404, message: 'data loader not found' };
  }
  // Symlinks for data.ts would let a hostile CWD point at arbitrary
  // files outside the plugin tree — refuse.
  if (stat.isSymbolicLink()) throw { status: 403, message: 'symlinks not allowed for data loaders' };
  if (!stat.isFile()) throw { status: 404, message: 'not a file' };
  return { absPath: resolved, mtimeMs: Math.floor(stat.mtimeMs) };
}

function makeExec(defaultCwd: string) {
  return function exec(
    cmd: string[],
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(cmd) || cmd.length === 0 || typeof cmd[0] !== 'string') {
        return reject(new Error('exec: cmd must be a non-empty string array'));
      }
      const timeout = Math.min(Math.max(opts?.timeoutMs ?? EXEC_TIMEOUT_MS, 1), EXEC_TIMEOUT_MS);
      // shell:false enforces argv form — no shell interpolation, so loader
      // authors who pass tainted query params can't accidentally inject.
      const child = spawn(cmd[0], cmd.slice(1), {
        cwd: opts?.cwd || defaultCwd,
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      let outBytes = 0;
      let errBytes = 0;
      let killed = false;
      const killTimer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeout);
      child.stdout.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > EXEC_MAX_BYTES) {
          killed = true;
          child.kill('SIGKILL');
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes > EXEC_MAX_BYTES) return; // silently drop overflow tail
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err: any) => {
        clearTimeout(killTimer);
        reject(err);
      });
      child.on('close', (code: number | null) => {
        clearTimeout(killTimer);
        if (killed) {
          return reject(new Error(`exec: killed (timeout or output overflow): ${cmd.join(' ')}`));
        }
        resolve({ stdout, stderr, code: code ?? -1 });
      });
    });
  };
}

export interface LoadTileDataOpts {
  cwdResolved: string;
  plugin: string;
  tile: string;
  dataFile: string;
  query: Record<string, string>;
}

export async function loadTileData(opts: LoadTileDataOpts): Promise<unknown> {
  const { absPath, mtimeMs } = await resolveDataFile({
    cwdResolved: opts.cwdResolved,
    plugin: opts.plugin,
    tile: opts.tile,
    dataFile: opts.dataFile,
  });
  const url = pathToFileURL(absPath).href + '?v=' + mtimeMs;
  let mod: any;
  try {
    mod = await import(url);
  } catch (e: any) {
    throw { status: 500, message: `data loader import failed: ${e?.message || String(e)}` };
  }
  const fn: DataLoader | undefined = mod?.default;
  if (typeof fn !== 'function') {
    throw { status: 500, message: 'data loader must export a default async function' };
  }
  const ctx: DataCtx = {
    cwd: opts.cwdResolved,
    query: opts.query,
    platform: PLATFORM,
    exec: makeExec(opts.cwdResolved),
  };
  return await fn(ctx);
}
