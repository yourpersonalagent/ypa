'use strict';

const logger = require('../../core/logger');
const { BRIDGE_INTERNAL_KEY } = require('../../core/state');
const { timingSafeEqualStr } = require('../../core/secure-compare');
const { getModuleApi } = require('../../core/modules');
const { createGroup, getGroup, updateGroup, setPhase, deleteGroup, listGroups } = require('./groups');
const { digestMessage } = require('./digest');
const { PLAN_PREAMBLE, VOTE_PREAMBLE, MOD_DECIDE_PREAMBLE } = require('./prompts');
const { vote: resolveVote, moderatorPick } = require('./decide');

function isInternalAuthorized(req: any): boolean {
  const h = String(req.headers['x-api-key'] || req.headers['authorization'] || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : h;
  return !!BRIDGE_INTERNAL_KEY && !!token && timingSafeEqualStr(token, BRIDGE_INTERNAL_KEY);
}

// ── Turn execution helpers ────────────────────────────────────────────────────

function _buildSlotCtx(slot: any, Model: string) {
  const { activeModels } = require('../../core/state');
  const { getOrCreateStream } = require('../../sessions-internal');
  const stream = getOrCreateStream(slot.sessionId);
  Object.assign(stream, {
    status: 'streaming', chunks: [], blocks: [], text: '',
    cost: 0, error: null, doneAt: null,
  });
  return {
    sessionId: slot.sessionId,
    Model: Model || '',
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
}

// Push the host-session marker that drives the inline MultichatRow.
//
// The host session is the one the user clicked ⊞ multichat from — it gets
// the user's prompt + a `multichat-turn` placeholder per turn, and the
// placeholder carries the slot session ids so the FE can render a row of
// mini-bubbles. Each slot session keeps its own normal user/assistant
// transcript so it stays openable as a standalone chat.
function _pushHostTurnMarker(group: any, Input: string): void {
  const hostSid = String(group.hostSessionId || '');
  if (!hostSid) return;
  const { pushDisplayMsg, displaySessions } = require('../../sessions-internal');
  // pushDisplayMsg is the only public message-push API; we use it for the
  // user prompt and then for the marker (custom role 'multichat-turn').
  pushDisplayMsg(hostSid, 'user', Input);
  const slotInfo = (group.agentSlots || []).map((s: any) => ({
    sessionId: s.sessionId,
    label: s.label || s.id,
    id: s.id,
  }));
  const turnIndex = (group.currentTurn ?? 1) - 1;
  pushDisplayMsg(
    hostSid,
    'multichat-turn',
    '',
    [{ type: 'multichat-row', groupId: group.id, turnIndex, slots: slotInfo }],
    { groupId: group.id, turnIndex }
  );
  // displaySessions reference is imported just to silence the lint that
  // require()'s unused import — leave the reference live.
  void displaySessions;
}

// Push a visible diagnostic into a slot's session when its employee can't be
// resolved (renamed/deleted/module disabled). Without this, the MultichatRow
// MiniBubble shows "(no response)" forever with no hint why.
function _pushSlotUnavailable(slot: any): void {
  const { pushDisplayMsg } = require('../../sessions-internal');
  pushDisplayMsg(
    slot.sessionId,
    'assistant',
    `[agent unavailable: ${slot.id}]\n\nThe employee/partner backing this slot could not be resolved. Likely renamed, deleted, or its module is disabled.`,
    undefined,
    { author: { id: slot.id, name: slot.label || slot.id, role: 'unavailable', symbolColor: '' }, slotUnavailable: true }
  );
}

async function _runDirectTurn(group: any, Input: string, Model: string): Promise<void> {
  const broadcast = getModuleApi('multichat-broadcast');
  const personnel = getModuleApi('multichat-personnel');
  if (!broadcast || !personnel) {
    throw new Error('multichat-group requires multichat-broadcast and multichat-personnel modules');
  }
  const runEmployeeInChain = broadcast.runEmployeeInChain;
  const getEmployee = personnel.getEmployee;

  setPhase(group.id, 'execute');

  // The user prompt + host-session marker are pushed by the /turn route
  // handler synchronously before res.json — don't duplicate them here.

  await Promise.allSettled(
    group.agentSlots.map((slot: any, idx: number) => {
      const emp = getEmployee(slot.id);
      if (!emp) {
        _pushSlotUnavailable(slot);
        return Promise.resolve({ cost: 0, text: '' });
      }
      return runEmployeeInChain(emp, Input, idx, slot.sessionId, _buildSlotCtx(slot, Model));
    })
  );
}

async function _runPlanModeTurn(group: any, Input: string, Model: string): Promise<void> {
  const broadcast = getModuleApi('multichat-broadcast');
  const personnel = getModuleApi('multichat-personnel');
  if (!broadcast || !personnel) {
    throw new Error('multichat-group requires multichat-broadcast and multichat-personnel modules');
  }
  const runEmployeeInChain = broadcast.runEmployeeInChain;
  const getEmployee = personnel.getEmployee;
  const planModel = group.planModel || Model;

  // The user prompt + host-session marker + per-slot user pushes happen
  // synchronously in the /turn route handler before res.json.

  // Phase 1 — PLAN
  setPhase(group.id, 'plan');
  const peerLine = group.agentSlots.map((s: any, i: number) => `Slot ${i}: ${s.id}`).join(', ');
  const planInput = `${PLAN_PREAMBLE}\n\nPeers: ${peerLine}\n\nUser message: ${Input}`;

  const planSettled = await Promise.allSettled(
    group.agentSlots.map(async (slot: any, idx: number) => {
      const emp = getEmployee(slot.id);
      if (!emp) {
        _pushSlotUnavailable(slot);
        return { slotIdx: idx, plan: '', unavailable: true };
      }
      const ctx = _buildSlotCtx(slot, planModel);
      const result = await runEmployeeInChain(emp, planInput, idx, slot.sessionId, ctx);
      const m = (result.text || '').match(/PLAN:\s*([\s\S]+?)(?:CRITIQUE:|$)/i);
      return { slotIdx: idx, plan: m ? m[1].trim() : (result.text || '').slice(0, 400) };
    })
  );
  // Filter unavailable slots out of the plan pool so the vote/moderator pick
  // doesn't see a hole as a valid empty-plan candidate.
  const plans = planSettled
    .filter((r: any) => r.status === 'fulfilled' && !r.value?.unavailable)
    .map((r: any) => r.value);

  // No reachable plans → abort. Without this, the vote path resolves to an
  // empty plan and the execute path runs with a "[Chosen plan]: " preamble
  // and the original input — confusing for the user and wasteful of tokens.
  if (plans.length === 0) {
    const hostSid = String(group.hostSessionId || '');
    if (hostSid) {
      const { pushDisplayMsg } = require('../../sessions-internal');
      pushDisplayMsg(
        hostSid,
        'assistant',
        '[multichat aborted] No agents available to plan this turn — all slot employees/partners failed to resolve. Re-invite or re-create the slot agents and try again.',
        undefined,
        { author: { id: 'system', name: 'multichat', role: 'system', symbolColor: '' }, multichatAborted: true }
      );
    }
    return;
  }

  // Phase 2 — DECIDE
  setPhase(group.id, 'decide');
  let chosenPlan: string;

  if (group.mode === 'mod') {
    const modSlot = group.agentSlots[0];
    const modEmp = getEmployee(modSlot.id);
    if (!modEmp) {
      chosenPlan = plans[0]?.plan || Input;
    } else {
      const modCtx = _buildSlotCtx(modSlot, planModel);
      const modResult = await runEmployeeInChain(modEmp, MOD_DECIDE_PREAMBLE(plans), 0, modSlot.sessionId, modCtx);
      chosenPlan = moderatorPick(modResult.text || '', plans).plan;
    }
  } else {
    // Democratic vote
    const voteInput = VOTE_PREAMBLE(plans);
    const voteSettled = await Promise.allSettled(
      group.agentSlots.map(async (slot: any, idx: number) => {
        const emp = getEmployee(slot.id);
        // Missing employees already had a diagnostic pushed in the plan
        // phase — skip pushing again here; just exclude from the vote.
        if (!emp) return { slotIdx: idx, voteFor: idx, change: null, unavailable: true };
        const ctx = _buildSlotCtx(slot, planModel);
        const r = await runEmployeeInChain(emp, voteInput, idx, slot.sessionId, ctx);
        const vm = (r.text || '').match(/VOTE:\s*(\d+)/i);
        const cm = (r.text || '').match(/CHANGE:\s*(.+?)(?:\n|$)/i);
        return {
          slotIdx: idx,
          voteFor: vm ? parseInt(vm[1], 10) : idx,
          change: cm && cm[1].toLowerCase().trim() !== 'none' ? cm[1].trim() : null,
        };
      })
    );
    const votes = voteSettled
      .filter((r: any) => r.status === 'fulfilled' && !r.value?.unavailable)
      .map((r: any) => r.value);
    chosenPlan = resolveVote(plans, votes).plan;
  }

  // Phase 3 — EXECUTE
  setPhase(group.id, 'execute');
  const executeInput = `[Chosen plan]: ${chosenPlan}\n\n[Original user request]: ${Input}\n\nNow execute this plan.`;

  await Promise.allSettled(
    group.agentSlots.map((slot: any, idx: number) => {
      const emp = getEmployee(slot.id);
      // Diagnostic already pushed in the plan phase for missing employees.
      if (!emp) return Promise.resolve({ cost: 0, text: '' });
      return runEmployeeInChain(emp, executeInput, idx, slot.sessionId, _buildSlotCtx(slot, Model));
    })
  );
}

// ── Route registration ────────────────────────────────────────────────────────

function registerGroupRoutes(app: any): void {
  // POST /v1/multichat/groups — create
  app.post('/v1/multichat/groups', async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const title = typeof body.title === 'string' ? body.title.trim() : 'multichat';
      // Accept new 'vs' literal; tolerate legacy 'each' from older clients by
      // mapping it to 'vs'. 'mod' stays 'mod'. Anything else defaults to 'vs'.
      const mode = body.mode === 'mod' ? 'mod' : 'vs';
      const planMode = body.planMode !== false;
      const agentSlots = Array.isArray(body.agentSlots) ? body.agentSlots : [];
      const workingDir = typeof body.workingDir === 'string' ? body.workingDir.trim() : '';
      const mainSessionId = typeof body.mainSessionId === 'string' ? body.mainSessionId.trim() : '';
      if (!agentSlots.length) {
        return res.status(400).json({ success: false, error: 'agentSlots must be a non-empty array' });
      }
      const group = createGroup({ title, mode, agentSlots, planMode, workingDir, hostSessionId: mainSessionId });
      // Tag the user's host session with this group id so the chat
      // session itself "is" a multichat session — its MessageList renders
      // user prompts followed by inline multichat-row markers (one per
      // turn). Persist so the tag survives a server restart.
      //
      // Use getOrCreateDisplaySession (not displaySessions.get) so we
      // promote a fresh ghost session to a real one on the spot — without
      // this, ⊞ multichat clicked from a not-yet-persisted session would
      // silently fail to tag, the FE would route the next prompt through
      // /v1/stream/ instead of /turn, and the user would see a normal
      // single-bubble response instead of the multichat row.
      if (mainSessionId) {
        const {
          getOrCreateDisplaySession,
          saveSessionToDisk,
        } = require('../../sessions-internal');
        const mainSession = getOrCreateDisplaySession(mainSessionId);
        if (mainSession) {
          mainSession.multichatGroupId = group.id;
          // Match the slot CWD on the host so file-tool resolution is
          // identical across the host bubble and every column.
          if (workingDir) mainSession.workingDir = workingDir;
          try { saveSessionToDisk(mainSessionId); } catch (_) {}
        }
      }
      res.status(201).json({ success: true, group });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // GET /v1/multichat/groups — list
  app.get('/v1/multichat/groups', (_req: any, res: any) => {
    res.json({ success: true, groups: listGroups() });
  });

  // GET /v1/multichat/groups/:id — get
  app.get('/v1/multichat/groups/:gid', (req: any, res: any) => {
    const g = getGroup(req.params.gid);
    if (!g) return res.status(404).json({ success: false, error: 'Group not found' });
    res.json({ success: true, group: g });
  });

  // PATCH /v1/multichat/groups/:id — update
  app.patch('/v1/multichat/groups/:gid', async (req: any, res: any) => {
    const g = getGroup(req.params.gid);
    if (!g) return res.status(404).json({ success: false, error: 'Group not found' });
    const body = req.body || {};
    const patch: any = {};
    if (body.mode === 'vs' || body.mode === 'mod') patch.mode = body.mode;
    // Legacy alias: 'each' (the old name for the parallel-vote mode) maps to 'vs'.
    else if (body.mode === 'each') patch.mode = 'vs';
    if (typeof body.planMode === 'boolean') patch.planMode = body.planMode;
    if (typeof body.title === 'string') patch.title = body.title.trim();
    if (Array.isArray(body.agentSlots)) patch.agentSlots = body.agentSlots;
    const updated = updateGroup(g.id, patch);
    res.json({ success: true, group: updated });
  });

  // POST /v1/multichat/groups/:id/slots — add a slot
  app.post('/v1/multichat/groups/:gid/slots', async (req: any, res: any) => {
    const g = getGroup(req.params.gid);
    if (!g) return res.status(404).json({ success: false, error: 'Group not found' });
    const body = req.body || {};
    const empId = typeof body.id === 'string' ? body.id.trim() : '';
    if (!empId) return res.status(400).json({ success: false, error: 'id required' });
    const { createBackgroundSession } = require('../../sessions-internal');
    const { displaySessions } = require('../../core/state');
    const idx = g.agentSlots.length;
    const ts = Date.now().toString(36);
    const safeEmpId = empId.slice(0, 6).replace(/[^a-z0-9]/gi, '');
    const sessionId = `mc-${g.slug}-${idx}-${safeEmpId}-${ts}`;
    createBackgroundSession(sessionId, `${g.title} · slot ${idx + 1} · ${empId}`);
    const s = displaySessions.get(sessionId);
    if (s) {
      s.multichatGroupId = g.id;
      // Inherit the group's shared working directory so the new slot uses
      // the same CWD as every other column in the grid.
      if (g.workingDir) s.workingDir = g.workingDir;
    }
    const slot = { id: empId, sessionId, label: body.label || empId };
    g.agentSlots.push(slot);
    updateGroup(g.id, { agentSlots: g.agentSlots });
    res.status(201).json({ success: true, slot, group: g });
  });

  // POST /v1/multichat/groups/:id/turn — submit turn
  app.post('/v1/multichat/groups/:gid/turn', async (req: any, res: any) => {
    const g = getGroup(req.params.gid);
    if (!g) return res.status(404).json({ success: false, error: 'Group not found' });
    if (g.phase !== 'idle') {
      return res.status(409).json({ success: false, error: `Group busy (phase=${g.phase})` });
    }
    const Input = typeof req.body?.Input === 'string' ? req.body.Input.trim() : '';
    const Model = typeof req.body?.Model === 'string' ? req.body.Model.trim() : '';
    if (!Input) return res.status(400).json({ success: false, error: 'Input required' });

    const newTurn = g.currentTurn + 1;
    updateGroup(g.id, { currentTurn: newTurn, lastUsed: Date.now() });

    // Push the host-session marker + per-slot user message SYNCHRONOUSLY
    // before responding. Without this, the FE re-fetch of host messages
    // right after /turn returns races against the setImmediate fan-out
    // and sees neither the new prompt nor the multichat-row marker —
    // the user submits and nothing visible happens until the next refresh.
    _pushHostTurnMarker(g, Input);
    {
      const { pushDisplayMsg } = require('../../sessions-internal');
      for (const slot of g.agentSlots) pushDisplayMsg(slot.sessionId, 'user', Input);
    }

    // Respond — client refreshes host session messages to render the
    // new turn row, then watches each slot's SSE for streaming text.
    res.json({
      success: true,
      turn: newTurn,
      sessionIds: g.agentSlots.map((s: any) => s.sessionId),
    });

    // Fan out asynchronously (now skips the user-msg pushes — already done above)
    setImmediate(async () => {
      try {
        if (g.planMode) {
          await _runPlanModeTurn(g, Input, Model);
        } else {
          await _runDirectTurn(g, Input, Model);
        }
      } catch (e) {
        logger.warn('multichat-group.turn-failed', {
          id: g.id,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setPhase(g.id, 'idle');
        updateGroup(g.id, { lastUsed: Date.now() });
      }
    });
  });

  // DELETE /v1/multichat/groups/:id
  app.delete('/v1/multichat/groups/:gid', (req: any, res: any) => {
    const g = getGroup(req.params.gid);
    if (!g) return res.status(404).json({ success: false, error: 'Group not found' });
    const keepSessions = req.query?.keepSessions === 'true';
    deleteGroup(g.id, keepSessions);
    res.json({ success: true });
  });

  // ── Proxy routes for agent-multichat MCP server ───────────────────────────

  // GET /proxy/multichat-agents/groups — read all groups (peers tool)
  app.get('/proxy/multichat-agents/groups', (req: any, res: any) => {
    if (!isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    res.json({ success: true, groups: listGroups() });
  });

  // GET /proxy/multichat-agents/groups/:id — read single group
  app.get('/proxy/multichat-agents/groups/:gid', (req: any, res: any) => {
    if (!isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const g = getGroup(req.params.gid);
    if (!g) return res.status(404).json({ success: false, error: 'Group not found' });
    // For peer_last: include last message digest from each member session
    const { displaySessions } = require('../../core/state');
    const slots = g.agentSlots.map((slot: any) => {
      const session = displaySessions.get(slot.sessionId);
      const msgs = session?.messages || [];
      const lastAssistant = [...msgs].reverse().find((m: any) => m.role === 'assistant');
      const lastText = lastAssistant?.text || (lastAssistant?.blocks?.find((b: any) => b.type === 'text')?.content || '');
      return {
        ...slot,
        status: g.phase,
        lastDigest: digestMessage(lastText),
        lastTokenAt: session?.lastUsed || null,
      };
    });
    res.json({ success: true, group: { ...g, slots } });
  });

  // POST /proxy/multichat-agents/groups/:id/emit-plan — emit plan during plan phase
  app.post('/proxy/multichat-agents/groups/:gid/emit-plan', (req: any, res: any) => {
    if (!isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const g = getGroup(req.params.gid);
    if (!g) return res.status(404).json({ success: false, error: 'Group not found' });
    if (g.phase !== 'plan') {
      return res.status(409).json({ success: false, error: `Not in plan phase (phase=${g.phase})` });
    }
    const body = req.body || {};
    const slotIdx = typeof body.slotIdx === 'number' ? body.slotIdx : -1;
    const plan = typeof body.plan === 'string' ? body.plan.trim() : '';
    if (!plan) return res.status(400).json({ success: false, error: 'plan required' });
    // Store plan in group (overwrite if called twice — last-write-wins)
    if (!g._pendingPlans) g._pendingPlans = {};
    g._pendingPlans[slotIdx] = { slotIdx, plan, ts: Date.now() };
    res.json({ success: true });
  });
}

module.exports = { registerGroupRoutes };
