// ── Meta Bridge HTTP routes ───────────────────────────────────────────────
// REST surface that mirrors the meta-bridge MCP server, so the prefs UI can
// drive the same storage that the LLM does. Every mutation also nudges the
// running meta-bridge MCP connection to refresh its cached tools/prompts so
// the aggregator sees changes without a server restart.
'use strict';

const meta = require('./lib');
const { getModuleApi } = require('../../core/modules');

async function refreshAggregator() {
  try {
    const mcp = getModuleApi('mcp-client');
    if (!mcp) return;
    await Promise.allSettled([
      mcp.refreshMcpTools('meta-bridge'),
      mcp.refreshMcpPrompts('meta-bridge'),
    ]);
  } catch (_) {
    // Aggregator refresh is best-effort. If meta-bridge isn't running, the
    // prefs UI still works against on-disk state.
  }
}

function userEmail(req): string {
  return req?.session?.user?.email || 'unknown';
}

function ok(res, body) { res.json({ success: true, ...body }); }
function fail(res, status, error) { res.status(status).json({ success: false, error }); }

function registerMetaBridgeRoutes(app) {
  // ── Skills ───────────────────────────────────────────────────────────────
  app.get('/v1/meta/skills/', (_req, res) => {
    try { ok(res, { skills: meta.listSkills() }); }
    catch (e) { fail(res, 500, e.message); }
  });

  app.get('/v1/meta/skills/:name', (req, res) => {
    const name = String(req.params.name || '').trim();
    const err = meta.validateName(name);
    if (err) return fail(res, 400, err);
    const sk = meta.readSkill(name);
    if (!sk) return fail(res, 404, 'not found');
    ok(res, {
      name: sk.name,
      content: sk.content,
      description: sk.description,
      references: sk.references.map((r) => r.relPath),
      mounted: meta.isMounted('skill', name),
    });
  });

  app.put('/v1/meta/skills/:name', async (req, res) => {
    const name = String(req.params.name || '').trim();
    const err = meta.validateName(name);
    if (err) return fail(res, 400, err);
    const { content, references, mount } = req.body || {};
    if (typeof content !== 'string') return fail(res, 400, 'content required');
    try {
      const existed = !!meta.readSkill(name);
      meta.writeSkill(name, content, references);
      let mounted;
      if (typeof mount === 'boolean') mounted = mount;
      else mounted = existed ? meta.isMounted('skill', name) : true;
      meta.setMount('skill', name, mounted);
      meta.audit('save_skill', name, { user: userEmail(req), mounted });
      await refreshAggregator();
      ok(res, { name, mounted });
    } catch (e) { fail(res, 400, e.message); }
  });

  app.post('/v1/meta/skills/import', async (req, res) => {
    const { source, name } = req.body || {};
    if (typeof source !== 'string' || !source) return fail(res, 400, 'source required');
    try {
      const result = meta.importSkillFromPath(source, name);
      meta.audit('import_skill', result.name, { user: userEmail(req), source: result.source, files: result.files });
      await refreshAggregator();
      ok(res, result);
    } catch (e) { fail(res, 400, e.message); }
  });

  app.get('/v1/meta/hermeshub/skills', async (_req, res) => {
    try {
      ok(res, { skills: await meta.listHermesHubSkills() });
    } catch (e) { fail(res, 500, e.message); }
  });

  app.get('/v1/meta/hermeshub/skills/:name', async (req, res) => {
    const name = String(req.params.name || '').trim();
    const err = meta.validateName(name);
    if (err) return fail(res, 400, err);
    try {
      ok(res, { skill: await meta.getHermesHubSkill(name) });
    } catch (e) { fail(res, 400, e.message); }
  });

  app.post('/v1/meta/hermeshub/install', async (req, res) => {
    const { name, target_name } = req.body || {};
    if (typeof name !== 'string' || !name) return fail(res, 400, 'name required');
    try {
      const result = await meta.installHermesHubSkill(name, target_name);
      meta.audit('install_hermeshub_skill', result.name, {
        user: userEmail(req),
        source: result.source,
        files: result.files,
      });
      await refreshAggregator();
      ok(res, result);
    } catch (e) { fail(res, 400, e.message); }
  });

  // ── Generic GitHub skills source ─────────────────────────────────────────
  // Parameterized over (repo, branch, base_path) so any repo that stores skill
  // dirs under a known path can be browsed and installed. base_path defaults
  // to "skills" (matches Anthropic + most public skill repos); pass "" for
  // repos that keep skill dirs at the root.
  app.get('/v1/meta/github/skills', async (req, res) => {
    const repo = String(req.query.repo || '').trim();
    const branch = String(req.query.branch || 'main').trim();
    const basePath = req.query.base_path != null ? String(req.query.base_path) : 'skills';
    if (!repo) return fail(res, 400, 'repo query param required (owner/name)');
    try {
      ok(res, { skills: await meta.listGithubSkills(repo, branch, basePath), repo, branch, base_path: basePath });
    } catch (e) { fail(res, 400, e.message); }
  });

  app.get('/v1/meta/github/skill', async (req, res) => {
    const repo = String(req.query.repo || '').trim();
    const branch = String(req.query.branch || 'main').trim();
    const basePath = req.query.base_path != null ? String(req.query.base_path) : 'skills';
    const name = String(req.query.name || '').trim();
    if (!repo) return fail(res, 400, 'repo query param required (owner/name)');
    if (!name) return fail(res, 400, 'name query param required');
    try {
      ok(res, { skill: await meta.getGithubSkill(repo, branch, basePath, name) });
    } catch (e) { fail(res, 400, e.message); }
  });

  app.post('/v1/meta/github/install', async (req, res) => {
    const { repo, branch, base_path, name, target_name } = req.body || {};
    if (typeof repo !== 'string' || !repo) return fail(res, 400, 'repo required (owner/name)');
    if (typeof name !== 'string' || !name) return fail(res, 400, 'name required');
    const bp = base_path == null ? 'skills' : String(base_path);
    try {
      const result = await meta.installGithubSkill(repo, branch || 'main', bp, name, target_name);
      meta.audit('install_github_skill', result.name, {
        user: userEmail(req),
        source: result.source,
        files: result.files,
        repo: result.source_repo,
        branch: result.source_branch,
      });
      await refreshAggregator();
      ok(res, result);
    } catch (e) { fail(res, 400, e.message); }
  });

  app.delete('/v1/meta/skills/:name', async (req, res) => {
    const name = String(req.params.name || '').trim();
    const err = meta.validateName(name);
    if (err) return fail(res, 400, err);
    try {
      const removed = meta.deleteSkill(name);
      meta.audit('delete_skill', name, { user: userEmail(req), ok: removed });
      await refreshAggregator();
      if (!removed) return fail(res, 404, 'not found');
      ok(res, {});
    } catch (e) { fail(res, 500, e.message); }
  });

  // ── Tools ────────────────────────────────────────────────────────────────
  app.get('/v1/meta/tools/', (_req, res) => {
    try { ok(res, { tools: meta.listTools() }); }
    catch (e) { fail(res, 500, e.message); }
  });

  app.get('/v1/meta/tools/:name', (req, res) => {
    const name = String(req.params.name || '').trim();
    const err = meta.validateName(name);
    if (err) return fail(res, 400, err);
    const t = meta.readTool(name);
    if (!t) return fail(res, 404, 'not found');
    ok(res, { tool: { ...t, mounted: meta.isMounted('tool', name) } });
  });

  app.put('/v1/meta/tools/:name', async (req, res) => {
    const name = String(req.params.name || '').trim();
    const err = meta.validateName(name);
    if (err) return fail(res, 400, err);
    const body = req.body || {};
    try {
      const existed = !!meta.readTool(name);
      meta.writeTool(name, {
        description: body.description,
        runtime: body.runtime,
        inputSchema: body.inputSchema,
        code: body.code,
        url: body.url,
      });
      let mounted;
      if (typeof body.mount === 'boolean') mounted = body.mount;
      else mounted = existed ? meta.isMounted('tool', name) : true;
      meta.setMount('tool', name, mounted);
      meta.audit('save_tool', name, { user: userEmail(req), runtime: body.runtime, mounted });
      await refreshAggregator();
      ok(res, { name, mounted });
    } catch (e) { fail(res, 400, e.message); }
  });

  app.post('/v1/meta/tools/import', async (req, res) => {
    const { source, name } = req.body || {};
    if (typeof source !== 'string' || !source) return fail(res, 400, 'source required');
    try {
      const result = meta.importToolFromPath(source, name);
      meta.audit('import_tool', result.name, { user: userEmail(req), source: result.source, files: result.files, runtime: result.runtime });
      await refreshAggregator();
      ok(res, result);
    } catch (e) { fail(res, 400, e.message); }
  });

  app.delete('/v1/meta/tools/:name', async (req, res) => {
    const name = String(req.params.name || '').trim();
    const err = meta.validateName(name);
    if (err) return fail(res, 400, err);
    try {
      const removed = meta.deleteTool(name);
      meta.audit('delete_tool', name, { user: userEmail(req), ok: removed });
      await refreshAggregator();
      if (!removed) return fail(res, 404, 'not found');
      ok(res, {});
    } catch (e) { fail(res, 500, e.message); }
  });

  app.post('/v1/meta/tools/:name/invoke', async (req, res) => {
    const name = String(req.params.name || '').trim();
    const err = meta.validateName(name);
    if (err) return fail(res, 400, err);
    const t = meta.readTool(name);
    if (!t) return fail(res, 404, 'not found');
    const args = (req.body && req.body.arguments) || {};
    const telemetry = getModuleApi('observability-plus')?.telemetry;
    const argsSize = (() => { try { return JSON.stringify(args).length; } catch { return 0; } })();
    const t0 = Date.now();
    try {
      const mcp = getModuleApi('mcp-client');
      if (!mcp) return fail(res, 501, 'mcp-client module is disabled');
      const result: any = await mcp.callMcpTool('meta-bridge', 'meta_invoke_tool', { name, arguments: args });
      const text = result?.content?.[0]?.text || '';
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { parsed = { stdout: text, stderr: '', exit_code: 0 }; }
      meta.audit('invoke_tool', name, { user: userEmail(req), exit_code: parsed?.exit_code });
      // Surface a `tool` event for the meta-tool itself, distinct from the
      // MCP relay event recorded inside callMcpTool, so the monitoring panel
      // can show meta-tool invocations as their own row.
      telemetry?.record?.({
        surface: 'tool',
        name: `meta:${name}`,
        durationMs: Date.now() - t0,
        ok: true,
        argsSize,
        resultSize: text.length,
        meta: { runtime: t.runtime, exitCode: parsed?.exit_code, source: 'meta' },
      });
      ok(res, { result: parsed });
    } catch (e) {
      telemetry?.record?.({
        surface: 'tool',
        name: `meta:${name}`,
        durationMs: Date.now() - t0,
        ok: false,
        argsSize,
        meta: { runtime: t.runtime, source: 'meta', error: e.message || String(e) },
      });
      // meta-bridge MCP may not be running; fall back to "not running" error
      fail(res, 503, e.message || 'meta-bridge MCP not running');
    }
  });

  // ── Mount / unmount ──────────────────────────────────────────────────────
  app.post('/v1/meta/mount', async (req, res) => {
    const { kind, name } = req.body || {};
    if (kind !== 'skill' && kind !== 'tool') return fail(res, 400, 'kind must be "skill" or "tool"');
    const err = meta.validateName(String(name || ''));
    if (err) return fail(res, 400, err);
    meta.setMount(kind, String(name).trim(), true);
    await refreshAggregator();
    ok(res, {});
  });

  app.post('/v1/meta/unmount', async (req, res) => {
    const { kind, name } = req.body || {};
    if (kind !== 'skill' && kind !== 'tool') return fail(res, 400, 'kind must be "skill" or "tool"');
    const err = meta.validateName(String(name || ''));
    if (err) return fail(res, 400, err);
    meta.setMount(kind, String(name).trim(), false);
    await refreshAggregator();
    ok(res, {});
  });

  app.get('/v1/meta/state', (_req, res) => {
    ok(res, { state: meta.loadState() });
  });
}

module.exports = { registerMetaBridgeRoutes };
