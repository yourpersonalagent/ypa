// ── Synchronous (--print, JSON output) Claude binary execution ────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const logger = require('../core/logger');

const {
  config,
  CLAUDE_BIN,
  PORT,
  BRIDGE_INTERNAL_KEY,
  activeModels,
  claudeSessions,
} = require('../core/state');
const { saveIndexToDisk, getSessionCwd, getHistory, pushHistory, getHistoryForEmployee, getMaxHistoryTurns, getMaxHistoryChars } = require('../sessions-internal');
const { logRaw } = require('../observability/raw-logs');
const {
  isClaudeModel,
  isSubscriptionModel,
  EFFORT_LEVELS,
  historyModeNotice,
  getInstalledPluginDirs,
  loadAgentsJson,
} = require('./core');

function getNiceness(isInteractive: boolean): string[] {
  return isInteractive ? ['nice', '-n', '0'] : ['nice', '-n', '10'];
}

async function runClaude(
  prompt,
  modelId,
  preset,
  sessionId,
  imageBlocks = [],
  opts: any = {},
  _retryCount = 0
) {
  return new Promise((resolve, reject) => {
    const historySessionId = String(opts.historySessionId || sessionId);
    const args = ['--print', '--output-format', 'json'];
    const hasImages = imageBlocks.length > 0;
    if (hasImages) args.push('--input-format', 'stream-json');

    const { resolveClaudeSubscriptionModel } = require('../models');
    const effectiveModel = resolveClaudeSubscriptionModel(modelId || activeModels.llm.model);
    const isExternal = !isClaudeModel(effectiveModel);

    if (!isExternal && effectiveModel && effectiveModel !== activeModels.llm.model) {
      args.push('--model', effectiveModel);
    }

    if (opts.effort && EFFORT_LEVELS.has(opts.effort)) args.push('--effort', opts.effort);

    if (preset && opts.sysMode === 'replace') {
      args.push('--system-prompt', preset);
    } else if (preset && opts.sysMode === 'append') {
      args.push('--append-system-prompt', preset);
    }

    if (opts.skills?.length) {
      const block = opts.skills
        .map((s) => `## Skill: ${s.name}\n\n${s.content}`)
        .join('\n\n---\n\n');
      args.push('--append-system-prompt', block);
    }

    const cSid = claudeSessions.get(historySessionId);
    if (cSid) args.push('--resume', cSid);

    const originalPrompt = prompt;
    if (!cSid) {
      const priorHistory = opts.selfEmpId
        ? getHistoryForEmployee(sessionId, opts.selfEmpId)
        : getHistory(historySessionId);
      if (priorHistory.length > 0) {
        const maxTurns = getMaxHistoryTurns();
        const maxChars = getMaxHistoryChars();
        const recentTurns = priorHistory.slice(-maxTurns);
        let ctx = recentTurns
          .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
          .join('\n\n');
        if (ctx.length > maxChars) ctx = ctx.slice(-maxChars);
        prompt = `[Previous conversation context:\n${historyModeNotice()}\n${ctx}\n]\n\n${prompt}`;
      }
    }

    const env = { ...process.env };
    if (!env.HOME || env.HOME === '/root') env.HOME = os.homedir();
    if (opts.configDir) {
      env.CLAUDE_CONFIG_DIR = opts.configDir;
      // Override HOME to the parent of `.claude` so any per-user state Claude
      // resolves from $HOME (libsecret, fallback files) stays isolated.
      const { deriveIsolatedHome } = require('../chat/helpers');
      const home = deriveIsolatedHome(opts.configDir, '.claude');
      if (home) env.HOME = home;
      // Dedicated MCP-only file (mcp-bridge.json) written by
      // mcp-internal/materialize.ts on bridge start. The binary's --mcp-config
      // rejects/ignores MCPs in files with non-mcp top-level keys, so we don't
      // point it at settings.json itself.
      const mcpConfigPath = path.join(opts.configDir, 'mcp-bridge.json');
      if (fs.existsSync(mcpConfigPath)) args.push('--mcp-config', mcpConfigPath);
      // In --print mode the binary defaults to MCP_CONNECTION_NONBLOCKING=1,
      // which kicks off MCP child connections async and does NOT wait for them
      // before the first model turn. Result: tools/list is empty when the
      // model assembles its tool catalog. Force blocking so MCP handshake
      // completes before the LLM call.
      env.MCP_CONNECTION_NONBLOCKING = '0';
    }
    const anthropicProvider = config.providers.find((p) => p.name === 'Anthropic');
    const activeProvider =
      opts.modelProvider ||
      (effectiveModel === activeModels.llm.model ? activeModels.llm.provider : undefined);
    if (anthropicProvider?.api_key && !isSubscriptionModel(effectiveModel, activeProvider)) {
      env.ANTHROPIC_API_KEY = anthropicProvider.api_key;
    } else {
      // Prevent any leaked ANTHROPIC_API_KEY in process.env from overriding OAuth for subscription
      delete env.ANTHROPIC_API_KEY;
    }

    if (config.defaults?.dangerously_skip_permissions !== false) {
      args.push('--dangerously-skip-permissions');
    } else {
      logger.warn('claude.perms-not-skipped', { msg: '--dangerously-skip-permissions is disabled — Claude will prompt for permissions' });
    }

    if (isExternal) {
      env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}/proxy/${encodeURIComponent(effectiveModel)}`;
      if (!env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = BRIDGE_INTERNAL_KEY;
      if (opts.sysMode === 'replace') args.push('--bare');
      for (const dir of getInstalledPluginDirs()) args.push('--plugin-dir', dir);
      if (config.defaults?.useAgents !== false) {
        const agentsJson = loadAgentsJson();
        if (Object.keys(agentsJson).length > 0) args.push('--agents', JSON.stringify(agentsJson));
      }
    }

    const sessionCwd = getSessionCwd(sessionId);
    logRaw(
      'model',
      'in',
      {
        prompt,
        modelId: effectiveModel,
        preset,
        imageBlocks,
        opts,
        cwd: sessionCwd,
        args,
      },
      { provider: 'claude-binary', sessionId, stream: false }
    );

    args.push(
      '--append-system-prompt',
      `WORKING DIRECTORY CONSTRAINT: Your current working directory for this session is "${sessionCwd}". ` +
        `You MUST only read, write, create, or delete files inside "${sessionCwd}". ` +
        `Finding a matching file outside this directory via grep, find, or any search tool does NOT give you permission to touch it. ` +
        `If you believe you need to modify a file outside "${sessionCwd}", you MUST stop and ask the user for explicit permission BEFORE taking any action. ` +
        `Never modify files outside "${sessionCwd}" on your own initiative, even if they appear related or similar. ` +
        `When referencing files without absolute paths, always resolve them relative to "${sessionCwd}". ` +
        `OTHER USERS' DATA: This machine may be shared (e.g. family members on a household PC, separate user accounts on the same OS). ` +
        `You MUST NOT read, list, browse, display, summarize, copy, or otherwise expose the contents of directories belonging to other users — ` +
        `this includes sibling home folders, other accounts' working trees, their photos, videos, documents, downloads, mail, browser data, or any personal files — ` +
        `even if the operating system's file permissions would technically allow access. ` +
        `Treat anything outside this working directory as private to someone else unless the user explicitly references that exact path in their request. ` +
        `If a tool result accidentally surfaces such content, do not relay or summarize it; tell the user and stop.`
    );

    const niceArgs = getNiceness(opts.isInteractive);
    const bin = opts.claudeBin || CLAUDE_BIN;
    logger.info('claude.spawn', { bin, args, configDir: opts.configDir, cwd: sessionCwd });
    const proc = spawn(niceArgs[0], [...niceArgs.slice(1), bin, ...args], {
      env,
      cwd: sessionCwd,
    });

    if (hasImages) {
      const content = [];
      if (prompt.trim()) content.push({ type: 'text', text: prompt });
      for (const img of imageBlocks) content.push(img);
      proc.stdin.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n',
        'utf8'
      );
    } else {
      proc.stdin.write(prompt, 'utf8');
    }
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      logRaw('model', 'out', text, {
        provider: 'claude-binary',
        sessionId,
        stream: false,
        stderr: true,
      });
    });

    proc.on('close', (code) => {
      if (
        !stdout.trim() &&
        stderr.includes('No conversation found with session ID') &&
        _retryCount < 1
      ) {
        claudeSessions.delete(historySessionId);
        saveIndexToDisk();
        runClaude(originalPrompt, modelId, preset, sessionId, imageBlocks, opts, _retryCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        logRaw('model', 'out', result, { provider: 'claude-binary', sessionId, stream: false });
        if (result.session_id) {
          claudeSessions.set(historySessionId, result.session_id);
          saveIndexToDisk();
        }
        pushHistory(historySessionId, 'user', originalPrompt);
        pushHistory(historySessionId, 'assistant', result.result || '');
        resolve({
          text: result.result || '',
          cost: result.total_cost_usd || 0,
          tokens: 0,
          toolEvents: [],
        });
      } catch (_) {
        if (stdout.trim()) {
          logRaw('model', 'out', stdout.trim(), {
            provider: 'claude-binary',
            sessionId,
            stream: false,
            rawText: true,
          });
          resolve({ text: stdout.trim(), cost: 0, tokens: 0, toolEvents: [] });
        } else {
          logRaw('model', 'out', stderr.trim() || `claude exited ${code}`, {
            provider: 'claude-binary',
            sessionId,
            stream: false,
            error: true,
          });
          reject(new Error(stderr.trim() || `claude exited ${code}`));
        }
      }
    });

    proc.on('error', (err) => reject(new Error(`Failed to spawn claude: ${err.message}`)));
  });
}

module.exports = {
  getNiceness,
  runClaude,
};
