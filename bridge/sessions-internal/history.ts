// ── Chat history state, policies, lazy rebuild ────────────────────────────────
'use strict';

const { config, chatHistory, displaySessions } = require('../core/state');
const logger = require('../core/logger');

// Maximum number of sessions in chatHistory (LRU-like eviction by delete)
const MAX_CHAT_HISTORY_SESSIONS = 100;

// Block types we knowingly encounter when rebuilding chat history. `text` and
// `btw` shape the rebuilt transcript; the rest are intentionally dropped
// (thinking is private reasoning, tool_use/tool-call/tool_result are flow-
// internal, image isn't text). Anything outside this set triggers a one-shot
// warn so a newly-introduced block type can't silently vanish from rebuilt
// history.
const _KNOWN_REBUILD_BLOCK_TYPES = new Set([
  'text', 'btw', 'tool_use', 'tool-call', 'tool_result', 'thinking', 'image',
]);
const _warnedUnknownBlockTypes = new Set();
function _warnUnknownBlockType(t, where) {
  if (!t || _KNOWN_REBUILD_BLOCK_TYPES.has(t) || _warnedUnknownBlockTypes.has(t)) return;
  _warnedUnknownBlockTypes.add(t);
  logger.warn('[history] dropping unknown block type from rebuild', { type: t, where });
}

function getMaxHistoryTurns() {
  const v = parseInt(config.defaults?.chat_history_max_turns, 10);
  return Number.isFinite(v) && v > 0 ? v : 8;
}

function getHistoryMode() {
  const m = String(config.defaults?.chat_history_mode || 'turns');
  return ['turns', 'turns_chars', 'split_80_20'].includes(m) ? m : 'turns';
}

function getMaxHistoryChars() {
  const v = parseInt(config.defaults?.chat_history_max_chars, 10);
  return Number.isFinite(v) && v > 0 ? v : 8000;
}

function entryChars(entry) {
  return String(entry?.content || '').length;
}

function takeLastByChars(history, maxChars) {
  if (!maxChars || maxChars < 1) return [];
  let used = 0;
  const outRev = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const c = entryChars(history[i]);
    if (outRev.length && used + c > maxChars) break;
    outRev.push(history[i]);
    used += c;
    if (used >= maxChars) break;
  }
  return outRev.reverse();
}

function takeFirstByChars(history, maxChars) {
  if (!maxChars || maxChars < 1) return [];
  let used = 0;
  const out = [];
  for (let i = 0; i < history.length; i++) {
    const c = entryChars(history[i]);
    if (out.length && used + c > maxChars) break;
    out.push(history[i]);
    used += c;
    if (used >= maxChars) break;
  }
  return out;
}

function applyHistoryPolicy(history) {
  const maxTurns = getMaxHistoryTurns();
  const base =
    history.length > maxTurns ? history.slice(history.length - maxTurns) : history.slice();
  const mode = getHistoryMode();
  if (mode === 'turns') return base;

  const maxChars = getMaxHistoryChars();
  if (mode === 'turns_chars') {
    return takeLastByChars(base, maxChars);
  }

  // split_80_20: preserve both head context and recent context under char cap.
  const frontBudget = Math.max(1, Math.floor(maxChars * 0.2));
  const backBudget = Math.max(1, maxChars - frontBudget);
  const front = takeFirstByChars(base, frontBudget);
  const back = takeLastByChars(base, backBudget);
  const frontKeys = new Set(front.map((m) => `${m.role}:${m.content.slice(0, 64)}`));
  const merged = [...front, ...back.filter((m) => !frontKeys.has(`${m.role}:${m.content.slice(0, 64)}`))];
  return merged;
}

function _enforceChatHistoryCap() {
  if (chatHistory.size > MAX_CHAT_HISTORY_SESSIONS) {
    // Evict oldest entries (Map preserves insertion order)
    const toDelete = [...chatHistory.keys()].slice(0, chatHistory.size - MAX_CHAT_HISTORY_SESSIONS);
    for (const k of toDelete) chatHistory.delete(k);
  }
}

function getHistory(sid) {
  // Lazy: chatHistory is no longer eagerly populated for every session at boot
  // (see persistence.ts). First reader for a given session triggers the
  // rebuild via ensureChatHistory; subsequent reads hit the cached map.
  if (chatHistory.has(sid)) return chatHistory.get(sid);
  return ensureChatHistory(sid);
}

function pushHistory(sid, role, content) {
  // Ensure prior turns from disk are folded in before appending — otherwise
  // the first push after restart would start from an empty array and silently
  // lose context.
  if (!chatHistory.has(sid)) ensureChatHistory(sid);
  if (!chatHistory.has(sid)) chatHistory.set(sid, []);
  const h = chatHistory.get(sid);
  h.push({ role, content });
  const pruned = applyHistoryPolicy(h);
  h.splice(0, h.length, ...pruned);
  _enforceChatHistoryCap();
}

