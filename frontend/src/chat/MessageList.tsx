// MessageList — React renderer for chatStore.messages into #chat-scroll.
// Uses dangerouslySetInnerHTML backed by the existing chatUtils HTML generators
// so CSS classes and markdown rendering stay identical to vanilla output.
//
// Streaming: while a message has typing: true, its rendered HTML lives in
// chatStore.streamingSegments[mid]. chat.ts writes to a detached placeholder
// element and syncs its innerHTML to the store on every chunk. When the segment
// is finalized, chat-streaming pushes a fresh messages array and clears
// the streaming segment so React re-renders from msg.blocks.
//
// Activation: sets scroll.dataset.react = '1', which makes:
//   - chat.ts::renderAll() a no-op
//   - chat.ts::appendEl() return a detached element instead of appending to scroll

import { useEffect, useLayoutEffect, useRef, useState, memo } from 'react';
import { createPortal } from 'react-dom';
import { useChatStore, useSessionStore, useEmployeesStore, useAppStore } from '../stores/index.js';
import { getChatActions } from '../stores/chatStore.js';
import { consumeScrollIntent, SCROLL_INTENT_EVENT } from '../util/scrollIntent.js';
import type { ChatMessage, Block, MarkdownIt } from './chat-utils.js';
import { chatUtils } from './chat-utils.js';
import { chatRendering } from './chat-rendering.js';
import { ensureLiveClock } from './chat-streaming.js';
import { useSessionActivityStore } from '../stores/sessionActivityStore.js';
import { md as vendorMd, shikiHighlightElement } from '../vendor.js';
import { resolveAvatarColor } from '../color-themes-config.js';
import { Settings, CornerDownRight } from './icons.js';
import { extractMentionedFilesFromBlocks, getValidatedFiles, subscribeFilesChecked } from '../util/file-mentions.js';
import { MultichatRow } from './MultichatRow.js';
import { StatusIndicator } from './StatusIndicator.js';

function getMd(): MarkdownIt {
  return vendorMd as unknown as MarkdownIt;
}

// Render-virtualization for long sessions. `content-visibility: auto` lets the
// browser skip layout + paint for messages outside the viewport while leaving
// every node in the DOM — so the minimap, message-edit, pet-jump and
// scroll-to-note paths (all of which resolve a message via its [data-mid])
// keep working, unlike true DOM windowing which would drop those nodes. The
// `auto` intrinsic-size makes the browser remember each row's real height after
// its first paint, so the scrollbar barely shifts. It's a no-op for on-screen
// content, so short sessions are unaffected; unsupported browsers (no
// content-visibility) simply render everything as before.
const CV_STYLE = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 120px',
} as unknown as React.CSSProperties;

// ── Single message ────────────────────────────────────────────────────────────

interface MessageProps {
  msg: ChatMessage;
}

