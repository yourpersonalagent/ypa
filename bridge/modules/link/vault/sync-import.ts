// ── LINK Sync Engine — Vault-Folder Import (Phase 3.4d) ──────────────────────
// One-shot "scoop everything in <vaultPath> down to docs/keep-notes/" workflow.
// Used for the Google-Keep-Importer Obsidian plugin output: the user has
// already imported Keep into a folder of the vault (typically `Google Keep/`),
// and now wants those notes mirrored onto the server so the Picker / Sorter
// see them and so future edits sync bidirectionally.
//
// Distinct from a regular sync run because:
//   1. The vault-side prefix (`Google Keep/`) does NOT match any default
//      `syncDirs` mapping, so the watchdog wouldn't normally walk it. The
//      import re-points the `docs/keep-notes` server dir at the user's
//      vault folder by writing the mapping into `config.defaults.contextLink.syncDirs`.
//   2. We seed `link-state.json` for every imported file so the next sync
//      tick doesn't re-push them right back (which would be a no-op but
//      waste rate budget on a 500-note Keep dump).
//   3. We attach a frontmatter `sensitivity: public` (or `private` when the
//      target folder name suggests it) since Keep notes don't carry any
//      tier metadata — Sorter wouldn't otherwise know what to tag them as.
//
// Returns a summary the route layer turns into a JSON response.
//
// Implementation note: this routine intentionally bypasses the regular
// `_runOnce()` engine because (a) it operates on a folder the watchdog
// hasn't seen yet, (b) it should be one-shot rather than reconciling, and
// (c) we want to surface a different shape ({ imported, skipped, errors })
// than the regular run gives.
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../../../core/logger');

const { DOCS_ROOT } = require('./sync-constants');
const { _getAdapter } = require('./sync-secrets');
const { _readState, _writeStateAtomic, _sha1 } = require('./sync-state');
const { _ensureSensitivityFrontmatter } = require('./sync-policy');
const {
  _isWorkerRunning,
  _setLastPushAt,
  _setLastAdapterPing,
  _startProcess,
} = require('./sync-runner');

