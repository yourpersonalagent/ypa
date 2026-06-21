#!/usr/bin/env node
// @ts-check
'use strict';

// Meta Bridge MCP server — exposes a CRUD + mount/unmount surface for skills
// and tools, plus runs each *mounted* user-tool as a regular MCP tool entry.
//
// Storage and helpers live in bridge/modules/skills-editor/lib.js (was
// bridge/meta/lib.js before the modular migration; this MCP child stays
// in bridge/mcp/ for now and moves into the future `mcp-servers` module
// in a follow-up batch).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const meta = require('../modules/skills-editor/lib.js');

// ── Static CRUD/mount tool surface ────────────────────────────────────────

const META_TOOLS = [
  {
    name: 'meta_list_skills',
    description:
      'List all skills (mounted and unmounted) stored in the YHA meta-bridge. ' +
      'Returns name, description, and mounted flag per entry.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'meta_get_skill',
    description:
      'Read the full SKILL.md content and references map of one skill.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'meta_save_skill',
    description:
      'Create or overwrite a skill. SKILL.md content includes YAML frontmatter ' +
      '(name, description) followed by Markdown body. Optional references map ' +
      '({"rel/path": "text"}). Auto-mounted on creation; mount preserved on overwrite ' +
      'unless explicitly set.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        content: { type: 'string' },
        references: { type: 'object', additionalProperties: { type: 'string' } },
        mount: { type: 'boolean' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'meta_import_skill',
    description:
      'Copy an existing skill (e.g. a Hermes skill at ~/.hermes/skills/.../<name>/) ' +
      'into the YHA meta-bridge layout, including all sibling files (scripts, references/, etc.). ' +
      'Use this instead of meta_save_skill when the skill body references companion files — ' +
      'meta_save_skill only writes SKILL.md.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute (or ~-prefixed) path to the skill dir or its SKILL.md.' },
        name: { type: 'string', description: 'Optional override; defaults to frontmatter name or dir basename.' },
      },
      required: ['source'],
    },
  },
  {
    name: 'meta_list_hermeshub_skills',
    description:
      'List skills currently available from HermesHub via its GitHub-backed catalog. ' +
      'Returns name plus source URLs for each skill.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'meta_get_hermeshub_skill',
    description:
      'Fetch one HermesHub skill and return its current SKILL.md plus file list. ' +
      'Use this to inspect a skill before installation.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'meta_install_hermeshub_skill',
    description:
      'Download a skill from HermesHub into the YHA meta-bridge, normalize ' +
      'Hermes-oriented docs/scripts to YHA paths where possible, and mount it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'HermesHub skill name.' },
        target_name: { type: 'string', description: 'Optional local override for the imported skill name.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'meta_list_github_skills',
    description:
      'List candidate skill directories from any public GitHub repo. Generic ' +
      'sibling of meta_list_hermeshub_skills — parameterised over repo / branch / ' +
      'base_path. base_path defaults to "skills"; pass "" for repos that keep ' +
      'skill dirs at the root.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '"<owner>/<name>", e.g. "mattpocock/skills".' },
        branch: { type: 'string', description: 'Defaults to "main".' },
        base_path: { type: 'string', description: 'Directory under the repo root that contains skill dirs. Defaults to "skills".' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'meta_get_github_skill',
    description:
      'Inspect one skill in a public GitHub repo — returns SKILL.md content, ' +
      'description, and file list. Use before meta_install_github_skill to ' +
      'preview what would be copied.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        branch: { type: 'string' },
        base_path: { type: 'string' },
        name: { type: 'string', description: 'Skill directory name under base_path.' },
      },
      required: ['repo', 'name'],
    },
  },
  {
    name: 'meta_install_github_skill',
    description:
      'Download a skill directory from a public GitHub repo into the YHA ' +
      'meta-bridge layout and mount it. Does NOT apply Hermes-specific text ' +
      'normalization beyond the generic .yha-import.json provenance stamp — ' +
      'use meta_install_hermeshub_skill for HermesHub-flavoured rewrites.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '"<owner>/<name>".' },
        branch: { type: 'string', description: 'Defaults to "main".' },
        base_path: { type: 'string', description: 'Defaults to "skills".' },
        name: { type: 'string', description: 'Skill directory name under base_path.' },
        target_name: { type: 'string', description: 'Optional local override for the imported skill name.' },
      },
      required: ['repo', 'name'],
    },
  },
  {
    name: 'meta_delete_skill',
    description: 'Remove a skill directory and unmount it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'meta_invoke_skill',
    description:
      'Return the inlined SKILL.md body of a skill. Always callable, even when ' +
      'unmounted. Same semantics as hermes_invoke_skill.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'meta_list_tools',
    description:
      'List all tools (mounted and unmounted) stored in the YHA meta-bridge. ' +
      'Returns name, description, runtime, mounted flag.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'meta_get_tool',
    description: 'Read a tool\'s tool.json plus its entry-script source.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'meta_save_tool',
    description:
      'Create or overwrite a tool. Runtime is bash (default, full host access), ' +
      'python-sandbox / node-sandbox (Docker, no installs, no host FS), or webhook (POST URL). ' +
      'inputSchema follows JSON-Schema. For non-webhook runtimes provide `code`; for webhook provide `url`. ' +
      'Auto-mounted on creation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        runtime: { type: 'string', enum: ['bash', 'python-sandbox', 'node-sandbox', 'webhook'] },
        inputSchema: { type: 'object' },
        code: { type: 'string' },
        url: { type: 'string' },
        mount: { type: 'boolean' },
      },
      required: ['name', 'description', 'runtime', 'inputSchema'],
    },
  },
  {
    name: 'meta_import_tool',
    description:
      'Copy an existing tool directory (containing tool.json + entry script + any siblings) ' +
      'into the YHA meta-bridge layout. Validates runtime, inputSchema, and entry script before importing.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute (or ~-prefixed) path to the tool dir or its tool.json.' },
        name: { type: 'string', description: 'Optional override; defaults to tool.json name or dir basename.' },
      },
      required: ['source'],
    },
  },
  {
    name: 'meta_delete_tool',
    description: 'Remove a tool directory and unmount it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'meta_invoke_tool',
    description:
      'Run a tool by name. Always callable, even when unmounted. Returns stdout, ' +
      'stderr, and exit_code. Bash tools receive args as $META_ARGS env var (raw JSON); ' +
      'python-sandbox/node-sandbox tools receive args as ARGS (parsed); webhook tools ' +
      'receive args as JSON request body.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        arguments: { type: 'object' },
      },
      required: ['name'],
    },
  },
  {
    name: 'meta_mount',
    description:
      'Mount a skill or tool — makes it visible on tools/list (for tools) or ' +
      'prompts/list (for skills). Files stay on disk regardless.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['skill', 'tool'] },
        name: { type: 'string' },
      },
      required: ['kind', 'name'],
    },
  },
  {
    name: 'meta_unmount',
    description:
      'Unmount a skill or tool — hides it from tools/list / prompts/list but ' +
      'leaves files on disk and keeps it directly invokable by exact name via ' +
      'meta_invoke_skill / meta_invoke_tool.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['skill', 'tool'] },
        name: { type: 'string' },
      },
      required: ['kind', 'name'],
    },
  },
];

