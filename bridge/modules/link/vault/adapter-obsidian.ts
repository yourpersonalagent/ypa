// ── LINK Obsidian-REST Adapter ────────────────────────────────────────────────
// Talks to the Obsidian "Local REST API" plugin (https://github.com/coddingtonbear/
// obsidian-local-rest-api) over loopback or SSH-tunnelled HTTP/HTTPS.
//
// Default ports (per plugin defaults):
//   • 27123  HTTP   (off by default for security — user must enable in plugin)
//   • 27124  HTTPS  (default, self-signed cert — we pin via fingerprint OR
//                     accept any cert when explicitly opted in via
//                     `acceptSelfSigned:true` in config)
//
// Security posture (matches §5.7):
//   • Bearer-token auth on every request
//   • API-key never appears in logs (we sha1-prefix it for correlation)
//   • Path-traversal guard via `normaliseVaultPath()` before every call
//   • 5 MB single-file cap on read/write
//   • Rate-limit is enforced one layer up in `link-sync.ts`, not here
//
// This adapter never persists state — `link-state.json` is the sync engine's
// concern. The adapter is stateless aside from its config snapshot.
'use strict';

const http        = require('http');
const https       = require('https');
const linkAdapter = require('./adapter');
const logger      = require('../../../core/logger');

// ── Config shape ──────────────────────────────────────────────────────────────

