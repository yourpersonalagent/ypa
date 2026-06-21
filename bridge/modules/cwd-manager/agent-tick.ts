// cwd-manager — agent tick (LLM-backed manager checkup).
//
// This file is intentionally pure CommonJS at runtime (no import/export
// keywords) to match bridge module loader expectations. It creates/reuses one
// manager session per CWD, pins it to that CWD, and posts a compact management
// prompt to /v1/command/. The scheduler calls this only when per-CWD
// `agentEnabled` is true and the programmatic tick says an agent is warranted.
'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { getModuleApi } = require('../../core/modules');
const { displaySessions } = require('../../core/state');
const { createBackgroundSession } = require('../../sessions-internal');
const { buildContextEnrichment, formatHistorySnippets, formatRagHits } = require('./context-enrichment');

type CwdManagerEntry = import('./types').CwdManagerEntry;

type AgentTickResult = {
  entry: CwdManagerEntry;
  response: string;
};

const MANAGER_AGENT_PRESET = `You are YPA's CWD Manager, a careful per-working-directory task supervisor.

Your job:
- Review the current CWD context and TODO list.
- Decide the next useful action for this working directory.
- Update TODO statuses when the real state is clear.
- Before doing implementation work, inspect the repository/code as needed.
- Avoid duplicate work; prefer checking existing sessions/history when relevant.
- If blocked or a human decision is needed, ask the user instead of guessing.
- Be concise: end each tick with a short status summary and what you changed.

Safety:
- Do not perform destructive operations unless the user clearly requested them.
- Do not spawn duplicate work for the same task.
- If all tasks are complete, say so and leave the TODOs completed.`;

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

function shortPath(cwd: string): string {
  const base = path.basename(cwd) || cwd;
  return base.length > 32 ? base.slice(0, 29) + '…' : base;
}

function genSessionId(): string {
  return 'cwdmgr-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function findNamedManagerSession(cwd: string): string | null {
  const targetName = `CWD Manager · ${shortPath(cwd)}`.toLowerCase();
  for (const [id, s] of displaySessions.entries()) {
    if (String(s?.name || '').toLowerCase() === targetName && String(s?.workingDir || '') === cwd) {
      return String(id);
    }
  }
  return null;
}

function ensureManagerSession(entry: CwdManagerEntry): string {
  let sid = entry.managerSessionId;
  if (sid && displaySessions.has(sid)) {
    const s = displaySessions.get(sid);
    if (s) {
      s.name = s.name || `CWD Manager · ${shortPath(entry.cwd)}`;
      s.workingDir = entry.cwd;
      s._cwdManager = true;
    }
    return sid;
  }

  sid = findNamedManagerSession(entry.cwd) || genSessionId();
  if (!displaySessions.has(sid)) createBackgroundSession(sid, `CWD Manager · ${shortPath(entry.cwd)}`);
  const s = displaySessions.get(sid);
  if (s) {
    s.name = `CWD Manager · ${shortPath(entry.cwd)}`;
    s.workingDir = entry.cwd;
    s._cwdManager = true;
  }
  return sid;
}

function recentSessionsForCwd(cwd: string, managerSessionId: string): any[] {
  return [...displaySessions.values()]
    .filter((s: any) => String(s?.workingDir || '') === cwd)
    .sort((a: any, b: any) => Number(b?.lastUsed || 0) - Number(a?.lastUsed || 0))
    .slice(0, 12)
    .map((s: any) => ({
      id: s.id,
      name: s.name,
      lastUsed: s.lastUsed || 0,
      manager: String(s.id) === String(managerSessionId),
      live: Array.isArray(s.messages) && s.messages.some((m: any) => m && m._liveToken),
    }));
}

function formatTodos(todos: any[]): string {
  if (!todos.length) return '(no todos)';
  return todos
    .slice(0, 80)
    .map((t: any, idx: number) => {
      const status = t?.status || 'pending';
      const prio = t?.priority ? `/${t.priority}` : '';
      const id = t?.id ? ` ${t.id}` : ` #${idx + 1}`;
      return `- [${status}${prio}]${id}: ${String(t?.content || '').replace(/\s+/g, ' ').trim()}`;
    })
    .join('\n');
}

function formatSessions(sessions: any[]): string {
  if (!sessions.length) return '(no sessions in this CWD)';
  return sessions
    .map((s) => `- ${s.id}${s.manager ? ' (manager)' : ''}${s.live ? ' (live)' : ''}: ${s.name || '(unnamed)'}`)
    .join('\n');
}

async function buildPrompt(entry: CwdManagerEntry, managerSessionId: string): Promise<string> {
  const todos = readTodosSafe(entry.cwd);
  const ctxLines = await readCwdContextLines(entry.cwd);
  const sessions = recentSessionsForCwd(entry.cwd, managerSessionId);
  const enrichment = await buildContextEnrichment(entry, managerSessionId, todos, ctxLines);
  const reason = entry.needsAgentReason || entry.needsAgent || 'scheduled check';

  return `CWD Manager heartbeat tick.

CWD: ${entry.cwd}
Reason: ${reason}
Mode: ${entry.mode}
Open todos: ${entry.openTodoCount}; in_progress: ${entry.inProgressCount}

TODO list:
${formatTodos(todos)}

CWD context:
${ctxLines.length ? ctxLines.map((l) => `- ${l}`).join('\n') : '(no CWD context lines)'}

Recent sessions in this CWD:
${formatSessions(sessions)}

History/RAG search query:
${enrichment.query || '(empty)'}

Relevant same-CWD chat history snippets:
${formatHistorySnippets(enrichment.history)}

Context-RAG hits (if context-RAG is enabled/configured):
${formatRagHits(enrichment.rag)}

Do one focused manager pass now. If you can safely advance or verify a task, do it. If you only need to update TODO status, do that. If nothing should be done, explain why briefly.`;
}

function dispatchCommand(prompt: string, sessionId: string): Promise<string> {
  return new Promise((resolve) => {
    const PORT = process.env.YHA_PORT || process.env.PORT || 8443;
    const payload: Record<string, unknown> = {
      Input: prompt,
      SessionId: sessionId,
      Preset: MANAGER_AGENT_PRESET,
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

async function runAgentTick(entry: CwdManagerEntry): Promise<AgentTickResult> {
  const sessionId = ensureManagerSession(entry);
  const prompt = await buildPrompt(entry, sessionId);
  const response = await dispatchCommand(prompt, sessionId);
  const next: CwdManagerEntry = {
    ...entry,
    managerSessionId: sessionId,
    lastAgentAt: Date.now(),
    lastAction: entry.needsAgent === 'checkup' ? 'checkup' : 'started_chat',
    lastError: response ? undefined : 'agent tick returned no response',
  };
  return { entry: next, response };
}

module.exports = { runAgentTick, MANAGER_AGENT_PRESET };
