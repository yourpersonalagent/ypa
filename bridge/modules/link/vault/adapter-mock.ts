// ── LINK Mock Adapter ─────────────────────────────────────────────────────────
// In-memory implementation of `VaultSyncAdapter`. Default adapter when LINK
// is not yet configured against a real Obsidian vault. Two purposes:
//   • End-to-end tests of the sync engine without external dependencies.
//   • A safe default at boot — `enabled=false` means no-op; `enabled=true` +
//     `adapter='mock'` exercises the full pipeline harmlessly until the user
//     swaps in a real adapter.
//
// The adapter persists nothing — restart wipes the in-memory store. State
// reconciliation (link-state.json) is owned by the sync engine, not the
// adapter, so a "fresh" mock just looks like an empty desktop vault.
'use strict';

const crypto = require('crypto');
const linkAdapter = require('./adapter');

// ── In-memory store ───────────────────────────────────────────────────────────

interface _MockEntry {
  content: string;
  mtime:   number;
  sha1:    string;
}

const _store: Map<string, _MockEntry> = new Map();

function _sha1(content: string): string {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
}

// ── Public API (matches VaultSyncAdapter) ─────────────────────────────────────

const mockAdapter = {
  kind: 'mock',

  async list(prefix: string): Promise<Array<{ path: string; mtime: number; size: number; sha1: string }>> {
    const out: Array<{ path: string; mtime: number; size: number; sha1: string }> = [];
    // Normalise + strip trailing slash, then re-append exactly one if a prefix
    // is being filtered. Avoids a "notes//" double-slash that never matches
    // anything in the store. `''` means "list everything".
    const stripped = prefix ? linkAdapter.normaliseVaultPath(prefix).replace(/\/+$/, '') : '';
    const norm = stripped ? stripped + '/' : '';
    for (const [p, entry] of _store) {
      if (!norm || p.startsWith(norm)) {
        out.push({
          path:  p,
          mtime: entry.mtime,
          size:  Buffer.byteLength(entry.content, 'utf8'),
          sha1:  entry.sha1,
        });
      }
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  },

  async read(path: string): Promise<{ content: string; mtime: number }> {
    const p = linkAdapter.normaliseVaultPath(path);
    const entry = _store.get(p);
    if (!entry) {
      const err: any = new Error(`mock-vault: ${p} not found`);
      err.code = 'ENOENT';
      throw err;
    }
    linkAdapter.assertSizeWithinCap(Buffer.byteLength(entry.content, 'utf8'), p);
    return { content: entry.content, mtime: entry.mtime };
  },

  async write(path: string, content: string): Promise<{ mtime: number }> {
    const p = linkAdapter.normaliseVaultPath(path);
    linkAdapter.assertSizeWithinCap(Buffer.byteLength(content, 'utf8'), p);
    const mtime = Date.now();
    _store.set(p, { content, mtime, sha1: _sha1(content) });
    return { mtime };
  },

  async remove(path: string): Promise<void> {
    const p = linkAdapter.normaliseVaultPath(path);
    _store.delete(p);
  },

  async ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    return { ok: true, version: 'mock-1.0' };
  },

  // ── Test-only helpers ───────────────────────────────────────────────────────
  // These are NOT part of the VaultSyncAdapter interface — they exist so
  // smoke-tests can prime / inspect the in-memory store without going through
  // the public API. Leaking them on the adapter type would be wrong; they're
  // exposed via direct module access.
  __reset: (): void => { _store.clear(); },
  __snapshot: (): Array<{ path: string; size: number }> => {
    return [..._store.entries()].map(([p, e]) => ({
      path: p,
      size: Buffer.byteLength(e.content, 'utf8'),
    }));
  },
  __seed: (path: string, content: string, mtime?: number): void => {
    const p = linkAdapter.normaliseVaultPath(path);
    _store.set(p, {
      content,
      mtime: mtime ?? Date.now(),
      sha1:  _sha1(content),
    });
  },
};

module.exports = mockAdapter;
