// ── OpenAI Codex CLI integration ──────────────────────────────────────────────
'use strict';

const { spawn } = require('child_process');

const { config, CODEX_BIN, activeProcesses } = require('../core/state');
const { getSessionCwd, pushHistory } = require('../sessions-internal');
const { logRaw } = require('../observability/raw-logs');

const CODEX_TOOL_NAMES = [
  'functions.exec_command',
  'functions.apply_patch',
  'functions.update_plan',
  'functions.spawn_agent',
  'functions.send_input',
  'functions.wait_agent',
  'functions.close_agent',
  'web.search_query',
  'web.open',
  'web.find',
  'web.click',
  'web.finance',
  'web.weather',
  'multi_tool_use.parallel',
];

function getCodexBin() {
  return config.defaults?.codexBin || CODEX_BIN;
}

function splitAllowedToolsByProvider(tools = []) {
  const out = { claude: [], codex: [] };
  for (const raw of Array.isArray(tools) ? tools : []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    if (CODEX_TOOL_NAMES.includes(name)) out.codex.push(name);
    else out.claude.push(name);
  }
  return out;
}

function buildCodexToolPreamble(allowedTools = []) {
  const names = [
    ...new Set(
      (Array.isArray(allowedTools) ? allowedTools : [])
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    ),
  ];
  if (!names.length) return '';
  return [
    'Tool availability for this run:',
    `Only use these Codex tools if tool use is necessary: ${names.join(', ')}`,
    'If you need a tool outside this list, stop and say which tool is missing instead of using it.',
  ].join('\n');
}

function formatCodexMcpToolName(item: any = {}) {
  const server = String(item.server || '').trim();
  const tool = String(item.tool || '').trim();
  if (!server && !tool) return '';
  const safeServer = server.replace(/[^a-zA-Z0-9]/g, '_');
  const safeTool = tool.replace(/-/g, '_');
  if (safeServer && safeTool) return `mcp__${safeServer}__.${safeTool}`;
  return safeTool || safeServer;
}