const Message = memo(function Message({ msg }: MessageProps) {
  // multichat-turn markers are rendered by MessageListInner via the dedicated
  // <MultichatRow> path. If one slips through (e.g. the dispatcher missed a
  // role), drop it instead of rendering a blank bubble.
  if (msg.role === 'multichat-turn') return null;
  const md = getMd();
  const divRef = useRef<HTMLDivElement>(null);

  // After every render: apply Shiki syntax highlighting to any new code blocks.
  // Mirrors the vanilla chat-rendering.ts::renderBlocks() setTimeout approach.
  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    // During streaming, most renders have no code blocks — skip the setTimeout
    // entirely rather than scheduling 20+ no-op tasks per second.
    if (msg.typing && !el.querySelector('pre code:not(.shiki-highlighted)')) return;
    const id = setTimeout(() => {
      el.querySelectorAll<HTMLElement>('pre code:not(.shiki-highlighted)').forEach(shikiHighlightElement);
      chatUtils.addCodeCopyButtons(el);
    }, 0);
    return () => clearTimeout(id);
  });

  // Auto-scroll the active reasoning <pre> to its bottom on every chunk.
  // The vanilla chat-rendering path also does this, but it runs on the detached
  // placeholder element — dangerouslySetInnerHTML rebuilds the DOM here so that
  // scrollTop is lost. Mirroring it post-commit makes the live block follow the
  // latest tokens. useLayoutEffect avoids the user seeing a scrollTop=0 flash.
  useLayoutEffect(() => {
    const el = divRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>('.reasoning-live').forEach((p) => {
      p.scrollTop = p.scrollHeight;
    });
    // Chip strips are height-capped and grow as the file-existence cache
    // resolves; keep the latest chip in view.
    el.querySelectorAll<HTMLElement>('.msg-mentioned-files, .msg-external-files').forEach((p) => {
      p.scrollTop = p.scrollHeight;
    });
  });

  // For typing messages, read live streaming HTML from chatStore.
  // The entry is populated by chat.ts::renderBlocks() on every streaming chunk.
  const streamingHtml = useChatStore((s) =>
    msg.typing ? (s.streamingSegments[String(msg._mid)] ?? null) : null
  );
  // Busy-bar source for a switched-into / reloaded turn. The originating tab
  // paints its bar from the per-turn `_live` SSE frames — chat-rendering's
  // syncLiveMetaBar stamps them into streamingHtml. But the backend pushes
  // `_live` frames STRAIGHT to the originating POST's pump; they bypass the
  // replayable session buffer (go-core route.go), so a REATTACHED stream
  // (session switch or page reload) receives the streamed content but never a
  // `_live` frame — its reconstructed streamingHtml has content yet no bar.
  // sessionActivityStore mirrors the always-on /v1/activity/stream feed, fed
  // from the same 450ms registry tick regardless of who is attached, so it
  // carries this session's turnStartMs + counters for the whole turn. Read it
  // whenever this message is typing (NOT only when streamingHtml is null) so
  // the bar can still be applied after the reconnect replay fills
  // streamingHtml with bar-less content.
  // Key the bar off the session that owns the loaded messages (displayedSid),
  // NOT the global currentSession. currentSession flips early during switchTo
  // (setCurrentId) while messages load later (after awaited fetches); reading
  // it here painted the on-screen session's bar with the switched-INTO
  // session's live counters during that window — the reported "values jump
  // between streams / disappear / wrong after switching" across concurrent
  // busy sessions. displayedSid is snapshotted in setMessages so it always
  // matches what's rendered. (The feed itself is correct and per-session:
  // go-core keys the registry by sessionId and multichat slots use distinct
  // ids — so a correctly-keyed lookup never crosses streams.)
  const displayedSid = useChatStore((s) => s.displayedSid);
  const liveActivity = useSessionActivityStore((s) =>
    // Important perf guard: once streamingHtml exists, do NOT subscribe this
    // whole message bubble to the activity object. Activity counters change
    // every ~1-2s; if React re-renders here it reassigns
    // dangerouslySetInnerHTML for the entire (often huge) streaming transcript
    // just to update the tiny live stats bar. Reattached/active streams update
    // that bar imperatively via syncLiveMetaBar on `_live` frames. We only use
    // the activity-sourced bar before streamingHtml has arrived, so a
    // switch-into/reload does not show a blank bubble while replay starts.
    msg.typing && streamingHtml === null ? (s.sessions[displayedSid] ?? null) : null
  );
  // Start the shared elapsed clock so the activity-sourced bar's `.live-elapsed`
  // ticks (applyLiveMeta normally does this, but no live frame has fired yet).
  useEffect(() => {
    if (liveActivity) ensureLiveClock();
  }, [liveActivity]);
  // Look up live employee record so badge color/name updates apply to past
  // messages without needing a session reload. Falls back to the snapshot
  // baked into msg.meta.author at send time.
  const authorId = msg.role === 'agent' && msg.meta?.author?.id ? String(msg.meta.author.id) : null;
  const liveAuthor = useEmployeesStore((s) => (authorId ? s.byId[authorId] : undefined));
  // Subscribe to user identity so own messages re-render when name/color change.
  const userName = useAppStore((s) => s.userName);
  const userSymbolColor = useAppStore((s) => s.userSymbolColor);
  // Working directory for resolving relative file mentions. Updates trigger
  // re-render via store subscription so chips re-validate after a session swap.
  const sessionCwd = useAppStore((s) => s.sessionWorkingDir) || '';
  // Re-render this message when the file-existence cache picks up new entries
  // for paths we extracted earlier — the chips appear after a ~300ms debounce.
  const [, forceFilesTick] = useState(0);
  useEffect(() => {
    const unsub = subscribeFilesChecked(() => forceFilesTick((n) => n + 1));
    return unsub;
  }, []);

  if (msg.typing) {
    // Busy bar built from the activity feed (see liveActivity above). Markup
    // mirrors chat-rendering.syncLiveMetaBar so the shared elapsed clock
    // (ensureLiveClock, started by the effect above) ticks its `.live-elapsed`.
    // Prefer the live activity feed (real-time growing counters from core's
    // registry / 1s ticker). Fall back to last-known values that were
    // checkpointed into the live msg's meta by Go's persist updates (durability
    // across switches, re-attach, and short bridge restarts while the core
    // harness/turn is still alive). This makes the bar "survive" and show
    // real (core-sourced) numbers that can continue growing.
    const meta: any = (msg as any).meta || {};
    const fallbackStart = (liveActivity && liveActivity.turnStartMs) || meta.turnStartMs || meta._liveStartedAt || Date.now();
    const barVals = liveActivity ? {
      model: liveActivity.model || meta.model,
      inputTokens: liveActivity.inputTokens,
      outputTokens: liveActivity.outputTokens,
      toolCallCount: liveActivity.toolCallCount,
      apiCallCount: liveActivity.apiCallCount,
      startMs: liveActivity.turnStartMs,
    } : {
      model: meta.model,
      inputTokens: meta.inputTokens || 0,
      outputTokens: meta.outputTokens || 0,
      toolCallCount: meta.toolCallCount || 0,
      apiCallCount: meta.apiCallCount || 0,
      startMs: fallbackStart,
    };
    const liveBar = (liveActivity || (barVals.model || barVals.inputTokens || barVals.outputTokens || barVals.toolCallCount))
      ? `<div class="msg-meta is-live"><div class="msg-meta-stats">${chatUtils.buildLiveStatsHtml(barVals)}</div></div>`
      : '';
    if (streamingHtml !== null) {
      // Vanilla streaming content is live. The stream path's own `_live`
      // frames stamp/update the busy bar imperatively. Do NOT append an
      // activity-sourced bar here: activity counter ticks would otherwise
      // replace the entire bubble HTML for every long tool-heavy turn, which
      // is exactly the progressive session-switch slowdown.
      return (
        <div
          ref={divRef}
          className="msg agent"
          data-mid={msg._mid}
          dangerouslySetInnerHTML={{ __html: streamingHtml }}
        />
      );
    }
    // Persisted blocks present (post-reload or post-switch-back, where the
    // on-disk `streaming: true` placeholder already carries the bridge's
    // debounced updateLiveMsg snapshot). Render the persisted partial reply
    // so the bubble isn't a stale blank typing dot, plus the live bar above.
    // As soon as the reattach EventSource's replay pump fires renderBlocks()
    // → setStreamingSegment(), the streamingHtml branch above takes over and
    // the display swaps to the live state in place. We do NOT add typing dots
    // on top — the user's reply is *already* visible, adding dots beneath it
    // implies "more to come" even when the stream has finalised and only the
    // FE-side typing flag hasn't been cleared.
    if ((msg.blocks as Block[] | undefined)?.length) {
      const persistedHtml = chatUtils.buildBlocksHtml(msg.blocks as Block[], '', md);
      return (
        <div
          ref={divRef}
          className="msg agent"
          data-mid={msg._mid}
          dangerouslySetInnerHTML={{
            __html: `<div class="msg-bubble"><span class="msg-role-label">${chatUtils.avatarFor('agent')}</span>${persistedHtml}</div>${liveBar}`,
          }}
        />
      );
    }
    // Streaming hasn't produced a chunk yet — show typing indicator (plus the
    // live bar when we have activity meta, so a turn switched into right at
    // its start still shows the elapsed clock + token counters).
    return (
      <div
        ref={divRef}
        className="msg agent"
        data-mid={msg._mid}
        dangerouslySetInnerHTML={{
          __html: `<div class="msg-bubble"><span class="msg-role-label">${chatUtils.avatarFor('agent')}</span><span class="typing"><span></span><span></span><span></span></span></div>${liveBar}`,
        }}
      />
    );
  }

  const baseAuthor = msg.role === 'agent' && msg.meta?.author ? msg.meta.author : null;
  // Merge live employee data over the snapshot so a renamed / recolored
  // employee is reflected even on already-rendered messages.
  const empAuthor = baseAuthor
    ? (liveAuthor ? { ...baseAuthor, ...liveAuthor } : baseAuthor)
    : null;
  const empColor = empAuthor?.symbolColor ? resolveAvatarColor(empAuthor.symbolColor) : '';
  const userColor = userSymbolColor ? resolveAvatarColor(userSymbolColor) : '';
  const roleLabel = msg.role !== 'system'
    ? empAuthor
      ? `<span class="msg-role-label is-emp"${empColor ? ` style="background:${chatUtils.escHtml(empColor)}"` : ''} title="${chatUtils.escHtml((empAuthor.name || empAuthor.id || '?') + (empAuthor.role ? ' · ' + empAuthor.role : ''))}">${chatUtils.escHtml((empAuthor.name || empAuthor.id || '?')[0].toUpperCase())}</span>`
      : msg.role === 'user'
        ? `<span class="msg-role-label"${userColor ? ` style="color:${chatUtils.escHtml(userColor)}"` : ''}${userName ? ` title="${chatUtils.escHtml(userName)}"` : ''}>${chatUtils.escHtml(((userName || 'U')[0]).toUpperCase())}</span>`
        : `<span class="msg-role-label">${chatUtils.avatarFor(msg.role)}</span>`
    : '';

  let bubbleContent: string;
  if ((msg.blocks as Block[] | undefined)?.length) {
    bubbleContent = chatUtils.buildBlocksHtml(msg.blocks as Block[], undefined, md);
  } else {
    let html = '';
    if (msg.reasoning) {
      html += `<details class="msg-reasoning"><summary>Reasoning</summary><pre class="reasoning-pre">${chatUtils.escHtml(msg.reasoning)}</pre></details>`;
    }
    // Strip embedded image markdown when we render thumbnails explicitly below
    let textForRender = msg.images?.length
      ? (msg.text || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim()
      : (msg.text || '');
    // Collapse the <media-request>…</media-request> XML to a clean badge in
    // place, leaving any surrounding content (skill body, post-block prompt)
    // untouched so #skill-media-gen turns render their full instructions.
    // markdown-it runs with html:false, so we stash the rendered <details>
    // HTML behind a placeholder, let markdown render the surrounding text,
    // then splice the real HTML back in.
    const mediaBlocks: string[] = [];
    if (msg.role === 'user' && textForRender.includes('<media-request>')) {
      textForRender = textForRender.replace(
        /<media-request>([\s\S]*?)<\/media-request>/g,
        (_full, inner: string) => {
          const modeM   = inner.match(/^mode:\s*(\S+)/m);
          const modelM  = inner.match(/^model:\s*(\S+)/m);
          const aspM    = inner.match(/^\s*aspect_ratio:\s*"?([^"\n]+)"?/m);
          const bpmM    = inner.match(/^\s*bpm:\s*(\d+)/m);
          const durM    = inner.match(/^\s*duration_secs:\s*(\d+)/m);
          const styleM  = inner.match(/^\s*style:\s*"?([^"\n]+)"?/m);
          const mode    = modeM?.[1] ?? 'media';
          const model   = modelM?.[1];
          const parts: string[] = [model ? `${mode} · ${model}` : mode];
          if (aspM?.[1])   parts.push(aspM[1]);
          if (bpmM?.[1])   parts.push(`${bpmM[1]} bpm`);
          if (durM?.[1])   parts.push(`${durM[1]}s`);
          if (styleM?.[1]) parts.push(styleM[1].trim());
          const badge   = `[${parts.join(' · ')}]`;
          const fullXml = `<media-request>${inner}</media-request>`;
          const detailsHtml = `<details class="msg-media-request"><summary>${chatUtils.escHtml(badge)}</summary><pre class="media-request-pre">${chatUtils.escHtml(fullXml)}</pre></details>`;
          const idx = mediaBlocks.length;
          mediaBlocks.push(detailsHtml);
          return `\n\nMEDIAREQUESTPLACEHOLDER${idx}\n\n`;
        }
      ).trim();
    }
    let renderedHtml = chatUtils.renderMd(textForRender, md);
    if (mediaBlocks.length) {
      renderedHtml = renderedHtml.replace(
        /<p>MEDIAREQUESTPLACEHOLDER(\d+)<\/p>|MEDIAREQUESTPLACEHOLDER(\d+)/g,
        (_m, a, b) => mediaBlocks[Number(a ?? b)] ?? ''
      );
    }
    html += renderedHtml;
    bubbleContent = html;
  }

  if (msg.images?.length) {
    bubbleContent += `<div class="msg-sent-images">${msg.images.map((img) =>
      `<a href="${chatUtils.escHtml(img.url)}" target="_blank" rel="noopener noreferrer">` +
      `<img src="${chatUtils.escHtml(img.url)}" alt="${chatUtils.escHtml(img.name)}" class="msg-sent-img" loading="lazy" />` +
      `</a>`
    ).join('')}</div>`;
  }

  if (msg.role === 'agent' && (msg.blocks as Block[] | undefined)?.length) {
    const candidates = extractMentionedFilesFromBlocks(msg.blocks as Block[]);
    const validated = getValidatedFiles(candidates, sessionCwd);
    bubbleContent += chatUtils.buildMentionedFilesHtml(validated, sessionCwd);
  }

  const showMeta = msg.role !== 'system';
  const metaHtml = showMeta ? chatRendering.msgMetaHtml(msg) : '';

  const innerHTML = `<div class="msg-bubble">${roleLabel}${bubbleContent}</div>${metaHtml}`;

  return (
    <div
      ref={divRef}
      className={`msg ${msg.role}`}
      data-mid={msg._mid}
      style={CV_STYLE}
      dangerouslySetInnerHTML={{ __html: innerHTML }}
    />
  );
});

