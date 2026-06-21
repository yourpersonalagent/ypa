#!/usr/bin/env bun
/**
 * import-sessions.mjs
 * Converts Claude Code, Codex, and GitHub Copilot session files into YHA chat
 * history and inserts them directly into bridge/data/sessions.db.
 *
 * Requires Bun — uses bun:sqlite via bridge/sessions-internal/db.ts (the same
 * module the bridge opens), so each insert is bit-for-bit identical to a live
 * bridge save (same promoted columns, same data-blob shape, same UPSERT).
 *
 * Usage:
 *   bun tools/import-sessions.mjs --type <claude-code|codex|copilot> --source <path> [options]
 *
 * Options:
 *   --type              Source format: claude-code | codex | copilot
 *   --source            Source file or directory to convert
 *   --db                Target SQLite DB (default: <project>/bridge/data/sessions.db)
 *   --filter            Only process files whose path contains this string
 *   --cwd-filter        Only include sessions whose workingDir contains this string (claude-code)
 *   --overwrite         Re-import sessions that match an existing fingerprint
 *                       (UPSERTs by session id — same id replaces the row, new id adds another)
 *   --dry-run           Print what would be inserted; does not open the DB
 *   --verbose           Show per-file debug info
 *
 * Duplicate detection (always on):
 *   - Fingerprint = sha256(first user message, lowercased + whitespace-normalized + first 300 chars).
 *   - Existing DB rows are fingerprinted up front; matches are skipped unless --overwrite is passed.
 *
 * Examples (paths illustrative — substitute $HOME / %USERPROFILE%):
 *   # Claude Code sessions for this project (Linux)
 *   bun tools/import-sessions.mjs \
 *     --type claude-code \
 *     --source "$HOME/.claude/projects/<this-project-slug>/"
 *
 *   # Claude Code sessions (Windows)
 *   bun tools/import-sessions.mjs `
 *     --type claude-code `
 *     --source "$env:USERPROFILE\.claude\projects\<this-project-slug>"
 *
 *   # Codex sessions
 *   bun tools/import-sessions.mjs --type codex --source "$HOME/.codex-config/sessions/"
 *
 *   # GitHub Copilot transcripts (VS Code Insiders)
 *   bun tools/import-sessions.mjs --type copilot \
 *     --source "$HOME/.vscode-server-insiders/data/User/workspaceStorage/"
 *
 * Concurrency note: SQLite WAL (with busy_timeout=5000ms from db.ts pragmas)
 * lets this run while the bridge is up. New rows show up in the bridge's
 * in-memory cache on its next boot — restart the bridge to see imports in the
 * session picker.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename, extname, sep, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createHash } from 'crypto';
import { homedir, platform } from 'os';

const IS_WINDOWS = platform() === 'win32';

// Project root = parent of the tools/ directory that holds this script.
// Used so --db defaults to the canonical bridge DB regardless of cwd.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB = join(PROJECT_ROOT, 'bridge', 'data', 'sessions.db');

// On Linux, $HOME may be overridden to a config dir in some environments
// (e.g. tooling that sets HOME to a per-instance config dir), so we look up
// the real home via /etc/passwd. On Windows, os.homedir() reads USERPROFILE
// and is authoritative — no override pattern to defeat.
function realHome() {
  if (IS_WINDOWS) return homedir();
  try {
    if (typeof process.getuid === 'function') {
      const uid = process.getuid();
      const passwd = readFileSync('/etc/passwd', 'utf-8');
      const entry = passwd.split('\n').find(l => parseInt(l.split(':')[2]) === uid);
      if (entry) return entry.split(':')[5];
    }
  } catch { /* fall through */ }
  // Fallback: strip known config-dir suffix from $HOME
  const h = process.env.HOME || homedir() || '';
  const m = h.match(/^(\/home\/[^/]+)/);
  return m ? m[1] : h;
}
const HOME = realHome();

// ─── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const sourceType = getArg('type');
const sourcePath = getArg('source');
const dbPath     = getArg('db') || DEFAULT_DB;
const filter     = getArg('filter');
const cwdFilter  = getArg('cwd-filter');
const dryRun     = hasFlag('dry-run');
const verbose    = hasFlag('verbose');
const overwrite  = hasFlag('overwrite');

