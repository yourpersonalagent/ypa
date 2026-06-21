#!/usr/bin/env node
// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Skill discovery ───────────────────────────────────────────────────────────

const SKILLS_DIR = process.env.HERMES_SKILLS_DIR || path.join(os.homedir(), '.hermes', 'skills');
const SKIP_DIRS = new Set(['.git', '.github', '.hub', 'node_modules']);
const NAME_PREFIX = 'hermes:';
const URI_SCHEME = 'hermes-skill://';
const INLINE_REF_THRESHOLD = 2;

function findSkillFiles(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(p);
      } else if (e.isFile() && e.name === 'SKILL.md') {
        out.push(p);
      }
    }
  }
  walk(root);
  return out.sort();
}

function listReferenceFiles(refsDir) {
  const out = [];
  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out.push({ relPath: r, absPath: p });
    }
  }
  walk(refsDir, '');
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ── Frontmatter parser ────────────────────────────────────────────────────────
// Minimal: extracts top-level scalar keys from a YAML block. No nested objects.
// Hermes skills only need name + description; arguments is unused in current corpus.

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: content };
  const fm = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (/^\s/.test(rawLine)) continue; // skip nested keys (we only need top-level)
    const km = rawLine.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!km) continue;
    let v = km[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[km[1]] = v;
  }
  return { fm, body: m[2] };
}

// ── Build skill registry ──────────────────────────────────────────────────────

function buildRegistry() {
  const registry = new Map(); // promptName → { skillName, dir, body, description, refs[], strategy }
  for (const skillFile of findSkillFiles(SKILLS_DIR)) {
    let raw;
    try { raw = fs.readFileSync(skillFile, 'utf8'); } catch { continue; }
    const { fm, body } = parseFrontmatter(raw);
    const skillDir = path.dirname(skillFile);
    const skillName = (fm.name || path.basename(skillDir)).trim();
    if (!skillName) continue;
    const promptName = NAME_PREFIX + skillName;
    if (registry.has(promptName)) continue; // first wins on duplicates

    const refsDir = path.join(skillDir, 'references');
    let refs = [];
    if (fs.existsSync(refsDir) && fs.statSync(refsDir).isDirectory()) {
      refs = listReferenceFiles(refsDir);
    }
    const strategy = refs.length === 0 ? 'none'
      : refs.length <= INLINE_REF_THRESHOLD ? 'inline'
      : 'sidecar';

    registry.set(promptName, {
      skillName,
      dir: skillDir,
      body,
      description: (fm.description || `Hermes skill: ${skillName}`).trim(),
      refs,
      strategy,
    });
  }
  return registry;
}

const REGISTRY = buildRegistry();
const HAS_RESOURCES = [...REGISTRY.values()].some(s => s.strategy === 'sidecar');

// ── MCP request handlers ──────────────────────────────────────────────────────