// ── tools/list and prompts/list (rescan disk every call) ──────────────────

function buildToolsList() {
  const userTools = [];
  const seen = new Set(META_TOOLS.map((t) => t.name));
  // Mounted user tools — exposed by their bare name
  for (const t of meta.listTools()) {
    if (!t.mounted) continue;
    if (seen.has(t.name)) continue;
    const full = meta.readTool(t.name);
    if (!full) continue;
    userTools.push({
      name: full.name,
      description: full.description || '',
      inputSchema: full.inputSchema || { type: 'object', properties: {} },
    });
    seen.add(full.name);
  }
  // Mounted skills — also exposed as zero-arg tools so the model sees them
  // directly on tools/list (no discovery step required). Calling the tool
  // returns the inlined SKILL.md body, same as meta_invoke_skill.
  for (const s of meta.listSkills()) {
    if (!s.mounted) continue;
    if (seen.has(s.name)) continue; // tool with same name wins
    userTools.push({
      name: s.name,
      description: s.description || `Meta Bridge skill: ${s.name}`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    });
    seen.add(s.name);
  }
  return { tools: [...META_TOOLS, ...userTools] };
}

function buildPromptsList() {
  const out = [];
  for (const s of meta.listSkills()) {
    if (!s.mounted) continue;
    out.push({
      name: s.name,
      description: s.description || `Meta Bridge skill: ${s.name}`,
      arguments: [],
    });
  }
  return { prompts: out };
}

