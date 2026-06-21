// ModelPicker — React popover for the chat-model-btn (and personnel form's
// model picker). Replaces pickers/model.ts (deleted). Owns the click on
// #chat-model-btn via data-react-owned. Also exposes openPickerImperatively
// so vanilla callers (e.g. PersonnelPanel's ModelInput) can request the same
// picker programmatically.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore, getAppState, getAppActions } from '../stores/index.js';
import { store } from '../store.js';
import { api } from '../api.js';
import { presetKey, loadPreset, naturalDefaults } from './cap-presets.js';
import { categoryBadge } from '../models/categories.js';
import { ComposerModeIcon, modeForCategory } from '../composer/modeIcons.js';
import type { ComposerMode } from '../stores/appStore.js';
import { useActiveModelsStore } from '../stores/activeModelsStore.js';

interface Model {
  id: number;
  name: string;
  provider?: string;
  type?: string;
  category?: string;
  vision?: boolean;
  reasoning?: boolean;
  tools?: boolean;
  context_length?: number;
  instanceLabel?: string;
  instanceIndex?: number;
}

type ModelGroup = {
  key: string;
  name: string;
  type: string;
  category: string;
  section: string;
  variants: Model[];
};

interface ActiveModelInfo {
  model?: string;
  provider?: string;
}

interface ActiveModels {
  llm: ActiveModelInfo;
  image: ActiveModelInfo;
  video: ActiveModelInfo;
  audio: ActiveModelInfo;
}

type ActiveModelKey = keyof ActiveModels;

type SelectCallback = (m: { id: number; name: string; type: string; provider: string }) => void;

type OpenDetail = {
  anchor: HTMLElement;
  onSelect?: SelectCallback;
};

// ── Small helpers ──────────────────────────────────────────────────────────

function modelType(provider: string | undefined): string {
  const p = (provider || '').toLowerCase();
  if (p.includes('image')) return 'image';
  if (p.includes('video')) return 'video';
  return 'llm';
}

function providerChipShort(provider: string | undefined): string {
  if (!provider) return '';
  const claudeSub = /^Anthropic-SUB(\d*)$/.exec(provider);
  if (claudeSub) return 'SUB' + (claudeSub[1] || '');
  if (provider === 'Anthropic Subscription') return 'SUB';
  const openaiSub = /^OpenAI-SUB(\d*)$/.exec(provider);
  if (openaiSub) return 'SUB' + (openaiSub[1] || '');
  if (provider === 'OpenAI Subscription') return 'SUB';
  const grokSub = /^Grok-SUB(\d*)$/.exec(provider);
  if (grokSub) return 'SUB' + (grokSub[1] || '');
  if (provider === 'Anthropic' || provider === 'Anthropic API' || provider === 'OpenAI') return 'API';
  return '';
}

function providerTooltip(m: Pick<Model, 'provider' | 'instanceLabel'>): string {
  const chip = providerChipShort(m.provider);
  if (!chip) return m.provider || '';
  if (m.instanceLabel) return `${chip} (${m.instanceLabel}) · ${m.provider}`;
  return `${chip} · ${m.provider || ''}`;
}

function variantBadgeLabel(m: Model): string {
  const p = m.provider || '';
  if (typeof m.instanceIndex === 'number' && /SUB/.test(p)) {
    return `sub${m.instanceIndex + 1}`;
  }
  if (p === 'Anthropic API' || p === 'Anthropic' || p === 'OpenAI') return 'API';
  const chip = providerChipShort(p);
  return chip ? chip.toLowerCase() : (p || '·').toLowerCase();
}

