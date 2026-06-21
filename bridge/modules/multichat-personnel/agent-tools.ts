// agent-tools.ts — Proxy routes for the `agent-tools` MCP server.
//
// The MCP server (bridge/mcp/agent-tools-server.js) connects back to the
// bridge over HTTP and uses these routes (auth: BRIDGE_INTERNAL_KEY) to
//   1. list employees + partners that have been published with
//      exposeAsAgent: true, and
//   2. invoke one of them with an input string, getting back the assistant
//      reply as plain text — same one-shot semantics that
//      runEmployeeInChain() already implements for the multichat group
//      runner.
//
// Why a thin proxy + a stdio MCP server (vs. exposing the routes directly)?
// MCP clients like Claude Code / Codex speak stdio JSON-RPC; they can't
// call HTTPS routes. The stdio server is the protocol shim; this file is
// just the HTTP surface it talks to.
'use strict';

const logger = require('../../core/logger');
const { BRIDGE_INTERNAL_KEY } = require('../../core/state');
const { timingSafeEqualStr } = require('../../core/secure-compare');
const { getModuleApi } = require('../../core/modules');

function _isInternalAuthorized(req: any): boolean {
  const h = String(req.headers['x-api-key'] || req.headers['authorization'] || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : h;
  return !!BRIDGE_INTERNAL_KEY && !!token && timingSafeEqualStr(token, BRIDGE_INTERNAL_KEY);
}

// Pull the union of "exposed" agents: published employees + published
// partners. Returns the same agent-shape both kinds use internally so
// the MCP server doesn't have to care which kind a given id is.
function _listExposedAgents(): any[] {
  const out: any[] = [];

  // Employees with exposeAsAgent === true
  try {
    const personnel = getModuleApi('multichat-personnel');
    const allEmps = personnel?.getAllEmployees?.() ?? [];
    for (const e of allEmps) {
      // Skip virtual partner entries — partners are listed separately so
      // their kind is unambiguous to the MCP caller.
      if (e.virtual) continue;
      if (!e.exposeAsAgent) continue;
      out.push({
        id: e.id,
        name: e.name || e.id,
        role: e.role || '',
        kind: 'employee',
        defaultModel: e.defaultModel || '',
        symbolColor: e.symbolColor || '',
      });
    }
  } catch (err) {
    logger.debug('agent-tools.list-emps-failed', { error: (err as Error).message });
  }

  // Partners with exposeAsAgent === true
  try {
    const partners = getModuleApi('multichat-partners');
    const partnerEmps = partners?.getEnabledPartnerEmployees?.() ?? [];
    for (const p of partnerEmps) {
      if (!p.exposeAsAgent) continue;
      out.push({
        id: p.id,
        name: p.name || p.id,
        role: p.role || 'Partner Agent',
        kind: 'partner',
        partnerType: p.partnerType,
        defaultModel: p.partnerPresets?.model || '',
        symbolColor: p.symbolColor || '',
      });
    }
  } catch (err) {
    logger.debug('agent-tools.list-partners-failed', { error: (err as Error).message });
  }

  return out;
}

// One-shot invocation: build a fresh background session, run the
// employee/partner through runEmployeeInChain(), wait for the final
// text, return it. Each call is isolated (its own session id) so
// concurrent agent_call's don't share history.
async function _callAgent(id: string, input: string, model?: string): Promise<{ text: string; cost: number; sessionId: string }> {
  if (!id) throw new Error('id required');
  if (!input || !input.trim()) throw new Error('input required');

  const personnel = getModuleApi('multichat-personnel');
  if (!personnel) throw new Error('multichat-personnel module is not loaded');
  const broadcast = getModuleApi('multichat-broadcast');
  if (!broadcast) throw new Error('multichat-broadcast module is not loaded');

  // Resolve the agent: getEmployee already falls back to partner virtuals.
  const agent = personnel.getEmployee?.(id);
  if (!agent) throw new Error(`Agent '${id}' not found`);

  // Gate: only published agents are callable through this MCP path.
  // Partners come through getEnabledPartnerEmployees with exposeAsAgent
  // copied onto the virtual record; employees carry it natively.
  if (!agent.exposeAsAgent && !agent.virtual) {
    throw new Error(`Agent '${id}' is not exposed via MCP (exposeAsAgent: false)`);
  }
  if (agent.virtual) {
    // For partners, double-check the source of truth in case the cached
    // virtual record was minted from a stale state.
    const partners = getModuleApi('multichat-partners');
    const live = partners?.getEnabledPartnerEmployees?.()?.find((p: any) => p.id === id);
    if (!live?.exposeAsAgent) {
      throw new Error(`Partner '${id}' is not exposed via MCP (exposeAsAgent: false)`);
    }
  }

  // Build a unique throwaway session id for this call. Background
  // sessions don't appear in the picker (no viewedAt) but still flow
  // through pushDisplayMsg + activeStreams the same way the multichat
  // group slots do.
  const sessionId = `mcp-call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionsInternal = require('../../sessions-internal');
  sessionsInternal.createBackgroundSession(sessionId, `MCP call: ${id}`);
  const stream = sessionsInternal.getOrCreateStream(sessionId);
  Object.assign(stream, {
    status: 'streaming',
    chunks: [],
    blocks: [],
    text: '',
    cost: 0,
    error: null,
    doneAt: null,
  });

  const { activeModels } = require('../../core/state');
  const ctx = {
    sessionId,
    Model: model || '',
    activeModels,
    imageBlocks: [],
    caps: {},
    effort: undefined,
    sysMode: undefined,
    skills: [],
    configDir: null,
    codexConfigDir: null,
    stream,
  };

  const result = await broadcast.runEmployeeInChain(agent, input, 0, sessionId, ctx);
  return {
    text: String(result?.text || ''),
    cost: Number(result?.cost || 0),
    sessionId,
  };
}

// Resolve the org library off the loaded module api so this proxy stays
// decoupled from org.ts's own require graph.
function _org(): any {
  const personnel = getModuleApi('multichat-personnel');
  const lib = personnel?.org;
  if (!lib) throw new Error('org registry is not available');
  return lib;
}

function registerAgentToolsRoutes(app: any): void {
  // GET /proxy/agent-tools/agents — list all published agents.
  app.get('/proxy/agent-tools/agents', (req: any, res: any) => {
    if (!_isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    res.json({ success: true, agents: _listExposedAgents() });
  });

  // ── Org-chart management (used by the recruit-team skill via MCP) ──────────
  // GET /proxy/agent-tools/org — read the full department→team tree.
  app.get('/proxy/agent-tools/org', (req: any, res: any) => {
    if (!_isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    try {
      res.json({ success: true, org: _org().getOrg() });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /proxy/agent-tools/org/department — create a department.
  app.post('/proxy/agent-tools/org/department', (req: any, res: any) => {
    if (!_isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    try {
      res.json({ success: true, department: _org().createDepartment(req.body || {}) });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // POST /proxy/agent-tools/org/team — create a team under a department.
  // Body: { department, id?, label, description?, lead?, context?, members? }
  app.post('/proxy/agent-tools/org/team', (req: any, res: any) => {
    if (!_isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body || {};
    const dep = String(body.department || body.dep || '');
    if (!dep) return res.status(400).json({ success: false, error: 'department required' });
    try {
      res.json({ success: true, team: _org().createTeam(dep, body) });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // POST /proxy/agent-tools/org/member — assign an employee to a team.
  // Body: { department, team, employeeId }
  app.post('/proxy/agent-tools/org/member', (req: any, res: any) => {
    if (!_isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body || {};
    const dep = String(body.department || body.dep || '');
    const team = String(body.team || '');
    const emp = String(body.employeeId || body.employee || '');
    if (!dep || !team || !emp) return res.status(400).json({ success: false, error: 'department, team, employeeId required' });
    try {
      res.json({ success: true, team: _org().assignMember(dep, team, emp) });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // PUT /proxy/agent-tools/org — wholesale replace the tree (bulk edits).
  app.put('/proxy/agent-tools/org', (req: any, res: any) => {
    if (!_isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    try {
      res.json({ success: true, org: _org().replaceOrg(req.body?.org ?? req.body ?? {}) });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // POST /proxy/agent-tools/call — invoke one agent and return the reply.
  // Body: { id, input, model? }
  app.post('/proxy/agent-tools/call', async (req: any, res: any) => {
    if (!_isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body || {};
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const input = typeof body.input === 'string' ? body.input : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    if (!input.trim()) return res.status(400).json({ success: false, error: 'input required' });
    try {
      const out = await _callAgent(id, input, model || undefined);
      res.json({ success: true, ...out });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 404 for "not found" / "not exposed" — distinguishable on the
      // MCP side so the caller can re-list. 500 for everything else.
      const code = /not found|not exposed/i.test(msg) ? 404 : 500;
      res.status(code).json({ success: false, error: msg });
    }
  });
}

module.exports = { registerAgentToolsRoutes };