if (!sourceType || !sourcePath) {
  console.error(
    'Usage: bun tools/import-sessions.mjs --type <claude-code|codex|copilot> --source <path> [options]\n' +
    'See the docstring at the top of the file for full help.'
  );
  process.exit(1);
}

// ─── YHA session builder ─────────────────────────────────────────────────────

function makeSession(id, name, messages, workingDir, createdAt, lastUsed) {
  const userMessageCount = messages.filter(m => m.role === 'user').length;
  return {
    id,
    name: name || 'Imported Session',
    messages,
    createdAt:        createdAt  || Date.now(),
    lastUsed:         lastUsed   || Date.now(),
    workingDir:       workingDir || HOME || '',
    userMessageCount,
  };
}

// ─── Duplicate detection ─────────────────────────────────────────────────────
//
// Fingerprint = sha256 of the first user message (lowercased,
// whitespace-normalized, first 300 chars). Two sessions with the same
// fingerprint are treated as duplicates regardless of source.

function fingerprintText(text) {
  if (!text) return null;
  const normalized = String(text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function fingerprint(session) {
  const firstUser = session.messages.find(m => m.role === 'user');
  return fingerprintText(firstUser?.text);
}

// Pull first-user-message text out of the existing DB and fingerprint each.
// Correlated subquery picks the lowest-seq user row per session — fine at the
// scale we care about (thousands of sessions).
function loadFingerprintsFromDB(db) {
  const fp = new Map(); // fingerprint -> session_id
  const rows = db
    .query(`
      SELECT m.session_id AS sid, m.text AS text
      FROM messages m
      WHERE m.role = 'user'
        AND m.text IS NOT NULL
        AND m.seq = (
          SELECT MIN(seq) FROM messages
          WHERE session_id = m.session_id AND role = 'user' AND text IS NOT NULL
        )
    `)
    .all();
  for (const r of rows) {
    const f = fingerprintText(r.text);
    if (f && !fp.has(f)) fp.set(f, r.sid);
  }
  return fp;
}

// ─── Claude Code converter ────────────────────────────────────────────────────
//
// Format: JSONL, one JSON object per line.
//   { type: "user",      message: { role, content: string | ContentBlock[] }, timestamp, cwd, ... }
//   { type: "assistant", message: { id, role, model, content: ContentBlock[], stop_reason, usage }, timestamp, ... }
//   { type: "summary",   summary: string, ... }
//   { type: "queue-operation" | "last-prompt" | "file-history-snapshot", ... }  ← skipped
//
// ContentBlock types we care about:
//   { type: "text",        text }
//   { type: "tool_use",    id, name, input }   (in assistant messages)
//   { type: "tool_result", tool_use_id, content: ContentBlock[] | string }  (in user messages)

function convertClaudeCode(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  let sessionName  = null;
  let workingDir   = null;
  let createdAt    = null;
  let lastUsed     = null;
  const messages   = [];

  // Pending assistant turn: accumulated until we know its tool results
  // Each block: { type, content? } for text, or { type, name, detail, _id? } for tool-call
  // Tool results are attached by matching _id (tool_use_id) before flush.
  let pendingAsst = null; // { ts, blocks: [...], byId: Map<tool_use_id, block>, meta }

  function flushPendingAsst() {
    if (!pendingAsst) return;
    const out = [];
    for (const b of pendingAsst.blocks) {
      if (b.type === 'tool-call') {
        out.push({ type: 'tool-call', name: b.name, detail: b.detail });
        if (b._result !== undefined) {
          out.push({ type: 'tool-result', name: b.name, detail: b._result });
        }
      } else {
        out.push(b);
      }
    }
    if (out.length > 0) {
      messages.push({ role: 'assistant', ts: pendingAsst.ts, blocks: out, meta: pendingAsst.meta });
    }
    pendingAsst = null;
  }

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    if (entry.timestamp) {
      if (!createdAt || ts < createdAt) createdAt = ts;
      if (!lastUsed  || ts > lastUsed)  lastUsed  = ts;
    }

    if (entry.cwd && !workingDir) workingDir = entry.cwd;

    switch (entry.type) {
      case 'summary':
        sessionName = entry.summary;
        break;

      case 'user': {
        const msg     = entry.message || {};
        const content = msg.content;
        const toolResults = [];
        let userText = '';

        if (typeof content === 'string') {
          userText = content.trim();
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              userText += block.text;
            } else if (block.type === 'tool_result') {
              toolResults.push(block);
            }
          }
        }

        // Attach tool results to the pending assistant's matching tool-call blocks
        if (toolResults.length > 0 && pendingAsst) {
          for (const tr of toolResults) {
            const callBlock = pendingAsst.byId.get(tr.tool_use_id);
            if (callBlock) {
              callBlock._result = extractToolResultContent(tr.content);
            }
          }
          // Don't flush yet — the next assistant turn (or user text) will trigger it
        }

        if (userText.trim()) {
          flushPendingAsst();
          messages.push({ role: 'user', ts, text: userText.trim() });
        }
        break;
      }

      case 'assistant': {
        // Accumulate into the pending turn — do NOT flush here.
        // Multiple assistant JSONL entries may belong to one logical turn
        // (tool-call round-trips). Only flush when a real user message arrives.
        const msg     = entry.message || {};
        const content = Array.isArray(msg.content) ? msg.content : [];
        const usage   = msg.usage || {};

        if (!pendingAsst) {
          pendingAsst = {
            ts,
            blocks: [],
            byId: new Map(),
            meta: {
              model:               msg.model || 'unknown',
              stopReason:          msg.stop_reason || 'end_turn',
              inputTokens:         usage.input_tokens || 0,
              outputTokens:        usage.output_tokens || 0,
              cacheCreationTokens: usage.cache_creation_input_tokens || 0,
              cacheReadTokens:     usage.cache_read_input_tokens || 0,
            },
          };
        } else {
          // Merge token counts; keep last stop_reason and model
          const m = pendingAsst.meta;
          m.model               = msg.model || m.model;
          m.stopReason          = msg.stop_reason || m.stopReason;
          m.inputTokens        += usage.input_tokens || 0;
          m.outputTokens       += usage.output_tokens || 0;
          m.cacheCreationTokens+= usage.cache_creation_input_tokens || 0;
          m.cacheReadTokens    += usage.cache_read_input_tokens || 0;
        }

        for (const block of content) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            pendingAsst.blocks.push({ type: 'text', content: block.text });
          } else if (block.type === 'tool_use') {
            const b = { type: 'tool-call', name: block.name || 'Tool', detail: block.input || {}, _id: block.id };
            pendingAsst.blocks.push(b);
            if (block.id) pendingAsst.byId.set(block.id, b);
          }
        }
        break;
      }

      // Ignore everything else
    }
  }

  flushPendingAsst();

  if (!messages.length) return null;

  // Apply cwd filter if requested
  if (cwdFilter && workingDir && !workingDir.includes(cwdFilter)) return null;

  // Fall back to first user message text as session name
  if (!sessionName) {
    const firstUser = messages.find(m => m.role === 'user');
    if (firstUser) sessionName = firstUser.text.slice(0, 80).replace(/\n/g, ' ');
  }
  // Strip [SYSTEM: ...] prefix injected by some YHA presets
  if (sessionName) sessionName = sessionName.replace(/^\[SYSTEM:[^\]]*\]\s*/i, '').trim();

  const fileSlug = basename(filePath, extname(filePath)).slice(0, 8);
  const id = `cc_${createdAt || Date.now()}_${fileSlug}`;
  return makeSession(id, sessionName, messages, workingDir, createdAt, lastUsed);
}

function extractToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
  }
  return JSON.stringify(content);
}

// ─── Codex converter ──────────────────────────────────────────────────────────
//
// Format: JSONL, one JSON object per line.
//   { type: "session_meta",  payload: { id, cwd, model_provider, ... } }
//   { type: "turn_context",  payload: { model, ... } }
//   { type: "event_msg",     payload: { type: "user_message", message } }
//   { type: "event_msg",     payload: { type: "token_count", info: { last_token_usage } } }
//   { type: "event_msg",     payload: { type: "agent_message", message, phase } }
//   { type: "response_item", payload: { type: "message", role, content, phase } }
//   { type: "response_item", payload: { type: "function_call", name, arguments, call_id } }
//   { type: "response_item", payload: { type: "function_call_output", call_id, output } }
//   { type: "response_item", payload: { type: "reasoning", encrypted_content } }  ← skip
//
// Commentary messages (phase: "commentary") are skipped — only "final" responses are kept.

function convertCodex(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  let sessionName    = null;
  let workingDir     = null;
  let createdAt      = null;
  let lastUsed       = null;
  let currentModel   = 'gpt-4o';
  let lastTokenUsage = null;
  let turnCalls      = [];          // function_call items for current turn
  let turnOutputs    = new Map();   // call_id -> output for current turn
  const messages     = [];

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    if (entry.timestamp) {
      if (!createdAt || ts < createdAt) createdAt = ts;
      if (!lastUsed  || ts > lastUsed)  lastUsed  = ts;
    }

    const payload = entry.payload || {};

    switch (entry.type) {
      case 'session_meta':
        workingDir = payload.cwd || workingDir;
        break;

      case 'turn_context':
        currentModel = payload.model || currentModel;
        break;

      case 'event_msg': {
        const ptype = payload.type;

        if (ptype === 'user_message') {
          const text = payload.message || '';
          if (text.trim()) {
            if (!sessionName) sessionName = text.slice(0, 80).replace(/\n/g, ' ');
            messages.push({ role: 'user', ts, text: text.trim() });
          }
        }

        if (ptype === 'token_count' && payload.info?.last_token_usage) {
          lastTokenUsage = payload.info.last_token_usage;
        }
        break;
      }

      case 'response_item': {
        const ptype = payload.type;

        // Accumulate tool calls and their outputs; flush when the final text message arrives
        if (ptype === 'function_call') {
          let detail = {};
          try { detail = JSON.parse(payload.arguments || '{}'); } catch { detail = { raw: payload.arguments }; }
          turnCalls.push({ name: payload.name || 'function', detail, callId: payload.call_id });
        }

        if (ptype === 'function_call_output') {
          if (payload.call_id) turnOutputs.set(payload.call_id, payload.output || '');
        }

        // Only include final responses (phase: "final"), skip commentary
        if (ptype === 'message' && payload.role === 'assistant' && payload.phase === 'final') {
          const contentArr = Array.isArray(payload.content) ? payload.content : [];
          const text = contentArr
            .filter(c => c.type === 'output_text' || c.type === 'text')
            .map(c => c.text)
            .join('\n');

          const blocks = [];
          for (const call of turnCalls) {
            blocks.push({ type: 'tool-call', name: call.name, detail: call.detail });
            if (turnOutputs.has(call.callId)) {
              blocks.push({ type: 'tool-result', name: call.name, detail: turnOutputs.get(call.callId) });
            }
          }
          if (text.trim()) blocks.push({ type: 'text', content: text });

          if (blocks.length > 0) {
            const tu = lastTokenUsage || {};
            messages.push({
              role: 'assistant',
              ts,
              blocks,
              meta: {
                model:               currentModel,
                stopReason:          payload.stop_reason || 'stop',
                inputTokens:         tu.input_tokens || 0,
                outputTokens:        tu.output_tokens || 0,
                cacheCreationTokens: 0,
                cacheReadTokens:     tu.cached_input_tokens || 0,
              },
            });
          }

          // Reset turn buffer
          turnCalls = [];
          turnOutputs = new Map();
          lastTokenUsage = null;
        }
        break;
      }
    }
  }

  if (!messages.length) return null;

  const fileSlug = basename(filePath, extname(filePath)).slice(-8);
  const id = `codex_${createdAt || Date.now()}_${fileSlug}`;
  return makeSession(id, sessionName, messages, workingDir, createdAt, lastUsed);
}

