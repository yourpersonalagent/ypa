// ── LINK Sync Engine — Policy & Path Mapping ────────────────────────────────
// Sensitivity push-allow filter, sync-dirs resolution, conflict-policy
// selection, conflict-sidecar naming, and the frontmatter-injector used by
// `importVaultFolder`. All pure (or config-driven) — no FS I/O at the
// top-level functions, no worker state.
'use strict';

const path = require('path');

const {
  DEFAULT_SYNC_DIRS,
  DEFAULT_CONFLICT_POLICY,
} = require('./sync-constants');
const { _readSensitivityFromContent } = require('./sync-state');

type ConflictPolicy = 'server-wins' | 'desktop-wins' | 'newest-wins' | 'preserve-both';

// ── Sensitivity filter ───────────────────────────────────────────────────────

function _isPushAllowed(rel: string, content: string, cfg: any): { allowed: boolean; reason?: string } {
  // Hard block: anything under `docs/system/` (path-based fence — even if
  // the user accidentally drops a system-tier file outside the standard
  // tree, the categorizer will tag it `system` and it'll be blocked below).
  if (rel.startsWith('docs/system/') || rel.includes('/system/')) {
    return { allowed: false, reason: 'system-path' };
  }
  const tier = _readSensitivityFromContent(content);
  if (tier === 'system') {
    return { allowed: false, reason: 'system-tier' };
  }
  if (tier === 'private' && cfg?.syncSensitivity?.private !== true) {
    return { allowed: false, reason: 'private-not-opted-in' };
  }
  return { allowed: true };
}

// ── Vault path mapping ───────────────────────────────────────────────────────
// Convert between server-side paths (`docs/notes/foo.md`) and adapter-side
// paths (`notes/foo.md`). The mapping table is `cfg.syncDirs` (default in
// `DEFAULT_SYNC_DIRS`).

function _resolveSyncDirs(cfg: any): Record<string, string> {
  if (cfg?.syncDirs && typeof cfg.syncDirs === 'object') {
    return { ...DEFAULT_SYNC_DIRS, ...cfg.syncDirs };
  }
  return { ...DEFAULT_SYNC_DIRS };
}

function _serverDirToVaultPrefix(serverDir: string, syncDirs: Record<string, string>): string {
  return (syncDirs[serverDir] || (serverDir + '/')).replace(/^\/+/, '').replace(/\/+$/, '/') ;
}

// ── Conflict resolution ──────────────────────────────────────────────────────

function _policyFor(serverDir: string, cfg: any): ConflictPolicy {
  const explicit = cfg?.conflictPolicyByDir?.[serverDir];
  if (explicit && ['server-wins', 'desktop-wins', 'newest-wins', 'preserve-both'].includes(explicit)) {
    return explicit;
  }
  return DEFAULT_CONFLICT_POLICY[serverDir] || (cfg?.conflictPolicy as ConflictPolicy) || 'preserve-both';
}

function _conflictSidecar(rel: string, ts: number): string {
  // `foo.md` → `foo.conflict-<ts>.md`. Suffix is recognised by `_walkLocalDir`
  // and by the Sorter's eligibility scan (both skip these files).
  const dir  = path.dirname(rel);
  const ext  = path.extname(rel);
  const base = path.basename(rel, ext);
  const sidecar = `${base}.conflict-${ts}${ext}`;
  return dir === '.' ? sidecar : `${dir}/${sidecar}`;
}

// Helper: ensure the imported file has YAML frontmatter with at least
// `sensitivity` + `category`. If frontmatter exists and already has
// `sensitivity`, we leave it alone (user-set tier wins). If frontmatter
// exists but has no `sensitivity`, we splice the field in. If no
// frontmatter exists at all, we prepend a minimal block.
function _ensureSensitivityFrontmatter(content: string, tier: string, category: string): string {
  const hasFm = content.startsWith('---\n');
  if (hasFm) {
    const fmEnd = content.indexOf('\n---', 4);
    if (fmEnd > 0) {
      const fm = content.slice(4, fmEnd);
      const rest = content.slice(fmEnd + 4).replace(/^\n/, '');
      let next = fm;
      if (!/^sensitivity:/m.test(next)) next += `\nsensitivity: ${tier}`;
      if (!/^category:/m.test(next))    next += `\ncategory: ${category}`;
      if (!/^source:/m.test(next))      next += `\nsource: vault-import`;
      return `---\n${next}\n---\n${rest}`;
    }
  }
  // No frontmatter — prepend.
  return `---\nsensitivity: ${tier}\ncategory: ${category}\nsource: vault-import\n---\n\n${content.replace(/^\n+/, '')}`;
}

module.exports = {
  _isPushAllowed,
  _resolveSyncDirs,
  _serverDirToVaultPrefix,
  _policyFor,
  _conflictSidecar,
  _ensureSensitivityFrontmatter,
};