function rebuildSessionChatHistory(sid) {
  const session = displaySessions.get(sid);
  if (!session?.messages?.length) {
    chatHistory.delete(sid);
    return;
  }
  const history = [];
  for (const msg of session.messages) {
    const role = msg.role === 'user' || msg.role === 'note' ? 'user' : 'assistant';
    let content = '';
    if (msg.text) content = msg.role === 'note' ? `[Note: ${msg.text}]` : msg.text;
    else if (msg.blocks?.length) {
      // Walk blocks in order. `btw` blocks split the assistant turn so the
      // user injection appears at its chronological position when reloading.
      // Anything before the btw is one assistant turn; anything after is the
      // next assistant turn (separated by the synthetic user btw turn).
      let textBuf = '';
      let emitted = false;
      const flushAssistant = () => {
        const t = textBuf.trim();
        textBuf = '';
        if (t) { history.push({ role: 'assistant', content: t }); emitted = true; }
      };
      for (const b of msg.blocks) {
        if (b.type === 'text') textBuf += (textBuf ? '\n' : '') + (b.content || '');
        else if (b.type === 'btw') {
          flushAssistant();
          const t = String(b.text || b.content || '').replace(/^#btw\s*/i, '').trim();
          if (t) { history.push({ role: 'user', content: `[User added mid-response: ${t}]` }); emitted = true; }
        } else {
          _warnUnknownBlockType(b?.type, 'rebuildSessionChatHistory');
        }
      }
      flushAssistant();
      if (!emitted) {
        // Tool-only turn — synthesise a summary so multi-turn context is intact
        const toolUses = msg.blocks.filter((b) => b.type === 'tool_use' || b.type === 'tool-call');
        content = toolUses.length
          ? '[Used tools: ' + toolUses.map((b) => b.name || b.tool || 'tool').join(', ') + ']'
          : '[tool result]';
      } else {
        continue; // already emitted via flushAssistant + btw splits
      }
    }
    if (!content) continue;
    history.push({ role, content });
  }
  const pruned = applyHistoryPolicy(history);
  if (pruned.length) chatHistory.set(sid, pruned);
  else chatHistory.delete(sid);
}

function rebuildChatHistoryFromDisplay() {
  // Only re-prune sessions whose history is already materialized. The map
  // is now populated lazily, so any session not present here will be (re)built
  // with the current policy on its next read via ensureChatHistory().
  for (const sid of [...chatHistory.keys()]) rebuildSessionChatHistory(sid);
}

// Build history from the perspective of a single employee/partner in a multi-
// participant chat: keep role=assistant only for that participant's own past
// turns; relabel everyone else's assistant turns as user-role messages with a
// `[Name]: ...` prefix. This prevents identity confusion when one employee
// reads another employee's prior reply as if it were their own.
function getHistoryForEmployee(sid, selfEmpId) {
  const session = displaySessions.get(sid);
  if (!session?.messages?.length) return [];
  const out = [];
  for (const msg of session.messages) {
    let content = '';
    if (msg.text) content = msg.role === 'note' ? `[Note: ${msg.text}]` : msg.text;
    else if (msg.blocks?.length) {
      for (const b of msg.blocks) {
        if (b?.type) _warnUnknownBlockType(b.type, 'getHistoryForEmployee');
      }
      content = msg.blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.content)
        .join('\n')
        .trim();
      if (!content) {
        const toolUses = msg.blocks.filter((b) => b.type === 'tool_use');
        content = toolUses.length
          ? '[Used tools: ' + toolUses.map((b) => b.name || b.tool || 'tool').join(', ') + ']'
          : '[tool result]';
      }
    }
    if (!content) continue;

    if (msg.role === 'user' || msg.role === 'note') {
      out.push({ role: 'user', content });
      continue;
    }

    const authorId = msg.author?.id || null;
    const authorName = msg.author?.name || '';
    if (authorId && authorId === selfEmpId) {
      out.push({ role: 'assistant', content });
    } else if (authorId || authorName) {
      const label = authorName || authorId || 'Other';
      out.push({ role: 'user', content: `[${label}]: ${content}` });
    } else {
      // Default-chat assistant turn (no employee author). From a named
      // employee's perspective this is "someone else", so prefix it.
      out.push({ role: 'user', content: `[Default]: ${content}` });
    }
  }
  return applyHistoryPolicy(out);
}

// Short note appended to system prompt so the model knows how to read history.
function multiAgentSystemNote(empName) {
  const name = String(empName || '').trim();
  if (!name) return '';
  return [
    `You are ${name}. This is a multi-participant chat session.`,
    `Messages from other participants appear inside user-role turns prefixed with \`[Name]:\`.`,
    `Only role=assistant messages are your own past replies — do not confuse other participants' words with your own.`,
  ].join(' ');
}

function ensureChatHistory(sid) {
  // Lazy chat history rebuild for a single session — avoids full startup scan
  if (chatHistory.has(sid)) return chatHistory.get(sid);
  const session = displaySessions.get(sid);
  if (!session?.messages?.length) {
    chatHistory.delete(sid);
    return [];
  }
  rebuildSessionChatHistory(sid);
  return chatHistory.get(sid) || [];
}

module.exports = {
  getMaxHistoryTurns,
  getHistoryMode,
  getMaxHistoryChars,
  applyHistoryPolicy,
  getHistory,
  pushHistory,
  rebuildSessionChatHistory,
  rebuildChatHistoryFromDisplay,
  ensureChatHistory,
  getHistoryForEmployee,
  multiAgentSystemNote,
};
