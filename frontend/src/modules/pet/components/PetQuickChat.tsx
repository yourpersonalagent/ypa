// PetQuickChat — Section in the pet menu for configuring the pet's independent
// background chat session with its own model + capability settings.
//
// Renders a compact control group inside the pet popover:
//
//   ─────────────────────────────────────────────────────
//   🐾 Pet Chat
//   [💬 Session name                                  ▾]
//   [🤖 Model name  [CHIP]] [👁] [◈] [⚙]
//   ─────────────────────────────────────────────────────
//
// State is stored in localStorage (separate from the main chat model + caps)
// so the pet can use a different model/configuration while the main session
// continues untouched.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore } from '../../../stores/index.js';
import { session } from '../../../session.js';
import { openModelPicker } from '../../../pickers/ModelPicker.js';
import type { UserCaps } from '../../../stores/index.js';
import { getPetConsoleActions } from '../store/petConsoleStore.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PetModel {
  id: number;
  name: string;
  provider: string;
}

// ── LocalStorage keys ─────────────────────────────────────────────────────────

const LS_SESSION_ID   = 'yha.pet.chat.sessionId';
const LS_SESSION_NAME = 'yha.pet.chat.sessionName';
const LS_MODEL        = 'yha.pet.chat.model';
const LS_CAPS         = 'yha.pet.chat.caps';
/** Mirrored from modules/pet/index.ts. Single source of truth lives there;
 *  duplicated here as a literal so this file doesn't pull an import cycle. */
const LS_VOICE_ROUTE  = 'yha.pet.chat.voiceRoute';

// ── Storage helpers ───────────────────────────────────────────────────────────

function lsGet<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(key) || 'null') as T; }
  catch { return null; }
}

function lsSet(key: string, val: unknown): void {
  if (val == null) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(val));
}

const DEFAULT_CAPS: UserCaps = { vision: true, reasoning: null, tools: 'on' };

// ── Provider chip helper (mirrors ModelBadge / ModelPicker) ──────────────────

function providerChipShort(provider: string | undefined): string {
  if (!provider) return '';
  if (/^Anthropic-SUB\d*$/.test(provider) || provider === 'Anthropic Subscription') return 'SUB';
  if (/^OpenAI-SUB\d*$/.test(provider) || provider === 'OpenAI Subscription') return 'SUB';
  if (provider === 'Anthropic' || provider === 'Anthropic API' || provider === 'OpenAI') return 'API';
  return '';
}

// ── Tools cycle (same as CapabilityBadges) ────────────────────────────────────

const TOOLS_CYCLE: Record<string, UserCaps['tools']> = {
  on: 'filter',
  filter: false,
  false: 'on',
};

// ── Mini session picker portal ────────────────────────────────────────────────

interface MiniPickerProps {
  anchor: DOMRect;
  currentPetSessionId: string | null;
  onSelect: (id: string, name: string) => void;
  onClose: () => void;
}

