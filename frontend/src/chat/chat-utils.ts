import { iconSvg, monochromizeEmojis } from './icons.js';
import { fileChipKind, partitionValidatedFiles, type ValidatedFile } from '../util/file-mentions.js';

export interface Block {
  type: string;
  content?: string;
  name?: string;
  detail?: unknown;
  toolId?: string | null;
  text?: string;
  kind?: string;
  ts?: number;
  bufferedChunks?: number;
  chunkCap?: number;
  approxTailMs?: number | null;
  postFinishGraceMs?: number;
  replayedCount?: number;
  fromSeq?: number;
  gapMs?: number | null;
  livePath?: 'direct' | 'harness' | 'unknown';
  // multichat-row payload — present only on the host-session marker that
  // the inline MultichatRow component reads to render N mini-bubbles.
  groupId?: string;
  turnIndex?: number;
  slots?: Array<{ sessionId: string; label: string; id: string }>;
  // ask-user-question payload — block for an in-flight (or answered) AskUser
  // tool call. `questionId` matches the bridge's pending-questions registry;
  // `questions` is the verbatim AskUserQuestion-shape array; `answered`
  // flips true once the user submits and the summary is recorded here so
  // reload/replay shows the resolved state without re-rendering the form.
  questionId?: string;
  questions?: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
  answered?: boolean;
  answerSummary?: string;
  // timeout interrupt extras (injected by Node sweeper on LIVE_MSG_MAX_DURATION_MS)
  elapsedMs?: number;
  partialLen?: number;
  model?: string;
  provider?: string;
}

export interface Employee {
  id: string;
  name?: string;
  role?: string;
  symbolColor?: string;
}

export interface MsgMeta {
  model?: string;
  author?: Employee;
  tokensPerSec?: number;
  tokenCount?: number;
  durationMs?: number;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  // Persisted (disk/reload) meta keeps the cached prompt tokens disjoint from
  // inputTokens (the uncached delta). The live finalize path instead pre-folds
  // them into inputTokens and omits these. buildStatsHtml folds whatever is
  // present, so both shapes display the same "tokens in" total — see there.
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  // multichat host-session marker fields — read by MessageList when role
  // === 'multichat-turn' to render an inline row of mini-bubbles.
  groupId?: string;
  turnIndex?: number;
}

export interface BlockCounts {
  toolCalls: number;
  subagentCalls: number;
  modelCalls: number;
}

export interface ChatMessage {
  _mid?: number;
  role: string;
  text?: string;
  blocks?: Block[];
  reasoning?: string;
  typing?: boolean;
  ts?: number;
  meta?: MsgMeta;
  toolCalls?: Array<{ type?: string; name?: string; detail?: string }>;
  images?: Array<{ name: string; url: string }>;
}

export type MarkdownIt = { render: (text: string) => string };

