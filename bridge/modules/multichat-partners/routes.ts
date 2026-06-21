// routes.ts — REST endpoints for external partner agents
// Partners live in bridge/partners.json.  Each entry is one configured instance
// (e.g. "hermes", "openclaw") with name, color, enabled flag, and type-specific config.
'use strict';

const fs = require('fs');
const path = require('path');
const { gateway, isHermesInstalled, getHermesVirtualEmployee } = require('./hermes');
const { getClient, getExistingClient, dropClient } = require('./openclaw');
const logger = require('../../core/logger');
const { writeJsonSync } = require('../../core/state');

// Per-user content (Q16) — routed via bridge/core/paths.ts.
// Falls back to bridge/partners.json + bridge/partners/ pre-migration.
const _paths = require('../../core/paths');
const PARTNERS_FILE = _paths.partners;       // per-user partners.json
const PARTNERS_DIR  = _paths.partnersDir;    // per-user partners/ dir for prompt MDs

// Default Hermes model when a partner record has no explicit value. Free-form
// string — Hermes' /model accepts whatever provider/id the user types.
const DEFAULT_HERMES_MODEL = 'deepseek v4 flash';

function _ensurePartnersDir(): void {
  try { fs.mkdirSync(PARTNERS_DIR, { recursive: true }); } catch (_) {}
}

function _promptFile(id: string): string {
  return path.join(PARTNERS_DIR, `${id}.md`);
}

function _readSystemPrompt(id: string): string {
  try {
    return fs.readFileSync(_promptFile(id), 'utf8');
  } catch {
    return '';
  }
}

function _writeSystemPrompt(id: string, text: string): void {
  _ensurePartnersDir();
  if (text && text.trim()) {
    fs.writeFileSync(_promptFile(id), text, 'utf8');
  } else {
    try { fs.unlinkSync(_promptFile(id)); } catch {}
  }
}

// ── Known adapter types ────────────────────────────────────────────────────────
// `maxInstances` caps how many records of this type can coexist. The Hermes
// gateway is a singleton subprocess but supports many sessions, so multiple
// records (each with its own name/colour) keyed by partnerId behave as
// independent agents in chats. OpenClaw is a remote WS gateway; each record
// can point to a different host/agent.
const KNOWN_TYPES: Array<{ type: string; label: string; defaultColor: string; maxInstances: number; installed: () => boolean; connectionType: 'local' | 'network' }> = [
  {
    type: 'hermes',
    label: 'Hermes',
    defaultColor: '#ff9a3d',
    maxInstances: 5,
    installed: isHermesInstalled,
    connectionType: 'local',
  },
  {
    type: 'openclaw',
    label: 'OpenClaw',
    defaultColor: '#e05c3a',
    maxInstances: 5,
    // OpenClaw runs remotely — always show as available type so users can configure it.
    // Actual connectivity is checked per-record at connect time.
    installed: () => true,
    connectionType: 'network',
  },
];

// ── Persistent partner list ────────────────────────────────────────────────────
interface PartnerRecord {
  id: string;
  type: string;
  name: string;
  symbolColor: string;
  enabled: boolean;
  createdAt: string;
  // Hermes per-instance presets
  model?: string;
  // systemPrompt kept on disk in bridge/partners/<id>.md (runtime mirror only)
  systemPrompt?: string;
  // OpenClaw per-instance config (stored in partners.json)
  host?: string;     // hostname or Tailscale IP of the remote gateway
  port?: number;     // default 18789
  token?: string;    // Bearer token from openclaw.json on the remote machine
  agentId?: string;  // which agent to use (default "main")
  // Published-as-agent flag: when true, this partner shows up in the
  // `agent-tools` MCP server's list_agents output and can be invoked via
  // call_agent by other MCP clients (Claude Code, Codex, API callers).
  exposeAsAgent?: boolean;
}

let _partners: PartnerRecord[] = [];

function _load(): void {
  try {
    if (fs.existsSync(PARTNERS_FILE)) {
      _partners = JSON.parse(fs.readFileSync(PARTNERS_FILE, 'utf8')) || [];
    }
  } catch (e) {
    logger.warn('partners.load-failed', { error: (e as Error).message });
    _partners = [];
  }
}

function _save(): void {
  try {
    writeJsonSync(PARTNERS_FILE, _partners);
  } catch (e) {
    logger.warn('partners.save-failed', { error: (e as Error).message });
  }
}

