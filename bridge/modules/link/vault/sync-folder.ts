// ── LINK Sync Engine — Per-Folder Sync Workhorse ─────────────────────────────
// `_syncOneFolder` reconciles one mapped server-dir/vault-prefix pair.
// Walks both sides, diffs each file against `link-state.json`, and applies
// the configured conflict policy (server-wins / desktop-wins / newest-wins
// / preserve-both). All push-only-dir handling and sensitivity-filter
// invocations live here.
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../../../core/logger');

const { DOCS_ROOT, PUSH_ONLY_DIRS, MAX_SYNC_FILE_BYTES } = require('./sync-constants');
const { _sha1, _walkLocalDir, _isConflictSidecar }       = require('./sync-state');
const { _isPushAllowed, _conflictSidecar } = require('./sync-policy');

type ConflictPolicy = 'server-wins' | 'desktop-wins' | 'newest-wins' | 'preserve-both';

interface SyncFileState {
  serverSha:   string | null;
  serverMtime: number;
  desktopSha?: string | null;
  desktopMtime: number;
  lastSyncAt:  number;
}

interface LinkState {
  version: 1;
  files:   Record<string, SyncFileState>;
}

interface SyncRunStats {
  pushed:    number;
  pulled:    number;
  conflicts: number;
  errors:    Array<{ path: string; error: string }>;
  filesScanned: number;
}

// ── Single-folder sync ───────────────────────────────────────────────────────

