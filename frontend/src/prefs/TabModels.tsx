import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api.js';
import { store } from '../store.js';
import { getAppState } from '../stores/index.js';
import { getHiddenModels } from './costs.js';
import { clearAllPresets, countPresets } from '../pickers/cap-presets.js';
import { MODEL_CATEGORIES, CATEGORY_LABELS, type ModelCategory } from '../models/categories.js';

type ModelRecord = Record<string, unknown>;

interface RemotePrice {
  id: string;
  name: string;
  input?: number | null;
  output?: number | null;
}

interface PriceMatch {
  localName: string;
  patchName: string;
  input?: number | null;
  output?: number | null;
  remoteName: string;
}

interface LiteLLMMatch {
  localName: string;
  litellmKey: string;
  changes: Record<string, { to: unknown }>;
}

const BOOL_CAPS = [
  'supports_vision',
  'supports_function_calling',
  'supports_reasoning',
  'supports_prompt_caching',
  'supports_system_messages',
] as const;

function _normStr(s: unknown): string {
  return String(s || '')
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/[.\-_\s]/g, '');
}

function _matchLlmPrices(
  localModels: { name: string; type?: string; configKey?: string }[],
  remotePrices: RemotePrice[]
): PriceMatch[] {
  const remoteNorm = remotePrices.map((r) => ({
    ...r,
    _nid: _normStr(r.id),
    _nname: _normStr(r.name),
  }));
  const matches: PriceMatch[] = [];
  const seenPatch = new Set<string>();
  for (const m of localModels) {
    if (m.type === 'image' || m.type === 'video') continue;
    const patchName: string = m.configKey as string || m.name;
    if (seenPatch.has(patchName)) continue;
    const nlocal = _normStr(patchName);
    const hit = remoteNorm.find((r) => r._nid === nlocal || r._nname === nlocal);
    if (hit) {
      matches.push({ localName: m.name, patchName, input: hit.input, output: hit.output, remoteName: hit.name });
      seenPatch.add(patchName);
    }
  }
  return matches;
}

function _buildPricingPayload(all: ModelRecord[]): ModelRecord[] {
  return all.map((m) => {
    const entry: ModelRecord = { name: m.name, provider: m.provider, type: m.type || 'llm' };
    if (m.type === 'image') {
      entry.price_per_image = m.price_per_image ?? null;
    } else if (m.type === 'video') {
      entry.price_per_second = m.price_per_second ?? null;
    } else {
      entry.price_input = m.price_input ?? null;
      entry.price_output = m.price_output ?? null;
      entry.context_length = m.context_length ?? null;
      entry.vision = m.vision ?? null;
      entry.reasoning = m.reasoning ?? null;
      entry.tools = m.tools ?? null;
    }
    return entry;
  });
}

function _buildUpdatePrompt(payload: unknown[]): string {
  return `Search the web for the current API capabilities and pricing for each of the following AI models, then return ONLY a valid JSON array — no explanation, no markdown fences, just raw JSON.
Rules:
- price_input / price_output → USD per 1,000,000 tokens (e.g. 3.00 = $3/M tokens)
- price_per_image → USD per generated image
- price_per_second → USD per second of generated video
- context_length → maximum context window in raw tokens (e.g. 128000 for 128k)
- vision → true if the model accepts image inputs, false otherwise
- reasoning → true if the model has built-in chain-of-thought / thinking / reasoning, false otherwise
- tools → true if the model supports function/tool calling, false otherwise
- If a model is unknown or a value is unavailable, leave it as null
- Keep every object exactly as-is; only fill in the fields
Models JSON:
${JSON.stringify(payload, null, 2)}`;
}

function _getCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem('yha.collapsedProviders') || '[]') as string[]);
  } catch {
    return new Set();
  }
}

function _saveCollapsed(s: Set<string>): void {
  localStorage.setItem('yha.collapsedProviders', JSON.stringify([...s]));
}

type IoMode =
  | { type: 'none' }
  | { type: 'prompt'; text: string }
  | { type: 'llmprices'; matches: PriceMatch[]; unmatchedCount: number }
  | { type: 'litellm'; matches: LiteLLMMatch[] }
  | { type: 'import' };

