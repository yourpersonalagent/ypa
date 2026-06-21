// server-employees.js — Employee (configurable agent) persistence
// Each employee is ./bridge/employees/{id}.md (YAML frontmatter + user notes).
// Modeled on server-triggers.js but with no runtime handles.
'use strict';

const fs = require('fs');
const path = require('path');

// Per-user content (Q16) — routed via bridge/core/paths.ts.
// Falls back to bridge/employees/ pre-migration.
const EMPLOYEES_DIR = require('../../core/paths').employeesDir;
if (!fs.existsSync(EMPLOYEES_DIR)) fs.mkdirSync(EMPLOYEES_DIR, { recursive: true });
const logger = require('../../core/logger');
const { BridgeInputError } = require('../../core/errors');
const { getModuleApi } = require('../../core/modules');

// id → {id,name,role,fullName,defaultModel,fallbackModel,toolSetPreset,systemPromptPreset,standard,createdAt}
const employees = new Map();

// ── MD I/O ────────────────────────────────────────────────────────────────────
function employeeFilePath(id) {
  return path.join(EMPLOYEES_DIR, `${id}.md`);
}

function parseFrontmatter(content): any {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const front = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (val === 'true') front[key] = true;
    else if (val === 'false') front[key] = false;
    else if (val === 'null' || val === '') front[key] = null;
    else if (/^\d+$/.test(val)) front[key] = parseInt(val, 10);
    else if (val.startsWith('{') || val.startsWith('[')) {
      try {
        front[key] = JSON.parse(val);
      } catch (_) {
        front[key] = val;
      }
    } else front[key] = val;
  }
  return front;
}

