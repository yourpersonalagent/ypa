interface Props {
  config: Record<string, unknown>;
  base: string;
  onRenderAll: () => void;
  enabled: boolean;
}

export function CodexConfigSection({ config, base, onRenderAll, enabled }: Props) {
  const defs = (config['defaults'] || {}) as Record<string, unknown>;
  const codexExecMode = (defs['codexExecMode'] as string) || localStorage.getItem('yha.codexExecMode') || 'bypass';

  if (!enabled) return null;

  async function handleCodexExecModeChange(val: string) {
    const mode = val === 'full-auto' ? 'full-auto' : 'bypass';
    localStorage.setItem('yha.codexExecMode', mode);
    try {
      await fetch(base + '/v1/config/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { codexExecMode: mode } }),
      });
      onRenderAll();
    } catch { /* ignore */ }
  }

  return (
    <div id="prefs-harness-codex-exec-section">
      <h4 className="prefs-sec">Codex Execution Mode</h4>
      <div className="prefs-row">
        <label style={{ marginRight: '10px', fontSize: '13px' }}>How the bridge launches Codex:</label>
        <select
          className="prefs-input"
          id="prefs-codex-exec-mode"
          value={codexExecMode === 'full-auto' ? 'full-auto' : 'bypass'}
          onChange={(e) => handleCodexExecModeChange(e.target.value)}
          style={{ width: 'auto', flex: '0 0 auto' }}
        >
          <option value="bypass">Bypass sandbox + approvals</option>
          <option value="full-auto">Codex full-auto sandbox</option>
        </select>
      </div>
      <div className="prefs-hint" id="prefs-codex-exec-hint">
        {codexExecMode === 'bypass'
          ? <><code>Bypass</code> avoids the nested bwrap failure in restricted environments. <code>Full-auto</code> re-enables Codex's own sandbox.</>
          : <>Full-auto uses Codex's own sandbox again. If file listings fail with bwrap / RTM_NEWADDR errors, switch back to Bypass.</>
        }
      </div>
    </div>
  );
}
