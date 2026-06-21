// ChatView — renders the static DOM structure of the chat panel as JSX.
// chat.ts wires all event listeners after init() finds elements by ID;
// this component only provides the structure (no event handlers here).

import { useEffect, useRef, useState } from 'react';
import { ChatBarSlot } from '../host/slots/ChatBarSlot.js';
import { useBridgeModuleEnabledStrict } from '../host/bridge-modules.js';
import { chat } from '../chat.js';
import { useAppStore } from '../stores/appStore.js';
import { ComposerModeSwitcher } from '../composer/ComposerModeSwitcher.js';
import { MediaParamPanel } from '../composer/MediaParamPanel.js';

const HERO_SYNTH_LS_KEY = 'yha.heroSynth';

function CircleDotIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className="lucide lucide-circle-dot" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

function SpeakerOnIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function InsertIntoFlowIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <line x1="3" y1="5" x2="21" y2="5" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="3" y1="20" x2="21" y2="20" />
      <path d="M4 15 L17 15" />
      <polyline points="13 11 17 15 13 19" />
    </svg>
  );
}

function SpeakerOffIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </svg>
  );
}

export function ChatView() {
  const barRef = useRef<HTMLDivElement>(null);
  // The minimap container only renders when the chat-minimap module is on.
  // Without this gate, legacy chat-ui.ts:buildMinimap finds the empty <div>
  // by id and writes vanilla minimap content into it — so disabling the
  // module wouldn't actually hide the minimap.
  const minimapEnabled = useBridgeModuleEnabledStrict('chat-minimap');
  const composerMode = useAppStore((s) => s.composerMode);

  const [synthOn, setSynthOn] = useState<boolean>(() => {
    try { return localStorage.getItem(HERO_SYNTH_LS_KEY) !== 'off'; } catch { return true; }
  });
  useEffect(() => {
    const viewChat = document.getElementById('view-chat');
    if (!viewChat) return;
    viewChat.classList.toggle('synth-on', synthOn);
    viewChat.classList.toggle('synth-off', !synthOn);
    try { localStorage.setItem(HERO_SYNTH_LS_KEY, synthOn ? 'on' : 'off'); } catch { /* private mode */ }
  }, [synthOn]);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    // Hard-code the narrow layout via inline styles so CSS flex math can't fight us.
    // Below 480 px: left row (all left buttons nowrap) + right row (all right buttons
    // nowrap). Long-text buttons get an explicit max-width so they truncate instead of
    // pushing siblings off-screen. Above 480 px: restore everything to CSS defaults.
    const applyLayout = (narrow: boolean) => {
      bar.toggleAttribute('data-narrow', narrow);

      const s = (sel: string) => bar.querySelector<HTMLElement>(sel);
      const cbLeft    = s('.cb-left-rest');
      const cbRight   = s('.cb-right-rest');
      const sessionBtn = s('.session-sw-btn');
      const modelBtn   = s('.model-btn');

      if (narrow) {
        if (cbLeft)     { cbLeft.style.flexWrap = 'nowrap'; cbLeft.style.overflow = 'hidden'; }
        if (cbRight)    { cbRight.style.flexWrap = 'nowrap'; }
        // Cap the two wide text buttons so they shrink gracefully
        if (sessionBtn) {
          sessionBtn.style.maxWidth    = '110px';
          sessionBtn.style.minWidth    = '0';
          sessionBtn.style.overflow    = 'hidden';
          sessionBtn.style.textOverflow = 'ellipsis';
        }
        if (modelBtn) {
          modelBtn.style.maxWidth    = '110px';
          modelBtn.style.minWidth    = '0';
          modelBtn.style.overflow    = 'hidden';
          modelBtn.style.textOverflow = 'ellipsis';
        }
      } else {
        if (cbLeft)     { cbLeft.style.flexWrap = ''; cbLeft.style.overflow = ''; }
        if (cbRight)    { cbRight.style.flexWrap = ''; }
        if (sessionBtn) {
          sessionBtn.style.maxWidth = '';
          sessionBtn.style.minWidth = '';
          sessionBtn.style.overflow = '';
          sessionBtn.style.textOverflow = '';
        }
        if (modelBtn) {
          modelBtn.style.maxWidth = '';
          modelBtn.style.minWidth = '';
          modelBtn.style.overflow = '';
          modelBtn.style.textOverflow = '';
        }
      }
    };

    const ro = new ResizeObserver(entries => {
      applyLayout(entries[0].contentRect.width < 480);
    });
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // Sync send/stop visibility against the live stream state on every mount.
  // Layout switches unmount this whole subtree and remount it; the AppEffects
  // store→DOM bridge only fires when streamKey/streamState change, so without
  // this the freshly rendered buttons stay at their JSX defaults (send shown,
  // stop hidden) until the next stream event — meaning an active stream looks
  // idle right after a layout switch (the "play button frozen on" bug).
  useEffect(() => {
    try { chat?.updateStreamingUI?.(); } catch (_) { /* boot-order, no-op */ }
  }, []);

  return (
    <>
      <div className="chat-scroll-wrap">
        <div className="chat-scroll" id="chat-scroll" />
        {minimapEnabled && <div id="chat-minimap" aria-hidden="true" />}
        <button
          id="chat-scroll-btn"
          className="chat-scroll-btn"
          title="Scroll to bottom"
          style={{ display: 'none' }}
        >
          ↓
        </button>
      </div>

      <div className="chat-controls-area">
        <div className="chat-empty-hero" aria-hidden="true">
          <button
            type="button"
            className="hero-synth-toggle"
            aria-label={synthOn ? 'Disable hero synthesizer' : 'Enable hero synthesizer'}
            title={synthOn ? 'Synth on — click to mute' : 'Synth muted — click to enable'}
            aria-pressed={synthOn}
            // Stop the native pointerdown from bubbling into the hero's growl
            // listener (attached via addEventListener — React's onPointerDown
            // runs after the native bubble, so we must stop the native event).
            onPointerDown={(e) => { e.stopPropagation(); e.nativeEvent.stopPropagation(); }}
            onClick={() => setSynthOn(v => !v)}
          >
            {synthOn ? <SpeakerOnIcon /> : <SpeakerOffIcon />}
          </button>
          <h1 className="brand-hero-logo">
            <span className="brand-hero-block">█</span> YHA
          </h1>
        </div>

        <div className="chat-input-container">
          <div className="chat-input-wrapper">
            <div id="chat-participants" className="chat-participants" style={{ display: 'none' }} />
            <div id="chat-attachments" className="chat-attachments" style={{ display: 'none' }} />

            <MediaParamPanel />

            <div className="chat-ta-wrap">
              <textarea
                id="chat-ta"
                placeholder="Type # or / for a command, or just your message …"
                rows={3}
              />
            </div>

            <div className="chat-input-bar" ref={barRef} data-composer-mode={composerMode}>
              <div className="chat-bar-left">
                <button className="chat-bar-btn file-btn" id="chat-file" title="Files &amp; Folders [Alt+F]">
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6.5a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.4.6l1.4 1.4H17a2 2 0 0 1 2 2" />
                    <path d="M3 10a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6l1.4 1.4H19a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8Z" />
                  </svg>
                </button>

                <div className="cb-left-rest">
                  <span className="session-group" title="Sessions">
                    <button
                      className="chat-bar-btn session-sw-btn"
                      id="chat-session-btn"
                      title="Switch session [Alt+S]"
                    >
                      sessions
                    </button>
                    <button
                      className="chat-bar-btn session-btn"
                      id="chat-new-session"
                      title="New session [Alt+N] — hold for new session in same working directory"
                    >
                      +
                    </button>
                  </span>

                  {/* Notes / context button moved to the `context` module:
                      frontend/src/modules/context/ChatNotesButton.tsx — renders
                      via the ChatBarSlot below when the module is active. */}

                  <ChatBarSlot side="left" />

                  <button className="chat-bar-btn cmd-btn" id="chat-cmd" title="Commands (#)">#</button>
                </div>
              </div>

              <div className="chat-bar-right">
                <div className="cb-right-rest">
                  <ComposerModeSwitcher />

                  <span className="model-cap-group" title="Model &amp; per-model capabilities">
                    <button
                      className="chat-bar-btn model-btn"
                      id="chat-model-btn"
                      title="Select model [Alt+M]"
                    >
                      model
                    </button>
                    <span className="cap-group" />
                  </span>

                  <button className="chat-bar-btn sys-btn" id="chat-sys-btn" title="System prompt override">
                    <CircleDotIcon />
                  </button>

                  <span className="ef-inline-wrap">
                    <span className="ef-inline-label" id="ef-inline-label" />
                    <button className="ef-dot-btn" data-idx="0" title="Effort Level 1" />
                    <button className="ef-dot-btn" data-idx="1" title="Effort Level 2" />
                    <button className="ef-dot-btn" data-idx="2" title="Effort Level 3" />
                    <button className="ef-dot-btn" data-idx="3" title="Effort Level 4" />
                    <button className="ef-dot-btn" data-idx="4" title="Effort Level 5" />
                  </span>
                </div>

                <div className="cb-right-send">
                  {/* Insert-into-flow overlay button: only visible while a
                     stream is active in this session AND there is composer
                     text. ChatInput toggles display + wires the click; the
                     #btw chat-submit interceptor in chat-streaming.ts does
                     the actual /v1/sessions/:id/btw POST. */}
                  <button
                    className="chat-bar-btn"
                    id="chat-btw-insert"
                    title="Insert into running session (⚡ live) [Enter]"
                  >
                    <InsertIntoFlowIcon />
                  </button>
                  <button
                    className="chat-bar-btn stop-btn"
                    id="chat-stop"
                    title="Stop"
                    style={{ display: 'none' }}
                  >
                    ⏹
                  </button>
                  <button
                    className="chat-bar-btn send-btn"
                    id="chat-send"
                    title="Send [Enter]   (Shift+Enter for newline)"
                  >
                    ▶
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
