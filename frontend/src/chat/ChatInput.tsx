import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import chatUI from './chat-ui.js';
import { chatParticipants } from './chat-participants.js';
import { useChatStore, useSessionStore, useAppStore } from '../stores/index.js';
import { useInputHistoryStore } from '../stores/inputHistoryStore.js';
import { bus } from '../state.js';
import { chat } from '../chat.js';
import { imageFilesFromClipboard, uploadPastedFiles } from './paste-upload.js';
import { api } from '../api.js';
import { CommandPicker, findSelectedPickerRow } from '../pickers/CommandPicker.js';
import { AppCommandPalette, findSelectedRow, runAppCommand } from '../pickers/AppCommandPalette.js';
import { MentionPickerForDirectMsg } from '../pickers/MentionPickerForDirectMsg.js';
import { registers } from '../host/keys.js';
import { useBridgeModuleEnabledStrict } from '../host/bridge-modules.js';
import { useDraftAutosave, loadDraft, loadLocalDraft, clearDraft, type DraftPayload } from './useDraftAutosave.js';
import { SEED_SKILL_EVENT, type SeedSkillDetail } from './seedCommand.js';
import { useInlineSuggestion, GhostOverlay } from '../modules/input-autocomplete/index.js';

type Employee = {
  id: string;
  name?: string;
  role?: string;
};

interface MountState {
  container: HTMLElement;
  legacyTextarea: HTMLTextAreaElement;
}