// ─── GitHub Copilot converter ─────────────────────────────────────────────────
//
// Format: JSONL, one JSON object per line.
//   { type: "session.start",      data: { sessionId, startTime, copilotVersion, ... } }
//   { type: "user.message",       data: { content, attachments }, id, timestamp, parentId }
//   { type: "assistant.turn_start", data: { turnId }, ... }
//   { type: "assistant.message",  data: { messageId, content, toolRequests: [...], reasoningText }, ... }
//   { type: "assistant.turn_end", data: { turnId }, ... }
//
// toolRequests items: { toolCallId, name, arguments (JSON string), type: "function" }
// Tool results are stored in separate files and are not present in the transcript — only calls are captured.
// workingDir cannot be derived from transcripts (workspace hash is not reversible without the original URI).

// Normalize path separators to forward slashes for substring checks that
// look for known directory segments (avoids \ vs / mismatches on Windows).
function normalizeSep(p) {
  return String(p).split(sep).join('/');
}

function convertCopilot(filePath) {
  // Only process files inside a GitHub.copilot-chat/transcripts directory
  if (!normalizeSep(filePath).includes('/GitHub.copilot-chat/transcripts/')) return null;

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  let sessionName = null;
  let sessionId   = null;
  let createdAt   = null;
  let lastUsed    = null;
  const messages  = [];

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    if (entry.timestamp) {
      if (!createdAt || ts < createdAt) createdAt = ts;
      if (!lastUsed  || ts > lastUsed)  lastUsed  = ts;
    }

    const data = entry.data || {};

    switch (entry.type) {
      case 'session.start':
        sessionId = data.sessionId || sessionId;
        if (data.startTime) {
          const t = new Date(data.startTime).getTime();
          if (!isNaN(t) && (!createdAt || t < createdAt)) createdAt = t;
        }
        break;

      case 'user.message': {
        const text = (data.content || '').trim();
        if (text) {
          if (!sessionName) sessionName = text.slice(0, 80).replace(/\n/g, ' ');
          messages.push({ role: 'user', ts, text });
        }
        break;
      }

      case 'assistant.message': {
        const content  = (data.content || '').trim();
        const toolReqs = Array.isArray(data.toolRequests) ? data.toolRequests : [];

        const blocks = [];
        for (const tool of toolReqs) {
          let detail = {};
          try { detail = JSON.parse(tool.arguments || '{}'); } catch { detail = { raw: tool.arguments }; }
          blocks.push({ type: 'tool-call', name: tool.name || 'function', detail });
          // Copilot transcripts don't include tool results — calls only
        }
        if (content) blocks.push({ type: 'text', content });

        if (blocks.length > 0) {
          messages.push({
            role: 'assistant',
            ts,
            blocks,
            meta: {
              model:               'copilot',
              stopReason:          'stop',
              inputTokens:         0,
              outputTokens:        0,
              cacheCreationTokens: 0,
              cacheReadTokens:     0,
            },
          });
        }
        break;
      }

      // session.start, assistant.turn_start, assistant.turn_end — metadata only, skip
    }
  }

  if (!messages.length) return null;

  // sessionId is the UUID from the filename / session.start event
  const slug = (sessionId || basename(filePath, '.jsonl')).slice(0, 8);
  const id = `copilot_${createdAt || Date.now()}_${slug}`;
  // workingDir: workspace URI hash is not reversible without the original path
  return makeSession(id, sessionName, messages, null, createdAt, lastUsed);
}

