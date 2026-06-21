// ── Bridge tool executor + hash-tool dispatch ─────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { config, mcpConnections, CLAUDE_BIN, BRIDGE_INTERNAL_KEY, PORT } = require('../core/state');
const { getSessionCwd } = require('../sessions-internal');
const { logRaw } = require('../observability/raw-logs');
const logger = require('../core/logger');
const { resolveSafePath, validateFetchUrl, resolvePinnedAddress, pinnedGet } = require('./security');
const { getModuleApi } = require('../core/modules');
const { IS_WINDOWS } = require('../core/platform');

// ── MCP tool call relay (imported lazily to avoid circular init) ──────────────
function _callMcpTool(serverName, toolName, args) {
  const mcp = getModuleApi<any>('mcp-client');
  if (!mcp) throw new Error('mcp-client module is disabled');
  return mcp.callMcpTool(serverName, toolName, args);
}

// Resolve a working Python 3 launcher for RunCode. `python3` is the POSIX name
// but is frequently absent on Windows, where the `py` launcher (`py -3`) or a
// bare `python` is what exists. Probe candidates once and cache the first that
// answers `--version`. Returns { cmd, prefix } so the caller spawns
// `cmd [...prefix] '-'`. spawn() with the bare exe name (no shell) avoids any
// argument-injection surface.
let _pythonCmd: { cmd: string; prefix: string[] } | null = null;
function resolvePythonCmd() {
  if (_pythonCmd) return _pythonCmd;
  const { spawnSync } = require('child_process');
  const candidates: Array<[string, string[]]> = IS_WINDOWS
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [cmd, prefix] of candidates) {
    try {
      const r = spawnSync(cmd, [...prefix, '--version'], { stdio: 'ignore', timeout: 5000 });
      if (r && r.status === 0) {
        _pythonCmd = { cmd, prefix };
        return _pythonCmd;
      }
    } catch (_) { /* try next */ }
  }
  // Nothing answered; fall back to the platform default and let spawn surface
  // the ENOENT through RunCode's proc.on('error') handler.
  _pythonCmd = IS_WINDOWS ? { cmd: 'py', prefix: ['-3'] } : { cmd: 'python3', prefix: [] };
  return _pythonCmd;
}

