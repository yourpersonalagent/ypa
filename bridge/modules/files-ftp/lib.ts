// files-ftp module — FTP connection store + directory-mapping management.
// ftp-connections.json : {id, name, host, user, pass, port, ftps, createdAt}[]
// ftp-dirs.json        : {cwd, connectionId, remotePath, createdAt}[]
//
// Data files stay in bridge/ (legacy user state) — code only is moved.
// rclone is used here only as a sync engine for the FTP /v1/ftp/sync route;
// the general /v1/rclone/* surface lives in the sibling files-rclone module.
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');
const ftp  = require('basic-ftp');
const logger = require('../../core/logger');

// Resolve rclone binary — checks PATH and common user-local locations
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

// Data files live at bridge/ftp-{connections,dirs}.json — the legacy user
// state location. From bridge/modules/files-ftp/ that's two levels up.
const CONNECTIONS_FILE = path.join(__dirname, '..', '..', 'ftp-connections.json');
const DIRS_FILE        = path.join(__dirname, '..', '..', 'ftp-dirs.json');

interface FtpConnection {
  id: string;
  name: string;
  host: string;
  user: string;
  pass: string;
  port: number;
  ftps: boolean;
  // 'none' | 'explicit' | 'implicit'  (default: 'none' = plain FTP)
  ftpsMode: string;
  // false = force plain PASV; true (default) = try EPSV first, fall back to PASV
  useEpsv: boolean;
  createdAt: string;
}

interface FtpDirMapping {
  cwd: string;
  connectionId: string;
  remotePath: string;
  createdAt: string;
}

let _connections: FtpConnection[] = [];
let _dirs: FtpDirMapping[] = [];

// ── Persistence ───────────────────────────────────────────────────────────────

function _loadConnections(): void {
  try {
    if (fs.existsSync(CONNECTIONS_FILE))
      _connections = JSON.parse(fs.readFileSync(CONNECTIONS_FILE, 'utf8')) || [];
  } catch (e) {
    logger.warn('ftp.connections.load-failed', { error: (e as Error).message });
    _connections = [];
  }
}

function _saveConnections(): void {
  try {
    fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(_connections, null, 2), 'utf8');
  } catch (e) {
    logger.warn('ftp.connections.save-failed', { error: (e as Error).message });
  }
}

function _loadDirs(): void {
  try {
    if (fs.existsSync(DIRS_FILE))
      _dirs = JSON.parse(fs.readFileSync(DIRS_FILE, 'utf8')) || [];
  } catch (e) {
    logger.warn('ftp.dirs.load-failed', { error: (e as Error).message });
    _dirs = [];
  }
}

