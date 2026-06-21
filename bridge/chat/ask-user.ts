// ── ask-user: bridge-side state for the AskUser tool ─────────────────────────
//
// When the model invokes `mcp__MCP-Tools__bridge__AskUser`, the handler
// (in tools/exec.ts) creates a question_id, registers a pending Promise
// here, broadcasts an `askUserQuestion` SSE chunk to the session's stream,
// and awaits the resolver. The frontend renders a form, the user submits,
// and `POST /v1/sessions/:id/answer-question` calls `answerQuestion(id, ...)`,
// which resolves the Promise. The handler then returns the formatted answer
// as the MCP tool result, completing the model's tool_use → tool_result loop
// without any spawn-stdin gymnastics.
'use strict';

const crypto = require('node:crypto');

interface PendingQuestion {
  resolve: (answer: string) => void;
  sessionId: string;
  timer: NodeJS.Timeout;
  questions: any[];
}

const pending: Map<string, PendingQuestion> = new Map();

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function newQuestionId(): string {
  return 'q_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

// Register a pending question. Returns { id, promise } — the caller awaits
// the promise; it resolves when the user submits an answer (or with a
// timeout-marker string if no answer arrives in time).
function registerQuestion(sessionId: string, questions: any[]): { id: string; promise: Promise<string> } {
  const id = newQuestionId();
  const promise = new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      resolve('(no answer — question timed out after 10 minutes)');
    }, DEFAULT_TIMEOUT_MS);
    pending.set(id, { resolve, sessionId, timer, questions });
  });
  return { id, promise };
}

// Resolve a pending question with the user's answer text. Returns true if a
// matching pending question was found and resolved, false otherwise (already
// answered, expired, or never existed).
function answerQuestion(id: string, sessionId: string, answer: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (entry.sessionId !== sessionId) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(answer);
  return true;
}

// Inspect a pending question without resolving — used by reconnect/replay
// paths that need to know if a question is still open.
function peekQuestion(id: string): { sessionId: string; questions: any[] } | null {
  const entry = pending.get(id);
  if (!entry) return null;
  return { sessionId: entry.sessionId, questions: entry.questions };
}

module.exports = {
  registerQuestion,
  answerQuestion,
  peekQuestion,
};
