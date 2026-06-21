// Per-WD TODO persistence + HTTP routes.
//
// Storage: /tmp/yha-todos-<sanitized-cwd>.json (kept on /tmp by user choice;
// lists are ephemeral if /tmp is cleared — acceptable trade-off).
//
// One file per working directory; the "index" of which WDs have non-empty
// lists is computed by scanning matching files. Callers (TodoWrite/TodoRead
// bridge tools, the v1 routes, and the MCP-Tools aggregator) all go through
// this module so persistence stays in one place.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getModuleApi } = require('../../core/modules');

const TODO_PREFIX = 'yha-todos-';
const TODO_SUFFIX = '.json';

interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

function sanitizeKey(cwd: string | undefined): string {
  return String(cwd || 'default').replace(/[^a-z0-9]/gi, '_');
}

function fileFor(cwd: string | undefined): string {
  return path.join(os.tmpdir(), `${TODO_PREFIX}${sanitizeKey(cwd)}${TODO_SUFFIX}`);
}

function readTodos(cwd: string | undefined): Todo[] {
  try {
    const raw = fs.readFileSync(fileFor(cwd), 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [];
    try {
      getModuleApi('observability-plus')?.telemetry?.record?.({
        surface: 'memory',
        name: 'todos/read',
        durationMs: 0,
        ok: true,
        resultSize: raw.length,
        meta: { op: 'read', cwd: String(cwd || ''), count: arr.length, source: 'todos' },
      });
    } catch (_) {}
    return arr;
  } catch (_) {
    return [];
  }
}

async function writeTodos(cwd: string | undefined, todos: Todo[]): Promise<void> {
  const safe = Array.isArray(todos) ? todos : [];
  const json = JSON.stringify(safe, null, 2);
  await fs.promises.writeFile(fileFor(cwd), json, 'utf8');
  try {
    getModuleApi('observability-plus')?.telemetry?.record?.({
      surface: 'memory',
      name: 'todos/write',
      durationMs: 0,
      ok: true,
      argsSize: json.length,
      meta: { op: 'write', cwd: String(cwd || ''), count: safe.length, source: 'todos' },
    });
  } catch (_) {}
}

// Map of stored cwd-key → original cwd label. We don't get the original path
// back from the sanitized key, so we keep a side table on disk. Cheap.
const LABEL_INDEX = path.join(os.tmpdir(), 'yha-todos-_labels.json');

function readLabels(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(LABEL_INDEX, 'utf8'));
  } catch (_) {
    return {};
  }
}

async function rememberLabel(cwd: string | undefined): Promise<void> {
  if (!cwd) return;
  const labels = readLabels();
  const key = sanitizeKey(cwd);
  if (labels[key] === cwd) return;
  labels[key] = cwd;
  await fs.promises.writeFile(LABEL_INDEX, JSON.stringify(labels, null, 2), 'utf8');
}

function listAllCwds(): Array<{ key: string; cwd: string; count: number; openCount: number }> {
  const out: Array<{ key: string; cwd: string; count: number; openCount: number }> = [];
  const labels = readLabels();
  let entries: string[];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch (_) {
    return out;
  }
  for (const name of entries) {
    if (!name.startsWith(TODO_PREFIX) || !name.endsWith(TODO_SUFFIX)) continue;
    if (name === 'yha-todos-_labels.json') continue;
    const key = name.slice(TODO_PREFIX.length, -TODO_SUFFIX.length);
    const todos = readTodos(labels[key] || key);
    if (!todos.length) continue;
    const openCount = todos.filter((t) => t.status !== 'completed').length;
    out.push({ key, cwd: labels[key] || key, count: todos.length, openCount });
  }
  return out;
}

function registerTodoRoutes(app: any): void {
  app.get('/v1/todos', (_req: any, res: any) => {
    const labels = readLabels();
    const cwds = listAllCwds();
    const byCwd: Record<string, Todo[]> = {};
    for (const entry of cwds) byCwd[entry.cwd] = readTodos(entry.cwd);
    res.json({ success: true, byCwd, cwds, defaultCwd: process.cwd(), labels });
  });

  app.get('/v1/todos/cwds', (_req: any, res: any) => {
    res.json({ success: true, cwds: listAllCwds() });
  });

  app.get('/v1/todos/:cwd', (req: any, res: any) => {
    const cwd = decodeURIComponent(String(req.params.cwd || ''));
    res.json({ success: true, cwd, todos: readTodos(cwd) });
  });

  app.post('/v1/todos', async (req: any, res: any) => {
    const body = req.body || {};
    const cwd = String(body.cwd || process.cwd());
    const todos: Todo[] = Array.isArray(body.todos) ? body.todos : [];
    await writeTodos(cwd, todos);
    await rememberLabel(cwd);
    res.json({ success: true, cwd, count: todos.length });
  });
}

module.exports = {
  readTodos,
  writeTodos,
  rememberLabel,
  listAllCwds,
  registerTodoRoutes,
};