function extractBody(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

function defaultBody(e) {
  return [
    `# ${e.name || e.id}`,
    ``,
    `**Role**: ${e.role || '—'}${e.fullName ? `  (${e.fullName})` : ''}`,
    ``,
    `## Notes`,
    `_Describe this employee, their responsibilities, and any context the model should know._`,
  ].join('\n');
}

async function writeEmployeeMd(e) {
  let body = '';
  try {
    body = extractBody(await fs.promises.readFile(employeeFilePath(e.id), 'utf8'));
  } catch (_) {}
  if (!body) body = defaultBody(e);

  const front = [
    `---`,
    `id: ${e.id}`,
    `name: ${e.name || ''}`,
    `role: ${e.role || ''}`,
    `fullName: ${e.fullName || ''}`,
    `defaultModel: ${e.defaultModel || ''}`,
    `defaultModelProvider: ${e.defaultModelProvider || ''}`,
    `fallbackModel: ${e.fallbackModel || ''}`,
    `fallbackModelProvider: ${e.fallbackModelProvider || ''}`,
    `toolSetPreset: ${e.toolSetPreset || ''}`,
    `systemPromptPreset: ${e.systemPromptPreset || ''}`,
    `skillSetPreset: ${e.skillSetPreset || ''}`,
    `symbolColor: ${e.symbolColor || ''}`,
    `capVision: ${e.capVision || ''}`,
    `capReasoning: ${e.capReasoning || ''}`,
    `capTools: ${e.capTools || ''}`,
    `standard: ${e.standard === true}`,
    // exposeAsAgent: when true, this employee is published by the
    // `agent-tools` MCP server so other agents (Claude Code, Codex, API
    // callers) can list and invoke them via list_agents / call_agent.
    `exposeAsAgent: ${e.exposeAsAgent === true}`,
    `createdAt: ${e.createdAt || new Date().toISOString()}`,
    `---`,
  ].join('\n');

  try {
    await fs.promises.writeFile(employeeFilePath(e.id), front + '\n\n' + body + '\n', 'utf8');
  } catch (err) {
    logger.warn('employees.save-failed', { id: e.id, error: err instanceof Error ? err.message : String(err) });
  }
}

function readEmployeeMd(id) {
  try {
    return parseFrontmatter(fs.readFileSync(employeeFilePath(id), 'utf8'));
  } catch (_) {
    return null;
  }
}

function deleteEmployeeMd(id) {
  try {
    fs.unlinkSync(employeeFilePath(id));
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn('employees.delete-failed', { id, error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 24) || `emp${Date.now().toString(36)}`
  );
}

function sanitizeId(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '')
    .slice(0, 32);
}

function serialize(e) {
  return { ...e };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
function createEmployee(patch) {
  const id = sanitizeId(patch.id) || slugify(patch.name) || `emp${Date.now().toString(36)}`;
  if (employees.has(id)) throw new BridgeInputError(`Employee '${id}' already exists`, { id });
  const e = {
    id,
    name: patch.name || id,
    role: patch.role || '',
    fullName: patch.fullName || '',
    defaultModel: patch.defaultModel || '',
    defaultModelProvider: patch.defaultModelProvider || '',
    fallbackModel: patch.fallbackModel || '',
    fallbackModelProvider: patch.fallbackModelProvider || '',
    toolSetPreset: patch.toolSetPreset || '',
    systemPromptPreset: patch.systemPromptPreset || '',
    skillSetPreset: patch.skillSetPreset || '',
    symbolColor: patch.symbolColor || '',
    capVision: patch.capVision || '',
    capReasoning: patch.capReasoning || '',
    capTools: patch.capTools || '',
    standard: patch.standard === true,
    exposeAsAgent: patch.exposeAsAgent === true,
    createdAt: new Date().toISOString(),
  };
  employees.set(id, e);
  writeEmployeeMd(e).catch((err) => logger.warn('employees.create-write-failed', { id: e.id, error: err instanceof Error ? err.message : String(err) }));
  return e;
}

function updateEmployee(id, patch) {
  const e = employees.get(id);
  if (!e) return null;
  const fields = [
    'name',
    'role',
    'fullName',
    'defaultModel',
    'defaultModelProvider',
    'fallbackModel',
    'fallbackModelProvider',
    'toolSetPreset',
    'systemPromptPreset',
    'skillSetPreset',
    'symbolColor',
    'capVision',
    'capReasoning',
    'capTools',
    'exposeAsAgent',
  ];
  for (const f of fields) if (patch[f] !== undefined) e[f] = patch[f];
  writeEmployeeMd(e).catch((err) => logger.warn('employees.update-write-failed', { id: e.id, error: err instanceof Error ? err.message : String(err) }));
  return e;
}

function deleteEmployee(id) {
  const e = employees.get(id);
  if (!e) return false;
  if (e.standard) throw new BridgeInputError('Cannot delete standard employee', { id });
  employees.delete(id);
  deleteEmployeeMd(id);
  return true;
}

function getEmployee(id) {
  if (employees.has(id)) return employees.get(id);
  // Fall back to virtual partner employees so they can be added as participants
  try {
    const partners = getModuleApi('multichat-partners');
    const partnerEmps = partners?.getEnabledPartnerEmployees?.() ?? [];
    const match = partnerEmps.find((p) => p.id === id);
    if (match) return match;
  } catch (_) {}
  return null;
}
function getAllEmployees() {
  const list = [...employees.values()].map(serialize);
  // Append enabled partner agents as virtual employees so they appear in the @-picker
  try {
    const partners = getModuleApi('multichat-partners');
    const partnerEmps = partners?.getEnabledPartnerEmployees?.() ?? [];
    for (const p of partnerEmps) list.push(p);
  } catch (_) {}
  return list;
}

// ── Load from disk + seed standard ────────────────────────────────────────────
function loadFromDisk() {
  try {
    const files = fs.readdirSync(EMPLOYEES_DIR).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const id = path.basename(f, '.md');
      const data = readEmployeeMd(id);
      if (!data?.id) continue;
      employees.set(data.id, {
        id: data.id,
        name: data.name || data.id,
        role: data.role || '',
        fullName: data.fullName || '',
        defaultModel: data.defaultModel || '',
        defaultModelProvider: data.defaultModelProvider || '',
        fallbackModel: data.fallbackModel || '',
        fallbackModelProvider: data.fallbackModelProvider || '',
        toolSetPreset: data.toolSetPreset || '',
        systemPromptPreset: data.systemPromptPreset || '',
        skillSetPreset: data.skillSetPreset || '',
        symbolColor: data.symbolColor || '',
        capVision: data.capVision || '',
        capReasoning: data.capReasoning || '',
        capTools: data.capTools || '',
        standard: data.standard === true,
        exposeAsAgent: data.exposeAsAgent === true,
        createdAt: data.createdAt || new Date().toISOString(),
      });
    }
    if (!employees.has('ceodave')) {
      createEmployee({
        id: 'ceodave',
        name: 'CEOdave',
        role: 'CEO',
        fullName: 'David Steinberg',
        defaultModel: 'claude-opus-4-7',
        fallbackModel: 'claude-sonnet-4-6',
        standard: true,
      });
    }
    logger.info('employees.loaded', { count: employees.size });
  } catch (e) {
    logger.error('employees.load-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Express routes ────────────────────────────────────────────────────────────
function registerEmployeeRoutes(app) {
  app.get('/v1/employees/', (req, res) => {
    res.json({ success: true, employees: getAllEmployees() });
  });

  app.post('/v1/employees/', (req, res) => {
    try {
      const e = createEmployee(req.body || {});
      res.json({ success: true, employee: serialize(e) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.get('/v1/employees/:id', (req, res) => {
    const e = employees.get(req.params.id);
    if (!e) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, employee: serialize(e) });
  });

  app.put('/v1/employees/:id', (req, res) => {
    const e = updateEmployee(req.params.id, req.body || {});
    if (!e) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, employee: serialize(e) });
  });

  app.delete('/v1/employees/:id', (req, res) => {
    try {
      if (!deleteEmployee(req.params.id))
        return res.status(404).json({ success: false, error: 'not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(403).json({ success: false, error: err.message });
    }
  });

  // Raw MD read/write for inline editor (notes body preserved)
  app.get('/v1/employees/:id/md', async (req, res) => {
    const fp = employeeFilePath(req.params.id);
    try {
      await fs.promises.access(fp);
      const content = await fs.promises.readFile(fp, 'utf8');
      res.type('text/plain').send(content);
    } catch (_) {
      res.status(404).json({ success: false, error: 'not found' });
    }
  });

  app.put('/v1/employees/:id/md', async (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string')
      return res.status(400).json({ success: false, error: 'content required' });
    try {
      await fs.promises.writeFile(employeeFilePath(req.params.id), content, 'utf8');
      const data = readEmployeeMd(req.params.id);
      if (data?.id && employees.has(req.params.id)) {
        const e = employees.get(req.params.id);
        const fields = [
          'name',
          'role',
          'fullName',
          'defaultModel',
          'defaultModelProvider',
          'fallbackModel',
          'fallbackModelProvider',
          'toolSetPreset',
          'systemPromptPreset',
          'skillSetPreset',
          'symbolColor',
          'capVision',
          'capReasoning',
          'capTools',
        ];
        for (const f of fields) if (data[f] !== undefined) e[f] = data[f];
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

function init() {
  loadFromDisk();
}

module.exports = {
  init,
  registerEmployeeRoutes,
  getAllEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  EMPLOYEES_DIR,
};