// ── Tool strip ────────────────────────────────────────────────────────────────

interface ToolPillProps {
  msg: ChatMessage & { type?: string; name?: string; detail?: string };
}

const ToolPill = memo(function ToolPill({ msg }: ToolPillProps) {
  const type = msg.type || 'tool-call';
  const name = msg.name || 'tool';
  const detail = msg.detail || '';
  const fullStr = typeof detail === 'object' ? JSON.stringify(detail, null, 2) : String(detail);
  const snippet = fullStr.slice(0, 55);

  // Dismiss button — covers the dangling tool-call pill case where a stream
  // aborts before the matching tool-result arrives. The original FINDINGS
  // recommended either auto-cleanup or a × button; auto-cleanup is fragile
  // (matching by name/id is racy across multichat turns), so a per-pill
  // dismiss is the simpler and more user-friendly fix. Click event stops
  // propagation so the existing pill-row expand handler doesn't fire.
  function dismiss(e: React.MouseEvent) {
    e.stopPropagation();
    if (msg._mid != null) getChatActions().removeMessage(msg._mid);
  }

  return (
    <div className={`tool-pill ${type}`} data-mid={msg._mid}>
      <div className="pill-row">
        <span className="pill-icon">
          {type === 'tool-call' ? <Settings size={13} strokeWidth={1.75} /> : <CornerDownRight size={13} strokeWidth={1.75} />}
        </span>
        <span className="pill-name" dangerouslySetInnerHTML={{ __html: chatUtils.escHtml(name) }} />
        <span className="pill-snippet" dangerouslySetInnerHTML={{ __html: chatUtils.escHtml(snippet) }} />
        <button
          type="button"
          className="pill-dismiss"
          title="Dismiss"
          aria-label="Dismiss tool pill"
          onClick={dismiss}
        >×</button>
      </div>
      <div className="pill-full" dangerouslySetInnerHTML={{ __html: chatUtils.escHtml(fullStr) }} />
    </div>
  );
});

