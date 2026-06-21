// ── /v1/config/link/* — LINK (Obsidian Sync) routes ──────────────────────────
// Phase 3.1d of the ContextGenerator pipeline.
//
//   GET  /v1/config/link/status      — full status snapshot (no secrets)
//   POST /v1/config/link/run-now     — manual sync trigger
//   POST /v1/config/link/secrets     — write API key (body: {key, value})
//   POST /v1/config/link/test-ping   — adapter ping without running the loop
//
// Configuration (enabled, adapter, baseUrl, vaultRoot, syncDirs, conflictPolicy,
// syncSensitivity) lives in `config.json defaults.contextLink` and is edited
// via the standard `/v1/config` PATCH endpoint — we deliberately do NOT add
// a separate config-write endpoint here so the existing config-history /
// audit-trail captures LINK changes too.
//
// The `/secrets` endpoint is the ONE exception — API keys are stored in
// `bridge/secrets/contextLink.json` (chmod 600) outside the standard config
// flow so they never end up in config-history backups or Settings exports.
'use strict';

function registerLinkRoutes(app): void {
  // The LINK sync engine lives next to this file under ./vault/sync.ts.
  // Phase-2 batch F (`context-generator` move-out) brought the worker
  // into the link module so it shares this module's lifecycle; the
  // sorter chains in via cross-module require (see sorter/runner.ts).
  const link = require('./vault/sync');

  // ── GET /v1/config/link/status ───────────────────────────────────────────
  // Cheap, sync — read-only snapshot. Frontend polls this for the LINK card.
  app.get('/v1/config/link/status', (_req, res) => {
    try {
      res.json({ ok: true, ...link.getLinkStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // ── POST /v1/config/link/run-now ─────────────────────────────────────────
  // User-initiated kick. Bypasses the push-side rate limit. Returns immediately;
  // progress is surfaced via SSE `link:synced`.
  app.post('/v1/config/link/run-now', (_req, res) => {
    try {
      const r = link.runNow();
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // ── POST /v1/config/link/secrets ─────────────────────────────────────────
  // Body: { key: 'obsidianApiKey', value: '<the-key>' } — value can be empty
  // to clear the secret. Server never echoes the value back; subsequent
  // /status calls report the masked fingerprint.
  app.post('/v1/config/link/secrets', (req, res) => {
    const key = String(req.body?.key || '').trim();
    const value = typeof req.body?.value === 'string' ? req.body.value : '';
    // Allowlist — never let a caller name an arbitrary key (defence against
    // the secrets file becoming a kitchen sink).
    const ALLOWED = ['obsidianApiKey'];
    if (!ALLOWED.includes(key)) {
      return res.status(400).json({ ok: false, error: 'unknown secret key' });
    }
    try {
      link.writeLinkSecret(key, value);
      res.json({ ok: true, masked: link.maskedLinkSecret(key) });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // ── POST /v1/config/link/test-ping ───────────────────────────────────────
  // Performs a *live* probe against the currently-configured adapter and
  // returns the result. Used by the LINK configuration UI right after the
  // user changes adapter / host / vaultRoot or pastes an API key, so they
  // get immediate "reachable / not reachable" feedback without waiting for
  // the next 5-minute watchdog tick. Side-effect: also refreshes the
  // cached ping that powers `/status` so the dashboard updates in lockstep.
  app.post('/v1/config/link/test-ping', async (_req, res) => {
    try {
      const probe = await link.pingAdapterNow();
      res.json({
        ok:        true,
        reachable: probe.ok,
        error:     probe.error || null,
        checkedAt: probe.at,
        adapter:   probe.kind,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // ── POST /v1/config/link/import-vault-folder ─────────────────────────────
  // Phase 3.4d — one-shot scoop of an arbitrary vault folder (typically the
  // Google-Keep-Importer plugin's output) into a server-side category
  // directory (default `docs/keep-notes/`). Hands off to
  // `link.importVaultFolder()` which takes care of:
  //   • adapter validation + ping
  //   • listing markdown files under the vault folder
  //   • writing them to the server with `sensitivity:` + `category:`
  //     frontmatter so the Picker / Sorter / sensitivity-filter pick them up
  //   • seeding `link-state.json` so the next watchdog tick doesn't re-push
  //   • persisting the syncDirs override into `defaults.contextLink.syncDirs`
  //     so the watchdog keeps the folder in sync going forward
  //   • triggering an immediate sync so any since-imported vault-side edits
  //     land before the user closes the modal
  //
  // Body: {
  //   vaultPath:    string            // required — e.g. "Google Keep"
  //   serverDir?:   string            // default 'docs/keep-notes'
  //   category?:    string            // default 'keep-notes'
  //   sensitivity?: 'public'|'private' // default 'public'
  //   dryRun?:      boolean            // when true, list-only (preview)
  //   startSync?:   boolean            // when false, skip the syncDirs persist
  // }
  //
  // Response: { ok, vaultPath, serverDir, imported, skipped, errors, total,
  //             syncStarted?, files? (dry-run only, capped at 500) }
  app.post('/v1/config/link/import-vault-folder', async (req, res) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const r = await link.importVaultFolder({
        vaultPath:   typeof body.vaultPath   === 'string' ? body.vaultPath   : '',
        serverDir:   typeof body.serverDir   === 'string' ? body.serverDir   : undefined,
        category:    typeof body.category    === 'string' ? body.category    : undefined,
        sensitivity: body.sensitivity === 'private' ? 'private' : 'public',
        dryRun:      body.dryRun === true,
        startSync:   body.startSync !== false,
      });
      // Distinguish "user error" (4xx — bad input, adapter not configured)
      // from "server error" (500 — exception during import). The lib returns
      // ok:false with a human-readable error in both cases; we map well-known
      // input errors to 400 so the UI can show them inline.
      if (!r.ok) {
        const userInput = /required|may only contain|must look like|disabled|configured|Mock adapter/.test(r.error || '');
        return res.status(userInput ? 400 : 502).json(r);
      }
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });
}

module.exports = { registerLinkRoutes };
