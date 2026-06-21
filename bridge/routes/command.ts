// ── /v1/command/ route — non-streaming synchronous prompt execution ───────────
'use strict';

const { activeModels } = require('../core/state');
const { extractImageBlocks, pushDisplayMsg } = require('../sessions-internal');
const {
  handleSpecial,
  resolveModelId,
  isClaudeModel,
} = require('../providers');
const { dispatchExec } = require('../tools');
// Phase 3: harness functions are looked up in the `harnesses` register
// (see bridge/core/bootstrap-harnesses.ts) instead of imported directly.
const { bridgeRegisters } = require('../core/registers/keys');
function _getHarness(id: string) {
  const entry = bridgeRegisters.harnesses.list().find((h: any) => h.id === id);
  if (!entry) {
    throw new Error(`No harness "${id}" available — check bridge/modules.json`);
  }
  return entry as any;
}
const { logRaw } = require('../observability/raw-logs');
const logger = require('../core/logger');
const {
  sanitizeAndValidateChatBody,
  appendImageAttachments,
  resolveClaudeConfigDir,
  resolveCodexConfigDir,
  resolveSkills,
  resolveActiveChatSkills,
} = require('../chat/helpers');
const { presetText, getDefaultSystem, EFFORT_LEVELS, buildImportantFooter } = require('../providers');
const { buildCwdContextFooterForSession } = require('../context/cwd');

function registerCommandRoute(app) {
  app.post('/v1/command/', async (req, res) => {
    const validation = sanitizeAndValidateChatBody(req.body, '/v1/command/');
    if (!validation.ok) {
      logRaw('model', 'in', { error: validation.error }, { route: '/v1/command/' });
      return res.status(400).json({ success: false, error: validation.error });
    }
    const {
      Input, Model, Preset, Presets, SessionId, Attachments, Effort, SystemMode, SkillSet,
      HarnessInstance, CodexInstance,
    } = validation.sanitized;
    logRaw('model', 'in', req.body, { route: '/v1/command/' });
    let input = Input;
    const sessionId = SessionId;

    // `await` here is intentionally tolerant of sync returns. Most cases
    // (e.g. /clear, #m switches) return a plain object; /rewind returns a
    // Promise because it waits for in-flight tool calls to finish first.
    const special = await handleSpecial(input, sessionId);
    if (special.handled) {
      return res.json({ success: true, response: special.response, chatHistory: special.chatHistory });
    }

    const userCmdDisplayText = input;
    const { cleanText, imageBlocks } = await extractImageBlocks(input);
    input = cleanText;
    appendImageAttachments(imageBlocks, Attachments);

    const modelId = resolveModelId(Model || activeModels.llm.model);
    const resolvedPreset = Array.isArray(Presets) && Presets.length
      ? Presets.map((p) => presetText(p)).filter((p) => String(p).trim()).join('\n\n')
      : presetText(Preset);
    let preset = resolvedPreset || getDefaultSystem();
    const effort = EFFORT_LEVELS.has(Effort) ? Effort : undefined;
    const sysMode = SystemMode === 'replace' || SystemMode === 'append' ? SystemMode : undefined;
    let externalPreset =
      sysMode === 'append' && resolvedPreset
        ? `${getDefaultSystem()}\n\n${resolvedPreset}`
        : preset;
    const _importantFooter = buildImportantFooter();
    const _cwdFooter = buildCwdContextFooterForSession(sessionId);
    if (_importantFooter) {
      preset = preset ? `${preset}\n\n${_importantFooter}` : _importantFooter;
      externalPreset = externalPreset ? `${externalPreset}\n\n${_importantFooter}` : _importantFooter;
    }
    if (_cwdFooter) {
      preset = preset ? `${preset}\n\n${_cwdFooter}` : _cwdFooter;
      externalPreset = externalPreset ? `${externalPreset}\n\n${_cwdFooter}` : _cwdFooter;
    }
    // SkillSet provided (workflow node / broadcast / employee override) →
    // resolve that explicitly. Otherwise fall to the chat-default rule:
    // any "active-in-chat" sets win; if none, all mounted skills load.
    const skills = SkillSet
      ? await resolveSkills(SkillSet)
      : await resolveActiveChatSkills();
    const configDir = resolveClaudeConfigDir(HarnessInstance);
    const codexConfigDir = resolveCodexConfigDir(CodexInstance);

    logger.info('cmd.dispatch', {
      model: Model, resolved: modelId, effort: effort || '-',
      sys: sysMode || 'off', skills: skills.length, images: imageBlocks.length,
      input: input.slice(0, 40),
    });

    try {
      const useSdk = require('../core/state').config.defaults?.claudeRuntime === 'sdk';
      const claudeOpts = { effort, sysMode, skills, configDir, codexConfigDir };
      const _claudeHarness = _getHarness(useSdk ? 'claude-sdk' : 'claude-binary');
      const result = isClaudeModel(modelId)
        ? await _claudeHarness.run(input, modelId, preset, sessionId, imageBlocks, claudeOpts)
        : (useSdk
            ? await _claudeHarness.run(input, modelId, externalPreset || preset, sessionId, imageBlocks, claudeOpts)
            : await dispatchExec(input, modelId, externalPreset, sessionId, null));
      pushDisplayMsg(sessionId, 'user', userCmdDisplayText);
      pushDisplayMsg(sessionId, 'assistant', result.text);
      res.json({
        success: true,
        response: result.text,
        chatHistory: [result.text],
        totalTokens: result.tokens || 0,
        cost: result.cost || 0,
      });
      logRaw('model', 'out', result, { route: '/v1/command/', modelId, sessionId });
    } catch (e) {
      logger.error('cmd.error', { error: e instanceof Error ? e.message : String(e) });
      logRaw('model', 'out', e.message, { route: '/v1/command/', modelId, sessionId, error: true });
      res.json({ success: false, errorMessage: e.message });
    }
  });
}

module.exports = { registerCommandRoute };