function codexResultToText(result: any): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result?.content)) {
    return result.content
      .map((part: any) => {
        if (typeof part?.text === 'string') return part.text;
        if (part?.data != null) return String(part.data);
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (result?.structured_content != null) return JSON.stringify(result.structured_content);
  return JSON.stringify(result);
}

function isPlainObject(value: any): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwnEntries(value: any): boolean {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function pickCodexFields(item: any, keys: string[] = []) {
  const out = {};
  for (const key of keys) {
    const value = item?.[key];
    if (value == null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (isPlainObject(value) && !Object.keys(value).length) continue;
    out[key] = value;
  }
  return out;
}

function extractCodexNativeToolInput(item: any = {}) {
  const type = String(item.type || '').trim();
  if (!type) return {};
  if (hasOwnEntries(item.input)) return item.input;
  if (type === 'web_search') {
    const action = isPlainObject(item.action) ? item.action : {};
    const out = pickCodexFields(
      {
        status: item.status,
        action: pickCodexFields(action, ['type', 'query', 'queries', 'url']),
      },
      ['status', 'action']
    );
    if (hasOwnEntries(out)) return out;
  }
  if (type === 'todo_list') {
    const out = pickCodexFields(item, ['todos', 'items', 'entries', 'operations']);
    if (hasOwnEntries(out)) return out;
  }
  if (type === 'file_change') {
    const out = pickCodexFields(item, [
      'path',
      'paths',
      'file',
      'files',
      'old_path',
      'new_path',
      'changes',
      'diff',
      'summary',
    ]);
    if (hasOwnEntries(out)) return out;
  }
  const fallback = {};
  const skip = new Set([
    'id',
    'type',
    'status',
    'input',
    'output',
    'result',
    'error',
    'text',
    'content',
    'aggregated_output',
    'exit_code',
    'call_id',
  ]);
  for (const [key, value] of Object.entries(item || {})) {
    if (skip.has(key)) continue;
    if (value == null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (isPlainObject(value) && !Object.keys(value).length) continue;
    fallback[key] = value;
  }
  return fallback;
}

function extractCodexNativeToolResult(item: any = {}) {
  const type = String(item.type || '').trim();
  if (!type) return '';
  if (type === 'web_search') {
    const action = isPlainObject(item.action) ? item.action : {};
    const lines = [];
    if (item.status) lines.push(`status=${item.status}`);
    if (action.type) lines.push(`action=${action.type}`);
    if (action.query) lines.push(`query=${action.query}`);
    if (Array.isArray(action.queries) && action.queries.length > 1)
      lines.push(`queries=${action.queries.join(' | ')}`);
    if (action.url) lines.push(`url=${action.url}`);
    return lines.join('\n');
  }
  if (type === 'todo_list' || type === 'file_change') {
    const payload = extractCodexNativeToolInput(item);
    return hasOwnEntries(payload) ? JSON.stringify(payload) : '';
  }
  if (item.result != null) return codexResultToText(item.result);
  if (item.error) return String(item.error);
  return '';
}

function formatCodexNativeToolName(type: string): string {
  if (type === 'web_search') return 'codex.WebSearch';
  if (type === 'todo_list') return 'codex.TodoList';
  if (type === 'file_change') return 'codex.FileChange';
  return `codex.${type}`;
}

function mapCodexItemToToolUse(item: any = {}) {
  const type = String(item.type || '').trim();
  if (!type || type === 'agent_message') return null;
  if (type === 'command_execution') {
    return {
      id: item.id,
      name: 'functions.exec_command',
      input: { command: item.command || '' },
    };
  }
  if (type === 'mcp_tool_call') {
    return {
      id: item.id,
      name: formatCodexMcpToolName(item) || type,
      input: item.arguments || {},
    };
  }
  return {
    id: item.id,
    name: formatCodexNativeToolName(type),
    input: extractCodexNativeToolInput(item),
  };
}

function mapCodexItemToToolResult(item: any = {}) {
  const type = String(item.type || '').trim();
  if (!type || type === 'agent_message') return null;
  if (type === 'command_execution') {
    const lines = [];
    if (item.aggregated_output) lines.push(String(item.aggregated_output));
    if (item.exit_code !== undefined && item.exit_code !== null)
      lines.push(`[exit_code=${item.exit_code}]`);
    return {
      id: item.id,
      content: lines.join('\n').trim() || '(no output)',
    };
  }
  if (type === 'mcp_tool_call') {
    const text = item.error ? String(item.error) : codexResultToText(item.result);
    return {
      id: item.id,
      content: text || '(no output)',
    };
  }
  const nativeText = extractCodexNativeToolResult(item);
  if (nativeText) {
    return {
      id: item.id,
      content: nativeText,
    };
  }
  if (item.output !== undefined) {
    return {
      id: item.id,
      content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
    };
  }
  return null;
}

function streamCodex(prompt, modelId, preset, sessionId, onChunk, onDone, onError, opts: any = {}) {
  const codexBin = opts.codexBin || getCodexBin();
  const rawModel = String(modelId).replace(/^codex\//i, '');
  const cliModel = /^(?:default|auto)$/i.test(rawModel) ? '' : rawModel;
  const sessionCwd = getSessionCwd(sessionId);
  const historySessionId = String(opts.historySessionId || sessionId);
  const execMode = config.defaults?.codexExecMode === 'full-auto' ? 'full-auto' : 'bypass';

  const args = ['exec', '--json', '--skip-git-repo-check'];
  if (execMode === 'full-auto') args.push('--full-auto');
  else args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push('--cd', sessionCwd);
  if (cliModel) args.push('--model', cliModel);

  // Save the bare user input before any enrichment so pushHistory records
  // only the user's actual message, not the injected history prefix.
  const rawUserInput = prompt;

  // Inject YHA chatHistory as text prefix — same source of truth as all other providers.
  try {
    const { getHistory } = require('../sessions-internal');
    const priorTurns = getHistory(historySessionId);
    if (priorTurns.length) {
      const historyText = priorTurns
        .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
        .join('\n\n');
      prompt = `[Previous conversation:\n${historyText}\n]\n\n${prompt}`;
    }
  } catch (_) {}

  if (opts.skills?.length) {
    const skillBlock = opts.skills
      .map((s) => `## Skill: ${s.name}\n\n${s.content}`)
      .join('\n\n---\n\n');
    prompt = skillBlock + '\n\n---\n\n' + prompt;
  }
  if (preset) {
    if (opts.sysMode === 'replace') prompt = `[Instructions: ${preset}]\n\n${prompt}`;
    else prompt = `${prompt}\n\n[Additional context: ${preset}]`;
  }
  const toolPreamble = buildCodexToolPreamble(opts.allowedTools);
  if (toolPreamble) prompt = `${toolPreamble}\n\n---\n\n${prompt}`;

  // #btw queue: harness path — drain at start-of-turn. The Codex CLI runs as
  // a child process with stdin closed after the prompt; true mid-stream
  // injection would need the Codex App Server (bidirectional JSON-RPC).
  // TODO: switch to App Server protocol to support real mid-turn injection.
  try {
    const { drainBtw, formatBtwInjection } = require('../chat/btw-queue');
    const pending = drainBtw(sessionId);
    if (pending.length) prompt = `${prompt}\n\n${formatBtwInjection(pending)}`;
  } catch (_) {}

  const env = { ...process.env };
  const openaiProvider = config.providers.find((p) => p.name === 'OpenAI');
  const activeProvider = String(opts.modelProvider || opts.provider || '');
  const isCodexSubscription =
    /^OpenAI-SUB\d*$/i.test(activeProvider) || activeProvider === 'OpenAI Subscription';
  if (openaiProvider?.api_key && !isCodexSubscription) {
    env.OPENAI_API_KEY = openaiProvider.api_key;
  } else {
    // Subscription OAuth must not be overridden by a stored API key or a
    // leaked process.env OPENAI_API_KEY (mirrors claude-stream.ts).
    delete env.OPENAI_API_KEY;
  }
  if (opts.codexConfigDir) {
    env.CODEX_HOME = opts.codexConfigDir;
    const { deriveIsolatedHome } = require('../chat/helpers');
    const home = deriveIsolatedHome(opts.codexConfigDir, '.codex');
    if (home) env.HOME = home;
  }

  logRaw(
    'model',
    'in',
    { prompt, modelId: rawModel, opts, cwd: sessionCwd, args },
    { provider: 'codex', sessionId, stream: true }
  );

  // Watchdog: kill the process if no stdout output arrives for silenceMs,
  // or if the whole turn exceeds maxMs. Protects against hanging shell commands
  // like recursive directory listings on large/network paths.
  const silenceMs = (opts.silenceTimeoutMs ?? 90_000);
  const maxMs = (opts.maxTimeoutMs ?? 10 * 60_000);

  const proc = spawn(codexBin, args, { env, cwd: sessionCwd });

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const maxTimer = setTimeout(() => {
    try { proc.kill('SIGTERM'); } catch (_) {}
    onError(new Error(`codex turn exceeded maximum duration (${maxMs / 1000}s)`));
  }, maxMs);

  function resetWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      onError(new Error(`codex produced no output for ${silenceMs / 1000}s — likely a hanging shell command`));
    }, silenceMs);
  }
  resetWatchdog();

  function clearTimers() {
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
    clearTimeout(maxTimer);
  }

  activeProcesses.set(sessionId, {
    killFn: () => {
      clearTimers();
      try {
        proc.kill('SIGTERM');
      } catch (_) {}
    },
  });
  proc.on('error', (err) => {
    clearTimers();
    activeProcesses.delete(sessionId);
    onError(err);
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  let lineBuffer = '';
  let fullText = '';
  let stderr = '';
  let usage = null;
  let codexErrorMessage = '';
  const toolCallMap = new Map();
  const startedItemIds = new Set();

  proc.stdout.on('data', (d) => {
    resetWatchdog();
    lineBuffer += d.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    for (const raw of lines) {
      if (!raw.trim()) continue;
      try {
        const ev = JSON.parse(raw);
        if (ev.type === 'response.text.delta' && ev.delta) {
          fullText += ev.delta;
          onChunk({ delta: ev.delta });
        } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
          const text =
            typeof ev.item.text === 'string'
              ? ev.item.text
              : Array.isArray(ev.item.content)
                ? ev.item.content.map((part) => part?.text || '').join('')
                : '';
          if (text) {
            fullText += text;
            onChunk({ delta: text });
          }
        } else if (ev.type === 'item.started' && ev.item) {
          const toolUse = mapCodexItemToToolUse(ev.item);
          if (toolUse) {
            if (toolUse.id && hasOwnEntries(toolUse.input)) startedItemIds.add(toolUse.id);
            onChunk({ toolUse });
          }
        } else if (ev.type === 'item.completed' && ev.item) {
          const toolUse = mapCodexItemToToolUse(ev.item);
          const toolResult = mapCodexItemToToolResult(ev.item);
          if (toolUse && (!toolUse.id || !startedItemIds.has(toolUse.id))) onChunk({ toolUse });
          if (toolResult) onChunk({ toolResult });
          if (toolUse?.id) startedItemIds.delete(toolUse.id);
        } else if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call') {
          toolCallMap.set(ev.item.call_id, { name: ev.item.name, args: '' });
          onChunk({ toolUse: { id: ev.item.call_id, name: ev.item.name, input: {} } });
        } else if (ev.type === 'response.function_call_arguments.delta' && ev.call_id) {
          const toolCall = toolCallMap.get(ev.call_id);
          if (toolCall) toolCall.args += ev.delta || '';
        } else if (ev.type === 'response.function_call_arguments.done' && ev.call_id) {
          const toolCall = toolCallMap.get(ev.call_id);
          if (toolCall) {
            try {
              toolCall.input = JSON.parse(ev.arguments || '{}');
            } catch (_) {
              toolCall.input = ev.arguments || '';
            }
            onChunk({ toolUse: { id: ev.call_id, name: toolCall.name, input: toolCall.input } });
          }
        } else if (
          ev.type === 'response.output_item.done' &&
          ev.item?.type === 'function_call_output'
        ) {
          onChunk({ toolResult: { id: ev.item.call_id, content: ev.item.output || '' } });
        } else if (ev.type === 'error' && ev.message) {
          codexErrorMessage = String(ev.message);
        } else if (ev.type === 'turn.failed' && ev.error?.message) {
          codexErrorMessage = String(ev.error.message);
        } else if (ev.type === 'turn.completed' && ev.usage) {
          usage = ev.usage;
        } else if (!ev.type) {
          const text = ev.delta || ev.text || ev.content || '';
          if (text && typeof text === 'string') {
            fullText += text;
            onChunk({ delta: text });
          }
        }
      } catch (_) {
        if (raw.trim() && !raw.trimStart().startsWith('{')) {
          fullText += raw + '\n';
          onChunk({ delta: raw + '\n' });
        }
      }
    }
  });

  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  proc.on('close', (code) => {
    clearTimers();
    activeProcesses.delete(sessionId);
    // Flush any unterminated last line (stdout ended without trailing newline)
    if (lineBuffer.trim()) {
      try {
        const ev = JSON.parse(lineBuffer);
        if (ev.type === 'response.text.delta' && ev.delta) {
          fullText += ev.delta;
          onChunk({ delta: ev.delta });
        } else if (ev.type === 'turn.completed' && ev.usage) {
          usage = ev.usage;
        } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
          const text = typeof ev.item.text === 'string'
            ? ev.item.text
            : Array.isArray(ev.item.content)
              ? ev.item.content.map((p) => p?.text || '').join('')
              : '';
          if (text) { fullText += text; onChunk({ delta: text }); }
        }
      } catch (_) {
        if (!lineBuffer.trimStart().startsWith('{')) {
          fullText += lineBuffer;
          onChunk({ delta: lineBuffer });
        }
      }
    }
    logRaw(
      'model',
      'out',
      { text: fullText, code, stderr },
      { provider: 'codex', sessionId, stream: true }
    );
    if (code !== 0 && !fullText) {
      const msg = codexErrorMessage || stderr.slice(0, 300);
      onError(new Error(msg || `codex exited ${code}`));
      return;
    }
    if (!fullText.trim()) {
      if (codexErrorMessage) {
        onError(new Error(codexErrorMessage));
        return;
      }
      const errText = stderr.trim();
      if (errText) {
        onError(new Error(`codex produced no response: ${errText.slice(0, 300)}`));
        return;
      }
    }
    pushHistory(historySessionId, 'user', rawUserInput);
    pushHistory(historySessionId, 'assistant', fullText);
    onDone({
      text: fullText,
      cost: 0,
      tokens: usage?.output_tokens || 0,
      // input_tokens is GROSS (includes cached); subtract so inputTokens is NET.
      cacheReadTokens: usage?.input_tokens_details?.cached_tokens || 0,
      inputTokens: (usage?.input_tokens || 0) - (usage?.input_tokens_details?.cached_tokens || 0),
      outputTokens: usage?.output_tokens || 0,
      cacheCreationTokens: 0,
    });
  });
}

module.exports = {
  streamCodex,
  getCodexBin,
  splitAllowedToolsByProvider,
};