function PromptIo({ text, onClose }: { text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.getElementById('prefs-gen-textarea') as HTMLTextAreaElement | null;
      if (ta) { ta.select(); document.execCommand('copy'); }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }
  void onClose;
  return (
    <div style={{ position: 'relative' }}>
      <textarea
        id="prefs-gen-textarea"
        className="prefs-input"
        rows={10}
        readOnly
        style={{ width: '100%', resize: 'vertical', fontSize: 11.5, fontFamily: 'var(--font-mono)', boxSizing: 'border-box', whiteSpace: 'pre' }}
        value={text}
      />
      <button
        className="prefs-btn"
        style={{ position: 'absolute', top: 6, right: 6, fontSize: 11, padding: '4px 9px' }}
        onClick={() => { void handleCopy(); }}
      >{copied ? 'Copied ✓' : 'Copy'}</button>
    </div>
  );
}

function LlmPricesIo({
  matches,
  unmatchedCount,
  onCancel,
  onApplied,
  importStatus,
  setImportStatus,
}: {
  matches: PriceMatch[];
  unmatchedCount: number;
  onCancel: () => void;
  onApplied: () => void;
  importStatus: string;
  setImportStatus: (s: string) => void;
}) {
  async function handleApply() {
    let ok = 0, fail = 0, skipped = 0;
    for (const { patchName, input, output } of matches) {
      for (const [field, val] of [['price_input', input], ['price_output', output]] as [string, number | null | undefined][]) {
        if (val == null) continue;
        try {
          const r = await fetch(api.config.baseUrl + '/v1/config/pricing', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: patchName, [field]: parseFloat(String(val)) }),
          });
          const d = await r.json().catch(() => ({})) as { skipped?: boolean; success?: boolean };
          if (d.skipped) skipped++;
          else if (r.ok && d.success) ok++;
          else fail++;
        } catch { fail++; }
      }
    }
    (getAppState() as unknown as Record<string, unknown>).models = null;
    setImportStatus(`✓ Applied ${ok} value${ok !== 1 ? 's' : ''} from llm-prices.com${skipped ? ` (${skipped} skipped)` : ''}${fail ? `, ${fail} failed` : ''}`);
    setTimeout(() => setImportStatus(''), 5000);
    onApplied();
  }
  void importStatus;
  const fmtPrice = (v: unknown) => (v == null ? '—' : String(v));
  return (
    <>
      <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 8 }}>
        <table className="prefs-table">
          <thead><tr><th>Local model</th><th>Matched to</th><th>$/M in</th><th>$/M out</th></tr></thead>
          <tbody>
            {matches.map((x) => (
              <tr key={x.patchName}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{x.patchName !== x.localName ? `${x.patchName} (${x.localName})` : x.localName}</td>
                <td className="dim" style={{ fontSize: 11 }}>{x.remoteName}</td>
                <td className="cost-val">{fmtPrice(x.input)}</td>
                <td className="cost-val">{fmtPrice(x.output)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--fg-dim)', marginBottom: 8 }}>
        {unmatchedCount ? `${unmatchedCount} model${unmatchedCount !== 1 ? 's' : ''} had no match and will be skipped.` : 'All LLM models matched.'}
      </div>
      <div className="prefs-row">
        <button className="prefs-btn" onClick={() => { void handleApply(); }}>Apply {matches.length} match{matches.length !== 1 ? 'es' : ''}</button>
        <button className="prefs-btn" style={{ opacity: .6 }} onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

function LiteLLMIo({
  matches,
  onCancel,
  onApplied,
  setImportStatus,
}: {
  matches: LiteLLMMatch[];
  onCancel: () => void;
  onApplied: () => void;
  setImportStatus: (s: string) => void;
}) {
  const fmtPrice = (v: unknown) => (v == null ? '—' : String(v));
  async function handleApply() {
    let ok = 0, fail = 0;
    for (const { localName, changes } of matches) {
      const body: Record<string, unknown> = { model: localName };
      for (const [field, { to }] of Object.entries(changes)) { body[field] = to; }
      try {
        const r = await fetch(api.config.baseUrl + '/v1/config/pricing', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({})) as { success?: boolean };
        if (r.ok && d.success) ok++; else fail++;
      } catch { fail++; }
    }
    (getAppState() as unknown as Record<string, unknown>).models = null;
    setImportStatus(`✓ Applied ${ok} model update${ok !== 1 ? 's' : ''} from LiteLLM${fail ? ` (${fail} failed)` : ''}`);
    setTimeout(() => setImportStatus(''), 5000);
    onApplied();
  }
  return (
    <>
      <div style={{ maxHeight: 240, overflowY: 'auto', marginBottom: 8 }}>
        <table className="prefs-table">
          <thead><tr><th>Model</th><th>LiteLLM key</th><th>$/M in</th><th>$/M out</th><th>ctx</th><th>caps</th></tr></thead>
          <tbody>
            {matches.map((x) => {
              const c = x.changes;
              const capChanges = BOOL_CAPS.filter((k) => c[k])
                .map((k) => `${k.replace('supports_', '')}: ${c[k].to ? '✓' : '✗'}`)
                .join(' · ');
              return (
                <tr key={x.localName}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{x.localName}</td>
                  <td className="dim" style={{ fontSize: 10, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.litellmKey}</td>
                  <td className="cost-val">{c.price_input ? fmtPrice(c.price_input.to) : '—'}</td>
                  <td className="cost-val">{c.price_output ? fmtPrice(c.price_output.to) : '—'}</td>
                  <td style={{ fontSize: 10, color: 'var(--fg-dim)' }}>{c.context_length ? Math.round((c.context_length.to as number) / 1000) + 'k' : '—'}</td>
                  <td style={{ fontSize: 10, color: 'var(--fg-dim)' }}>{capChanges || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 8 }}>
        Rule: LiteLLM value wins when present — existing data is kept when LiteLLM field is absent/zero.
      </div>
      <div className="prefs-row">
        <button className="prefs-btn" onClick={() => { void handleApply(); }}>Apply {matches.length} match{matches.length !== 1 ? 'es' : ''}</button>
        <button className="prefs-btn" style={{ opacity: .6 }} onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

function ImportIo({
  visibleNames,
  onCancel,
  onApplied,
  setImportStatus,
}: {
  visibleNames: Set<string>;
  onCancel: () => void;
  onApplied: () => void;
  setImportStatus: (s: string) => void;
}) {
  const [raw, setRaw] = useState('');
  async function handleApply() {
    let entries: ModelRecord[];
    try {
      entries = JSON.parse(raw || '') as ModelRecord[];
    } catch {
      setImportStatus('✖ Invalid JSON');
      return;
    }
    if (!Array.isArray(entries) || !entries.length) {
      setImportStatus('✖ Expected a JSON array');
      return;
    }
    let ok = 0, fail = 0, skipped = 0;
    const PRICE_FIELDS = ['price_input', 'price_output', 'price_per_image', 'price_per_second'];
    const CAP_MAP: Record<string, string> = {
      vision: 'supports_vision',
      reasoning: 'supports_reasoning',
      tools: 'supports_function_calling',
    };
    for (const entry of entries) {
      if (!entry.name || !visibleNames.has(entry.name as string)) continue;
      const body: Record<string, unknown> = { model: entry.name };
      let hasData = false;
      for (const field of PRICE_FIELDS) {
        if (entry[field] == null) continue;
        const val = parseFloat(String(entry[field]));
        if (!isNaN(val)) { body[field] = val; hasData = true; }
      }
      if (entry.context_length != null) {
        const val = parseInt(String(entry.context_length), 10);
        if (!isNaN(val) && val > 0) { body.context_length = val; hasData = true; }
      }
      for (const [key, capField] of Object.entries(CAP_MAP)) {
        if (entry[key] != null) { body[capField] = !!entry[key]; hasData = true; }
      }
      if (!hasData) continue;
      try {
        const r = await fetch(api.config.baseUrl + '/v1/config/pricing', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({})) as { skipped?: boolean; success?: boolean };
        if (d.skipped) skipped++;
        else if (r.ok && d.success) ok++;
        else fail++;
      } catch { fail++; }
    }
    (getAppState() as unknown as Record<string, unknown>).models = null;
    setImportStatus(`✓ Applied ${ok} value${ok !== 1 ? 's' : ''}${skipped ? ` (${skipped} skipped — not in config)` : ''}${fail ? `, ${fail} failed` : ''}`);
    setTimeout(() => setImportStatus(''), 4000);
    onApplied();
  }
  return (
    <>
      <textarea
        className="prefs-input"
        rows={8}
        style={{ width: '100%', resize: 'vertical', fontSize: 11.5, fontFamily: 'var(--font-mono)', boxSizing: 'border-box' }}
        placeholder="Paste the AI-returned JSON array here…"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <div className="prefs-row" style={{ marginTop: 6 }}>
        <button className="prefs-btn" onClick={() => { void handleApply(); }}>Apply All Values</button>
        <button className="prefs-btn" style={{ opacity: .6 }} onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

function ModelRow({
  m,
  hidden,
  onVisChange,
  onPriceSaved,
}: {
  m: ModelRecord;
  hidden: boolean;
  onVisChange: (name: string, visible: boolean) => void;
  onPriceSaved: () => void;
}) {
  const isImage = m.type === 'image';
  const isVideo = m.type === 'video';
  const isLlm = !isImage && !isVideo;
  const name = m.name as string;
  const priceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  async function patchPricing(field: string, val: number | string | null) {
    try {
      const r = await fetch(api.config.baseUrl + '/v1/config/pricing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, [field]: val }),
      });
      const d = await r.json().catch(() => ({})) as { success?: boolean; skipped?: boolean };
      (getAppState() as unknown as Record<string, unknown>).models = null;
      return d;
    } catch {
      return { success: false };
    }
  }

  async function handleCategoryChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    const payload = v === '__auto__' ? '' : v;
    const d = await patchPricing('userCategory', payload);
    if (d.success && !d.skipped) {
      e.target.classList.add('prefs-price-saved');
      setTimeout(() => e.target.classList.remove('prefs-price-saved'), 1200);
      onPriceSaved();
    } else if (d.skipped) {
      e.target.classList.add('prefs-price-skip');
      setTimeout(() => e.target.classList.remove('prefs-price-skip'), 2500);
    }
  }

  function handlePriceChange(e: React.ChangeEvent<HTMLInputElement>, field: string) {
    const rawVal = e.target.value.trim();
    let val: number | null = rawVal === '' ? null : parseFloat(rawVal);
    if (rawVal !== '' && val !== null && isNaN(val)) return;
    const el = e.target;
    if (priceTimers.current[field]) clearTimeout(priceTimers.current[field]);
    priceTimers.current[field] = setTimeout(async () => {
      let finalVal = val;
      if (field === 'context_length' && finalVal !== null) finalVal = Math.round(finalVal * 1000);
      const d = await patchPricing(field, finalVal);
      if (d.success && !d.skipped) {
        el.classList.add('prefs-price-saved');
        setTimeout(() => el.classList.remove('prefs-price-saved'), 1200);
        onPriceSaved();
      } else if (d.skipped) {
        el.classList.add('prefs-price-skip');
        el.title = 'Could not save — model unknown to any provider';
        setTimeout(() => el.classList.remove('prefs-price-skip'), 2500);
      }
    }, 0);
  }

  async function handleCapChange(e: React.ChangeEvent<HTMLInputElement>, cap: string) {
    const checked = e.target.checked;
    try {
      const r = await fetch(api.config.baseUrl + '/v1/config/pricing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, [cap]: checked }),
      });
      const d = await r.json().catch(() => ({})) as { success?: boolean; skipped?: boolean };
      (getAppState() as unknown as Record<string, unknown>).models = null;
      if (!d.success || d.skipped) e.target.checked = !checked;
    } catch {
      e.target.checked = !checked;
    }
  }

  const ctxVal = m.context_length != null ? Math.round((m.context_length as number) / 1000) : '';
  const category = (m.category as string | undefined) || 'llm';
  const categoryAuto = (m.categoryAuto as string | undefined) || category;
  const categoryOverride = m.categoryOverride as string | undefined;
  const isOverridden = !!categoryOverride;
  const selectValue: string = isOverridden ? category : '__auto__';

  return (
    <div className="prefs-model-row">
      <label style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, gap: 4, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={!hidden}
          onChange={(e) => onVisChange(name, e.target.checked)}
        />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <select
          className={`prefs-cat-select${isOverridden ? ' overridden' : ''}`}
          value={selectValue}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { void handleCategoryChange(e); }}
          title={isOverridden ? `Override: ${category} (auto-detected: ${categoryAuto})` : `Auto-detected: ${categoryAuto}`}
        >
          <option value="__auto__">auto · {categoryAuto}</option>
          {MODEL_CATEGORIES.map((c: ModelCategory) => (
            <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
          ))}
        </select>
      </label>

      {isImage && (
        <span className="prefs-price-group">
          <label className="prefs-price-lbl">$/img</label>
          <input
            className="prefs-price-input"
            type="number"
            inputMode="decimal"
            step={0.001}
            min={0}
            defaultValue={m.price_per_image != null ? String(m.price_per_image) : ''}
            placeholder="—"
            onChange={(e) => handlePriceChange(e, 'price_per_image')}
          />
        </span>
      )}
      {isVideo && (
        <span className="prefs-price-group">
          <label className="prefs-price-lbl">$/sec</label>
          <input
            className="prefs-price-input"
            type="number"
            inputMode="decimal"
            step={0.001}
            min={0}
            defaultValue={m.price_per_second != null ? String(m.price_per_second) : ''}
            placeholder="—"
            onChange={(e) => handlePriceChange(e, 'price_per_second')}
          />
        </span>
      )}
      {isLlm && (
        <>
          <span className="prefs-price-group">
            <label className="prefs-price-lbl">in</label>
            <input
              className="prefs-price-input"
              type="number"
              inputMode="decimal"
              step={0.01}
              min={0}
              defaultValue={m.price_input != null ? String(m.price_input) : ''}
              placeholder="—"
              onChange={(e) => handlePriceChange(e, 'price_input')}
            />
            <label className="prefs-price-lbl">out</label>
            <input
              className="prefs-price-input"
              type="number"
              inputMode="decimal"
              step={0.01}
              min={0}
              defaultValue={m.price_output != null ? String(m.price_output) : ''}
              placeholder="—"
              onChange={(e) => handlePriceChange(e, 'price_output')}
            />
          </span>
          <span className="prefs-price-group">
            <label className="prefs-price-lbl">ctx k</label>
            <input
              className="prefs-price-input"
              type="number"
              inputMode="decimal"
              step={1}
              min={0}
              defaultValue={ctxVal !== '' ? String(ctxVal) : ''}
              placeholder="—"
              title="Context window in thousands of tokens (e.g. 200 = 200k tokens)"
              onChange={(e) => handlePriceChange(e, 'context_length')}
            />
          </span>
          <span className="prefs-caps-group">
            <label className="prefs-cap-item" title="Vision"><span>👁</span><input type="checkbox" defaultChecked={!!m.vision} onChange={(e) => { void handleCapChange(e, 'supports_vision'); }} /></label>
            <label className="prefs-cap-item" title="Thinking / reasoning"><span>🧠</span><input type="checkbox" defaultChecked={!!m.reasoning} onChange={(e) => { void handleCapChange(e, 'supports_reasoning'); }} /></label>
            <label className="prefs-cap-item" title="Tool calls"><span>🔧</span><input type="checkbox" defaultChecked={!!m.tools} onChange={(e) => { void handleCapChange(e, 'supports_function_calling'); }} /></label>
          </span>
        </>
      )}
    </div>
  );
}

function ProviderGroup({
  provider,
  models,
  hiddenModels,
  onVisChange,
  onPriceSaved,
}: {
  provider: string;
  models: ModelRecord[];
  hiddenModels: Set<string>;
  onVisChange: (name: string, visible: boolean) => void;
  onPriceSaved: () => void;
}) {
  const [collapsed, setCollapsed] = useState(() => _getCollapsed().has(provider));

  function toggle() {
    const c = _getCollapsed();
    if (c.has(provider)) c.delete(provider); else c.add(provider);
    _saveCollapsed(c);
    setCollapsed(c.has(provider));
  }

  return (
    <div className="prefs-model-group">
      <div className="prefs-model-group-hdr prefs-group-toggle" data-provider={provider} onClick={toggle} style={{ cursor: 'pointer' }}>
        <span className="prefs-group-caret">{collapsed ? '▶' : '▼'}</span>
        {provider}
        <span className="prefs-group-count dim">{models.length}</span>
      </div>
      {!collapsed && (
        <div className="prefs-group-body">
          {models.map((m) => (
            <ModelRow
              key={m.name as string}
              m={m}
              hidden={hiddenModels.has(m.name as string)}
              onVisChange={onVisChange}
              onPriceSaved={onPriceSaved}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TabModels() {
  const apiBase = api.config.baseUrl;
  const [allModels, setAllModels] = useState<ModelRecord[]>([]);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => getHiddenModels());
  const [importStatus, setImportStatus] = useState('');
  const [io, setIo] = useState<IoMode>({ type: 'none' });
  const [presetsCount, setPresetsCount] = useState(() => countPresets());
  const [presetsStatus, setPresetsStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const importStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function setStatusWithTimeout(text: string, ms = 4000) {
    setImportStatus(text);
    if (importStatusTimer.current) clearTimeout(importStatusTimer.current);
    if (text) {
      importStatusTimer.current = setTimeout(() => setImportStatus(''), ms);
    }
  }

  const loadModels = useCallback(async () => {
    try {
      const r = await fetch(apiBase + '/v1/models/');
      const d = (await r.json()) as { models?: ModelRecord[] };
      if (d.models) {
        (getAppState() as unknown as Record<string, unknown>).models = d.models;
        setAllModels(d.models);
      }
    } catch { }
    setLoading(false);

    try {
      const r = await fetch(apiBase + '/v1/config/');
      const d = (await r.json()) as { config?: { defaults?: Record<string, unknown> } };
      const mode = d.config?.defaults?.anthropicApiMode as string | undefined;
      if (mode) localStorage.setItem('yha.anthropicApiMode', mode);
    } catch { }
  }, [apiBase]);

  useEffect(() => { void loadModels(); }, [loadModels]);

  const byProvider: Record<string, ModelRecord[]> = {};
  for (const m of allModels) {
    const p = m.provider as string;
    if (!byProvider[p]) byProvider[p] = [];
    byProvider[p].push(m);
  }

  function getCollapsedProviders() {
    return _getCollapsed();
  }

  function visibleModels(): ModelRecord[] {
    const c = getCollapsedProviders();
    return allModels.filter((m) => !c.has(m.provider as string));
  }

  function handleVisChange(name: string, visible: boolean) {
    const h = getHiddenModels();
    if (visible) h.delete(name); else h.add(name);
    store.set('hiddenModels', [...h]);
    setHiddenModels(new Set(h));
  }

  function handlePriceSaved() {
    void loadModels();
  }

  async function handleResetPrices() {
    if (!confirm(`Clear pricing for all ${allModels.length} models? This cannot be undone.`)) return;
    let ok = 0, fail = 0;
    for (const m of allModels) {
      const fields =
        m.type === 'image'
          ? ['price_per_image']
          : m.type === 'video'
            ? ['price_per_second']
            : ['price_input', 'price_output'];
      for (const field of fields) {
        try {
          const r = await fetch(apiBase + '/v1/config/pricing', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m.name, [field]: null }),
          });
          if (r.ok) ok++; else fail++;
        } catch { fail++; }
      }
    }
    (getAppState() as unknown as Record<string, unknown>).models = null;
    setStatusWithTimeout(`✓ Reset ${ok} price${ok !== 1 ? 's' : ''}${fail ? ` (${fail} failed)` : ''}`);
    await loadModels();
  }

  async function handleLlmPrices() {
    setIo({ type: 'none' });
    setStatusWithTimeout('');
    let remotePrices: RemotePrice[];
    try {
      const r = await fetch('https://www.llm-prices.com/current-v1.json');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { prices?: unknown };
      remotePrices = d.prices as RemotePrice[];
      if (!Array.isArray(remotePrices)) throw new Error('Unexpected format');
    } catch (err) {
      setStatusWithTimeout(`✖ Fetch failed: ${(err as Error).message}`, 5000);
      return;
    }
    const matches = _matchLlmPrices(
      allModels as { name: string; type?: string; configKey?: string }[],
      remotePrices
    );
    const unmatchedCount = allModels.filter(
      (m) => m.type !== 'image' && m.type !== 'video' && !matches.find((x) => x.localName === (m.name as string))
    ).length;
    if (!matches.length) {
      setStatusWithTimeout('✖ No models matched', 4000);
      return;
    }
    setIo({ type: 'llmprices', matches, unmatchedCount });
  }

  async function handleLiteLLM() {
    setIo({ type: 'none' });
    let matches: LiteLLMMatch[];
    try {
      const r = await fetch(apiBase + '/v1/config/litellm-preview');
      const d = (await r.json()) as { success?: boolean; error?: string; total?: number; matches?: LiteLLMMatch[] };
      if (!r.ok || !d.success) throw new Error(d.error || `HTTP ${r.status}`);
      matches = d.matches!;
      setStatusWithTimeout(`LiteLLM: ${d.total!.toLocaleString()} models in source, ${matches.length} local matches found`, 6000);
    } catch (err) {
      setStatusWithTimeout(`✖ ${(err as Error).message}`, 5000);
      return;
    }
    if (!matches.length) {
      setStatusWithTimeout('✖ No matches found', 4000);
      return;
    }
    setIo({ type: 'litellm', matches });
  }

  function handleGenPrompt() {
    setIo({ type: 'prompt', text: _buildUpdatePrompt(_buildPricingPayload(visibleModels())) });
  }

  function handleGenMissing() {
    const missing = visibleModels().filter((m) => {
      if (m.type === 'image') return m.price_per_image == null;
      if (m.type === 'video') return m.price_per_second == null;
      return m.price_input == null || m.price_output == null;
    });
    if (!missing.length) {
      setStatusWithTimeout('✓ All visible models already have prices', 3000);
      return;
    }
    setIo({ type: 'prompt', text: _buildUpdatePrompt(_buildPricingPayload(missing)) });
  }

  const visibleNames = new Set(visibleModels().map((m) => m.name as string));

  return (
    <>
      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">
          Pricing updater <span className="dim" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}> — generate a prompt for an AI agent, then import its answer</span>
        </h4>
        <div className="prefs-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <button className="prefs-btn" onClick={handleGenPrompt}>✨ Generate Update Prompt</button>
          <button className="prefs-btn" onClick={handleGenMissing}>⚠ Generate Missing Only</button>
          <button className="prefs-btn" onClick={() => setIo({ type: 'import' })}>⬇ Import Values</button>
          <button className="prefs-btn" onClick={() => { void handleLlmPrices(); }}>🌐 From llm-prices.com</button>
          <button className="prefs-btn" onClick={() => { void handleLiteLLM(); }}>📦 From LiteLLM</button>
          <button className="prefs-btn-danger" onClick={() => { void handleResetPrices(); }}>✕ Reset All Prices</button>
          <span style={{ fontSize: 12, color: 'var(--fg-dim)', alignSelf: 'center' }}>{importStatus}</span>
        </div>
        {io.type !== 'none' && (
          <div style={{ marginBottom: 14 }}>
            {io.type === 'prompt' && <PromptIo text={io.text} onClose={() => setIo({ type: 'none' })} />}
            {io.type === 'llmprices' && (
              <LlmPricesIo
                matches={io.matches}
                unmatchedCount={io.unmatchedCount}
                onCancel={() => setIo({ type: 'none' })}
                onApplied={async () => { setIo({ type: 'none' }); await loadModels(); }}
                importStatus={importStatus}
                setImportStatus={setStatusWithTimeout}
              />
            )}
            {io.type === 'litellm' && (
              <LiteLLMIo
                matches={io.matches}
                onCancel={() => setIo({ type: 'none' })}
                onApplied={async () => { setIo({ type: 'none' }); await loadModels(); }}
                setImportStatus={setStatusWithTimeout}
              />
            )}
            {io.type === 'import' && (
              <ImportIo
                visibleNames={visibleNames}
                onCancel={() => setIo({ type: 'none' })}
                onApplied={async () => { setIo({ type: 'none' }); await loadModels(); }}
                setImportStatus={setStatusWithTimeout}
              />
            )}
          </div>
        )}
      </section>

      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">
          Capability presets <span className="dim" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}> — saved per (model + provider + harness) when you toggle the input-bar badges</span>
        </h4>
        <div className="prefs-row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <button className="prefs-btn-danger" onClick={() => {
            const n = presetsCount;
            if (!n) { setPresetsStatus('No presets to reset'); return; }
            if (!confirm(`Clear capability presets for all ${n} model${n === 1 ? '' : 's'}? Each model will fall back to its natural defaults until you toggle a badge again.`)) return;
            clearAllPresets();
            setPresetsCount(0);
            setPresetsStatus('0 presets saved — all reset');
          }}>✕ Reset Capability Presets</button>
          <span className="dim" style={{ fontSize: 12 }}>{presetsStatus || `${presetsCount} preset${presetsCount === 1 ? '' : 's'} saved`}</span>
        </div>
      </section>

      <section className="prefs-section" data-view="simple">
        <h4 className="prefs-sec">
          Model visibility <span className="dim" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}> — uncheck to hide from picker</span>
        </h4>
        {loading && <div className="prefs-loading">Loading models…</div>}
        {!loading && allModels.length === 0 && (
          <div className="dim" style={{ padding: '10px 0' }}>No models loaded — refresh the model list first.</div>
        )}
        {Object.entries(byProvider).map(([provider, models]) => (
          <ProviderGroup
            key={provider}
            provider={provider}
            models={models}
            hiddenModels={hiddenModels}
            onVisChange={handleVisChange}
            onPriceSaved={handlePriceSaved}
          />
        ))}
      </section>
    </>
  );
}
