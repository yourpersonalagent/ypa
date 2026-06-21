// cwd-manager — worker chat launcher.
//
// Separate from the long-lived manager session. A worker chat is a focused
// background session for one todo/progress item in the monitored CWD. It is
// only started when the user explicitly enables worker chats for that CWD.
'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { getModuleApi } = require('../../core/modules');
const { displaySessions, activeStreams, activeProcesses } = require('../../core/state');
const { createBackgroundSession } = require('../../sessions-internal');
const { buildContextEnrichment, formatHistorySnippets, formatRagHits } = require('./context-enrichment');

type CwdManagerEntry = import('./types').CwdManagerEntry;

type WorkerLaunchResult = {
  entry: CwdManagerEntry;
  response: string;
  sessionId: string;
};

const WORKER_PRESET = `You are a focused YPA worker chat for one working-directory task.

Your job:
- Work only in the provided CWD and on the selected task unless blocked.
- Inspect the repository before changing code.
- Prefer small, verifiable changes.
- Update TODO status when the task clearly moves forward or completes.
- Ask the user before destructive, ambiguous, or high-risk operations.
- End with a concise status summary and verification performed.`;

function shortPath(cwd: string): string {
  const base = path.basename(cwd) || cwd;
  return base.length > 32 ? base.slice(0, 29) + '…' : base;
}

function genSessionId(): string {
  return 'cwdwork-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function compactText(s: unknown, max = 96): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function readTodosSafe(cwd: string): any[] {
  try {
    const api = getModuleApi('todos');
    const todos = api?.readTodos?.(cwd);
    return Array.isArray(todos) ? todos : [];
  } catch (_) {
    return [];
  }
}

async function readCwdContextLines(cwd: string): Promise<string[]> {
  try {
    const { readCwdContext } = require('../../context/cwd');
    const ctx = await readCwdContext(cwd);
    const lines = Array.isArray(ctx?.lines) ? ctx.lines : [];
    return lines.map((l: any) => String(l?.text ?? l ?? '')).filter(Boolean).slice(0, 80);
  } catch (_) {
    return [];
  }
}

function isSessionLive(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  if (activeStreams?.has?.(sessionId) || activeProcesses?.has?.(sessionId)) return true;
  const s = displaySessions.get(sessionId);
  return !!(s && Array.isArray(s.messages) && s.messages.some((m: any) => m && m._liveToken));
}

function findExistingWorkerForTodo(cwd: string, todoId: string): string | null {
  for (const [id, s] of displaySessions.entries()) {
    if (String(s?.workingDir || '') !== cwd) continue;
    if (s?._cwdManagerWorker && String(s?._cwdManagerTodoId || '') === String(todoId)) {
      return String(id);
    }
  }
  return null;
}

function selectTodo(todos: any[], requestedId?: string): any | null {
  const open = todos.filter((t) => t && t.status !== 'completed');
  if (!open.length) return null;
  if (requestedId) {
    const match = open.find((t) => String(t.id || '') === String(requestedId));
    if (match) return match;
  }
  const inProgress = open.find((t) => t.status === 'in_progress');
  if (inProgress) return inProgress;
  const priority = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  return [...open].sort((a, b) => (priority[String(a.priority || 'medium')] ?? 1) - (priority[String(b.priority || 'medium')] ?? 1))[0] || null;
}

function formatTodos(todos: any[]): string {
  if (!todos.length) return '(no todos)';
  return todos
    .slice(0, 80)
    .map((t: any, idx: number) => {
      const status = t?.status || 'pending';
      const prio = t?.priority ? `/${t.priority}` : '';
      const id = t?.id ? ` ${t.id}` : ` #${idx + 1}`;
      return `- [${status}${prio}]${id}: ${compactText(t?.content, 180)}`;
    })
    .join('\n');
}