// ── Bridge tool executor ──────────────────────────────────────────────────────
async function executeBridgeTool(name, input, cwd = undefined, modelId = undefined, sessionId = undefined) {
  logRaw('tool', 'in', input, { name, cwd, modelId });
  const _t0 = Date.now();
  const _argsSize = (() => { try { return JSON.stringify(input || {}).length; } catch { return 0; } })();
  // Determines whether this dispatch was routed to an MCP server (already
  // recorded in callMcpTool) or to a bridge-native tool path. We only emit
  // a `tool` surface event for the latter to avoid double-counting.
  let _routedToMcp = false;
  // In-flight memory op classification for bridge-native TodoRead/TodoWrite.
  // The MCP relay branch handles its own classification in protocol.ts.
  const _classifyBridgeMemoryOp = (n: string): 'read' | 'write' | null => {
    if (n === 'TodoRead') return 'read';
    if (n === 'TodoWrite') return 'write';
    return null;
  };
  const done = (output, meta: any = {}) => {
    logRaw('tool', 'out', output, { name, modelId, ...meta });
    if (!_routedToMcp) {
      const ok = !meta.error;
      const obs = getModuleApi<any>('observability-plus');
      obs?.telemetry?.record?.({
        surface: 'tool',
        name,
        durationMs: Date.now() - _t0,
        ok,
        argsSize: _argsSize,
        resultSize: typeof output === 'string' ? output.length : 0,
        meta: { modelId, ...(meta.error ? { error: true } : {}) },
      });
      const memOp = _classifyBridgeMemoryOp(name);
      if (memOp) {
        obs?.telemetry?.record?.({
          surface: 'memory',
          name: `bridge/${name}`,
          durationMs: 0,
          ok,
          argsSize: _argsSize,
          meta: { op: memOp, source: 'bridge' },
        });
      }
    }
    return output;
  };
  // Route MCP tool calls to the appropriate running MCP server
  for (const [serverName, conn] of mcpConnections) {
    if (!conn.ok) continue;
    const safePrefix = serverName.replace(/[^a-zA-Z0-9]/g, '_') + '_';
    const matchedTool = conn.tools.find((t) => t.name === name || safePrefix + t.name === name);
    if (matchedTool) {
      _routedToMcp = true;
      // Inject session cwd so bash-console opens new sessions in the right directory
      const toolInput =
        serverName === 'bash-console' &&
        matchedTool.name === 'run_command' &&
        cwd &&
        !input.working_dir
          ? { ...input, working_dir: cwd }
          : input;
      const result = await _callMcpTool(serverName, matchedTool.name, toolInput);
      const content = result?.content || [];
      // If MCP returned image content blocks, pass them through as Anthropic-style
      // tool_result blocks so Claude can actually see the image. Other providers
      // (OpenAI/Gemini) will degrade in tools/stream — the tool description
      // warns the model not to call image-returning tools from those providers.
      const hasImage = content.some((c) => c.type === 'image' && c.data);
      if (hasImage) {
        const blocks = content.map((c) => {
          if (c.type === 'image' && c.data) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: c.mimeType || c.media_type || 'image/png',
                data: c.data,
              },
            };
          }
          return { type: 'text', text: c.text ?? JSON.stringify(c) };
        });
        return done(blocks, { serverName });
      }
      const out = content.length
        ? content.map((c) => c.text ?? c.data ?? JSON.stringify(c)).join('\n')
        : JSON.stringify(result);
      return done(out, { serverName });
    }
  }
  try {
    switch (name) {
      // ── Read ──
      case 'Read': {
        const fp = resolveSafePath(input.file_path, cwd);
        return done(await fs.promises.readFile(fp, 'utf8'));
      }

      // ── Write ──
      case 'Write': {
        const writeFp = resolveSafePath(input.file_path, cwd);
        await fs.promises.mkdir(path.dirname(writeFp), { recursive: true });
        await fs.promises.writeFile(writeFp, input.content, 'utf8');
        return done(`Written ${writeFp} (${input.content.length} chars)`);
      }

      // ── Edit ──
      case 'Edit': {
        const editFp = resolveSafePath(input.file_path, cwd);
        const src = await fs.promises.readFile(editFp, 'utf8');
        if (!src.includes(input.old_string)) return done(`old_string not found in ${editFp}`);
        const occurrences = src.split(input.old_string).length - 1;
        if (occurrences > 1)
          return done(
            `Ambiguous old_string — found ${occurrences} occurrences in ${editFp}. Make it more specific.`
          );
        await fs.promises.writeFile(
          editFp,
          src.replace(input.old_string, () => input.new_string),
          'utf8'
        );
        return done(`Edited ${editFp}`);
      }

      // ── Bash ──
      case 'Bash': {
        // Cap command length before spawning. A multi-MB command can't actually
        // succeed via -c (ARG_MAX) and just delays the timeout kill while sh
        // tokenizes the whole thing. 64 KB covers any realistic one-liner.
        const BASH_MAX_LEN = 64 * 1024;
        const rawCmd = String(input.command ?? '');
        if (rawCmd.length > BASH_MAX_LEN) {
          return done(`(bash command too long: ${rawCmd.length} > ${BASH_MAX_LEN} bytes)`, { error: true });
        }
        return new Promise((resolve) => {
          // Pass argv through `sh -c` for shell features (pipes, redirects) without
          // direct exec() RCE through the command string. NOT immune to injection via
          // crafted commands. Windows has no /bin/sh; run the same command in real
          // git-bash `bash` (commands are POSIX-flavored, so no translation needed —
          // git-bash must be on PATH).
          const shellBin = IS_WINDOWS ? 'bash' : '/bin/sh';
          const proc = spawn(shellBin, ['-c', rawCmd], {
            cwd: cwd || process.cwd(),
            timeout: 60000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let out = '';
          let errOut = '';
          proc.stdout.on('data', (d) => {
            out += d;
            if (out.length > 8000) proc.kill();
          });
          proc.stderr.on('data', (d) => {
            errOut += d;
            if (errOut.length > 8000) proc.kill();
          });
          proc.on('close', (code) => {
            const combined = (out + errOut).slice(0, 8000);
            resolve(done(combined || `(exit ${code})`));
          });
          proc.on('error', (err) => {
            resolve(done(err.message || '(spawn error)'));
          });
        });
      }

      // ── PowerShell ──
      case 'PowerShell': {
        const PS_MAX_LEN = 64 * 1024;
        const rawCmd = String(input.command ?? '');
        if (rawCmd.length > PS_MAX_LEN) {
          return done(`(powershell command too long: ${rawCmd.length} > ${PS_MAX_LEN} bytes)`, { error: true });
        }
        return new Promise((resolve) => {
          const proc = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', rawCmd],
            {
              cwd: cwd || process.cwd(),
              timeout: 60000,
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
          let out = '';
          let errOut = '';
          proc.stdout.on('data', (d) => {
            out += d;
            if (out.length > 8000) proc.kill();
          });
          proc.stderr.on('data', (d) => {
            errOut += d;
            if (errOut.length > 8000) proc.kill();
          });
          proc.on('close', (code) => {
            const combined = (out + errOut).slice(0, 8000);
            resolve(done(combined || `(exit ${code})`));
          });
          proc.on('error', (err) => {
            resolve(done(err.message || '(spawn error)'));
          });
        });
      }

      // ── Glob ──
      case 'Glob': {
        // Real glob via Bun.Glob — honors directory prefixes and `**` path segments
        // (e.g. `src/**/*.ts` confines to src/, `**/node_modules/**` matches at any depth).
        const globPattern = input.pattern || '*';
        const baseCwd = cwd || process.cwd();
        const searchDir = input.path ? path.resolve(baseCwd, input.path) : baseCwd;
        const MAX_RESULTS = 100;
        const MAX_BYTES = 50_000;
        const TIMEOUT_MS = 20_000;
        try {
          // @ts-ignore — Bun global at runtime
          const glob = new Bun.Glob(globPattern);
          const matches: string[] = [];
          let bytes = 0;
          const started = Date.now();
          const iter = glob.scan({
            cwd: searchDir,
            onlyFiles: true,
            followSymlinks: false,
          });
          for await (const rel of iter) {
            if (Date.now() - started > TIMEOUT_MS) break;
            matches.push(rel);
            bytes += rel.length + 1;
            if (matches.length >= MAX_RESULTS || bytes >= MAX_BYTES) break;
          }
          return done(matches.join('\n') || '(no files found)');
        } catch (err: any) {
          return done('(no files found)', { error: err?.message || String(err) });
        }
      }

      // ── Grep ──
      case 'Grep': {
        // spawn (no shell) — prevents RCE via crafted regex/path args.
        // Windows has no `grep`; use ripgrep. `--no-ignore` matches grep -r, which
        // (unlike rg's default) does NOT skip .gitignore'd files; rg recurses by
        // default. Both must be on PATH.
        let grepBin: string;
        let grepArgs: string[];
        if (IS_WINDOWS) {
          grepBin = 'rg';
          grepArgs = ['-n', '--no-ignore'];
          if (input.glob) grepArgs.push('--glob', input.glob);
        } else {
          grepBin = 'grep';
          grepArgs = ['-rn'];
          if (input.glob) grepArgs.push(`--include=${input.glob}`);
        }
        grepArgs.push('--', input.pattern, input.path || '.');
        return new Promise((resolve) => {
          const spawnOpts: any = {};
          if (cwd) spawnOpts.cwd = cwd;
          const proc = spawn(grepBin, grepArgs, spawnOpts);
          let out = '';
          const timer = setTimeout(() => proc.kill(), 20000);
          proc.stdout.on('data', (d) => {
            out += d;
            if (out.length > 50000) proc.kill();
          });
          proc.stderr.on('data', () => {});
          proc.on('close', () => {
            clearTimeout(timer);
            resolve(done(out.trim().split('\n').slice(0, 50).join('\n') || '(no matches)'));
          });
          proc.on('error', () => {
            clearTimeout(timer);
            resolve(done('(no matches)'));
          });
        });
      }

      // ── WebFetch ──
      case 'WebFetch': {
        // Cap raw body at 1 MiB so a 1 GB page can't OOM the bridge. Output
        // gets stripped + sliced to 12 KB after; the 1 MiB headroom leaves room
        // for tag-heavy pages that compress dramatically when stripped.
        const MAX_RAW_BYTES = 1024 * 1024;
        const MAX_HOPS = 5;
        // Manual redirect loop: re-validate + re-pin EVERY hop. fetch() follows
        // redirects internally and re-resolves DNS at connect time, so a public
        // first hop could 302 to (or DNS-rebind toward) 169.254.169.254 /
        // 127.0.0.1. Validate the literal, resolve to ONE approved public IP,
        // and connect straight to it via pinnedGet — no blind chasing.
        let url = validateFetchUrl(input.url);
        let res = null;
        let redirected = true;
        for (let hop = 0; hop < MAX_HOPS && redirected; hop++) {
          const { hostname } = new URL(url);
          const pin = await resolvePinnedAddress(hostname);
          res = await pinnedGet(url, pin.address, pin.family, {
            maxBytes: MAX_RAW_BYTES,
            timeoutMs: 15000,
          });
          redirected = false;
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            url = validateFetchUrl(new URL(res.headers.location, url).href);
            redirected = true;
          }
        }
        if (redirected) return done('(too many redirects)', { error: true });
        const truncated = !!(res && res.truncated);
        const raw = res && res.body ? res.body.toString('utf8') : '';
        const stripped = raw
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 12000);
        return done(truncated ? `${stripped}\n…(truncated at ${MAX_RAW_BYTES} bytes raw)` : stripped);
      }

      // ── WebSearch ──
      // Delegates to bridge/search/orchestrator.js, which walks the configured
      // providers (Tavily → Exa → Google CSE → Bing) and falls through to a
      // free DDG/Brave stage. The `surface` toggle in search-config.json
      // determines whether this bridge tool path is active or whether the
      // model should be steered to use the websearch MCP server's `search`
      // tool instead. Both paths share the same orchestrator and quota counters.
      case 'WebSearch': {
        const search = getModuleApi<any>('search');
        if (!search) {
          return done('Web search is disabled (search module is not enabled in bridge/modules.json).', { error: true });
        }
        const surface = search.searchConfig.load().surface;
        if (surface === 'mcp') {
          return done(
            'The bridge WebSearch tool is disabled by your Search-tab surface setting. Use the websearch MCP server\'s `search` tool instead, or switch the surface to "bridge" / "both" in the Search preferences tab.'
          );
        }
        const out = await search.orchestrator.search(String(input.query || input.q || ''), {
          num: input.num_results || 10,
        });
        return done(search.orchestrator.formatMarkdown(out.results, out.used), {
          searchProvider: out.used,
          searchAttempts: out.attempts,
        });
      }

      case 'Task': {
        // Spawn Claude Code binary as a subagent for an independent workstream
        const claudeBin = CLAUDE_BIN || 'claude';

        return new Promise((resolve) => {
          const taskCwd = cwd || process.cwd();
          const args = ['--print', '--output-format', 'json', '--dangerously-skip-permissions'];
          const taskEnv = { ...process.env };
          if (modelId) {
            const bridgePort = config.defaults?.port || 8443;
            taskEnv.ANTHROPIC_BASE_URL = `http://localhost:${bridgePort}/proxy/${encodeURIComponent(modelId)}`;
            if (!taskEnv.ANTHROPIC_API_KEY) taskEnv.ANTHROPIC_API_KEY = BRIDGE_INTERNAL_KEY;
          }
          // `nice` doesn't exist on Windows; spawn the agent directly there (the
          // de-prioritization is a nice-to-have, not load-bearing). The
          // --dangerously-skip-permissions flag is intentional and kept on both.
          const spawnOpts = { cwd: taskCwd, env: taskEnv, stdio: ['pipe', 'pipe', 'pipe'] as const };
          const proc = IS_WINDOWS
            ? spawn(claudeBin, args, spawnOpts)
            : spawn('nice', ['-n', '10', claudeBin, ...args], spawnOpts);
          const MAX_OUT = 1024 * 1024; // 1MB cap — runaway subagent won't OOM the bridge
          let out = '';
          proc.stdout.on('data', (d) => {
            if (out.length < MAX_OUT) out += d;
          });
          proc.stderr.on('data', () => {});
          proc.on('close', () => {
            try {
              const lines = out.trim().split('\n').filter(Boolean);
              const last = lines
                .map((l) => {
                  try {
                    return JSON.parse(l);
                  } catch {
                    return null;
                  }
                })
                .filter(Boolean)
                .pop();
              resolve(
                done(
                  last?.result || last?.content?.[0]?.text || out.slice(0, 4000) || '(no output)'
                )
              );
            } catch (_) {
              resolve(done(out.slice(0, 4000) || '(no output)'));
            }
          });
          proc.on('error', (err) => resolve(done(`Task spawn error: ${err.message}`)));
          proc.stdin.end(input.prompt || '');
        });
      }

      case 'TodoWrite': {
        const todos = getModuleApi<any>('todos');
        if (!todos) {
          return done('Todos are disabled (todos module is not enabled in bridge/modules.json).', { error: true });
        }
        const items = Array.isArray(input.todos) ? input.todos : [];
        const effectiveCwd = String(cwd || process.cwd());
        await todos.writeTodos(effectiveCwd, items);
        await todos.rememberLabel(effectiveCwd);
        return done(`Task list saved (${items.length} items)`);
      }

      case 'TodoRead': {
        const todos = getModuleApi<any>('todos');
        if (!todos) {
          return done('Todos are disabled (todos module is not enabled in bridge/modules.json).', { error: true });
        }
        const effectiveCwd = String(cwd || process.cwd());
        const items = todos.readTodos(effectiveCwd);
        if (!items.length) return done('(no task list yet)');
        return done(
          items
            .map(
              (t) => `[${t.status}] ${t.id}: ${t.content}${t.priority ? ` (${t.priority})` : ''}`
            )
            .join('\n')
        );
      }

      // ── AskUser ──
      // Renders an interactive multiple-choice form in the chat and blocks
      // until the user submits. Replaces the unavailable built-in
      // AskUserQuestion. Requires a sessionId so the question routes to the
      // right SSE stream — when missing (legacy code path that bypasses MCP),
      // returns an error instead of hanging forever.
      case 'AskUser': {
        if (!sessionId) {
          return done('AskUser requires a session context — invoke via the MCP-Tools bridge.', { error: true });
        }
        const questions = Array.isArray(input.questions) ? input.questions : [];
        if (!questions.length) {
          return done('AskUser called with no questions — pass at least one.', { error: true });
        }
        const { registerQuestion } = require('../chat/ask-user');
        const { broadcastChunk } = require('../sessions-internal');
        const { injectInlineBlock } = require('../chat/btw-queue');
        const { id, promise } = registerQuestion(sessionId, questions);
        // Inject the block into the live stream's bridge-side `blocks` array
        // (so it persists across reload / session-switch) AND broadcast the
        // matching chunk for the live SSE listeners. Falls back to a pure
        // broadcast if no live stream is registered — frontend still shows
        // the form but the persisted message won't have the block.
        const block = {
          type: 'ask-user-question',
          questionId: id,
          questions,
          answered: false,
        };
        const chunk = { askUserQuestion: { id, questions } };
        const injected = injectInlineBlock(sessionId, block, broadcastChunk, chunk);
        if (!injected) broadcastChunk(sessionId, chunk);
        const answer = await promise;
        return done(answer);
      }

      // ── Frontend ──
      // Sends a semantic command/inspection request to the already-open YPA
      // tab that owns this session. The visible browser executes it through
      // window.__ypa_agent and returns the result via the session route.
      case 'Frontend': {
        const action = String(input.action || '').trim();
        const allowed = new Set([
          'list_commands',
          'run_command',
          'get_state',
          'list_surfaces',
          'focus_surface',
          'close_surface',
          'list_manifest',
          'open_terminal',
          'list_models',
          'new_session',
          'set_model',
          'send_message',
          'list_tabs',
        ]);
        if (!allowed.has(action)) {
          return done(`Unknown Frontend action: ${action || '(empty)'}`, { error: true });
        }
        const targetSessionId = String(input.session_id || sessionId || '').trim();
        if (action === 'list_tabs') {
          const { listFrontendSessions } = require('../chat/frontend-agent');
          return done(JSON.stringify({ ok: true, action, data: listFrontendSessions() }, null, 2));
        }
        if (!targetSessionId) {
          return done('Frontend requires a session context.', { error: true });
        }
        const commandId = String(input.command_id || '').trim();
        const surfaceId = String(input.surface_id || '').trim();
        const modelQuery = String(input.model_query || '').trim();
        const message = String(input.message || '').trim();
        if (action === 'run_command' && !commandId) {
          return done('run_command requires command_id.', { error: true });
        }
        if ((action === 'focus_surface' || action === 'close_surface') && !surfaceId) {
          return done(`${action} requires surface_id.`, { error: true });
        }
        if (action === 'set_model' && !modelQuery) {
          return done('set_model requires model_query.', { error: true });
        }
        if (action === 'send_message' && !message) {
          return done('send_message requires message.', { error: true });
        }
        const { registerFrontendRequest, publishFrontendRequest } = require('../chat/frontend-agent');
        const { id, promise } = registerFrontendRequest(targetSessionId);
        publishFrontendRequest(targetSessionId, {
          id,
          action,
          ...(commandId ? { commandId } : {}),
          ...(surfaceId ? { surfaceId } : {}),
          ...(modelQuery ? { modelQuery } : {}),
          ...(message ? { message } : {}),
        });
        const result = await promise;
        return done(JSON.stringify(result, null, 2), result?.ok === false ? { error: true } : {});
      }

      // ── RunCode ──
      // Provider-agnostic Programmatic Tool Calling: execute Python 3 in the
      // session cwd. Intermediate values stay in Python variables; only stdout
      // returns to model context. The injected `yha` module lets Python call
      // back into bridge tools (Read, Bash, Grep, …) via /proxy/tool so the
      // model can orchestrate multi-tool loops without multiple round-trips.
      case 'RunCode': {
        const code = String(input.code || '');
        if (!code.trim()) return done('(empty code)');

        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yha-runcode-'));
        const cleanup = () => fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

        const bridgePort = PORT || config.defaults?.port || 8443;
        const effectiveCwd = cwd || process.cwd();

        // yha.py stdlib injected into PYTHONPATH so model's code can `import yha`
        const yhaPy = [
          'import os, json',
          'try:',
          '  import urllib.request as _req',
          'except ImportError:',
          '  _req = None',
          '',
          `_BASE = os.environ.get('YHA_BRIDGE_URL', 'http://127.0.0.1:${bridgePort}')`,
          `_KEY  = os.environ.get('YHA_BRIDGE_KEY', '')`,
          `cwd   = os.environ.get('YHA_CWD', os.getcwd())`,
          '',
          'def _call(name, **kw):',
          '  if _req is None: return "(yha: urllib unavailable)"',
          '  d = json.dumps({"name": name, "input": kw, "cwd": cwd}).encode()',
          '  r = _req.Request(f"{_BASE}/proxy/tool", data=d,',
          '      headers={"Content-Type": "application/json", "x-bridge-key": _KEY})',
          '  try:',
          '    with _req.urlopen(r, timeout=25) as resp:',
          '      return json.loads(resp.read().decode()).get("result", "")',
          '  except Exception as e:',
          '    return f"(yha error: {e})"',
          '',
          'def read(path): return _call("Read", file_path=path)',
          'def write(path, content): return _call("Write", file_path=path, content=content)',
          'def bash(cmd): return _call("Bash", command=cmd)',
          'def grep(pattern, path=".", glob=None):',
          '  kw = {"pattern": pattern, "path": path}',
          '  if glob is not None: kw["glob"] = glob',
          '  return _call("Grep", **kw)',
          'def glob_files(pattern, path="."): return _call("Glob", pattern=pattern, path=path)',
          'def web_fetch(url): return _call("WebFetch", url=url)',
          'def web_search(query, num=10): return _call("WebSearch", query=query, num_results=num)',
        ].join('\n');

        await fs.promises.writeFile(path.join(tmpDir, 'yha.py'), yhaPy, 'utf8');

        const py = resolvePythonCmd();
        return new Promise((resolve) => {
          const proc = spawn(py.cmd, [...py.prefix, '-'], {
            cwd: effectiveCwd,
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              YHA_CWD: effectiveCwd,
              YHA_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
              YHA_BRIDGE_KEY: BRIDGE_INTERNAL_KEY,
              PYTHONPATH: tmpDir + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''),
              PYTHONDONTWRITEBYTECODE: '1',
            },
          });
          let out = '';
          let errOut = '';
          proc.stdout.on('data', (d) => { out += d; if (out.length > 12000) proc.kill(); });
          proc.stderr.on('data', (d) => { errOut += d; if (errOut.length > 4000) proc.kill(); });
          proc.on('close', async (exitCode) => {
            await cleanup();
            const combined = (out + (errOut ? '\n[stderr]\n' + errOut : '')).slice(0, 12000).trim();
            resolve(done(combined || `(exit ${exitCode})`));
          });
          proc.on('error', async (err) => {
            await cleanup();
            resolve(done(`RunCode error: ${err.message}`));
          });
          proc.stdin.write(code);
          proc.stdin.end();
        });
      }

      default:
        return done(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const errOut = `Tool error: ${e.message}`;
    return done(errOut, { error: true });
  }
}

