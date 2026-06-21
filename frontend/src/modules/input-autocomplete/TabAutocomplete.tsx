// Prefs tab for the input-autocomplete module.
//
// Self-registered (see ./index.ts). Reads/writes via the module's local
// configStore, which proxies GET/PATCH /v1/input-autocomplete/config.

import { useEffect, useRef } from 'react';
import { useAutocompleteConfig } from './configStore.js';

// Chat-mode recommendations — only instruct models that respond fast enough for
// the 6 s autocomplete timeout. On NVIDIA free tier, larger models (8B+) queue
// for 30–60 s and will always time out silently. Stick to nemotron-mini or use
// a paid/local provider for larger models.
const CHAT_MODELS = [
  { id: 'nvidia/nemotron-mini-4b-instruct',           size: '4B',  note: 'default · fastest · free tier' },
  { id: 'nvidia/llama-3.1-nemotron-nano-8b-v1',       size: '8B',  note: 'NVIDIA-tuned · may queue on free' },
  { id: 'meta/llama-3.1-8b-instruct',                 size: '8B',  note: 'general purpose · may queue on free' },
  { id: 'meta/llama-3.3-70b-instruct',                size: '70B', note: 'high quality · likely too slow on free' },
] as const;

// FIM-mode recommendations — base (non-instruct) models only; instruct variants
// have no /completions endpoint and will 404. starcoder2 uses the same FIM token
// format as codestral. Availability on NVIDIA NIM free tier varies.
const FIM_MODELS = [
  { id: 'bigcode/starcoder2-7b',           size: '7B',  note: 'fast · starcoder2 tokens' },
  { id: 'bigcode/starcoder2-15b',          size: '15B', note: 'smarter · starcoder2 tokens' },
  { id: 'mistralai/codestral-22b-v0.1',   size: '22B', note: 'best FIM quality · codestral tokens' },
] as const;

function ModelPill({ id, size, note, active, onClick }: {
  id: string; size: string; note: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      title={id}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        marginRight: 6,
        marginBottom: 5,
        borderRadius: 4,
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg2, var(--bg-card))',
        cursor: 'pointer',
        fontSize: '.77rem',
        color: 'var(--fg)',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ opacity: 0.55, fontWeight: 600 }}>{size}</span>
      <span style={{ fontFamily: 'monospace' }}>{id.split('/')[1]}</span>
      <span style={{ opacity: 0.45, fontSize: '.73rem' }}>· {note}</span>
    </button>
  );
}