// Scroll a specific note message into view by polling the live chatStore for
// the _mid assignment, then querying the DOM. Shared by the [container,
// currentId] effect (cross-session click) and the SCROLL_INTENT_EVENT
// listener (same-session click — currentId never flips so the effect alone
// would miss it). Returns a cancel fn the caller can invoke if the watcher
// needs to be pre-empted.
function _runScrollIntent(
  container: HTMLElement,
  msgIdx: number,
  flashClass: string | null | undefined,
): () => void {
  let cancelled = false;
  const startedAt = performance.now();
  function findTarget(): HTMLElement | null {
    const live = useChatStore.getState().messages as Array<{ _mid?: number }>;
    const m = live[msgIdx];
    if (!m || m._mid == null) return null;
    return container.querySelector<HTMLElement>(`[data-mid="${m._mid}"]`);
  }
  function tryJump() {
    if (cancelled) return;
    const target = findTarget();
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (flashClass) {
        const cls = flashClass;
        target.classList.add(cls);
        setTimeout(() => target.classList.remove(cls), 1600);
      }
      return;
    }
    if (performance.now() - startedAt > 8000) return;
    requestAnimationFrame(tryJump);
  }
  requestAnimationFrame(tryJump);
  return () => { cancelled = true; };
}

// ── Message list inner ────────────────────────────────────────────────────────

