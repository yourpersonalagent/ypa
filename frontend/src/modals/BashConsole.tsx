// BashConsole — moveable, resizable, fullscreen-toggleable window onto the
// shared MCP bash session. Replaces the legacy fixed-bottom drawer that was
// tied to the #main-views layout (it didn't survive the view-swap mechanism
// rework — and a drawer never made sense for an interactive shell anyway).
//
// Open via the global event 'yha:open-bash-console' (the header
// BashConsoleHeaderButton dispatches it). MCP status comes from the shared
// mcpStore so we don't add yet another /v1/mcp/ poller; while the window is
// open we ALSO poll /v1/bash-console/history every 2 s to mirror command
// activity from LLM tool-use back into the user's view.
//
// Note: `data.open` from /v1/bash-console/history reflects whether the inner
// bash subshell has been spawned (true after the first run_command) — it is
// NOT a gate on whether the window may exist. The previous implementation
// conflated the two and force-hid the header button + auto-closed the drawer
// the moment the user opened it (because no command had been run yet).
// Here, we only use `mcpUp` (server process alive) as a render gate.

import { useCallback, useEffect, useRef, useState } from 'react';
import { MoveableWindow } from '../components/MoveableWindow.js';
import { useAppStore } from '../stores/index.js';
import { useMcpRunning } from '../stores/mcpStore.js';
import {
  registerAgentSurface,
  type AgentSurfaceController,
} from '../host/surface-registry.js';

const STORAGE_KEY = 'yha.bashConsole.geometry';
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

function promptFor(shell: ShellLabel): string {
  return shell === 'bash' ? '$' : 'PS>';
}
function placeholderFor(shell: ShellLabel): string {
  return shell === 'bash' ? 'type a command…' : 'type a PowerShell command…';
}

