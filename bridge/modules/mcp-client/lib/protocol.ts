// ── MCP stdio frame parser + server lifecycle (query/start/stop/call) ─────────
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');

const state = require('../../../core/state');
const { mcpConnections } = state;
const logger = require('../../../core/logger');
const { BridgeNotFoundError } = require('../../../core/errors');
const { getModuleApi } = require('../../../core/modules');
const { registerMcpPid, unregisterMcpPid } = require('./pid-registry');

// ── Go-owns-MCP delegation guards (Phase 4 cutover) ─────────────────────────
// When YHA_GO_OWNS_MCP=1, the Go core is authoritative for the MCP pool.
// callMcpTool / startMcpServer / stopMcpServer all proxy through Go's
// /v1/mcp/* endpoints in that mode. When the flag is unset (default,
// pre-cutover), the original in-process implementations run unchanged.
//
// The poller below also runs only when the flag is set — it keeps Node's
// in-memory mcpConnections Map in sync with Go's view of /v1/mcp/state
// so existing callers reading conn.tools / conn.ok continue to work.

function _goOwnsMcp(): boolean {
  return process.env.YHA_GO_OWNS_MCP === '1';
}

function _goCoreUrl(): string {
  return process.env.YHA_GO_CORE_URL || 'http://127.0.0.1:8443';
}

function _bridgeKey(): string {
  return state.BRIDGE_INTERNAL_KEY || '';
}

// ── Internal-key injection gate ───────────────────────────────────────────────
// BRIDGE_INTERNAL_KEY grants /internal/* + /proxy/* authority. Only first-party
// MCP scripts shipped under bridge/mcp/ may receive it. Third-party servers
// configured in mcp-registry.json must NOT inherit it, or a malicious/compromised
// server could write through the bridge as if it were trusted code.
const _path = require('path');
const _BRIDGE_DIR = _path.resolve(__dirname, '../../..'); // bridge/modules/mcp-client/lib -> bridge/
const _FIRST_PARTY_MCP_DIR = _path.join(_BRIDGE_DIR, 'mcp');

function _isFirstPartyMcp(cfg): boolean {
  const args = Array.isArray(cfg?.args) ? cfg.args : [];
  for (const a of args) {
    if (typeof a !== 'string') continue;
    if (!/\.(c?js|mjs|ts)$/i.test(a)) continue;
    // Resolve relative args (e.g. "./mcp/important-server.js") against the
    // bridge dir, not process.cwd(), so detection is cwd-independent.
    const resolved = _path.resolve(_BRIDGE_DIR, a);
    if (resolved === _FIRST_PARTY_MCP_DIR || resolved.startsWith(_FIRST_PARTY_MCP_DIR + _path.sep)) {
      return true;
    }
  }
  return false;
}

// Build the env for an MCP child. Both bridge-authority secrets —
// BRIDGE_INTERNAL_KEY *and* its master YHA_BRIDGE_KEY (they are the same value
// in shared-key deployments) — are stripped for third-party servers so a
// malicious/compromised child can't replay the secret against /internal/*,
// /proxy/*, or go-core's /v1/mcp/call. First-party scripts shipped under
// bridge/mcp/ keep them. Mirrors go-core's util.go:filterBridgeSecrets so the
// Node and Go pools enforce the same trust boundary.
function _mcpChildEnv(cfg) {
  const env = { ...process.env, ...(cfg?.env || {}) };
  if (_isFirstPartyMcp(cfg)) {
    if (state.BRIDGE_INTERNAL_KEY) env.BRIDGE_INTERNAL_KEY = state.BRIDGE_INTERNAL_KEY;
  } else {
    delete env.BRIDGE_INTERNAL_KEY;
    delete env.YHA_BRIDGE_KEY;
  }
  return env;
}

function isMcpConnAlive(conn): boolean {
  if (!conn) return false;
  if (conn.transport === 'http') return conn.ok === true && !!conn.http?.url;
  return !!(conn.proc && conn.proc.exitCode === null && !conn.proc.killed && conn.send);
}