function handleToolsList() {
  const skillNames = [...REGISTRY.values()].map(s => s.skillName).sort();
  return {
    tools: [
      {
        name: 'hermes_list_skills',
        description:
          'List all available Hermes skills with their one-line descriptions. ' +
          'Call this first to discover what skills exist before invoking one.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'hermes_invoke_skill',
        description:
          'Load a Hermes skill by name and return its full body. The body is ' +
          'INSTRUCTION TEXT for you to follow — typically shell commands you run with ' +
          'the Bash tool, files you read with the Read tool, or APIs you call directly. ' +
          'Hermes skills are NOT Claude Code skills: do not pass the same name to the ' +
          'built-in Skill tool, that registry is separate and will report "Unknown skill". ' +
          'Markdown links inside the body like `../gws-gmail-triage/SKILL.md` are pointers ' +
          'to sub-skill names — invoke them with this same tool (name: "gws-gmail-triage"); ' +
          'if the name is not registered, follow the parent skill\'s commands directly. ' +
          `Use hermes_list_skills first to find names. Available: ${skillNames.length} skills.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Skill name as listed by hermes_list_skills (e.g. "gws-gmail", "baoyu-comic").',
            },
          },
          required: ['name'],
        },
      },
    ],
  };
}

function handleToolsCall(params) {
  const name = params?.name;
  const args = params?.arguments || {};
  if (name === 'hermes_list_skills') {
    const list = [...REGISTRY.values()]
      .map(s => `- ${s.skillName}: ${s.description}`)
      .sort()
      .join('\n');
    return { content: [{ type: 'text', text: list }] };
  }
  if (name === 'hermes_invoke_skill') {
    const target = String(args.name || '').trim();
    if (!target) {
      const e = /** @type {Error & { code?: number }} */ (new Error('Argument "name" is required')); e.code = -32602; throw e;
    }
    const s = REGISTRY.get(NAME_PREFIX + target);
    if (!s) {
      const e = /** @type {Error & { code?: number }} */ (new Error(`Unknown skill: ${target}`)); e.code = -32602; throw e;
    }
    // Tool callers (model API path) generally can't fetch resources, so always
    // inline references here regardless of strategy. Same renderer as inline mode.
    const text = s.refs.length ? renderInline(s) : s.body;
    return { content: [{ type: 'text', text }] };
  }
  const e = /** @type {Error & { code?: number }} */ (new Error(`Unknown tool: ${name}`)); e.code = -32601; throw e;
}

function handlePromptsList() {
  const prompts = [];
  for (const [name, s] of REGISTRY) {
    prompts.push({ name, description: s.description, arguments: [] });
  }
  return { prompts };
}

function renderInline(s) {
  let out = s.body;
  for (const ref of s.refs) {
    let text;
    try { text = fs.readFileSync(ref.absPath, 'utf8'); }
    catch (e) { text = `(unable to read ${ref.relPath}: ${e.message})`; }
    out += `\n\n--- references/${ref.relPath} ---\n\n${text}`;
  }
  return out;
}

function handlePromptsGet(params) {
  const name = params?.name;
  const s = REGISTRY.get(name);
  if (!s) {
    const e = /** @type {Error & { code?: number }} */ (new Error(`Unknown prompt: ${name}`)); e.code = -32602; throw e;
  }
  const text = s.strategy === 'inline' ? renderInline(s) : s.body;
  return {
    description: s.description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}

function handleResourcesList() {
  const resources = [];
  for (const [, s] of REGISTRY) {
    if (s.strategy !== 'sidecar') continue;
    for (const ref of s.refs) {
      resources.push({
        uri: `${URI_SCHEME}${s.skillName}/references/${ref.relPath}`,
        name: `${s.skillName}/references/${ref.relPath}`,
        description: `Reference for ${s.skillName}`,
        mimeType: ref.relPath.endsWith('.md') ? 'text/markdown' : 'text/plain',
      });
    }
  }
  return { resources };
}

function resolveResourceUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(URI_SCHEME)) {
    const e = /** @type {Error & { code?: number }} */ (new Error(`Invalid resource URI: ${uri}`)); e.code = -32602; throw e;
  }
  const rest = uri.slice(URI_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash < 0) {
    const e = /** @type {Error & { code?: number }} */ (new Error(`Invalid resource URI: ${uri}`)); e.code = -32602; throw e;
  }
  const skillName = rest.slice(0, slash);
  const subPath = rest.slice(slash + 1); // expected: "references/<rel>"
  if (!subPath.startsWith('references/')) {
    const e = /** @type {Error & { code?: number }} */ (new Error(`Only references/ subpath supported`)); e.code = -32602; throw e;
  }
  const relPath = subPath.slice('references/'.length);
  const s = REGISTRY.get(NAME_PREFIX + skillName);
  if (!s) { const e = /** @type {Error & { code?: number }} */ (new Error(`Unknown skill: ${skillName}`)); e.code = -32602; throw e; }
  const refsRoot = path.resolve(s.dir, 'references');
  const target = path.resolve(refsRoot, relPath);
  if (target !== refsRoot && !target.startsWith(refsRoot + path.sep)) {
    const e = /** @type {Error & { code?: number }} */ (new Error(`Path escape rejected`)); e.code = -32602; throw e;
  }
  return { target, relPath };
}

function handleResourcesRead(params) {
  const { target, relPath } = resolveResourceUri(params?.uri);
  let text;
  try { text = fs.readFileSync(target, 'utf8'); }
  catch (e) { const err = /** @type {Error & { code?: number }} */ (new Error(`Read failed: ${e.message}`)); err.code = -32000; throw err; }
  return {
    contents: [{
      uri: params.uri,
      mimeType: relPath.endsWith('.md') ? 'text/markdown' : 'text/plain',
      text,
    }],
  };
}

// ── MCP stdio transport ───────────────────────────────────────────────────────

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    const capabilities = { tools: {}, prompts: {} };
    if (HAS_RESOURCES) capabilities.resources = {};
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities,
        serverInfo: { name: 'hermes-skills', version: '1.0.0' },
      },
    });
  }
  if (msg.method === 'initialized' || msg.method === 'notifications/initialized') return;
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });

  try {
    if (msg.method === 'tools/list') {
      return send({ jsonrpc: '2.0', id: msg.id, result: handleToolsList() });
    }
    if (msg.method === 'tools/call') {
      return send({ jsonrpc: '2.0', id: msg.id, result: handleToolsCall(msg.params) });
    }
    if (msg.method === 'prompts/list') {
      return send({ jsonrpc: '2.0', id: msg.id, result: handlePromptsList() });
    }
    if (msg.method === 'prompts/get') {
      return send({ jsonrpc: '2.0', id: msg.id, result: handlePromptsGet(msg.params) });
    }
    if (msg.method === 'resources/list') {
      return send({ jsonrpc: '2.0', id: msg.id, result: handleResourcesList() });
    }
    if (msg.method === 'resources/read') {
      return send({ jsonrpc: '2.0', id: msg.id, result: handleResourcesRead(msg.params) });
    }
  } catch (e) {
    return send({
      jsonrpc: '2.0', id: msg.id,
      error: { code: e.code || -32000, message: e.message },
    });
  }

  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
}

let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inputBuffer += chunk;
  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = inputBuffer.slice(0, headerEnd);
    const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lenMatch) { inputBuffer = inputBuffer.slice(headerEnd + 4); continue; }
    const len = parseInt(lenMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (Buffer.byteLength(inputBuffer, 'utf8') < bodyStart + len) break;
    const body = inputBuffer.slice(bodyStart, bodyStart + len);
    inputBuffer = inputBuffer.slice(bodyStart + len);
    try { handleMessage(JSON.parse(body)); } catch {}
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
require('./_parent-watchdog').installParentWatchdog();
