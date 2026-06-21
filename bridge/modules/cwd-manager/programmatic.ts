// cwd-manager — programmatic tick (no LLM).
//
// The cheap fast-path that runs every heartbeat. Reads the CWD's TODO list
// (via getModuleApi('todos')) and CWD context, then classifies the entry's
// mode + whether an agent tick is warranted. This fast path itself never
// calls the model; agent-tick.ts consumes `needsAgent` only when the user
// explicitly enables agent checkups for this CWD.
'use strict';

const crypto = require('crypto');
const { getModuleApi } = require('../../core/modules');

type CwdManagerEntry = import('./types').CwdManagerEntry;
type ProgrammaticResult = import('./types').ProgrammaticResult;

interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

function readTodosSafe(cwd: string): Todo[] {
  try {
    const api = getModuleApi('todos');
    const todos = api?.readTodos?.(cwd);
    return Array.isArray(todos) ? todos : [];
  } catch (_) {
    return [];
  }
}

async function readCwdContextSafe(cwd: string): Promise<{ lineCount: number }> {
  try {
    const { readCwdContext } = require('../../context/cwd');
    const ctx = await readCwdContext(cwd);
    return { lineCount: Array.isArray(ctx?.lines) ? ctx.lines.length : 0 };
  } catch (_) {
    return { lineCount: 0 };
  }
}

function hashTodos(todos: Todo[]): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(todos.map((t) => [t.id, t.content, t.status, t.priority])))
    .digest('hex');
}

/**
 * Run one programmatic tick against `prev`. Pure-ish: returns the next entry
 * snapshot (caller persists). Mutates nothing it doesn't own.
 *
 * Mode rules (P1):
 *   - openCount === 0           → idle, lastAction 'all_done'
 *   - todo set changed          → active, needsAgent 'progress' (something to look at)
 *   - has in_progress, no change→ active, needsAgent 'checkup'  (work may have stalled)
 *   - only pending, no change   → active, needsAgent 'progress'
 */
async function runProgrammaticTick(prev: CwdManagerEntry): Promise<ProgrammaticResult> {
  const now = Date.now();
  const cwd = prev.cwd;
  const todos = readTodosSafe(cwd);
  await readCwdContextSafe(cwd); // touched for parity / future bundle; lineCount unused in P1 classification

  const open = todos.filter((t) => t.status !== 'completed');
  const inProgress = todos.filter((t) => t.status === 'in_progress');
  const hash = hashTodos(todos);
  const todosChanged = prev.lastTodoHash !== '' && hash !== prev.lastTodoHash;

  const next: CwdManagerEntry = {
    ...prev,
    lastProgrammaticAt: now,
    lastTodoHash: hash,
    openTodoCount: open.length,
    inProgressCount: inProgress.length,
    lastError: undefined,
  };

  if (open.length === 0) {
    next.mode = 'idle';
    next.needsAgent = null;
    next.needsAgentReason = '';
    next.lastAction = 'all_done';
  } else {
    next.mode = 'active';
    if (todosChanged) {
      next.needsAgent = 'progress';
      next.needsAgentReason = 'todo list changed';
    } else if (inProgress.length > 0) {
      next.needsAgent = 'checkup';
      next.needsAgentReason = `${inProgress.length} in_progress task(s) — verify still advancing`;
    } else {
      next.needsAgent = 'progress';
      next.needsAgentReason = `${open.length} pending task(s) with no active work`;
    }
  }

  const changed =
    next.mode !== prev.mode ||
    next.openTodoCount !== prev.openTodoCount ||
    next.inProgressCount !== prev.inProgressCount ||
    next.needsAgent !== prev.needsAgent;

  return { entry: next, changed };
}

module.exports = { runProgrammaticTick };