async function _postGo(path: string, body: any): Promise<any> {
  const res = await fetch(`${_goCoreUrl()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bridge-key': _bridgeKey(),
    },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    throw new Error(`Go ${path} failed: ${msg}`);
  }
  return data;
}

// Stable 8-char hash of a tool description string. Stamped onto telemetry
// events as `desc_v` so when we rewrite a description the resulting change in
// usage patterns can be attributed to the new wording (A/B-style). Empty
// description → 'none'. SHA1 is fine here — not a security boundary, just an
// identity tag for grouping.
function _descHash(desc: string): string {
  if (!desc) return 'none';
  return crypto.createHash('sha1').update(desc).digest('hex').slice(0, 8);
}

// ── Shared Buffer-based MCP frame parser ──────────────────────────────────────
// Content-Length is a BYTE count; string .length would miscount non-ASCII chars
function parseMcpFrames(buf, onMsg) {
  while (true) {
    const sep = buf.indexOf(Buffer.from('\r\n\r\n'));
    if (sep === -1) break;
    const header = buf.slice(0, sep).toString('ascii');
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      buf = buf.slice(sep + 4);
      continue;
    }
    const len = +m[1],
      bodyStart = sep + 4;
    if (buf.length < bodyStart + len) break;
    let msg;
    try {
      msg = JSON.parse(buf.slice(bodyStart, bodyStart + len).toString());
    } catch (_) {}
    buf = buf.slice(bodyStart + len);
    if (msg) onMsg(msg);
  }
  return buf;
}

// ── Query a stdio MCP server for its tool list (used by buildToolGroups) ──────
async function queryMcpServer(name, serverCfg, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const { command, args = [] } = serverCfg;
    let proc;
    try {
      proc = spawn(command, args, {
        env: _mcpChildEnv(serverCfg),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (_) {
      return resolve([]);
    }

    let buf = Buffer.alloc(0);
    const tools: any[] = [];
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch (_) {
        try {
          proc.kill();
        } catch (_) {}
      }
      resolve(tools);
    };
    const timer = setTimeout(finish, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      buf = parseMcpFrames(buf, (msg) => {
        if (msg.result?.tools)
          for (const t of msg.result.tools) tools.push({ name: t.name, desc: t.description || '' });
      });
    });
    proc.on('error', () => {
      clearTimeout(timer);
      finish();
    });
    proc.on('close', () => {
      clearTimeout(timer);
      finish();
    });

    const send = (obj) => {
      const body = JSON.stringify(obj);
      proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    try {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'yha-bridge', version: '1.0' },
        },
      });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    } catch (_) {}
  });
}

// ── Start a persistent MCP server process ────────────────────────────────────
// YHA-owned MCP child scripts that depend on a specific module being
// loaded. The script itself runs in a separate Node process and can't
// use the in-memory module registry (`getModuleApi()` is in-process
// only), but at spawn time we know which backing module the script
// needs to require successfully. If the user disables the backing
// module in modules.json but leaves the MCP enabled in mcp-state, we
// fail fast here with a clear error rather than letting the child
// process crash with a confusing "Cannot find module" trace.
//
// Keys are the basename of the script's `args[0]` (the .js file path
// passed to `node`). Values are the module name to check.
const MCP_SCRIPT_MODULE_DEPS: Record<string, string> = {
  'websearch-server.js': 'search',
  'meta-bridge-server.js': 'skills-editor',
};

async function startMcpServer(name, cfg) {
  if (_goOwnsMcp()) {
    return _startMcpServerViaGo(name);
  }
  if ((cfg?.transport === 'http' || cfg?.url) && cfg?.transport !== 'stdio') {
    const prevHttp = mcpConnections.get(name);
    if (isMcpConnAlive(prevHttp)) return prevHttp;
    try {
      const { startHttpMcpServer } = require('./http-transport');
      const remote = await startHttpMcpServer(name, cfg);
      mcpConnections.set(name, remote);
      return remote;
    } catch (e) {
      const entry = {
        proc: null,
        transport: 'http',
        http: { url: cfg?.url, auth: cfg?.auth || 'none' },
        tools: [],
        prompts: [],
        resources: [],
        ok: false,
        error: (e as Error)?.message || String(e),
        pending: new Map(),
        nextId: 10,
        stdoutBuf: Buffer.alloc(0),
        send: null,
        _cfg: cfg,
      };
      mcpConnections.set(name, entry);
      return entry;
    }
  }

  // Idempotent: if the process is already alive and healthy, return it as-is.
  // Previously this always killed and restarted, which caused the "double-click
  // to connect" bug in BrowserWindow: the first click started the MCP and fired
  // docker compose up -d in background, then immediately started polling. The
  // second click killed the running MCP, restarted it, and since Docker was now
  // already up the new MCP connected instantly — making it look like only the
  // second click worked.
  const prev = mcpConnections.get(name);
  const prevAlive = isMcpConnAlive(prev);
  if (prevAlive && prev.ok) return prev;

  // Module-dependency gate: refuse to spawn a YHA-owned MCP child
  // whose backing module is disabled in modules.json. The child script
  // require()s the module's lib at startup and would crash; surface a
  // clean diagnostic up the API instead.
  const argv0 = Array.isArray(cfg?.args) && cfg.args.length ? cfg.args[0] : '';
  if (argv0) {
    const path = require('path');
    const scriptBase = path.basename(String(argv0));
    const requiredModule = MCP_SCRIPT_MODULE_DEPS[scriptBase];
    if (requiredModule) {
      // `getModuleApi(...)` returns undefined unless the module is
      // active. A missing entry here also returns undefined. Note
      // mcp-client itself is the caller — we're checking a sibling.
      if (!getModuleApi(requiredModule)) {
        const err = new Error(
          `MCP server "${name}" cannot start: backing module "${requiredModule}" ` +
          `is disabled in bridge/modules.json. Enable that module or remove ` +
          `"${name}" from your MCP autostart list.`
        );
        const state = {
          proc: null,
          tools: [],
          ok: false,
          startedAt: Date.now(),
          stoppedAt: Date.now(),
          stopReason: 'module-disabled',
          error: err.message,
        };
        mcpConnections.set(name, state);
        return state;
      }
    }
  }

  // Kill any stale/errored existing process before spawning a fresh one.
  if (prev?.proc) {
    try {
      process.kill(-prev.proc.pid, 'SIGTERM');
    } catch (_) {
      try {
        prev.proc.kill('SIGTERM');
      } catch (_) {}
    }
  }

  const { command, args = [] } = cfg;
  let proc;
  try {
    proc = spawn(command, args, {
      env: _mcpChildEnv(cfg),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    // Persist this child's PID so the next bridge boot can sweep it if the
    // current bridge process gets replaced (bun --watch re-exec) before
    // proc.on('exit') has a chance to fire.
    try {
      const scriptPath = Array.isArray(args) && args.length ? String(args[0]) : '';
      registerMcpPid(name, proc.pid, scriptPath);
    } catch (_) { /* registry write is best-effort */ }
  } catch (e) {
    const state = {
      proc: null,
      tools: [],
      prompts: [],
      resources: [],
      ok: false,
      error: e.message,
      pending: new Map(),
      nextId: 10,
      stdoutBuf: Buffer.alloc(0),
    };
    mcpConnections.set(name, state);
    return state;
  }

  proc.stderr?.on('data', (chunk) => {
    const text = (chunk as Buffer).toString().trim();
    if (text) logger.warn('mcp.stderr', { name, text });
  });

  const pending = new Map(); // id → { resolve, reject }
  const nextId = 10;
  let stdoutBuf = Buffer.alloc(0);

  // Persistent stdout router — handles BOTH handshake AND subsequent tool calls
  proc.stdout.on('data', (chunk) => {
    stdoutBuf = parseMcpFrames(Buffer.concat([stdoutBuf, chunk]), (msg) => {
      if (msg.id !== undefined) {
        const req = pending.get(msg.id);
        if (req) {
          pending.delete(msg.id);
          if (msg.error) req.reject(new Error(msg.error.message || 'MCP error'));
          else req.resolve(msg.result);
        }
      }
    });
    const conn = mcpConnections.get(name);
    if (conn) conn.stdoutBuf = stdoutBuf;
  });

  const mcpSend = (obj) => {
    const b = JSON.stringify(obj);
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`);
  };

  // Handshake: id 1 = initialize, id 2 = tools/list, id 3 = prompts/list, id 4 = resources/list
  const probe = await new Promise<{ tools: any[]; prompts: any[]; resources: any[] }>((resolve) => {
    let done = false;
    const result = { tools: [] as any[], prompts: [] as any[], resources: [] as any[] };
    let pendingProbes = 3;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(result);
      }
    };
    const settleOne = () => { if (--pendingProbes <= 0) { clearTimeout(timer); finish(); } };
    const timer = setTimeout(finish, 10000);

    pending.set(1, { resolve: () => {}, reject: () => {} });
    pending.set(2, {
      resolve: (r) => {
        result.tools = (r?.tools || []).map((t) => ({
          name: t.name,
          desc: t.description || '',
          descHash: _descHash(t.description || ''),
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
          // Carried so the gateway write-gate (lib/policy.ts) can honour the
          // server's own read-only / destructive hints before falling back to
          // the tool-name heuristic.
          annotations: t.annotations || null,
        }));
        settleOne();
      },
      reject: () => settleOne(),
    });
    pending.set(3, {
      resolve: (r) => {
        result.prompts = (r?.prompts || []).map((p) => ({
          name: p.name,
          desc: p.description || '',
          arguments: p.arguments || [],
        }));
        settleOne();
      },
      reject: () => settleOne(),
    });
    pending.set(4, {
      resolve: (r) => {
        result.resources = (r?.resources || []).map((res) => ({
          uri: res.uri,
          name: res.name || res.uri,
          desc: res.description || '',
          mimeType: res.mimeType || '',
        }));
        settleOne();
      },
      reject: () => settleOne(),
    });

    proc.on('error', () => { clearTimeout(timer); finish(); });
    proc.on('exit', () => { clearTimeout(timer); finish(); });

    try {
      mcpSend({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'yha-bridge', version: '1.0' },
        },
      });
      mcpSend({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      mcpSend({ jsonrpc: '2.0', id: 3, method: 'prompts/list', params: {} });
      mcpSend({ jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} });
    } catch (e) {
      clearTimeout(timer);
      finish();
    }
  });

  const { tools, prompts, resources } = probe;
  const alive = proc.exitCode === null && !proc.killed;
  // Process died during handshake — drop its PID from the persisted registry
  // now since the exit-handler branch below won't run.
  if (!alive) {
    try { unregisterMcpPid(proc.pid); } catch (_) {}
  }
  const exposesAny = tools.length + prompts.length + resources.length > 0;
  const state = {
    proc: alive ? proc : null,
    tools,
    prompts,
    resources,
    ok: alive && exposesAny,
    error: !alive
      ? 'Process exited during startup'
      : exposesAny
        ? null
        : 'Server started but exposes no tools, prompts, or resources',
    pending,
    nextId,
    stdoutBuf,
    send: alive ? mcpSend : null,
    // Preserved so the auto-respawn path below can call startMcpServer again
    // with the same args after a mid-call crash. Reads on subsequent boots
    // load from mcp-registry.json so we can also fall back to that.
    _cfg: cfg,
    // Set by stopMcpServer to disambiguate "user-requested teardown" from
    // "crashed mid-call" in the exit handler — only the latter triggers the
    // one-shot auto-respawn + replay.
    _userStopRequested: false,
    // Capped at one attempt per process lifetime to avoid retry storms when
    // the underlying tool is deterministically crashing on a poisoned input.
    _retriedOnce: false,
  };
  mcpConnections.set(name, state);
  // NOTE: run-state is the user's DECLARED intent (mcp-state.json disabled[]/
  // enabled[]), mutated only by the start/stop ROUTES — never derived from
  // which processes are alive. So nothing is persisted here: this same
  // startMcpServer runs for boot autostart, crash auto-respawn, and the
  // search-surface ensure, none of which should rewrite the desired set.
  if (alive) {
    proc.once('exit', (code) => {
      try { unregisterMcpPid(proc.pid); } catch (_) {}
      const cur = mcpConnections.get(name);
      if (cur?.proc !== proc) return;

      // Snapshot pending requests + reason flags before we mutate the state
      // entry. We need them whether we retry or reject.
      const pendingSnapshot = cur.pending ? new Map(cur.pending) : new Map();
      const userStopped = !!cur._userStopRequested;
      const alreadyRetried = !!cur._retriedOnce;
      const replayable = !userStopped && !alreadyRetried && pendingSnapshot.size > 0;

      mcpConnections.set(name, {
        ...cur,
        proc: null,
        ok: false,
        error: userStopped
          ? `Process stopped by user (code ${code ?? ''})`
          : `Process exited (code ${code ?? ''})`,
        send: null,
      });
      if (cur.pending) cur.pending.clear();

      // NOTE: do NOT call saveMcpState here. The auto-start list is the
      // user's intent, not a snapshot of what's currently alive. Crashes
      // (and bridge shutdowns that take MCPs down with them) should keep
      // the entry so the next bridge boot retries.

      if (!replayable) {
        // User-initiated stop OR we've already burned our retry budget.
        // Reject every in-flight call so callers see a clean error instead
        // of waiting 60s for a dead process.
        const reason = userStopped
          ? `MCP server "${name}" stopped`
          : `MCP server "${name}" exited unexpectedly`;
        for (const [, req] of pendingSnapshot) {
          try { req.reject(new Error(reason)); } catch (_) {}
        }
        return;
      }

      // Crashed mid-call — try once to respawn and replay. The model loop
      // would otherwise see a generic "exited unexpectedly" string and have
      // no way to know whether the call was retryable; this is exactly the
      // recovery case where one transparent retry buys the most.
      logger.warn('mcp.auto-respawn-attempt', { name, pending: pendingSnapshot.size });
      Promise.resolve().then(async () => {
        try {
          const fresh = await startMcpServer(name, cur._cfg);
          if (!fresh?.send || !fresh.proc) {
            const reason = fresh?.error || 'auto-respawn failed';
            for (const [, req] of pendingSnapshot) {
              try { req.reject(new Error(`MCP server "${name}" crashed mid-call and could not respawn: ${reason}`)); } catch (_) {}
            }
            return;
          }
          // Latch the retry-budget on the fresh entry so a second crash
          // during replay falls through to the normal reject path.
          fresh._retriedOnce = true;
          for (const [, req] of pendingSnapshot) {
            if (!req._replay) {
              // Pending entry was created by something other than the
              // tool-call path (e.g. rpcRequest) — we don't have a payload
              // to replay, so fail it with a clear reason.
              try { req.reject(new Error(`MCP server "${name}" crashed mid-call; could not replay (no payload preserved)`)); } catch (_) {}
              continue;
            }
            try {
              const result = await _callMcpToolRaw(name, req._replay.toolName, req._replay.args);
              req.resolve(result);
            } catch (e) {
              try { req.reject(e); } catch (_) {}
            }
          }
        } catch (e) {
          for (const [, req] of pendingSnapshot) {
            try { req.reject(new Error(`MCP server "${name}" crashed mid-call and could not respawn: ${(e as Error)?.message || String(e)}`)); } catch (_) {}
          }
        }
      });
    });
  }
  return state;
}