// ─── Directory scanner ────────────────────────────────────────────────────────

function scanDir(dir, ext = '.jsonl') {
  const results = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          results.push(...scanDir(full, ext));
        } else if (stat.isFile() && entry.endsWith(ext)) {
          results.push(full);
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip unreadable dir */ }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const resolvedSource = sourcePath.replace(/^~/, HOME);
  const resolvedDB = dbPath.replace(/^~/, HOME);

  // Open the DB unless dry-run. We use the same module the bridge uses so
  // pragmas (WAL + busy_timeout) and schema application stay in lockstep.
  let dbMod = null;
  let db = null;
  if (!dryRun) {
    const dbModUrl = pathToFileURL(
      join(PROJECT_ROOT, 'bridge', 'sessions-internal', 'db.ts')
    ).href;
    dbMod = await import(dbModUrl);
    dbMod.openDB(resolvedDB);
    db = dbMod.getDB();
  }

  // Build fingerprint set from existing DB rows so re-runs skip already-imported sessions.
  const seenFingerprints = new Map(); // fingerprint -> human-readable source description
  if (!dryRun) {
    const existing = loadFingerprintsFromDB(db);
    console.log(`Dedup check : ${resolvedDB} (${existing.size} existing sessions fingerprinted)`);
    for (const [fp, sid] of existing) seenFingerprints.set(fp, `db:${sid}`);
  } else {
    console.log('Dedup check : skipped (dry-run does not open the DB)');
  }

  let files = [];
  const stat = statSync(resolvedSource);
  if (stat.isFile()) {
    files = [resolvedSource];
  } else if (stat.isDirectory()) {
    files = scanDir(resolvedSource);
  }

  if (filter) {
    files = files.filter(f => f.includes(filter));
  }

  // For Copilot, only transcripts — not debug logs or other JSONL files
  if (sourceType === 'copilot') {
    files = files.filter(f => normalizeSep(f).includes('/GitHub.copilot-chat/transcripts/'));
  }

  console.log(`\nSource type : ${sourceType}`);
  console.log(`Source path : ${resolvedSource}`);
  console.log(`Target DB   : ${resolvedDB}`);
  console.log(`Files found : ${files.length}`);
  if (dryRun) console.log('(dry-run mode — DB not opened, no rows will be written)\n');
  else console.log('');

  let converted   = 0;
  let skipped     = 0;
  let duplicates  = 0;

  for (const file of files) {
    try {
      let session = null;

      if      (sourceType === 'claude-code') session = convertClaudeCode(file);
      else if (sourceType === 'codex')       session = convertCodex(file);
      else if (sourceType === 'copilot')     session = convertCopilot(file);
      else {
        console.error(`Unknown source type: "${sourceType}". Use claude-code, codex, or copilot.`);
        process.exit(1);
      }

      if (!session || session.messages.length === 0) {
        if (verbose) console.log(`  skip (empty): ${basename(file)}`);
        skipped++;
        continue;
      }

      // Duplicate check
      const fp = fingerprint(session);
      if (fp && seenFingerprints.has(fp)) {
        const dupSource = seenFingerprints.get(fp);
        if (overwrite) {
          if (verbose) console.log(`  overwrite (dup of ${dupSource}): ${basename(file)}`);
        } else {
          if (verbose) console.log(`  skip (dup of ${dupSource}): ${basename(file)}`);
          else console.log(`  dup  ${basename(file).slice(0, 40).padEnd(40)}  -> ${dupSource}`);
          duplicates++;
          skipped++;
          continue;
        }
      }

      if (dryRun) {
        const name = (session.name || '').slice(0, 60);
        console.log(`  [dry] ${session.id}  ${session.messages.length} msgs  "${name}"`);
      } else {
        dbMod.writeSessionFull(session);
        const name = (session.name || '').slice(0, 60);
        console.log(`  wrote ${session.id}  ${session.messages.length} msgs  "${name}"`);
      }

      // Register this session's fingerprint so subsequent files in the same run don't re-emit it
      if (fp) seenFingerprints.set(fp, `imported:${session.id}`);

      converted++;
    } catch (err) {
      console.error(`  error: ${basename(file)}: ${err.message}`);
      if (verbose) console.error(err.stack);
      skipped++;
    }
  }

  console.log(`\nDone: ${converted} converted, ${duplicates} duplicates skipped, ${skipped - duplicates} other skipped.`);

  if (!dryRun) {
    dbMod.closeDB();
    if (converted > 0) {
      console.log(`Rows written to: ${resolvedDB}`);
      console.log('Restart the bridge to see the imported sessions in the picker.\n');
    } else {
      console.log('');
    }
  } else {
    console.log('');
  }
}

await main();