function ChatInputInner({
  legacyTextarea,
  carryoverRef,
}: {
  legacyTextarea: HTMLTextAreaElement;
  carryoverRef: React.MutableRefObject<string>;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Tracks whether we've already attached our handler to a given button DOM
  // node. Replaced the previous clone-and-replaceWith pattern, which detached
  // React-managed DOM and caused commit-phase insertBefore errors when slots
  // tried to re-render around the (now-orphaned) button reference.
  const sendBtnRef = useRef<HTMLElement | null>(null);
  const cmdBtnRef  = useRef<HTMLElement | null>(null);
  const btwBtnRef  = useRef<HTMLElement | null>(null);
  const sendHandlerRef = useRef<(() => void) | null>(null);
  const cmdHandlerRef  = useRef<((e: MouseEvent) => void) | null>(null);
  const btwHandlerRef  = useRef<(() => void) | null>(null);
  // Carryover survives layout switches: the outer <ChatInput> stays mounted,
  // so its ref holds the last-typed value across our unmount/remount cycle.
  // After carryover and the live textarea, fall back to the synchronous
  // localStorage draft layer — that hydrates on the very first render so
  // there's no flash-of-empty-input after a hard reload (the async server
  // restore below may still overwrite with a newer cross-device value).
  // Captured once in a ref so we can also compare its updatedAt against the
  // server payload in the mount effect.
  const localDraftSeedRef = useRef<DraftPayload | null | undefined>(undefined);
  if (localDraftSeedRef.current === undefined) {
    localDraftSeedRef.current = loadLocalDraft();
  }
  const [value, setValue] = useState(
    () => carryoverRef.current || legacyTextarea.value || localDraftSeedRef.current?.text || '',
  );
  const valueRef = useRef(value);
  const [commandOpen, setCommandOpen] = useState(false);
  // Which trigger char opened the picker. `#` → CommandPicker (commands
  // that produce direct chat output: tools, MCP, codex, local nodes,
  // skills); `/` → AppCommandPalette (interface / settings / module
  // commands that never enter the chat stream). The two surfaces never
  // cross-open (LayoutPlan.md §Two-surface design).
  const [commandSurface, setCommandSurface] = useState<'#' | '/'>('#');
  // Single-expand state shared by both pickers' hierarchical rest view —
  // they're mutually exclusive (commandSurface picks one), so one piece
  // of state is enough. Lives here (not inside the pickers) so it
  // survives renders and so the `findSelected*Row` helpers agree with
  // what's on screen when Enter is pressed.
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  // Second-level expand state for the `#` picker — currently the MCP Tools
  // group is the only one that sub-categorizes (by parent MCP server), but
  // CommandPicker treats this generically. Reset whenever expandedGroup
  // changes so a stale subgroup key doesn't leak across categories.
  const [expandedSubgroup, setExpandedSubgroup] = useState<string | null>(null);
  useEffect(() => { setExpandedSubgroup(null); }, [expandedGroup]);
  // `#` picker only — when the user opens the picker via the toolbar button
  // while there's already non-trivial text in the input (anything other
  // than empty / `#` / `/`), we preserve their text and the picked command
  // is *prepended* with a separating space instead of replacing the value.
  // The picker is forced into its hierarchical rest view in this mode
  // (the actual textarea value isn't a `#…` query, so we override the
  // `query` prop with `'#'`). Lifecycle is tied to commandOpen below.
  const [prependMode, setPrependMode] = useState(false);
  const [participantOpen, setParticipantOpen] = useState(false);
  const [commandSelectedIdx, setCommandSelectedIdx] = useState(0);
  const [participantSelectedIdx, setParticipantSelectedIdx] = useState(0);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const currentId = useSessionStore((s) => s.currentId);
  const personnelEnabled = useBridgeModuleEnabledStrict('multichat-personnel');
  // Narrow selector: only re-render when the current session's participants change.
  // Subscribing to the whole sessions array caused a re-render on every streaming
  // chunk that updated any session field (title, last message, etc.).
  const sessionParticipantKey = useSessionStore((s) => {
    const cur = s.sessions.find((x) => String(x.id) === String(s.currentId));
    return (cur?.participants || []).join(',');
  });
  const sessionParticipants = useMemo(
    () => (sessionParticipantKey ? sessionParticipantKey.split(',') : []),
    [sessionParticipantKey],
  );
  const inputHistoryList = useInputHistoryStore((s) => s.history);
  const addToInputHistory = useInputHistoryStore((s) => s.add);
  const setInputHistoryIdx = useInputHistoryStore((s) => s.setIdx);
  const enterToSend = useAppStore((s) => s.enterToSend);
  // Narrow selector: only re-render when the *current* session's streaming
  // state changes. The chat-streaming module pushes patches into
  // sessionStreams on every state transition (start, stop, reconnect, btw
  // injection), so this is enough to drive the insert-into-flow button's
  // visibility without polling.
  const isStreaming = useChatStore((s) => {
    const sid = String(currentId || 'default');
    const st = s.sessionStreams[sid];
    return !!(st && (st.localLive || st.reconnecting || st.serverActive));
  });

  const [caretAtEnd, setCaretAtEnd] = useState(true);
  const [composing, setComposing] = useState(false);
  // Mirror taRef.current into state so <GhostOverlay> re-renders once the
  // textarea has mounted (refs don't trigger re-renders on assignment).
  const [taEl, setTaEl] = useState<HTMLTextAreaElement | null>(null);
  useEffect(() => { setTaEl(taRef.current); }, []);
  const pickerOpen = commandOpen || participantOpen;
  const { suggestion, accept: acceptSuggestion, dismiss: dismissSuggestion } =
    useInlineSuggestion({ value, caretAtEnd, pickerOpen, composing });

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    return () => {
      carryoverRef.current = valueRef.current;
    };
  }, [carryoverRef]);

  // ── Phase 0: server-side autosave ────────────────────────────────────────
  // Restore once on mount. The synchronous localStorage seed already
  // populated `value` above (no flash-of-empty-input). Here we fetch the
  // server copy and adopt it only if it's strictly newer than whatever
  // localStorage held — that's the cross-device case ("I just typed this on
  // my laptop, now I'm on the desktop"). If the user has already typed or
  // edited locally since mount (valueRef differs from the local seed), we
  // never clobber their fresh input.
  useEffect(() => {
    let cancelled = false;
    const localSeed = localDraftSeedRef.current;
    const localTs   = localSeed?.updatedAt ?? 0;
    const localText = localSeed?.text ?? '';
    void (async () => {
      const draft = await loadDraft();
      if (cancelled) return;
      if (!draft?.text) return;
      // User has typed since mount → don't clobber their fresh input.
      if (valueRef.current !== localText) return;
      // Local copy is the same as (or newer than) the server copy.
      if (draft.updatedAt <= localTs) return;
      setValue(draft.text);
      legacyTextarea.value = draft.text;
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only — legacyTextarea is stable for the lifetime of this inner
    // component (the outer ChatInput remounts when the legacy node moves).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy autosave: debounce 5 s after last keystroke + only PUT when no
  // session is streaming. See useDraftAutosave.ts for the gate logic.
  useDraftAutosave(value);

  useEffect(() => {
    if (!personnelEnabled) return;
    const baseUrl = api.config.baseUrl || '';
    if (!baseUrl) return;
    fetch(baseUrl + '/v1/employees/')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.employees) setEmployees(d.employees as Employee[]);
      })
      .catch(() => {});
  }, [currentId, personnelEnabled]);

  function autoGrow() {
    if (taRef.current) chatUI.autoGrow(taRef.current);
  }

  useEffect(() => {
    // Defer to rAF — reading scrollHeight forces a full synchronous layout
    // reflow. With a large chat DOM this costs ~30ms per keystroke when run
    // inside React's commit phase. rAF batches it with the normal paint tick.
    const id = requestAnimationFrame(() => autoGrow());
    return () => cancelAnimationFrame(id);
  }, [value]);

  useEffect(() => {
    legacyTextarea.value = value;
  }, [legacyTextarea, value]);

  // Composer seed bus — drives `#skill-<name> ` insertion from outside the
  // React tree (see chat/seedCommand.ts). Mirrors the prepend rules in
  // `openCommandPicker('#')`: trivial composer → replace, trigger-prefixed
  // → leave alone, otherwise → prepend with a single trailing space.
  useEffect(() => {
    function onSeed(e: Event) {
      const detail = (e as CustomEvent<SeedSkillDetail>).detail;
      const skill = detail?.skill;
      if (typeof skill !== 'string' || !skill) return;
      const ta = taRef.current;
      if (!ta) return;
      const argSuffix = detail?.args ? `${detail.args} ` : '';
      const seed = `#skill-${skill} ${argSuffix}`;
      const existing = ta.value;
      const trivial = existing === '' || existing === '#' || existing === '/'
        || existing === '# ' || existing === '/ ';
      // Walk a leading `#skill-<name>` chain so we can stack onto it; we
      // need this because the bare `startsWithTrigger` check below would
      // otherwise refuse to seed when the user already has one or more
      // skill tokens at the start (`#skill-a foo` → no-op without this).
      const CHAIN_TOKEN_RE = /^#skill-([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63})(?=\s|$)/;
      let chainEnd = 0;
      let scan = existing;
      let consumed = 0;
      while (true) {
        const m = scan.match(CHAIN_TOKEN_RE);
        if (!m) break;
        consumed += m[0].length;
        chainEnd = consumed;
        scan = scan.slice(m[0].length);
        const ws = scan.match(/^\s+/);
        if (!ws) break;
        consumed += ws[0].length;
        scan = scan.slice(ws[0].length);
      }
      const startsWithTrigger = existing.startsWith('#') || existing.startsWith('/');
      let next: string;
      if (trivial) {
        next = seed;
      } else if (chainEnd > 0) {
        // Splice the new token after the existing chain, before any args.
        const head = existing.slice(0, chainEnd);
        const tail = existing.slice(chainEnd).replace(/^\s+/, '');
        next = tail ? `${head} ${seed}${tail}` : `${head} ${seed}`;
      } else if (startsWithTrigger) {
        // Already a picker query — don't clobber the user's in-progress
        // input. Just focus so they can see the textarea.
        ta.focus();
        return;
      } else {
        next = seed + existing;
      }
      ta.value = next;
      legacyTextarea.value = next;
      setValue(next);
      ta.focus();
      const end = next.length;
      try { ta.setSelectionRange(end, end); } catch { /* IE */ }
      chatUI.autoGrow(ta);
    }
    document.addEventListener(SEED_SKILL_EVENT, onSeed);
    return () => document.removeEventListener(SEED_SKILL_EVENT, onSeed);
  }, [legacyTextarea]);

  useEffect(() => {
    if (!taRef.current) return;
    chatParticipants.bindTextarea(taRef.current, autoGrow);

    const ta = taRef.current;
    // Only sync when external code (chatParticipants, autofill) changes ta.value
    // outside of React's onChange — avoids a second re-render on every keystroke
    // where handleChange already updated state.
    const syncFromDom = () => {
      const next = ta.value;
      if (next !== valueRef.current) setValue(next);
    };
    ta.addEventListener('input', syncFromDom);
    return () => {
      ta.removeEventListener('input', syncFromDom);
    };
  }, []);

  useEffect(() => {
    // editMsg (and any other vanilla code that wants to prefill the input)
    // pushes through the bus because the legacy `ta` reference points at
    // the hidden chat-ta-legacy textarea, not this React-controlled one.
    const handler = (text: unknown) => {
      const next = typeof text === 'string' ? text : '';
      setValue(next);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    };
    bus.on('chat:set-input', handler);
    return () => bus.off('chat:set-input', handler);
  }, []);

  // Insert-into-flow eligibility: while a stream is active in the current
  // session AND there is non-empty composer text that isn't already a #btw
  // command. Attachments are intentionally NOT a gate — when the user has
  // both attachments and text mid-stream, we send the text part as #btw and
  // keep attachments in the composer for the next real send (per design).
  function shouldInsertIntoFlow(): boolean {
    if (!isStreaming) return false;
    const v = (taRef.current?.value ?? valueRef.current).trim();
    if (!v) return false;
    if (v.startsWith('#btw')) return false;
    return true;
  }

  // Routes the current composer text through the existing #btw chat-submit
  // interceptor (chat-streaming.ts:577-613). Reuses sendViaLegacy's clear
  // logic by mutating ta.value before the call so the interceptor sees the
  // `#btw …` form. Attachments are untouched — only text is cleared.
  async function sendAsBtw() {
    const ta = taRef.current;
    const current = ta?.value ?? valueRef.current;
    const trimmed = current.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('#btw')) {
      await sendViaLegacy();
      return;
    }
    const btwText = `#btw ${trimmed}`;
    if (ta) ta.value = btwText;
    legacyTextarea.value = btwText;
    setValue(btwText);
    await sendViaLegacy();
  }

  async function sendViaLegacy() {
    const currentValue = taRef.current?.value ?? valueRef.current;
    setCommandOpen(false);
    setParticipantOpen(false);
    const cwd = useAppStore.getState().sessionWorkingDir ?? null;
    const interceptors = registers.chatSubmitInterceptors.list();
    for (const interceptor of interceptors) {
      if (interceptor.handle(currentValue, { sessionId: currentId != null ? String(currentId) : null, cwd })) {
        setValue('');
        legacyTextarea.value = '';
        setInputHistoryIdx(-1);
        clearDraft();
        return;
      }
    }
    const trimmedValue = currentValue.trim();
    if (trimmedValue) addToInputHistory(trimmedValue);
    legacyTextarea.value = currentValue;
    setValue('');
    // Phase 0: drop the autosaved draft now that this message has been sent.
    // Fire-and-forget — the autosave loop's de-dupe check (lastSavedRef) and
    // empty-text branch on the server both self-heal a racing PUT.
    if (trimmedValue) clearDraft();
    if (!chat?.send) return;
    await chat.send();
  }

  function openCommandPicker(prefix: '#' | '/') {
    const ta = taRef.current;
    if (!ta) return;
    const existing = ta.value;
    const trivial = existing === '' || existing === '#' || existing === '/' || existing === '# ' || existing === '/ ';
    const startsWithTrigger = existing.startsWith('#') || existing.startsWith('/');
    if (trivial) {
      // Empty or lone trigger char: seed the textarea with the requested
      // trigger so the picker opens its normal `^#…` / `^/…` query flow.
      ta.value = prefix;
      legacyTextarea.value = prefix;
      setValue(prefix);
      setPrependMode(false);
    } else if (startsWithTrigger) {
      // Already a `#…` / `/…` query — leave it; the picker will filter it.
      setPrependMode(false);
    } else {
      // Non-trivial input that isn't a trigger query: preserve the user's
      // message, open the picker in prepend mode. pickCommand will insert
      // the chosen command at the start with a separating space.
      setPrependMode(true);
    }
    chatUI.autoGrow(ta);
    setParticipantOpen(false);
    setCommandSelectedIdx(0);
    setCommandSurface(prefix);
    // Fresh session: drop any leftover expanded-group state from a prior
    // open so both pickers consistently start collapsed in the
    // hierarchical rest view.
    setExpandedGroup(null);
    setCommandOpen(true);
  }

  // Tie prependMode to the picker's open state — any close path (Escape,
  // outside click, picker dismissed via typing past the query, send) should
  // drop prepend state so the next open starts fresh.
  useEffect(() => {
    if (!commandOpen) setPrependMode(false);
  }, [commandOpen]);

  // What the picker sees as its query. In prepend mode the textarea holds
  // the user's draft message, but the picker must behave as if the query
  // were the bare trigger char (hierarchical rest view, full group list).
  const effectivePickerQuery = prependMode ? commandSurface : value;

  useEffect(() => {
    // Attach click handlers to the React-rendered #chat-send / #chat-cmd
    // buttons in place. We previously cloned and replaceWith'd these nodes —
    // that detached the React-managed DOM, so when ChatBarSlot or any
    // sibling later asked React to insert a fiber using the original button
    // as the "before" reference, the commit threw NotFoundError because the
    // node was no longer a child of its parent.
    //
    // Idempotence: dataset flag — if the button is later replaced (HMR /
    // chat.ts rebuilds the bar), the MutationObserver re-runs claim() and
    // sees a fresh button without the flag.
    function claim() {
      const sendBtn = document.getElementById('chat-send');
      if (sendBtn && sendBtn !== sendBtnRef.current) {
        const handler = () => { void sendViaLegacy(); };
        sendBtn.dataset.reactOwnedSend = '1';
        sendBtn.addEventListener('click', handler);
        sendBtnRef.current = sendBtn;
        sendHandlerRef.current = handler;
      }
      const cmdBtn = document.getElementById('chat-cmd');
      if (cmdBtn && cmdBtn !== cmdBtnRef.current) {
        const handler = (e: MouseEvent) => {
          e.preventDefault();
          taRef.current?.focus();
          openCommandPicker('#');
        };
        cmdBtn.dataset.reactOwnedCmd = '1';
        cmdBtn.addEventListener('mousedown', handler);
        cmdBtnRef.current = cmdBtn;
        cmdHandlerRef.current = handler;
      }
      const btwBtn = document.getElementById('chat-btw-insert');
      if (btwBtn && btwBtn !== btwBtnRef.current) {
        const handler = () => { void sendAsBtw(); };
        btwBtn.dataset.reactOwnedBtw = '1';
        btwBtn.addEventListener('click', handler);
        btwBtnRef.current = btwBtn;
        btwHandlerRef.current = handler;
      }
    }
    claim();
    // Observe only the chat input bar, not the full body — avoids firing on
    // every React DOM mutation (pet animations, message list updates, etc.).
    const obs = new MutationObserver(claim);
    const bar = document.getElementById('chat-input-bar') || document.querySelector('.chat-controls-area') || document.body;
    obs.observe(bar, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      if (sendBtnRef.current && sendHandlerRef.current) {
        sendBtnRef.current.removeEventListener('click', sendHandlerRef.current);
        delete sendBtnRef.current.dataset.reactOwnedSend;
      }
      if (cmdBtnRef.current && cmdHandlerRef.current) {
        cmdBtnRef.current.removeEventListener('mousedown', cmdHandlerRef.current);
        delete cmdBtnRef.current.dataset.reactOwnedCmd;
      }
      if (btwBtnRef.current && btwHandlerRef.current) {
        btwBtnRef.current.removeEventListener('click', btwHandlerRef.current);
        delete btwBtnRef.current.dataset.reactOwnedBtw;
      }
    };
  }, []);

  // Insert-into-flow visibility + title sync. Runs whenever the value, the
  // current session, or its streaming state changes. The button lives in
  // the DOM unconditionally (rendered by ChatView) — we just toggle its
  // display + swap a couple of titles so the user knows Enter no longer
  // means "interrupt". `display: none` here overrides the CSS default; we
  // null the style back when not eligible so the stylesheet wins again.
  useEffect(() => {
    const btn = document.getElementById('chat-btw-insert');
    const stopBtn = document.getElementById('chat-stop');
    const eligible = shouldInsertIntoFlow();
    if (btn) btn.style.display = eligible ? 'inline-flex' : '';
    if (stopBtn) {
      stopBtn.title = eligible
        ? 'Stop session (Enter inserts into running flow ⚡)'
        : 'Stop';
    }
    // No cleanup — next run overwrites. shouldInsertIntoFlow reads from
    // refs / closures captured at this effect's render, which is what we
    // want.
  }, [value, currentId, isStreaming]);

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = imageFilesFromClipboard(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void uploadPastedFiles(files);
  }

  async function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Inline-autocomplete: Tab accepts when a suggestion is showing and no
    // picker is open (the pickers consume Tab below). Esc dismisses.
    if (suggestion && !commandOpen && !participantOpen) {
      if (e.key === 'Tab') {
        e.preventDefault();
        const merged = acceptSuggestion();
        if (merged != null) {
          setValue(merged);
          setCaretAtEnd(true);
          requestAnimationFrame(() => {
            const ta = taRef.current;
            if (!ta) return;
            ta.focus();
            ta.setSelectionRange(merged.length, merged.length);
          });
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissSuggestion();
        return;
      }
    }

    if (participantOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setParticipantSelectedIdx((i) => Math.min(i + 1, Math.max(mentionMatches.length - 1, 0)));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setParticipantSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const picked = mentionMatches[participantSelectedIdx];
        if (picked) {
          e.preventDefault();
          pickParticipant(picked);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setParticipantOpen(false);
        return;
      }
    }

    if (commandOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCommandSelectedIdx((i) => i + 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCommandSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      // `/` surface — Enter resolves the currently selected row. On an item
      // row, run the command and clear the composer (so the user doesn't
      // accidentally send the literal `/layout zen` text). On a group row,
      // toggle expansion in place and keep the palette open.
      if (commandSurface === '/' && (e.key === 'Enter' || e.key === 'Tab')) {
        e.preventDefault();
        const row = findSelectedRow(effectivePickerQuery, commandSelectedIdx, expandedGroup);
        if (row?.kind === 'group') {
          setExpandedGroup(row.expanded ? null : row.group);
          return;
        }
        if (row?.kind === 'item') {
          runAppCommand(row.cmd, { closePalette: () => setCommandOpen(false) });
          setValue('');
          legacyTextarea.value = '';
          setCommandOpen(false);
        }
        return;
      }
      // `#` surface — Enter resolves the currently selected interactive
      // row. On a group/subgroup row, toggle expansion in place and keep
      // the picker open. On an item row, autocomplete the command; if
      // the value already exactly matches the command, send instead.
      if (e.key === 'Enter' || e.key === 'Tab') {
        const row = findSelectedPickerRow(
          effectivePickerQuery,
          commandSelectedIdx,
          expandedGroup,
          expandedSubgroup,
        );
        if (row?.kind === 'group') {
          e.preventDefault();
          setExpandedGroup(row.expanded ? null : row.group);
          return;
        }
        if (row?.kind === 'subgroup') {
          e.preventDefault();
          setExpandedSubgroup(row.expanded ? null : row.subgroup);
          return;
        }
        const picked = row?.kind === 'item' ? row.cmd : null;
        // Enter on an exact match = send, don't autocomplete. Otherwise the user
        // types "#note" + Enter and gets "#note " back instead of a sent command.
        if (e.key === 'Enter' && picked && !prependMode && value.trim() === picked.trim()) {
          e.preventDefault();
          setCommandOpen(false);
          await sendViaLegacy();
          return;
        }
        e.preventDefault();
        if (picked) {
          pickCommand(picked);
          return;
        }
        setCommandOpen(false);
        if (e.key !== 'Enter') return;
      }
      if (e.key === ' ') {
        // `/` surface — space is a normal separator inside the palette
        // query (`layout zen`, `theme ocean dark`). Don't dismiss the picker
        // here; the AppCommandPalette consumes spaces as part of the query.
        if (commandSurface === '/') return;
        // `#` surface — auto-pick the currently selected item so the user
        // can immediately type arguments after the command (`#note `,
        // `#bash `, …). On a group/subgroup row, expand it instead so
        // space drills further into the category. Bare `#` with nothing
        // selected → close.
        const row = findSelectedPickerRow(
          effectivePickerQuery,
          commandSelectedIdx,
          expandedGroup,
          expandedSubgroup,
        );
        if (row?.kind === 'group') {
          e.preventDefault();
          setExpandedGroup(row.expanded ? null : row.group);
          return;
        }
        if (row?.kind === 'subgroup') {
          e.preventDefault();
          setExpandedSubgroup(row.expanded ? null : row.subgroup);
          return;
        }
        if (row?.kind === 'item') {
          e.preventDefault();
          pickCommand(row.cmd);
        } else {
          setCommandOpen(false);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (value === '#' || value === '/' || value === '# ' || value === '/ ') setValue('');
        setCommandOpen(false);
        return;
      }
    }

    if (e.key === 'Enter' && (enterToSend ? !e.shiftKey : e.ctrlKey)) {
      e.preventDefault();
      // While a stream is live in this session and the composer has text,
      // route the send through #btw instead of starting a new turn. The
      // user explicitly asked for this: Enter should never interrupt while
      // streaming — it should inject into the running flow. The on-screen
      // #chat-btw-insert button is the visual cue that this is happening.
      if (shouldInsertIntoFlow()) {
        await sendAsBtw();
        return;
      }
      await sendViaLegacy();
      return;
    }

    if ((e.key === '#' || e.key === '/') && value.trim() === '') {
      requestAnimationFrame(() => openCommandPicker(e.key as '#' | '/'));
      return;
    }

    const currentIdx = useInputHistoryStore.getState().historyIdx;
    if (e.key === 'ArrowUp' && !commandOpen && !participantOpen && (value === '' || currentIdx >= 0) && inputHistoryList.length) {
      e.preventDefault();
      const nextIdx = Math.min(currentIdx + 1, inputHistoryList.length - 1);
      setInputHistoryIdx(nextIdx);
      setValue(inputHistoryList[nextIdx] || '');
      return;
    }

    if (e.key === 'ArrowDown' && !commandOpen && !participantOpen && currentIdx >= 0) {
      e.preventDefault();
      const nextIdx = currentIdx - 1;
      setInputHistoryIdx(nextIdx);
      setValue(nextIdx >= 0 ? inputHistoryList[nextIdx] || '' : '');
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const nextValue = e.target.value;
    setValue(nextValue);
    setInputHistoryIdx(-1);
    const caret = e.target.selectionStart ?? nextValue.length;
    setCaretAtEnd(caret >= nextValue.length);
    syncPickerState(nextValue, caret);
    // Signal bg.ts to pause WebGL shaders for 2s — cuts GPU ~40%→~0% during
    // typing bursts, reducing compositor pressure and improving INP.
    window.dispatchEvent(new Event('yha:user-typing'));
  }

  function syncPickerState(nextValue: string, selectionStart: number) {
    const before = nextValue.slice(0, selectionStart);
    const atMatch = before.match(/@([a-z0-9_-]*)$/i);
    if (atMatch && mentionMatches.length) {
      setCommandOpen(false);
      setParticipantOpen(true);
      setParticipantSelectedIdx(0);
      return;
    }

    // `/` surface accepts spaces inside the query (`/theme ocean dark`); `#`
    // surface treats whitespace as the end of the command, matching today's
    // chat-tool autocomplete behavior.
    const slashLive = /^\/(?:[^\n]*)?$/.test(nextValue);
    const hashLive  = /^#[^\s]*$/.test(nextValue);
    if ((slashLive || hashLive) && useInputHistoryStore.getState().historyIdx < 0) {
      setCommandSurface(nextValue.startsWith('/') ? '/' : '#');
      setParticipantOpen(false);
      setCommandOpen(true);
      setCommandSelectedIdx(0);
      return;
    }

    setParticipantOpen(false);
    setCommandOpen(false);
  }

  function mentionTokenForEmployee(emp: Employee): string {
    const preferred = String(emp.name || '').trim();
    if (/^[A-Za-z0-9_-]+$/.test(preferred)) return preferred;
    return String(emp.id || '').trim();
  }

  const invited = useMemo(
    () => new Set(sessionParticipants.map((id) => String(id || '').toLowerCase())),
    [sessionParticipants],
  );
  // Memoized so the selectionStart DOM read doesn't run on every re-render
  // (only when value changes). Previously this was an IIFE in the render body
  // that forced a synchronous DOM read on every keystroke AND on every other
  // state update (streaming chunks, mood changes, etc.).
  const mentionPartial = useMemo(() => {
    if (!participantOpen) return '';
    const before = value.slice(0, value.length);
    return before.match(/@([a-z0-9_-]*)$/i)?.[1]?.toLowerCase() || '';
  }, [value, participantOpen]);
  const mentionMatches = employees.filter((e) => {
    const eid = String(e.id || '').toLowerCase();
    const token = mentionTokenForEmployee(e).toLowerCase();
    return invited.has(eid) && (!mentionPartial || eid.includes(mentionPartial) || token.includes(mentionPartial) || String(e.name || '').toLowerCase().includes(mentionPartial));
  });

  function pickParticipant(emp: Employee) {
    const ta = taRef.current;
    if (!ta) return;
    const currentValue = ta.value;
    const cur = ta.selectionStart ?? currentValue.length;
    const before = currentValue.slice(0, cur);
    const after = currentValue.slice(cur);
    const atMatch = before.match(/@([a-z0-9_-]*)$/i);
    const token = mentionTokenForEmployee(emp);
    let nextValue = currentValue;
    let nextPos = cur;
    if (atMatch) {
      const start = cur - atMatch[0].length;
      nextValue = currentValue.slice(0, start) + '@' + token + ' ' + after;
      nextPos = start + token.length + 2;
    }
    setValue(nextValue);
    setParticipantOpen(false);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(nextPos, nextPos);
    });
  }

  function pickCommand(cmd: string) {
    const ta = taRef.current;
    if (!ta) return;
    // Prepend mode (picker opened via toolbar button with existing text):
    // insert the command at the start with a separating space, preserving
    // whatever the user had typed. Caret lands right after the inserted
    // command + space so the user can either type arguments or End-key to
    // the original draft. Otherwise, the normal replace-and-arm behavior.
    const existing = ta.value;
    const nextValue = prependMode && existing && !existing.startsWith('#') && !existing.startsWith('/')
      ? `${cmd} ${existing}`
      : `${cmd} `;
    const caretPos = cmd.length + 1;
    setValue(nextValue);
    setCommandOpen(false);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(caretPos, caretPos);
    });
  }

  return (
    <>
      <textarea
        id="chat-ta"
        data-react-owned="1"
        ref={taRef}
        value={value}
        placeholder="Type # or / for a command, or just your message …"
        rows={3}
        onChange={handleChange}
        onClick={(e) => {
          const caret = e.currentTarget.selectionStart ?? value.length;
          setCaretAtEnd(caret >= value.length);
          syncPickerState(value, caret);
        }}
        onKeyUp={(e) => {
          // Only re-sync on cursor-movement keys; handleChange already handled
          // character input (calling it on every keyup doubled picker work).
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
            const caret = e.currentTarget.selectionStart ?? valueRef.current.length;
            setCaretAtEnd(caret >= valueRef.current.length);
            syncPickerState(valueRef.current, caret);
          }
        }}
        onKeyDown={(e) => {
          void handleKeyDown(e);
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onPaste={handlePaste}
      />
      <GhostOverlay textarea={taEl} value={value} suggestion={suggestion} />
      {commandSurface === '/' ? (
        <AppCommandPalette
          open={commandOpen}
          textarea={taRef.current}
          query={value}
          selectedIndex={commandSelectedIdx}
          onSelectedIndexChange={setCommandSelectedIdx}
          expandedGroup={expandedGroup}
          onExpandedGroupChange={setExpandedGroup}
          onClose={() => { setCommandOpen(false); setValue(''); legacyTextarea.value = ''; setExpandedGroup(null); }}
        />
      ) : (
        <CommandPicker
          open={commandOpen}
          textarea={taRef.current}
          query={effectivePickerQuery}
          selectedIndex={commandSelectedIdx}
          onSelectedIndexChange={setCommandSelectedIdx}
          expandedGroup={expandedGroup}
          onExpandedGroupChange={setExpandedGroup}
          expandedSubgroup={expandedSubgroup}
          onExpandedSubgroupChange={setExpandedSubgroup}
          onPick={pickCommand}
          onClose={() => { setCommandOpen(false); setExpandedGroup(null); setExpandedSubgroup(null); }}
        />
      )}
      <MentionPickerForDirectMsg
        open={participantOpen}
        textarea={taRef.current}
        employees={mentionMatches}
        selectedIndex={participantSelectedIdx}
        onSelectedIndexChange={setParticipantSelectedIdx}
        onPick={pickParticipant}
        onClose={() => setParticipantOpen(false)}
      />
    </>
  );
}

