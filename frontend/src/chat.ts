import chatUtils from './chat/chat-utils.js';
import chatRendering from './chat/chat-rendering.js';
import { iconSvg } from './chat/icons.js';
import chatActions from './chat/chat-actions.js';
import chatParticipants from './chat/chat-participants.js';
import multichatGrid from './chat/multichat-grid.js';
import chatStreaming from './chat/chat-streaming.js';
import chatUI from './chat/chat-ui.js';
import { inputHistoryActions } from './stores/inputHistoryStore.js';
import { showDebugModal } from './panels/debug-panel.js';
import type { ChatMessage, Block, MarkdownIt } from './chat/chat-utils.js';
import { getChatActions, useChatStore } from './stores/chatStore.js';
import { useSessionStore } from './stores/sessionStore.js';
import { useGraphStore } from './stores/graphStore.js';
import { getAppState } from './stores/appStore.js';
import { md as _vendorMd } from './vendor.js';
import { session } from './session.js';
import { buildMediaTurn } from './composer/mediaTurn.js';
import { useActiveModelsStore } from './stores/activeModelsStore.js';

export const chat = (() => {
  let root: HTMLElement | null = null;
  let scroll: HTMLElement | null = null;
  let ta: HTMLTextAreaElement | null = null;
  let md: MarkdownIt | null = null;
  let toolStrip: HTMLElement | null = null;
  let _scrollLocked = true;
  let _msgCounter = 0;

  function nextMid(): number { return ++_msgCounter; }
  function syncMessageCounter(): void {
    const messages = useChatStore.getState().messages as ChatMessage[];
    // First pass: bump counter past any existing _mid values.
    for (const m of messages) {
      if (m._mid && m._mid > _msgCounter) _msgCounter = m._mid;
    }
    // Second pass: assign _mid to messages that don't have one. Critical in
    // React mode where renderAll() (which used to do this) is a no-op — without
    // it the [data-mid] attribute on rendered messages stays undefined, so the
    // msg-meta-actions click handler can't look up which message was clicked.
    let assigned = false;
    for (const m of messages) {
      if (!m._mid) { m._mid = nextMid(); assigned = true; }
    }
    if (assigned) {
      // Push a fresh array reference so React re-renders <Message> with the
      // newly-assigned mids — same-object mutation alone wouldn't trigger it.
      useChatStore.setState({ messages: [...messages] });
    }
  }
  function currentSessionId(): string { return String(getAppState().currentSession || 'default'); }

  let _lastProgrammaticScroll = 0;
  let _lastScrollTop = 0;
  function _scrollToBottom(): void {
    if (!scroll || !_scrollLocked) return;
    scroll.scrollTop = scroll.scrollHeight;
    _lastProgrammaticScroll = performance.now();
    _lastScrollTop = scroll.scrollTop;
  }

  function _updateScrollBtn(): void {
    const btn = document.getElementById('chat-scroll-btn');
    if (!btn || !scroll) return;
    // Visibility is a pure function of where the viewport actually is.
    // Decoupled from `_scrollLocked` (which only flips when the user
    // actively scrolls UP) so the button shows whenever content grows
    // and leaves us above the bottom, even without a user gesture.
    const fromBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    btn.style.display = fromBottom < 60 ? 'none' : '';
  }

  let _scrollBtnRafScheduled = false;
  function _scheduleUpdateScrollBtn(): void {
    if (_scrollBtnRafScheduled) return;
    _scrollBtnRafScheduled = true;
    requestAnimationFrame(() => {
      _scrollBtnRafScheduled = false;
      _updateScrollBtn();
    });
  }
  let _scrollBtnMo: MutationObserver | null = null;

  function getMsgText(msg: ChatMessage): string {
    if (msg.blocks) return msg.blocks.filter((b) => b.type === 'text').map((b) => b.content).join('\n').trim();
    return msg.text || '';
  }

  function scheduleMinimap(force = false): void { chatUI.scheduleMinimap(force); }
  function buildMinimap(): void { chatUI.buildMinimap(); }

  function renderAttachmentStrip(): void { chatUI.renderAttachmentStrip(); }
  function addAttachment(att: Record<string, unknown>): void { chatUI.addAttachment(att); }
  function removeAttachment(idx: number): void { chatUI.removeAttachment(idx); }

  // Layouts (full/messenger/zen) each render their own <ChatView>, which
  // ChatInput.tsx then hijacks: the rendered <textarea id="chat-ta"> gets
  // renamed to "chat-ta-legacy" and a React-controlled textarea takes the
  // "chat-ta" id. On layout switch the previous legacy textarea is unmounted
  // and a fresh one is created, but `ta` (set once in init()) still points
  // at the disconnected old node — so send() reads value="" and returns
  // silently. Re-resolve lazily whenever a consumer needs the textarea.
  function refreshTaIfStale(): HTMLTextAreaElement | null {
    if (ta && ta.isConnected) return ta;
    ta = (document.getElementById('chat-ta-legacy')
       || document.getElementById('chat-ta')) as HTMLTextAreaElement | null;
    return ta;
  }
  function autoGrow(): void { const t = refreshTaIfStale(); if (t) chatUI.autoGrow(t); }

  function _checkAtMention(): void { chatParticipants._checkAtMention(); }

  async function refreshSessionList(): Promise<void> {
    await session.fetchList();
    // Button text is now updated reactively by AppEffects.tsx from Zustand store
  }

  async function startNewSession(): Promise<void> {
    chatStreaming.clearAllowedTools();
    session.create();
    // session.create() already clears chatStore messages, which triggers
    // <MessageList /> to re-render to empty. Do NOT wipe scroll.innerHTML
    // here — MessageList owns that DOM.
  }

  async function startNewSessionSameDir(): Promise<void> {
    chatStreaming.clearAllowedTools();
    const cwd = getAppState().sessionWorkingDir || '';
    session.createWithDir(cwd);
    // Same: React handles clearing via chatStore.
  }

  // Shared tap/hold state for the "+" new-session button and the Alt+N hotkey.
  // Tap = startNewSession, hold ≥ NEW_SESSION_HOLD_MS = startNewSessionSameDir.
  const NEW_SESSION_HOLD_MS = 450;
  let _newSessionHoldTimer: number | null = null;
  let _newSessionDidHold = false;
  let _wiredNewBtn: HTMLElement | null = null;
  let _wiredSendBtn: HTMLElement | null = null;
  let _wiredStopBtn: HTMLElement | null = null;

  function newSessionHoldStart(): void {
    _newSessionDidHold = false;
    if (_newSessionHoldTimer !== null) clearTimeout(_newSessionHoldTimer);
    _newSessionHoldTimer = window.setTimeout(() => {
      _newSessionHoldTimer = null;
      _newSessionDidHold = true;
      void startNewSessionSameDir();
    }, NEW_SESSION_HOLD_MS);
  }

  function _newSessionHoldCancel(): void {
    if (_newSessionHoldTimer !== null) {
      clearTimeout(_newSessionHoldTimer);
      _newSessionHoldTimer = null;
    }
  }

  // Wire the new-session button using property assignment so re-wiring after a
  // layout switch (which replaces the DOM element) can't double-bind via addEventListener.
  function _wireNewSessionBtn(btn: HTMLElement): void {
    if (_wiredNewBtn === btn) return;
    _wiredNewBtn = btn;
    btn.onpointerdown = newSessionHoldStart;
    btn.onpointerup = _newSessionHoldCancel;
    btn.onpointerleave = _newSessionHoldCancel;
    btn.onpointercancel = _newSessionHoldCancel;
    // Single onclick handles both the hold-swallow and the tap-action so we
    // don't need a capture-phase listener to stop propagation after a hold.
    btn.onclick = () => {
      if (_newSessionDidHold) { _newSessionDidHold = false; return; }
      void startNewSession();
    };
  }

  // Same property-assignment pattern for send/stop so layout switches (which
  // unmount and remount <ChatView/>, creating fresh DOM nodes for these IDs)
  // get a working click handler on the new element instead of leaving it inert.
  function _wireSendBtn(btn: HTMLElement): void {
    if (_wiredSendBtn === btn) return;
    _wiredSendBtn = btn;
    btn.onclick = () => { void send(); };
  }
  function _wireStopBtn(btn: HTMLElement): void {
    if (_wiredStopBtn === btn) return;
    _wiredStopBtn = btn;
    btn.onclick = () => { stopStream(); };
  }

  // Alt+N keyup: cancel the pending hold timer and, if the hold did not engage,
  // run the tap-action (startNewSession). Mirrors layout.headerHoldEnd().
  function newSessionHoldEnd(): void {
    _newSessionHoldCancel();
    if (_newSessionDidHold) {
      _newSessionDidHold = false;
      return;
    }
    void startNewSession();
  }

  function showPermissionModal(denials: Array<{ tool_name: string; tool_input?: Record<string, string> }>): void {
    const modal = document.getElementById('perm-modal');
    const list = document.getElementById('perm-list');
    if (!modal || !list) return;
    list.innerHTML = '';
    const tools: string[] = [];
    for (const d of denials) {
      const li = document.createElement('li');
      const fp = d.tool_input?.['file_path'] || d.tool_input?.['command'] || d.tool_input?.['path'] || '';
      li.textContent = fp ? `${d.tool_name} → ${fp}` : d.tool_name;
      list.appendChild(li);
      if (!tools.includes(d.tool_name)) tools.push(d.tool_name);
    }
    function close(): void { modal!.setAttribute('hidden', ''); modal!.style.display = 'none'; }
    function handleAllow(): void {
      close();
      const remember = document.getElementById('perm-remember') as HTMLInputElement | null;
      if (remember?.checked) chatStreaming.addAllowedTools(tools);
    }
    const allowBtn = document.getElementById('perm-allow') as HTMLElement | null;
    const dismissBtn = document.getElementById('perm-dismiss') as HTMLElement | null;
    const closeBtn = modal.querySelector('.perm-close') as HTMLElement | null;
    if (allowBtn) { const newAllow = allowBtn.cloneNode(true) as HTMLElement; allowBtn.replaceWith(newAllow); newAllow.addEventListener('click', handleAllow); }
    if (dismissBtn) { const newDismiss = dismissBtn.cloneNode(true) as HTMLElement; dismissBtn.replaceWith(newDismiss); newDismiss.addEventListener('click', close); }
    if (closeBtn) { const nc = closeBtn.cloneNode(true) as HTMLElement; closeBtn.replaceWith(nc); nc.addEventListener('click', close); }
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); }, { once: true });
    modal.removeAttribute('hidden'); modal.style.display = 'flex';
  }

  function buildDisplayInput(text: string, attachments: Record<string, unknown>[] = []): string {
    const inline: string[] = [];
    const ragBlocks: string[] = [];
    for (const a of attachments) {
      const t = a['type'];
      if (t === 'image') {
        inline.push(`\n![${a['name']}](${a['url']})`);
      } else if (t === 'file') {
        inline.push(`\n[Attached file: ${a['name']} — uploaded to session, use tools to read it if needed]`);
      } else if (t === 'rag-hit') {
        // Render the retrieved chunk body inline so the LLM sees it. Tagged
        // with its provenance (dbDisplayName / sourceKind / sourceId) so the
        // model can reason about where the snippet came from rather than
        // hallucinating attribution.
        const tag = String(a['dbDisplayName'] || a['dbId'] || 'rag');
        const kind = String(a['sourceKind'] || 'chunk');
        const sid = String(a['sourceId'] || '');
        const body = String(a['text'] || '').trim();
        ragBlocks.push(
          `\n--- RAG hit · ${tag} · ${kind}:${sid} ---\n${body}\n--- end hit ---`,
        );
      } else if (t === 'rag-hint') {
        // Footer note pointing at the MCP `rag_search` tool so partner agents
        // (Claude Code / Codex / external MCP clients) can re-query the same
        // database(s) for additional chunks without a manual round-trip.
        const ids = Array.isArray(a['dbIds']) ? (a['dbIds'] as unknown[]).map(String) : [];
        const idsJson = JSON.stringify(ids);
        const lastQuery = String(a['query'] || '').trim();
        const rerank = a['rerank'] === true;
        ragBlocks.push(
          `\n--- RAG note ---`
          + `\nThe hits above were retrieved from vector database(s): ${ids.join(', ') || '(unspecified)'}.`
          + `\nFor further retrieval, call the MCP tool \`rag_search\` with:`
          + `\n  { "query": "<your refined query>", "dbIds": ${idsJson}, "k": 8${rerank ? ', "rerank": true' : ''} }`
          + `\nUse \`rag_list_dbs\` first if you want to discover other databases.`
          + `\n--- end note ---`
          + (lastQuery ? `\n(original user query: ${JSON.stringify(lastQuery)})` : ''),
        );
      }
    }
    return (text + inline.join('') + ragBlocks.join('')).trim();
  }

  async function executeChatSend(opts: { text?: string; displayText?: string; attachments?: Record<string, unknown>[]; graphNode?: Record<string, unknown> | null; recordInGraph?: boolean } = {}): Promise<unknown> {
    return chatStreaming.executeChatSend(opts);
  }

  async function send(): Promise<void> {
    refreshTaIfStale();
    if (!ta) return;
    const text = ta.value.trim();
    const pendingAttachments = chatUI.getPendingAttachments();
    if (!text && !pendingAttachments.length) return;
    // Multichat host-session intercept: if the current session was created
    // as a multichat host, route the user's prompt to the group's /turn
    // endpoint instead of the regular /v1/stream-direct/. The backend pushes a
    // multichat-turn marker into this session's messages, which the
    // MessageList renders as an inline row of per-agent mini-bubbles.
    const sid = String(getAppState().currentSession || '');
    const sess = useSessionStore.getState().sessions.find((s) => String(s.id) === sid);
    const groupId = (sess?.multichatGroupId || '') as string;
    if (groupId) {
      inputHistoryActions.add(text);
      ta.value = '';
      autoGrow();
      const ok = await multichatGrid.submitTurn(groupId, text);
      // The /turn handler pushes the user prompt + multichat-row marker
      // into the host session synchronously before responding, so a refetch
      // here is guaranteed to surface them. Without it the chat scroll
      // wouldn't react to the user's submission at all (no SSE on the
      // host session, only on the slot sessions).
      if (ok) {
        try {
          const full = await session.fetchSession(sid);
          if (full?.messages) {
            const msgs = (full.messages as Array<{ role: string }>).map((m) => ({
              ...m,
              role: m.role === 'assistant' ? 'agent' : m.role,
            }));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            useChatStore.getState().setMessages(msgs as any);
          }
        } catch (_) {}
      }
      return;
    }
    inputHistoryActions.add(text);
    ta.value = '';
    autoGrow();
    const currentAttachments = pendingAttachments.slice();
    chatUI.clearAttachments();

    // Composer-mode branch — image / audio / video build a structured
    // <media-request> block so the model calls the right MCP tool with the
    // params the user picked in MediaParamPanel. Chat mode is unchanged.
    const appState = getAppState();
    const mode = appState.composerMode;
    if (mode === 'image' || mode === 'audio' || mode === 'video') {
      // Ensure the active-models cache is populated so the turn knows which
      // provider/model is targeted. The store dedupes concurrent fetches.
      await useActiveModelsStore.getState().load();
      const active = useActiveModelsStore.getState().byCategory[mode] || null;
      const params = appState.mediaParams[mode] || {};
      const enhance = appState.composerEnhance;
      const { text: turnText, displayText } = buildMediaTurn({
        mode, prompt: text, active, params, enhance,
      });
      await executeChatSend({ text: turnText, displayText, attachments: currentAttachments });
      return;
    }

    await executeChatSend({ text, attachments: currentAttachments });
  }

  // Approximate node bbox at render time — see nodes.css `.node` (min-width
  // 200, max-width 260, content-driven height ~80).
  const NODE_W = 230;
  const NODE_H = 80;
  // Per-axis minimum *gap* between any two node bboxes when a new node is
  // placed. Half a node-width horizontally, one full node-height vertically.
  const GAP_X = NODE_W / 2;
  const GAP_Y = NODE_H;

  // Returns true if a candidate (x,y) lands inside the buffer zone of any
  // existing node (bboxes overlap or are closer than the required gap on both
  // axes simultaneously). Treats (x,y) as the node's top-left.
  function overlapsExisting(x: number, y: number): boolean {
    const nodes = useGraphStore.getState().nodes as { x?: number; y?: number }[];
    for (const n of nodes) {
      const nx = typeof n.x === 'number' ? n.x : 0;
      const ny = typeof n.y === 'number' ? n.y : 0;
      if (Math.abs(x - nx) < NODE_W + GAP_X && Math.abs(y - ny) < NODE_H + GAP_Y) {
        return true;
      }
    }
    return false;
  }

  // Pushes a seed (x,y) downward in fixed steps until no existing node is
  // within the buffer zone. Down-only keeps recordings reading top-to-bottom
  // and never collides with newly-placed siblings on the same row.
  function avoidOverlap(seed: { x: number; y: number }): { x: number; y: number } {
    const STEP = NODE_H + GAP_Y;
    let { x, y } = seed;
    let guard = 200; // hard cap so a pathological graph can't loop forever
    while (overlapsExisting(x, y) && guard-- > 0) y += STEP;
    return { x, y: Math.round(y) };
  }

  // Snake layout for top-level chat/note/command nodes: rows of 4, alternating
  // direction (left→right, right→left, left→right, …) so the eye reads the
  // record as one continuous serpentine path through time. Per request:
  // "build like from left to right rows of 4 then next row down and from right
  // to left 4 and so on like a snake".
  function gridPos(i: number): { x: number; y: number } {
    const cols = 4;
    // Column step must clear the node bbox plus the half-width gap.
    const COL_W = NODE_W + GAP_X;
    const ROW_H = NODE_H + GAP_Y;
    const X0 = 80;
    const Y0 = 80;
    const row = Math.floor(i / cols);
    const colInRow = i % cols;
    const col = (row % 2 === 0) ? colInRow : (cols - 1 - colInRow);
    return avoidOverlap({ x: X0 + col * COL_W, y: Y0 + row * ROW_H });
  }

  // Spiral layout for child nodes (tool calls, #btw notes, etc.) emitted by
  // a single parent chat node. Uses the golden angle so successive children
  // never overlap and the spiral grows outward at a steady rate.
  function spiralPos(parent: { x?: number; y?: number } | null, childIdx: number): { x: number; y: number } {
    const px = (parent?.x ?? 80) + NODE_W / 2;  // approx parent-bbox center
    const py = (parent?.y ?? 80) + NODE_H / 2;
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));   // ≈ 2.39996 rad
    // Start radius clears the parent bbox plus half the new node's width;
    // step per child grows fast enough that children don't crowd each other.
    const R0 = NODE_W / 2 + GAP_X + NODE_W / 2;
    const STEP = 24;
    const angle = childIdx * GOLDEN - Math.PI / 2; // start above parent
    const radius = R0 + childIdx * STEP;
    return avoidOverlap({
      x: Math.round(px + Math.cos(angle) * radius - NODE_W / 2),
      y: Math.round(py + Math.sin(angle) * radius - NODE_H / 2),
    });
  }

  function pushMessage(msg: ChatMessage): HTMLElement {
    syncMessageCounter();
    msg._mid = nextMid();
    const entry = { ts: Date.now(), ...msg } as ChatMessage;
    useChatStore.setState((s) => ({ messages: [...s.messages, entry] }));
    return appendEl(msg);
  }

  // Inserts a message immediately before the active streaming placeholder so
  // it lands at the chronological position when the user typed it (instead of
  // dangling at the bottom under the finalized response). Used for #btw.
  function insertBeforeStreaming(msg: ChatMessage): HTMLElement {
    syncMessageCounter();
    msg._mid = nextMid();
    const entry = { ts: Date.now(), ...msg } as ChatMessage;
    const messages = useChatStore.getState().messages as ChatMessage[];
    let liveIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as ChatMessage & { typing?: boolean }).typing) { liveIdx = i; break; }
    }
    if (liveIdx < 0) {
      useChatStore.setState((s) => ({ messages: [...s.messages, entry] }));
    } else {
      const next = [...messages];
      next.splice(liveIdx, 0, entry);
      useChatStore.setState({ messages: next });
    }
    return appendEl(msg);
  }

  function escHtml(s: unknown): string { return chatUtils.escHtml(s); }

  function _positionPillFull(pill: HTMLElement): void {
    const full = pill.querySelector('.pill-full') as HTMLElement | null;
    if (!full) return;
    full.style.left = ''; full.style.right = '';
    pill.classList.remove('flip-down');
    // Only measurable when CSS has actually shown the popup (hover/expanded).
    if (getComputedStyle(full).display === 'none') return;
    const rect = full.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) { full.style.left = 'auto'; full.style.right = '0'; }
    else if (rect.left < 8) { full.style.left = '0'; full.style.right = 'auto'; }
    // Vertical: popup opens above the pill. If it'd clip the viewport top,
    // flip it below — but only if there's actually more room below than above.
    if (rect.top < 8) {
      const pillRect = pill.getBoundingClientRect();
      const spaceBelow = window.innerHeight - pillRect.bottom - 8;
      if (spaceBelow > pillRect.top) pill.classList.add('flip-down');
    }
  }

  function _resetPillFull(pill: HTMLElement): void {
    const full = pill.querySelector('.pill-full') as HTMLElement | null;
    if (full) { full.style.left = ''; full.style.right = ''; }
    pill.classList.remove('flip-down');
  }

  function getOrCreateToolStrip(): HTMLElement {
    if (!toolStrip) {
      toolStrip = document.createElement('div');
      toolStrip.className = 'tool-strip';
      scroll?.appendChild(toolStrip);
    }
    return toolStrip;
  }

  function appendToolPill(type: string, name: string, detail: unknown): HTMLElement {
    const strip = getOrCreateToolStrip();
    const pill = document.createElement('div');
    pill.className = `tool-pill ${type}`;
    const icon = iconSvg(type === 'tool-call' ? 'settings' : 'corner-down-right', 13);
    const fullStr = typeof detail === 'object' ? JSON.stringify(detail, null, 2) : String(detail || '');
    const snippet = (typeof detail === 'object' ? JSON.stringify(detail) : String(detail || '')).slice(0, 55);
    pill.innerHTML = `<div class="pill-row"><span class="pill-icon">${icon}</span><span class="pill-name">${escHtml(name)}</span><span class="pill-snippet">${escHtml(snippet)}</span></div><div class="pill-full">${escHtml(fullStr)}</div>`;
    strip.appendChild(pill);
    _scrollToBottom();
    return pill;
  }

  function renderBlocks(el: HTMLElement, blocks: Block[], liveText?: string): void {
    chatRendering.renderBlocks(el, blocks, liveText, md);
    // When React owns #chat-scroll, sync rendered HTML to chatStore so <Message> can display it.
    if (scroll?.dataset['react'] && el.dataset['mid']) {
      getChatActions().setStreamingSegment(el.dataset['mid'], el.innerHTML);
    }
    _scrollToBottom();
  }

  function appendEl(msg: ChatMessage): HTMLElement {
    // When React owns #chat-scroll it already rendered a slot for this message.
    // Return a detached element so streaming code can write into it; chat.ts syncs to store.
    if (scroll?.dataset['react']) {
      const el = chatRendering.createMsgEl(msg, md);
      if (msg._mid) {
        el.dataset['mid'] = String(msg._mid);
        getChatActions().setStreamingSegment(String(msg._mid), el.innerHTML);
      }
      return el;
    }
    if (msg.role !== 'system') toolStrip = null;
    const el = chatRendering.appendEl(msg, scroll!, md);
    if (msg._mid) el.dataset['mid'] = String(msg._mid);
    _scrollToBottom();
    scheduleMinimap(true);
    return el;
  }

  function updateMessage(el: HTMLElement, text: string, role?: string): void {
    chatRendering.updateMessage(el, text, role, md);
    if (scroll?.dataset['react'] && el.dataset['mid']) {
      getChatActions().setStreamingSegment(el.dataset['mid'], el.innerHTML);
    }
    _scrollToBottom();
  }

  function setMsgMeta(el: HTMLElement, msg: ChatMessage, meta: Record<string, unknown>): void {
    chatRendering.setMsgMeta(el, msg, meta as Parameters<typeof chatRendering.setMsgMeta>[2]);
  }

  function renderAll(): void {
    if (!scroll) return;
    if (scroll.dataset['react']) return; // <MessageList /> owns this container
    _scrollLocked = true; _updateScrollBtn();
    scroll.innerHTML = ''; toolStrip = null;
    const messages = useChatStore.getState().messages as ChatMessage[];
    syncMessageCounter();
    for (const m of messages) {
      if (!m._mid) m._mid = nextMid();
      if (m.role === 'tool') {
        const toolMsg = m as ChatMessage & { type?: string; name?: string; detail?: string };
        appendToolPill(toolMsg.type || 'tool-call', toolMsg.name || 'tool', toolMsg.detail || '');
      } else {
        appendEl(m);
        if (!m.blocks && m.role === 'agent' && m.toolCalls?.length) {
          for (const tc of m.toolCalls) appendToolPill(tc.type || 'tool-call', tc.name || 'tool', tc.detail || '');
        }
      }
    }
    requestAnimationFrame(buildMinimap);
  }

  async function reconnectStream(sessionId: string | null, knownStatus: { active?: boolean; status?: string } | null = null): Promise<void> {
    return chatStreaming.reconnectStream(sessionId, knownStatus);
  }

  function stopStream(sessionId: string | null = null): void { chatStreaming.stopStream(sessionId); }
  function updateStreamingUI(): void { chatStreaming.updateStreamingUI(); }
  function detachStream(sessionId: string): void { chatStreaming.detachStream(sessionId); }
  function clearAllowedTools(): void { chatStreaming.clearAllowedTools(); }
  function setKnownStreamStatus(sessionId: string | null, status: { active?: boolean; status?: string } = {}): void { chatStreaming.setKnownStreamStatus(sessionId, status); }
  function invalidateReconnect(sessionId: string | number | null): number { return chatStreaming.invalidateReconnect(sessionId); }

  async function copyMsg(mid: number): Promise<void> { await chatActions.copyMsg(mid); }
  async function editMsg(mid: number): Promise<void> { refreshTaIfStale(); await chatActions.editMsg(mid, ta!, autoGrow, scroll!, renderBlocks); }
  async function branchMsg(mid: number): Promise<void> { await chatActions.branchMsg(mid); }
  async function deleteMsg(mid: number): Promise<void> { await chatActions.deleteMsg(mid, scroll!); }
  function speakMsg(mid: number): void { chatActions.speakMsg(mid, scroll!); }

  let _exchPopup: HTMLElement | null = null;
  function closeExchPopup(): void { if (_exchPopup) { _exchPopup.remove(); _exchPopup = null; } }
  function showFileChipPopup(anchor: HTMLElement, kind: string, path: string, url: string): void {
    closeExchPopup();
    const name = path.split('/').pop() || path;
    const body = kind === 'image'
      ? `<img src="${url}" alt="${escHtml(name)}" loading="lazy" />`
      : `<audio controls autoplay preload="auto" src="${url}"></audio>`;
    const pop = document.createElement('div');
    pop.className = 'exchange-preview-popup mfc-popup';
    pop.innerHTML = `<div class="exchange-preview-header"><span class="exchange-preview-name" title="${escHtml(path)}">${escHtml(name)}</span><button class="exchange-preview-close" title="Close">✕</button></div><div class="exchange-preview-body">${body}</div><div class="exchange-preview-actions"><a href="${url}" target="_blank" class="exchange-preview-open">Open ↗</a><a href="${url}" download="${escHtml(name)}" class="exchange-preview-dl">Download ↓</a></div>`;
    (pop.querySelector('.exchange-preview-close') as HTMLElement).addEventListener('click', closeExchPopup);
    pop.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const pw = 360, ph = kind === 'audio' ? 130 : 320;
    let left = rect.left + window.scrollX;
    let top = rect.top + window.scrollY - ph - 8;
    if (top < 8) top = rect.bottom + window.scrollY + 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = Math.max(8, top) + 'px';
    _exchPopup = pop;
  }
  function showExchPopup(span: HTMLElement): void {
    closeExchPopup();
    const url = span.dataset['url']!;
    const name = span.dataset['name']!;
    const pop = document.createElement('div');
    pop.className = 'exchange-preview-popup';
    pop.innerHTML = `<div class="exchange-preview-header"><span class="exchange-preview-name">${escHtml(name)}</span><button class="exchange-preview-close" title="Close">✕</button></div><div class="exchange-preview-body"><img src="${url}" alt="${escHtml(name)}" loading="lazy" /></div><div class="exchange-preview-actions"><a href="${url}" target="_blank" class="exchange-preview-open">Open full size ↗</a><a href="${url}" download="${escHtml(name)}" class="exchange-preview-dl">Download ↓</a></div>`;
    (pop.querySelector('.exchange-preview-close') as HTMLElement).addEventListener('click', closeExchPopup);
    pop.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(pop);
    const rect = span.getBoundingClientRect();
    const pw = 320, ph = 280;
    let left = rect.left + window.scrollX;
    let top = rect.bottom + window.scrollY + 6;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight + window.scrollY - 8) top = rect.top + window.scrollY - ph - 6;
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = Math.max(8, top) + 'px';
    _exchPopup = pop;
  }

  let _linkPopup: HTMLElement | null = null;
  function closeLinkPopup(): void { if (_linkPopup) { _linkPopup.remove(); _linkPopup = null; } }
  function showLinkPopup(anchor: HTMLAnchorElement, x: number, y: number): void {
    closeLinkPopup();
    const url = anchor.href;
    const pop = document.createElement('div');
    pop.className = 'link-popup';
    pop.innerHTML = `<div class="link-popup-url" title="${escHtml(url)}">${escHtml(url)}</div><button class="link-popup-btn" data-action="copy"><span class="lpb-icon">⎘</span> Copy link</button><button class="link-popup-btn" data-action="new"><span class="lpb-icon">↗</span> Open in new window</button><button class="link-popup-btn" data-action="here"><span class="lpb-icon">→</span> Open in this window</button>`;
    pop.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!btn) return;
      const action = btn.dataset['action'];
      if (action === 'copy') { navigator.clipboard?.writeText(url).catch(() => {}); }
      else if (action === 'new') { window.open(url, '_blank', 'noopener,noreferrer'); }
      else if (action === 'here') { window.location.href = url; }
      closeLinkPopup();
    });
    document.body.appendChild(pop);
    _linkPopup = pop;
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = pop.offsetWidth || 190, ph = pop.offsetHeight || 130;
    const left = x + pw > vw - 8 ? vw - pw - 10 : x;
    const top2 = y + ph > vh - 8 ? y - ph - 6 : y + 6;
    pop.style.left = left + 'px';
    pop.style.top = top2 + 'px';
    setTimeout(() => {
      const dismiss = (e: MouseEvent) => { if (!_linkPopup) return; if (!_linkPopup.contains(e.target as Node)) closeLinkPopup(); document.removeEventListener('mousedown', dismiss, true); document.removeEventListener('keydown', onKey, true); };
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { closeLinkPopup(); document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', dismiss, true); } };
      document.addEventListener('mousedown', dismiss, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  function initLinkPopup(): void {
    scroll!.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.href;
      if (!href || href.startsWith('javascript:')) return;
      e.preventDefault();
      e.stopPropagation();
      showLinkPopup(a, e.clientX, e.clientY);
    });
  }


  function _updateEmptyState(): void {
    // Re-resolve if the cached element was disconnected by a layout switch.
    if (!root || !root.isConnected) root = document.getElementById('view-chat');
    if (!root) return;
    const messages = useChatStore.getState().messages as ChatMessage[];
    const hasContent = messages.some((m) => m.role === 'user' || m.role === 'agent' || m.role === 'note' || m.role === 'tool' || m.role === 'error');
    root.classList.toggle('chat-empty', !hasContent);
  }

  // All event listeners that live on #chat-scroll. Extracted so they can be
  // re-registered when a layout switch replaces the element.
  function _bindScrollListeners(): void {
    if (!scroll) return;

    scroll.addEventListener('scroll', () => {
      const fromBottom = scroll!.scrollHeight - scroll!.scrollTop - scroll!.clientHeight;
      const now = performance.now();
      // Within 150ms of our own programmatic scroll-to-bottom, ignore the
      // resulting scroll event so async content reflows (markdown, code
      // highlighting, images) don't masquerade as user-initiated scrolls
      // and silently turn off the auto-follow lock.
      const isProgrammatic = (now - _lastProgrammaticScroll) < 150;
      const wentUp = scroll!.scrollTop < _lastScrollTop - 1;
      _lastScrollTop = scroll!.scrollTop;
      _updateScrollBtn();
      if (fromBottom < 60) {
        _scrollLocked = true;
        return;
      }
      // Only release the lock when the user actively scrolled UP. Layout
      // growth that pushes us past the 60px threshold without a real user
      // gesture must NOT unlock — that was the long-standing mid-stream bug.
      if (!isProgrammatic && wentUp) {
        _scrollLocked = false;
      }
    }, { passive: true });

    document.getElementById('chat-scroll-btn')?.addEventListener('click', () => {
      _scrollLocked = true;
      scroll!.scrollTop = scroll!.scrollHeight;
      _updateScrollBtn();
    });

    // Content grows during streaming WITHOUT firing scroll events when the
    // user is parked above the bottom (scrollTop doesn't change, only
    // scrollHeight does). Without this observer the button stays hidden
    // even as the bottom slides further away. rAF-throttled to stay cheap.
    if (_scrollBtnMo) _scrollBtnMo.disconnect();
    _scrollBtnMo = new MutationObserver(_scheduleUpdateScrollBtn);
    _scrollBtnMo.observe(scroll, { childList: true, subtree: true, characterData: true });

    initLinkPopup();

    scroll.addEventListener('click', (e) => {
      const pill = (e.target as HTMLElement).closest('.tool-pill') as HTMLElement | null;
      const expanded = scroll!.querySelectorAll('.tool-pill.expanded');
      if (pill) {
        const opening = !pill.classList.contains('expanded');
        expanded.forEach((p) => p !== pill && p.classList.remove('expanded'));
        pill.classList.toggle('expanded', opening);
        if (opening) requestAnimationFrame(() => _positionPillFull(pill));
        else _resetPillFull(pill);
      } else {
        expanded.forEach((p) => { p.classList.remove('expanded'); _resetPillFull(p as HTMLElement); });
      }
    });

    // Hover positioning — clamp the .pill-full inside the viewport and flip
    // below the pill if there's no room above. Uses pointerover/out because
    // mouseenter/leave don't bubble, so a single delegated pair covers every
    // pill (including ones that arrive later via streaming).
    scroll.addEventListener('pointerover', (e) => {
      const pill = (e.target as HTMLElement).closest('.tool-pill') as HTMLElement | null;
      if (!pill) return;
      const from = e.relatedTarget as Node | null;
      if (from && pill.contains(from)) return; // moving within the pill, ignore
      requestAnimationFrame(() => _positionPillFull(pill));
    });
    scroll.addEventListener('pointerout', (e) => {
      const pill = (e.target as HTMLElement).closest('.tool-pill') as HTMLElement | null;
      if (!pill) return;
      const to = e.relatedTarget as Node | null;
      if (to && pill.contains(to)) return; // leaving into a child, ignore
      if (pill.classList.contains('expanded')) return; // click-locked, keep position
      _resetPillFull(pill);
    });

    scroll.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.msg-act-btn') as HTMLElement | null;
      if (!btn) return;
      e.stopPropagation();
      const msgEl = btn.closest('.msg') as HTMLElement | null;
      if (!msgEl) return;
      const mid = +msgEl.dataset['mid']!;
      const action = btn.dataset['action'];
      if (action === 'copy') copyMsg(mid);
      else if (action === 'speak') speakMsg(mid);
      else if (action === 'edit') editMsg(mid);
      else if (action === 'branch') branchMsg(mid);
      else if (action === 'delete') deleteMsg(mid);
    });

    scroll.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLElement | null;
      if (!btn) return;
      e.stopPropagation();
      const pre = btn.closest('pre') as HTMLElement | null;
      const code = pre?.querySelector('code');
      const text = code?.textContent ?? '';
      chatActions.copyText(text).then(() => {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1200);
      });
    });

    // AskUser submit — collect selections + notes for each fieldset, POST to
    // the bridge, and let the bridge's askUserQuestionAnswered SSE chunk
    // flip the rendered form to its resolved-summary state. Failure leaves
    // the form interactive so the user can retry.
    scroll.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-action="ask-user-submit"]') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const block = btn.closest('.ask-user-block') as HTMLElement | null;
      if (!block) return;
      const questionId = block.dataset['questionId'] || '';
      if (!questionId) return;
      const answers: Array<{ questionIndex: number; selected: string[]; notes?: string }> = [];
      block.querySelectorAll<HTMLFieldSetElement>('fieldset.ask-user-question').forEach((fs) => {
        const qi = Number(fs.dataset['qIndex'] || '-1');
        if (qi < 0) return;
        const selected: string[] = [];
        fs.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked, input[type="checkbox"]:checked').forEach((inp) => {
          selected.push(inp.value);
        });
        const notesEl = fs.querySelector('textarea.ask-user-notes') as HTMLTextAreaElement | null;
        const notes = (notesEl?.value || '').trim();
        answers.push({ questionIndex: qi, selected, notes: notes || undefined });
      });
      const sid = String(getAppState().currentSession || '');
      if (!sid) return;
      btn.setAttribute('disabled', '');
      btn.textContent = 'Submitting…';
      fetch(`/v1/sessions/${encodeURIComponent(sid)}/answer-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId, answers }),
      })
        .then((r) => r.json().catch(() => ({})))
        .then((j) => {
          if (j?.success) return; // SSE chunk will flip the UI
          btn.removeAttribute('disabled');
          btn.textContent = 'Submit answer';
          console.warn('answer-question failed', j);
        })
        .catch((err) => {
          btn.removeAttribute('disabled');
          btn.textContent = 'Submit answer';
          console.warn('answer-question error', err);
        });
    });

    scroll.addEventListener('click', (e) => {
      const span = (e.target as HTMLElement).closest('.exchange-file-ref') as HTMLElement | null;
      if (span) { e.stopPropagation(); showExchPopup(span); return; }
      if (!(e.target as HTMLElement).closest('.exchange-preview-popup')) closeExchPopup();
    });

    // Mentioned-file chips at the bottom of agent bubbles → route by kind:
    //   image  → centered preview popup
    //   audio  → inline player popup
    //   video  → open in a new tab
    //   pdf    → open in a new tab (browsers render natively)
    //   text   → file editor / viewer modal (re-uses fileEditor.open)
    scroll.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest('.mentioned-file-chip') as HTMLElement | null;
      if (!chip) return;
      e.stopPropagation();
      e.preventDefault();
      const path = chip.dataset['path'] || '';
      const kind = chip.dataset['kind'] || 'text';
      if (!path) return;
      const url = `/local-image?path=${encodeURIComponent(path)}`;
      if (kind === 'image' || kind === 'audio') {
        showFileChipPopup(chip, kind, path, url);
      } else if (kind === 'video' || kind === 'pdf') {
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        import('./modals/file-editor.js').then(({ fileEditor }) => {
          if (typeof fileEditor.open === 'function') {
            fileEditor.open(path);
          } else {
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        }).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
      }
    });
  }

  function init(): void {
    root = document.getElementById('view-chat')!;
    // DOM structure is now rendered by ChatView.tsx (React).

    scroll = document.getElementById('chat-scroll') as HTMLDivElement | null;
    ta = document.getElementById('chat-ta') as HTMLTextAreaElement | null;
    md = _vendorMd as MarkdownIt;

    // React may not have committed yet (or a portal crash may have unmounted
    // the tree). Observe and retry once the elements appear.
    if (!scroll || !ta) {
      const obs = new MutationObserver(() => {
        if (document.getElementById('chat-scroll') && document.getElementById('chat-ta')) {
          obs.disconnect();
          init();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      return;
    }

    _bindScrollListeners();
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExchPopup(); });

    // Re-bind listeners that were on the old ChatView DOM when a layout switch
    // replaces it. Covers: #chat-scroll, #chat-new-session, #chat-send,
    // #chat-stop, and #view-chat (root for the chat-empty class). All use the
    // same body observer so one MutationObserver handles them.
    {
      const layoutSwitchObs = new MutationObserver(() => {
        const freshScroll = document.getElementById('chat-scroll') as HTMLElement | null;
        if (freshScroll && freshScroll !== scroll) {
          scroll = freshScroll;
          _bindScrollListeners();
          if (ta) chatUI.init(scroll, ta);
        }
        const freshNewBtn = document.getElementById('chat-new-session') as HTMLElement | null;
        if (freshNewBtn) _wireNewSessionBtn(freshNewBtn);
        const freshSendBtn = document.getElementById('chat-send') as HTMLElement | null;
        if (freshSendBtn) _wireSendBtn(freshSendBtn);
        const freshStopBtn = document.getElementById('chat-stop') as HTMLElement | null;
        if (freshStopBtn) _wireStopBtn(freshStopBtn);
        const freshRoot = document.getElementById('view-chat') as HTMLElement | null;
        if (freshRoot && freshRoot !== root) {
          root = freshRoot;
          _updateEmptyState();
        }
      });
      layoutSwitchObs.observe(document.body, { childList: true, subtree: true });
    }

    ta.addEventListener('input', () => { _checkAtMention(); });
    // Paste is handled by ChatInput.tsx's onPaste (frontend/src/chat/paste-upload.ts).
    // Don't add a second DOM listener here — at init time `ta` resolves to the
    // React-owned visible textarea, so a listener here would fire alongside
    // React's onPaste and double every upload.

    {
      const sendBtn = document.getElementById('chat-send') as HTMLElement | null;
      if (sendBtn) _wireSendBtn(sendBtn);
      const stopBtn = document.getElementById('chat-stop') as HTMLElement | null;
      if (stopBtn) _wireStopBtn(stopBtn);
    }
    // chat-new-session: tap = startNewSession, hold ≥ 450ms = startNewSessionSameDir.
    // Hold state lives at module scope so Alt+N (KeyboardShortcuts.tsx) can share it.
    // Uses property assignment via _wireNewSessionBtn so layout-switch re-wiring
    // (in scrollReplaceObs below) never double-binds.
    {
      const newBtn = document.getElementById('chat-new-session') as HTMLElement | null;
      if (!newBtn) console.warn('[chat] #chat-new-session not found during init');
      else _wireNewSessionBtn(newBtn);
    }
    // chat-model-btn click handled by <ModelPicker /> React component (ModelPicker.tsx)

    // TOOLS_CYCLE / TITLES removed — owned by <CapabilityBadges />

    // Cap button DOM sync now handled by <CapabilityBadges /> via appStore.
    // Kept as a no-op so callers in this function don't need removal.
    function updateCapBtns(): void {}

    // cap-vision/reasoning/tools click handlers removed — owned by <CapabilityBadges />
    // session-btn click handled by <SessionPicker /> React component (SessionPicker.tsx)
    // chat-voicemode click handled by <VoiceMode /> React component registered via panel slot
    // chat-sys-btn click handled by <SysPromptEditor /> React component (SysPromptEditor.tsx)

    refreshSessionList();

    // Model badge label is managed by <ModelBadge /> via appStore subscription.
    // The cap toggles are managed by <CapabilityBadges />. models.setCurrent()
    // now applies caps directly and updates the chat-model-btn DOM.
    void updateCapBtns;

    chatParticipants.init(ta!, autoGrow);
    chatUI.init(scroll, ta);

    _updateEmptyState();
    useChatStore.subscribe(_updateEmptyState);
    // chat-empty-bg WebGL canvas now mounted by <ChatEmptyBg /> React component (ChatEmptyBg.tsx)

    // Sync participants chip-bar when the active session changes.
    let _prevSid = useSessionStore.getState().currentId;
    useSessionStore.subscribe((state) => {
      if (state.currentId === _prevSid) return;
      _prevSid = state.currentId;
      const cache = (session.getCached() || []) as unknown as Record<string, unknown>[];
      const cur = cache.find((s) => String(s['id']) === String(getAppState().currentSession || '')) as Record<string, unknown> | undefined;
      chatParticipants._updateParticipants((cur?.['participants'] as string[]) || []);
    });
    setTimeout(() => {
      const cache = (session.getCached() || []) as unknown as Record<string, unknown>[];
      const cur = cache.find((s) => String(s['id']) === String(getAppState().currentSession || '')) as Record<string, unknown> | undefined;
      chatParticipants._updateParticipants((cur?.['participants'] as string[]) || []);
    }, 500);
    chatParticipants._loadAtEmployees();

    // node:executed → push synthetic chat messages for chat/note node types.
    let _prevExec = useGraphStore.getState().lastExecuted;
    useGraphStore.subscribe((state) => {
      if (state.lastExecuted === _prevExec) return;
      _prevExec = state.lastExecuted;
      const e = _prevExec;
      if (!e || !e.node) return;
      if (e.viaChatEngine) return;
      const cmd = String((e.node as Record<string, string>)['command'] || '').trim();
      if (cmd.startsWith('#ns') || cmd.startsWith('#new')) { startNewSession(); return; }
      const node = e.node as unknown as Record<string, unknown>;
      if (node['type'] === 'chat' || cmd.startsWith('#note')) {
        const userInput = String(node['command'] || (String(node['input'] || '')).slice(0, 100));
        if (userInput) pushMessage({ role: 'user', text: userInput });
        pushMessage({ role: e.error ? 'error' : 'agent', text: String(e.output || '') });
      }
    });

    void currentSessionId;
  }

  return {
    init,
    send,
    executeChatSend,
    stopStream,
    renderAll,
    pushMessage,
    refreshSessionList,
    startNewSession,
    startNewSessionSameDir,
    newSessionHoldStart,
    newSessionHoldEnd,
    insertBeforeStreaming,
    addAttachment,
    removeAttachment,
    reconnectStream,
    updateStreamingUI,
    detachStream,
    clearAllowedTools,
    setKnownStreamStatus,
    invalidateReconnect,
    getMsgText,
    scheduleMinimap,
    buildMinimap,
    copyMsg,
    editMsg,
    branchMsg,
    deleteMsg,
    speakMsg,
    buildDisplayInput,
    showPermissionModal,
    showDebugModal,
    updateMessage,
    renderBlocks,
    setMsgMeta,
    renderAttachmentStrip,
    gridPos,
    spiralPos,
    syncMessageCounter
  };
})();

export default chat;