function fmtTs(ts: string): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function BashConsole() {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [cmdRunning, setCmdRunning] = useState(false);
  const [shellOpen, setShellOpen] = useState(false); // inner shell subprocess is alive
  const [shell, setShell] = useState<ShellLabel>('bash');
  const mcpUp = useMcpRunning('bash-console');

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cmdHistoryRef = useRef<string[]>([]);
  const cmdHistoryIdxRef = useRef(-1);
  const wasAtBottomRef = useRef(true);
  const surfaceControllerRef = useRef<AgentSurfaceController | null>(null);

  useEffect(() => {
    const controller = registerAgentSurface({
      id: 'shared-terminal',
      label: 'Shared YPA terminal',
      kind: 'window',
      module: '<core>',
      openCommand: 'terminal.open',
      closeCommand: 'terminal.close',
      focus: () => inputRef.current?.focus(),
      close: () => setOpen(false),
    });
    surfaceControllerRef.current = controller;
    return () => {
      surfaceControllerRef.current = null;
      controller.dispose();
    };
  }, []);

  useEffect(() => {
    surfaceControllerRef.current?.setOpen(open && mcpUp);
  }, [mcpUp, open]);

  // ── Open via global event (matches ServePreview / BrowserWindow pattern) ───
  useEffect(() => {
    function onOpen() {
      setOpen(true);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
    function onClose() { setOpen(false); }
    window.addEventListener('yha:open-bash-console', onOpen);
    window.addEventListener('yha:close-bash-console', onClose);
    return () => {
      window.removeEventListener('yha:open-bash-console', onOpen);
      window.removeEventListener('yha:close-bash-console', onClose);
    };
  }, []);

  // If the MCP server goes away while the window is open, close it (no point
  // showing a dead shell). Reopening when MCP comes back requires a click.
  useEffect(() => {
    if (!mcpUp && open) setOpen(false);
  }, [mcpUp, open]);

  // ── History poll while open ─────────────────────────────────────────────────
  const pollHistory = useCallback(async () => {
    try {
      const r = await fetch('/v1/bash-console/history');
      if (!r.ok) return;
      const data = (await r.json()) as HistoryResponse;
      if (!data.success) return;
      setShellOpen(!!data.open);
      if (data.shell) setShell(data.shell);
      setHistory(data.history ?? []);
    } catch {}
  }, []);

  useEffect(() => {
    if (!open) return;
    pollHistory();
    const id = setInterval(pollHistory, POLL_HISTORY_MS);
    return () => clearInterval(id);
  }, [open, pollHistory]);

  // ── Stick to bottom on new history if user was already at bottom ────────────
  useEffect(() => {
    const body = bodyRef.current;
    if (body && wasAtBottomRef.current) body.scrollTop = body.scrollHeight;
  }, [history]);

  function onBodyScroll() {
    const body = bodyRef.current;
    if (!body) return;
    wasAtBottomRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  }

  // ── Command submission ──────────────────────────────────────────────────────
  async function submitCommand() {
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
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitCommand();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const list = cmdHistoryRef.current;
      if (list.length === 0) return;
      cmdHistoryIdxRef.current = Math.min(cmdHistoryIdxRef.current + 1, list.length - 1);
      setInputValue(list[list.length - 1 - cmdHistoryIdxRef.current]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdHistoryIdxRef.current = Math.max(cmdHistoryIdxRef.current - 1, -1);
      const list = cmdHistoryRef.current;
      setInputValue(cmdHistoryIdxRef.current === -1 ? '' : list[list.length - 1 - cmdHistoryIdxRef.current]);
    }
  }

  // Close the inner shell (drops env vars, cwd, background jobs) but keeps
  // the MCP server up. Run lazily — fire and forget; the next poll will
  // refresh shellOpen.
  async function closeInnerShell() {
    try {
      // There's no dedicated /v1/bash-console/close route; the run endpoint
      // can dispatch an arbitrary command — but for "really kill the shell"
      // the cleanest move is `exit`, which the wrapper sees and the bash
      // process terminates. The MCP `close_console` tool is the formal API
      // but isn't exposed via HTTP, so we use exit as a pragmatic close.
      await fetch('/v1/bash-console/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'exit' }),
      });
      await pollHistory();
    } catch {}
  }

  if (!mcpUp) return null;

  const closeShellTitle = shell === 'bash'
    ? 'Close inner bash session — clears env vars, cwd, background jobs'
    : 'Close inner PowerShell session — clears env vars, cwd, background jobs';

  const headerExtras = (
    <>
      <span className="bc-live-dot" id="bc-live-dot" />
      <span className="bc-subtitle">shared session — {shell}</span>
      {cmdRunning && (
        <span id="bc-running-badge" className="bc-running-badge">running…</span>
      )}
      {shellOpen && (
        <button
          type="button"
          className="mw-btn"
          title={closeShellTitle}
          onClick={closeInnerShell}
        >
          ⏻
        </button>
      )}
    </>
  );

  const footer = (
    <div className="bc-footer">
      <span className="bc-prompt">{promptFor(shell)}</span>
      <input
        ref={inputRef}
        className="bc-input"
        id="bc-input"
        type="text"
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
        id="bc-run-btn"
        onClick={submitCommand}
        disabled={cmdRunning || !inputValue.trim()}
      >
        run ↵
      </button>
    </div>
  );

  const windowTitle = shell === 'bash' ? 'bash terminal' : `${shell} terminal`;

  return (
    <MoveableWindow
      isOpen={open}
      title={windowTitle}
      storageKey={STORAGE_KEY}
      defaultGeometry={{ width: 720, height: 420 }}
      minWidth={420}
      minHeight={260}
      zIndex={1190}
      onClose={() => setOpen(false)}
      closeOnOutsideClick={false}
      closeOnEscape
      headerExtras={headerExtras}
      bodyClassName="bash-window-body"
      footer={footer}
    >
      <div className="bc-body" id="bc-body" ref={bodyRef} onScroll={onBodyScroll}>
        {history.length === 0 ? (
          <div className="bc-empty">
            No commands yet — type below, or let a model run something first.
          </div>
        ) : (
          history.map((e, i) => (
            <div key={`${e.ts}-${i}`} className="bc-entry">
              <div className="bc-cmd-line">
                <span className="bc-cmd-text">{e.command}</span>
                {e.exitCode !== null && (
                  <span className={e.exitCode === 0 ? 'bc-exit-ok' : 'bc-exit-err'}>
                    [{e.exitCode}]
                  </span>
                )}
                <span className="bc-ts">{fmtTs(e.ts)}</span>
              </div>
              {e.output && <pre className="bc-output">{e.output}</pre>}
            </div>
          ))
        )}
      </div>
    </MoveableWindow>
  );
}
