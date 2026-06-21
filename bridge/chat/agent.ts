// Claude Agent SDK adapter — alternative execution path to providers/claude.ts.
//
// Why: the legacy spawn path uses `claude --print`, which kicks off MCP server
// connections asynchronously and proceeds without them after a 5s budget.
// Result: native mcp__* tools are invisible to the model on every bridge turn.
//
// The SDK manages the binary as a long-lived agentic session and waits for MCP
// readiness before the first turn — so MCPs work natively. Bonus: also works
// for non-Anthropic models (DeepSeek, OpenAI, Gemini) that go through the
// bridge's /proxy/:externalModel translation route, because the SDK still
// honors ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY in env.
//
// Currently a parallel path. Gated by config.defaults.claudeRuntime === 'sdk'.
// Once verified end-to-end, the goal is to delete the legacy spawn code.
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const logger = require('../core/logger');
const { CLAUDE_BIN, BRIDGE_INTERNAL_KEY, PORT, config, activeModels } = require('../core/state');
const { isClaudeModel, isSubscriptionModel } = require('../providers');
const { getSessionCwd, getHistory, pushHistory, getHistoryForEmployee, getMaxHistoryTurns, getMaxHistoryChars } = require('../sessions-internal');
const { logRaw } = require('../observability/raw-logs');

// Single-entry MCP config: every SDK-spawned Claude session loads ONLY the
// yha-bridge stub, which forwards JSON-RPC over HTTP to this same YHA process.
// That way the spawned agent reuses YHA's already-running upstream MCP
// connections instead of double-spawning its own copies.
const BRIDGE_STUB = path.join(__dirname, 'mcp', 'yha-bridge-stub.js');

function loadMcpServers(sessionId?: string): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  const env: Record<string, string> = { YHA_BRIDGE_URL: `http://127.0.0.1:${PORT}` };
  if (sessionId) env.YHA_SESSION_ID = sessionId;
  return {
    'MCP-Tools': {
      command: process.execPath,
      args: [BRIDGE_STUB],
      env,
    },
  };
}

// Lazy ESM dynamic import of the SDK (bridge is CJS, SDK is ESM).
let _sdkPromise: Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null = null;
function getSdk() {
  if (!_sdkPromise) _sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return _sdkPromise;
}

interface RunOpts {
  effort?: string;
  sysMode?: 'replace' | 'append';
  skills?: Array<{ name: string; content: string }>;
  configDir?: string;
  claudeBin?: string;
  historySessionId?: string;
  modelProvider?: string;
  selfEmpId?: string;
}

interface RunResult {
  text: string;
  tokens?: number;
  cost?: number;
  sessionId?: string;
}