function stopMcpServer(name) {
  if (_goOwnsMcp()) {
    return _stopMcpServerViaGo(name);
  }
  const entry = mcpConnections.get(name);
  if (entry?.transport === 'http') {
    entry._userStopRequested = true;
    mcpConnections.set(name, {
      ...entry,
      ok: false,
      error: null,
      tools: entry.tools || [],
      prompts: entry.prompts || [],
      resources: entry.resources || [],
    });
    return { stopped: true };
  }
  // Mark the user-stop intent BEFORE killing the process so the `exit`
  // handler picks the right reject reason and skips the auto-respawn.
  if (entry) entry._userStopRequested = true;
  if (entry?.proc) {
    try {
      process.kill(-entry.proc.pid, 'SIGTERM');
    } catch (_) {
      try {
        entry.proc.kill('SIGTERM');
      } catch (_) {}
    }
  }
  mcpConnections.set(name, {
    proc: null,
    tools: entry?.tools || [],
    prompts: entry?.prompts || [],
    resources: entry?.resources || [],
    ok: false,
    error: null,
    pending: new Map(),
    nextId: 10,
    stdoutBuf: Buffer.alloc(0),
    send: null,
  });
  // Intent (move to disabled[]) is recorded by the /stop route, not here —
  // stopMcpServer also runs for the search-surface ensure and worker teardown.
  return { stopped: true };
}