function handlePromptsGet(params) {
  const name = params?.name;
  if (typeof name !== 'string') {
    const e = /** @type {Error & { code?: number }} */ (new Error('name required')); e.code = -32602; throw e;
  }
  const text = meta.renderSkillInline(name);
  if (text === null) {
    const e = /** @type {Error & { code?: number }} */ (new Error(`Unknown prompt: ${name}`)); e.code = -32602; throw e;
  }
  const sk = meta.readSkill(name);
  return {
    description: sk?.description || '',
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}

// ── Dispatcher: meta_* CRUD/mount surface ─────────────────────────────────

const dispatch = {
  meta_list_skills() {
    return text(JSON.stringify(meta.listSkills(), null, 2));
  },
  meta_get_skill(args) {
    const name = String(args.name || '').trim();
    meta.assertName(name);
    const sk = meta.readSkill(name);
    if (!sk) return errResult(-32602, `Unknown skill: ${name}`);
    const references = {};
    for (const r of sk.references) {
      try { references[r.relPath] = fs.readFileSync(r.absPath, 'utf8'); }
      catch (e) { references[r.relPath] = `(unreadable: ${e.message})`; }
    }
    return text(JSON.stringify({
      name: sk.name,
      content: sk.content,
      description: sk.description,
      dir: meta.skillDir(sk.name),
      references,
    }, null, 2));
  },
  meta_save_skill(args) {
    const name = String(args.name || '').trim();
    const existed = !!meta.readSkill(name);
    meta.writeSkill(name, args.content, args.references);
    let mounted;
    if (typeof args.mount === 'boolean') mounted = args.mount;
    else mounted = existed ? meta.isMounted('skill', name) : true;
    meta.setMount('skill', name, mounted);
    meta.audit('save_skill', name, { mounted });
    return text(JSON.stringify({ ok: true, name, mounted }));
  },
  meta_import_skill(args) {
    const result = meta.importSkillFromPath(String(args.source || ''), args.name);
    meta.audit('import_skill', result.name, { source: result.source, files: result.files });
    return text(JSON.stringify({ ok: true, ...result }, null, 2));
  },
  async meta_list_hermeshub_skills() {
    return text(JSON.stringify(await meta.listHermesHubSkills(), null, 2));
  },
  async meta_get_hermeshub_skill(args) {
    return text(JSON.stringify(await meta.getHermesHubSkill(String(args.name || '').trim()), null, 2));
  },
  async meta_install_hermeshub_skill(args) {
    const result = await meta.installHermesHubSkill(String(args.name || '').trim(), args.target_name);
    meta.audit('install_hermeshub_skill', result.name, { source: result.source, files: result.files });
    return text(JSON.stringify({ ok: true, ...result }, null, 2));
  },
  async meta_list_github_skills(args) {
    const skills = await meta.listGithubSkills(
      String(args.repo || '').trim(),
      args.branch ? String(args.branch).trim() : 'main',
      args.base_path != null ? String(args.base_path) : 'skills',
    );
    return text(JSON.stringify(skills, null, 2));
  },
  async meta_get_github_skill(args) {
    const skill = await meta.getGithubSkill(
      String(args.repo || '').trim(),
      args.branch ? String(args.branch).trim() : 'main',
      args.base_path != null ? String(args.base_path) : 'skills',
      String(args.name || '').trim(),
    );
    return text(JSON.stringify(skill, null, 2));
  },
  async meta_install_github_skill(args) {
    const result = await meta.installGithubSkill(
      String(args.repo || '').trim(),
      args.branch ? String(args.branch).trim() : 'main',
      args.base_path != null ? String(args.base_path) : 'skills',
      String(args.name || '').trim(),
      args.target_name,
    );
    meta.audit('install_github_skill', result.name, {
      source: result.source,
      files: result.files,
      repo: result.source_repo,
      branch: result.source_branch,
    });
    return text(JSON.stringify({ ok: true, ...result }, null, 2));
  },
  meta_delete_skill(args) {
    const name = String(args.name || '').trim();
    meta.assertName(name);
    const ok = meta.deleteSkill(name);
    meta.audit('delete_skill', name, { ok });
    return text(JSON.stringify({ ok }));
  },
  meta_invoke_skill(args) {
    const name = String(args.name || '').trim();
    meta.assertName(name);
    const body = meta.renderSkillInline(name);
    if (body === null) return errResult(-32602, `Unknown skill: ${name}`);
    return text(body);
  },
  meta_list_tools() {
    return text(JSON.stringify(meta.listTools(), null, 2));
  },
  meta_get_tool(args) {
    const name = String(args.name || '').trim();
    meta.assertName(name);
    const t = meta.readTool(name);
    if (!t) return errResult(-32602, `Unknown tool: ${name}`);
    return text(JSON.stringify(t, null, 2));
  },
  meta_save_tool(args) {
    const name = String(args.name || '').trim();
    const existed = !!meta.readTool(name);
    meta.writeTool(name, args);
    let mounted;
    if (typeof args.mount === 'boolean') mounted = args.mount;
    else mounted = existed ? meta.isMounted('tool', name) : true;
    meta.setMount('tool', name, mounted);
    meta.audit('save_tool', name, { mounted, runtime: args.runtime });
    return text(JSON.stringify({ ok: true, name, mounted }));
  },
  meta_import_tool(args) {
    const result = meta.importToolFromPath(String(args.source || ''), args.name);
    meta.audit('import_tool', result.name, { source: result.source, files: result.files, runtime: result.runtime });
    return text(JSON.stringify({ ok: true, ...result }, null, 2));
  },
  meta_delete_tool(args) {
    const name = String(args.name || '').trim();
    meta.assertName(name);
    const ok = meta.deleteTool(name);
    meta.audit('delete_tool', name, { ok });
    return text(JSON.stringify({ ok }));
  },
  async meta_invoke_tool(args) {
    const name = String(args.name || '').trim();
    meta.assertName(name);
    const t = meta.readTool(name);
    if (!t) return errResult(-32602, `Unknown tool: ${name}`);
    const result = await runTool(t, args.arguments || {});
    meta.audit('invoke_tool', name, { exit_code: result.exit_code });
    return text(JSON.stringify(result, null, 2));
  },
  meta_mount(args) {
    const kind = args.kind === 'skill' ? 'skill' : args.kind === 'tool' ? 'tool' : null;
    if (!kind) return errResult(-32602, 'kind must be "skill" or "tool"');
    const name = String(args.name || '').trim();
    meta.assertName(name);
    meta.setMount(kind, name, true);
    return text(JSON.stringify({ ok: true }));
  },
  meta_unmount(args) {
    const kind = args.kind === 'skill' ? 'skill' : args.kind === 'tool' ? 'tool' : null;
    if (!kind) return errResult(-32602, 'kind must be "skill" or "tool"');
    const name = String(args.name || '').trim();
    meta.assertName(name);
    meta.setMount(kind, name, false);
    return text(JSON.stringify({ ok: true }));
  },
};

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}
function errResult(code, message) {
  const e = /** @type {Error & { code?: number }} */ (new Error(message)); e.code = code; throw e;
}

