// Internal-routes smoke tests for the Go-callback endpoints added in Phase 2
// of GO-Ownership-Plan.md. Stand-alone so the bridge doesn't need a test
// runner — invoke with:
//   tsx bridge/__tests__/internal-routes.test.ts
//
// Spins up a tiny express app with the new /internal/* routes plus
// /proxy/tool, registers fake observability-plus + context-generator module
// handles in the registry, and exercises every route end-to-end.

'use strict';

const http = require('http');
const express = require('express');

// Lock the bridge-internal key BEFORE state.ts is required so tests don't
// race against the random key. state.ts reads from process.env.BRIDGE_INTERNAL_KEY
// only as a write target (it always generates fresh), so we capture the
// generated key after first import.
const { BRIDGE_INTERNAL_KEY } = require('../core/state');

const registry = require('../core/modules/registry');
const { registerInternalRoutes } = require('../routes/internal');
const { registerMcpBridgeRoutes } = require('../modules/mcp-client/lib/bridge');

// ── Test harness ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEq(label: string, actual: any, expected: any) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`);
    console.log(`  ✗ ${label}`);
  }
}
function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? '\n    ' + detail : ''}`);
    console.log(`  ✗ ${label}`);
  }
}

interface ReqOpts {
  body?: any;
  headers?: Record<string, string>;
}
function request(method: string, urlPath: string, opts: ReqOpts = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL('http://localhost' + urlPath);
    const headers: any = { ...(opts.headers || {}) };
    let bodyBuf: Buffer | null = null;
    if (opts.body !== undefined) {
      bodyBuf = Buffer.from(JSON.stringify(opts.body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(bodyBuf.length);
    }
    const req = http.request(
      {
        method,
        hostname: '127.0.0.1',
        port: (server.address() as any).port,
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk.toString('utf8');
        });
        res.on('end', () => {
          let body: any = null;
          try { body = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode || 0, body, raw });
        });
      },
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Fake module API spies ─────────────────────────────────────────────────

const telemetrySpy: any[] = [];
const recordCostSpy: any[] = [];
const recordTokensSpy: any[] = [];
const autoTitleSpy: string[] = [];
const proxyToolSpy: any[] = [];

// Stub observability-plus module so /internal/cost-event has a sink.
registry.set({
  name: 'observability-plus',
  state: 'active',
  manifest: { name: 'observability-plus', version: 'test', kind: 'bridge' },
  api: {
    name: 'observability-plus',
    telemetry: {
      record: (ev: any) => { telemetrySpy.push(ev); },
    },
    recordCost: (cost: number, model: string, provider: string) => {
      recordCostSpy.push({ cost, model, provider });
    },
    recordTokens: (args: any) => { recordTokensSpy.push(args); },
  },
  loadedAt: Date.now(),
});

// Stub context-generator module so /internal/auto-title has a trigger.
registry.set({
  name: 'context-generator',
  state: 'active',
  manifest: { name: 'context-generator', version: 'test', kind: 'bridge' },
  api: {
    name: 'context-generator',
    enqueueForAutoTitle: (sid: string) => { autoTitleSpy.push(sid); },
  },
  loadedAt: Date.now(),
});

// Stub sessions-internal so /internal/persist-broadcast-message has a sink
// without dragging the real persistence stack (filesystem, debounced saves)
// into this smoke test. Mirrors the pushDisplayMsg + rebuildSessionChatHistory
// contract used by the Node-side broadcast runner.
const persistBroadcastPushSpy: any[] = [];
const persistBroadcastRebuildSpy: string[] = [];
const finalizeAbandonedSpy: any[] = [];
{
  const sessionsInternal = require('../sessions-internal');
  sessionsInternal.pushDisplayMsg = (
    sid: string,
    role: string,
    text: any,
    blocks: any,
    meta: any,
  ) => {
    persistBroadcastPushSpy.push({ sid, role, text, blocks, meta });
  };
  sessionsInternal.rebuildSessionChatHistory = (sid: string) => {
    persistBroadcastRebuildSpy.push(sid);
  };
  sessionsInternal.finalizeAbandonedLiveMsgs = (sid: string, reason: string, force: boolean) => {
    finalizeAbandonedSpy.push({ sid, reason, force });
    return true;
  };
}

// Patch the bridge tools/exec module so /proxy/tool calls a spy instead of
// hitting real tool dispatch (which would shell out, write files, etc.).
// We swap the export on the cached module — exec.ts is `module.exports = ...`
// so reassigning `executeBridgeTool` flows to the requirer.
{
  const execMod = require('../tools/exec');
  execMod.executeBridgeTool = async (name: string, input: any, cwd: any, modelId: any, sessionId: any) => {
    proxyToolSpy.push({ name, input, cwd, modelId, sessionId });
    return `stubbed:${name}`;
  };
}

// ── Boot the test app ────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '5mb' }));
registerInternalRoutes(app);
registerMcpBridgeRoutes(app);
const server = http.createServer(app);

const goodHeaders = { 'x-bridge-key': BRIDGE_INTERNAL_KEY };

// ── Tests ────────────────────────────────────────────────────────────────

async function run() {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  console.log(`\nInternal-routes smoke tests — port ${(server.address() as any).port}\n`);

  // ── 1. /internal/tool-catalog ────────────────────────────────────────
  console.log('/internal/tool-catalog');
  {
    const r = await request('POST', '/internal/tool-catalog', { headers: goodHeaders });
    assertEq('200 with valid bridge key', r.status, 200);
    assertEq('success=true', r.body?.success, true);
    assert('tools is an array', Array.isArray(r.body?.tools));
    assert('version is sha256 hex', typeof r.body?.version === 'string' && /^[a-f0-9]{64}$/.test(r.body.version));
    // Built-ins excluded by default — none of the 13 BRIDGE_TOOL_DEFS_STATIC
    // entries should be there without the opt-in flag.
    const names = r.body.tools.map((t: any) => t.name);
    assert('no builtin Read by default', !names.includes('Read'));
    assert('no builtin Bash by default', !names.includes('Bash'));
    // Every entry has the required shape.
    if (r.body.tools.length) {
      const sample = r.body.tools[0];
      assert('entry has name', typeof sample.name === 'string');
      assert('entry has description', typeof sample.description === 'string');
      assert('entry has parameters', typeof sample.parameters === 'object');
      assert('entry has source', typeof sample.source === 'string' && (sample.source === 'builtin' || sample.source.startsWith('mcp:') || sample.source.startsWith('module:')));
    }
  }
  {
    const r = await request('POST', '/internal/tool-catalog?include_builtins=1', { headers: goodHeaders });
    assertEq('200 with include_builtins', r.status, 200);
    const names = r.body.tools.map((t: any) => t.name);
    assert('Read present with include_builtins', names.includes('Read'));
    assert('Bash present with include_builtins', names.includes('Bash'));
    assert('Write present with include_builtins', names.includes('Write'));
    assert('TodoRead present with include_builtins', names.includes('TodoRead'));
  }
  {
    const r = await request('POST', '/internal/tool-catalog', {});
    assertEq('401 with missing key', r.status, 401);
    assertEq('error message', r.body?.error, 'bad bridge key');
  }
  {
    const r = await request('POST', '/internal/tool-catalog', { headers: { 'x-bridge-key': 'wrong-key' } });
    assertEq('401 with wrong key', r.status, 401);
  }
  {
    // Version stability: same input → same hash.
    const a = await request('POST', '/internal/tool-catalog', { headers: goodHeaders });
    const b = await request('POST', '/internal/tool-catalog', { headers: goodHeaders });
    assertEq('version is stable across calls', a.body.version, b.body.version);
  }

  // ── 2. /internal/cost-event ──────────────────────────────────────────
  console.log('/internal/cost-event');
  {
    telemetrySpy.length = 0;
    recordCostSpy.length = 0;
    recordTokensSpy.length = 0;
    const r = await request('POST', '/internal/cost-event', {
      headers: goodHeaders,
      body: {
        sessionId: 'sess-1',
        model: 'claude-sonnet-4-6',
        provider: 'Anthropic',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 200,
        cacheCreationTokens: 10,
        cost: 0.0042,
        toolCallCount: 2,
        durationMs: 1500,
      },
    });
    assertEq('200 valid body', r.status, 200);
    assertEq('success=true', r.body?.success, true);
    assertEq('telemetry recorded once', telemetrySpy.length, 1);
    assertEq('telemetry surface', telemetrySpy[0]?.surface, 'stream-finalize');
    assertEq('telemetry name', telemetrySpy[0]?.name, 'claude-sonnet-4-6');
    assertEq('telemetry durationMs', telemetrySpy[0]?.durationMs, 1500);
    assertEq('telemetry meta.sessionId', telemetrySpy[0]?.meta?.sessionId, 'sess-1');
    assertEq('telemetry meta.inputTokens', telemetrySpy[0]?.meta?.inputTokens, 100);
    assertEq('telemetry meta.cost', telemetrySpy[0]?.meta?.cost, 0.0042);
    assertEq('recordCost called', recordCostSpy.length, 1);
    assertEq('recordCost cost value', recordCostSpy[0]?.cost, 0.0042);
    assertEq('recordTokens called', recordTokensSpy.length, 1);
    assertEq('recordTokens inputTokens', recordTokensSpy[0]?.inputTokens, 100);
  }
  {
    const r = await request('POST', '/internal/cost-event', { headers: {}, body: { sessionId: 's', model: 'm' } });
    assertEq('401 missing key', r.status, 401);
  }
  {
    const r = await request('POST', '/internal/cost-event', { headers: goodHeaders, body: { model: 'm' } });
    assertEq('400 missing sessionId', r.status, 400);
  }
  {
    const r = await request('POST', '/internal/cost-event', { headers: goodHeaders, body: { sessionId: 's' } });
    assertEq('400 missing model', r.status, 400);
  }
  {
    // Disable the module mid-test to verify the 503 branch, then restore.
    const handle = registry.get('observability-plus');
    registry.remove('observability-plus');
    const r = await request('POST', '/internal/cost-event', {
      headers: goodHeaders,
      body: { sessionId: 's', model: 'm' },
    });
    assertEq('503 when observability-plus disabled', r.status, 503);
    assertEq('error mentions module', r.body?.error, 'observability-plus module disabled');
    registry.set(handle);
  }
  {
    // cost <= 0 should skip recordCost but still log telemetry + tokens.
    telemetrySpy.length = 0;
    recordCostSpy.length = 0;
    recordTokensSpy.length = 0;
    const r = await request('POST', '/internal/cost-event', {
      headers: goodHeaders,
      body: { sessionId: 's', model: 'm', cost: 0, inputTokens: 5, outputTokens: 5 },
    });
    assertEq('200 zero-cost ok', r.status, 200);
    assertEq('telemetry recorded for zero-cost', telemetrySpy.length, 1);
    assertEq('recordCost skipped for zero-cost', recordCostSpy.length, 0);
    assertEq('recordTokens still called', recordTokensSpy.length, 1);
  }

  // ── 3. /internal/auto-title ──────────────────────────────────────────
  console.log('/internal/auto-title');
  {
    autoTitleSpy.length = 0;
    const r = await request('POST', '/internal/auto-title', {
      headers: goodHeaders,
      body: { sessionId: 'sess-42' },
    });
    assertEq('200 valid body', r.status, 200);
    assertEq('success=true', r.body?.success, true);
    assertEq('trigger fired once', autoTitleSpy.length, 1);
    assertEq('trigger received sessionId', autoTitleSpy[0], 'sess-42');
  }
  {
    const r = await request('POST', '/internal/auto-title', { headers: {}, body: { sessionId: 's' } });
    assertEq('401 missing key', r.status, 401);
  }
  {
    const r = await request('POST', '/internal/auto-title', { headers: goodHeaders, body: {} });
    assertEq('400 missing sessionId', r.status, 400);
  }
  {
    const handle = registry.get('context-generator');
    registry.remove('context-generator');
    const r = await request('POST', '/internal/auto-title', {
      headers: goodHeaders,
      body: { sessionId: 's' },
    });
    assertEq('503 when context-generator disabled', r.status, 503);
    registry.set(handle);
  }

  // ── 4. /internal/persist-broadcast-message ───────────────────────────
  console.log('/internal/finalize-abandoned-live');
  {
    finalizeAbandonedSpy.length = 0;
    const r = await request('POST', '/internal/finalize-abandoned-live', {
      headers: goodHeaders,
      body: { sessionId: 'sess-stuck', reason: 'stopped' },
    });
    assertEq('200 valid abandoned-live body', r.status, 200);
    assertEq('abandoned-live changed=true', r.body?.changed, true);
    assertEq('abandoned-live finalized once', finalizeAbandonedSpy.length, 1);
    assertEq('abandoned-live session forwarded', finalizeAbandonedSpy[0]?.sid, 'sess-stuck');
    assertEq('abandoned-live reason forwarded', finalizeAbandonedSpy[0]?.reason, 'stopped');
    assertEq('abandoned-live force=true', finalizeAbandonedSpy[0]?.force, true);
  }
  {
    const r = await request('POST', '/internal/finalize-abandoned-live', {
      headers: goodHeaders,
      body: {},
    });
    assertEq('400 abandoned-live missing sessionId', r.status, 400);
  }

  console.log('/internal/persist-broadcast-message');
  {
    persistBroadcastPushSpy.length = 0;
    persistBroadcastRebuildSpy.length = 0;
    const r = await request('POST', '/internal/persist-broadcast-message', {
      headers: goodHeaders,
      body: {
        sessionId: 'sess-bc-1',
        employeeId: 'emp-1',
        text: 'hello from alice',
        model: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 50,
        stopReason: 'end_turn',
        author: { id: 'emp-1', name: 'Alice', role: 'Engineer', symbolColor: '#ff00aa' },
      },
    });
    assertEq('200 happy path', r.status, 200);
    assertEq('success=true', r.body?.success, true);
    assertEq('ok=true', r.body?.ok, true);
    assertEq('pushDisplayMsg called once', persistBroadcastPushSpy.length, 1);
    assertEq('push sid', persistBroadcastPushSpy[0]?.sid, 'sess-bc-1');
    assertEq('push role', persistBroadcastPushSpy[0]?.role, 'assistant');
    assertEq('push text', persistBroadcastPushSpy[0]?.text, 'hello from alice');
    assertEq('push blocks is undefined for plain text', persistBroadcastPushSpy[0]?.blocks, undefined);
    assertEq('push meta.model', persistBroadcastPushSpy[0]?.meta?.model, 'claude-opus-4-7');
    assertEq('push meta.author.id', persistBroadcastPushSpy[0]?.meta?.author?.id, 'emp-1');
    assertEq('push meta.author.name', persistBroadcastPushSpy[0]?.meta?.author?.name, 'Alice');
    assertEq('push meta.author.role', persistBroadcastPushSpy[0]?.meta?.author?.role, 'Engineer');
    assertEq('push meta.author.symbolColor', persistBroadcastPushSpy[0]?.meta?.author?.symbolColor, '#ff00aa');
    assertEq('push meta.inputTokens', persistBroadcastPushSpy[0]?.meta?.inputTokens, 100);
    assertEq('push meta.outputTokens', persistBroadcastPushSpy[0]?.meta?.outputTokens, 50);
    assertEq('push meta.stopReason', persistBroadcastPushSpy[0]?.meta?.stopReason, 'end_turn');
    assertEq('rebuild called once', persistBroadcastRebuildSpy.length, 1);
    assertEq('rebuild sid', persistBroadcastRebuildSpy[0], 'sess-bc-1');
  }
  {
    const r = await request('POST', '/internal/persist-broadcast-message', {
      headers: {},
      body: { sessionId: 's', employeeId: 'e', text: 't' },
    });
    assertEq('401 missing key', r.status, 401);
  }
  {
    const r = await request('POST', '/internal/persist-broadcast-message', {
      headers: goodHeaders,
      body: { employeeId: 'e', text: 't' },
    });
    assertEq('400 missing sessionId', r.status, 400);
  }
  {
    // Role override + employeeId-derived author fallback when author block omitted.
    persistBroadcastPushSpy.length = 0;
    persistBroadcastRebuildSpy.length = 0;
    const r = await request('POST', '/internal/persist-broadcast-message', {
      headers: goodHeaders,
      body: { sessionId: 'sess-bc-2', employeeId: 'emp-bare', text: 'no author block' },
    });
    assertEq('200 minimal body ok', r.status, 200);
    assertEq('default role assistant', persistBroadcastPushSpy[0]?.role, 'assistant');
    assertEq('author derived from employeeId', persistBroadcastPushSpy[0]?.meta?.author?.id, 'emp-bare');
  }

  // ── 5. /proxy/tool extended with sessionId ───────────────────────────
  console.log('/proxy/tool');
  {
    proxyToolSpy.length = 0;
    const r = await request('POST', '/proxy/tool', {
      headers: { 'x-bridge-key': BRIDGE_INTERNAL_KEY },
      body: { name: 'Read', input: { file_path: '/tmp/x' }, cwd: '/tmp', sessionId: 'sess-99' },
    });
    assertEq('200 valid call', r.status, 200);
    assertEq('result returned', r.body?.result, 'stubbed:Read');
    assertEq('executeBridgeTool called once', proxyToolSpy.length, 1);
    assertEq('name forwarded', proxyToolSpy[0]?.name, 'Read');
    assertEq('input forwarded', proxyToolSpy[0]?.input?.file_path, '/tmp/x');
    assertEq('cwd forwarded', proxyToolSpy[0]?.cwd, '/tmp');
    assertEq('sessionId forwarded (5th arg)', proxyToolSpy[0]?.sessionId, 'sess-99');
    assertEq('modelId stays undefined', proxyToolSpy[0]?.modelId, undefined);
  }
  {
    proxyToolSpy.length = 0;
    const r = await request('POST', '/proxy/tool', {
      headers: { 'x-bridge-key': BRIDGE_INTERNAL_KEY },
      body: { name: 'Read', input: { file_path: '/tmp/y' }, cwd: '/tmp' },
    });
    assertEq('200 without sessionId (backward compat)', r.status, 200);
    assertEq('sessionId undefined when omitted', proxyToolSpy[0]?.sessionId, undefined);
  }
  {
    const r = await request('POST', '/proxy/tool', {
      headers: { 'x-bridge-key': 'nope' },
      body: { name: 'Read', input: {} },
    });
    assertEq('401 with wrong bridge key', r.status, 401);
  }

  // ── Wrap up ──────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:\n');
    for (const f of failures) console.log('  ' + f + '\n');
  }
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Test runner crashed:', e);
  server.close();
  process.exit(1);
});