function _saveDirs(): void {
  try {
    fs.writeFileSync(DIRS_FILE, JSON.stringify(_dirs, null, 2), 'utf8');
  } catch (e) {
    logger.warn('ftp.dirs.save-failed', { error: (e as Error).message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _slugify(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || `ftp-${Date.now().toString(36)}`;
}

// ── Total Commander wcx_ftp.ini password decryption ───────────────────────────
// TC uses XOR 0xBF + rotate-left-1 on each byte (no master password variant).
function _decryptTcPassword(hexString: string): string {
  if (!hexString) return '';
  try {
    const data = Buffer.from(hexString, 'hex');
    const bytes: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const rotated = ((data[i] >> 1) | (data[i] << 7)) & 0xFF;
      bytes.push(rotated ^ 0xBF);
    }
    return Buffer.from(bytes).toString('latin1').replace(/\0+$/, '');
  } catch {
    return '';
  }
}

// ── .ini parser (subset — avoids external dep) ────────────────────────────────
function _parseWcxFtpIni(iniContent: string): Omit<FtpConnection, 'id' | 'createdAt'>[] {
  const sections: Record<string, Record<string, string>> = {};
  let cur = '';
  for (const raw of iniContent.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { cur = sec[1]; sections[cur] = {}; continue; }
    const eq = line.indexOf('=');
    if (eq > 0 && cur) {
      sections[cur][line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
    }
  }

  const out: Omit<FtpConnection, 'id' | 'createdAt'>[] = [];
  for (const [section, f] of Object.entries(sections)) {
    if (section.toLowerCase() === 'connections' || !f.host) continue;
    out.push({
      name: section,
      host: f.host,
      user: f.username || f.user || 'anonymous',
      pass: _decryptTcPassword(f.password || ''),
      port: parseInt(f.port || '21', 10) || 21,
      ftps: f.secure === '1' || f.ftps === '1',
      ftpsMode: 'explicit',
      useEpsv: false,
    });
  }
  return out;
}

// ── Route registration ────────────────────────────────────────────────────────

function registerFtpRoutes(app: any): void {

  // List connections (password omitted)
  app.get('/v1/ftp/connections', (_req: any, res: any) => {
    res.json({
      success: true,
      connections: _connections.map(({ pass: _p, ...c }) => c),
    });
  });

  // Show full credentials including plaintext password (for import verification)
  app.get('/v1/ftp/connections/:id/credentials', (req: any, res: any) => {
    const conn = _connections.find(c => c.id === req.params.id);
    if (!conn) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, credentials: { id: conn.id, name: conn.name, host: conn.host, user: conn.user, pass: conn.pass, port: conn.port, ftps: conn.ftps, ftpsMode: conn.ftpsMode } });
  });

  // Create connection
  app.post('/v1/ftp/connections', (req: any, res: any) => {
    const { name, host, user, pass, port, ftps, ftpsMode, useEpsv } = req.body || {};
    if (!host || !user)
      return res.status(400).json({ success: false, error: 'host and user required' });

    const id = _slugify(name || host);
    if (_connections.find(c => c.id === id))
      return res.status(409).json({ success: false, error: `Connection '${id}' already exists` });

    const conn: FtpConnection = {
      id, name: name || host, host, user,
      pass: pass || '',
      port: parseInt(port || '21', 10) || 21,
      ftps: !!ftps,
      ftpsMode: ftpsMode || (ftps ? 'explicit' : 'none'),
      useEpsv: useEpsv !== false, // default true
      createdAt: new Date().toISOString(),
    };
    _connections.push(conn);
    _saveConnections();
    const { pass: _p, ...safe } = conn;
    res.json({ success: true, connection: safe });
  });

  // Update connection
  app.put('/v1/ftp/connections/:id', (req: any, res: any) => {
    const conn = _connections.find(c => c.id === req.params.id);
    if (!conn) return res.status(404).json({ success: false, error: 'not found' });
    const { name, host, user, pass, port, ftps, ftpsMode, useEpsv } = req.body || {};
    if (name !== undefined) conn.name = name;
    if (host !== undefined) conn.host = host;
    if (user !== undefined) conn.user = user;
    if (pass !== undefined && pass !== '') conn.pass = pass;
    if (port !== undefined) conn.port = parseInt(port, 10) || conn.port;
    if (ftps !== undefined) conn.ftps = !!ftps;
    if (ftpsMode !== undefined) conn.ftpsMode = ftpsMode;
    if (useEpsv !== undefined) conn.useEpsv = !!useEpsv;
    _saveConnections();
    const { pass: _p, ...safe } = conn;
    res.json({ success: true, connection: safe });
  });

  // Delete connection (also removes dir mappings for it)
  app.delete('/v1/ftp/connections/:id', (req: any, res: any) => {
    const idx = _connections.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'not found' });
    _connections.splice(idx, 1);
    _saveConnections();
    _dirs = _dirs.filter(d => d.connectionId !== req.params.id);
    _saveDirs();
    res.json({ success: true });
  });

  // Check if a cwd has an FTP mapping (used by the button indicator)
  app.get('/v1/ftp/dirs/check', (req: any, res: any) => {
    const cwd = req.query.cwd as string;
    if (!cwd) return res.status(400).json({ success: false, error: 'cwd required' });
    const mapping = _dirs.find(d => d.cwd === cwd);
    if (!mapping) return res.json({ success: true, linked: false });
    const conn = _connections.find(c => c.id === mapping.connectionId);
    res.json({
      success: true, linked: true,
      mapping: {
        cwd: mapping.cwd,
        connectionId: mapping.connectionId,
        remotePath: mapping.remotePath,
        connectionName: conn?.name || mapping.connectionId,
        host: conn?.host || '',
        user: conn?.user || '',
        port: conn?.port || 21,
        ftps: conn?.ftps || false,
        createdAt: mapping.createdAt,
      },
    });
  });

  // List all dir mappings
  app.get('/v1/ftp/dirs', (_req: any, res: any) => {
    res.json({ success: true, dirs: _dirs });
  });

  // Link cwd → connection + remote path (upsert)
  app.post('/v1/ftp/dirs', (req: any, res: any) => {
    const { cwd, connectionId, remotePath } = req.body || {};
    if (!cwd || !connectionId)
      return res.status(400).json({ success: false, error: 'cwd and connectionId required' });
    if (!_connections.find(c => c.id === connectionId))
      return res.status(404).json({ success: false, error: 'connection not found' });

    const mapping: FtpDirMapping = {
      cwd, connectionId,
      remotePath: remotePath || '/',
      createdAt: new Date().toISOString(),
    };
    const existingIdx = _dirs.findIndex(d => d.cwd === cwd);
    if (existingIdx >= 0) _dirs[existingIdx] = mapping; else _dirs.push(mapping);
    _saveDirs();
    res.json({ success: true, mapping });
  });

  // Unlink cwd
  app.delete('/v1/ftp/dirs', (req: any, res: any) => {
    const cwd = (req.body?.cwd || req.query.cwd) as string;
    if (!cwd) return res.status(400).json({ success: false, error: 'cwd required' });
    const idx = _dirs.findIndex(d => d.cwd === cwd);
    if (idx === -1) return res.status(404).json({ success: false, error: 'no mapping for this cwd' });
    _dirs.splice(idx, 1);
    _saveDirs();
    res.json({ success: true });
  });

  // Import Total Commander wcx_ftp.ini content
  app.post('/v1/ftp/import-ini', (req: any, res: any) => {
    const { iniContent } = req.body || {};
    if (!iniContent || typeof iniContent !== 'string')
      return res.status(400).json({ success: false, error: 'iniContent (string) required' });
    try {
      const parsed = _parseWcxFtpIni(iniContent);
      const imported: string[] = [];
      const skipped: string[] = [];
      for (const c of parsed) {
        const id = _slugify(c.name || c.host);
        if (_connections.find(x => x.id === id)) { skipped.push(c.name); continue; }
        _connections.push({ ...c, id, createdAt: new Date().toISOString() });
        imported.push(c.name);
      }
      _saveConnections();
      res.json({ success: true, imported: imported.length, skipped: skipped.length, names: imported });
    } catch (e) {
      res.status(400).json({ success: false, error: (e as Error).message });
    }
  });

  // Sync local dir → FTP using rclone
  // Body: { cwd, mode?: 'sync'|'copy'|'check', dryRun?: boolean }
  // 'sync' = mirror local to remote (deletes remote files not in local)
  // 'copy' = upload new/changed, never delete
  // 'check' = diff only, no transfer
  app.post('/v1/ftp/sync', (req: any, res: any) => {
    const { cwd, mode, dryRun } = req.body || {};
    if (!cwd) return res.status(400).json({ success: false, error: 'cwd required' });

    const mapping = _dirs.find(d => d.cwd === cwd);
    if (!mapping) return res.status(404).json({ success: false, error: 'no FTP mapping for this cwd' });

    const conn = _connections.find(c => c.id === mapping.connectionId);
    if (!conn) return res.status(404).json({ success: false, error: 'connection not found' });

    if (!fs.existsSync(cwd))
      return res.status(400).json({ success: false, error: `Local path not found: ${cwd}` });

    const rclone = _rcloneBin();

    // Obscure password for rclone config
    const obscureResult = spawnSync(rclone, ['obscure', conn.pass], { encoding: 'utf8', timeout: 5000 });
    if (obscureResult.error || obscureResult.status !== 0)
      return res.status(500).json({ success: false, error: 'rclone not available — install it first' });
    const obscuredPass = (obscureResult.stdout || '').trim();

    // Write temp config
    const tmpConfig = path.join(os.tmpdir(), `rclone-yha-${process.pid}-${Date.now()}.conf`);
    const configLines = [
      '[remote]',
      'type = ftp',
      `host = ${conn.host}`,
      `user = ${conn.user}`,
      `pass = ${obscuredPass}`,
      `port = ${conn.port}`,
    ];
    if (conn.ftpsMode === 'explicit') configLines.push('tls = true');
    if (conn.ftpsMode === 'implicit') configLines.push('implicit_tls = true');
    if (!conn.useEpsv) configLines.push('disable_epsv = true');
    fs.writeFileSync(tmpConfig, configLines.join('\n') + '\n', 'utf8');

    const rcloneMode = mode === 'copy' ? 'copy' : mode === 'check' ? 'check' : 'sync';
    const args: string[] = [
      rcloneMode,
      cwd,
      `remote:${mapping.remotePath}`,
      '--config', tmpConfig,
      '--verbose',
      '--stats-one-line',
      '--stats', '0',
    ];
    if (dryRun) args.push('--dry-run');
    if (rcloneMode !== 'check') args.push('--create-empty-src-dirs');

    logger.info('ftp.sync.start', { cwd, remotePath: mapping.remotePath, mode: rcloneMode, dryRun: !!dryRun });

    try {
      const result = spawnSync(rclone, args, { encoding: 'utf8', timeout: 180_000 });
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      const success = result.status === 0;
      logger.info('ftp.sync.done', { success, exitCode: result.status });
      res.json({ success, output, dryRun: !!dryRun, mode: rcloneMode, exitCode: result.status });
    } finally {
      try { fs.unlinkSync(tmpConfig); } catch {}
    }
  });

  // Browse FTP directory — connect, list, disconnect.
  // Body: {connectionId?, host?, user?, pass?, port?, ftps?, path?}
  // connectionId resolves stored credentials; inline fields override or stand alone.
  app.post('/v1/ftp/browse', async (req: any, res: any) => {
    const body = req.body || {};
    let host: string, user: string, pass: string, port: number,
        ftpsMode: string, useEpsv: boolean;

    if (body.connectionId) {
      const conn = _connections.find(c => c.id === body.connectionId);
      if (!conn) return res.status(404).json({ success: false, error: 'connection not found' });
      host     = body.host || conn.host;
      user     = body.user || conn.user;
      pass     = body.pass || conn.pass;
      port     = parseInt(body.port || conn.port, 10) || 21;
      ftpsMode = body.ftpsMode ?? conn.ftpsMode ?? 'none';
      useEpsv  = body.useEpsv !== undefined ? !!body.useEpsv : (conn.useEpsv !== false);
    } else {
      host     = body.host;
      user     = body.user;
      pass     = body.pass || '';
      port     = parseInt(body.port || '21', 10) || 21;
      ftpsMode = body.ftpsMode || 'none';
      useEpsv  = body.useEpsv !== false; // default true (passive like WWW-browser)
    }

    if (!host || !user) return res.status(400).json({ success: false, error: 'host and user required' });

    // Map ftpsMode → basic-ftp secure option
    const secureOpt: false | boolean | 'implicit' =
      ftpsMode === 'implicit' ? 'implicit' :
      ftpsMode === 'explicit' ? true :
      false; // 'none' = plain FTP

    const remotePath: string = body.path || '/';

    // Capture verbose FTP conversation for debugging
    const ftpLog: string[] = [];
    const client = new ftp.Client(30_000);
    client.ftp.verbose = true;
    client.ftp.log = (msg: string) => ftpLog.push(msg);
    // Force IPv4 — avoids issues where hostname resolves to IPv6 but server listens only on IPv4
    client.ftp.ipFamily = 4;

    // Passive mode: basic-ftp uses PASV/EPSV by default (like TC "passive mode like WWW browsers").
    // When useEpsv=false we override prepareTransfer to use plain PASV only (no EPSV).
    if (!useEpsv) {
      // Force plain PASV — no EPSV attempt (compatibility with older servers)
      client.prepareTransfer = ftp.enterPassiveModeIPv4;
    }

    try {
      await client.access({
        host, user, password: pass, port,
        secure: secureOpt,
        secureOptions: secureOpt ? { rejectUnauthorized: false } : undefined,
      });
      await client.cd(remotePath);
      const list = await client.list();

      const items = list.map((e: any) => ({
        name: e.name,
        type: e.isDirectory ? 'dir' : 'file',
        size: e.size,
        modified: e.modifiedAt ? e.modifiedAt.toISOString() : null,
      })).sort((a: any, b: any) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      let canonicalPath = remotePath;
      try { canonicalPath = await client.pwd(); } catch {}
      const parent = canonicalPath === '/' ? null : canonicalPath.replace(/\/[^/]+\/?$/, '') || '/';

      res.json({ success: true, path: canonicalPath, parent, items });
    } catch (e: any) {
      // Return verbose log so the UI can show what went wrong
      res.status(400).json({ success: false, error: e.message || String(e), ftpLog });
    } finally {
      try { client.close(); } catch {}
    }
  });
}


// ── Init ──────────────────────────────────────────────────────────────────────

function initFtp(): void {
  _loadConnections();
  _loadDirs();
  logger.info('ftp.init', { connections: _connections.length, dirs: _dirs.length });
}

module.exports = { registerFtpRoutes, initFtp };