export async function runClaudeViaSdk(
  prompt: string,
  modelId: string,
  preset: string,
  sessionId: string,
  imageBlocks: any[] = [],
  opts: RunOpts = {}
): Promise<RunResult> {
  const { query } = await getSdk();

  const effectiveModel = modelId || activeModels.llm.model;
  const isExternal = !isClaudeModel(effectiveModel);
  const sessionCwd = getSessionCwd(sessionId);

  // Build env: subscription path uses OAuth (no API key), proxy path uses
  // bridge-internal key so the binary's calls hit /proxy/:externalModel.
  // Inherit YHA's env (PATH, HOME, USER, …) so the spawned Bash tool can find
  // /usr/bin/python3, ~/.hermes/.../gws, etc. — a fresh empty env strips PATH
  // and breaks every shell command the agent tries to run.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts.configDir) {
    env.CLAUDE_CONFIG_DIR = opts.configDir;
    // Override HOME so any path Claude derives from $HOME (XDG dirs, fallback
    // credential files, libsecret per-user state) lands inside this instance's
    // isolated tree — multiple subscriptions otherwise overwrite each other.
    const { deriveIsolatedHome } = require('./helpers');
    const home = deriveIsolatedHome(opts.configDir, '.claude');
    if (home) env.HOME = home;
  }
  if (isExternal) {
    env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}/proxy/${encodeURIComponent(effectiveModel)}`;
    env.ANTHROPIC_API_KEY = BRIDGE_INTERNAL_KEY;
  } else {
    // Honor ANTHROPIC_API_KEY only when not a subscription model.
    const anthropicProvider = config.providers.find((p: any) => p.name === 'Anthropic');
    if (anthropicProvider?.api_key && !isSubscriptionModel(effectiveModel, opts.modelProvider)) {
      env.ANTHROPIC_API_KEY = anthropicProvider.api_key;
    } else {
      // Prevent any leaked ANTHROPIC_API_KEY in process.env from overriding OAuth for subscription
      delete env.ANTHROPIC_API_KEY;
    }
  }

  // Compose system prompt from preset + skills (mirrors legacy runClaude).
  let systemPrompt: string | { type: 'preset'; preset: 'claude_code'; append?: string } | undefined;
  const skillsBlock = opts.skills?.length
    ? opts.skills.map((s) => `## Skill: ${s.name}\n\n${s.content}`).join('\n\n---\n\n')
    : '';
  if (preset && opts.sysMode === 'replace') {
    systemPrompt = preset
      + (skillsBlock ? '\n\n' + skillsBlock : '');
  } else {
    const append = [
      preset && opts.sysMode === 'append' ? preset : '',
      skillsBlock,
    ]
      .filter(Boolean)
      .join('\n\n');
    if (append) {
      systemPrompt = { type: 'preset', preset: 'claude_code', append };
    }
  }

  // Prepend prior history for the first turn of a new session, mirroring legacy behavior.
  let composedPrompt = prompt;
  const historySessionId = String(opts.historySessionId || sessionId);
  const priorHistory = opts.selfEmpId
    ? getHistoryForEmployee(sessionId, opts.selfEmpId)
    : getHistory(historySessionId);
  if (priorHistory.length > 0) {
    const maxTurns = getMaxHistoryTurns();
    const maxChars = getMaxHistoryChars();
    const recentTurns = priorHistory.slice(-maxTurns);
    let ctx = recentTurns
      .map((m: any) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    if (ctx.length > maxChars) ctx = ctx.slice(-maxChars);
    composedPrompt = `[Previous conversation context:\n${ctx}\n]\n\n${prompt}`;
  }

  logger.info('claude-agent-sdk.query', {
    model: effectiveModel,
    isExternal,
    cwd: sessionCwd,
    configDir: opts.configDir,
    promptLen: composedPrompt.length,
  });
  logRaw('model', 'in', { prompt: composedPrompt, modelId: effectiveModel, route: 'sdk', sessionId }, {});

  const ac = new AbortController();
  const mcpServers = loadMcpServers(sessionId);
  const q = query({
    prompt: composedPrompt,
    options: {
      cwd: sessionCwd,
      model: effectiveModel,
      pathToClaudeCodeExecutable: opts.claudeBin || CLAUDE_BIN,
      env,
      systemPrompt,
      effort: opts.effort as any,
      permissionMode: 'bypassPermissions' as any,
      allowDangerouslySkipPermissions: true,
      mcpServers: Object.keys(mcpServers).length ? mcpServers : undefined,
      // The built-in AskUserQuestion has no IPC path back from this harness,
      // so the model would emit it and the turn would dead-end. We replace it
      // with mcp__MCP-Tools__bridge__AskUser (same schema), which routes
      // through SSE to the chat UI and returns the answer as a tool_result.
      disallowedTools: ['AskUserQuestion'],
      abortController: ac,
    },
  });

  let assembledText = '';
  let result: RunResult = { text: '' };

  try {
    for await (const msg of q) {
      // Capture assistant text deltas as they arrive.
      if ((msg as any).type === 'assistant') {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              assembledText += block.text;
            }
          }
        }
      }
      if ((msg as any).type === 'result') {
        // Final result message — use its `result` text if present, else what we assembled.
        const r = msg as any;
        result = {
          text: typeof r.result === 'string' && r.result ? r.result : assembledText,
          tokens: r.usage?.input_tokens != null && r.usage?.output_tokens != null
            ? r.usage.input_tokens + r.usage.output_tokens : undefined,
          cost: r.total_cost_usd,
          sessionId: r.session_id,
        };
      }
    }
  } catch (e) {
    logger.error('claude-agent-sdk.error', { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  if (!result.text && assembledText) result.text = assembledText;
  logRaw('model', 'out', result, { route: 'sdk', modelId: effectiveModel, sessionId });
  // Persist this exchange to chatHistory. The SDK path doesn't use --resume,
  // so the only way the next turn gets prior context is via the explicit
  // priorHistory injection above — which reads chatHistory. If we don't push,
  // every turn starts blind. (Other provider paths push in their finalizers.)
  try {
    pushHistory(historySessionId, 'user', prompt);
    if (result.text) pushHistory(historySessionId, 'assistant', result.text);
  } catch (_) {}
  return result;
}

// Streaming variant — same callback interface as the legacy streamClaude so the
// /v1/stream/ route can swap it in without restructuring its finalize/error logic.
// The SDK yields complete turns (one assistant message per LLM response), so text
// appears per-turn rather than per-token, but tool calls and results are emitted
// incrementally as the agentic loop progresses.
export function streamClaudeViaSdk(
  prompt: string,
  modelId: string,
  preset: string,
  sessionId: string,
  onChunk: (chunk: any) => void,
  onDone: (info: { text: string; cost?: number; stopReason?: string; inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number }) => void,
  onError: (err: Error) => void,
  imageBlocks: any[] = [],
  opts: RunOpts = {}
): void {
  (async () => {
    const { query } = await getSdk();

    const effectiveModel = modelId || activeModels.llm.model;
    const isExternal = !isClaudeModel(effectiveModel);
    const sessionCwd = getSessionCwd(sessionId);

    // Inherit YHA's env (PATH, HOME, USER, …) so the spawned Bash tool can find
    // /usr/bin/python3, ~/.hermes/.../gws, and friends — building a fresh empty
    // env strips PATH and breaks every shell command the agent tries to run.
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (opts.configDir) {
      env.CLAUDE_CONFIG_DIR = opts.configDir;
      const { deriveIsolatedHome } = require('./helpers');
      const home = deriveIsolatedHome(opts.configDir, '.claude');
      if (home) env.HOME = home;
    }
    if (isExternal) {
      env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}/proxy/${encodeURIComponent(effectiveModel)}`;
      env.ANTHROPIC_API_KEY = BRIDGE_INTERNAL_KEY;
    } else {
      const anthropicProvider = config.providers.find((p: any) => p.name === 'Anthropic');
      if (anthropicProvider?.api_key && !isSubscriptionModel(effectiveModel, opts.modelProvider)) {
        env.ANTHROPIC_API_KEY = anthropicProvider.api_key;
      } else {
        // Prevent any leaked ANTHROPIC_API_KEY in process.env from overriding OAuth for subscription
        delete env.ANTHROPIC_API_KEY;
      }
    }

    let systemPrompt: string | { type: 'preset'; preset: 'claude_code'; append?: string } | undefined;
    const skillsBlock = opts.skills?.length
      ? opts.skills.map((s) => `## Skill: ${s.name}\n\n${s.content}`).join('\n\n---\n\n')
      : '';
    if (preset && opts.sysMode === 'replace') {
      systemPrompt = preset
        + (skillsBlock ? '\n\n' + skillsBlock : '');
    } else {
      const append = [
        preset && opts.sysMode === 'append' ? preset : '',
        skillsBlock,
      ]
        .filter(Boolean)
        .join('\n\n');
      if (append) {
        systemPrompt = { type: 'preset', preset: 'claude_code', append };
      }
    }

    // #btw queue: harness path — drain any pending items at start-of-turn.
    // The Claude Agent SDK's query() iterator is a black box, so true
    // mid-stream injection isn't possible here. TODO: explore SDK
    // interrupt/append APIs once they exist; for now the queue just folds
    // into the next prompt.
    let composedPrompt = prompt;
    try {
      const { drainBtw, formatBtwInjection } = require('./btw-queue');
      const pending = drainBtw(sessionId);
      if (pending.length) composedPrompt = `${prompt}\n\n${formatBtwInjection(pending)}`;
    } catch (_) {}
    const historySessionId = String(opts.historySessionId || sessionId);
    const priorHistory = opts.selfEmpId
    ? getHistoryForEmployee(sessionId, opts.selfEmpId)
    : getHistory(historySessionId);
    if (priorHistory.length > 0) {
      const maxTurns = getMaxHistoryTurns();
      const maxChars = getMaxHistoryChars();
      const recentTurns = priorHistory.slice(-maxTurns);
      let ctx = recentTurns
        .map((m: any) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
      if (ctx.length > maxChars) ctx = ctx.slice(-maxChars);
      composedPrompt = `[Previous conversation context:\n${ctx}\n]\n\n${prompt}`;
    }

    logger.info('claude-agent-sdk.stream', {
      model: effectiveModel,
      isExternal,
      cwd: sessionCwd,
      configDir: opts.configDir,
      promptLen: composedPrompt.length,
    });
    logRaw('model', 'in', { prompt: composedPrompt, modelId: effectiveModel, route: 'sdk-stream', sessionId }, {});

    const ac = new AbortController();
    const mcpServers = loadMcpServers(sessionId);
    const q = query({
      prompt: composedPrompt,
      options: {
        cwd: sessionCwd,
        model: effectiveModel,
        pathToClaudeCodeExecutable: opts.claudeBin || CLAUDE_BIN,
        env,
        systemPrompt,
        effort: opts.effort as any,
        permissionMode: 'bypassPermissions' as any,
        allowDangerouslySkipPermissions: true,
        mcpServers: Object.keys(mcpServers).length ? mcpServers : undefined,
        // See runClaudeViaSdk above — replaces AskUserQuestion with the
        // mcp__MCP-Tools__bridge__AskUser variant routed through SSE.
        disallowedTools: ['AskUserQuestion'],
        abortController: ac,
      },
    });

    let assembledText = '';
    let resultInfo: { text: string; cost?: number; stopReason?: string; inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number } = {
      text: '',
      cost: 0,
      stopReason: 'end_turn',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };

    for await (const msg of q) {
      const m = msg as any;
      if (m.type === 'assistant') {
        const content = m.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              assembledText += block.text;
              onChunk({ text: block.text, delta: block.text });
            } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
              onChunk({ reasoning: block.thinking });
            } else if (block.type === 'tool_use') {
              onChunk({ toolUse: { id: block.id, name: block.name, input: block.input } });
            }
          }
        }
      }
      if (m.type === 'user') {
        const content = m.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const textContent = Array.isArray(block.content)
                ? block.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
                : String(block.content || '');
              onChunk({ toolResult: { id: block.tool_use_id, content: textContent } });
            }
          }
        }
      }
      if (m.type === 'result') {
        resultInfo = {
          text: typeof m.result === 'string' && m.result ? m.result : assembledText,
          cost: m.total_cost_usd,
          stopReason: 'end_turn',
          inputTokens: m.usage?.input_tokens || 0,
          outputTokens: m.usage?.output_tokens || 0,
          cacheCreationTokens: m.usage?.cache_creation_input_tokens || 0,
          cacheReadTokens: m.usage?.cache_read_input_tokens || 0,
        };
      }
    }

    if (!resultInfo.text) resultInfo.text = assembledText;
    logRaw('model', 'out', resultInfo, { route: 'sdk-stream', modelId: effectiveModel, sessionId });
    // See note in runClaudeViaSdk above — SDK path is the only one that didn't
    // write back to chatHistory, which made the model see [] every turn.
    try {
      pushHistory(historySessionId, 'user', prompt);
      if (resultInfo.text) pushHistory(historySessionId, 'assistant', resultInfo.text);
    } catch (_) {}
    onDone(resultInfo);
  })().catch((e) => {
    logger.error('claude-agent-sdk.stream.error', { error: e instanceof Error ? e.message : String(e) });
    onError(e instanceof Error ? e : new Error(String(e)));
  });
}