async function _syncOneFolder(
  serverDir: string,
  vaultPrefix: string,
  policy: ConflictPolicy,
  cfg: any,
  adapter: any,
  state: LinkState,
  stats: SyncRunStats,
): Promise<void> {
  const serverAbs = path.resolve(DOCS_ROOT, '..', serverDir);
  fs.mkdirSync(serverAbs, { recursive: true });

  // 1. Snapshot server-side
  const serverFiles: Array<{ rel: string; abs: string; mtime: number; size: number; sha1: string }> = [];
  _walkLocalDir(serverAbs, '', serverFiles);
  const serverByPath = new Map(serverFiles.map((f) => [f.rel, f]));

  // 2. Snapshot desktop-side via adapter
  let desktopFiles: Array<{ path: string; mtime: number; size: number; sha1?: string }>;
  try {
    desktopFiles = await adapter.list(vaultPrefix);
  } catch (e) {
    stats.errors.push({ path: serverDir, error: `list: ${(e as Error).message}` });
    return;
  }
  const desktopByPath = new Map<string, { mtime: number; size: number; sha1?: string }>();
  for (const df of desktopFiles) {
    // Strip the vault prefix to get the per-folder relative path.
    const stripped = df.path.startsWith(vaultPrefix) ? df.path.slice(vaultPrefix.length) : df.path;
    desktopByPath.set(stripped, df);
  }

  // 3. Union of paths
  const allPaths = new Set<string>([...serverByPath.keys(), ...desktopByPath.keys()]);
  const isPushOnly = PUSH_ONLY_DIRS.has(serverDir);

  // 4. Per-path decision
  for (const rel of allPaths) {
    stats.filesScanned++;
    const fullKey = `${serverDir}/${rel}`;       // unique state-key across folders
    const last    = state.files[fullKey];
    const server  = serverByPath.get(rel);
    const desktop = desktopByPath.get(rel);

    // Never re-process conflict sidecars (any extension, incl. nested). They
    // are user-facing merge artifacts; letting them back into the sync is what
    // multiplied `foo.conflict-A.conflict-B.png` every tick until the folder
    // OOM'd the bridge. _walkLocalDir already drops them from serverByPath;
    // this also covers sidecars that came back from the desktop via list().
    // Likewise skip files over the adapter's size cap so a runaway binary
    // asset can't be pulled into memory on a read.
    if (_isConflictSidecar(rel) ||
        (desktop && typeof desktop.size === 'number' && desktop.size > MAX_SYNC_FILE_BYTES)) {
      continue;
    }

    try {
      // ── Case A: only server has it ─────────────────────────────────────
      if (server && !desktop) {
        // Sensitivity filter applies to push only.
        const ok = _isPushAllowed(`${serverDir}/${rel}`, fs.readFileSync(server.abs, 'utf8'), cfg);
        if (!ok.allowed) {
          logger.info('link.skip-push', { rel: fullKey, reason: ok.reason });
          continue;
        }
        if (last && last.serverSha === server.sha1) {
          // Server unchanged but desktop deleted — propagate delete unless
          // the policy is `server-wins` for this folder (then re-push).
          if (policy === 'server-wins' || isPushOnly) {
            await adapter.write(`${vaultPrefix}${rel}`, fs.readFileSync(server.abs, 'utf8'));
            stats.pushed++;
            state.files[fullKey] = {
              serverSha:    server.sha1,
              serverMtime:  server.mtime,
              desktopMtime: Date.now(),
              lastSyncAt:   Date.now(),
            };
          } else {
            // Desktop deleted intentionally — mirror that on server.
            try { fs.unlinkSync(server.abs); } catch { /* race-tolerant */ }
            delete state.files[fullKey];
            stats.pulled++;
          }
          continue;
        }
        // First-seen or genuine server-side change → push.
        await adapter.write(`${vaultPrefix}${rel}`, fs.readFileSync(server.abs, 'utf8'));
        stats.pushed++;
        state.files[fullKey] = {
          serverSha:    server.sha1,
          serverMtime:  server.mtime,
          desktopMtime: Date.now(),
          lastSyncAt:   Date.now(),
        };
        continue;
      }

      // ── Case B: only desktop has it ────────────────────────────────────
      if (!server && desktop) {
        if (isPushOnly) {
          // Desktop introduced a file in a push-only dir → ignore. Logged
          // so the user can clean up manually.
          logger.info('link.ignore-desktop-only-push-only', { rel: fullKey });
          continue;
        }
        if (last && (!last.desktopMtime || last.desktopMtime === desktop.mtime)) {
          // Server deleted, desktop unchanged → mirror delete to desktop.
          await adapter.remove(`${vaultPrefix}${rel}`);
          delete state.files[fullKey];
          stats.pushed++;
          continue;
        }
        // Pull from desktop.
        const r = await adapter.read(`${vaultPrefix}${rel}`);
        const targetAbs = path.resolve(serverAbs, rel);
        fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
        fs.writeFileSync(targetAbs, r.content, 'utf8');
        stats.pulled++;
        state.files[fullKey] = {
          serverSha:    _sha1(r.content),
          serverMtime:  Date.now(),
          desktopMtime: r.mtime,
          lastSyncAt:   Date.now(),
        };
        continue;
      }

      // ── Case C: both sides present — diff ──────────────────────────────
      if (server && desktop) {
        // Cheap pre-check: did anything move?
        const serverChanged = !last || last.serverSha !== server.sha1;
        // Adapters that can't return sha1 in list() leave it `undefined`. In
        // that case we read the desktop content to compute it. Cost: one
        // extra HTTP GET per ambiguous file per tick.
        let desktopSha: string;
        let desktopContent: string | null = null;
        if (typeof desktop.sha1 === 'string') {
          desktopSha = desktop.sha1;
        } else {
          const r = await adapter.read(`${vaultPrefix}${rel}`);
          desktopContent = r.content;
          desktopSha = _sha1(r.content);
          desktop.mtime = desktop.mtime || r.mtime;
        }
        const desktopChanged = !last || last.desktopSha !== desktopSha;

        if (!serverChanged && !desktopChanged) continue;
        if (serverChanged && !desktopChanged) {
          // Server-only change → push (apply sensitivity filter).
          const content = fs.readFileSync(server.abs, 'utf8');
          const ok = _isPushAllowed(`${serverDir}/${rel}`, content, cfg);
          if (!ok.allowed) {
            logger.info('link.skip-push', { rel: fullKey, reason: ok.reason });
            continue;
          }
          await adapter.write(`${vaultPrefix}${rel}`, content);
          stats.pushed++;
          state.files[fullKey] = {
            serverSha:    server.sha1,
            serverMtime:  server.mtime,
            desktopSha,
            desktopMtime: Date.now(),
            lastSyncAt:   Date.now(),
          };
          continue;
        }
        if (!serverChanged && desktopChanged) {
          if (isPushOnly) {
            // Desktop edit in a push-only dir → revert by re-pushing server.
            const content = fs.readFileSync(server.abs, 'utf8');
            await adapter.write(`${vaultPrefix}${rel}`, content);
            stats.pushed++;
            continue;
          }
          // Pull from desktop.
          const content = desktopContent ?? (await adapter.read(`${vaultPrefix}${rel}`)).content;
          fs.writeFileSync(server.abs, content, 'utf8');
          stats.pulled++;
          state.files[fullKey] = {
            serverSha:    _sha1(content),
            serverMtime:  Date.now(),
            desktopSha,
            desktopMtime: desktop.mtime || Date.now(),
            lastSyncAt:   Date.now(),
          };
          continue;
        }
        // ── Real conflict — both sides drifted ────────────────────────────
        stats.conflicts++;
        const effPolicy = isPushOnly ? 'server-wins' : policy;
        const tsTag = Date.now();
        if (effPolicy === 'server-wins') {
          // Stash desktop version locally so user can compare.
          const stashRel = _conflictSidecar(rel, tsTag);
          const stashAbs = path.resolve(serverAbs, stashRel);
          fs.mkdirSync(path.dirname(stashAbs), { recursive: true });
          const desktopRead = desktopContent ?? (await adapter.read(`${vaultPrefix}${rel}`)).content;
          fs.writeFileSync(stashAbs, desktopRead, 'utf8');
          // Push server version.
          const serverContent = fs.readFileSync(server.abs, 'utf8');
          const ok = _isPushAllowed(`${serverDir}/${rel}`, serverContent, cfg);
          if (!ok.allowed) continue;
          await adapter.write(`${vaultPrefix}${rel}`, serverContent);
          stats.pushed++;
          state.files[fullKey] = {
            serverSha:    server.sha1,
            serverMtime:  server.mtime,
            desktopSha:   _sha1(serverContent),
            desktopMtime: Date.now(),
            lastSyncAt:   Date.now(),
          };
          logger.warn('link.conflict-resolved', { rel: fullKey, policy: 'server-wins', stashRel });
        } else if (effPolicy === 'desktop-wins') {
          // Server version archived as conflict-sidecar, then overwritten.
          const stashRel = _conflictSidecar(rel, tsTag);
          const stashAbs = path.resolve(serverAbs, stashRel);
          fs.mkdirSync(path.dirname(stashAbs), { recursive: true });
          fs.writeFileSync(stashAbs, fs.readFileSync(server.abs, 'utf8'), 'utf8');
          const desktopRead = desktopContent ?? (await adapter.read(`${vaultPrefix}${rel}`)).content;
          fs.writeFileSync(server.abs, desktopRead, 'utf8');
          stats.pulled++;
          state.files[fullKey] = {
            serverSha:    _sha1(desktopRead),
            serverMtime:  Date.now(),
            desktopSha,
            desktopMtime: desktop.mtime || Date.now(),
            lastSyncAt:   Date.now(),
          };
          logger.warn('link.conflict-resolved', { rel: fullKey, policy: 'desktop-wins', stashRel });
        } else if (effPolicy === 'newest-wins') {
          if ((server.mtime || 0) >= (desktop.mtime || 0)) {
            const content = fs.readFileSync(server.abs, 'utf8');
            await adapter.write(`${vaultPrefix}${rel}`, content);
            stats.pushed++;
          } else {
            const desktopRead = desktopContent ?? (await adapter.read(`${vaultPrefix}${rel}`)).content;
            fs.writeFileSync(server.abs, desktopRead, 'utf8');
            stats.pulled++;
          }
          // Re-snapshot state.
          const finalContent = fs.readFileSync(server.abs, 'utf8');
          state.files[fullKey] = {
            serverSha:    _sha1(finalContent),
            serverMtime:  Date.now(),
            desktopSha:   _sha1(finalContent),
            desktopMtime: Date.now(),
            lastSyncAt:   Date.now(),
          };
          logger.warn('link.conflict-resolved', { rel: fullKey, policy: 'newest-wins' });
        } else {
          // preserve-both: write desktop version as `.conflict-<ts>.md`
          // alongside the server file, bump nothing else. User merges later.
          const stashRel = _conflictSidecar(rel, tsTag);
          const stashAbs = path.resolve(serverAbs, stashRel);
          fs.mkdirSync(path.dirname(stashAbs), { recursive: true });
          const desktopRead = desktopContent ?? (await adapter.read(`${vaultPrefix}${rel}`)).content;
          fs.writeFileSync(stashAbs, desktopRead, 'utf8');
          // Also push the conflict-sidecar to the desktop so the user sees
          // it in Obsidian without having to look at the filesystem.
          await adapter.write(`${vaultPrefix}${stashRel}`, desktopRead);
          state.files[`${serverDir}/${stashRel}`] = {
            serverSha:    _sha1(desktopRead),
            serverMtime:  Date.now(),
            desktopSha:   _sha1(desktopRead),
            desktopMtime: Date.now(),
            lastSyncAt:   Date.now(),
          };
          logger.warn('link.conflict-resolved', { rel: fullKey, policy: 'preserve-both', stashRel });
        }
        continue;
      }
    } catch (e) {
      stats.errors.push({ path: fullKey, error: (e as Error).message });
      logger.warn('link.sync-error', { rel: fullKey, error: (e as Error).message });
    }
  }
}

module.exports = {
  _syncOneFolder,
};