// ── Tool execution paths ───────────────────────────────────────────────────

async function runTool(tool, args) {
  const argJson = JSON.stringify(args || {});
  switch (tool.runtime) {
    case 'bash': return runBash(tool, argJson);
    case 'python-sandbox': return runSandbox('python', tool, argJson);
    case 'node-sandbox': return runSandbox('nodejs', tool, argJson);
    case 'webhook': return runWebhook(tool, args || {});
    default: return { stdout: '', stderr: `Unknown runtime: ${tool.runtime}`, exit_code: 1 };
  }
}

function runBash(tool, argJson) {
  return new Promise((resolve) => {
    const entryPath = path.join(meta.toolDir(tool.name), tool.entry);
    let body;
    try { body = fs.readFileSync(entryPath, 'utf8'); }
    catch (e) {
      return resolve({ stdout: '', stderr: `entry script missing: ${e.message}`, exit_code: 1 });
    }
    const proc = spawn('/bin/bash', ['-c', body], {
      env: { ...process.env, META_ARGS: argJson },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch (_) {}
    }, 60_000);
    proc.stdout.on('data', (c) => { stdout += c.toString(); if (stdout.length > 256 * 1024) stdout = stdout.slice(0, 256 * 1024); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); if (stderr.length > 64 * 1024) stderr = stderr.slice(0, 64 * 1024); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout, stderr,
        exit_code: killed ? 124 : (code ?? 1),
        timed_out: killed,
      });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + '\n' + e.message, exit_code: 1 });
    });
  });
}