export function TabAutocomplete() {
  const cfg = useAutocompleteConfig((s) => s.cfg);
  const loaded = useAutocompleteConfig((s) => s.loaded);
  const fetchCfg = useAutocompleteConfig((s) => s.fetch);
  const patchCfg = useAutocompleteConfig((s) => s.patch);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { if (!loaded) void fetchCfg(); }, [loaded, fetchCfg]);

  function debouncedPatch(p: Partial<typeof cfg>, ms = 500) {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => { void patchCfg(p); }, ms);
  }

  return (
    <>
      <section className="prefs-section" data-view="simple">
        <h4 className="prefs-sec">Inline autocomplete</h4>
        <div className="prefs-hint" style={{ marginBottom: 8 }}>
          When you pause typing in the chat input, a faded ghost completion
          appears inline. Press <code>Tab</code> to accept, keep typing or
          press <code>Esc</code> to dismiss. Uses a small / cheap model
          (free on NVIDIA tiers) and runs entirely through this bridge.
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            id="prefs-iac-enabled"
            checked={cfg.enabled}
            style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
            onChange={(e) => { void patchCfg({ enabled: e.target.checked }); }}
          />
          <label htmlFor="prefs-iac-enabled" style={{ fontSize: '.82rem', color: 'var(--fg-dim)' }}>
            Enable inline autocomplete in the chat input
          </label>
        </div>
      </section>

      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Model</h4>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 80 }}>Provider</label>
          <input
            className="prefs-input flex1"
            type="text"
            value={cfg.provider}
            placeholder="NVIDIA"
            onChange={(e) => debouncedPatch({ provider: e.target.value.trim() })}
          />
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 80 }}>Model</label>
          <input
            className="prefs-input flex1"
            type="text"
            value={cfg.model}
            placeholder="nvidia/nemotron-mini-4b-instruct"
            onChange={(e) => debouncedPatch({ model: e.target.value.trim() })}
          />
        </div>
        <div className="prefs-hint">
          Default ships with the same fast / free model the auto-titler uses.
          Any provider listed in the <code>API Keys</code> tab is valid here;
          set both fields to switch.
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 80 }}>Mode</label>
          <select
            className="prefs-input"
            value={cfg.completionMode}
            onChange={(e) => { void patchCfg({ completionMode: e.target.value as 'chat' | 'fim' }); }}
          >
            <option value="chat">Chat — instruct models (default)</option>
            <option value="fim">FIM — Fill-in-Middle, base/code models</option>
          </select>
        </div>
        <div className="prefs-hint">
          {cfg.completionMode === 'fim' ? (
            <>
              <strong>FIM</strong> wraps your text in special tokens
              ({' '}<code>{'<fim_prefix>…<fim_suffix><fim_middle>'}</code>){' '}
              that tell base/code models to predict what comes next. Gives
              cleaner raw continuations but only works with base models that
              have a <code>/completions</code> endpoint — see recommendations
              below. Instruct models silently fail here.
            </>
          ) : (
            <>
              <strong>Chat</strong> sends your text as a chat message to
              the <code>/chat/completions</code> endpoint. Works with any
              instruct or chat-tuned model. The model is told not to answer but
              to continue the text instead.
            </>
          )}
        </div>
      </section>

      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Model recommendations</h4>
        <div className="prefs-hint" style={{ marginBottom: 10 }}>
          Click any model to apply it (also switches mode automatically).{' '}
          <strong>Important:</strong> autocomplete has a 6 s timeout — on the
          NVIDIA free tier only <code>nemotron-mini-4b-instruct</code> responds
          reliably within that window. Larger models queue for 30–60 s and will
          silently time out. Use a paid tier or local provider for bigger models.
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '.77rem', color: 'var(--fg-dim)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
            Chat mode · instruct models
          </div>
          {CHAT_MODELS.map((m) => (
            <ModelPill
              key={m.id}
              {...m}
              active={cfg.model === m.id}
              onClick={() => void patchCfg({ model: m.id, completionMode: 'chat' })}
            />
          ))}
        </div>

        <div>
          <div style={{ fontSize: '.77rem', color: 'var(--fg-dim)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
            FIM mode · base/code models
          </div>
          {FIM_MODELS.map((m) => (
            <ModelPill
              key={m.id}
              {...m}
              active={cfg.model === m.id}
              onClick={() => void patchCfg({ model: m.id, completionMode: 'fim' })}
            />
          ))}
          <div className="prefs-hint" style={{ marginTop: 6 }}>
            FIM models use <code>{'<fim_prefix>'}</code> / <code>{'<fim_suffix>'}</code> /{' '}
            <code>{'<fim_middle>'}</code> tokens (starcoder2 / codestral format).
            The model predicts what goes after your cursor — with no text after the
            cursor it&apos;s a clean &quot;continue from here&quot;.
          </div>
        </div>
      </section>

      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Trigger &amp; output</h4>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 160 }} title="Idle time after whitespace / punctuation before a suggestion is requested">Boundary debounce (ms)</label>
          <input
            className="prefs-input"
            type="number"
            min={60}
            max={10000}
            step={50}
            value={cfg.debounceBoundaryMs}
            style={{ maxWidth: 120 }}
            onChange={(e) => debouncedPatch({ debounceBoundaryMs: Number(e.target.value) })}
          />
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 160 }} title="Idle time inside an unfinished word before a suggestion is requested">Mid-word debounce (ms)</label>
          <input
            className="prefs-input"
            type="number"
            min={60}
            max={10000}
            step={100}
            value={cfg.debounceMidwordMs}
            style={{ maxWidth: 120 }}
            onChange={(e) => debouncedPatch({ debounceMidwordMs: Number(e.target.value) })}
          />
        </div>
        <div className="prefs-hint">
          Two waits. <strong>Boundary</strong>: how long to pause after a
          space or punctuation before asking — short feels snappy.
          <strong> Mid-word</strong>: how long to pause inside an
          unfinished word before guessing — usually much longer so the
          model doesn&apos;t pelt the API while you&apos;re still typing.
          Set mid-word to a high value (e.g. <code>10000</code>) to
          effectively only fire at boundaries.
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 160 }}>Min chars</label>
          <input
            className="prefs-input"
            type="number"
            min={1}
            max={40}
            step={1}
            value={cfg.minChars}
            style={{ maxWidth: 120 }}
            onChange={(e) => debouncedPatch({ minChars: Number(e.target.value) })}
          />
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 160 }}>Max tokens</label>
          <input
            className="prefs-input"
            type="number"
            min={8}
            max={200}
            step={1}
            value={cfg.maxTokens}
            style={{ maxWidth: 120 }}
            onChange={(e) => debouncedPatch({ maxTokens: Number(e.target.value) })}
          />
          <label className="prefs-field-lbl" style={{ minWidth: 110, marginLeft: 12 }}>Temperature</label>
          <input
            className="prefs-input"
            type="number"
            min={0}
            max={2}
            step={0.05}
            value={cfg.temperature}
            style={{ maxWidth: 90 }}
            onChange={(e) => debouncedPatch({ temperature: Number(e.target.value) })}
          />
        </div>
      </section>

      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Conversation context</h4>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 140 }} title="Tail of the previous turn sent with each request, in characters">History chars</label>
          <input
            className="prefs-input"
            type="number"
            min={0}
            max={4000}
            step={50}
            value={cfg.historyChars}
            style={{ maxWidth: 140 }}
            onChange={(e) => debouncedPatch({ historyChars: Number(e.target.value) })}
          />
        </div>
        <div className="prefs-hint">
          Last <code>{cfg.historyChars}</code> characters of the previous chat
          turn are sent with each suggestion request so the model knows what
          you&apos;re replying to. Set to <code>0</code> to send only the typed
          text. Higher values = more context, slightly larger payload &amp;
          token cost per request.
        </div>
      </section>
    </>
  );
}
