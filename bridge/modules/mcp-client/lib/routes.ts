// ── HTTP routes for /v1/mcp/, /v1/bash-console/, /v1/knowledge/, /v1/tools/ ───
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { mcpConnections, config } = require('../../../core/state');
const {
  readUpstreamRegistry,
  getExternalSharing,
  setExternalSharing,
  getGatewayMode,
  setGatewayMode,
  getAudienceOverrides,
  setAudienceOverride,
  setMcpEnabled,
  setMcpDisabled,
} = require('./state');
const { startMcpServer, stopMcpServer, callMcpTool, clearSupervisorBackoff, isMcpConnAlive } = require('./protocol');
const { getToolGroups, invalidateToolGroupsCache } = require('./discovery');
const { promoteMcpTools } = require('./materialize');

function registerMcpRoutes(app) {
  // GET /v1/mcp/external-sharing — current toggle state + counts + connection snippet
  app.get('/v1/mcp/external-sharing', (_req, res) => {
    let tools = 0, prompts = 0, resources = 0, active = 0;
    for (const [, conn] of mcpConnections) {
      const alive = isMcpConnAlive(conn);
      if (!alive) continue;
      active++;
      tools     += (conn.tools     || []).length;
      prompts   += (conn.prompts   || []).length;
      resources += (conn.resources || []).length;
    }
    const { PORT } = require('../../../core/state');
    const stubPath = path.join(__dirname, '..', '..', '..', 'mcp', 'yha-bridge-stub.js');
    res.json({
      success: true,
      enabled: getExternalSharing(),
      gatewayMode: getGatewayMode(),
      activeUpstreams: active,
      tools, prompts, resources,
      connection: {
        name: 'MCP-Tools',
        command: process.execPath,
        args: [stubPath],
        env: { YHA_BRIDGE_URL: `http://127.0.0.1:${PORT}` },
      },
    });
  });

  // POST /v1/mcp/gateway-mode  body: { mode: 'direct' | 'search' }
  // Flips how the MCP-Tools gateway advertises tools. Pure runtime switch — no
  // re-materialize needed (the stub always points at the same RPC route; only
  // the tools/list payload changes), so we don't re-run promotion here.
  app.post('/v1/mcp/gateway-mode', (req, res) => {
    const mode = req.body && req.body.mode;
    if (mode !== 'direct' && mode !== 'search') {
      return res.status(400).json({ success: false, error: "mode must be 'direct' or 'search'" });
    }
    setGatewayMode(mode);
    res.json({ success: true, gatewayMode: mode });
  });

  // POST /v1/mcp/external-sharing  body: { enabled: boolean }
  // Flips the toggle and re-runs promotion so harness configs reflect the change.
  app.post('/v1/mcp/external-sharing', (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    setExternalSharing(enabled);
    try { promoteMcpTools(config); }
    catch (e) {
      return res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
    res.json({ success: true, enabled });
  });

  // GET /v1/mcp/ — MCP server status
  app.get('/v1/mcp/', (req, res) => {
    const mcpServers = readUpstreamRegistry().mcpServers || {};
    const servers = Object.entries(mcpServers).map(([name, cfg]) => {
      const conn = mcpConnections.get(name) || {};
      const running = isMcpConnAlive(conn);
      return {
        name,
        kind: (cfg as any).kind || 'internal',
        transport: (cfg as any).transport || ((cfg as any).url ? 'http' : 'stdio'),
        command: (cfg as any).command || '',
        args: (cfg as any).args || [],
        url: (cfg as any).url || '',
        running,
        ok: running && conn.ok === true,
        tools: conn.tools || [],
        prompts: conn.prompts || [],
        resources: conn.resources || [],
        error: conn.error || null,
      };
    });
    res.json({ success: true, servers });
  });

  // GET /v1/mcp/audience — per-server audience scope (ternary) + detector
  //
  // Response shape:
  //   {
  //     petActive: boolean,                                  // pet bridge module loaded?
  //     servers: { [name]: {
  //       resolved: 'all' | 'chat-only' | 'pet-only',        // current effective scope
  //       default:  'all' | 'chat-only' | 'pet-only',        // catalog / registry default
  //       override: 'all' | 'chat-only' | 'pet-only' | null, // user override, null when unset
  //     } }
  //   }
  //
  // The frontend prefs MCP tab renders the per-server dropdown using this.
  // When petActive is false the dropdown is hidden (the audience policy still
  // resolves correctly but the user has no reason to flip values without a
  // pet consumer).
  app.get('/v1/mcp/audience', (_req, res) => {
    let petActive = false;
    let resolveAudience: ((name: string) => 'all' | 'chat-only' | 'pet-only') | null = null;
    try {
      const mod = require('../../pet/lib/mcp-audience');
      petActive = !!(mod && typeof mod.isPetActive === 'function' && mod.isPetActive());
      if (mod && typeof mod.resolveAudience === 'function') resolveAudience = mod.resolveAudience;
    } catch (_e) { /* pet module path unavailable */ }

    const overrides = getAudienceOverrides();
    const registered = readUpstreamRegistry().mcpServers || {};
    const servers: Record<string, { resolved: string; default: string; override: string | null }> = {};

    // Catalog-default lookup (best-effort — same resolver path used by the
    // tools layer, so the response stays consistent with what the tool list
    // actually filters on).
    let getCatalogDefault: ((name: string) => string | undefined) | null = null;
    try {
      const cat = require('../../mcp-servers');
      if (cat && typeof cat.getAudienceDefault === 'function') getCatalogDefault = cat.getAudienceDefault;
    } catch (_e) { /* catalog unavailable */ }

    for (const name of Object.keys(registered)) {
      const override = overrides[name] || null;
      const defaultScope =
        (getCatalogDefault && getCatalogDefault(name))
        || ((registered[name] as any)?.audience)
        || 'all';
      const resolved = resolveAudience ? resolveAudience(name) : (override || defaultScope);
      servers[name] = { resolved, default: defaultScope, override };
    }
    res.json({ success: true, petActive, servers });
  });

  // POST /v1/mcp/:name/audience  body: { audience: Audience | null }
  // Sets a user override for the named server. Pass null (or omit the value)
  // to clear the override and fall back to the catalog default.
  app.post('/v1/mcp/:name/audience', (req, res) => {
    const { name } = req.params;
    const cfg = readUpstreamRegistry().mcpServers?.[name];
    if (!cfg) return res.status(404).json({ success: false, error: `Unknown MCP server: ${name}` });
    const value = req.body?.audience;
    if (value !== null && value !== 'all' && value !== 'chat-only' && value !== 'pet-only') {
      return res.status(400).json({ success: false, error: 'audience must be one of: all, chat-only, pet-only, null' });
    }
    setAudienceOverride(name, value);
    res.json({ success: true, name, audience: value });
  });

  // POST /v1/mcp/:name/start
  app.post('/v1/mcp/:name/start', async (req, res) => {
    const { name } = req.params;
    const cfg = readUpstreamRegistry().mcpServers?.[name];
    if (!cfg) return res.status(404).json({ success: false, error: `Unknown MCP server: ${name}` });
    // Record the user's intent to run this server BEFORE spawning. If the spawn
    // fails the server stays in the desired-ON set so the supervisor keeps
    // retrying (and the MCP tab keeps showing the live error) rather than the
    // failure silently dropping it. clearSupervisorBackoff gives this manual
    // start a fresh retry budget even if the background one was spent.
    setMcpEnabled(name);
    clearSupervisorBackoff(name);
    const state = await startMcpServer(name, cfg);
    const running = isMcpConnAlive(state);
    res.json({
      success: true,
      name,
      running,
      ok: state.ok,
      tools: state.tools,
      prompts: state.prompts || [],
      resources: state.resources || [],
      error: state.error,
    });
  });

  // POST /v1/mcp/:name/stop
  app.post('/v1/mcp/:name/stop', (req, res) => {
    // Record intent (move to disabled[]) so the supervisor leaves it down and
    // it stays off across restarts until the user starts it again.
    setMcpDisabled(req.params.name);
    const result = stopMcpServer(req.params.name);
    res.json({ success: true, name: req.params.name, ...result });
  });

  // GET /v1/bash-console/history — proxy to console_history tool
  app.get('/v1/bash-console/history', async (req, res) => {
    const conn = mcpConnections.get('bash-console');
    const alive = conn?.proc && conn.proc.exitCode === null && !conn.proc.killed && conn.send;
    if (!alive)
      return res.json({
        success: false,
        error: 'bash-console not running',
        history: [],
        open: false,
        sessionStart: null,
      });
    try {
      const result = await callMcpTool('bash-console', 'console_history', {});
      const data = JSON.parse(result.content[0].text);
      res.json({ success: true, ...data });
    } catch (e) {
      res.json({ success: false, error: e.message, history: [], open: false, sessionStart: null });
    }
  });

  // POST /v1/bash-console/run — run a command in the shared session
  app.post('/v1/bash-console/run', async (req, res) => {
    const conn = mcpConnections.get('bash-console');
    const alive = conn?.proc && conn.proc.exitCode === null && !conn.proc.killed && conn.send;
    if (!alive) return res.status(400).json({ success: false, error: 'bash-console not running' });
    const { command, timeout, working_dir } = req.body || {};
    if (!command || typeof command !== 'string')
      return res.status(400).json({ success: false, error: 'command required' });
    try {
      const toolArgs: any = { command, timeout: timeout || 30 };
      if (working_dir && typeof working_dir === 'string') toolArgs.working_dir = working_dir;
      const result = await callMcpTool('bash-console', 'run_command', toolArgs);
      const data = JSON.parse(result.content[0].text);
      res.json({ success: true, ...data });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Slug logic mirrors bridge/mcp/knowledge-server.js — keep them in sync.
  // Knowledge root is resolved through bridge/core/paths.ts so per-user
  // migration moves all callers together.
  const PATHS = require('../../../core/paths');
  function slugForCwd(workingDir: string): string {
    return workingDir.toLowerCase().replace(/^[/\\]+|[/\\]+$/g, '').replace(/[/\\]+/g, '___');
  }
  function knowledgeDirFor(workingDir: string): string {
    return path.join(PATHS.knowledgeRoot, 'dirs', slugForCwd(workingDir));
  }

  // GET /v1/knowledge/status?workingDir=<absolute path>
  // Reports graph + synthesis status for the working dir's bucket.
  app.get('/v1/knowledge/status', (req, res) => {
    const workingDir = typeof req.query.workingDir === 'string' ? req.query.workingDir : '';
    if (!workingDir) {
      // Graceful zero-state for pre-session polling.
      return res.json({ success: true, graphExists: false, synthCount: 0 });
    }
    const KNOWLEDGE_DIR = knowledgeDirFor(workingDir);
    const graphPath     = path.join(KNOWLEDGE_DIR, 'graph', 'graph.json');
    const synthDir      = path.join(KNOWLEDGE_DIR, 'synthesis');

    const graphExists = fs.existsSync(graphPath);

    // Count only hand-crafted synthesis pages — skip auto-generated dirs and system files
    const SYSTEM_FILES = new Set(['_index.md', 'index.md', 'log.md', 'README.md']);
    const SKIP_DIRS    = new Set(['code']); // auto-generated by export-obsidian
    let synthCount = 0;
    function countMd(dir: string): void {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) countMd(path.join(dir, entry.name));
        } else if (entry.name.endsWith('.md') && !SYSTEM_FILES.has(entry.name)) {
          synthCount++;
        }
      }
    }
    countMd(synthDir);

    res.json({ success: true, graphExists, synthCount });
  });

  // POST /v1/knowledge/build — rebuild the code dependency graph via knowledge-memory MCP
  app.post('/v1/knowledge/build', async (req, res) => {
    const body = (req.body as any) || {};
    const workingDir = typeof body.workingDir === 'string' ? body.workingDir : '';
    if (!workingDir) return res.status(400).json({ success: false, error: 'workingDir is required' });
    const conn = mcpConnections.get('knowledge-memory');
    const alive = conn?.proc && conn.proc.exitCode === null && !conn.proc.killed && conn.send;
    if (!alive) return res.status(503).json({ success: false, error: 'knowledge-memory MCP is not running' });
    try {
      const result = await callMcpTool('knowledge-memory', 'build_code_graph', { workingDir, target: body.target });
      res.json({ success: true, output: result.content[0].text });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // POST /v1/knowledge/export-obsidian — write [[wikilink]] .md files from graph.json into synthesis/code/
  app.post('/v1/knowledge/export-obsidian', (req, res) => {
    const body = (req.body as any) || {};
    const workingDir = typeof body.workingDir === 'string' ? body.workingDir : '';
    if (!workingDir) return res.status(400).json({ success: false, error: 'workingDir is required' });
    const KNOWLEDGE_DIR = knowledgeDirFor(workingDir);
    const GRAPH_JSON    = path.join(KNOWLEDGE_DIR, 'graph', 'graph.json');
    const CODE_DIR      = path.join(KNOWLEDGE_DIR, 'synthesis', 'code');

    if (!fs.existsSync(GRAPH_JSON))
      return res.status(404).json({ success: false, error: 'graph.json not found — run /v1/knowledge/build first' });

    let g: any;
    try { g = JSON.parse(fs.readFileSync(GRAPH_JSON, 'utf8')); } catch (e) {
      return res.status(500).json({ success: false, error: `Cannot parse graph.json: ${(e as Error).message}` });
    }

    function toSlug(src: string): string {
      return src.replace(/^[./]+/, '').replace(/\//g, '___');
    }

    fs.rmSync(CODE_DIR, { recursive: true, force: true });
    fs.mkdirSync(CODE_DIR, { recursive: true });

    // Stamp every code/*.md page with `source_sha` (current HEAD), `source_paths`
    // (the file the page mirrors), and `built_at`. Without this the
    // synth-status checker has nothing to diff against and silently lists
    // every page under "skipped (incomplete frontmatter)". Resolved once per
    // export so all pages share the same recorded SHA.
    let headSha = '';
    try {
      headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf8' }).trim();
    } catch (_) { /* not a git repo — leave source_sha unset, synth-status will report it */ }
    const builtAt = new Date().toISOString();

    let written = 0;

    if (Array.isArray(g.nodes) && Array.isArray(g.links)) {
      const nodes: Array<any> = g.nodes;
      const links: Array<any> = g.links;
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const isFileNode = (node: any) =>
        !!node
        && typeof node.source_file === 'string'
        && typeof node.label === 'string'
        && path.posix.basename(node.source_file) === node.label
        && node.source_location === 'L1';
      const fileNodes = nodes.filter(isFileNode).sort((a, b) => String(a.source_file).localeCompare(String(b.source_file)));
      const fileSources = new Set(fileNodes.map((node) => String(node.source_file)));
      const deps = new Map<string, Set<string>>();
      const dependents = new Map<string, Set<string>>();
      const symbols = new Map<string, string[]>();
      const rels = new Set(['imports', 'imports_from', 'calls', 'method']);

      for (const link of links) {
        const src = nodesById.get(link.source);
        const tgt = nodesById.get(link.target);
        if (!src || !tgt) continue;
        if (link.relation === 'contains' && isFileNode(src) && tgt.label && tgt.label !== src.label) {
          const arr = symbols.get(src.source_file) || [];
          arr.push(String(tgt.label));
          symbols.set(src.source_file, arr);
        }
        if (!rels.has(String(link.relation || ''))) continue;
        const srcFile = String(src.source_file || '');
        const tgtFile = String(tgt.source_file || '');
        if (!srcFile || !tgtFile || srcFile === tgtFile) continue;
        if (!fileSources.has(srcFile) || !fileSources.has(tgtFile)) continue;
        const depSet = deps.get(srcFile) || new Set<string>();
        depSet.add(tgtFile);
        deps.set(srcFile, depSet);
        const revSet = dependents.get(tgtFile) || new Set<string>();
        revSet.add(srcFile);
        dependents.set(tgtFile, revSet);
      }

      for (const node of fileNodes) {
        const sourceFile = String(node.source_file);
        const slug = toSlug(sourceFile);
        if (!slug) continue;
        const depLinks = [...(deps.get(sourceFile) || new Set<string>())].sort().map((s) => `- [[${toSlug(s)}|${s}]]`);
        const revLinks = [...(dependents.get(sourceFile) || new Set<string>())].sort().map((s) => `- [[${toSlug(s)}|${s}]]`);
        const symbolLinks = [...new Set(symbols.get(sourceFile) || [])].sort().map((s) => `- \`${s}\``);
        const content = [
          `---`,
          `title: "${sourceFile}"`,
          `source_paths:`,
          `  - ${sourceFile}`,
          ...(headSha ? [`source_sha: ${headSha}`] : []),
          `built_at: ${builtAt}`,
          `---`,
          ``,
          `Path: \`${sourceFile}\``,
          `Community: \`${node.community ?? ''}\``,
          ``,
          `## Symbols`,
          symbolLinks.length ? symbolLinks.join('\n') : '_none_',
          ``,
          `## Dependencies`,
          depLinks.length ? depLinks.join('\n') : '_none_',
          ``,
          `## Dependents`,
          revLinks.length ? revLinks.join('\n') : '_none_',
        ].join('\n');
        fs.writeFileSync(path.join(CODE_DIR, `${slug}.md`), content, 'utf8');
        written++;
      }

      const indexLines = fileNodes.map((node) => `- [[${toSlug(String(node.source_file))}|${String(node.source_file)}]]`);
      fs.writeFileSync(
        path.join(CODE_DIR, '_index.md'),
        `# Code Graph Index\n\n${indexLines.join('\n')}\n`,
        'utf8'
      );
      return res.json({ success: true, filesWritten: written });
    }

    const modules: Array<{source: string; dependencies?: Array<{resolved: string}>}> = g.modules || [];
    const sources = new Set(modules.map((m) => m.source));
    const isInternalDep = (dep: { resolved?: string; coreModule?: boolean; dependencyTypes?: string[] }) => {
      if (!dep || typeof dep.resolved !== 'string') return false;
      if (dep.coreModule) return false;
      if (Array.isArray(dep.dependencyTypes) && dep.dependencyTypes.some((t) => t === 'core' || t.startsWith('npm'))) return false;
      if (dep.resolved.includes('node_modules')) return false;
      return sources.has(dep.resolved);
    };
    const dependents = new Map<string, string[]>();
    for (const m of modules) {
      for (const d of m.dependencies || []) {
        if (!isInternalDep(d as any)) continue;
        const arr = dependents.get(d.resolved) || [];
        arr.push(m.source);
        dependents.set(d.resolved, arr);
      }
    }

    for (const m of modules) {
      const slug = toSlug(m.source);
      if (!slug) continue;
      const depLinks = (m.dependencies || []).filter((d) => isInternalDep(d as any)).map((d) => `- [[${toSlug(d.resolved)}|${d.resolved}]]`);
      const revLinks = (dependents.get(m.source) || []).map((s) => `- [[${toSlug(s)}|${s}]]`);
      const content = [
        `---`,
        `title: "${m.source}"`,
        `source_paths:`,
        `  - ${m.source}`,
        ...(headSha ? [`source_sha: ${headSha}`] : []),
        `built_at: ${builtAt}`,
        `---`,
        ``,
        `Path: \`${m.source}\``,
        ``,
        `## Dependencies`,
        depLinks.length ? depLinks.join('\n') : '_none_',
        ``,
        `## Dependents`,
        revLinks.length ? revLinks.join('\n') : '_none_',
      ].join('\n');
      fs.writeFileSync(path.join(CODE_DIR, `${slug}.md`), content, 'utf8');
      written++;
    }

    const indexLines = modules.map((m) => `- [[${toSlug(m.source)}|${m.source}]]`);
    fs.writeFileSync(
      path.join(CODE_DIR, '_index.md'),
      `# Code Graph Index\n\n${indexLines.join('\n')}\n`,
      'utf8'
    );

    res.json({ success: true, filesWritten: written });
  });

  // GET /v1/modules/skills/:name
  // Serves a module-provided skill body to the frontend `#skill-<name>`
  // interceptor. Resolution walks the active module registry — the body is
  // only available while the owning module is active, which is exactly the
  // contract the picker entry promises. 404s when the skill isn't declared
  // by any active module or its SKILL.md file is missing.
  app.get('/v1/modules/skills/:name', (req, res) => {
    const { readModuleSkillBody } = require('../../../core/modules');
    const hit = readModuleSkillBody(req.params.name);
    if (!hit) {
      return res.status(404).json({ success: false, error: 'not-found' });
    }
    res.json({ success: true, content: hit.content, moduleName: hit.moduleName });
  });

  // GET /v1/mcp/audit?limit=100 — most-recent-first tail of the gateway
  // tool-call audit log (source, tool, status ok/denied/error, session, args
  // summary). Powers the prefs MCP → External "Recent activity" view.
  app.get('/v1/mcp/audit', (req, res) => {
    const { readAudit } = require('./audit');
    const raw = parseInt(String(req.query.limit ?? '100'), 10);
    const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 100, 1), 500);
    res.json({ success: true, entries: readAudit(limit) });
  });

  // GET /v1/tools/
  app.get('/v1/tools/', async (req, res) => {
    const groups = await getToolGroups();
    res.json({ success: true, groups });
  });

  // GET /v1/tools/refresh
  app.get('/v1/tools/refresh', async (req, res) => {
    invalidateToolGroupsCache();
    const groups = await getToolGroups();
    res.json({ success: true, groups });
  });
}

module.exports = { registerMcpRoutes };