export function ChatInput() {
  const [mountState, setMountState] = useState<MountState | null>(null);
  const obsRef = useRef<MutationObserver | null>(null);
  const mountStateRef = useRef<MountState | null>(null);
  // Outlives ChatInputInner so unsent text survives layout switches. Inner
  // writes here on unmount and reads on the next mount.
  const carryoverRef = useRef<string>('');

  useEffect(() => { mountStateRef.current = mountState; }, [mountState]);

  useEffect(() => {
    // Permanent observer — must survive layout switches. When the user toggles
    // between full/messenger/zen, the layout component unmounts and takes
    // the legacy <textarea id="chat-ta"> + our portal container with it. We
    // detect that disconnect here, reset mountState to null (so React unmounts
    // ChatInputInner cleanly), and re-claim the new textarea the next layout
    // renders. The dataset.reactOwned guard prevents the React-rendered
    // textarea (which carries data-react-owned="1" from JSX) from being
    // re-hijacked, so the observer can safely stay live.
    function tick() {
      const current = mountStateRef.current;
      if (current && !current.legacyTextarea.isConnected) {
        // Stale mount — the layout that owned this textarea unmounted.
        // Drop the reference; the cleanup effect below runs and the next
        // tick claims the fresh textarea.
        setMountState(null);
        return;
      }
      if (current) return; // already mounted, nothing to do

      const legacyTextarea = document.getElementById('chat-ta');
      if (!(legacyTextarea instanceof HTMLTextAreaElement)) return;
      if (legacyTextarea.dataset['reactOwned'] === '1') return;

      legacyTextarea.dataset['reactOwned'] = '1';
      legacyTextarea.id = 'chat-ta-legacy';
      legacyTextarea.style.display = 'none';

      const container = document.createElement('div');
      container.id = 'chat-ta-react-root';
      legacyTextarea.insertAdjacentElement('beforebegin', container);
      setMountState({ container, legacyTextarea });
    }

    tick();
    obsRef.current = new MutationObserver(tick);
    obsRef.current.observe(document.body, { childList: true, subtree: true });
    return () => obsRef.current?.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (!mountState) return;
      // Only restore DOM if the nodes are still connected. After a layout
      // switch they're orphans and the restoration is a no-op (and the next
      // ChatView render will create fresh nodes anyway).
      if (mountState.container.isConnected) mountState.container.remove();
      if (mountState.legacyTextarea.isConnected) {
        mountState.legacyTextarea.id = 'chat-ta';
        mountState.legacyTextarea.style.display = '';
        delete mountState.legacyTextarea.dataset['reactOwned'];
      }
    };
  }, [mountState]);

  if (!mountState) return null;
  return createPortal(
    <ChatInputInner legacyTextarea={mountState.legacyTextarea} carryoverRef={carryoverRef} />,
    mountState.container,
  );
}