async function runSandbox(kind, tool, argJson) {
  const entryPath = path.join(meta.toolDir(tool.name), tool.entry);
  let body;
  try { body = fs.readFileSync(entryPath, 'utf8'); }
  catch (e) {
    return { stdout: '', stderr: `entry script missing: ${e.message}`, exit_code: 1 };
  }
  // Inline ARGS literal (code-server doesn't accept env vars)
  const escaped = JSON.stringify(JSON.stringify(argJson)); // double-encoded JSON string literal
  let wrapped;
  let toolName;
  if (kind === 'python') {
    wrapped = `import json\nARGS=json.loads(json.loads(${escaped}))\n${body}`;
    toolName = 'run_python';
  } else {
    wrapped = `const ARGS=JSON.parse(JSON.parse(${escaped}));\n${body}`;
    toolName = 'run_nodejs';
  }
  try {
    const result = await callBridgeMcp(
      'code-server.js',
      toolName,
      { code: wrapped, timeout: 60 }
    );
    // code-server returns { content:[{type:'text', text:'...'}] } where text is "STDOUT:...\nSTDERR:..."
    // We pass the raw text through as stdout; code-exec mixes them by design.
    const t = result?.content?.[0]?.text || '';
    return { stdout: t, stderr: '', exit_code: 0 };
  } catch (e) {
    return { stdout: '', stderr: e.message, exit_code: 1 };
  }
}

async function runWebhook(tool, args) {
  const url = tool.url;
  if (!url) return { stdout: '', stderr: 'webhook url missing', exit_code: 1 };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const body = await res.text();
    return {
      stdout: body,
      stderr: '',
      exit_code: res.ok ? 0 : 1,
      status: res.status,
    };
  } catch (e) {
    return { stdout: '', stderr: e.message, exit_code: 1 };
  }
}

// ── Spawn one-shot stdio MCP child to call code-server's run_python/run_nodejs
// We can't reach into the parent bridge's mcpConnections from this child process.