// ── Runtime status overlay ─────────────────────────────────────────────────────
// Redacts credential fields (token) before returning over HTTP — the FE only
// needs to know whether one is set, not the raw value. Roundtripping the
// bearer to the panel leaks it into every dev-tools Network response body.
function _withStatus(p: PartnerRecord): Omit<PartnerRecord, 'token'> & { installed: boolean; running: boolean; promptFile: string; connectionType: 'local' | 'network'; tokenSet: boolean } {
  const typeDef = KNOWN_TYPES.find((t) => t.type === p.type);
  const installed = typeDef ? typeDef.installed() : false;
  const connectionType = typeDef ? typeDef.connectionType : 'local';
  let running = false;
  if (p.type === 'hermes') {
    running = gateway.isRunning();
  } else if (p.type === 'openclaw') {
    running = getExistingClient(p.id)?.isConnected() ?? false;
  }
  const systemPrompt = _readSystemPrompt(p.id);
  const { token, ...rest } = p;
  return { ...rest, systemPrompt, installed, running, promptFile: _promptFile(p.id), connectionType, tokenSet: !!token };
}

// ── Available types list (for the "Add partner" UI) ───────────────────────────
function _availableTypes() {
  return KNOWN_TYPES.map((t) => {
    const count = _partners.filter((p) => p.type === t.type).length;
    return {
      type: t.type,
      label: t.label,
      defaultColor: t.defaultColor,
      installed: t.installed(),
      maxInstances: t.maxInstances,
      connectionType: t.connectionType,
      count,
      canAdd: count < t.maxInstances,
    };
  });
}

// ── CRUD helpers ───────────────────────────────────────────────────────────────
function _slugify(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || `partner-${Date.now().toString(36)}`;
}

function _create(
  type: string,
  name: string,
  symbolColor: string,
  presets: {
    model?: string;
    systemPrompt?: string;
    // OpenClaw-specific
    host?: string;
    port?: number;
    token?: string;
    agentId?: string;
  } = {},
): PartnerRecord {
  const typeDef = KNOWN_TYPES.find((t) => t.type === type);
  if (!typeDef) throw new Error(`Unknown partner type: ${type}`);

  const sameTypeCount = _partners.filter((p) => p.type === type).length;
  if (sameTypeCount >= typeDef.maxInstances) {
    throw new Error(`max_reached: cap of ${typeDef.maxInstances} reached for type '${type}'`);
  }

  let resolvedName = name;
  if (!resolvedName) {
    resolvedName = sameTypeCount === 0 ? typeDef.label : `${typeDef.label} #${sameTypeCount + 1}`;
  }

  const baseId = _slugify(resolvedName || type);
  let id = baseId;
  let n = 2;
  while (_partners.some((p) => p.id === id)) { id = `${baseId}-${n++}`; }

  const record: PartnerRecord = {
    id,
    type,
    name: resolvedName,
    symbolColor: symbolColor || typeDef.defaultColor,
    enabled: true,
    createdAt: new Date().toISOString(),
    ...(presets.model ? { model: presets.model } : {}),
    // OpenClaw connection config
    ...(type === 'openclaw' ? {
      host: presets.host || '',
      port: presets.port || 18789,
      token: presets.token || '',
      agentId: presets.agentId || 'main',
    } : {}),
  };
  _partners.push(record);
  _save();
  if (presets.systemPrompt !== undefined) _writeSystemPrompt(id, presets.systemPrompt);
  return record;
}

function _update(
  id: string,
  patch: Partial<Pick<PartnerRecord, 'name' | 'symbolColor' | 'enabled' | 'model' | 'systemPrompt' | 'host' | 'port' | 'token' | 'agentId' | 'exposeAsAgent'>>,
): PartnerRecord | null {
  const p = _partners.find((x) => x.id === id);
  if (!p) return null;
  if (patch.name !== undefined) p.name = patch.name;
  if (patch.symbolColor !== undefined) p.symbolColor = patch.symbolColor;
  if (patch.enabled !== undefined) p.enabled = patch.enabled;
  if (patch.model !== undefined) p.model = patch.model || undefined;
  if (patch.exposeAsAgent !== undefined) p.exposeAsAgent = !!patch.exposeAsAgent;
  // OpenClaw connection config
  if (p.type === 'openclaw') {
    if (patch.host !== undefined) p.host = patch.host;
    if (patch.port !== undefined) p.port = patch.port;
    if (patch.token !== undefined) p.token = patch.token;
    if (patch.agentId !== undefined) p.agentId = patch.agentId || 'main';
    // Drop the WS client so it reconnects with the new config on next use
    if (patch.host !== undefined || patch.port !== undefined || patch.token !== undefined || patch.agentId !== undefined) {
      dropClient(id);
    }
  }
  _save();
  if (patch.systemPrompt !== undefined) _writeSystemPrompt(id, patch.systemPrompt);
  return p;
}