function MessageListInner() {
  const messages = useChatStore((s) => s.messages);

  // Group consecutive tool messages into strips
  const items: Array<
    | { type: 'msg'; msg: ChatMessage }
    | { type: 'strip'; tools: ChatMessage[] }
    | { type: 'mc-row'; msg: ChatMessage }
  > = [];
  let currentStrip: ChatMessage[] | null = null;

  for (const msg of messages) {
    if (msg.role === 'tool') {
      if (!currentStrip) { currentStrip = []; items.push({ type: 'strip', tools: currentStrip }); }
      currentStrip.push(msg);
    } else if (msg.role === 'multichat-turn') {
      currentStrip = null;
      items.push({ type: 'mc-row', msg });
    } else {
      if (msg.role !== 'system') currentStrip = null;
      items.push({ type: 'msg', msg });
    }
  }

  // Locate the index of the last multichat-turn marker so MultichatRow
  // knows when to switch from "static text" to "live SSE".
  let lastMcTurnIdx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'mc-row') { lastMcTurnIdx = i; break; }
  }

  return (
    <>
      {items.map((item, i) => {
        if (item.type === 'strip') {
          return (
            <div key={`strip-${i}`} className="tool-strip" style={CV_STYLE}>
              {item.tools.map((t, toolIdx) => (
                <ToolPill
                  key={`tool-${t.ts ?? t._mid ?? 'no-ts'}-${toolIdx}`}
                  msg={t as ChatMessage & { type?: string; name?: string; detail?: string }}
                />
              ))}
            </div>
          );
        }
        if (item.type === 'mc-row') {
          const blocks = (item.msg.blocks as Array<{ type: string; groupId?: string; turnIndex?: number; slots?: Array<{ sessionId: string; label: string; id: string }> }> | undefined) || [];
          const row = blocks.find((b) => b.type === 'multichat-row');
          const groupId = row?.groupId || (item.msg.meta?.groupId as string | undefined) || '';
          const turnIndex = typeof row?.turnIndex === 'number'
            ? row.turnIndex
            : (typeof item.msg.meta?.turnIndex === 'number' ? item.msg.meta.turnIndex as number : 0);
          const slots = (row?.slots || []) as Array<{ sessionId: string; label: string; id: string }>;
          if (!slots.length || !groupId) return null;
          return (
            <MultichatRow
              key={`mc-${item.msg.ts ?? item.msg._mid ?? i}`}
              groupId={groupId}
              turnIndex={turnIndex}
              slots={slots}
              isLatestTurn={i === lastMcTurnIdx}
            />
          );
        }
        return (
          <Message
            key={`msg-${item.msg.ts ?? item.msg._mid ?? 'no-ts'}-${i}`}
            msg={item.msg}
          />
        );
      })}
      <StatusIndicator />
    </>
  );
}