function sectionFor(variants: Model[]): string {
  const ps = variants.map((v) => v.provider || '');
  if (ps.length && ps.every((p) => /^Anthropic-SUB/.test(p))) return 'Claude Code';
  if (ps.some((p) => /^Anthropic/.test(p))) return 'Anthropic';
  if (ps.some((p) => /^OpenAI-SUB/.test(p))) return 'Codex';
  if (ps.length && ps.every((p) => /^Grok-SUB/.test(p))) return 'Grok Build';
  if (ps.some((p) => /^Grok/.test(p))) return 'Grok';
  return ps[0] || 'unknown';
}

function groupModels(models: Model[]): ModelGroup[] {
  const map = new Map<string, ModelGroup>();
  const order: string[] = [];
  for (const m of models) {
    const t = m.type ?? 'llm';
    const c = m.category ?? t;
    const k = `${t}::${m.name}`;
    let g = map.get(k);
    if (!g) {
      g = { key: k, name: m.name, type: t, category: c, section: '', variants: [] };
      map.set(k, g);
      order.push(k);
    }
    g.variants.push(m);
  }
  for (const g of map.values()) {
    g.variants.sort((a, b) => {
      const aSub = typeof a.instanceIndex === 'number' && /SUB/.test(a.provider || '');
      const bSub = typeof b.instanceIndex === 'number' && /SUB/.test(b.provider || '');
      if (aSub !== bSub) return aSub ? 1 : -1;
      return (a.instanceIndex ?? 0) - (b.instanceIndex ?? 0);
    });
    g.section = sectionFor(g.variants);
  }
  return order.map((k) => map.get(k)!);
}

function lsRead(key: string): ActiveModelInfo {
  try {
    return (JSON.parse(localStorage.getItem(key) || 'null') as ActiveModelInfo) || {};
  } catch {
    return {};
  }
}

function applyModelCaps(caps: Record<string, boolean>, _fromInit: boolean): void {
  const state = getAppState();
  const actions = getAppActions();
  const newModelCaps = {
    vision: !!caps.vision,
    reasoning: !!caps.reasoning,
    tools: !!caps.tools,
  };
  actions.setModelCaps(newModelCaps);

  // Per-model preset takes precedence; otherwise natural defaults flow through
  // (everything the model supports is on, nothing persisted).
  const key = presetKey(state.currentModel, state.harnessInstance, state.codexInstance);
  const preset = loadPreset(key);
  if (preset) {
    actions.setCaps({
      vision: !!caps.vision && !!preset.vision,
      reasoning: caps.reasoning
        ? preset.reasoning === 'disabled'
          ? 'disabled'
          : 'enabled'
        : null,
      tools: caps.tools
        ? preset.tools === 'filter'
          ? 'filter'
          : preset.tools
            ? 'on'
            : false
        : false,
    });
  } else {
    actions.setCaps(naturalDefaults(newModelCaps));
  }
}

// ── Imperative open API for vanilla callers (PersonnelPanel, etc.) ─────────

export function openModelPicker(anchor: HTMLElement, onSelect?: SelectCallback): void {
  window.dispatchEvent(
    new CustomEvent<OpenDetail>('yha:open-model-picker', { detail: { anchor, onSelect } }),
  );
}

// Backwards-compat shim for code still importing { models } from './model'.
// Routes everything through the React component via the custom event.
export const models = {
  openPicker(btn: HTMLElement, onSelect?: SelectCallback): void {
    openModelPicker(btn, onSelect);
  },
  setCurrent(_m: unknown, _opts?: unknown): void {
    // setCurrent is now driven by the picker itself; legacy callers can ignore.
    void _m; void _opts;
  },
  close(): void {
    window.dispatchEvent(new CustomEvent('yha:close-model-picker'));
  },
};

// ── Card sub-components ────────────────────────────────────────────────────