function callBridgeMcp(serverScript, toolName, args) {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, serverScript);
    let proc;
    try {
      proc = spawn('node', [serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (e) { return reject(e); }
    let buf = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      try { proc.kill('SIGTERM'); } catch (_) {}
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`code-exec timed out for ${toolName}`));
    }, 70_000);
    function send(obj) {
      const body = JSON.stringify(obj);
      proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
    proc.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const sep = buf.indexOf(Buffer.from('\r\n\r\n'));
        if (sep === -1) break;
        const m = buf.slice(0, sep).toString('ascii').match(/Content-Length:\s*(\d+)/i);
        if (!m) { buf = buf.slice(sep + 4); continue; }
        const len = +m[1], bodyStart = sep + 4;
        if (buf.length < bodyStart + len) break;
        let msg;
        try { msg = JSON.parse(buf.slice(bodyStart, bodyStart + len).toString()); } catch (_) {}
        buf = buf.slice(bodyStart + len);
        if (!msg) continue;
        if (msg.id === 2 && !settled) {
          settled = true;
          clearTimeout(timer);
          cleanup();
          if (msg.error) reject(new Error(msg.error.message || 'mcp error'));
          else resolve(msg.result);
        }
      }
    });
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    proc.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('code-exec exited unexpectedly'));
    });
    try {
      send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'meta-bridge', version: '1.0' } },
      });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(e);
    }
  });
}

// ── MCP stdio transport (Content-Length framed) ───────────────────────────

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}

async function handleMessage(msg) {
  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'meta-bridge', version: '1.0.0' },
      },
    });
  }
  if (msg.method === 'initialized' || msg.method === 'notifications/initialized') return;
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });

  try {
    if (msg.method === 'tools/list') {
      return send({ jsonrpc: '2.0', id: msg.id, result: buildToolsList() });
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      let result;
      if (Object.prototype.hasOwnProperty.call(dispatch, name)) {
        result = await dispatch[name](args);
      } else {
        // Dynamic user-tool call via mounted tool surface
        const t = meta.readTool(name);
        if (t) {
          const r = await runTool(t, args || {});
          meta.audit('invoke_tool', name, { exit_code: r.exit_code, via: 'direct' });
          result = text(JSON.stringify(r, null, 2));
        } else {
          // Direct skill invocation — mounted skills are also published as tools
          const body = meta.renderSkillInline(name);
          if (body === null) {
            const e = /** @type {Error & { code?: number }} */ (new Error(`Unknown tool: ${name}`)); e.code = -32601; throw e;
          }
          meta.audit('invoke_skill', name, { via: 'direct' });
          result = text(body);
        }
      }
      return send({ jsonrpc: '2.0', id: msg.id, result });
    }
    if (msg.method === 'prompts/list') {
      return send({ jsonrpc: '2.0', id: msg.id, result: buildPromptsList() });
    }
    if (msg.method === 'prompts/get') {
      return send({ jsonrpc: '2.0', id: msg.id, result: handlePromptsGet(msg.params) });
    }
  } catch (e) {
    return send({
      jsonrpc: '2.0', id: msg.id,
      error: { code: e.code || -32000, message: e.message },
    });
  }

  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
}

let inputBuffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, /** @type {Buffer} */ (chunk)]);
  while (true) {
    const sep = inputBuffer.indexOf(Buffer.from('\r\n\r\n'));
    if (sep === -1) break;
    const header = inputBuffer.slice(0, sep).toString('ascii');
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) { inputBuffer = inputBuffer.slice(sep + 4); continue; }
    const len = +m[1], bodyStart = sep + 4;
    if (inputBuffer.length < bodyStart + len) break;
    let body;
    try { body = JSON.parse(inputBuffer.slice(bodyStart, bodyStart + len).toString('utf8')); } catch (_) {}
    inputBuffer = inputBuffer.slice(bodyStart + len);
    if (body) handleMessage(body);
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
require('./_parent-watchdog').installParentWatchdog();

meta.ensureLayout();
