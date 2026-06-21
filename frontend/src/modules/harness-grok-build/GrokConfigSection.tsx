
interface Props {
  config: Record<string, unknown>;
  base: string;
  onRenderAll: () => void;
  enabled: boolean;
}

export function GrokConfigSection({ config, base, onRenderAll, enabled }: Props) {
  const defs = (config['defaults'] || {}) as Record<string, unknown>;
  const grokRuntime = (defs['grokRuntime'] as string) || localStorage.getItem('yha.grokRuntime') || 'headless';

  if (!enabled) return null;

  async function handleGrokRuntimeChange(val: string) {
    const mode = val === 'acp' ? 'acp' : 'headless';
    localStorage.setItem('yha.grokRuntime', mode);
    try {
      await fetch(base + '/v1/config/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { grokRuntime: mode } }),
      });
      onRenderAll();
    } catch { /* ignore */ }
  }

  return (
    <div id="prefs-harness-grok-runtime-section">
      <h4 className="prefs-sec">Grok Build runtime</h4>
      <div className="prefs-row">
        <label style={{ marginRight: '10px', fontSize: '13px' }}>How YHA invokes the Grok binary:</label>
        <select
          className="prefs-input"
          id="prefs-grok-runtime"
          value={grokRuntime === 'acp' ? 'acp' : 'headless'}
          onChange={(e) => handleGrokRuntimeChange(e.target.value)}
          style={{ width: 'auto', flex: '0 0 auto' }}
        >
          <option value="headless">Headless (default · one-shot -p streaming-json + --resume)</option>
          <option value="acp">ACP (grok agent stdio · long-lived agent process, continuous context)</option>
        </select>
      </div>
      <div className="prefs-hint">
        {grokRuntime === 'acp'
          ? <>Uses the official Agent Client Protocol via <code>grok agent stdio</code>. Better for long agentic sessions (one persistent agent process per Grok account, reuses ACP session for full internal state across turns).</>
          : <>Standard headless CLI spawn per turn with <code>-p --output-format streaming-json --resume</code> when possible. Good default for most use.</>
        }
      </div>
      <div className="prefs-hint" style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>
        Switch requires a new turn to take effect. Both routes support the same MCP tools (via alias), rich events, resume continuity, and cost estimation.
      </div>
    </div>
  );
}
