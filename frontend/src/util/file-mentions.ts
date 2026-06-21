// Extract file paths mentioned by the LLM in chat messages and validate that
// they exist on the server. The result drives the chip strips rendered at the
// bottom of agent message bubbles: workspace paths under the session cwd in
// `.msg-mentioned-files`, everything else in `.msg-external-files`.
//
// "Mentions" come from two places:
//   1. Tool calls — `Read`/`Edit`/`Write`/`MultiEdit`/`NotebookEdit` carry an
//      explicit `file_path` (or `notebook_path`) we trust without scanning text.
//   2. Free text in `text` and `thinking` blocks — we tokenize and pick up
//      anything that looks path-like AND has a real file extension.
//
// We deliberately ignore output of tool RESULTS (e.g. the full file body
// returned by Read, `ls` listings) — only what the model itself wrote.

import type { Block } from '../chat/chat-utils.js';
import { api } from '../api.js';

const TOOL_PATH_FIELDS: Record<string, string[]> = {
  Read: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
};

const TOOL_TEXT_FIELDS: Record<string, string[]> = {
  Bash: ['command'],
  'functions.exec_command': ['cmd', 'command'],
  'functions.apply_patch': ['patch'],
};

// Strip surrounding markdown / punctuation noise that often hugs paths in
// LLM prose: backticks, brackets, quotes, trailing sentence punctuation.
function pruneEdges(s: string): string {
  // leading
  s = s.replace(/^[`'"(\[<{*_]+/, '');
  // trailing
  s = s.replace(/[`'")\]>}*_,;:!?]+$/, '');
  // Trailing dot: drop only if it doesn't belong to a real extension.
  // Real extensions are letters/digits, so "Foo.md." → trim, but "1.0" stays.
  if (/\.[A-Za-z0-9]{1,8}\.$/.test(s)) s = s.slice(0, -1);
  return s;
}

function looksLikePath(token: string): boolean {
  if (!token) return false;
  if (token.length > 300) return false;
  // Skip obvious URLs/schemes.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
  if (token.startsWith('mailto:')) return false;
  // Must end in `.<ext>` where ext is 1–8 alphanumerics and starts with a letter.
  if (!/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(token)) return false;
  // Must not be a number-only segment like 1.5 or 3.14.
  if (/^\d+(\.\d+)+$/.test(token)) return false;
  // Skip emails — anything with `@` and no `/`.
  if (token.includes('@') && !token.includes('/')) return false;
  // Skip if it has whitespace inside (safety — shouldn't happen post-tokenize).
  if (/\s/.test(token)) return false;
  // Reject common abbreviations that match the regex (e.g. "i.e", "e.g") —
  // these need at least one letter before the dot OR a path separator OR a
  // tilde. The extension check already requires letters, so single-letter
  // bases like "a.b" are accepted. Filter the obvious abbrev cases:
  if (/^[a-zA-Z]\.[a-zA-Z]{1,3}$/.test(token) && !token.includes('/')) return false;
  return true;
}

// Walk text and pick out path-shaped tokens. Splitting on whitespace plus
// markdown delimiters keeps this fast and good enough — the backend then
// validates existence so false positives never reach the user.
function extractFromText(text: string): string[] {
  const out: string[] = [];
  const tokens = text.split(/[\s<>(){}[\]"'`,;|]+/);
  for (const raw of tokens) {
    const cleaned = pruneEdges(raw);
    if (looksLikePath(cleaned)) out.push(cleaned);
  }
  return out;
}

function extractPathsFromApplyPatchText(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const match = /^(?:\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: )(.+)$/.exec(line.trim());
    if (!match) continue;
    const path = pruneEdges(match[1]?.trim() || '');
    if (looksLikePath(path)) out.push(path);
  }
  return out;
}

export function extractMentionedFilesFromBlocks(blocks: Block[] | undefined): string[] {
  if (!blocks?.length) return [];
  const found = new Set<string>();
  for (const b of blocks) {
    if ((b.type === 'text' || b.type === 'thinking') && typeof b.content === 'string') {
      for (const tok of extractFromText(b.content)) found.add(tok);
    } else if (b.type === 'tool-call' && b.name) {
      let detail = b.detail;
      if (typeof detail === 'string') {
        try { detail = JSON.parse(detail); } catch {}
      }
      const pathFields = TOOL_PATH_FIELDS[b.name];
      if (pathFields && detail && typeof detail === 'object') {
        for (const f of pathFields) {
          const v = (detail as Record<string, unknown>)[f];
          if (typeof v === 'string' && v.trim()) found.add(v.trim());
        }
      }
      const textFields = TOOL_TEXT_FIELDS[b.name];
      if (textFields && detail && typeof detail === 'object') {
        for (const f of textFields) {
          const v = (detail as Record<string, unknown>)[f];
          if (typeof v !== 'string' || !v.trim()) continue;
          for (const tok of extractFromText(v)) found.add(tok);
          if (b.name === 'functions.apply_patch') {
            for (const tok of extractPathsFromApplyPatchText(v)) found.add(tok);
          }
        }
      } else if (b.name === 'functions.apply_patch' && typeof detail === 'string') {
        for (const tok of extractPathsFromApplyPatchText(detail)) found.add(tok);
      } else if (b.name === 'functions.exec_command' && typeof detail === 'string') {
        for (const tok of extractFromText(detail)) found.add(tok);
      }
      if (b.name === 'functions.apply_patch' && detail && typeof detail === 'object') {
        const maybeInput = (detail as Record<string, unknown>)['input'];
        if (typeof maybeInput === 'string' && maybeInput.trim()) {
          for (const tok of extractPathsFromApplyPatchText(maybeInput)) found.add(tok);
        }
      }
    }
  }
  return [...found];
}

// ── Validation cache ────────────────────────────────────────────────────────
// Keyed by `${cwd}|${raw}`. `null` resolved means we've checked and it doesn't
// exist (so we don't re-ask on every render). Pending flag avoids duplicate
// in-flight requests for the same key.

export interface ValidatedFile {
  raw: string;
  resolved: string;
  isFile: boolean;
}

function cwdBase(cwd: string): string {
  return cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
}

/** True when `resolved` is the session cwd or a path under it. */
export function isResolvedUnderCwd(resolved: string, cwd?: string): boolean {
  if (!cwd) return false;
  const base = cwdBase(cwd);
  return resolved === base || resolved.startsWith(base + '/');
}

/** Split validated mentions into workspace (under cwd) vs external paths. */
export function partitionValidatedFiles(
  files: ValidatedFile[],
  cwd?: string,
): { workspace: ValidatedFile[]; external: ValidatedFile[] } {
  if (!files.length) return { workspace: [], external: [] };
  if (!cwd) return { workspace: [], external: files };
  const workspace: ValidatedFile[] = [];
  const external: ValidatedFile[] = [];
  for (const f of files) {
    if (isResolvedUnderCwd(f.resolved, cwd)) workspace.push(f);
    else external.push(f);
  }
  return { workspace, external };
}

const cache = new Map<string, { resolved: string | null; isFile: boolean; checked: boolean }>();
const pendingKeys = new Set<string>();
const subscribers = new Set<() => void>();

function cacheKey(cwd: string, raw: string): string { return `${cwd}|${raw}`; }

let pendingQueue = new Map<string, string[]>(); // cwd → raws
let flushTimer: number | null = null;

function notifySubscribers(): void {
  for (const fn of subscribers) {
    try { fn(); } catch (_) {}
  }
}

async function flushQueue(): Promise<void> {
  flushTimer = null;
  const queue = pendingQueue;
  pendingQueue = new Map();
  for (const [cwd, raws] of queue) {
    const unique = [...new Set(raws)];
    if (!unique.length) continue;
    try {
      const r = await fetch(`${api.config.baseUrl}/v1/files/exists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: unique, cwd }),
      });
      const j = await r.json() as { success?: boolean; files?: Record<string, { exists?: boolean; resolved?: string; isFile?: boolean }> };
      if (!j.success || !j.files) {
        for (const raw of unique) {
          const k = cacheKey(cwd, raw);
          pendingKeys.delete(k);
          cache.set(k, { resolved: null, isFile: false, checked: true });
        }
        continue;
      }
      for (const raw of unique) {
        const k = cacheKey(cwd, raw);
        pendingKeys.delete(k);
        const info = j.files[raw];
        if (info && info.exists && info.resolved) {
          cache.set(k, { resolved: info.resolved, isFile: !!info.isFile, checked: true });
        } else {
          cache.set(k, { resolved: null, isFile: false, checked: true });
        }
      }
    } catch (_) {
      // Network/parse error — mark as unchecked so a later render retries.
      for (const raw of unique) pendingKeys.delete(cacheKey(cwd, raw));
    }
  }
  notifySubscribers();
}

function scheduleFlush(): void {
  if (flushTimer != null) return;
  // Was 300ms — lowered to 80ms so chips pop in soon after the path is
  // emitted. Bump back up if backend stat batches start backing up under
  // heavy streaming (each flush is one /v1/files/exists POST per cwd).
  flushTimer = window.setTimeout(() => { void flushQueue(); }, 80);
}

// Returns the subset of `paths` that are confirmed existing on disk for the
// given `cwd`. Schedules a backend check for any paths not yet seen.
export function getValidatedFiles(paths: string[], cwd: string): ValidatedFile[] {
  if (!paths.length) return [];
  const out: ValidatedFile[] = [];
  for (const raw of paths) {
    const key = cacheKey(cwd, raw);
    const hit = cache.get(key);
    if (hit && hit.checked) {
      if (hit.resolved) out.push({ raw, resolved: hit.resolved, isFile: hit.isFile });
      continue;
    }
    if (!pendingKeys.has(key)) {
      pendingKeys.add(key);
      const list = pendingQueue.get(cwd) || [];
      list.push(raw);
      pendingQueue.set(cwd, list);
    }
  }
  if (pendingQueue.size) scheduleFlush();
  return out;
}

// Subscribe to cache updates — called whenever new validation results land.
// Returns an unsubscribe function. Used by both the React Message component
// and the vanilla streaming path to re-render the chip strip when results
// arrive after the initial render.
export function subscribeFilesChecked(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

// ── Per-extension UI helpers ────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'opus', 'aac']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv']);

export type FileChipKind = 'image' | 'audio' | 'video' | 'pdf' | 'text';

export function fileChipKind(resolved: string): FileChipKind {
  const ext = (resolved.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  // Anything else maps to 'text' — clicking the chip routes through
  // fileEditor.open(), whose viewability decision lives in shouldOpenInEditor
  // (util/file-lang.ts), the same rule FilePicker and FileManager consult.
  return 'text';
}