function _delete(id: string): boolean {
  const idx = _partners.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  _partners.splice(idx, 1);
  _save();
  return true;
}

// ── Virtual employee for the @-mention system ─────────────────────────────────
// Returns all enabled+installed partner records as virtual employee objects
// so they show up in the @-picker without being stored in the employees dir.
function getEnabledPartnerEmployees(): object[] {
  return _partners
    .filter((p) => {
      if (!p.enabled) return false;
      const typeDef = KNOWN_TYPES.find((t) => t.type === p.type);
      return typeDef ? typeDef.installed() : false;
    })
    .map((p) => ({
      id: p.id,
      name: p.name,
      role: 'Partner Agent',
      fullName: `${p.name} (${p.type})`,
      defaultModel: '',
      fallbackModel: '',
      toolSetPreset: '',
      systemPromptPreset: '',
      symbolColor: p.symbolColor,
      standard: false,
      partnerType: p.type,
      partnerId: p.id,
      partnerPresets: {
        model: p.model || (p.type === 'hermes' ? DEFAULT_HERMES_MODEL : ''),
        systemPrompt: _readSystemPrompt(p.id),
        // OpenClaw connection config forwarded to the chat route
        ...(p.type === 'openclaw' ? {
          host: p.host || '',
          port: p.port || 18789,
          token: p.token || '',
          agentId: p.agentId || 'main',
        } : {}),
      },
      virtual: true,
      exposeAsAgent: p.exposeAsAgent === true,
      createdAt: p.createdAt,
    }));
}