// ── Go-delegated lifecycle (Phase 4 cutover) ────────────────────────────────
// Both shapes intentionally match what the in-process implementations
// above return so callers (server.ts boot, frontend MCP tab routes,
// etc.) don't care which path was taken.

async function _startMcpServerViaGo(name: string): Promise<any> {
  let data: any;
  try {
    data = await _postGo('/v1/mcp/start', { name });
  } catch (e) {
    // Surface the error inline on the connection entry so the MCP tab
    // sees something useful rather than swallowing it.
    const entry = {
      proc: null,
      tools: [],
      prompts: [],
      resources: [],
      ok: false,
      error: (e as Error).message,
      pending: new Map(),
      nextId: 10,
      stdoutBuf: Buffer.alloc(0),
      send: null,
    };
    mcpConnections.set(name, entry);
    return entry;
  }
  // The Go side keeps the authoritative pool; poll the /v1/mcp/state
  // endpoint once after a start so we reflect the new "running" set
  // (and pick up the freshly-handshook tool list).
  await _refreshFromGoState().catch(() => undefined);
  const updated = mcpConnections.get(name) || {
    proc: null,
    tools: [],
    prompts: [],
    resources: [],
    ok: !!data?.ok,
    error: data?.error || null,
    pending: new Map(),
    nextId: 10,
    stdoutBuf: Buffer.alloc(0),
    send: null,
  };
  return updated;
}