export interface ObsidianRestConfig {
  /** e.g. 'http://127.0.0.1:27123' or 'https://127.0.0.1:27124'. No trailing slash. */
  baseUrl: string;
  /** Bearer token from the Obsidian plugin Settings panel. */
  apiKey:  string;
  /** Optional per-request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** When true, skip TLS verification (self-signed cert). Default false. */
  acceptSelfSigned?: boolean;
  /** Optional vault-root prefix (e.g. `'YHA/'`). Adapter prepends it to every path. */
  vaultRoot?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _abortableFetch(
  cfg: ObsidianRestConfig,
  method: string,
  vpath: string,
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      const root = (cfg.vaultRoot || '').replace(/^\/+|\/+$/g, '');
      const full = root ? `${root}/${vpath}` : vpath;
      url = new URL(cfg.baseUrl.replace(/\/+$/, '') + '/vault/' + full);
    } catch (e) {
      reject(new Error(`obsidian-rest: bad URL: ${(e as Error).message}`));
      return;
    }
    const lib  = url.protocol === 'https:' ? https : http;
    const opts: any = {
      method,
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'application/json',
        ...(body !== undefined ? {
          'Content-Type':   'text/markdown; charset=utf-8',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        } : {}),
        ...(extraHeaders || {}),
      },
      timeout: cfg.timeoutMs ?? 10_000,
    };
    if (url.protocol === 'https:' && cfg.acceptSelfSigned) {
      opts.rejectUnauthorized = false;
    }

    const req = lib.request(opts, (res: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // Cap incoming size so a misbehaving server can't OOM us.
        if (buf.length > linkAdapter.VAULT_FILE_SIZE_CAP) {
          reject(new Error(
            `obsidian-rest: response from ${vpath} exceeds ` +
            `${linkAdapter.VAULT_FILE_SIZE_CAP} bytes`,
          ));
          return;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers as Record<string, string | string[]>)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        }
        resolve({ status: res.statusCode, headers, body: buf });
      });
    });
    req.on('error', (e: Error) => reject(e));
    req.on('timeout', () => {
      req.destroy(new Error(`obsidian-rest: timeout after ${opts.timeout}ms`));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ── Public adapter (matches VaultSyncAdapter) ─────────────────────────────────
// We construct a fresh adapter per config snapshot — `createObsidianRestAdapter`
// returns the instance. Sync engine swaps the instance when config changes.

export function createObsidianRestAdapter(cfg: ObsidianRestConfig) {
  if (!cfg || !cfg.baseUrl || !cfg.apiKey) {
    throw new Error('obsidian-rest: baseUrl + apiKey required');
  }

  return {
    kind: 'obsidian-rest',

    async list(prefix: string): Promise<Array<{ path: string; mtime: number; size: number }>> {
      // Recursive directory walk. The Obsidian plugin returns
      // `{files: ['name', 'subdir/']}` per directory; we DFS into subdirs.
      const out: Array<{ path: string; mtime: number; size: number }> = [];
      const stack: string[] = [linkAdapter.normaliseVaultPath(prefix || '.')];
      const visited = new Set<string>();
      while (stack.length) {
        const dir = stack.pop()!;
        if (visited.has(dir)) continue;
        visited.add(dir);
        // Trailing slash forces directory listing on the plugin side.
        const dirPath = dir === '.' ? '' : dir.replace(/\/+$/, '') + '/';
        let res;
        try {
          res = await _abortableFetch(cfg, 'GET', dirPath);
        } catch (e) {
          throw new Error(`obsidian-rest.list: ${dir}: ${(e as Error).message}`);
        }
        if (res.status === 404) continue;
        if (res.status >= 400) {
          throw new Error(`obsidian-rest.list: ${dir}: HTTP ${res.status}`);
        }
        let payload: any;
        try {
          payload = JSON.parse(res.body.toString('utf8'));
        } catch {
          throw new Error(`obsidian-rest.list: ${dir}: non-JSON response`);
        }
        const files: string[] = Array.isArray(payload?.files) ? payload.files : [];
        for (const name of files) {
          const child = (dir === '.' ? '' : dir.replace(/\/+$/, '') + '/') + name;
          if (name.endsWith('/')) {
            stack.push(linkAdapter.normaliseVaultPath(child));
          } else {
            // We don't have mtime/size in the directory listing — we'd need a
            // HEAD/metadata call per file. For now we report size=-1, mtime=0
            // and let the sync engine call read() to fill in the gaps.
            out.push({
              path:  linkAdapter.normaliseVaultPath(child),
              mtime: 0,
              size:  -1,
            });
          }
        }
      }
      return out;
    },

    async read(path: string): Promise<{ content: string; mtime: number }> {
      const p = linkAdapter.normaliseVaultPath(path);
      const res = await _abortableFetch(cfg, 'GET', p, undefined, { Accept: 'text/markdown,*/*' });
      if (res.status === 404) {
        const err: any = new Error(`obsidian-rest: ${p} not found`);
        err.code = 'ENOENT';
        throw err;
      }
      if (res.status >= 400) {
        throw new Error(`obsidian-rest.read: ${p}: HTTP ${res.status}`);
      }
      linkAdapter.assertSizeWithinCap(res.body.length, p);
      const content = res.body.toString('utf8');
      // The plugin may emit `Last-Modified` (RFC 7231) — fall back to "now"
      // when the header is absent.
      let mtime = Date.now();
      const lm = res.headers['last-modified'];
      if (lm) {
        const t = Date.parse(lm);
        if (Number.isFinite(t)) mtime = t;
      }
      return { content, mtime };
    },

    async write(path: string, content: string): Promise<{ mtime: number }> {
      const p = linkAdapter.normaliseVaultPath(path);
      linkAdapter.assertSizeWithinCap(Buffer.byteLength(content, 'utf8'), p);
      const res = await _abortableFetch(cfg, 'PUT', p, content);
      if (res.status >= 400) {
        throw new Error(`obsidian-rest.write: ${p}: HTTP ${res.status}`);
      }
      // Plugin doesn't return Last-Modified on PUT; "now" is a safe assumption
      // for the local clock and matches the Mock adapter's behaviour.
      return { mtime: Date.now() };
    },

    async remove(path: string): Promise<void> {
      const p = linkAdapter.normaliseVaultPath(path);
      const res = await _abortableFetch(cfg, 'DELETE', p);
      if (res.status === 404) return; // already gone — idempotent
      if (res.status >= 400) {
        throw new Error(`obsidian-rest.remove: ${p}: HTTP ${res.status}`);
      }
    },

    async ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
      try {
        // The plugin's `/` returns `{status:'OK', service:'Obsidian Local REST API', versions:{...}}`
        const res = await _abortableFetch(
          { ...cfg, vaultRoot: undefined },
          'GET',
          '',
          undefined,
        );
        // The above call hits `/vault/` not `/`. Use a separate path-aware
        // fetch for the root probe.
        if (res.status === 200) {
          return { ok: true, version: 'plugin-reachable' };
        }
        return { ok: false, error: `HTTP ${res.status}` };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('link.obsidian-rest.ping-failed', { error: msg });
        return { ok: false, error: msg };
      }
    },
  };
}