function PetSessionMiniPicker({ anchor, currentPetSessionId, onSelect, onClose }: MiniPickerProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const [creating, setCreating] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!overlayRef.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function createNewPetSession() {
    setCreating(true);
    try {
      const id = `s${Date.now()}`;
      const name = '🐾 Pet Chat';
      // PATCH creates the session on the server if it doesn't exist yet.
      // Same mechanism as session.createWithDir() in session.ts.
      await fetch(`/v1/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        credentials: 'include',
      });
      // Refresh the list so the new session appears immediately.
      await session?.fetchList?.();
      onSelect(id, name);
    } catch {
      setCreating(false);
    }
  }

  const style: React.CSSProperties = useMemo(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const width = 272;
    const left = Math.max(margin, Math.min(vw - width - margin, anchor.left));
    const top = Math.min(vh - 120 - margin, anchor.bottom + 4);
    const maxHeight = Math.max(120, vh - top - margin);
    return { position: 'fixed', left, top, width, maxHeight, overflowY: 'auto' };
  }, [anchor]);

  return createPortal(
    <div
      ref={overlayRef}
      className="popover pet-session-mini-picker"
      style={style}
      // Prevent the pet menu's own click-outside handler from firing while
      // this sub-popover is open.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pet-smp-head">
        <button
          className="ss-new-btn pet-smp-create-btn"
          disabled={creating}
          onClick={() => void createNewPetSession()}
        >
          {creating ? '⏳ Creating…' : '＋ New Pet Session'}
        </button>
      </div>
      <div className="popover-group">Sessions</div>
      <div className="pet-smp-list">
        {sessions.map((s) => {
          const sid = String(s.id);
          const isPetSession = sid === currentPetSessionId;
          return (
            <div
              key={sid}
              className={`ss-item${isPetSession ? ' current' : ''}`}
              onClick={() => onSelect(sid, s.name)}
            >
              <span className="ss-name">{s.name}</span>
              <span className="ss-meta">{s.messageCount ?? 0} msgs</span>
            </div>
          );
        })}
        {sessions.length === 0 && (
          <div style={{ padding: '8px 12px', color: 'var(--fg-mute)', fontSize: '12px' }}>
            No sessions yet — create a new one.
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ── Main exported component ───────────────────────────────────────────────────

export function PetQuickChatSection() {
  const [petSessionId,   setPetSessionId]   = useState<string | null>(() => localStorage.getItem(LS_SESSION_ID));
  const [petSessionName, setPetSessionName] = useState<string>(() => localStorage.getItem(LS_SESSION_NAME) || '');
  const [petModel,       setPetModel]       = useState<PetModel | null>(() => lsGet<PetModel>(LS_MODEL));
  const [petCaps,        setPetCaps]        = useState<UserCaps>(() => lsGet<UserCaps>(LS_CAPS) ?? DEFAULT_CAPS);
  const [voiceRoute,     setVoiceRoute]     = useState<boolean>(() => {
    try { return localStorage.getItem(LS_VOICE_ROUTE) !== 'off'; }
    catch { return true; }
  });
  const [pickerOpen,     setPickerOpen]     = useState(false);
  const [pickerAnchor,   setPickerAnchor]   = useState<DOMRect | null>(null);

  const sessionBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef   = useRef<HTMLButtonElement>(null);

  // Keep the pet session name in sync when the session list updates
  // (e.g. user renamed the session from the main session picker).
  const sessions = useSessionStore((s) => s.sessions);
  useEffect(() => {
    if (!petSessionId) return;
    const found = sessions.find((s) => String(s.id) === petSessionId);
    if (found && found.name !== petSessionName) {
      setPetSessionName(found.name);
      localStorage.setItem(LS_SESSION_NAME, found.name);
    }
  }, [sessions, petSessionId, petSessionName]);

  // ── Session picker ──────────────────────────────────────────────────────────

  function openSessionPicker() {
    const rect = sessionBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPickerAnchor(rect);
    setPickerOpen(true);
    // Ensure the session list is fresh when the picker opens.
    void session?.fetchList?.();
  }

  function onSessionPick(id: string, name: string) {
    setPetSessionId(id);
    setPetSessionName(name);
    localStorage.setItem(LS_SESSION_ID, id);
    localStorage.setItem(LS_SESSION_NAME, name);
    setPickerOpen(false);
  }

  // ── Model picker ────────────────────────────────────────────────────────────

  function openModelPickerForPet() {
    const btn = modelBtnRef.current;
    if (!btn) return;
    openModelPicker(btn, (m) => {
      const model: PetModel = { id: m.id, name: m.name, provider: m.provider };
      setPetModel(model);
      lsSet(LS_MODEL, model);
      // Push into the pet console store so /v1/pet-console/ask uses this
      // model on the next turn AND the bubble's status footer updates
      // immediately (instead of waiting for the next refreshStatus()).
      try {
        getPetConsoleActions().setPetModelOverride({
          id:       model.id,
          name:     model.name,
          provider: model.provider,
        });
      } catch { /* store not yet hydrated — non-fatal */ }
    });
  }

  // ── Capability toggles ──────────────────────────────────────────────────────

  function updateCaps(next: UserCaps) {
    setPetCaps(next);
    lsSet(LS_CAPS, next);
    // Mirror into the pet console store so the next /v1/pet-console/ask
    // forwards these caps to the bridge (and any future subscriber sees the
    // change without re-reading localStorage).
    try {
      getPetConsoleActions().setPetCapsOverride(next);
    } catch { /* store not yet hydrated — non-fatal */ }
  }

  function toggleVision() {
    updateCaps({ ...petCaps, vision: !petCaps.vision });
  }

  function toggleReasoning() {
    const cur = petCaps.reasoning;
    const nextR: UserCaps['reasoning'] =
      cur === 'enabled' ? 'disabled' : cur === 'disabled' ? null : 'enabled';
    updateCaps({ ...petCaps, reasoning: nextR });
  }

  function toggleTools() {
    const key = String(petCaps.tools);
    const nextT = TOOLS_CYCLE[key] !== undefined ? TOOLS_CYCLE[key] : 'on';
    updateCaps({ ...petCaps, tools: nextT });
  }

  function toggleVoiceRoute() {
    const next = !voiceRoute;
    setVoiceRoute(next);
    try { localStorage.setItem(LS_VOICE_ROUTE, next ? 'on' : 'off'); }
    catch { /* quota / private-mode — non-fatal */ }
  }

  // ── Derived display values ──────────────────────────────────────────────────

  const sessionLabel = petSessionId
    ? (petSessionName || petSessionId)
    : 'No session';

  const modelLabel = petModel?.name ?? 'Choose model';
  const modelChip  = providerChipShort(petModel?.provider);

  const reasoningState = petCaps.reasoning;
  const toolsState     = petCaps.tools;

  // ── Titles for cap badges ───────────────────────────────────────────────────

  const visionTitle =
    `Vision: ${petCaps.vision ? 'on (click to disable)' : 'off (click to enable)'}`;
  const reasoningTitle =
    reasoningState === 'enabled'  ? 'Reasoning: on (click → disable)' :
    reasoningState === 'disabled' ? 'Reasoning: disabled (click → default)' :
                                    'Reasoning: default (click → enable)';
  const toolsTitle =
    toolsState === 'on'     ? 'Tools: on (click → filter mode)' :
    toolsState === 'filter' ? 'Tools: filter mode (click → disable)' :
                              'Tools: off (click → enable)';

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="pet-menu-sep" />
      <div
        className="pet-quickchat-section"
        // Prevent clicks inside from bubbling to the parent popover's
        // click-outside handler and accidentally closing the menu.
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="pet-quickchat-label">🐾 Pet Chat</div>

        {/* ── Session row ── */}
        <button
          ref={sessionBtnRef}
          type="button"
          className="pet-quickchat-session-btn"
          title={
            petSessionId
              ? `Pet session: ${sessionLabel} — click to change`
              : 'No pet session — click to assign one'
          }
          onClick={openSessionPicker}
        >
          <span className="pet-qc-icon" aria-hidden="true">💬</span>
          <span className="pet-qc-label">{sessionLabel}</span>
          <span className="pet-qc-caret" aria-hidden="true">▾</span>
        </button>

        {/* ── Model + capability row ── */}
        <div className="pet-quickchat-model-row">
          <button
            ref={modelBtnRef}
            type="button"
            className="pet-quickchat-model-btn"
            title={
              petModel
                ? `Pet model: ${petModel.name}${petModel.provider ? ` (${petModel.provider})` : ''}`
                : 'No model — click to choose'
            }
            onClick={openModelPickerForPet}
          >
            <span className="pet-qc-icon" aria-hidden="true">🤖</span>
            <span className="pet-qc-label">{modelLabel}</span>
            {modelChip
              ? <span className="pet-qc-provider-chip">{modelChip}</span>
              : null}
          </button>

          <div className="pet-quickchat-caps">
            <button
              type="button"
              className={`pet-qc-cap${petCaps.vision ? ' cap-active' : ''}`}
              title={visionTitle}
              onClick={toggleVision}
            >
              👁
            </button>
            <button
              type="button"
              className={[
                'pet-qc-cap',
                reasoningState === 'enabled'  ? 'cap-active' : '',
                reasoningState === 'disabled' ? 'cap-filter' : '',
              ].filter(Boolean).join(' ')}
              title={reasoningTitle}
              onClick={toggleReasoning}
            >
              ◈
            </button>
            <button
              type="button"
              className={[
                'pet-qc-cap',
                toolsState === 'on'     ? 'cap-active' : '',
                toolsState === 'filter' ? 'cap-filter' : '',
              ].filter(Boolean).join(' ')}
              title={toolsTitle}
              onClick={toggleTools}
            >
              ⚙
            </button>
          </div>
        </div>

        {/* ── Voice-route opt-in row ──
            Off → voice mode talks to the currently open chat session (legacy).
            On  → voice mode routes through the pet's quick-chat lane (uses the
            pet's own model + session, speaker nameplate becomes the pet's
            name). Click on the pet then opens voice mode minimized next to
            the pet instead of the regular pet console bubble. */}
        <button
          type="button"
          className={`pet-quickchat-voice-route${voiceRoute ? ' is-on' : ''}`}
          title={voiceRoute
            ? 'Voice mode talks to the pet (click to disable)'
            : 'Voice mode talks to the pet (click to enable)'}
          onClick={toggleVoiceRoute}
        >
          <span className="pet-qc-icon" aria-hidden="true">🎙</span>
          <span className="pet-qc-label">Voice → Pet</span>
          <span className="pet-qc-voice-state">{voiceRoute ? 'on' : 'off'}</span>
        </button>
      </div>

      {pickerOpen && pickerAnchor && (
        <PetSessionMiniPicker
          anchor={pickerAnchor}
          currentPetSessionId={petSessionId}
          onSelect={onSessionPick}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
