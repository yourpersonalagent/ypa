import chatUtils from './chat-utils.js';
import type { Block, ChatMessage, MsgMeta, MarkdownIt } from './chat-utils.js';
import { shikiHighlightElement } from '../vendor.js';
import { getAppState } from '../stores/index.js';
import { resolveAvatarColor } from '../color-themes-config.js';
import { extractMentionedFilesFromBlocks, getValidatedFiles } from '../util/file-mentions.js';

export const chatRendering = {
  msgMetaHtml(msg: ChatMessage): string {
    if (msg.typing) return '';
    const isNote = msg.role === 'note';
    const counts = !isNote && msg.blocks ? chatUtils.computeBlockCounts(msg.blocks) : null;
    const stats = isNote ? '' : chatUtils.buildStatsHtml(msg.meta, msg.ts, msg.role, counts);
    return (
      `<div class="msg-meta"><div class="msg-meta-stats">${stats}</div>` +
      `<div class="msg-meta-actions">` +
      `<button class="msg-act-btn" data-action="copy" title="Copy">${chatUtils.ICON_COPY}</button>` +
      `<button class="msg-act-btn" data-action="speak" title="Read aloud">${chatUtils.ICON_SPEAK}</button>` +
      `<button class="msg-act-btn" data-action="edit" title="${msg.role === 'user' ? 'Edit &amp; resend' : 'Edit text'}">${chatUtils.ICON_EDIT}</button>` +
      `<button class="msg-act-btn" data-action="branch" title="Branch chat here">${chatUtils.ICON_BRANCH}</button>` +
      `<button class="msg-act-btn" data-action="delete" title="Delete">${chatUtils.ICON_DELETE}</button>` +
      `</div></div>`
    );
  },

  createMsgEl(msg: ChatMessage, md: MarkdownIt | null): HTMLElement {
    const el = document.createElement('div');
    el.className = 'msg ' + (msg.role || 'system');
    if (msg._mid) el.dataset.mid = String(msg._mid);

    let bubbleContent: string;
    if (msg.typing) {
      bubbleContent = '<span class="typing"><span></span><span></span><span></span></span>';
    } else if (msg.blocks) {
      bubbleContent = chatUtils.buildBlocksHtml(msg.blocks, undefined, md);
    } else {
      let html = '';
      if (msg.reasoning) {
        html += `<details class="msg-reasoning"><summary>Reasoning</summary><pre class="reasoning-pre">${chatUtils.escHtml(msg.reasoning)}</pre></details>`;
      }
      html += chatUtils.renderMd(msg.text, md);
      bubbleContent = html;
    }

    if (msg.role === 'agent' && !msg.typing && msg.blocks?.length) {
      const cwd = getAppState().sessionWorkingDir || '';
      const candidates = extractMentionedFilesFromBlocks(msg.blocks);
      const validated = getValidatedFiles(candidates, cwd);
      bubbleContent += chatUtils.buildMentionedFilesHtml(validated, cwd);
    }

    const empAuthor = msg.role === 'agent' && msg.meta?.author ? msg.meta.author : null;
    const appState = getAppState();
    const userName = appState.userName;
    const userColor = appState.userSymbolColor ? resolveAvatarColor(appState.userSymbolColor) : '';
    const empColor = empAuthor?.symbolColor ? resolveAvatarColor(empAuthor.symbolColor) : '';
    const roleLabel = msg.role !== 'system'
      ? empAuthor
        ? `<span class="msg-role-label is-emp"${empColor ? ` style="background:${chatUtils.escHtml(empColor)}"` : ''} title="${chatUtils.escHtml((empAuthor.name || empAuthor.id || '?') + (empAuthor.role ? ' · ' + empAuthor.role : ''))}">${chatUtils.escHtml((empAuthor.name || empAuthor.id || '?')[0].toUpperCase())}</span>`
        : msg.role === 'user'
          ? `<span class="msg-role-label"${userColor ? ` style="color:${chatUtils.escHtml(userColor)}"` : ''}${userName ? ` title="${chatUtils.escHtml(userName)}"` : ''}>${chatUtils.escHtml(((userName || 'U')[0]).toUpperCase())}</span>`
          : `<span class="msg-role-label">${chatUtils.avatarFor(msg.role)}</span>`
      : '';

    const showMeta = !msg.typing && msg.role !== 'system';
    el.innerHTML = `<div class="msg-bubble">${roleLabel}${bubbleContent}</div>${showMeta ? this.msgMetaHtml(msg) : ''}`;
    return el;
  },

  appendEl(msg: ChatMessage, scroll: HTMLElement, md: MarkdownIt | null): HTMLElement {
    const el = this.createMsgEl(msg, md);
    scroll.appendChild(el);
    return el;
  },

  updateMessage(el: HTMLElement, text: string, role: string | undefined, md: MarkdownIt | null): void {
    if (role) el.className = 'msg ' + role;
    const bubble = el.querySelector('.msg-bubble') as HTMLElement;
    const existingLabel = bubble.querySelector('.msg-role-label');
    const labelHtml = existingLabel ? existingLabel.outerHTML : '';
    bubble.innerHTML = labelHtml + chatUtils.renderMd(text, md);
  },

  renderBlocks(el: HTMLElement, blocks: Block[], liveText: string | undefined, md: MarkdownIt | null): void {
    const bubble = el.querySelector('.msg-bubble') as HTMLElement;
    const existingLabel = bubble.querySelector('.msg-role-label');
    const labelHtml = existingLabel ? existingLabel.outerHTML : '';
    let html = chatUtils.buildBlocksHtml(blocks, liveText, md);
    if (liveText) html += chatUtils.renderMd(liveText, md);
    const cwd = getAppState().sessionWorkingDir || '';
    const candidates = extractMentionedFilesFromBlocks(blocks);
    if (liveText) {
      // Pull tokens from the in-flight text too so chips appear as the model
      // types out a path. Wraps liveText in a synthetic block so we reuse the
      // same extractor.
      for (const tok of extractMentionedFilesFromBlocks([{ type: 'text', content: liveText }])) {
        if (!candidates.includes(tok)) candidates.push(tok);
      }
    }
    const validated = getValidatedFiles(candidates, cwd);
    html += chatUtils.buildMentionedFilesHtml(validated, cwd);
    const _persistent = [...bubble.querySelectorAll<HTMLElement>('[data-persistent]')]
      .filter((n) => !n.classList.contains('msg-mentioned-files') && !n.classList.contains('msg-external-files'));
    bubble.innerHTML = labelHtml + html;
    for (const p of _persistent) bubble.appendChild(p);

    // Fold in the live "busy" meta bar when the placeholder carries `_live`
    // counter data (stamped by the stream handler). It's a sibling of the
    // bubble, so it rides el.innerHTML into the store and React paints it
    // from the turn's START — see chat.ts::renderBlocks.
    this.syncLiveMetaBar(el);

    setTimeout(() => {
      bubble.querySelectorAll('pre code:not(.shiki-highlighted)').forEach((b) => shikiHighlightElement(b as HTMLElement));
      chatUtils.addCodeCopyButtons(bubble);
    }, 0);

    bubble.querySelectorAll('.reasoning-live').forEach((p) => {
      (p as HTMLElement).scrollTop = (p as HTMLElement).scrollHeight;
    });
    // Chip strips are height-capped; pin to bottom so the latest validated
    // chip stays visible as more arrive.
    bubble.querySelectorAll('.msg-mentioned-files, .msg-external-files').forEach((p) => {
      (p as HTMLElement).scrollTop = (p as HTMLElement).scrollHeight;
    });
  },

  // Reconciles the transient `.msg-meta.is-live` busy bar against the
  // placeholder's `_live` dataset. Adds/updates it as a sibling of the
  // bubble while the turn is in flight; removes it once the stream handler
  // clears `data-live` on finalize (the canonical `.msg-meta` then takes
  // over via the non-typing render path).
  syncLiveMetaBar(el: HTMLElement): void {
    const live = el.dataset['live'] === '1';
    let bar = el.querySelector(':scope > .msg-meta.is-live') as HTMLElement | null;
    if (!live) {
      if (bar) bar.remove();
      return;
    }
    const stats = chatUtils.buildLiveStatsHtml({
      model: el.dataset['liveModel'] || undefined,
      inputTokens: +(el.dataset['liveIn'] || '0'),
      outputTokens: +(el.dataset['liveOut'] || '0'),
      toolCallCount: +(el.dataset['liveTools'] || '0'),
      apiCallCount: +(el.dataset['liveApi'] || '0'),
      startMs: +(el.dataset['liveStart'] || '0') || Date.now(),
    });
    const inner = `<div class="msg-meta-stats">${stats}</div>`;
    if (bar) {
      bar.innerHTML = inner;
    } else {
      bar = document.createElement('div');
      bar.className = 'msg-meta is-live';
      bar.innerHTML = inner;
      el.appendChild(bar);
    }
  },

  setMsgMeta(el: HTMLElement, msg: ChatMessage, meta: MsgMeta): void {
    msg.meta = meta;
    delete msg.typing;
    delete msg.text;
    let metaEl = el.querySelector('.msg-meta');
    if (metaEl) {
      const statsEl = metaEl.querySelector('.msg-meta-stats');
      if (statsEl) statsEl.innerHTML = chatUtils.buildStatsHtml(meta, msg.ts, msg.role, msg.blocks ? chatUtils.computeBlockCounts(msg.blocks) : null);
    } else {
      el.insertAdjacentHTML('beforeend', this.msgMetaHtml(msg));
    }
  }
};

export default chatRendering;