async function _stopMcpServerViaGo(name: string): Promise<any> {
  try {
    await _postGo('/v1/mcp/stop', { name });
  } catch (e) {
    logger.warn('mcp.go.stop.failed', { name, error: (e as Error).message });
  }
  // Clear the local cache entry immediately; the next poll will reconcile.
  const entry = mcpConnections.get(name);
  mcpConnections.set(name, {
    proc: null,
    tools: entry?.tools || [],
    prompts: entry?.prompts || [],
    resources: entry?.resources || [],
    ok: false,
    error: null,
    pending: new Map(),
    nextId: 10,
    stdoutBuf: Buffer.alloc(0),
    send: null,
  });
  return { stopped: true };
}

// ── Go state poller (Phase 4 cutover) ───────────────────────────────────────
// When Go owns the MCP pool, Node still publishes mcpConnections to its
// own modules (mcp-client routes, frontend MCP tab, telemetry desc-hash
// lookup). We keep that Map in sync by polling Go's /v1/mcp/state every
// 5s while YHA_GO_OWNS_MCP=1. The Map's entries lose `proc`/`send` —
// no local stdio in Go-owned mode — but `tools`/`ok`/`error` track Go.

let _pollerTimer: ReturnType<typeof setInterval> | null = null;

async function _refreshFromGoState(): Promise<void> {
  if (!_goOwnsMcp()) return;
  let res: Response;
  try {
    res = await fetch(`${_goCoreUrl()}/v1/mcp/state`, {
      headers: { 'x-bridge-key': _bridgeKey() },
    });
  } catch (e) {
    logger.warn('mcp.go.state.fetch-failed', { error: (e as Error).message });
    return;
  }
  if (!res.ok) {
    logger.warn('mcp.go.state.bad-status', { status: res.status });
    return;
  }
  let data: any;
  try { data = await res.json(); } catch (e) {
    logger.warn('mcp.go.state.parse-failed', { error: (e as Error).message });
    return;
  }
  const running: string[] = Array.isArray(data?.running) ? data.running : [];
  const servers: any[] = Array.isArray(data?.servers) ? data.servers : [];
  // Fetch the tool listing once per poll so the cache carries the
  // descriptions every consumer expects. Best-effort: if /v1/mcp/tools
  // is unreachable we keep whatever tools we last had.
  let toolsByServer: Record<string, any[]> = {};
  try {
    const toolsRes = await fetch(`${_goCoreUrl()}/v1/mcp/tools`, {
      headers: { 'x-bridge-key': _bridgeKey() },
    });
    if (toolsRes.ok) {
      const toolsData: any = await toolsRes.json();
      toolsByServer = toolsData?.servers || {};
    }
  } catch (_) { /* keep stale tools */ }

  const runningSet = new Set(running);
  for (const s of servers) {
    const name = String(s.name || '');
    if (!name) continue;
    const goTools: any[] = Array.isArray(toolsByServer[name]) ? toolsByServer[name] : [];
    const mapped = goTools.map((t) => ({
      name: t.name,
      desc: t.description || '',
      descHash: _descHash(t.description || ''),
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      annotations: t.annotations || null,
    }));
    const prev = mcpConnections.get(name) || {};
    mcpConnections.set(name, {
      ...prev,
      proc: null,
      tools: mapped.length ? mapped : (prev.tools || []),
      prompts: prev.prompts || [],
      resources: prev.resources || [],
      ok: !!s.ok && runningSet.has(name),
      error: s.error || null,
      pending: prev.pending || new Map(),
      nextId: prev.nextId || 10,
      stdoutBuf: prev.stdoutBuf || Buffer.alloc(0),
      send: null,
    });
  }
  // Drop stale entries for servers Go no longer reports.
  const seen = new Set<string>(servers.map((s) => String(s.name || '')));
  for (const key of Array.from(mcpConnections.keys()) as string[]) {
    if (!seen.has(key)) {
      mcpConnections.delete(key);
    }
  }
}