// ── Portal wrapper ────────────────────────────────────────────────────────────

export function MessageList() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const obsRef = useRef<MutationObserver | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const currentId = useSessionStore((s) => s.currentId);

  useEffect(() => {
    function find() {
      const el = document.getElementById('chat-scroll');
      if (el && el !== containerRef.current) {
        el.innerHTML = '';
        el.dataset['react'] = '1'; // disables chat.ts::renderAll() + appendEl() vanilla path
        containerRef.current = el;
        setContainer(el);
      }
    }
    find();
    obsRef.current = new MutationObserver(find);
    obsRef.current.observe(document.body, { childList: true, subtree: true });
    return () => obsRef.current?.disconnect();
  }, []);

  // Auto-scroll on session switch / first mount.
  // Two modes, decided by whether a scrollIntent was queued for this session:
  //   1. Intent set (e.g. NotePanel jumping to a note): scroll the target
  //      message into view as soon as it appears, with optional flash class.
  //   2. No intent: follow the bottom while the user is parked there, but let
  //      them scroll up to read freely and re-engage the follow when they
  //      return to the bottom (see the `stuck` scroll tracker below). Re-sticks
  //      on every scrollHeight change and stops when content has been stable
  //      for 1.2s or 12s elapsed.
  // The watcher is keyed on currentId only (not messages) — depending on
  // messages cancels the watcher every time setMessages fires during the
  // switch (which happens 2-3 times in quick succession) and the heartbeat
  // never completes for long chats.
  useEffect(() => {
    if (!container) return;
    const intent = consumeScrollIntent(currentId);

    if (intent) {
      // Cross-session click: switchTo flipped currentId → this effect re-ran
      // → we found the intent in _pending. Hand off to the shared runner.
      const cancelScroll = _runScrollIntent(container, intent.msgIdx, intent.flashClass);
      return () => { cancelScroll(); };
    }

    // Default: follow the bottom, but honour the user's scroll position.
    //
    // `stuck` is the auto-follow lock. It mirrors the vanilla chat.ts
    // `_scrollLocked` system (chat.ts::_bindScrollListeners) so the
    // React-rendered list and chat.ts::_scrollToBottom() — which still fires on
    // every chunk — agree on when to follow: the user is "stuck" to the bottom
    // while their viewport is within STICK_THRESHOLD px of it. Scrolling UP past
    // that releases the lock (free scroll); scrolling back down re-engages it.
    //
    // The previous implementation used one-shot wheel/touch/mousedown listeners
    // ({ once: true }) plus a `cancelled` flag, with no position check. That
    // broke the free-scroll/re-lock cycle two ways: (1) the gesture listeners
    // fired only ONCE per session, so after the first scroll + any re-arm (e.g.
    // sending a prompt re-armed the follow) later scroll-ups went undetected and
    // the loop fought the user, overriding their scroll AND the vanilla lock;
    // (2) returning to the bottom never re-engaged the follow. Tracking scroll
    // position, exactly like the vanilla path, fixes both.
    const STICK_THRESHOLD = 60;
    let stuck = true;
    let disposed = false;
    let lastProgrammaticScroll = 0;
    let lastScrollTop = container.scrollTop;
    let lastHeight = -1;
    let lastGrowAt = 0;
    let startedAt = performance.now();
    let stabilityMs = 1200;
    let alive = false;
    const stick = () => {
      if (!stuck || !container) return;
      container.scrollTop = container.scrollHeight;
      lastProgrammaticScroll = performance.now();
      lastScrollTop = container.scrollTop;
    };
    const onScroll = () => {
      if (!container) return;
      const fromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const now = performance.now();
      // Ignore the scroll event our own stick() (or chat.ts::_scrollToBottom)
      // produces for a short window so async reflow — markdown, shiki, images,
      // the dangerouslySetInnerHTML rebuild — can't masquerade as a user
      // scroll-up and silently release the lock.
      const isProgrammatic = (now - lastProgrammaticScroll) < 150;
      const wentUp = container.scrollTop < lastScrollTop - 1;
      lastScrollTop = container.scrollTop;
      if (fromBottom < STICK_THRESHOLD) {
        // Back at the bottom → re-engage. Re-arm so an in-flight stream resumes
        // following immediately rather than waiting for the next chunk.
        if (!stuck) { stuck = true; rearm(); }
      } else if (!isProgrammatic && wentUp) {
        // Genuine user scroll-up past the threshold → free scroll.
        stuck = false;
      }
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    // Monitored height = outer scrollHeight + any active reasoning <pre>
    // scrollHeight. The .reasoning-live pre has max-height: 280px with internal
    // overflow, so once reasoning streams past that point the outer scrollHeight
    // stops growing even though new tokens keep arriving — that lets the
    // stability timeout kill the watcher mid-stream, so the auto-scroll never
    // catches the text blocks (or tool calls) that follow.
    function monitoredHeight(): number {
      if (!container) return 0;
      let h = container.scrollHeight;
      container.querySelectorAll<HTMLElement>('.reasoning-live').forEach((p) => {
        h += p.scrollHeight;
      });
      return h;
    }
    function check() {
      if (disposed || !container) { alive = false; return; }
      const h = monitoredHeight();
      const now = performance.now();
      if (h !== lastHeight) {
        lastHeight = h;
        lastGrowAt = now;
        stick();
      }
      if (lastGrowAt > 0 && now - lastGrowAt > stabilityMs) {
        stick();
        alive = false;
        return;
      }
      if (now - startedAt > 12000) {
        stick();
        alive = false;
        return;
      }
      requestAnimationFrame(check);
    }
    function rearm(opts?: { force?: boolean; stabilityMs?: number }) {
      if (disposed || !container) return;
      // force=true preempts an in-flight watcher — needed on stream-finalize
      // so post-React-rerender height changes (msg-meta insertion, shiki
      // highlight, dangerouslySetInnerHTML rebuild) get caught even if the
      // 12s cap had already fired during a long tool-call loop.
      if (alive && !opts?.force) return;
      lastHeight = -1;
      lastGrowAt = 0;
      startedAt = performance.now();
      stabilityMs = opts?.stabilityMs ?? 1200;
      alive = true;
      requestAnimationFrame(check);
    }
    rearm();

    // Re-arm whenever a new message is appended. Without this the watcher
    // dies 1.2s after content settles, and the user's next prompt/note
    // lands silently below the fold until the model starts streaming.
    // A user-gesture role (user / note) also re-engages the lock: submitting
    // input is an explicit "take me to the bottom" intent that overrides a
    // prior scroll-up.
    let lastLen = (useChatStore.getState().messages as ChatMessage[]).length;
    const unsubMessages = useChatStore.subscribe((s) => {
      const msgs = s.messages as ChatMessage[];
      const len = msgs.length;
      if (len > lastLen) {
        const added = msgs.slice(lastLen);
        if (added.some((m) => m.role === 'user' || m.role === 'note')) {
          stuck = true;
        }
        lastLen = len;
        rearm();
      } else {
        lastLen = len;
      }
    });

    // Re-arm on every streaming-segment store write (setStreamingSegment /
    // removeStreamingSegment each replace the whole map, so identity changes
    // on every write). Two cases matter:
    //   • count DECREASES → a segment finalized: the canonical .msg-meta footer
    //     (token count, model, duration) is inserted by a React re-render AFTER
    //     renderBlocks/_scrollToBottom already fired. force=true preempts an
    //     in-flight watcher and a longer stability window outlives the
    //     dangerouslySetInnerHTML shrink-then-grow after long tool-call loops,
    //     so the final scroll lands at the bottom, not on the user prompt.
    //   • same count, new identity → the active turn streamed more content.
    //     This is also the live "busy" bar's lifeline: on a reattached /
    //     reloaded / switched-into turn the bar is appended by React from
    //     sessionActivityStore (see liveBar above) AFTER the replay content's
    //     _scrollToBottom, so the view would otherwise settle ~one bar-height
    //     short of the true bottom. Re-arming here keeps the bar in view.
    let prevSegments = useChatStore.getState().streamingSegments;
    let prevSegCount = Object.keys(prevSegments).length;
    const unsubSegments = useChatStore.subscribe((s) => {
      const segs = s.streamingSegments;
      if (segs === prevSegments) return;
      const count = Object.keys(segs).length;
      if (count < prevSegCount) rearm({ force: true, stabilityMs: 2500 });
      else rearm();
      prevSegments = segs;
      prevSegCount = count;
    });

    // Do not re-arm on activity counter ticks. The live bar is now updated
    // imperatively and does not change scroll height; rearming here started a
    // 60fps scrollHeight/querySelector loop for ~1.2s on every activity frame,
    // which becomes visible jank during long busy sessions.

    // File-existence cache resolves ~80ms after a path is emitted; chips
    // appear (and the chip strip may grow taller) AFTER the stream-finalize
    // watcher has stopped. Without re-arming here a post-finalize chip
    // batch silently pushes the prompt below the fold. stick() still no-ops
    // while the user is scrolled up (stuck=false), so this never yanks a free
    // scroller to the bottom.
    const unsubFilesChecked = subscribeFilesChecked(() => rearm());

    return () => {
      disposed = true;
      unsubMessages();
      unsubSegments();
      unsubFilesChecked();
      container.removeEventListener('scroll', onScroll);
    };
  }, [container, currentId]);

  // Same-session scroll-to-note bridge. The picker calls setScrollIntent +
  // session.switchTo(sid). When the user is already on `sid` the switchTo
  // setCurrentId(sid) is a React-level no-op, so the [container, currentId]
  // effect above does NOT re-fire and the queued intent stays orphaned in
  // _pending. This listener picks the intent up via the window event channel
  // so a note click in the active session still scrolls + flashes.
  useEffect(() => {
    if (!container) return;
    let cancelScroll: (() => void) | null = null;
    function onIntent(e: Event) {
      const ce = e as CustomEvent<{ sessionId: string }>;
      if (!ce.detail || ce.detail.sessionId !== currentId) return;
      // Cross-session intents are handled by the [container, currentId] effect
      // after switchTo flips currentId — only consume when the target is the
      // session we're already showing.
      const intent = consumeScrollIntent(currentId);
      if (!intent || !container) return;
      cancelScroll?.();
      cancelScroll = _runScrollIntent(container, intent.msgIdx, intent.flashClass);
    }
    window.addEventListener(SCROLL_INTENT_EVENT, onIntent as EventListener);
    return () => {
      window.removeEventListener(SCROLL_INTENT_EVENT, onIntent as EventListener);
      cancelScroll?.();
    };
  }, [container, currentId]);

  if (!container) return null;
  // Guard against a stale container — if #chat-scroll was replaced (e.g. a
  // parent remount) the MutationObserver will re-discover the new element and
  // call setContainer. Until then, render nothing into the detached node to
  // prevent React's insertBefore from throwing.
  if (!container.isConnected) {
    containerRef.current = null;
    Promise.resolve().then(() => setContainer(null));
    return null;
  }
  return createPortal(<MessageListInner />, container);
}