function ensureWorkerSession(cwd: string, todo: any): string {
  const todoId = String(todo?.id || 'task');
  const existing = findExistingWorkerForTodo(cwd, todoId);
  const sid = existing || genSessionId();
  if (!displaySessions.has(sid)) {
    createBackgroundSession(sid, `Task: ${compactText(todo?.content, 54)} · ${shortPath(cwd)}`);
  }
  const s = displaySessions.get(sid);
  if (s) {
    s.name = `Task: ${compactText(todo?.content, 54)} · ${shortPath(cwd)}`;
    s.workingDir = cwd;
    s._cwdManagerWorker = true;
    s._cwdManagerTodoId = todoId;
  }
  return sid;
}

function dispatchCommand(prompt: string, sessionId: string): Promise<string> {
  return new Promise((resolve) => {
    const PORT = process.env.YHA_PORT || process.env.PORT || 8443;
    const payload: Record<string, unknown> = {
      Input: prompt,
      SessionId: sessionId,
      Preset: WORKER_PRESET,
      SystemMode: 'append',
    };
    const body = JSON.stringify(payload);
    const chunks: Buffer[] = [];
    const req = http.request(
      {
        hostname: 'localhost',
        port: PORT,
        path: '/v1/command/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res: any) => {
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            resolve(String(parsed.response || parsed.errorMessage || parsed.error || ''));
          } catch (_) {
            resolve('');
          }
        });
      }
    );
    req.on('error', () => resolve(''));
    req.write(body);
    req.end();
  });
}

async function buildWorkerPrompt(entry: CwdManagerEntry, todo: any): Promise<string> {
  const todos = readTodosSafe(entry.cwd);
  const ctxLines = await readCwdContextLines(entry.cwd);
  const enrichment = await buildContextEnrichment(entry, entry.managerSessionId || '', todos, ctxLines);
  return `CWD Manager worker task.

CWD: ${entry.cwd}
Selected todo: ${todo?.id || '(no id)'}
Selected todo text: ${String(todo?.content || '').trim()}
Selected todo status: ${todo?.status || 'pending'}${todo?.priority ? `\nPriority: ${todo.priority}` : ''}

Current TODO list:
${formatTodos(todos)}

CWD context:
${ctxLines.length ? ctxLines.map((l) => `- ${l}`).join('\n') : '(no CWD context lines)'}

Relevant same-CWD chat history snippets:
${formatHistorySnippets(enrichment.history)}

Context-RAG hits (if context-RAG is enabled/configured):
${formatRagHits(enrichment.rag)}

Do one focused implementation/progress pass for the selected todo. If it cannot be safely advanced, ask the user what is needed and explain the blocker. If you complete or materially advance it, update the TODO list accordingly.`;
}

async function launchWorkerChat(entry: CwdManagerEntry, requestedTodoId?: string): Promise<WorkerLaunchResult> {
  if (isSessionLive(entry.activeCheckupSessionId)) {
    return { entry, response: 'worker already running', sessionId: entry.activeCheckupSessionId || '' };
  }

  const todos = readTodosSafe(entry.cwd);
  const todo = selectTodo(todos, requestedTodoId);
  if (!todo) {
    return {
      entry: { ...entry, lastError: 'no open todo available for worker chat' },
      response: '',
      sessionId: '',
    };
  }

  const sessionId = ensureWorkerSession(entry.cwd, todo);
  if (isSessionLive(sessionId)) {
    return {
      entry: { ...entry, activeCheckupSessionId: sessionId, lastAction: 'started_chat', lastError: undefined },
      response: 'worker already running',
      sessionId,
    };
  }

  const prompt = await buildWorkerPrompt(entry, todo);
  const response = await dispatchCommand(prompt, sessionId);
  const next: CwdManagerEntry = {
    ...entry,
    activeCheckupSessionId: sessionId,
    lastWorkerAt: Date.now(),
    lastAction: 'started_chat',
    lastError: response ? undefined : 'worker chat returned no response',
  };
  return { entry: next, response, sessionId };
}

module.exports = { launchWorkerChat, isSessionLive, WORKER_PRESET };
