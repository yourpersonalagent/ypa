import chatUtils from './chat-utils.js';
import chatRendering from './chat-rendering.js';
import type { Block, ChatMessage } from './chat-utils.js';
import { useChatStore } from '../stores/chatStore.js';
import { getAppState } from '../stores/appStore.js';
import { confirm } from '../stores/confirmStore.js';
import { bus, save } from '../state.js';
import { api } from '../api.js';
import { toast } from '../toast.js';
import { chat } from '../chat.js';
import { session } from '../session.js';
import { pickTtsProvider } from '../modules/voice/tts-picker.js';
import type { TTSProvider } from '../modules/voice/providers.js';

function apiBase(): string {
  return (api.config.baseUrl as string) || '';
}

// Tracks the currently-speaking TTS provider so a second click on the
// "read aloud" button can cancel the same instance that started playback
// (browser SpeechSynthesis is a singleton, but OpenAITTS holds queue state
// per-instance — `.cancel()` on the original instance is what stops it).
let _activeSpeakProvider: TTSProvider | null = null;

// Push a value into the React-owned chat input. The vanilla `ta` reference
// in chat.ts points at the hidden legacy textarea (chat-ta-legacy), so
// writing `ta.value` never reaches the visible React-controlled <textarea>.
// ChatInput.tsx subscribes to this event and calls setValue.
function setChatInputValue(text: string): void {
  bus.emit('chat:set-input', text);
}

