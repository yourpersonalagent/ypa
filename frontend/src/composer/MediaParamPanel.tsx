// MediaParamPanel — declarative param strip rendered above the chat input
// when the composer is in image / audio / video mode.
//
// Inputs:
//   - composerMode  (from appStore)
//   - active model for that mode's category (from activeModelsStore)
//   - schema for (provider, model) (from mediaSchemaClient — cached)
//
// Outputs:
//   - appStore.mediaParams[mode] is kept in sync with widget state. The send
//     handler reads this map when dispatching to the media-gen meta-skill.
//
// If no schema matches the active model we still render the panel — just with
// only the "Enhance prompt" toggle and a small "no params" hint. The model
// will still be called via the meta-skill, just without structured params.

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore.js';
import type { ComposerMode, MediaParamValue } from '../stores/appStore.js';
import { useActiveModelsStore } from '../stores/activeModelsStore.js';
import { fetchSchema, type MediaSchema, type MediaField } from './mediaSchemaClient.js';

// composerMode -> active-model category. (chat doesn't render this panel.)
const MODE_TO_CATEGORY: Record<Exclude<ComposerMode, 'chat'>, string> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
};

export function MediaParamPanel() {
  const mode = useAppStore((s) => s.composerMode);
  const mediaParams = useAppStore((s) => s.mediaParams);
  const setMediaParam = useAppStore((s) => s.setMediaParam);
  const enhance = useAppStore((s) => s.composerEnhance);
  const setComposerEnhance = useAppStore((s) => s.setComposerEnhance);
  const setComposerMode = useAppStore((s) => s.setComposerMode);
  const byCategory = useActiveModelsStore((s) => s.byCategory);
  const loadActiveModels = useActiveModelsStore((s) => s.load);

  useEffect(() => {
    if (mode !== 'chat') void loadActiveModels();
  }, [mode, loadActiveModels]);

  const category = mode === 'chat' ? null : MODE_TO_CATEGORY[mode];
  const active = category ? byCategory[category] : null;

  const [schema, setSchema] = useState<MediaSchema | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) { setSchema(null); return; }
    let cancelled = false;
    setLoading(true);
    void fetchSchema(active.provider, active.model).then((s) => {
      if (cancelled) return;
      setSchema(s);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [active?.provider, active?.model]);

  // When the schema first lands, seed any missing param defaults into the
  // store so the send handler sees the values even if the user never touched
  // the widget. Existing values are preserved.
  useEffect(() => {
    if (!schema || mode === 'chat') return;
    const current = mediaParams[mode] || {};
    for (const f of schema.fields) {
      if (f.default === undefined) continue;
      if (current[f.key] !== undefined) continue;
      setMediaParam(mode, f.key, f.default as MediaParamValue);
    }
    // mediaParams intentionally not in deps — we only want to seed on schema
    // change, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, mode]);

  if (mode === 'chat') return null;

  const values = mediaParams[mode] || {};

  return (
    <div className={`media-param-panel mode-${mode}`} data-composer-mode={mode}>
      <div className="mpp-header">
        <span className="mpp-mode-label">{labelForMode(mode)}</span>
        {active ? (
          <span className="mpp-model" title={`${active.provider}: ${active.model}`}>
            {active.model} <span className="mpp-provider">[{active.provider}]</span>
          </span>
        ) : (
          <span className="mpp-model mpp-no-model">no {category} model selected</span>
        )}
        {schema?.deprecation ? (
          <span className="mpp-deprecation" title={schema.deprecation.message}>
            ⚠ deprecated {schema.deprecation.date}
          </span>
        ) : null}
        <button
          type="button"
          className={`mpp-enhance-btn${enhance ? ' active' : ''}`}
          onClick={() => setComposerEnhance(!enhance)}
          title={enhance ? 'Enhance prompt: on — meta-skill will rewrite your prompt for better results.' : 'Enhance prompt: off — prompt sent verbatim.'}
        >
          <span className="mpp-enhance-dot" />
          enhance
        </button>
        <button
          type="button"
          className="mpp-close-btn"
          onClick={() => setComposerMode('chat')}
          title="Close — back to chat mode"
          aria-label="Close media panel"
        >
          ×
        </button>
      </div>
      {loading ? (
        <div className="mpp-loading">loading schema…</div>
      ) : !active ? (
        <div className="mpp-hint">Pick a {category} model in the model picker (or Prefs → Models).</div>
      ) : !schema ? (
        <div className="mpp-hint">No declared params for this model — prompt-only.</div>
      ) : (
        <div className="mpp-fields">
          {schema.fields.map((f) => (
            <FieldWidget
              key={f.key}
              field={f}
              value={values[f.key] ?? (f.default as MediaParamValue | undefined) ?? null}
              onChange={(v) => setMediaParam(mode, f.key, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function labelForMode(mode: ComposerMode): string {
  switch (mode) {
    case 'image': return 'Image';
    case 'audio': return 'Audio';
    case 'video': return 'Video';
    default: return 'Chat';
  }
}

function FieldWidget({
  field, value, onChange,
}: {
  field: MediaField;
  value: MediaParamValue;
  onChange: (v: MediaParamValue) => void;
}) {
  const id = useMemo(() => `mpp-${field.key}-${Math.random().toString(36).slice(2, 8)}`, [field.key]);
  switch (field.widget) {
    case 'select':
      return (
        <label className="mpp-field" htmlFor={id} title={field.help}>
          <span className="mpp-label">{field.label}</span>
          <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
            {(field.values || []).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
      );
    case 'aspect-ratio':
      return (
        <div className="mpp-field mpp-aspect" title={field.help}>
          <span className="mpp-label">{field.label}</span>
          <div className="mpp-aspect-grid">
            {(field.values || []).map((opt) => {
              const active = String(value ?? '') === opt.value;
              return (
                <button
                  type="button"
                  key={opt.value}
                  className={`mpp-aspect-btn${active ? ' active' : ''}`}
                  onClick={() => onChange(opt.value)}
                  title={opt.label}
                  data-ratio={opt.value}
                >
                  <span className={`mpp-aspect-tile ratio-${opt.value.replace(':', '-')}`} />
                  <span className="mpp-aspect-name">{opt.value}</span>
                </button>
              );
            })}
          </div>
        </div>
      );
    case 'range': {
      const num = typeof value === 'number' ? value : Number(value ?? field.default ?? field.min ?? 0);
      return (
        <label className="mpp-field" htmlFor={id} title={field.help}>
          <span className="mpp-label">{field.label}</span>
          <span className="mpp-range-wrap">
            <input
              id={id}
              type="range"
              min={field.min ?? 0}
              max={field.max ?? 10}
              step={field.step ?? 1}
              value={num}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            <span className="mpp-range-value">{num}</span>
          </span>
        </label>
      );
    }
    case 'number':
      return (
        <label className="mpp-field" htmlFor={id} title={field.help}>
          <span className="mpp-label">{field.label}</span>
          <input
            id={id}
            type="number"
            min={field.min}
            max={field.max}
            step={field.step}
            value={value === null || value === undefined || value === false ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        </label>
      );
    case 'text':
      return (
        <label className="mpp-field" htmlFor={id} title={field.help}>
          <span className="mpp-label">{field.label}</span>
          <input
            id={id}
            type="text"
            value={value == null || value === false ? '' : String(value)}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
    case 'multiline':
      return (
        <label className="mpp-field mpp-multiline" htmlFor={id} title={field.help}>
          <span className="mpp-label">{field.label}</span>
          <textarea
            id={id}
            rows={2}
            value={value == null || value === false ? '' : String(value)}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
    case 'bool':
      return (
        <label className="mpp-field mpp-bool" htmlFor={id} title={field.help}>
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="mpp-label">{field.label}</span>
        </label>
      );
    default:
      return <span className="mpp-field mpp-unknown">unknown widget: {field.widget}</span>;
  }
}
