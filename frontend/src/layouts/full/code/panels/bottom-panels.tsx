// Bottom-stack panel renderers, extracted from the old BottomStack.tsx body
// so PanelStack.tsx can render them from a registry alongside the
// right-stack panels (any panel can live in either stack via DnD).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../../../stores/index.js';
import { useMcpRunning } from '../../../../stores/mcpStore.js';
import { showDebugModal, DEBUG_MENU_ENTRIES } from '../../../../panels/debug-panel.js';
import { getAppState } from '../../../../stores/appStore.js';

// Browser panel removed — header already has a dedicated browser button.

const POLL_HISTORY_MS = 2000;
const CMD_HISTORY_MAX = 200;

interface HistoryEntry {
  ts: string;
  command: string;
  output: string;
  exitCode: number | null;
}
type ShellLabel = 'bash' | 'pwsh' | 'powershell';

interface HistoryResponse {
  success: boolean;
  open: boolean;
  shell?: ShellLabel;
  history: HistoryEntry[];
}

const promptFor = (shell: ShellLabel) => (shell === 'bash' ? '$' : 'PS>');
const placeholderFor = (shell: ShellLabel) =>
  shell === 'bash' ? 'type a command…' : 'type a PowerShell command…';

function fmtTs(ts: string): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function TerminalPanel() {
  const mcpUp = useMcpRunning('bash-console');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [shell, setShell] = useState<ShellLabel>('bash');
  const [inputValue, setInputValue] = useState('');
  const [cmdRunning, setCmdRunning] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cmdHistoryRef = useRef<string[]>([]);
  const cmdHistoryIdxRef = useRef(-1);
  const wasAtBottomRef = useRef(true);

  const pollHistory = useCallback(async () => {
    try {
      const r = await fetch('/v1/bash-console/history');
      if (!r.ok) return;
      const data = (await r.json()) as HistoryResponse;
      if (!data.success) return;
      if (data.shell) setShell(data.shell);
      setHistory(data.history ?? []);
    } catch {}
  }, []);

  useEffect(() => {
    if (!mcpUp) return;
    void pollHistory();
    const id = setInterval(pollHistory, POLL_HISTORY_MS);
    return () => clearInterval(id);
  }, [mcpUp, pollHistory]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body && wasAtBottomRef.current) body.scrollTop = body.scrollHeight;
  }, [history]);

  const onBodyScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    wasAtBottomRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  };

  const submitCommand = useCallback(async () => {
    if (cmdRunning) return;
    const cmd = inputValue.trim();
    if (!cmd) return;
    cmdHistoryRef.current.push(cmd);
    if (cmdHistoryRef.current.length > CMD_HISTORY_MAX) cmdHistoryRef.current.shift();
    cmdHistoryIdxRef.current = -1;
    setInputValue('');
    setCmdRunning(true);
    try {
      const working_dir = useAppStore.getState().sessionWorkingDir ?? null;
      await fetch('/v1/bash-console/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, working_dir }),
      });
      await pollHistory();
    } catch {}
    setCmdRunning(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [cmdRunning, inputValue, pollHistory]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitCommand();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const list = cmdHistoryRef.current;
      if (!list.length) return;
      cmdHistoryIdxRef.current = Math.min(cmdHistoryIdxRef.current + 1, list.length - 1);
      setInputValue(list[list.length - 1 - cmdHistoryIdxRef.current]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdHistoryIdxRef.current = Math.max(cmdHistoryIdxRef.current - 1, -1);
      const list = cmdHistoryRef.current;
      setInputValue(cmdHistoryIdxRef.current === -1 ? '' : list[list.length - 1 - cmdHistoryIdxRef.current]);
    }
  };

  if (!mcpUp) {
    return (
      <div className="cv-pane">
        <div className="cv-pane-status">
          Terminal MCP (bash-console) is not running. Enable it in Settings → MCP, or start it from the bridge.
        </div>
      </div>
    );
  }

  return (
    <div className="cv-pane cv-terminal-pane">
      <div className="cv-terminal-body" ref={bodyRef} onScroll={onBodyScroll}>
        {history.length === 0 ? (
          <div className="cv-pane-status">
            No commands yet — type below, or let a model run something first. Shared <code>{shell}</code> session.
          </div>
        ) : history.map((e, i) => (
          <div key={`${e.ts}-${i}`} className="bc-entry">
            <div className="bc-cmd-line">
              <span className="bc-cmd-text">{e.command}</span>
              {e.exitCode !== null && (
                <span className={e.exitCode === 0 ? 'bc-exit-ok' : 'bc-exit-err'}>[{e.exitCode}]</span>
              )}
              <span className="bc-ts">{fmtTs(e.ts)}</span>
            </div>
            {e.output && <pre className="bc-output">{e.output}</pre>}
          </div>
        ))}
      </div>
      <div className="cv-terminal-footer">
        <span className="bc-prompt" title={`shared ${shell} session`}>{promptFor(shell)}</span>
        <input
          ref={inputRef}
          type="text"
          className="bc-input"
          placeholder={placeholderFor(shell)}
          autoComplete="off"
          spellCheck={false}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={onInputKey}
          disabled={cmdRunning}
        />
        <button
          className="bc-run-btn"
          onClick={() => void submitCommand()}
          disabled={cmdRunning || !inputValue.trim()}
        >run ↵</button>
      </div>
    </div>
  );
}

export function DebugPanel() {
  const open = useCallback(async (subcmd: string) => {
    const sid = String(getAppState().currentSession || 'default');
    try {
      const r = await fetch(`/v1/debug/${encodeURIComponent(subcmd)}/${encodeURIComponent(sid)}`);
      const j = (await r.json()) as { success?: boolean; data?: Record<string, unknown> };
      if (j.success && j.data) showDebugModal(subcmd, j.data);
    } catch (e) {
      console.warn('[code-view debug] fetch failed', e);
    }
  }, []);

  return (
    <div className="cv-pane cv-debug-pane">
      <p className="cv-pane-blurb">
        Inspect bridge state. Each entry opens the existing Debug modal on top —
        embedding the renderers inline lands in a later milestone.
      </p>
      <div className="cv-debug-grid">
        {DEBUG_MENU_ENTRIES.map((d) => (
          <button key={d.id} className="cv-debug-card" onClick={() => void open(d.id)}>
            {d.label}
          </button>
        ))}
      </div>
    </div>
  );
}