export const chatActions = {
  // Copy plain text to the clipboard. Falls back to a hidden textarea +
  // execCommand('copy') when navigator.clipboard is unavailable — that's
  // the case in dev mode over plain HTTP (clipboard API requires a secure
  // context, except on localhost).
  async copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return; } catch (_) {}
    }
    const tmp = document.createElement('textarea');
    tmp.value = text;
    tmp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    document.body.removeChild(tmp);
  },

  async copyMsg(mid: number): Promise<void> {
    const msg = (useChatStore.getState().messages as ChatMessage[]).find((m) => m._mid === mid);
    if (!msg) return;
    const text = chat.getMsgText ? chat.getMsgText(msg) : (msg.text || '');
    await this.copyText(text);
  },

  async editMsg(
    mid: number,
    _ta: HTMLTextAreaElement,
    _autoGrow: () => void,
    scroll: HTMLElement,
    renderBlocks: (el: HTMLElement, blocks: Block[], liveText?: string) => void,
  ): Promise<void> {
    const messages = useChatStore.getState().messages as ChatMessage[];
    const idx = messages.findIndex((m) => m._mid === mid);
    if (idx < 0) return;
    const msg = messages[idx];

    if (msg.role === 'user') {
      const text = chat.getMsgText ? chat.getMsgText(msg) : msg.text || '';
      const sid = String(getAppState().currentSession || 'default');
      const cwd = getAppState().sessionWorkingDir || null;
      let res: { success: boolean; sessionId?: string; error?: string };
      try {
        const r = await fetch(apiBase() + `/v1/sessions/${encodeURIComponent(sid)}/branch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upToIndex: idx - 1, workingDir: cwd }),
        });
        res = await r.json();
      } catch (e) {
        res = { success: false, error: (e as Error).message };
      }
      if (res.success && res.sessionId) {
        await session.switchTo(res.sessionId);
        await chat.refreshSessionList();
      } else {
        toast.show('Branch failed: ' + (res.error || 'unknown error'), 'error');
      }
      setChatInputValue(text);
      return;
    }

    const el = scroll.querySelector(`.msg[data-mid="${mid}"]`) as HTMLElement | null;
    if (!el) return;
    const bubble = el.querySelector('.msg-bubble') as HTMLElement;
    const label = bubble.querySelector('.msg-role-label');
    const labelHtml = label ? label.outerHTML : '';

    // Edit the raw markdown of each text block in place. Every text block gets
    // its own <textarea> (keyed by its index in msg.blocks); non-text blocks
    // (tool-call/result, reasoning, #btw, …) render read-only between them so
    // the originally recorded text↔tool order is shown for context but can
    // never be rewritten or merged. Legacy text-only messages synthesize a
    // single text block so they take the same path.
    const blocks: Block[] = (msg.blocks && msg.blocks.length)
      ? msg.blocks
      : [{ type: 'text', content: msg.text || '' }];

    const parts = blocks.map((b, i) =>
      b.type === 'text'
        ? `<textarea class="msg-edit-ta" data-block-index="${i}">${chatUtils.escHtml(b.content || '')}</textarea>`
        : `<div class="msg-edit-ro" data-block-index="${i}">${chatUtils.buildBlocksHtml([b], undefined, null)}</div>`
    ).join('');

    bubble.innerHTML = labelHtml
      + `<div class="msg-edit-blocks">${parts}</div>`
      + `<div class="msg-edit-bar"><button class="msg-edit-save chat-bar-btn">Save</button><button class="msg-edit-cancel chat-bar-btn">Cancel</button></div>`;

    const tas = Array.from(bubble.querySelectorAll('.msg-edit-ta')) as HTMLTextAreaElement[];
    const autosize = (t: HTMLTextAreaElement): void => {
      t.style.height = 'auto';
      t.style.height = Math.max(t.scrollHeight, 40) + 'px';
    };
    tas.forEach((t) => { autosize(t); t.addEventListener('input', () => autosize(t)); });
    if (tas[0]) { tas[0].focus(); tas[0].setSelectionRange(tas[0].value.length, tas[0].value.length); }

    (bubble.querySelector('.msg-edit-cancel') as HTMLElement).addEventListener('click', () => {
      renderBlocks(el, msg.blocks || (msg.text ? [{ type: 'text', content: msg.text }] : []));
      const metaEl = el.querySelector('.msg-meta');
      if (!metaEl) el.insertAdjacentHTML('beforeend', chatRendering.msgMetaHtml(msg));
    });

    (bubble.querySelector('.msg-edit-save') as HTMLElement).addEventListener('click', async () => {
      // Rebuild blocks in their original order: each text block takes its own
      // textarea value (dropped if blanked); every non-text block is carried
      // over verbatim so the recorded sequence is preserved.
      const newBlocks: Block[] = [];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type !== 'text') { newBlocks.push(b); continue; }
        const ta = bubble.querySelector(`.msg-edit-ta[data-block-index="${i}"]`) as HTMLTextAreaElement | null;
        const val = ta ? ta.value : (b.content || '');
        if (!val.trim()) continue;
        newBlocks.push({ ...b, content: val });
      }
      msg.blocks = newBlocks;
      renderBlocks(el, msg.blocks);
      const metaEl = el.querySelector('.msg-meta');
      if (!metaEl) el.insertAdjacentHTML('beforeend', chatRendering.msgMetaHtml(msg));

      // Push the mutated message reference back so React re-renders.
      useChatStore.getState().setMessages([...useChatStore.getState().messages]);

      const sid = String(getAppState().currentSession || 'default');
      await fetch(`/v1/sessions/${encodeURIComponent(sid)}/messages/${idx}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: msg.blocks }),
      }).catch(() => {});
      save.chat();
    });
  },

  async branchMsg(mid: number): Promise<void> {
    const messages = useChatStore.getState().messages as ChatMessage[];
    const idx = messages.findIndex((m) => m._mid === mid);
    if (idx < 0) return;
    const sid = String(getAppState().currentSession || 'default');
    const cwd = getAppState().sessionWorkingDir || null;
    let res: { success: boolean; sessionId?: string; error?: string };
    try {
      const r = await fetch(apiBase() + `/v1/sessions/${encodeURIComponent(sid)}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upToIndex: idx, workingDir: cwd }),
      });
      res = await r.json();
    } catch (e) {
      res = { success: false, error: (e as Error).message };
    }
    if (res.success && res.sessionId) {
      await session.switchTo(res.sessionId);
      await chat.refreshSessionList();
    } else {
      toast.show('Branch failed: ' + (res.error || 'unknown error'), 'error');
    }
  },

  speakMsg(mid: number, scroll: HTMLElement): void {
    const btn = scroll.querySelector(`.msg[data-mid="${mid}"] .msg-act-btn[data-action="speak"]`) as HTMLElement | null;

    // Toggle: a second click on the active speaker stops playback.
    if (btn?.classList.contains('is-speaking')) {
      _activeSpeakProvider?.cancel();
      _activeSpeakProvider = null;
      btn.classList.remove('is-speaking');
      return;
    }

    const provider = pickTtsProvider();
    if (!provider.available()) { toast.show('Speech synthesis not supported in this browser', 'error'); return; }

    const msg = (useChatStore.getState().messages as ChatMessage[]).find((m) => m._mid === mid);
    if (!msg) return;
    const raw = chat.getMsgText ? chat.getMsgText(msg) : (msg.text || '');
    if (!raw.trim()) return;

    // Strip markdown to plain readable text by rendering then reading textContent.
    const tmp = document.createElement('div');
    tmp.innerHTML = chatUtils.renderMd(raw, null);
    const text = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return;

    // Clear any previous speaking state across all message buttons.
    scroll.querySelectorAll('.msg-act-btn.is-speaking').forEach((b) => b.classList.remove('is-speaking'));
    _activeSpeakProvider?.cancel();

    _activeSpeakProvider = provider;
    btn?.classList.add('is-speaking');
    const clear = (): void => {
      btn?.classList.remove('is-speaking');
      if (_activeSpeakProvider === provider) _activeSpeakProvider = null;
    };
    provider.speak(text, { onEnd: clear, onError: clear });
  },

  async deleteMsg(mid: number, _scroll: HTMLElement): Promise<void> {
    const messages = useChatStore.getState().messages as ChatMessage[];
    const idx = messages.findIndex((m) => m._mid === mid);
    if (idx < 0) return;

    const msg = messages[idx];
    const preview = chat.getMsgText ? chat.getMsgText(msg) : msg.text || '';
    const truncated = preview.length > 60 ? preview.slice(0, 60) + '…' : preview;

    const ok = await confirm({
      scope: 'delete-message',
      title: 'Delete message',
      message: `Delete this message?\n\n"${truncated}"`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
      trustMs: 5 * 60_000,
    });
    if (!ok) return;

    const sid = String(getAppState().currentSession || 'default');
    await fetch(`/v1/sessions/${encodeURIComponent(sid)}/messages`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: idx }),
    }).catch(() => {});
    // The store update triggers React to remove the node via the MessageList
    // portal. A previous imperative `scroll.querySelector(...).remove()` here
    // ripped the node out from under React's reconciler and wiped the entire
    // portal — the rest of the messages would only reappear on reload.
    useChatStore.getState().removeMessage(mid);
    chat.scheduleMinimap();
    save.chat();
  }
};

export default chatActions;