// ── Hash-tool command handler (#bash #read #glob etc., typed by the user) ─────
async function handleHashTool(input, sessionId) {
  const s = input.trim();
  const sessionCwd = sessionId ? getSessionCwd(sessionId) : process.cwd();
  const codexHashM = s.match(/^#([a-zA-Z0-9_.-]+)\s*([\s\S]*)$/);

  const bashM = s.match(/^#bash\s+([\s\S]+)$/i);
  if (bashM) {
    const result = await executeBridgeTool('Bash', { command: bashM[1].trim() }, sessionCwd);
    return { handled: true, result: String(result) };
  }
  const psM = s.match(/^#powershell\s+([\s\S]+)$/i);
  if (psM) {
    const result = await executeBridgeTool('PowerShell', { command: psM[1].trim() }, sessionCwd);
    return { handled: true, result: String(result) };
  }
  const readM = s.match(/^#read\s+(\S+)$/i);
  if (readM) {
    const result = await executeBridgeTool('Read', { file_path: readM[1] }, sessionCwd);
    return { handled: true, result: String(result) };
  }
  // #write <path>\n<content>  OR  #write <path> <single-line-content>
  const writeM = s.match(/^#write\s+(\S+)(?:\n([\s\S]*)|\s+([\s\S]+))?$/i);
  if (writeM) {
    const filePath = writeM[1];
    const content = writeM[2] !== undefined ? writeM[2] : (writeM[3] || '');
    const result = await executeBridgeTool('Write', { file_path: filePath, content }, sessionCwd);
    return { handled: true, result: String(result) };
  }
  // #edit <path>\n<old_string>\n---\n<new_string>  OR  #edit {"file_path":"...","old_string":"...","new_string":"..."}
  const editJsonM = s.match(/^#edit\s+(\{[\s\S]+\})$/i);
  if (editJsonM) {
    try {
      const args = JSON.parse(editJsonM[1]);
      const result = await executeBridgeTool('Edit', args, sessionCwd);
      return { handled: true, result: String(result) };
    } catch {
      return { handled: true, result: 'Invalid JSON args for #edit' };
    }
  }
  const editM = s.match(/^#edit\s+(\S+)\n([\s\S]*?)\n---\n([\s\S]*)$/i);
  if (editM) {
    const result = await executeBridgeTool(
      'Edit',
      { file_path: editM[1], old_string: editM[2], new_string: editM[3] },
      sessionCwd
    );
    return { handled: true, result: String(result) };
  }
  const globM = s.match(/^#glob\s+(.+)$/i);
  if (globM) {
    const result = await executeBridgeTool('Glob', { pattern: globM[1].trim() }, sessionCwd);
    return { handled: true, result: String(result) };
  }
  const grepM = s.match(/^#grep\s+(\S+)(?:\s+(.+))?$/i);
  if (grepM) {
    const result = await executeBridgeTool(
      'Grep',
      { pattern: grepM[1], path: (grepM[2] || '.').trim() },
      sessionCwd
    );
    return { handled: true, result: String(result) };
  }
  const fetchM = s.match(/^#webfetch\s+(\S+)$/i);
  if (fetchM) {
    const result = await executeBridgeTool('WebFetch', { url: fetchM[1] });
    return { handled: true, result: String(result) };
  }
  const searchM = s.match(/^#(?:search|websearch)\s+([\s\S]+)$/i);
  if (searchM) {
    const result = await executeBridgeTool('WebSearch', { query: searchM[1].trim() });
    return { handled: true, result: String(result) };
  }
  if (codexHashM) {
    const toolName = codexHashM[1];
    const rest = (codexHashM[2] || '').trim();
    if (toolName === 'functions.exec_command') {
      if (!rest) {
        return {
          handled: true,
          result: 'Usage: #functions.exec_command <shell command>',
        };
      }
      const result = await executeBridgeTool('Bash', { command: rest }, sessionCwd);
      return { handled: true, result: String(result) };
    }
    const unsupportedCodexTools = new Set([
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
    ]);
    if (unsupportedCodexTools.has(toolName)) {
      return {
        handled: true,
        result: `Direct bridge execution is not implemented for #${toolName} yet. Right now only #functions.exec_command can run immediately; the others still need model-driven tool use.`,
      };
    }
    // Check if it matches a running MCP tool and execute directly
    for (const [, conn] of mcpConnections) {
      if (!conn.ok) continue;
      const matchedTool = conn.tools.find((t) => t.name === toolName);
      if (matchedTool) {
        let args = {};
        if (rest.startsWith('{')) {
          try {
            args = JSON.parse(rest);
          } catch (_) {
            return {
              handled: true,
              result: `Invalid JSON args for #${toolName}. Use: #${toolName} {"param": "value"}`,
            };
          }
        } else if (rest) {
          const schema = matchedTool.inputSchema || {};
          const required = schema.required || [];
          const props = schema.properties || {};
          const strParams = required.filter((p) => !props[p] || props[p].type === 'string');
          if (strParams.length === 1) {
            args = { [strParams[0]]: rest };
          } else if (Object.keys(props).length === 1) {
            args = { [Object.keys(props)[0]]: rest };
          } else {
            return {
              handled: true,
              result: `Usage: #${toolName} <JSON args>\nSchema: ${JSON.stringify(matchedTool.inputSchema, null, 2)}`,
            };
          }
        }
        const result = await executeBridgeTool(toolName, args, sessionCwd);
        return { handled: true, result: String(result) };
      }
    }
  }
  return { handled: false };
}

module.exports = {
  executeBridgeTool,
  handleHashTool,
};
