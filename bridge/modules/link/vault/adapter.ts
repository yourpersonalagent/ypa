// ── LINK Adapter Interface ────────────────────────────────────────────────────
// Phase 3.1 of the ContextGenerator pipeline. Abstracts the destination of
// the bidirectional vault sync so we can swap between:
//   • mock           — in-memory, default at boot, used for E2E tests
//   • obsidian-rest  — Obsidian Local REST API plugin (default for users)
//   • webdav         — Nextcloud / generic WebDAV (multi-device)
//   • rsync-ssh      — SSH adapter for headless setups (low-priority)
//
// The interface is intentionally minimal — list/read/write/remove/ping —
// so the conflict-resolver, sensitivity-filter and watchdog can sit one layer
// above. See .ContextGenerator.MD §5.4.1 for the spec, §5.5 for conflict
// rules, §5.7 for the security model.
'use strict';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VaultFile {
  /** POSIX path relative to the vault root. No leading slash, no `..`. */
  path:  string;
  /** Last-modified timestamp in ms since epoch. Server-authoritative. */
  mtime: number;
  /** Size in bytes. */
  size:  number;
  /** SHA-1 hex of file content. Optional — adapters that can compute it
   *  cheaply should include it; otherwise the sync engine will compute it
   *  from `read()`. */
  sha1?: string;
}

export interface VaultReadResult {
  content: string;
  mtime:   number;
}

export interface VaultWriteResult {
  mtime: number;
}

export interface VaultPingResult {
  ok:      boolean;
  /** Adapter version / server version, when known. */
  version?: string;
  /** Human-readable error message, when `ok=false`. */
  error?:   string;
}

export interface VaultSyncAdapter {
  /** Identifier for logging / status. e.g. `'mock'`, `'obsidian-rest'`. */
  readonly kind: string;

  /** Lists every file under `prefix`, recursively. `prefix=''` lists root. */
  list(prefix: string): Promise<VaultFile[]>;

  /** Reads a file. Throws an Error with `code:'ENOENT'` when absent. */
  read(path: string): Promise<VaultReadResult>;

  /** Atomic write. Implementations should set mtime to "now" server-side. */
  write(path: string, content: string): Promise<VaultWriteResult>;

  /** Soft delete (move to trash) when supported; hard delete otherwise. */
  remove(path: string): Promise<void>;

  /** Health probe. Never throws — returns `{ok:false, error}` on failure. */
  ping(): Promise<VaultPingResult>;
}

// ── Path-safety guard (shared) ────────────────────────────────────────────────
// Every adapter must call this before touching the filesystem to refuse
// path-traversal attempts. Identical posture to the Sorter's
// _assertWithinGenerated() but expressed as a reusable normaliser so the
// adapters don't all reinvent it.

const path = require('path');

export function normaliseVaultPath(input: string): string {
  if (typeof input !== 'string' || !input) {
    throw new Error('vault path must be a non-empty string');
  }
  // Refuse absolute paths up-front. Forward and back-slash, NUL byte.
  if (input.startsWith('/') || input.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(input) || input.includes('\0')) {
    throw new Error(`vault path must be relative: ${input}`);
  }
  const normalised = path.posix.normalize(input.replace(/\\/g, '/'));
  if (normalised.startsWith('..') || normalised.includes('/../') || normalised === '..') {
    throw new Error(`vault path may not traverse upward: ${input}`);
  }
  // Strip leading "./" — common artifact, not a security issue.
  return normalised.startsWith('./') ? normalised.slice(2) : normalised;
}

// ── Single-file size cap (5 MB) ───────────────────────────────────────────────
// Every adapter enforces this on read AND write so a runaway page never
// crosses the boundary. Markdown notes are typically < 50 KB; 5 MB is a soft
// safety net, not a feature.

export const VAULT_FILE_SIZE_CAP = 5 * 1024 * 1024;

export function assertSizeWithinCap(bytes: number, path: string): void {
  if (bytes > VAULT_FILE_SIZE_CAP) {
    throw new Error(
      `vault file ${path} exceeds ${VAULT_FILE_SIZE_CAP} bytes (got ${bytes})`,
    );
  }
}

