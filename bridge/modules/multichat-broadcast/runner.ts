// ── Broadcast chain: per-employee streaming with shared chain history ─────────
'use strict';

const { config, activeProcesses } = require('../../core/state');
const {
  broadcastChunk: _broadcastChunkRaw,
  pushDisplayMsg,
  rebuildSessionChatHistory,
  getSessionCwd,
  multiAgentSystemNote,
} = require('../../sessions-internal');
const {
  resolveModelId,
  presetText,
  isGeminiModel,
  isSlashCommand,
  getDefaultSystem,
  splitAllowedToolsByProvider,
  resolveRouteType,
  buildImportantFooter,
} = require('../../providers');
const { buildCwdContextFooterForSession } = require('../../context/cwd');
const { resolveSkills } = require('../../chat/helpers');
// Phase 3: harness functions are looked up in the `harnesses` register
// rather than imported directly. Selection logic (resolveRouteType +
// claudeRuntime config flag) is unchanged.
const { bridgeRegisters } = require('../../core/registers/keys');
function _getHarness(id: string) {
  const entry = bridgeRegisters.harnesses.list().find((h: any) => h.id === id);
  if (!entry) {
    throw new Error(`No harness "${id}" available — check bridge/modules.json`);
  }
  return entry as any;
}

// Run a single employee in a broadcast chain. Streams chunks via stream.text
// accumulator and ctx.broadcast callback, persists the final assistant turn.
//
// ctx fields: sessionId, Model, activeModels, imageBlocks, caps, effort, sysMode,
// skills, configDir, codexConfigDir, stream
async function runEmployeeInChain(emp, empInput, chainIdx, chainHistoryId, ctx) {
  const {
    sessionId,
    Model,
    activeModels,
    imageBlocks,
    caps,
    effort,
    sysMode,
    skills,
    configDir,
    codexConfigDir,
    stream,
    taggedEmpId,
  } = ctx;
  // In parallel ("versus") mode, every chunk must carry an _empId so the
  // frontend can route it to the right per-author segment. Sequential mode
  // doesn't need this — author-on-change is enough.
  const broadcastChunk = taggedEmpId
    ? (sid, chunk) => _broadcastChunkRaw(sid, { ...chunk, _empId: taggedEmpId })
    : _broadcastChunkRaw;

  const empModelId = emp.defaultModel
    ? resolveModelId(emp.defaultModel)
    : resolveModelId(Model || activeModels.llm.model);
  const _basePreset = emp.systemPromptPreset
    ? presetText(emp.systemPromptPreset) || ''
    : getDefaultSystem();
  const _identityNote = multiAgentSystemNote(emp.name || emp.id);
  const _importantFooter = buildImportantFooter();
  const _cwdFooter = buildCwdContextFooterForSession(sessionId);
  let empPreset = _identityNote
    ? (_basePreset ? `${_basePreset}\n\n${_identityNote}` : _identityNote)
    : _basePreset;
  if (_importantFooter) empPreset = empPreset ? `${empPreset}\n\n${_importantFooter}` : _importantFooter;
  if (_cwdFooter) empPreset = empPreset ? `${empPreset}\n\n${_cwdFooter}` : _cwdFooter;
  // Force employee preset to reach the model: providers ignore preset when
  // sysMode is undefined. Default to 'replace' so the persona + identity
  // note actually take effect for each broadcast participant.
  const empSysMode = sysMode || 'replace';
  const empAuthor = { author: { id: emp.id, name: emp.name, role: emp.role, symbolColor: emp.symbolColor || '' } };
  const historySessionId = chainHistoryId || `${sessionId}::each::${chainIdx}::${emp.id}`;
  const empBlocks: any[] = [];
  let empBlockText = '';
  const empToolMap = new Map();

  function flushEmp() {
    if (empBlockText) {
      empBlocks.push({ type: 'text', content: empBlockText });
      empBlockText = '';
    }
  }
  function empChunk(chunk) {
    if (chunk.reasoning) {
      const last = empBlocks[empBlocks.length - 1];
      if (last?.type === 'thinking') last.content += chunk.reasoning;
      else {
        flushEmp();
        empBlocks.push({ type: 'thinking', content: chunk.reasoning });
      }
    }
    if (chunk.text || chunk.delta) {
      const text = chunk.text || chunk.delta;
      empBlockText += text;
      stream.text += text;
    }
    if (chunk.toolUse) {
      if (chunk.toolUse.id) empToolMap.set(chunk.toolUse.id, chunk.toolUse.name);
      flushEmp();
      empBlocks.push({
        type: 'tool-call',
        name: chunk.toolUse.name,
        detail: chunk.toolUse.input || {},
      });
    }
    if (chunk.toolResult) {
      empBlocks.push({
        type: 'tool-result',
        name: empToolMap.get(chunk.toolResult.id) || chunk.toolResult.id,
        detail: chunk.toolResult.content || '',
      });
    }
    broadcastChunk(sessionId, chunk);
  }

  // Partner routing: dispatch to external gateway instead of model stack
  if (emp.partnerType) {
    if (emp.partnerType === 'hermes') {
      const { getModuleApi } = require('../../core/modules');
      const partners = getModuleApi('multichat-partners');
      const gateway = partners?.hermesGateway;
      if (!gateway) {
        throw new Error('multichat-partners module is disabled — partner-Hermes routing unavailable');
      }
      broadcastChunk(sessionId, {
        author: { id: emp.id, name: emp.name, role: emp.role, symbolColor: emp.symbolColor || '' },
        model: 'hermes',
      });
      const _hermesEmpImageBlocks = emp.capVision === 'off' ? [] : imageBlocks;
      const empPartnerId = emp.partnerId || emp.id || '';
      const hermesEmpResult = await gateway.submitPrompt(sessionId, empPartnerId, empInput, (delta) => {
        empBlockText += delta;
        stream.text += delta;
        broadcastChunk(sessionId, { delta, text: delta });
      }, { imageBlocks: _hermesEmpImageBlocks, cwd: getSessionCwd(sessionId) }, 300_000,
      (promptType, promptPayload) => {
        broadcastChunk(sessionId, { hermesPrompt: { type: promptType, partnerId: empPartnerId, ...promptPayload } });
      });
      const finalEmpText = hermesEmpResult.text;
      if (hermesEmpResult.text !== hermesEmpResult.rawText) {
        broadcastChunk(sessionId, { liveTextSet: finalEmpText });
      }
      flushEmp();
      const hasRich = empBlocks.some((b) => b.type !== 'text');
      pushDisplayMsg(
        sessionId,
        'assistant',
        hasRich ? null : finalEmpText,
        hasRich ? empBlocks : undefined,
        { model: 'hermes', ...empAuthor, inputTokens: 0, outputTokens: 0 }
      );
      rebuildSessionChatHistory(sessionId);
      return { cost: 0, text: finalEmpText };
    }
    // Unknown partner type — skip so the chain can continue
    broadcastChunk(sessionId, { error: `Unsupported partner type: ${emp.partnerType}` });
    return { cost: 0, text: '' };
  }

  broadcastChunk(sessionId, {
    author: { id: emp.id, name: emp.name, role: emp.role, symbolColor: emp.symbolColor || '' },
    model: empModelId,
  });

  let empAllowedTools: string[] | undefined =
    emp.toolSetPreset && Array.isArray(config.toolSets?.[emp.toolSetPreset])
      ? [...config.toolSets[emp.toolSetPreset]]
      : undefined;
  if (emp.capTools === 'off') empAllowedTools = [];
  else if (emp.capTools === 'on') empAllowedTools = undefined;
  const empImageBlocks = emp.capVision === 'off' ? [] : imageBlocks;

  // Per-employee skill set overrides the ctx-level skills when the employee
  // has one configured. Without this override, emp.skillSetPreset would be
  // saved by the personnel routes but never actually reach the model.
  let empSkills = skills;
  if (emp.skillSetPreset) {
    try { empSkills = await resolveSkills(emp.skillSetPreset); } catch (_) {}
  }

  function saveEmp(text, info) {
    flushEmp();
    // NOTE: do NOT set stream.blocks here — empBlocks are per-employee and persisted via pushDisplayMsg
    const hasRich = empBlocks.some((b) => b.type !== 'text');
    pushDisplayMsg(
      sessionId,
      'assistant',
      hasRich ? null : text || '',
      hasRich ? empBlocks : undefined,
      {
        model: empModelId,
        ...empAuthor,
        inputTokens: info?.inputTokens || 0,
        outputTokens: info?.outputTokens || 0,
      }
    );
    rebuildSessionChatHistory(sessionId);
    return { ...(info || {}), text: text || '' };
  }

  const anthropicProvider = config.providers.find((p) => p.name === 'Anthropic');
  const empRoute = resolveRouteType(empModelId, emp.defaultModelProvider || undefined, {
    isSlash: isSlashCommand(empInput),
    apiKey: anthropicProvider?.api_key,
    apiMode: config.defaults?.anthropicApiMode,
    claudeRuntime: config.defaults?.claudeRuntime,
  });

  if (empRoute.type === 'codex') {
    return new Promise((resolve, reject) => {
      _getHarness('codex').stream(
        empInput,
        empModelId,
        empPreset,
        sessionId,
        empChunk,
        (info) => resolve(saveEmp(info.text, info)),
        reject,
        {
          sysMode: empSysMode,
          skills: empSkills,
          codexConfigDir,
          historySessionId,
          allowedTools: splitAllowedToolsByProvider(empAllowedTools).codex,
          selfEmpId: emp.id,
        }
      );
    });
  }

  if (empRoute.type === 'external') {
    const ac = new AbortController();
    activeProcesses.set(sessionId, { killFn: () => ac.abort(new Error('stopped')) });
    const extOpts = { historySessionId, selfEmpId: emp.id, ...(empRoute.providerName ? { providerName: empRoute.providerName } : {}) };
    try {
      const _directApi = _getHarness('direct-api');
      // Dispatch on api_style from the resolved route (set by resolveRouteType
      // from the provider's config entry). Falls back to the regex when the
      // route didn't carry one — preserves pre-dynamic-provider behaviour.
      const empStyle = empRoute.api_style || (isGeminiModel(empModelId) ? 'google' : 'openai');
      const result = await (empStyle === 'google'
        ? _directApi.streamGemini(empInput, empModelId, empPreset, sessionId, empImageBlocks, empChunk, ac.signal, caps, extOpts)
        : _directApi.stream(empInput, empModelId, empPreset, sessionId, empImageBlocks, empChunk, ac.signal, caps, extOpts));
      return saveEmp(result.text, result);
    } finally {
      activeProcesses.delete(sessionId);
    }
  }

  if (empRoute.type === 'direct-anthropic') {
    const ac = new AbortController();
    activeProcesses.set(sessionId, { killFn: () => ac.abort(new Error('stopped')) });
    try {
      const result = await _getHarness('direct-api').streamAnthropic(
        empInput,
        empModelId,
        empPreset,
        sessionId,
        empImageBlocks,
        empChunk,
        ac.signal,
        { ...caps, effort },
        { historySessionId, selfEmpId: emp.id }
      );
      return saveEmp(result.text, result);
    } finally {
      activeProcesses.delete(sessionId);
    }
  }

  const empOpts = {
    effort,
    sysMode: empSysMode,
    allowedTools: empAllowedTools,
    yoloPermBypass: config.defaults?.yoloPermissionBypass !== false,
    skills: empSkills,
    configDir,
    historySessionId,
    modelProvider: empRoute.resolvedProvider,
    selfEmpId: emp.id,
  };
  return new Promise((resolve, reject) => {
    _getHarness('claude-binary').stream(
      empInput,
      empModelId,
      empPreset,
      sessionId,
      empChunk,
      (info) => resolve(saveEmp(info.text, info)),
      reject,
      empImageBlocks,
      empOpts
    );
  });
}

module.exports = { runEmployeeInChain };