function ActiveCard({
  kind,
  mode,
  label,
  data,
  active,
  onToggle,
}: {
  kind: string;
  mode: ComposerMode;
  label: string;
  data: ActiveModelInfo;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`ms-active-card ms-active-filter ${kind}${active ? ' active' : ''}`}
      title={active ? `${label} · click to clear filter` : `${label} · click to show only ${label} models`}
      aria-pressed={active}
      onClick={onToggle}
    >
      <span className="ms-active-icon" aria-hidden>
        <ComposerModeIcon mode={mode} size={14} />
      </span>
      <span className="ms-active-text">
        <span className="ms-name">{data?.model || '—'}</span>
        <span className="dim">{data?.provider || ''}</span>
      </span>
    </button>
  );
}

function ModelGroupCard({
  group,
  isFav,
  currentVariantId,
  onPickVariant,
  onToggleFav,
}: {
  group: ModelGroup;
  isFav: boolean;
  currentVariantId: number | undefined;
  onPickVariant: (m: Model) => void;
  onToggleFav: () => void;
}) {
  const rep = group.variants[0];
  const badge = categoryBadge(group.category);
  const typeBadge = badge
    ? <span className={`ms-chip-badge ${badge.bucket}`}>{badge.label}</span>
    : null;
  const ctx = rep.context_length
    ? rep.context_length >= 1000
      ? Math.round(rep.context_length / 1000) + 'k'
      : String(rep.context_length)
    : '';
  const isCurrent = currentVariantId != null;
  const single = group.variants.length === 1;
  const onCardClick = single ? () => onPickVariant(group.variants[0]) : undefined;
  return (
    <div
      className={`popover-item ms-group-card${isCurrent ? ' current' : ''}${single ? ' ms-group-single' : ''}`}
      data-name={group.name}
      data-type={group.type}
      title={single ? providerTooltip(group.variants[0]) || group.name : group.name}
      onClick={onCardClick}
    >
      <div className="ms-card-top">
        <span className="ms-name">
          {typeBadge}
          {group.name}
        </span>
        {single && providerChipShort(rep.provider) && (
          <span className="ms-single-variant-chip" title={providerTooltip(rep)}>
            {variantBadgeLabel(rep)}
          </span>
        )}
        <button
          className={`ms-fav-btn${isFav ? ' active' : ''}`}
          title={isFav ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(e) => { e.stopPropagation(); onToggleFav(); }}
        >
          {isFav ? '★' : '☆'}
        </button>
      </div>
      <span className="dim">
        {ctx && <>{ctx}{' '}</>}
        <span className={`ms-cap${rep.vision ? '' : ' ms-cap-off'}`} title="Vision">👁</span>
        <span className={`ms-cap${rep.reasoning ? '' : ' ms-cap-off'}`} title="Reasoning">◈</span>
        <span className={`ms-cap${rep.tools ? '' : ' ms-cap-off'}`} title="Tool calls">⚙</span>
      </span>
      {!single && (
        <div className="ms-variant-row">
          {group.variants.map((v) => (
            <button
              key={v.id}
              className={`ms-variant-btn${v.id === currentVariantId ? ' active' : ''}`}
              title={providerTooltip(v) || variantBadgeLabel(v)}
              data-id={v.id}
              data-provider={v.provider || ''}
              onClick={(e) => { e.stopPropagation(); onPickVariant(v); }}
            >
              {variantBadgeLabel(v)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Picker content ─────────────────────────────────────────────────────────

function PickerContent({
  anchor,
  active,
  allModels,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  active: ActiveModels;
  allModels: Model[];
  onPick: (m: Model) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filterMode, setFilterMode] = useState<ComposerMode | null>(null);
  const [favs, setFavs] = useState<Set<string>>(() => {
    const stored = store.get('favoriteModels', []);
    return new Set(Array.isArray(stored) ? (stored as string[]) : []);
  });
  const [hidden] = useState<Set<string>>(() => {
    try {
      const stored = store.get('hiddenModels', []);
      return new Set(Array.isArray(stored) ? (stored as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const currentModel = useAppStore((s) => s.currentModel);

  function currentVariantIdForGroup(g: ModelGroup): number | undefined {
    if (g.type === 'llm' || !g.type) {
      if (!currentModel || currentModel.name !== g.name) return undefined;
      if (currentModel.provider) {
        const match = g.variants.find((v) => v.provider === currentModel.provider);
        return match?.id ?? g.variants[0]?.id;
      }
      return g.variants[0]?.id;
    }
    const a = active[g.type as ActiveModelKey];
    if (a?.model !== g.name) return undefined;
    if (a.provider) {
      const match = g.variants.find((v) => v.provider === a.provider);
      return match?.id ?? g.variants[0]?.id;
    }
    return g.variants[0]?.id;
  }

  function toggleFav(name: string) {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      store.set('favoriteModels', [...next]);
      return next;
    });
  }

  // Position relative to anchor; clamp maxHeight so the popover never extends
  // past the viewport edge (overrides the CSS 70vh fallback when space < 70vh).
  // Hidden-anchor fallback: Zen/Messenger layouts hide #chat-model-btn via
  // `display: none`, so the rect is all zeros — center on viewport instead
  // so palette / Alt+M opens stay visible.
  const style: React.CSSProperties = useMemo(() => {
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const gap = 6;
    const pw = Math.min(560, vw - 16);
    if (r.width === 0 && r.height === 0) {
      const left = Math.max(margin, (vw - pw) / 2);
      const top = Math.max(margin, vh * 0.15);
      const maxHeight = Math.max(120, vh - top - margin);
      return { position: 'fixed', width: pw, left, top, maxHeight };
    }
    const left = Math.max(margin, Math.min(vw - pw - margin, r.right - pw));
    const aboveHalf = r.bottom < vh / 2;
    if (aboveHalf) {
      const top = r.bottom + gap;
      const maxHeight = Math.max(120, vh - top - margin);
      return { position: 'fixed', width: pw, left, top, maxHeight };
    }
    const bottom = vh - r.top + gap;
    const maxHeight = Math.max(120, vh - bottom - margin);
    return { position: 'fixed', width: pw, left, bottom, maxHeight };
  }, [anchor]);

  // Close on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (popRef.current?.contains(e.target as Node)) return;
      if (e.target === anchor) return;
      onClose();
    }
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [anchor, onClose]);

  // Close on global Esc (dispatched by KeyboardShortcuts).
  useEffect(() => {
    window.addEventListener('yha:escape', onClose);
    return () => window.removeEventListener('yha:escape', onClose);
  }, [onClose]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Group variants (name + type) and bucket by section header.
  const groups = useMemo(
    () => groupModels(allModels.filter((m) => !hidden.has(m.name))),
    [allModels, hidden],
  );
  const sections = useMemo(() => {
    const bySec: Record<string, ModelGroup[]> = {};
    for (const g of groups) (bySec[g.section] ||= []).push(g);
    return bySec;
  }, [groups]);

  const favGroups = groups.filter((g) => favs.has(g.name));
  const hasFavs = favGroups.length > 0;
  const q = query.trim().toLowerCase();
  function matchesGroupQuery(g: ModelGroup): boolean {
    if (filterMode) {
      const groupMode = modeForCategory(g.category || g.type);
      if (groupMode !== filterMode) return false;
    }
    if (!q) return true;
    if (g.name.toLowerCase().includes(q)) return true;
    return g.variants.some((v) => (v.provider || '').toLowerCase().includes(q));
  }
  function toggleFilter(mode: ComposerMode) {
    setFilterMode((prev) => (prev === mode ? null : mode));
  }

  return (
    <div id="model-overlay" className="popover" ref={popRef} style={style}>
      <div className="ms-active-strip">
        <ActiveCard
          kind="llm" mode="chat" label="Chat"
          data={active.llm}
          active={filterMode === 'chat'}
          onToggle={() => toggleFilter('chat')}
        />
        <ActiveCard
          kind="img" mode="image" label="Image"
          data={active.image}
          active={filterMode === 'image'}
          onToggle={() => toggleFilter('image')}
        />
        <ActiveCard
          kind="vid" mode="video" label="Video"
          data={active.video}
          active={filterMode === 'video'}
          onToggle={() => toggleFilter('video')}
        />
        <ActiveCard
          kind="aud" mode="audio" label="Audio"
          data={active.audio}
          active={filterMode === 'audio'}
          onToggle={() => toggleFilter('audio')}
        />
      </div>
      <div className="ms-search-wrap">
        <input
          ref={searchRef}
          id="ms-search"
          className="ms-search-input"
          type="search"
          placeholder="Filter models…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="ms-scroll">
        {hasFavs && (
          <>
            <div className="popover-group ms-fav-header">★ Favorites</div>
            <div className="ms-grid ms-fav-grid">
              {favGroups.filter(matchesGroupQuery).map((g) => (
                <ModelGroupCard
                  key={`fav-${g.key}`}
                  group={g}
                  isFav
                  currentVariantId={currentVariantIdForGroup(g)}
                  onPickVariant={onPick}
                  onToggleFav={() => toggleFav(g.name)}
                />
              ))}
            </div>
          </>
        )}
        {Object.keys(sections).sort().map((sec) => {
          const visible = sections[sec].filter(matchesGroupQuery);
          if (!visible.length) return null;
          const isCollapsed = Object.prototype.hasOwnProperty.call(collapsed, sec)
            ? collapsed[sec]
            : hasFavs;
          return (
            <div
              key={sec}
              className="ms-provider-section"
              data-collapsed={isCollapsed ? 'true' : 'false'}
            >
              <button
                className="ms-collapse-btn ms-provider-toggle"
                data-collapsed={isCollapsed ? 'true' : 'false'}
                onClick={() => setCollapsed((s) => ({ ...s, [sec]: !isCollapsed }))}
              >
                <span className="ms-collapse-arrow">{isCollapsed ? '▶' : '▼'}</span> {sec}
              </button>
              {!isCollapsed && (
                <div className="ms-grid">
                  {visible.map((g) => (
                    <ModelGroupCard
                      key={`s-${g.key}`}
                      group={g}
                      isFav={favs.has(g.name)}
                      currentVariantId={currentVariantIdForGroup(g)}
                      onPickVariant={onPick}
                      onToggleFav={() => toggleFav(g.name)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {!Object.keys(sections).length && (
          <div className="popover-group">No models available</div>
        )}
      </div>
    </div>
  );
}

// ── Root component ─────────────────────────────────────────────────────────

export function ModelPicker() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [allModels, setAllModels] = useState<Model[]>([]);
  const [active, setActive] = useState<ActiveModels>(() => ({
    llm: {},
    image: lsRead('yha.active.image'),
    video: lsRead('yha.active.video'),
    audio: lsRead('yha.active.audio'),
  }));
  const onSelectRef = useRef<SelectCallback | null>(null);
  const currentModel = useAppStore((s) => s.currentModel);
  const composerMode = useAppStore((s) => s.composerMode);
  const initRanRef = useRef(false);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  // ── One-time hydration (parity with old models.init) ─────────────────────
  useEffect(() => {
    if (initRanRef.current) return;
    initRanRef.current = true;

    // Hydrate from server-prefs
    const last = store.get('model', null);
    if (last) {
      try {
        const m = typeof last === 'string' ? JSON.parse(last) : last;
        getAppActions().setCurrentModel(m as Model);
      } catch {}
    }

    loadAllModels().then((list) => {
      setAllModels(list);
      const cur = getAppState().currentModel;
      if (cur) {
        const b = document.getElementById('chat-model-btn');
        if (b) b.textContent = cur.name;
      }
      // applyModelCaps is driven by the effect below — fires once allModels and
      // currentModel are both ready, so we don't depend on the order of
      // setCurrentModel vs. /v1/models/ fetch resolution.
    });
  }, []);

  // Whenever currentModel or allModels changes, re-derive modelCaps from the
  // matching model entry. Fixes initial-paint glitches where modelCaps stayed
  // at defaults until the user manually switched models.
  useEffect(() => {
    if (!currentModel?.name || allModels.length === 0) return;
    const full =
      allModels.find(
        (x) =>
          x.name === currentModel.name &&
          (currentModel.provider ? x.provider === currentModel.provider : true),
      ) || allModels.find((x) => x.name === currentModel.name);
    if (!full) return;
    applyModelCaps(
      { vision: !!full.vision, reasoning: !!full.reasoning, tools: !!full.tools },
      true,
    );
  }, [currentModel, allModels]);

  const refreshModels = useCallback(async (): Promise<void> => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    refreshInFlightRef.current = (async () => {
      try {
        await fetch(api.config.baseUrl + '/v1/models/refresh', {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          mode: 'cors',
        });
      } catch {
        // Best-effort only — keep using the latest cached snapshot.
      } finally {
        refreshInFlightRef.current = null;
      }
    })();
    return refreshInFlightRef.current;
  }, []);

  const loadAllModels = useCallback(async (opts?: { refresh?: boolean }): Promise<Model[]> => {
    try {
      if (opts?.refresh) await refreshModels();
      const res = await fetch(api.config.baseUrl + '/v1/models/', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        mode: 'cors',
      });
      if (res.ok) {
        const data = (await res.json()) as { models?: Model[] };
        if (data.models?.length) {
          (getAppState() as unknown as Record<string, unknown>).models = data.models;
        }
      }
    } catch {
      await api.getAllModels();
    }
    const seen = new Set<string>();
    const list = (getAppState().models as Model[] | undefined ?? []).filter((m) => {
      const k = String(m.id);
      if (seen.has(k)) return false;
      seen.add(k);
      m.type = m.type || modelType(m.provider);
      return true;
    });
    return list;
  }, [refreshModels]);

  const loadActive = useCallback(async () => {
    try {
      const res = await fetch(api.config.baseUrl + '/v1/active-models/');
      if (!res.ok) return;
      const data = (await res.json()) as {
        success?: boolean;
        llm?: ActiveModelInfo;
        image?: ActiveModelInfo;
        video?: ActiveModelInfo;
        audio?: ActiveModelInfo;
      };
      if (!data || data.success === false) return;
      setActive((prev) => ({
        llm: data.llm ?? prev.llm,
        image: data.image?.model ? data.image : prev.image,
        video: data.video?.model ? data.video : prev.video,
        audio: data.audio?.model ? data.audio : prev.audio,
      }));
    } catch (e) {
      console.warn('active-models fetch failed', (e as Error).message);
    }
  }, []);

  // Sync chat-model-btn label: shows the active model for the current composer
  // mode (chat → LLM, image/audio/video → the slot in `active`). Falls back to
  // the LLM model name when a non-chat slot is empty so the button never goes
  // blank — picking a model in that mode populates the slot.
  useEffect(() => {
    const b = document.getElementById('chat-model-btn');
    if (!b) return;
    let label = '';
    let tooltip = '';
    if (composerMode === 'chat') {
      if (!currentModel) return;
      const chip = providerChipShort(currentModel.provider);
      label = chip ? `${currentModel.name} [${chip}]` : currentModel.name;
      tooltip = providerTooltip(currentModel) || currentModel.name;
    } else {
      const slot = active[composerMode as ActiveModelKey];
      if (slot?.model) {
        const chip = providerChipShort(slot.provider);
        label = chip ? `${slot.model} [${chip}]` : slot.model;
        tooltip = providerTooltip(slot) || slot.model;
      } else if (currentModel) {
        label = currentModel.name;
        tooltip = `No ${composerMode} model selected — click to pick one`;
      }
    }
    if (!label) return;
    b.textContent = label;
    b.title = tooltip;
  }, [currentModel, composerMode, active]);

  // Refresh active-models snapshot once on mount so the button label is
  // correct for image/audio/video modes even before the picker has been
  // opened. localStorage provides an immediate value; this updates from the
  // bridge if the cached value is stale.
  useEffect(() => {
    loadActive();
  }, [loadActive]);

  // ── Wire #chat-model-btn click ──────────────────────────────────────────
  useEffect(() => {
    function handleClick(e: Event) {
      const btn = e.currentTarget as HTMLElement;
      e.stopImmediatePropagation();
      onSelectRef.current = null;
      setAnchor(btn);
      loadAllModels({ refresh: true }).then(setAllModels);
      loadActive();
    }

    function wire() {
      const btn = document.getElementById('chat-model-btn');
      if (!btn || btn.dataset.reactOwned) return;
      btn.dataset.reactOwned = '1';
      btn.addEventListener('click', handleClick);
    }

    wire();
    const obs = new MutationObserver(wire);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      const btn = document.getElementById('chat-model-btn');
      if (btn) {
        btn.removeEventListener('click', handleClick);
        delete btn.dataset.reactOwned;
      }
    };
  }, [loadAllModels, loadActive]);

  // ── Imperative open + close events from external callers ──────────────
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<OpenDetail>).detail;
      if (!detail?.anchor) return;
      onSelectRef.current = detail.onSelect ?? null;
      setAnchor(detail.anchor);
      loadAllModels({ refresh: true }).then(setAllModels);
      loadActive();
    }
    function onClose() {
      setAnchor(null);
    }
    window.addEventListener('yha:open-model-picker', onOpen as EventListener);
    window.addEventListener('yha:close-model-picker', onClose);
    return () => {
      window.removeEventListener('yha:open-model-picker', onOpen as EventListener);
      window.removeEventListener('yha:close-model-picker', onClose);
    };
  }, [loadAllModels, loadActive]);

  useEffect(() => {
    if (!anchor) return;
    const id = window.setInterval(() => {
      loadAllModels({ refresh: true }).then(setAllModels).catch(() => {});
    }, 15000);
    return () => window.clearInterval(id);
  }, [anchor, loadAllModels]);

  function pick(m: Model) {
    const id = m.id;
    const name = m.name;
    const type = m.type ?? 'llm';
    const provider = m.provider ?? '';

    if (onSelectRef.current) {
      const cb = onSelectRef.current;
      setAnchor(null);
      onSelectRef.current = null;
      cb({ id, name, type, provider });
      return;
    }

    if (type === 'llm') {
      // Set current LLM model + apply caps
      getAppActions().setCurrentModel({ id, name, provider } as Model);
      store.set('model', { id, name, provider });
      const full = allModels.find((x) => x.name === name) || ({} as Model);
      const caps = { vision: !!full.vision, reasoning: !!full.reasoning, tools: !!full.tools };
      applyModelCaps(caps, false);
      setAnchor(null);
      setTimeout(async () => {
        try { await api.exec(`#m ${id}`); } catch (e) { console.warn((e as Error).message); }
        loadActive();
      }, 100);
    } else {
      const key = type as ActiveModelKey;
      setActive((prev) => ({ ...prev, [key]: { model: name, provider } }));
      useActiveModelsStore.getState().setForCategory(key, { model: name, provider });
      localStorage.setItem(`yha.active.${type}`, JSON.stringify({ model: name, provider }));
      fetch(api.config.baseUrl + '/v1/active-models/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [type]: { model: name, provider } }),
      }).catch(() => {});
      setAnchor(null);
    }
  }

  if (!anchor) return null;
  return createPortal(
    <PickerContent
      anchor={anchor}
      active={active}
      allModels={allModels}
      onPick={pick}
      onClose={() => setAnchor(null)}
    />,
    document.body,
  );
}
