// files-rclone module — general /v1/rclone/* surface.
//
// Owns: list/create/delete remotes, browse any remote, sync arbitrary
// local paths to any remote. Split out of bridge/files/ftp.ts when the
// files-* cluster was modularized — the FTP-specific /v1/ftp/sync route
// (which also uses rclone as its sync engine) lives in the sibling
// files-ftp module and keeps its own copy of `_rcloneBin`.
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const logger = require('../../core/logger');

// Resolve rclone binary — checks PATH and common user-local locations.
// Duplicated from files-ftp on purpose so the two modules stay independent.
function _rcloneBin(): string {
  const candidates = [
    'rclone',
    '/home/user/.local/bin/rclone',
    '/usr/local/bin/rclone',
    '/usr/bin/rclone',
  ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) return c;
    } catch {}
  }
  return 'rclone'; // fallback, will fail with a clear error
}

// ── rclone remotes / browse / sync (general) ──────────────────────────────────

function registerRcloneRoutes(app: any): void {

  // GET /v1/rclone/remotes — list all configured rclone remotes with type
  app.get('/v1/rclone/remotes', (_req: any, res: any) => {
    const rclone = _rcloneBin();
    const r = spawnSync(rclone, ['listremotes', '--long'], { encoding: 'utf8', timeout: 8000 });
    if (r.error || r.status !== 0)
      return res.status(500).json({ success: false, error: 'rclone not available or config unreadable' });
    // output format: "remotename:   type\n"
    const remotes = (r.stdout || '').split('\n')
      .filter(Boolean)
      .map(line => {
        const [nameColon, type] = line.split(/\s+/);
        return { name: (nameColon || '').replace(/:$/, ''), type: (type || '').trim() };
      })
      .filter(r => r.name);
    res.json({ success: true, remotes });
  });

  // POST /v1/rclone/browse — list files on any rclone remote
  // Body: { remote, path? }
  app.post('/v1/rclone/browse', (req: any, res: any) => {
    const { remote, path: remotePath } = req.body || {};
    if (!remote) return res.status(400).json({ success: false, error: 'remote required' });
    const rclone = _rcloneBin();
    const target = `${remote}:${remotePath || '/'}`;
    const r = spawnSync(rclone, ['lsjson', target, '--no-modtime'], {
      encoding: 'utf8', timeout: 20_000
    });
    if (r.error) return res.status(500).json({ success: false, error: 'rclone not available' });
    if (r.status !== 0) {
      const err = (r.stderr || r.stdout || 'browse failed').trim();
      return res.status(400).json({ success: false, error: err });
    }
    try {
      const raw = JSON.parse(r.stdout || '[]');
      const items = raw.map((e: any) => ({
        name: e.Name,
        type: e.IsDir ? 'dir' : 'file',
        size: e.Size,
        modified: e.ModTime || null,
      })).sort((a: any, b: any) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      res.json({ success: true, remote, path: remotePath || '/', items });
    } catch (e) {
      res.status(500).json({ success: false, error: 'invalid rclone output' });
    }
  });

  // DELETE /v1/rclone/remotes/:name — delete a rclone remote
  app.delete('/v1/rclone/remotes/:name', (req: any, res: any) => {
    const { name } = req.params;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const rclone = _rcloneBin();
    const r = spawnSync(rclone, ['config', 'delete', name], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0)
      return res.status(500).json({ success: false, error: (r.stderr || 'delete failed').trim() });
    res.json({ success: true, deleted: name });
  });

  // POST /v1/rclone/remotes — create a new rclone remote from config params
  // Body: { name, type, config: { host, user, pass, port, ... } }
  app.post('/v1/rclone/remotes', (req: any, res: any) => {
    const { name, type, config: cfg } = req.body || {};
    if (!name || !type) return res.status(400).json({ success: false, error: 'name and type required' });
    const rclone = _rcloneBin();
    // Obscure password if present
    let obscuredPass = '';
    if (cfg?.pass) {
      const ob = spawnSync(rclone, ['obscure', cfg.pass], { encoding: 'utf8', timeout: 5000 });
      if (ob.error || ob.status !== 0)
        return res.status(500).json({ success: false, error: 'rclone not available' });
      obscuredPass = (ob.stdout || '').trim();
    }
    // Build config args: key=value pairs
    const configArgs: string[] = [];
    for (const [k, v] of Object.entries(cfg || {})) {
      if (k === 'pass') continue; // handled separately
      if (v !== undefined && v !== '') configArgs.push(`${k}=${v}`);
    }
    if (obscuredPass) configArgs.push(`pass=${obscuredPass}`);
    const args = ['config', 'create', name, type, '--non-interactive', ...configArgs];
    const r = spawnSync(rclone, args, { encoding: 'utf8', timeout: 10_000 });
    if (r.error || r.status !== 0)
      return res.status(500).json({ success: false, error: (r.stderr || 'create failed').trim() });
    res.json({ success: true, name, type });
  });

  // POST /v1/rclone/sync — sync any localPath to any rclone remote
  // Body: { localPath, remote, remotePath, mode?, dryRun? }
  app.post('/v1/rclone/sync', (req: any, res: any) => {
    const { localPath, remote, remotePath, mode, dryRun } = req.body || {};
    if (!localPath || !remote)
      return res.status(400).json({ success: false, error: 'localPath and remote required' });
    if (!fs.existsSync(localPath))
      return res.status(400).json({ success: false, error: `Local path not found: ${localPath}` });
    const rclone = _rcloneBin();
    const rcloneMode = mode === 'copy' ? 'copy' : mode === 'check' ? 'check' : 'sync';
    const dest = `${remote}:${remotePath || '/'}`;
    const args: string[] = [
      rcloneMode, localPath, dest,
      '--verbose', '--stats-one-line', '--stats', '0',
    ];
    if (dryRun) args.push('--dry-run');
    if (rcloneMode !== 'check') args.push('--create-empty-src-dirs');
    logger.info('rclone.sync.start', { localPath, dest, mode: rcloneMode, dryRun: !!dryRun });
    const result = spawnSync(rclone, args, { encoding: 'utf8', timeout: 180_000 });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    const success = result.status === 0;
    res.json({ success, output, dryRun: !!dryRun, mode: rcloneMode });
  });
}

module.exports = { registerRcloneRoutes };
