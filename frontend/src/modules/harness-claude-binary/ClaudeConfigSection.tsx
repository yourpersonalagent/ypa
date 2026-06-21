import { useState } from 'react';
import { commands } from '../../commands.js';

interface Props {
  config: Record<string, unknown>;
  base: string;
  onRenderAll: () => void;
  enabled: boolean;
}

export function ClaudeConfigSection({ config, base, onRenderAll, enabled }: Props) {
  const defs = (config['defaults'] || {}) as Record<string, unknown>;
  const anthropicMode = (defs['anthropicApiMode'] as string) || localStorage.getItem('yha.anthropicApiMode') || 'api';
  const claudeRuntime = (defs['claudeRuntime'] as string) || localStorage.getItem('yha.claudeRuntime') || 'binary';

  const [showClaudeCommands, setShowClaudeCommandsState] = useState(() => commands.getShowClaudeCommands());

  if (!enabled) return null;

  async function handleAnthropicModeChange(val: string) {
    const mode = val === 'binary' ? 'binary' : val === 'sdk' ? 'sdk' : 'api';
    localStorage.setItem('yha.anthropicApiMode', mode);
    try {
      await fetch(base + '/v1/config/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { anthropicApiMode: mode } }),
      });
      onRenderAll();
    } catch { /* ignore */ }
  }

  async function handleClaudeRuntimeChange(val: string) {
    const mode = val === 'sdk' ? 'sdk' : 'binary';
    localStorage.setItem('yha.claudeRuntime', mode);
    try {
      await fetch(base + '/v1/config/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { claudeRuntime: mode } }),
      });
      onRenderAll();
    } catch { /* ignore */ }
  }

  function handleShowClaudeCommandsChange(v: boolean) {
    setShowClaudeCommandsState(v);
    commands.setShowClaudeCommands(v);
  }

  return (
    <>
      <div id="prefs-harness-claude-runtime-section">
        <h4 className="prefs-sec">Claude Code runtime</h4>
        <div className="prefs-row">
          <label style={{ marginRight: '10px', fontSize: '13px' }}>How the bridge invokes the Claude binary:</label>
          <select
            className="prefs-input"
            id="prefs-claude-runtime"
            value={claudeRuntime === 'sdk' ? 'sdk' : 'binary'}
            onChange={(e) => handleClaudeRuntimeChange(e.target.value)}
            style={{ width: 'auto', flex: '0 0 auto' }}
          >
            <option value="sdk">SDK (claude-agent-sdk)</option>
            <option value="binary">Binary (legacy --print spawn)</option>
          </select>
        </div>
        <div className="prefs-hint">
          {claudeRuntime === 'sdk'
            ? <>Calls go through <code>streamClaudeViaSdk()</code> using the official Claude Agent SDK.</>
            : <>Calls spawn the <code>claude</code> CLI with <code>--print</code> (legacy path). Switch to SDK unless you're debugging.</>
          }
        </div>
      </div>

      <div id="prefs-harness-anthropic-mode-section">
        <h4 className="prefs-sec">Anthropic API model path</h4>
        <div className="prefs-hint" style={{ marginBottom: '8px' }}>
          Controls how <em>API-billed</em> Claude models (non-subscription) are routed when an Anthropic API key is configured.
          Subscription models always go through the Claude binary / SDK via OAuth — this setting does not affect them.
        </div>
        <div className="prefs-row">
          <select
            className="prefs-input"
            id="prefs-anthropic-mode"
            value={['binary', 'sdk'].includes(anthropicMode) ? anthropicMode : 'api'}
            onChange={(e) => handleAnthropicModeChange(e.target.value)}
            style={{ width: 'auto', flex: '0 0 auto' }}
          >
            <option value="api">Direct API — native Anthropic SDK stream (fastest, no binary overhead)</option>
            <option value="sdk">SDK harness — Claude Agent SDK with API key (reasoning + MCPs)</option>
            <option value="binary">Binary — claude CLI with API key (legacy transport)</option>
          </select>
        </div>
      </div>

      <div id="prefs-harness-claude-commands-section">
        <h4 className="prefs-sec">Claude Code commands in command picker</h4>
        <div className="prefs-row" style={{ alignItems: 'center', gap: '8px' }}>
          <input
            type="checkbox"
            id="prefs-show-claude-commands"
            checked={showClaudeCommands}
            onChange={(e) => handleShowClaudeCommandsChange(e.target.checked)}
            style={{ accentColor: 'var(--accent)', width: '14px', height: '14px' }}
          />
          <label htmlFor="prefs-show-claude-commands" style={{ fontSize: '.82rem', color: 'var(--fg-dim)' }}>
            Add Claude Code commands to command list
          </label>
        </div>
        <div className="prefs-hint">
          When on, Claude Code's built-in slash commands (<code>/help</code>, <code>/clear</code>, <code>/status</code>, …) appear and autocomplete in the chat command picker and the node picker. Turn off to hide them.
        </div>
      </div>
    </>
  );
}