// startGoStatePoller / stopGoStatePoller are wired into the mcp-client
// module's activate/deactivate lifecycle (see ../index.ts). The interval
// is a const so a future env knob can override it without touching the
// rest of the file.
const GO_STATE_POLL_INTERVAL_MS = 5000;

function startGoStatePoller(): void {
  if (!_goOwnsMcp() || _pollerTimer) return;
  // Kick once immediately so the cache is non-empty on first request.
  _refreshFromGoState().catch(() => undefined);
  _pollerTimer = setInterval(() => {
    _refreshFromGoState().catch((e) => {
      logger.warn('mcp.go.state.poll-error', { error: (e as Error).message });
    });
  }, GO_STATE_POLL_INTERVAL_MS);
  // Don't keep the process alive just for the poller — graceful
  // shutdown should be able to exit even when the timer is queued.
  if (typeof (_pollerTimer as any).unref === 'function') {
    (_pollerTimer as any).unref();
  }
  logger.info('mcp.go.state.poller-started', { intervalMs: GO_STATE_POLL_INTERVAL_MS });
}

function stopGoStatePoller(): void {
  if (_pollerTimer) {
    clearInterval(_pollerTimer);
    _pollerTimer = null;
  }
}

// ── Desired-state supervisor ──────────────────────────────────────────────────
// Keeps the live pool reconciled to the user's declared desired-ON set
// (registry default ± explicit enable/disable in mcp-state.json). A server that
// is desired-ON but not alive — because it failed to start, crashed while idle,
// or never came back after a partial restart — is (re)started here with capped
// backoff so a deterministically-crashing server can't spin. A server the user
// stopped is in disabled[], so it is NOT desired-ON and the supervisor leaves
// it down. After the attempt budget is spent the last error is left on the
// connection entry, which the prefs MCP tab surfaces. This is the "restart, or
// eventually show an error" half; the separate mid-call auto-respawn in the
// exit handler stays for the narrower "replay the in-flight call" case.
const SUPERVISOR_INTERVAL_MS = 15_000;
const SUPERVISOR_MAX_ATTEMPTS = 5;
const SUPERVISOR_BASE_BACKOFF_MS = 5_000;
const SUPERVISOR_MAX_BACKOFF_MS = 5 * 60_000;

interface SupervisorEntry { attempts: number; nextEarliest: number; lastError: string | null }
const _supervisorBudget = new Map<string, SupervisorEntry>();
let _supervisorTimer: ReturnType<typeof setInterval> | null = null;

// Give a server a clean retry budget — called when the user explicitly starts
// it from the MCP tab so a manual "Start" always gets fresh attempts even after
// the background budget was exhausted.
function clearSupervisorBackoff(name: string): void {
  if (name) _supervisorBudget.delete(name);
}

async function reconcileDesiredState(): Promise<void> {
  if (_goOwnsMcp()) return; // Go owns the pool in cutover mode — its own loop reconciles.
  let desired: string[];
  let reg: Record<string, any>;
  try {
    const stateLib = require('./state');
    desired = stateLib.getDesiredOnServers();
    reg = stateLib.readUpstreamRegistry().mcpServers || {};
  } catch (_) {
    return;
  }
  const desiredSet = new Set(desired);
  // Forget budget bookkeeping for servers no longer desired-ON so a later
  // re-enable starts clean.
  for (const name of Array.from(_supervisorBudget.keys())) {
    if (!desiredSet.has(name)) _supervisorBudget.delete(name);
  }

  const now = Date.now();
  for (const name of desired) {
    const conn = mcpConnections.get(name);
    const alive = isMcpConnAlive(conn);
    if (alive) {
      _supervisorBudget.delete(name); // healthy — reset budget
      continue;
    }
    const cfg = reg[name];
    if (!cfg) continue;
    let sv = _supervisorBudget.get(name);
    if (!sv) { sv = { attempts: 0, nextEarliest: 0, lastError: null }; _supervisorBudget.set(name, sv); }
    if (sv.attempts >= SUPERVISOR_MAX_ATTEMPTS) continue; // budget spent — error stays on the conn entry
    if (now < sv.nextEarliest) continue;

    sv.attempts++;
    sv.nextEarliest = now + Math.min(SUPERVISOR_BASE_BACKOFF_MS * 2 ** (sv.attempts - 1), SUPERVISOR_MAX_BACKOFF_MS);
    logger.info('mcp.supervisor.restart', { name, attempt: sv.attempts, max: SUPERVISOR_MAX_ATTEMPTS });
    try {
      const fresh = await startMcpServer(name, cfg);
      const freshAlive = isMcpConnAlive(fresh);
      if (freshAlive && (fresh.ok || (fresh.tools?.length ?? 0) > 0)) {
        _supervisorBudget.delete(name); // back up — clear the budget
      } else {
        sv.lastError = fresh?.error || 'start did not yield a running server';
      }
    } catch (e) {
      sv.lastError = (e as Error)?.message || String(e);
      logger.warn('mcp.supervisor.restart-failed', { name, attempt: sv.attempts, error: sv.lastError });
    }
  }
}

