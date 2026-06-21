// CapabilityBadges — reactive capability toggle buttons (vision / reasoning / tools).
// Portals into the existing .cap-group container created by chat.ts.
// Replaces the imperative updateCapBtns() function and its ad-hoc addEventListener calls.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../stores/index.js';
import type { UserCaps } from '../stores/index.js';
import { presetKey, savePreset } from './cap-presets.js';

const TOOLS_CYCLE: Record<string, UserCaps['tools']> = {
  on: 'filter',
  filter: false,
  false: 'on',
};

const TOOLS_TITLES: Record<string, string> = {
  on: 'Tools: all active (click for filter mode)',
  filter: 'Tools: filter mode active (click to disable)',
  false: 'Tools: off (click to enable)',
};

const REASONING_TITLES: Record<string, string> = {
  enabled: 'Reasoning: on (click to force off)',
  disabled: 'Reasoning: forced off (click for default)',
  null: 'Reasoning: provider default (click to force on)',
};

function CapabilityBadgesInner() {
  const modelCaps = useAppStore((s) => s.modelCaps);
  const caps = useAppStore((s) => s.caps);
  const setCaps = useAppStore((s) => s.setCaps);
  const currentModel = useAppStore((s) => s.currentModel);
  const harnessInstance = useAppStore((s) => s.harnessInstance);
  const codexInstance = useAppStore((s) => s.codexInstance);

  const visionSupported = modelCaps.vision;
  const visionEnabled = visionSupported && caps.vision;

  const reasoningSupported = modelCaps.reasoning;
  const reasoningState = reasoningSupported ? caps.reasoning : null;

  const toolsSupported = modelCaps.tools;
  const toolsState: UserCaps['tools'] = toolsSupported ? (caps.tools || false) : false;

  function persist(next: UserCaps) {
    const key = presetKey(currentModel, harnessInstance, codexInstance);
    savePreset(key, next, modelCaps);
  }

  function toggleVision() {
    if (!visionSupported) return;
    const next = { ...caps, vision: !caps.vision };
    setCaps({ vision: next.vision });
    persist(next);
  }

  function toggleReasoning() {
    if (!reasoningSupported) return;
    const cur = caps.reasoning;
    const nextR: UserCaps['reasoning'] = cur === 'enabled' ? 'disabled' : 'enabled';
    const next: UserCaps = { ...caps, reasoning: nextR };
    setCaps({ reasoning: nextR });
    persist(next);
  }

  function toggleTools() {
    if (!toolsSupported) return;
    const key = String(toolsState);
    const nextT = TOOLS_CYCLE[key] !== undefined ? TOOLS_CYCLE[key] : 'on';
    const next = { ...caps, tools: nextT };
    setCaps({ tools: nextT });
    persist(next);
    // Sync tool filter mode to server
    type AppWindow = { app?: { api?: { config?: { baseUrl?: string } } } };
    const baseUrl = (window as unknown as AppWindow).app?.api?.config?.baseUrl ?? '';
    if (toolsState === 'on' && nextT === 'filter') {
      fetch(`${baseUrl}/v1/config/`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaults: { tool_command_overwrite_enabled: true } }) }).catch(() => {});
    } else if (toolsState === 'filter' && nextT === false) {
      fetch(`${baseUrl}/v1/config/`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaults: { tool_command_overwrite_enabled: false } }) }).catch(() => {});
    }
  }

  return (
    <>
      <button
        id="cap-vision"
        className={`chat-bar-btn cap-btn${visionEnabled ? ' cap-active' : ''}`}
        title={visionSupported ? `Vision${visionEnabled ? ' (on — click to disable)' : ' (off — click to enable)'}` : ''}
        style={{ display: visionSupported ? '' : 'none' }}
        onClick={toggleVision}
      >
        👁
      </button>
      <button
        id="cap-reasoning"
        className={`chat-bar-btn cap-btn${reasoningState === 'enabled' ? ' cap-active' : ''}${reasoningState === 'disabled' ? ' cap-filter' : ''}`}
        title={reasoningSupported ? (REASONING_TITLES[String(reasoningState)] ?? REASONING_TITLES['null']) : ''}
        style={{ display: reasoningSupported ? '' : 'none' }}
        onClick={toggleReasoning}
      >
        ◈
      </button>
      <button
        id="cap-tools"
        className={`chat-bar-btn cap-btn${toolsState === 'on' ? ' cap-active' : ''}${toolsState === 'filter' ? ' cap-filter' : ''}`}
        title={toolsSupported ? (TOOLS_TITLES[String(toolsState)] || TOOLS_TITLES['false']) : ''}
        style={{ display: toolsSupported ? '' : 'none' }}
        onClick={toggleTools}
      >
        ⚙
      </button>
    </>
  );
}

export function CapabilityBadges() {
  const [container, setContainer] = useState<Element | null>(null);
  const obsRef = useRef<MutationObserver | null>(null);
  const containerRef = useRef<Element | null>(null);

  useEffect(() => {
    function find() {
      const el = document.querySelector('.cap-group');
      if (el && el !== containerRef.current) {
        el.innerHTML = '';
        containerRef.current = el;
        setContainer(el);
      }
    }
    find();
    obsRef.current = new MutationObserver(find);
    obsRef.current.observe(document.body, { childList: true, subtree: true });
    return () => obsRef.current?.disconnect();
  }, []);

  if (!container) return null;
  return createPortal(<CapabilityBadgesInner />, container);
}