export const chatUtils = {
  ICON_COPY: `<svg viewBox="0 0 13 13" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="0.5" width="8" height="9.5" rx="1.3"/><rect x="0.5" y="3" width="8" height="9.5" rx="1.3"/></svg>`,
  ICON_EDIT: `<svg viewBox="0 0 13 13" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5 L11.5 4 L4 11.5 L1 12 L1.5 9 Z"/><line x1="7.5" y1="3" x2="10" y2="5.5"/></svg>`,
  ICON_BRANCH: `<svg viewBox="0 0 13 13" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><circle cx="2.5" cy="2.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="2.5" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="10.5" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><line x1="2.5" y1="4" x2="2.5" y2="6.5"/><path d="M2.5 6.5 C2.5 9 10.5 9 10.5 9"/></svg>`,
  ICON_DELETE: `<svg viewBox="0 0 13 13" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="11" y2="11"/><line x1="11" y1="2" x2="2" y2="11"/></svg>`,
  ICON_SPEAK: `<svg viewBox="0 0 13 13" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 5 L4 5 L7 2.5 L7 10.5 L4 8 L1.5 8 Z"/><path d="M9 4.5 C10 5.5 10 7.5 9 8.5"/><path d="M10.5 3 C12.5 5 12.5 8 10.5 10"/></svg>`,

  escHtml(s: unknown): string {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(s).replace(/[&<>"']/g, (c) => map[c] ?? c);
  },

  getMsgText(msg: ChatMessage): string {
    if (msg.blocks)
      return msg.blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.content)
        .join('\n')
        .trim();
    return msg.text || '';
  },

  fmtDuration(ms: number | undefined): string {
    if (!ms) return '';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  },

  fmtShortDuration(ms: number | null | undefined): string {
    if (!ms || ms <= 0) return '';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 60 / 60_000)}h`;
  },

  // Progressive elapsed clock for the live busy bar: seconds-only under a
  // minute (`45s`), minutes+seconds under an hour (`5m 03s`), then
  // hours+minutes+seconds (`1h 05m 03s`). Trailing units are zero-padded so
  // the readout width stays steady as it ticks (no horizontal jitter).
  fmtLiveElapsed(ms: number | null | undefined): string {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const p2 = (n: number) => String(n).padStart(2, '0');
    if (h > 0) return `${h}h ${p2(m)}m ${p2(s)}s`;
    if (m > 0) return `${m}m ${p2(s)}s`;
    return `${s}s`;
  },

  fmtTokenCount(n: number | undefined): string {
    if (!n) return '0';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  },

  fmtMsgTime(ts: number | undefined): string {
    if (!ts) return '';
    const d = new Date(ts);
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${mo}/${dy} ${hh}:${mm}`;
  },

  computeBlockCounts(blocks: Block[] | undefined): BlockCounts {
    if (!blocks || !blocks.length) return { toolCalls: 0, subagentCalls: 0, modelCalls: 0 };
    let toolCalls = 0, subagentCalls = 0, modelCalls = 0, inModelTurn = false;
    for (const b of blocks) {
      if (!inModelTurn && (b.type === 'text' || b.type === 'thinking' || b.type === 'tool-call')) {
        modelCalls++;
        inModelTurn = true;
      }
      if (b.type === 'tool-result') inModelTurn = false;
      if (b.type === 'tool-call') {
        toolCalls++;
        if (b.name === 'Task') subagentCalls++;
      }
    }
    return { toolCalls, subagentCalls, modelCalls };
  },

  buildStatsHtml(meta: MsgMeta | undefined, ts: number | undefined, role: string, counts: BlockCounts | null): string {
    const parts: string[] = [];
    if (role === 'agent' && meta && meta.model)
      parts.push(`<span class="meta-model">${this.escHtml(meta.model)}</span>`);
    if (meta && meta.tokensPerSec)
      parts.push(`<span class="meta-stat">~${meta.tokensPerSec} tok/s</span>`);
    // Fold cached prompt tokens into the displayed "tokens in". Persisted meta
    // carries the uncached delta in inputTokens with the bulk in cacheRead/
    // cacheCreation (disjoint counts); the live finalize path pre-folds them
    // into inputTokens and omits the cache fields. Summing here makes both
    // shapes read the same total instead of the bare ~2 delta after a reload.
    const inDisplay = (meta?.inputTokens || 0) + (meta?.cacheReadTokens || 0) + (meta?.cacheCreationTokens || 0);
    if (meta && (inDisplay || meta.outputTokens)) {
      parts.push(`<span class="meta-stat" title="Input tokens (incl. cached prompt)">${iconSvg('arrow-up', 11)}${this.fmtTokenCount(inDisplay)}</span>`);
      parts.push(`<span class="meta-stat" title="Output tokens">${iconSvg('arrow-down', 11)}${this.fmtTokenCount(meta.outputTokens || 0)}</span>`);
    } else if (meta && meta.tokenCount) {
      parts.push(`<span class="meta-stat">~${meta.tokenCount} tok</span>`);
    }
    if (meta && meta.durationMs)
      parts.push(`<span class="meta-stat">${this.fmtLiveElapsed(meta.durationMs)}</span>`);
    if (counts && counts.toolCalls > 0) {
      const nonSub = counts.toolCalls - counts.subagentCalls;
      if (nonSub > 0) parts.push(`<span class="meta-stat" title="Tool calls">${iconSvg('settings', 11)} ${nonSub}</span>`);
      if (counts.subagentCalls > 0)
        parts.push(`<span class="meta-stat" title="Subagent calls">${iconSvg('bot', 11)} ${counts.subagentCalls}</span>`);
    }
    if (counts && counts.modelCalls > 1)
      parts.push(`<span class="meta-stat" title="Model API calls">${counts.modelCalls}×</span>`);
    if (meta && meta.stopReason && meta.stopReason !== 'end_turn' && meta.stopReason !== 'stop')
      parts.push(`<span class="meta-stop">${this.escHtml(meta.stopReason)}</span>`);
    const t = this.fmtMsgTime(ts);
    if (t) parts.push(`<span class="meta-stat">${t}</span>`);
    return parts.join('<span class="meta-sep">·</span>');
  },

  // Live "busy" meta bar stats, painted from the turn's START off the
  // backend `_live` counter frames. Mirrors buildStatsHtml but for in-flight
  // values: a client-clock elapsed readout (bumped by a shared 250ms
  // interval — elapsed is never sent over the wire), input/output tokens,
  // tool-call count, and model-API-call count. The elapsed span carries
  // data-live-start so the clock interval can recompute it cheaply between
  // full renders.
  buildLiveStatsHtml(vals: { model?: string; inputTokens: number; outputTokens: number; toolCallCount: number; apiCallCount: number; startMs: number }): string {
    const parts: string[] = [];
    if (vals.model) parts.push(`<span class="meta-model">${this.escHtml(vals.model)}</span>`);
    const elapsed = this.fmtLiveElapsed(Math.max(0, Date.now() - vals.startMs));
    parts.push(`<span class="meta-stat live-elapsed" data-live-start="${vals.startMs}">${elapsed}</span>`);
    parts.push(`<span class="meta-stat" title="Input tokens">${iconSvg('arrow-up', 11)}${this.fmtTokenCount(vals.inputTokens || 0)}</span>`);
    parts.push(`<span class="meta-stat" title="Output tokens">${iconSvg('arrow-down', 11)}${this.fmtTokenCount(vals.outputTokens || 0)}</span>`);
    if (vals.toolCallCount > 0)
      parts.push(`<span class="meta-stat" title="Tool calls">${iconSvg('settings', 11)} ${vals.toolCallCount}</span>`);
    if (vals.apiCallCount > 1)
      parts.push(`<span class="meta-stat" title="Model API calls">${vals.apiCallCount}×</span>`);
    return parts.join('<span class="meta-sep">·</span>');
  },

  avatarFor(role: string): string {
    return ({ user: 'U', agent: 'AI', system: 'S', error: '!', note: '✎' } as Record<string, string>)[role] ?? '·';
  },

  renderMd(text: string | undefined, md: MarkdownIt | null): string {
    if (!text) return '';
    if (md) {
      const html = md.render(String(text));
      return monochromizeEmojis(this.injectExchangePreviews(this.convertCellTaskBoxes(html)));
    }
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
    const escaped = String(text)
      .replace(/[&<>]/g, (c) => map[c] ?? c)
      .replace(/\n/g, '<br>');
    return monochromizeEmojis(escaped);
  },

  // markdown-it-task-lists only converts `- [ ]` at the start of a list item.
  // Inside a <td>, a literal `[ ]` / `[x]` survives as plain text — so assistants
  // emitting Mon/Tue/Wed-column todo tables get unrendered brackets. Rewrite a
  // leading task marker in each cell to a disabled checkbox (styled by the
  // existing .task-list-item-checkbox rules).
  convertCellTaskBoxes(html: string): string {
    return html.replace(/(<td\b[^>]*>)\s*\[([ xX])\]\s*/g, (_m, openTag, ch) => {
      const checked = ch === 'x' || ch === 'X';
      return `${openTag}<input type="checkbox" class="task-list-item-checkbox" disabled${checked ? ' checked' : ''}> `;
    });
  },

  injectExchangePreviews(html: string): string {
    const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp|svg)$/i;
    const EXTS = 'png|jpg|jpeg|gif|webp|svg';
    const FILE_EXTS = 'png|jpg|jpeg|gif|webp|svg|pdf|csv|txt|json|html|mp4|mp3|wav';
    // Partner agents (e.g. Hermes) emit `MEDIA:<absolute-path>` to attach a TTS audio file.
    const MEDIA_RE = /MEDIA:(\/[-\w./]+\.(?:ogg|mp3|wav|m4a|flac|opus|aac))/gi;
    // Three groups: (1) web image URL  (2) absolute local path  (3) bare filename
    // Group 3 requires at least one letter in the basename so that bare frame
    // numbers like "05.png" or "09.png" — which appear when the AI writes
    // ranges like "fighting-01…09.png" and the ellipsis splits the token —
    // are never mistaken for exchange files and rendered as broken <img>s.
    const TOKEN_RE = new RegExp(
      `(https?://[^\\s<>"']+\\.(?:${EXTS}))` +
      `|(\\/[-\\w./]+\\.(?:${FILE_EXTS}))` +
      `|([-\\w]*[a-zA-Z][-\\w]*\\.(?:${FILE_EXTS}))`,
      'gi'
    );
    // Split on HTML tags so we only transform text nodes, not tag attributes
    return html.replace(/(<[^>]+>)|([^<]+)/g, (chunk, tag, text) => {
      if (tag) return tag;
      if (!text) return chunk;
      text = text.replace(MEDIA_RE, (_m: string, audioPath: string) => {
        const url = `/local-image?path=${encodeURIComponent(audioPath)}`;
        const name = audioPath.split('/').pop() || audioPath;
        return `<audio controls preload="none" src="${url}" class="msg-inline-audio" title="${this.escHtml(name)}"></audio>`;
      });
      return text.replace(TOKEN_RE, (_m: string, webUrl: string, localPath: string, bare: string) => {
        if (webUrl) {
          const name = webUrl.split('/').pop()?.split('?')[0] || webUrl;
          return `<img src="${this.escHtml(webUrl)}" alt="${this.escHtml(name)}" class="msg-inline-img" loading="lazy" />`;
        }
        if (localPath) {
          // Pet sprite assets (/pets/...) are app-internal UI files — skip inline
          // rendering entirely so sprite names mentioned in chat stay as plain text.
          if (localPath.startsWith('/pets/')) return _m;
          const name = localPath.split('/').pop() || localPath;
          const url = `/local-image?path=${encodeURIComponent(localPath)}`;
          if (IMAGE_EXT.test(localPath)) {
            return `<img src="${this.escHtml(url)}" alt="${this.escHtml(name)}" class="msg-inline-img" loading="lazy" />`;
          }
          return `<a href="${url}" target="_blank" class="exchange-file-link">${this.escHtml(localPath)}</a>`;
        }
        // bare filename
        const url = `/exchange/${bare}`;
        if (IMAGE_EXT.test(bare)) {
          return `<img src="${url}" alt="${this.escHtml(bare)}" class="msg-inline-img" loading="lazy" />`;
        }
        return `<a href="${url}" target="_blank" class="exchange-file-link">${this.escHtml(bare)}</a>`;
      });
    });
  },

  // Render file-chip strips at the bottom of agent bubbles (just above
  // msg-meta). Workspace paths (under the session cwd) land in
  // `.msg-mentioned-files`; everything else is collected in one
  // `.msg-external-files` strip. Each chip carries the validated absolute
  // path on `data-path`; chat.ts routes clicks to the editor / preview /
  // player based on `data-kind`.
  buildMentionedFilesHtml(files: ValidatedFile[] | undefined, cwd?: string): string {
    if (!files?.length) return '';
    const { workspace, external } = partitionValidatedFiles(files, cwd);
    let html = '';
    if (workspace.length) html += this.buildFileChipStripHtml(workspace, 'msg-mentioned-files', cwd, false);
    if (external.length) html += this.buildFileChipStripHtml(external, 'msg-external-files', cwd, true);
    return html;
  },

  buildFileChipStripHtml(
    files: ValidatedFile[],
    stripClass: string,
    cwd?: string,
    forceAbsolute = false,
  ): string {
    if (!files.length) return '';
    const base = cwd ? (cwd.endsWith('/') ? cwd.slice(0, -1) : cwd) : '';
    const seen = new Set<string>();
    const items: string[] = [];
    if (stripClass === 'msg-external-files') {
      items.push(`<span class="mfc-section-label">External</span>`);
    }
    for (const f of files) {
      if (seen.has(f.resolved)) continue;
      seen.add(f.resolved);
      const kind = fileChipKind(f.resolved);
      let display: string;
      if (!forceAbsolute && base && f.resolved === base) display = '.';
      else if (!forceAbsolute && base && f.resolved.startsWith(base + '/')) {
        display = f.resolved.slice(base.length + 1);
      } else {
        display = f.resolved;
      }
      const iconMap: Record<string, string> = {
        image: 'image',
        audio: 'circle-dot',
        video: 'circle-dot',
        pdf: 'file-text',
        text: 'file-text',
      };
      const icon = iconSvg(iconMap[kind] || 'file-text', 12);
      items.push(
        `<button type="button" class="mentioned-file-chip" ` +
        `data-kind="${this.escHtml(kind)}" ` +
        `data-path="${this.escHtml(f.resolved)}" ` +
        `data-raw="${this.escHtml(f.raw)}" ` +
        `title="${this.escHtml(f.resolved)}">` +
        `<span class="mfc-icon">${icon}</span>` +
        `<span class="mfc-name">${this.escHtml(display)}</span>` +
        `</button>`
      );
    }
    return `<div class="${stripClass}" data-persistent="1">${items.join('')}</div>`;
  },

  toolPillHtml(type: string, name: string, detail: unknown): string {
    const icon = iconSvg(type === 'tool-call' ? 'settings' : 'corner-down-right', 13);
    const fullStr = typeof detail === 'object' ? JSON.stringify(detail, null, 2) : String(detail || '');
    const snippet = (typeof detail === 'object' ? JSON.stringify(detail) : String(detail || '')).slice(0, 55);
    return (
      `<div class="tool-pill ${this.escHtml(type)}">` +
      `<div class="pill-row">` +
      `<span class="pill-icon">${icon}</span>` +
      `<span class="pill-name">${this.escHtml(name)}</span>` +
      `<span class="pill-snippet">${this.escHtml(snippet)}</span>` +
      `</div><div class="pill-full">${this.escHtml(fullStr)}</div></div>`
    );
  },

  // Renders an AskUser tool call as an inline form: each question gets its
  // own fieldset with radio (single-select) or checkbox (multiSelect) inputs
  // plus an optional notes textarea, then one Submit button at the bottom.
  // After the user submits, the bridge sends `askUserQuestionAnswered`,
  // chat-streaming flips `b.answered = true`, and we render the resolved
  // summary instead of the form.
  askUserQuestionHtml(b: Block): string {
    const qid = String(b.questionId || '');
    const questions = Array.isArray(b.questions) ? b.questions : [];
    if (b.answered) {
      const summary = String(b.answerSummary || '(answered)');
      return (
        `<div class="ask-user-block ask-user-answered" data-question-id="${this.escHtml(qid)}">` +
        `<div class="ask-user-title"><span class="ask-user-icon">${iconSvg('check', 13)}</span>Answered</div>` +
        `<pre class="ask-user-summary">${this.escHtml(summary)}</pre>` +
        `</div>`
      );
    }
    const blocks = questions.map((q, qi) => {
      const inputType = q.multiSelect ? 'checkbox' : 'radio';
      const groupName = `${qid}-q${qi}`;
      const opts = (q.options || []).map((opt) => {
        const label = String(opt.label || '');
        const desc = String(opt.description || '');
        return (
          `<label class="ask-user-option">` +
          `<input type="${inputType}" name="${this.escHtml(groupName)}" value="${this.escHtml(label)}" data-q-index="${qi}" />` +
          `<span class="ask-user-option-text">` +
          `<span class="ask-user-option-label">${this.escHtml(label)}</span>` +
          (desc ? `<span class="ask-user-option-desc">${this.escHtml(desc)}</span>` : '') +
          `</span>` +
          `</label>`
        );
      }).join('');
      const header = q.header ? `<span class="ask-user-q-header">${this.escHtml(q.header)}</span>` : '';
      const multi = q.multiSelect ? `<span class="ask-user-q-multi" title="Multi-select">multi</span>` : '';
      return (
        `<fieldset class="ask-user-question" data-q-index="${qi}">` +
        `<legend class="ask-user-q-legend">${header}${multi}</legend>` +
        `<div class="ask-user-q-text">${this.escHtml(q.question || '')}</div>` +
        `<div class="ask-user-options">${opts}</div>` +
        `<textarea class="ask-user-notes" data-q-index="${qi}" placeholder="Optional notes..." rows="2"></textarea>` +
        `</fieldset>`
      );
    }).join('');
    const icon = `<svg viewBox="0 0 13 13" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.5" cy="6.5" r="5.5"/><path d="M5 5 a1.5 1.5 0 1 1 1.8 1.7 c-0.4 0.1 -0.6 0.4 -0.6 0.9 v0.4"/><circle cx="6.5" cy="9.6" r="0.45" fill="currentColor"/></svg>`;
    return (
      `<div class="ask-user-block" data-question-id="${this.escHtml(qid)}">` +
      `<div class="ask-user-title"><span class="ask-user-icon">${icon}</span>The model is asking</div>` +
      `<form class="ask-user-form">${blocks}` +
      `<div class="ask-user-actions">` +
      `<button type="button" class="ask-user-submit" data-action="ask-user-submit">Submit answer</button>` +
      `</div></form></div>`
    );
  },

  interruptBlockHtml(b: Block): string {
    const kind = String(b.kind || 'note');
    const title =
      kind === 'disconnect' ? 'Connection lost'
      : kind === 'reconnect' ? 'Stream resumed'
      : kind === 'server-restart' ? 'Bridge restarted'
      : kind === 'stopped' ? 'Stopped'
      : kind === 'aborted' ? 'Aborted'
      : kind === 'timeout' ? 'Stream timed out'
      : 'Sidenote';
    const parts: string[] = [];
    if (b.ts) parts.push(this.fmtMsgTime(b.ts));
    if (kind === 'disconnect') {
      if (typeof b.bufferedChunks === 'number' && typeof b.chunkCap === 'number') {
        parts.push(`buffer ${b.bufferedChunks}/${b.chunkCap} chunks`);
      }
      if (b.approxTailMs) parts.push(`tail ~${this.fmtShortDuration(b.approxTailMs)}`);
      if (b.postFinishGraceMs) parts.push(`after finish: ${this.fmtShortDuration(b.postFinishGraceMs)} replay grace`);
    } else if (kind === 'reconnect') {
      if (typeof b.replayedCount === 'number' && b.replayedCount > 0) parts.push(`replayed ${b.replayedCount} chunks`);
      if (b.gapMs) parts.push(`gap ${this.fmtShortDuration(b.gapMs)}`);
    } else if (kind === 'server-restart') {
      parts.push('old live stream could not resume');
    } else if (kind === 'timeout') {
      if (typeof b.elapsedMs === 'number' && b.elapsedMs > 0) {
        parts.push(`ran ${this.fmtShortDuration(b.elapsedMs)}`);
      }
      if (b.model) parts.push(String(b.model));
      if (b.partialLen) parts.push(`~${b.partialLen} chars so far`);
    }
    return (
      `<div class="msg-interrupt-inline" data-kind="${this.escHtml(kind)}">` +
      `<div class="msg-interrupt-title">${this.escHtml(title)}</div>` +
      `<div class="msg-interrupt-text">${this.escHtml(String(b.text || b.content || ''))}</div>` +
      (parts.length ? `<div class="msg-interrupt-meta">${this.escHtml(parts.join(' · '))}</div>` : '') +
      `</div>`
    );
  },

  buildBlocksHtml(blocks: Block[], liveText: string | undefined, md: MarkdownIt | null): string {
    const streaming = liveText !== undefined;
    let html = '';
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'thinking') {
        const closedBy = (nb: Block) => nb.type === 'text' || nb.type === 'thinking';
        const hasFollowing = streaming && (blocks.slice(i + 1).some(closedBy) || !!liveText);
        const open = (streaming && !hasFollowing) ? ' open' : '';
        const isActive = !hasFollowing && streaming;
        const label = isActive ? 'Reasoning…' : 'Reasoning';
        const liveClass = isActive ? ' reasoning-live' : '';
        html += `<details class="msg-reasoning"${open}><summary>${label}</summary><pre class="reasoning-pre${liveClass}">${this.escHtml(b.content)}</pre></details>`;
      } else if (b.type === 'text') {
        html += this.renderMd(b.content, md);
      } else if (b.type === 'btw') {
        // Inline #btw — user injection at this chronological position. Same
        // visual treatment as a note, but lives INSIDE the assistant's blocks
        // so its position in the tool-call sequence is preserved on reload.
        // livePath = 'direct' when the bridge confirmed live delivery (direct
        // API tool-loop drain, OR claude-binary stdin sink wrote into the
        // running spawn). 'harness' = queued; model sees it next turn only.
        const t = String(b.text ?? b.content ?? '');
        let hint = '';
        if (b.livePath === 'harness') {
          hint = `<span class="msg-btw-hint" title="No active live spawn (codex CLI, or claude-binary turn already ended) — model sees this only on the next turn.">↪ next turn</span>`;
        } else if (b.livePath === 'direct') {
          hint = `<span class="msg-btw-hint msg-btw-hint--live" title="Live — spliced into the running model session. Direct API drains at the next tool boundary; claude-binary stdin sink applies at the next turn boundary inside the same spawn.">⚡ live</span>`;
        }
        html += `<div class="msg-btw-inline">${this.escHtml(t)}${hint}</div>`;
      } else if (b.type === 'interrupt') {
        html += this.interruptBlockHtml(b);
      } else if (b.type === 'ask-user-question') {
        html += this.askUserQuestionHtml(b);
      } else {
        html += this.toolPillHtml(b.type, b.name ?? '', b.detail);
        if (b.type === 'tool-result' && (b.name === 'generate_image' || b.name?.endsWith('__generate_image'))) {
          try {
            const res = typeof b.detail === 'string' ? JSON.parse(b.detail) : b.detail;
            ((res as Record<string, unknown[]>).images || []).forEach((img) => {
              const imgObj = img as Record<string, string>;
              if (imgObj.filename) {
                const url = `/exchange/${imgObj.filename}`;
                html += `<div class="generated-image-inline"><a href="${this.escHtml(url)}" target="_blank" rel="noopener noreferrer"><img src="${this.escHtml(url)}" alt="generated image" loading="lazy" style="max-width:100%;border-radius:8px;margin-top:6px;cursor:pointer" /></a></div>`;
              }
            });
          } catch (_) {}
        }
        if (b.type === 'tool-result' && (b.name === 'generate_audio' || b.name?.endsWith('__generate_audio'))) {
          try {
            const res = typeof b.detail === 'string' ? JSON.parse(b.detail) : b.detail;
            ((res as Record<string, unknown[]>).audio || []).forEach((au) => {
              const auObj = au as Record<string, string>;
              if (auObj.filename) {
                const url = `/exchange/${auObj.filename}`;
                html += `<div class="generated-audio-inline"><audio controls preload="none" src="${this.escHtml(url)}" style="margin-top:6px;width:100%"></audio></div>`;
              }
            });
          } catch (_) {}
        }
        if (b.type === 'tool-result' && (b.name === 'generate_video' || b.name?.endsWith('__generate_video'))) {
          try {
            const res = typeof b.detail === 'string' ? JSON.parse(b.detail) : b.detail;
            ((res as Record<string, unknown[]>).videos || []).forEach((vid) => {
              const vidObj = vid as Record<string, string>;
              if (vidObj.filename) {
                const url = `/exchange/${vidObj.filename}`;
                html += `<div class="generated-video-inline"><video controls preload="metadata" src="${this.escHtml(url)}" style="max-width:100%;border-radius:8px;margin-top:6px"></video></div>`;
              }
            });
          } catch (_) {}
        }
      }
    }
    return html;
  },

  addCodeCopyButtons(root: HTMLElement): void {
    root.querySelectorAll<HTMLPreElement>('pre').forEach((pre) => {
      if (pre.classList.contains('reasoning-pre')) return;
      if (!pre.querySelector(':scope > code')) return;
      if (pre.querySelector(':scope > .code-copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.dataset['action'] = 'copy-code';
      btn.title = 'Copy';
      btn.innerHTML = this.ICON_COPY;
      pre.appendChild(btn);
    });
  }
};

export default chatUtils;