function startMcpSupervisor(): void {
  if (_goOwnsMcp() || _supervisorTimer) return;
  _supervisorTimer = setInterval(() => {
    reconcileDesiredState().catch((e) => {
      logger.warn('mcp.supervisor.tick-error', { error: (e as Error)?.message || String(e) });
    });
  }, SUPERVISOR_INTERVAL_MS);
  // Don't keep the event loop alive just for the supervisor.
  if (typeof (_supervisorTimer as any).unref === 'function') (_supervisorTimer as any).unref();
  logger.info('mcp.supervisor.started', { intervalMs: SUPERVISOR_INTERVAL_MS });
}

function stopMcpSupervisor(): void {
  if (_supervisorTimer) {
    clearInterval(_supervisorTimer);
    _supervisorTimer = null;
  }
}

// ── Call a tool on a running MCP server via its persistent stdin/stdout ───────
// Wrapped in telemetry.track so every MCP call is observable in the
// "Tools, Skills & MCP" monitoring panel. Memory-flavoured surfaces
// (knowledge-memory, important, todos) are double-tagged with a `memory`
// surface event carrying op=read|write|delete so the panel can compute
// read-after-write ratios — the metric we use to spot write-only memory.
async function callMcpTool(serverName, toolName, args): Promise<any> {
  const telemetry = getModuleApi('observability-plus')?.telemetry;
  const argsSize = (() => { try { return JSON.stringify(args || {}).length; } catch { return 0; } })();
  const memoryOp = _classifyMemoryOp(serverName, toolName);
  // Look up the tool's current description hash so we can attribute usage to
  // a specific description version. Falls back to 'unknown' if the tool has
  // not been listed yet (rare — handshake populates it).
  const conn = mcpConnections.get(serverName);
  const toolMeta = (conn?.tools || []).find((t) => t.name === toolName);
  const descV = toolMeta?.descHash || 'unknown';
  // Underlying dispatch: Go owns it in Phase 4 cutover, otherwise the
  // local persistent-stdio code path. Telemetry/memory wrapping stays
  // on the Node side regardless so the existing dashboards keep working
  // even after the protocol layer moves.
  const dispatch = () =>
    _goOwnsMcp()
      ? _callMcpToolViaGo(serverName, toolName, args)
      : _callMcpToolRaw(serverName, toolName, args);
  // When observability-plus is disabled, skip telemetry wrapping entirely —
  // the underlying tool call still runs.
  const tracked = telemetry?.track
    ? telemetry.track(
        'mcp',
        `${serverName}/${toolName}`,
        dispatch,
        { argsSize, meta: { server: serverName, tool: toolName, desc_v: descV } }
      )
    : dispatch();
  return tracked.then((result) => {
    if (memoryOp) {
      telemetry?.record?.({
        surface: 'memory',
        name: `${serverName}/${toolName}`,
        durationMs: 0,
        ok: true,
        argsSize,
        resultSize: 0,
        meta: { op: memoryOp, server: serverName, tool: toolName, desc_v: descV },
      });
    }
    return result;
  }).catch((err) => {
    if (memoryOp) {
      telemetry?.record?.({
        surface: 'memory',
        name: `${serverName}/${toolName}`,
        durationMs: 0,
        ok: false,
        argsSize,
        meta: { op: memoryOp, server: serverName, tool: toolName, desc_v: descV, error: String((err as Error)?.message || err) },
      });
    }
    throw err;
  });
}

// Go-delegated dispatch (Phase 4 cutover). The Go endpoint enforces its
// own 60s budget per call, so we don't layer a second timeout here; the
// HTTP request just returns whatever Go decided.
async function _callMcpToolViaGo(serverName, toolName, args): Promise<any> {
  const data = await _postGo('/v1/mcp/call', {
    server: serverName,
    tool: toolName,
    arguments: args || {},
  });
  if (!data?.ok) {
    throw new Error(data?.error || `MCP call failed (${serverName}/${toolName})`);
  }
  return data.result;
}

// Servers whose tools can take several minutes (e.g. audio/video generation,
// long-running agent tools). Mirrors slowServerTimeouts in
// go-core/internal/mcp/routes.go — keep them in sync.
const _slowServerTimeoutMs: Record<string, number> = {
  'media-gen': 5 * 60 * 1000,
  'agent-tools': 20 * 60 * 1000,
};

