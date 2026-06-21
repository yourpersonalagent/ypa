// ── Harness detection / auto-fix routes ────────────────────────────────────
// Extracted from handler.ts (registerConfigRoutes) — see ./handler.ts.
// Attaches app._initHarnessAutoFix (server.ts calls it once after route
// registration so a fresh-after-update launch self-heals stale binary paths).
'use strict';

const fs = require('fs');
const path = require('path');
const { config, CONFIG_PATH, saveConfig } = require('../core/state');
const { IS_WINDOWS } = require('../core/platform');
const { invalidateModelCache } = require('../models');

function registerHarnessRoutes(app) {
  // ── GET /v1/harness/detect — check which harness binaries are installed ─────
  // Returns one entry per known type with `installed`, `binaryPath`, and
  // `configDirHint`. The frontend uses this to drive the "Enabled Harness Types"
  // toggle row so users only see config sections for harnesses they actually have.
  // ── Harness detect helpers (shared by GET /v1/harness/detect and
  // POST /v1/harness/refresh + boot-time initHarnessAutoFix) ────────────────
  const isWindows = IS_WINDOWS;
  const PATHEXT = isWindows
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((s) => s.trim()).filter(Boolean)
    : [''];
  // Cross-platform PATH lookup. Avoid shelling to `which` / `where` —
  // `which` doesn't exist on Windows, `where` doesn't exist on
  // Linux/macOS, and either failure here makes every harness look
  // uninstalled, hiding the entire "Add subscription account" UI.
  function which(bin) {
    const pathDirs = String(process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
      if (!dir) continue;
      for (const ext of PATHEXT) {
        const full = path.join(dir, bin + ext);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) return full;
        } catch (_) { /* ignore */ }
      }
    }
    return null;
  }
  // Windows-only fallback: Claude Code and Codex installers drop binaries
  // at version-pinned paths under %APPDATA% but DON'T add them to PATH.
  // Scan the standard install roots and return the highest-version exe
  // so detection works out of the box on a fresh Windows install.
  function findWindowsBinary(bin) {
    if (!isWindows) return null;
    // Standard Windows global-install locations, checked in addition to
    // each binary's own well-known install dir.
    const npmGlobalDir = path.join(process.env.APPDATA || '', 'npm');
    const bunGlobalDir = path.join(process.env.USERPROFILE || '', '.bun', 'bin');
    const repoBinDir = path.resolve(__dirname, '..', '..', 'bin');
    const roots = bin === 'claude'
      ? [
          // Stable copy populated by the bridge on Windows when the vendor
          // installer lives under AppData / OneDrive-risk paths.
          repoBinDir,
          // Standalone Claude Code installer (Squirrel-style versioned dirs)
          path.join(process.env.APPDATA || '', 'Claude', 'claude-code'),
          // Less common but possible: npm or bun global install
          npmGlobalDir,
          bunGlobalDir,
        ]
      : bin === 'codex'
      ? [
          // Stable copy populated by the bridge on Windows when the official
          // installer path is version/hash-pinned under LocalAppData.
          repoBinDir,
          // Official OpenAI installer:
          // %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
          // findWindowsBinary scans direct hits and one subdir level.
          path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'),
          // npm: `npm install -g @openai/codex` lands codex.cmd here
          npmGlobalDir,
          // bun: `bun install -g @openai/codex`
          bunGlobalDir,
          // Hypothetical Squirrel-style installer (matches Claude Code's
          // versioned-dir layout). Cheap to check, harmless if absent.
          path.join(process.env.APPDATA || '', 'codex'),
          path.join(process.env.LOCALAPPDATA || '', 'codex'),
        ]
      : bin === 'grok'
      ? [
          // Official xAI installer (`curl https://x.ai/cli/install.sh | bash`)
          // drops grok.exe + agent.exe here on Windows (via Git Bash / MSYS).
          path.join(process.env.USERPROFILE || '', '.grok', 'bin'),
          // Fallbacks if installed via a package manager wrapper.
          npmGlobalDir,
          bunGlobalDir,
        ]
      : [];
    for (const root of roots) {
      try {
        if (!fs.statSync(root).isDirectory()) continue;
        // Direct hit (no version subdir)
        for (const ext of PATHEXT) {
          const full = path.join(root, bin + ext);
          try { if (fs.statSync(full).isFile()) return full; } catch (_) {}
        }
        // Versioned subdirs (e.g. claude-code/2.1.149/claude.exe). Sort
        // newest first by semver-ish lex order — works for vendors that
        // version with x.y.z (zero-padding not needed at this scale).
        const subdirs = fs.readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
          .reverse();
        for (const sub of subdirs) {
          for (const ext of PATHEXT) {
            const full = path.join(root, sub, bin + ext);
            try { if (fs.statSync(full).isFile()) return full; } catch (_) {}
          }
        }
      } catch (_) { /* root doesn't exist — try next */ }
    }
    return null;
  }
  // Native macOS/Linux installers commonly add their per-user binary dir to
  // shell startup files, but PM2 and other non-interactive launch paths do not
  // necessarily read those files. Probe the vendor locations directly so the
  // Harness tab remains accurate regardless of how the bridge was started.
  function findUnixBinary(bin) {
    if (isWindows) return null;
    const home = require('os').homedir();
    const roots = [
      path.join(home, '.local', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    if (bin === 'grok') roots.unshift(path.join(home, '.grok', 'bin'));
    if (bin === 'claude') roots.unshift(path.join(home, '.claude', 'bin'));
    if (bin === 'codex') roots.unshift(path.join(home, '.codex', 'bin'));
    for (const root of roots) {
      const full = path.join(root, bin);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        if (fs.statSync(full).isFile()) return full;
      } catch (_) { /* try next */ }
    }
    return null;
  }
  function findBinary(bin) {
    return which(bin) || (isWindows ? findWindowsBinary(bin) : findUnixBinary(bin));
  }
  function dirExists(p) {
    try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
  }
  // Config copied from another host often keeps the Linux template prefix
  // /home/user (see bridge/config/paths.ts). Rewrite to this machine's
  // real homedir so harness OAuth dirs and auth copy-paste commands work.
  function rewritePlaceholderHome(p) {
    if (!p || typeof p !== 'string') return p;
    const home = require('os').homedir();
    if (p === '/home/user') return home;
    if (p.startsWith('/home/user/')) {
      return path.join(home, p.slice('/home/user/'.length));
    }
    return p;
  }
  app.get('/v1/harness/detect', (_req, res) => {
    const os = require('os');
    const home = os.homedir();
    const types = [
      { type: 'claude',  label: 'Claude Code', category: 'subscription',   bin: 'claude', configHint: path.join(home, '.claude') },
      { type: 'codex',   label: 'Codex',       category: 'subscription',   bin: 'codex',  configHint: path.join(home, '.codex')  },
      { type: 'grok',    label: 'Grok Build',  category: 'subscription',   bin: 'grok',   configHint: path.join(home, '.grok')   },
      { type: 'aider',   label: 'Aider',       category: 'single-account', bin: 'aider',  configHint: path.join(home, '.aider')  },
      { type: 'pi',      label: 'Pi',          category: 'single-account', bin: 'pi',     configHint: path.join(home, '.pi')     },
    ];
    const result = {};
    for (const t of types) {
      // Prefer PATH (whatever the user wired up) over our well-known
      // Windows install paths, so an explicitly-installed alternate
      // (e.g. wrapper script) wins over an auto-discovered version dir.
      const binPath = findBinary(t.bin);
      result[t.type] = {
        type: t.type,
        label: t.label,
        category: t.category,
        installed: !!binPath,
        binaryPath: binPath,
        configDirHint: t.configHint,
        configDirExists: dirExists(t.configHint),
      };
    }
    res.json({ success: true, harnesses: result });
  });

  // ── POST /v1/harness/refresh — re-detect + auto-update stale paths ──────────
  // Use case: Claude Code or Codex auto-updates to a new version, the path in
  // config.defaults.{claude,codex}Bin (and each instance's override) becomes
  // a 404 on the next spawn. This endpoint re-runs detection AND rewrites
  // config.json wherever the stored path is gone / wrong, then saves.
  //
  // Idempotent: if nothing changed, returns {changes:[], harnesses:{...}}.
  // Same detection helpers as GET /v1/harness/detect (findBinary)
  // so behaviour stays in sync.
  //
  // The frontend Preferences → Harness tab calls this from a "Refresh" button.
  // Also called once at boot via initHarnessAutoFix() below so a fresh-after-
  // update launch heals itself without UI interaction.
  app.post('/v1/harness/refresh', async (_req, res) => {
    try {
      const result = await refreshHarnessBins();
      res.json({ success: true, ...result });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // Shared by /v1/harness/refresh + boot-time initHarnessAutoFix.
  // Returns { harnesses, changes } where changes is a list of
  // { where: 'defaults.claudeBin' | 'claudeInstances[<label>].claudeBin', old, new }
  // describing every config edit applied. Saves config.json only if changes
  // is non-empty.
  async function refreshHarnessBins() {
    const os2 = require('os');
    const home2 = os2.homedir();
    const types = [
      { type: 'claude',  label: 'Claude Code', category: 'subscription',   bin: 'claude', configHint: path.join(home2, '.claude'), configKey: 'claudeBin', instancesKey: 'claudeInstances' },
      { type: 'codex',   label: 'Codex',       category: 'subscription',   bin: 'codex',  configHint: path.join(home2, '.codex'),  configKey: 'codexBin',  instancesKey: 'codexInstances'  },
      { type: 'grok',    label: 'Grok Build',  category: 'subscription',   bin: 'grok',   configHint: path.join(home2, '.grok'),   configKey: 'grokBin',   instancesKey: 'grokInstances'   },
      { type: 'aider',   label: 'Aider',       category: 'single-account', bin: 'aider',  configHint: path.join(home2, '.aider'),  configKey: 'aiderBin',  instancesKey: null               },
      { type: 'pi',      label: 'Pi',          category: 'single-account', bin: 'pi',     configHint: path.join(home2, '.pi'),     configKey: 'piBin',     instancesKey: null               },
    ];

    // Windows OneDrive workaround: %APPDATA% can be virtualized so that
    // spawning a binary from there fails with "system cannot find path
    // specified" even when Test-Path / Explorer see it. Mitigation:
    // when the detected path is under %APPDATA%, copy the binary to
    // <bridgeRoot>/../bin/<name>.exe (the yha/bin tree is deliberately
    // outside OneDrive per the install convention) and use THAT copy
    // as the canonical path. Self-heals on Claude Code auto-updates.
    function stableizeOnWindows(detected: string, binBase: string): string {
      if (!IS_WINDOWS) return detected;
      if (!detected) return detected;
      // Only stabilize if the source is in a OneDrive-risk zone.
      const lowered = detected.toLowerCase();
      const inRiskZone = lowered.includes('\\appdata\\') || lowered.includes('\\onedrive\\');
      if (!inRiskZone) return detected;
      const targetDir = path.resolve(path.dirname(CONFIG_PATH), '..', 'bin');
      const targetPath = path.join(targetDir, binBase + '.exe');
      try {
        fs.mkdirSync(targetDir, { recursive: true });
        // Only copy if source is newer than (or differs in size from) the
        // existing copy. Avoids re-copying 234 MB on every boot.
        let needsCopy = true;
        try {
          const srcStat = fs.statSync(detected);
          const dstStat = fs.statSync(targetPath);
          if (srcStat.size === dstStat.size && srcStat.mtimeMs <= dstStat.mtimeMs) {
            needsCopy = false;
          }
        } catch (_) { /* dst missing → needsCopy stays true */ }
        if (needsCopy) {
          // Use the long-path prefix on the source so OneDrive
          // virtualization can't ENOENT us mid-copy.
          const src = `\\\\?\\${detected}`;
          fs.copyFileSync(src, targetPath);
          console.log(`[harness] copied ${binBase}.exe out of OneDrive-risk zone → ${targetPath}`);
        }
        return targetPath;
      } catch (e: any) {
        console.warn(`[harness] failed to stabilize ${binBase}.exe (${e?.message || e}); using original path`);
        return detected;
      }
    }

    const harnesses: Record<string, any> = {};
    const changes: Array<{ where: string; old: string; new: string }> = [];
    config.defaults = config.defaults || {};
    for (const instancesKey of ['claudeInstances', 'codexInstances', 'grokInstances'] as const) {
      const insts = Array.isArray(config.defaults[instancesKey]) ? config.defaults[instancesKey] : [];
      for (const inst of insts) {
        if (!inst || typeof inst !== 'object') continue;
        const cur = String(inst.configDir || '');
        const next = rewritePlaceholderHome(cur);
        if (next && next !== cur) {
          changes.push({ where: `${instancesKey}[${inst.label || '<unlabeled>'}].configDir`, old: cur, new: next });
          inst.configDir = next;
        }
      }
    }
    for (const t of types) {
      let detected = findBinary(t.bin);
      if (detected) detected = stableizeOnWindows(detected, t.bin);
      harnesses[t.type] = {
        type: t.type,
        label: t.label,
        category: t.category,
        installed: !!detected,
        binaryPath: detected,
        configDirHint: t.configHint,
        configDirExists: dirExists(t.configHint),
      };
      if (!detected) continue;
      // Whether a path lives in a OneDrive-virtualization risk zone —
      // %APPDATA% or any OneDrive-named folder. Used to decide when to
      // override a "still-valid" stored path with the stabilized copy.
      const inRiskZone = (p: string) =>
        IS_WINDOWS &&
        (p.toLowerCase().includes('\\appdata\\') || p.toLowerCase().includes('\\onedrive\\'));

      // Replace defaults.<type>Bin if:
      //   - missing OR points to a file that no longer exists, OR
      //   - currently points into a risk zone but `detected` is the
      //     stabilized copy outside it.
      // Otherwise leave it alone — the user may have intentionally pinned
      // an older version.
      const cur = String(config.defaults[t.configKey] || '');
      const curOk = cur && (() => { try { return fs.statSync(cur).isFile(); } catch (_) { return false; } })();
      const shouldUpdate =
        cur !== detected &&
        (!curOk || (inRiskZone(cur) && !inRiskZone(detected)));
      if (shouldUpdate) {
        changes.push({ where: `defaults.${t.configKey}`, old: cur, new: detected });
        config.defaults[t.configKey] = detected;
      }
      // Same for each instance's per-account override.
      if (t.instancesKey) {
        const insts = Array.isArray(config.defaults[t.instancesKey]) ? config.defaults[t.instancesKey] : [];
        for (const inst of insts) {
          if (!inst || typeof inst !== 'object') continue;
          const cur2 = String(inst[t.configKey] || '');
          const cur2Ok = cur2 && (() => { try { return fs.statSync(cur2).isFile(); } catch (_) { return false; } })();
          const shouldUpdate2 =
            cur2 !== detected &&
            (!cur2Ok || (inRiskZone(cur2) && !inRiskZone(detected)));
          if (shouldUpdate2) {
            const label = String(inst.label || '<unlabeled>');
            changes.push({ where: `${t.instancesKey}[${label}].${t.configKey}`, old: cur2, new: detected });
            inst[t.configKey] = detected;
          }
        }
      }
    }
    if (changes.length) {
      await saveConfig();
      invalidateModelCache();
    }
    return { harnesses, changes };
  }

  // initHarnessAutoFix runs refreshHarnessBins once at boot so a launch
  // immediately after a Claude/Codex auto-update finds the new path
  // without requiring the user to click "Refresh" first. Errors are
  // swallowed — boot must not fail because we couldn't probe a binary.
  // Exported on app so server.ts can call it after route registration.
  (app as any)._initHarnessAutoFix = async () => {
    try {
      const out = await refreshHarnessBins();
      if (out.changes.length) {
        console.log(`[harness] auto-fix on boot: ${out.changes.length} path(s) updated`);
        for (const c of out.changes) {
          console.log(`[harness]   ${c.where}: "${c.old}" → "${c.new}"`);
        }
      }
    } catch (e: any) {
      console.warn('[harness] auto-fix on boot failed:', e?.message || String(e));
    }
  };
}

module.exports = { registerHarnessRoutes };