async function importVaultFolder(opts: {
  vaultPath:    string;                        // e.g. "Google Keep" or "Google Keep/Imported"
  serverDir?:   string;                        // default 'docs/keep-notes'
  category?:    string;                        // default 'keep-notes'
  sensitivity?: 'public' | 'private';          // default 'public'
  dryRun?:      boolean;                       // when true, list-only, no writes
  startSync?:   boolean;                       // when true (default), persist syncDirs override + kick a sync
}): Promise<{
  ok:        boolean;
  error?:    string;
  vaultPath: string;
  serverDir: string;
  imported:  number;
  skipped:   number;
  errors:    Array<{ path: string; error: string }>;
  total:     number;
  files?:    string[];                         // populated only on dry-run
  syncStarted?: boolean;
}> {
  const { config, saveConfig } = require('../../../core/state');
  const cfg = config.defaults?.contextLink || {};

  // ── Parameter validation ──────────────────────────────────────────────────
  let vaultPath = String(opts.vaultPath || '').trim().replace(/^\/+|\/+$/g, '');
  if (!vaultPath) {
    return {
      ok: false, error: 'vaultPath required',
      vaultPath: '', serverDir: '', imported: 0, skipped: 0, errors: [], total: 0,
    };
  }
  // Same path-safety posture as the standard `vaultRoot` setter — only
  // letters/digits/dot/underscore/dash/slash/space, no `..`.
  if (!/^[A-Za-z0-9._\-/ ]+$/.test(vaultPath) || vaultPath.split('/').some(seg => seg === '..' || seg === '')) {
    return {
      ok: false, error: 'vaultPath may only contain [A-Za-z0-9._-/ ], no `..`',
      vaultPath, serverDir: '', imported: 0, skipped: 0, errors: [], total: 0,
    };
  }
  const serverDir = String(opts.serverDir || 'docs/keep-notes').trim().replace(/^\/+|\/+$/g, '');
  if (!/^docs\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(serverDir)) {
    return {
      ok: false, error: 'serverDir must look like `docs/<name>` (no `..`, no spaces)',
      vaultPath, serverDir, imported: 0, skipped: 0, errors: [], total: 0,
    };
  }
  const sensitivityTier = opts.sensitivity === 'private' ? 'private' : 'public';
  const category        = (opts.category || 'keep-notes').trim();
  const startSync       = opts.startSync !== false;

  // ── Adapter check ─────────────────────────────────────────────────────────
  if (cfg.enabled === false) {
    return {
      ok: false, error: 'LINK is disabled — enable it first in Adapter settings.',
      vaultPath, serverDir, imported: 0, skipped: 0, errors: [], total: 0,
    };
  }
  const adapter = _getAdapter();
  if (!adapter) {
    return {
      ok: false, error: 'No adapter configured (paste the API key in Adapter settings).',
      vaultPath, serverDir, imported: 0, skipped: 0, errors: [], total: 0,
    };
  }
  if (adapter.kind === 'mock') {
    return {
      ok: false, error: 'Mock adapter cannot read your real vault. Switch to obsidian-rest first.',
      vaultPath, serverDir, imported: 0, skipped: 0, errors: [], total: 0,
    };
  }

  // ── Health probe ──────────────────────────────────────────────────────────
  try {
    const probe = await adapter.ping();
    _setLastAdapterPing({ ok: !!probe.ok, error: probe.error, at: Date.now() });
    if (!probe.ok) {
      return {
        ok: false, error: `Adapter ping failed: ${probe.error || 'unknown'}`,
        vaultPath, serverDir, imported: 0, skipped: 0, errors: [], total: 0,
      };
    }
  } catch (e) {
    _setLastAdapterPing({ ok: false, error: (e as Error).message, at: Date.now() });
    return {
      ok: false, error: `Adapter ping threw: ${(e as Error).message}`,
      vaultPath, serverDir, imported: 0, skipped: 0, errors: [], total: 0,
    };
  }

  // ── List the vault folder ─────────────────────────────────────────────────
  // The adapter's `list(prefix)` expects a vault-relative path WITH trailing
  // slash. We pass the user-provided vault folder verbatim — the adapter
  // already prepends the configured `vaultRoot` if any.
  const prefix = vaultPath.replace(/\/+$/, '') + '/';
  let listed: Array<{ path: string; mtime: number; size: number; sha1?: string }>;
  try {
    listed = await adapter.list(prefix);
  } catch (e) {
    return {
      ok: false, error: `list ${vaultPath}: ${(e as Error).message}`,
      vaultPath, serverDir, imported: 0, skipped: 0, errors: [], total: 0,
    };
  }
  // Markdown only — the picker/sorter only knows what to do with .md.
  // Future: extend to .pdf/.png by routing through the file-cat scanner.
  const mdFiles = listed.filter((f) => /\.md$/i.test(f.path));

  if (opts.dryRun) {
    return {
      ok: true,
      vaultPath, serverDir,
      imported: 0, skipped: 0, errors: [],
      total: mdFiles.length,
      files: mdFiles.map((f) => f.path).slice(0, 500),         // cap so dry-run JSON stays sane
    };
  }

  // ── Pull each file down ───────────────────────────────────────────────────
  const serverAbs = path.resolve(DOCS_ROOT, '..', serverDir);
  fs.mkdirSync(serverAbs, { recursive: true });

  const state = _readState();
  const errors: Array<{ path: string; error: string }> = [];
  let imported = 0;
  let skipped  = 0;

  for (const f of mdFiles) {
    try {
      // Strip the user-supplied vault-prefix so files land at the top of
      // `docs/keep-notes/` rather than re-creating the whole vault tree.
      // e.g. `Google Keep/2024-01-01.md` → `2024-01-01.md`.
      const stripped = f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path;
      // Defence: ensure the path is still vault-safe after the strip.
      let rel: string;
      try {
        rel = path.posix.normalize(stripped.replace(/^\/+/, ''));
      } catch {
        errors.push({ path: f.path, error: 'path-normalisation-failed' });
        continue;
      }
      if (rel.startsWith('..') || rel.includes('/../')) {
        errors.push({ path: f.path, error: 'path-traversal-rejected' });
        continue;
      }

      const targetAbs = path.resolve(serverAbs, rel);
      // Re-check the target stays under serverAbs (belt-and-braces against
      // adapter responses we don't fully trust).
      if (path.relative(serverAbs, targetAbs).startsWith('..')) {
        errors.push({ path: f.path, error: 'target-outside-server-dir' });
        continue;
      }

      // Skip if the file already exists with the same content (idempotent
      // re-imports are common while the user is iterating on which vault
      // folder is the "right" one).
      let alreadyOk = false;
      let existingHash: string | null = null;
      try {
        const existingContent = fs.readFileSync(targetAbs, 'utf8');
        existingHash = _sha1(existingContent);
      } catch { /* doesn't exist yet */ }

      // Read from the vault.
      const r = await adapter.read(f.path);

      // Inject sensitivity frontmatter when missing — Sorter / Picker /
      // sensitivity-filter all key off this. We DON'T overwrite an existing
      // `sensitivity:` line; respecting user-set tiers in their own notes.
      const augmented = _ensureSensitivityFrontmatter(r.content, sensitivityTier, category);
      const augmentedHash = _sha1(augmented);

      if (existingHash && existingHash === augmentedHash) {
        alreadyOk = true;
      }

      if (!alreadyOk) {
        fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
        fs.writeFileSync(targetAbs, augmented, 'utf8');
        imported++;
        try {
          const cg: any = require('../../../core/modules').getModuleApi('context-generator');
          cg?.contextRag?.enqueueKnowledgeForRag?.(targetAbs, 'write');
        } catch (_) { /* context-rag absent — fine */ }
      } else {
        skipped++;
      }

      // Seed link-state so the next watchdog tick doesn't re-push every file.
      const fullKey = `${serverDir}/${rel}`;
      state.files[fullKey] = {
        serverSha:    augmentedHash,
        serverMtime:  Date.now(),
        desktopSha:   existingHash === augmentedHash ? augmentedHash : null,
        desktopMtime: r.mtime || Date.now(),
        lastSyncAt:   Date.now(),
      };
    } catch (e) {
      errors.push({ path: f.path, error: (e as Error).message });
    }
  }

  _writeStateAtomic(state);
  logger.info('link.import-vault-folder', {
    vaultPath, serverDir, total: mdFiles.length, imported, skipped, errors: errors.length,
  });

  // ── Persist syncDirs override + kick a sync so the desktop picks up
  // any mutations the user made between the last vault-side edit and now.
  let syncStarted = false;
  if (startSync) {
    config.defaults              = config.defaults              || {};
    config.defaults.contextLink  = config.defaults.contextLink  || {};
    config.defaults.contextLink.syncDirs = config.defaults.contextLink.syncDirs || {};
    // Re-point the server dir at the user's actual vault folder. Trailing
    // slash matches the rest of the syncDirs map so `_serverDirToVaultPrefix`
    // returns it verbatim.
    config.defaults.contextLink.syncDirs[serverDir] = prefix;
    try {
      await saveConfig();
    } catch (e) {
      logger.warn('link.import-vault-folder.save-config-failed', { error: (e as Error).message });
    }
    // Run a sync IMMEDIATELY so the user sees the import-state reflected in
    // the LINK dashboard's last-run row, and so any vault-side edits made
    // since `adapter.read()` above get pulled.
    if (!_isWorkerRunning()) {
      _setLastPushAt(0);                              // bypass push rate limit for the kick
      void _startProcess();
      syncStarted = true;
    }
  }

  return {
    ok: true,
    vaultPath, serverDir,
    imported, skipped, errors,
    total: mdFiles.length,
    syncStarted,
  };
}

module.exports = {
  importVaultFolder,
};