// Plain JSON-RPC dispatch — no telemetry wrapping. Kept private; the only
// public callers go through callMcpTool so every call is recorded.
function _callMcpToolRaw(serverName, toolName, args): Promise<any> {
  const conn = mcpConnections.get(serverName);
  if (conn?.transport === 'http') {
    if (!isMcpConnAlive(conn)) throw new BridgeNotFoundError(`MCP server "${serverName}" is not running`, { serverName });
    const { callHttpMcpTool } = require('./http-transport');
    return callHttpMcpTool(conn, toolName, args);
  }
  if (!conn?.send || !conn.proc || conn.proc.exitCode !== null || conn.proc.killed)
    throw new BridgeNotFoundError(`MCP server "${serverName}" is not running`, { serverName });

  const timeoutMs = _slowServerTimeoutMs[serverName] ?? 60000;
  return new Promise((resolve, reject) => {
    const id = conn.nextId++;
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP tool call timed out: ${serverName}/${toolName}`));
    }, timeoutMs);

    conn.pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
      // Carried so the exit-handler's one-shot auto-respawn can re-issue
      // this same call against the fresh process instead of giving up.
      _replay: { toolName, args },
    });

    try {
      conn.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      });
    } catch (e) {
      conn.pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

// Classify memory-flavoured MCP calls. Anything that returns `null` is just
// a normal MCP call — only knowledge-memory, important, and bridge.todos go
// through the memory aggregator so the read-after-write ratio is meaningful.
function _classifyMemoryOp(server: string, tool: string): 'read' | 'write' | 'delete' | null {
  if (server === 'knowledge-memory') {
    if (/^(read_|list_|search_|query_)/.test(tool)) return 'read';
    if (/^(write_|append_|build_|synthesize)/.test(tool)) return 'write';
    return null;
  }
  if (server === 'important') {
    if (tool === 'important_read' || tool === 'read') return 'read';
    if (tool === 'important_remove' || tool === 'remove') return 'delete';
    return 'write';
  }
  // The MCP-Tools bridge surface exposes "TodoRead" and "TodoWrite". The
  // names already encode the op.
  if (tool === 'TodoRead') return 'read';
  if (tool === 'TodoWrite') return 'write';
  return null;
}

// ── Refresh cached tools / prompts for a running MCP connection ───────────
// Used by the Meta Bridge after CRUD mutations so that conn.tools / conn.prompts
// (read by the aggregator at bridge.ts) reflect the latest state without a
// server restart.

async function rpcRequest(serverName, method, params, timeoutMs = 5000) {
  const conn = mcpConnections.get(serverName);
  if (conn?.transport === 'http') {
    if (!isMcpConnAlive(conn)) throw new BridgeNotFoundError(`MCP server "${serverName}" is not running`, { serverName });
    const { httpRequest } = require('./http-transport');
    return httpRequest(conn, method, params, timeoutMs);
  }
  if (!conn?.send || !conn.proc || conn.proc.exitCode !== null || conn.proc.killed)
    throw new BridgeNotFoundError(`MCP server "${serverName}" is not running`, { serverName });

  return new Promise((resolve, reject) => {
    const id = conn.nextId++;
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP ${method} timed out: ${serverName}`));
    }, timeoutMs);

    conn.pending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });

    try {
      conn.send({ jsonrpc: '2.0', id, method, params: params || {} });
    } catch (e) {
      conn.pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

async function refreshMcpTools(serverName) {
  try {
    const result: any = await rpcRequest(serverName, 'tools/list', {});
    const conn = mcpConnections.get(serverName);
    if (conn) {
      conn.tools = (result?.tools || []).map((t) => ({
        name: t.name,
        desc: t.description || '',
        descHash: _descHash(t.description || ''),
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        annotations: t.annotations || null,
      }));
    }
    return conn?.tools || [];
  } catch (e) {
    logger.warn('mcp.refresh.tools.failed', { name: serverName, error: (e as Error).message });
    return null;
  }
}

async function refreshMcpPrompts(serverName) {
  try {
    const result: any = await rpcRequest(serverName, 'prompts/list', {});
    const conn = mcpConnections.get(serverName);
    if (conn) {
      conn.prompts = (result?.prompts || []).map((p) => ({
        name: p.name,
        desc: p.description || '',
        arguments: p.arguments || [],
      }));
    }
    return conn?.prompts || [];
  } catch (e) {
    logger.warn('mcp.refresh.prompts.failed', { name: serverName, error: (e as Error).message });
    return null;
  }
}

module.exports = {
  parseMcpFrames,
  queryMcpServer,
  startMcpServer,
  stopMcpServer,
  callMcpTool,
  refreshMcpTools,
  refreshMcpPrompts,
  // Phase 4 Go-cutover lifecycle hooks. No-op when YHA_GO_OWNS_MCP is unset.
  startGoStatePoller,
  stopGoStatePoller,
  // Desired-state supervisor: restarts desired-ON servers that aren't alive.
  startMcpSupervisor,
  stopMcpSupervisor,
  reconcileDesiredState,
  clearSupervisorBackoff,
  isMcpConnAlive,
};
