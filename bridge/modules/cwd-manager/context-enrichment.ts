// cwd-manager — prompt context enrichment (history + RAG).
//
// Pure CommonJS at runtime (no import/export keywords). This helper is used
// only for LLM-backed manager ticks. It intentionally degrades to empty
// sections when history/RAG are unavailable so CWD monitoring remains cheap and
// reliable without optional modules enabled.
'use strict';

const path = require('path');
const { getModuleApi } = require('../../core/modules');
const { displaySessions } = require('../../core/state');

const HISTORY_SESSION_LIMIT = 10;
const HISTORY_SNIPPET_LIMIT = 6;
const RAG_HIT_LIMIT = 6;
const RAG_TIMEOUT_MS = 8000;

type HistorySnippet = {
  sessionId: string;
  sessionName: string;
  role: string;
  ts: number;
  score: number;
  text: string;
};

type RagHitSummary = {
  db: string;
  kind: string;
  source: string;
  score: number | null;
  text: string;
};

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function messageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (typeof msg.text === 'string') return msg.text;
  if (Array.isArray(msg.blocks)) {
    return msg.blocks
      .filter((b) => b && (b.type === 'text' || b.type === 'btw'))
      .map((b) => b.content || b.text || '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function buildQuery(entry, todos, ctxLines) {
  const openTodos = Array.isArray(todos)
    ? todos.filter((t) => !['done', 'completed', 'cancelled'].includes(String(t?.status || '').toLowerCase()))
    : [];
  const todoText = openTodos
    .slice(0, 10)
    .map((t) => normalizeText(t?.content || t?.title || ''))
    .filter(Boolean)
    .join(' | ');
  const ctxText = Array.isArray(ctxLines) ? ctxLines.slice(0, 12).map(normalizeText).filter(Boolean).join(' | ') : '';
  const parts = [
    `CWD ${entry.cwd}`,
    path.basename(entry.cwd || '') || '',
    entry.needsAgentReason || entry.needsAgent || '',
    todoText,
    ctxText,
  ].filter(Boolean);
  return normalizeText(parts.join(' | ')).slice(0, 1200);
}

function queryTokens(query) {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'cwd', 'task', 'todo',
    'manager', 'check', 'done', 'open', 'active', 'status', 'need', 'needs', 'agent',
  ]);
  const toks = String(query || '').toLowerCase().match(/[a-z0-9_./-]{3,}/g) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of toks) {
    const cleaned = t.replace(/^[-./_]+|[-./_]+$/g, '');
    if (!cleaned || stop.has(cleaned) || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= 40) break;
  }
  return out;
}

function scoreText(text, tokens) {
  const lower = String(text || '').toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    if (lower.includes(tok)) score += tok.length >= 8 ? 3 : 1;
  }
  return score;
}

function localHistorySnippets(cwd, managerSessionId, query) {
  const tokens = queryTokens(query);
  const sessions = [...displaySessions.values()]
    .filter((s) => String(s?.workingDir || '') === cwd && String(s?.id || '') !== String(managerSessionId || ''))
    .sort((a, b) => Number(b?.lastUsed || 0) - Number(a?.lastUsed || 0))
    .slice(0, HISTORY_SESSION_LIMIT);

  const candidates: HistorySnippet[] = [];
  for (const s of sessions) {
    const messages = Array.isArray(s?.messages) ? s.messages : [];
    for (let i = Math.max(0, messages.length - 24); i < messages.length; i++) {
      const msg = messages[i];
      const text = normalizeText(messageText(msg));
      if (!text) continue;
      const score = tokens.length ? scoreText(text, tokens) : 1;
      if (score <= 0 && candidates.length >= 2) continue;
      candidates.push({
        sessionId: s.id,
        sessionName: s.name || '(unnamed)',
        role: msg?.role || 'message',
        ts: Number(msg?.ts || 0) || 0,
        score,
        text: text.slice(0, 700),
      });
    }
  }

  return candidates
    .sort((a, b) => (b.score - a.score) || (b.ts - a.ts))
    .slice(0, HISTORY_SNIPPET_LIMIT);
}

function withTimeout(promise: Promise<any>, ms: number): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function ragSearchSafe(cwd, query) {
  try {
    const cg = getModuleApi('context-generator');
    const searchRag = cg?.contextRag?.searchRag;
    if (typeof searchRag !== 'function') {
      return { hits: [], status: 'unavailable' };
    }
    const result = await withTimeout(searchRag({
      query,
      cwd,
      k: RAG_HIT_LIMIT,
      overFetch: 2,
      rerank: false,
    }), RAG_TIMEOUT_MS);
    if (result && result.__timeout) return { hits: [], status: 'timeout' };
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    return {
      hits: hits.slice(0, RAG_HIT_LIMIT).map((h: any): RagHitSummary => ({
        db: h.dbDisplayName || h.dbId || 'rag',
        kind: h.sourceKind || 'source',
        source: h.sourcePath || h.sourceId || h.sourceUrl || '',
        score: typeof h.rerankScore === 'number' ? h.rerankScore : (typeof h.rrfScore === 'number' ? h.rrfScore : null),
        text: normalizeText(h.text || '').slice(0, 900),
      })).filter((h) => h.text),
      status: 'ok',
      debug: result?.debug || null,
    };
  } catch (e) {
    return { hits: [], status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

async function buildContextEnrichment(entry, managerSessionId, todos, ctxLines) {
  const query = buildQuery(entry, todos, ctxLines);
  const history = localHistorySnippets(entry.cwd, managerSessionId, query);
  const rag = query ? await ragSearchSafe(entry.cwd, query) : { hits: [], status: 'empty-query' };
  return { query, history, rag };
}

function formatHistorySnippets(snippets) {
  if (!Array.isArray(snippets) || !snippets.length) return '(no relevant same-CWD history snippets found)';
  return snippets
    .map((h, idx) => {
      const when = h.ts ? new Date(h.ts).toISOString() : 'unknown-time';
      return `${idx + 1}. ${h.sessionName} (${h.sessionId}, ${h.role}, ${when}, score ${h.score}): ${h.text}`;
    })
    .join('\n');
}

function formatRagHits(rag) {
  const status = rag?.status || 'unavailable';
  const hits = Array.isArray(rag?.hits) ? rag.hits : [];
  if (!hits.length) return `(no RAG hits; status=${status})`;
  return hits
    .map((h, idx) => {
      const src = h.source ? ` ${h.source}` : '';
      const score = h.score == null ? '' : ` score=${Number(h.score).toFixed(4)}`;
      return `${idx + 1}. [${h.db}/${h.kind}${score}]${src}: ${h.text}`;
    })
    .join('\n');
}

module.exports = {
  buildContextEnrichment,
  formatHistorySnippets,
  formatRagHits,
  _private: { buildQuery, localHistorySnippets, queryTokens, scoreText },
};
