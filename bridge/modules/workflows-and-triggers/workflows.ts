// server-workflows.js — Workflow file-backed storage
// Each workflow stored as bridge/workflows/{id}.md
// Frontmatter: id, name, timestamps.
// Body: ## Nodes (### {id}, key: value props) + ## Connections (- a → b)
// Hot-reloads on direct file edits (mirrors server-triggers.js pattern).
'use strict';

const fs = require('fs');
const path = require('path');

// Per-user content (Q16) — routed via bridge/core/paths.ts.
// Falls back to bridge/workflows/ pre-migration.
const WORKFLOWS_DIR = require('../../core/paths').workflowsDir;
if (!fs.existsSync(WORKFLOWS_DIR)) fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
const logger = require('../../core/logger');

// In-memory store: id → { id, name, createdAt, updatedAt, graph }
const workflows = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function workflowFilePath(id) {
  const safe = String(id)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
  return path.join(WORKFLOWS_DIR, `${safe}.md`);
}

function genId() {
  return 'wf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Local types ───────────────────────────────────────────────────────────────
interface WorkflowNode { id: string; [key: string]: unknown }
interface WorkflowLink { id: string; from: string; to: string; kind?: string; fromPort?: string }

// ── MD Parser ─────────────────────────────────────────────────────────────────

function parseFrontmatter(content): any {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

function extractBody(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

// Convert a raw string value to the right JS type
function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  return v;
}

const STRING_NODE_FIELDS = new Set(['command', 'input', 'label', 'title']);

// Set a property on a node object; handles dotted keys like decisionLogic.operator
function setNodeProp(node, key, rawVal) {
  const val = STRING_NODE_FIELDS.has(key) ? (rawVal === '' ? null : rawVal) : coerce(rawVal);
  if (key.includes('.')) {
    const dot = key.indexOf('.');
    const parent = key.slice(0, dot);
    const child = key.slice(dot + 1);
    if (!node[parent] || typeof node[parent] !== 'object') node[parent] = {};
    node[parent][child] = val;
  } else {
    node[key] = val;
  }
}

// Split MD body into named sections (## Heading → content) without broken regex
function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | null = null;
  const buf: string[] = [];
  for (const line of body.split('\n')) {
    if (/^## /.test(line)) {
      if (current !== null) sections[current] = buf.join('\n');
      current = line.slice(3).trim().toLowerCase();
      buf.length = 0;
    } else {
      if (current !== null) buf.push(line);
    }
  }
  if (current !== null) sections[current] = buf.join('\n');
  return sections;
}

function parseNodes(body): WorkflowNode[] {
  const sections = parseSections(body);
  const nodesText = sections['nodes'] || '';
  if (!nodesText.trim()) return [];

  const nodes: WorkflowNode[] = [];
  const blocks = nodesText.split(/^### /m).slice(1);

  for (const block of blocks) {
    const lines = block.split('\n');
    const id = lines[0].trim();
    if (!id) continue;

    const node = { id };
    let i = 1;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      if (/^#{1,3} /.test(line)) break;

      const colon = line.indexOf(':');
      if (colon === -1) {
        i++;
        continue;
      }

      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();

      if (!val) {
        // Multiline block: read 2-space-indented continuation lines
        i++;
        const parts: string[] = [];
        while (i < lines.length) {
          const cont = lines[i];
          if (!cont.trim()) {
            i++;
            break;
          }
          // Non-indented line with a colon signals next key
          if (!/^ {2}/.test(cont) && cont.includes(':')) break;
          parts.push(cont.startsWith('  ') ? cont.slice(2) : cont.trim());
          i++;
        }
        setNodeProp(node, key, parts.join('\n').trim());
      } else {
        setNodeProp(node, key, val);
        i++;
      }
    }

    nodes.push(node);
  }

  return nodes;
}

function parseConnections(body): WorkflowLink[] {
  const sections = parseSections(body);
  const connText = sections['connections'] || '';
  if (!connText.trim()) return [];

  const links: WorkflowLink[] = [];
  for (const line of connText.split('\n')) {
    const m = line.match(/^[-*]\s+(\S+)\s*→\s*(\S+)(?:\s+\((\w+)\))?/);
    if (!m) continue;
    links.push({
      id: 'l_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
      from: m[1],
      to: m[2],
      ...(m[3] ? { fromPort: m[3] } : {}),
    });
  }
  return links;
}

function parseWorkflowMd(content) {
  const meta = parseFrontmatter(content);
  const body = extractBody(content);
  const nodes = parseNodes(body);
  const links = parseConnections(body);
  return {
    id: meta.id || '',
    name: meta.name || 'Unnamed',
    createdAt: meta.createdAt || new Date().toISOString(),
    updatedAt: meta.updatedAt || new Date().toISOString(),
    graph: { nodes, links },
  };
}

// ── MD Serializer ─────────────────────────────────────────────────────────────

const NODE_PROP_ORDER = [
  'type',
  'label',
  'command',
  'input',
  'x',
  'y',
  'disabled',
  'decisionLogic',
];
const SKIP_PROPS = new Set(['id', 'output', 'status', 'meta']);

function serializeNodeProp(key, val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') {
    // Expand { leftOperand, operator, rightOperand } to dotted lines
    return Object.entries(val)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${key}.${k}: ${v}`)
      .join('\n');
  }
  if (typeof val === 'string' && val.includes('\n')) {
    return `${key}:\n${val
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')}`;
  }
  return `${key}: ${val}`;
}

function serializeGraph(graph) {
  const nodes = graph.nodes || [];
  const links = graph.links || [];

  const nodeSections = nodes.map((n) => {
    const extra = Object.keys(n).filter((k) => !SKIP_PROPS.has(k) && !NODE_PROP_ORDER.includes(k));
    const lines: string[] = [];
    for (const key of [...NODE_PROP_ORDER, ...extra]) {
      if (!(key in n) || n[key] === undefined) continue;
      if (SKIP_PROPS.has(key)) continue;
      const line = serializeNodeProp(key, n[key]);
      if (line !== null) lines.push(line);
    }
    return `### ${n.id}\n${lines.join('\n')}`;
  });

  const connLines = links.map((l) => {
    const port = l.fromPort ? ` (${l.fromPort})` : '';
    return `- ${l.from} → ${l.to}${port}`;
  });

  return { nodeSections, connLines };
}

function buildWorkflowMd(wf, existingNotes) {
  const { nodeSections, connLines } = serializeGraph(wf.graph || { nodes: [], links: [] });

  const front = [
    '---',
    `id: ${wf.id}`,
    `name: ${wf.name}`,
    `createdAt: ${wf.createdAt}`,
    `updatedAt: ${wf.updatedAt}`,
    '---',
  ].join('\n');

  const body = [
    `# ${wf.name}`,
    '',
    '## Nodes',
    '',
    nodeSections.length ? nodeSections.join('\n\n') : '_No nodes_',
    '',
    '## Connections',
    '',
    connLines.length ? connLines.join('\n') : '_No connections_',
    '',
    existingNotes ||
      '## Notes\n\n_Add your own notes here. This section is preserved when the workflow is saved._',
  ].join('\n');

  return front + '\n\n' + body + '\n';
}

function writeWorkflowMd(wf) {
  // Preserve any user-added ## Notes content
  let existingNotes = '';
  try {
    const existing = fs.readFileSync(workflowFilePath(wf.id), 'utf8');
    const notesMatch = existing.match(/\n## Notes[\s\S]*/);
    if (notesMatch) existingNotes = notesMatch[0].trim();
  } catch (_) {}

  try {
    fs.writeFileSync(workflowFilePath(wf.id), buildWorkflowMd(wf, existingNotes), 'utf8');
  } catch (e) {
    logger.warn('workflows.write-failed', { id: wf.id, error: e instanceof Error ? e.message : String(e) });
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function createWorkflow({ name, graph }) {
  const now = new Date().toISOString();
  const wf = {
    id: genId(),
    name: String(name || 'Untitled').slice(0, 80),
    createdAt: now,
    updatedAt: now,
    graph: graph || { nodes: [], links: [] },
  };
  workflows.set(wf.id, wf);
  writeWorkflowMd(wf);
  return wf;
}

function getWorkflow(id) {
  return workflows.get(id) || null;
}

function findWorkflow(idOrName) {
  if (workflows.has(idOrName)) return workflows.get(idOrName);
  const lower = String(idOrName).toLowerCase();
  for (const wf of workflows.values()) {
    if (wf.name?.toLowerCase() === lower) return wf;
  }
  return null;
}

function updateWorkflow(id, patch) {
  const wf = workflows.get(id);
  if (!wf) return null;
  if (patch.name !== undefined) wf.name = String(patch.name).slice(0, 80);
  if (patch.graph !== undefined) wf.graph = patch.graph;
  wf.updatedAt = new Date().toISOString();
  writeWorkflowMd(wf);
  return wf;
}

function deleteWorkflow(id) {
  if (!workflows.has(id)) return false;
  // Cancel any pending file-watcher debounce so it doesn't race with the deletion
  if (_debounceTimers.has(id)) {
    clearTimeout(_debounceTimers.get(id));
    _debounceTimers.delete(id);
  }
  workflows.delete(id);
  try {
    fs.unlinkSync(workflowFilePath(id));
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn('workflows.delete-failed', { id, error: e instanceof Error ? e.message : String(e) });
  }
  return true;
}

function listWorkflows() {
  return [...workflows.values()]
    .map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// ── Disk load ─────────────────────────────────────────────────────────────────

function loadFromDisk() {
  try {
    const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8');
        const wf = parseWorkflowMd(content);
        if (wf.id) workflows.set(wf.id, wf);
      } catch (e) {
        logger.warn('workflows.load-file-failed', { file: f, error: e instanceof Error ? e.message : String(e) });
      }
    }
    logger.info('workflows.loaded', { count: workflows.size });
  } catch (e) {
    logger.error('workflows.load-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

// ── File watcher (hot-reload on direct edits) ─────────────────────────────────

const _debounceTimers = new Map();
let _dirWatcher: import("fs").FSWatcher | null = null;
let _stopped = false;

function watchDir() {
  try {
    _dirWatcher = fs.watch(WORKFLOWS_DIR, { persistent: false }, (event, filename) => {
      if (!filename?.endsWith('.md')) return;
      const id = path.basename(filename, '.md');

      if (_debounceTimers.has(id)) clearTimeout(_debounceTimers.get(id));
      _debounceTimers.set(
        id,
        setTimeout(() => {
          _debounceTimers.delete(id);
          const fp = path.join(WORKFLOWS_DIR, filename);

          if (!fs.existsSync(fp)) {
            if (workflows.has(id)) {
              workflows.delete(id);
              logger.info('workflows.external-delete', { id });
            }
            return;
          }

          try {
            const content = fs.readFileSync(fp, 'utf8');
            const wf = parseWorkflowMd(content);
            if (wf.id) {
              workflows.set(wf.id, wf);
              logger.info('workflows.external-reload', { id: wf.id });
            }
          } catch (e) {
            logger.warn('workflows.hot-reload-failed', { id, error: e instanceof Error ? e.message : String(e) });
          }
        }, 500)
      );
    });
    logger.info('workflows.watching', { dir: WORKFLOWS_DIR });
  } catch (e) {
    logger.warn('workflows.watch-unavailable', { error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Express routes ────────────────────────────────────────────────────────────

function registerWorkflowRoutes(app) {
  // GET /v1/workflows/ — list all
  app.get('/v1/workflows/', (req, res) => {
    res.json({ success: true, workflows: listWorkflows() });
  });

  // POST /v1/workflows/ — create
  app.post('/v1/workflows/', (req, res) => {
    const { name, graph } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const wf = createWorkflow({ name, graph });
    res.json({
      success: true,
      workflow: { id: wf.id, name: wf.name, createdAt: wf.createdAt, updatedAt: wf.updatedAt },
    });
  });

  // GET /v1/workflows/:id — get one with full graph
  app.get('/v1/workflows/:id', (req, res) => {
    const wf = getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, workflow: wf });
  });

  // PATCH /v1/workflows/:id — update name and/or graph
  app.patch('/v1/workflows/:id', (req, res) => {
    const wf = updateWorkflow(req.params.id, req.body);
    if (!wf) return res.status(404).json({ success: false, error: 'not found' });
    res.json({
      success: true,
      workflow: { id: wf.id, name: wf.name, createdAt: wf.createdAt, updatedAt: wf.updatedAt },
    });
  });

  // DELETE /v1/workflows/:id
  app.delete('/v1/workflows/:id', (req, res) => {
    if (!deleteWorkflow(req.params.id))
      return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true });
  });

  // GET /v1/workflows/:id/md — raw .md file
  app.get('/v1/workflows/:id/md', async (req, res) => {
    const fp = workflowFilePath(req.params.id);
    try {
      const content = await fs.promises.readFile(fp, 'utf8');
      res.type('text/plain').send(content);
    } catch (_) {
      res.status(404).json({ success: false, error: 'not found' });
    }
  });

  // POST /v1/workflows/parse-md — parse a raw .md (LLM-generated) into { name, graph }
  // Used by the frontend "⤴ MD" import button. Does NOT persist anything; the caller
  // decides whether to save the resulting graph as a new workflow.
  app.post('/v1/workflows/parse-md', (req, res) => {
    const content = (req.body && req.body.content) || '';
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ success: false, error: 'content (string) required' });
    }
    try {
      // Strip any outer ```markdown / ``` fence the LLM may have left in the answer.
      const stripped = content
        .replace(/^\s*```(?:markdown|md)?\s*\n/i, '')
        .replace(/\n```\s*$/i, '')
        .trim();
      const wf = parseWorkflowMd(stripped);
      if (!wf.graph || !Array.isArray(wf.graph.nodes) || wf.graph.nodes.length === 0) {
        return res
          .status(400)
          .json({ success: false, error: 'no nodes found — check ## Nodes section and ### nodeId headers' });
      }
      res.json({
        success: true,
        name: wf.name,
        graph: wf.graph,
      });
    } catch (e) {
      res
        .status(400)
        .json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

// ── Init / Stop ───────────────────────────────────────────────────────────────

function init() {
  _stopped = false;
  loadFromDisk();
  watchDir();
}

function stopWorkflows() {
  if (_stopped) return;
  _stopped = true;

  // Close the directory watcher
  if (_dirWatcher) {
    try { _dirWatcher.close(); } catch (_) {}
    _dirWatcher = null;
  }

  // Clear any pending debounce timers
  for (const tmr of _debounceTimers.values()) {
    clearTimeout(tmr);
  }
  _debounceTimers.clear();
}

module.exports = { init, stopWorkflows, registerWorkflowRoutes, WORKFLOWS_DIR, findWorkflow };