// ── Route registration ─────────────────────────────────────────────────────────
function registerPartnerRoutes(app: any): void {
  // List all configured partners + available types
  app.get('/v1/partners/', (_req: any, res: any) => {
    res.json({
      success: true,
      partners: _partners.map(_withStatus),
      availableTypes: _availableTypes(),
    });
  });

  // Create new partner instance
  app.post('/v1/partners/', (req: any, res: any) => {
    try {
      const { type, name, symbolColor, model, systemPrompt, host, port, token, agentId } = req.body || {};
      if (!type) return res.status(400).json({ success: false, error: 'type required' });
      const p = _create(type, name || '', symbolColor || '', { model, systemPrompt, host, port, token, agentId });
      if (p.enabled && p.type === 'hermes' && !gateway.isRunning() && isHermesInstalled()) {
        gateway.start();
      }
      res.json({ success: true, partner: _withStatus(p) });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith('max_reached')) {
        res.status(409).json({ success: false, error: 'max_reached', detail: msg });
      } else {
        res.status(400).json({ success: false, error: msg });
      }
    }
  });

  // Get single partner
  app.get('/v1/partners/:id', (req: any, res: any) => {
    const p = _partners.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, partner: _withStatus(p) });
  });

  // Update partner (name, color, enabled, model, systemPrompt, and openclaw: host/port/token/agentId)
  app.put('/v1/partners/:id', (req: any, res: any) => {
    const { name, symbolColor, enabled, model, systemPrompt, host, port, token, agentId, exposeAsAgent } = req.body || {};
    const presetsChanged = model !== undefined || systemPrompt !== undefined;
    const p = _update(req.params.id, { name, symbolColor, enabled, model, systemPrompt, host, port, token, agentId, exposeAsAgent });
    if (!p) return res.status(404).json({ success: false, error: 'not found' });

    if (p.type === 'hermes') {
      if (p.enabled && !gateway.isRunning() && isHermesInstalled()) gateway.start();
      else if (!p.enabled && gateway.isRunning()) gateway.stop();
      if (presetsChanged && gateway.isRunning()) {
        gateway.refreshAllForPartner?.(p.id, {
          model: p.model || DEFAULT_HERMES_MODEL,
          systemPrompt: _readSystemPrompt(p.id),
        });
      }
    } else if (p.type === 'openclaw' && !p.enabled) {
      dropClient(p.id);
    }
    res.json({ success: true, partner: _withStatus(p) });
  });

  // Delete partner
  app.delete('/v1/partners/:id', (req: any, res: any) => {
    const p = _partners.find((x) => x.id === req.params.id);
    if (!p || !_delete(req.params.id))
      return res.status(404).json({ success: false, error: 'not found' });
    if (p.type === 'openclaw') dropClient(p.id);
    if (p.type === 'hermes' && typeof gateway?.dropAllSessionsForPartner === 'function') {
      // Sweep the bridge-side sessionMap and tell the Hermes gateway to close
      // every session this partner record owned. Without this the gateway
      // sessions linger until next gateway restart and bridge memory keeps
      // the (now-dangling) sessionMap entries alive.
      const closed = gateway.dropAllSessionsForPartner(p.id);
      if (closed > 0) logger.info('hermes.partner-deleted-cleanup', { partnerId: p.id, sessionsClosed: closed });
    }
    res.json({ success: true });
  });

  // Connect (start gateway process / open WS connection)
  app.post('/v1/partners/:id/connect', (req: any, res: any) => {
    const p = _partners.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ success: false, error: 'not found' });
    const typeDef = KNOWN_TYPES.find((t) => t.type === p.type);
    if (!typeDef?.installed()) return res.status(400).json({ success: false, error: 'not installed' });

    if (p.type === 'hermes') {
      if (gateway.isRunning()) return res.json({ success: true, message: 'already running', running: true });
      gateway.start();
    } else if (p.type === 'openclaw') {
      if (!p.host) return res.status(400).json({ success: false, error: 'host not configured' });
      const client = getClient(p.id, p.host, p.port || 18789, p.token || '', p.agentId || 'main');
      if (client.isConnected()) return res.json({ success: true, message: 'already connected', running: true });
      client.connect();
    }
    res.json({ success: true, running: true });
  });

  // Disconnect (stop gateway process / close WS connection)
  app.post('/v1/partners/:id/disconnect', (req: any, res: any) => {
    const p = _partners.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ success: false, error: 'not found' });
    if (p.type === 'hermes') gateway.stop();
    else if (p.type === 'openclaw') dropClient(p.id);
    res.json({ success: true, running: false });
  });

  // List agents available on an OpenClaw gateway (for the "Add partner" UI)
  app.get('/v1/partners/openclaw/agents', async (req: any, res: any) => {
    const { host, port, token } = req.query as Record<string, string>;
    if (!host) return res.status(400).json({ success: false, error: 'host required' });
    // Use a temporary client — do not store it in the pool
    const { OpenClawClient } = require('./openclaw');  // eslint-disable-line @typescript-eslint/no-var-requires
    const tmpClient = new OpenClawClient(host, parseInt(port || '18789', 10), token || '', 'main');
    tmpClient.connect();
    try {
      const agents = await tmpClient.listAgents();
      res.json({ success: true, agents });
    } catch (e) {
      res.status(502).json({ success: false, error: (e as Error).message });
    } finally {
      tmpClient.disconnect();
    }
  });

  // Respond to a Hermes blocking prompt (approval, clarify, sudo, secret)
  app.post('/v1/partners/hermes/prompt-respond', async (req: any, res: any) => {
    const { sessionId, partnerId, type, ...params } = req.body || {};
    if (!sessionId || !type) return res.status(400).json({ success: false, error: 'sessionId and type required' });
    try {
      const result = await gateway.respondToPrompt(sessionId, partnerId || '', type, params);
      res.json({ success: true, result });
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  });
}

// ── Init ───────────────────────────────────────────────────────────────────────
function initPartners(): void {
  _load();
  _ensurePartnersDir();

  // Auto-start gateway for any enabled+installed partner
  for (const p of _partners) {
    if (!p.enabled) continue;
    if (p.type === 'hermes' && isHermesInstalled()) {
      logger.info('partners.auto-start', { id: p.id, type: p.type });
      gateway.start();
      break; // gateway is a singleton; one start() is enough
    }
  }

  if (_partners.length === 0) {
    logger.info('partners.init', { count: 0, note: 'no partners configured yet' });
  }
}

module.exports = {
  registerPartnerRoutes,
  initPartners,
  getEnabledPartnerEmployees,
};
