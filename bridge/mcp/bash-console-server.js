#!/usr/bin/env node
// @ts-check
'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto'); // eslint-disable-line no-redeclare
const { StringDecoder } = require('string_decoder');
const _stdinDecoder = new StringDecoder('utf8');

// ── Platform / shell selection ───────────────────────────────────────────────
// On Linux/macOS the persistent session is `bash --norc --noprofile`.
// On Windows we pick PowerShell 7 (pwsh) if available, else Windows PowerShell
// 5.1 (powershell.exe). The binary is resolved once at module load so every
// openSession() in this process uses the same shell.
const isWindows = process.platform === 'win32';
let SHELL_BIN = 'bash';
let SHELL_LABEL = 'bash';
if (isWindows) {
  try {
    const probe = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit'], { stdio: 'ignore' });
    if (probe.status === 0) { SHELL_BIN = 'pwsh'; SHELL_LABEL = 'pwsh'; }
    else { SHELL_BIN = 'powershell.exe'; SHELL_LABEL = 'powershell'; }
  } catch (_) {
    SHELL_BIN = 'powershell.exe'; SHELL_LABEL = 'powershell';
  }
}

// ── History buffer ────────────────────────────────────────────────────────────
const MAX_HISTORY = 50;
const history = []; // { ts, command, output, exitCode }

// ── MCP stdio transport ──────────────────────────────────────────────────────

let inputBuffer = '';

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'bash-console', version: '1.0.0' }
      }
    });
  } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    // notification — no response needed
  } else if (msg.method === 'ping') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          {
            name: 'run_command',
            description: 'Execute a shell command in a single, shared session. Unlike #bash (which spawns parallel, isolated, ephemeral shells), this MCP maintains ONE persistent session with consistent state: environment variables, working directory, aliases, and background jobs all survive across calls. Use this for stateful workflows — activating virtualenvs, installing packages, starting/stopping services, or any multi-step shell work where state must carry over. The session is also visible to the user in the browser console panel, making it a true shared workspace. On Linux/macOS the session is bash; on Windows it is PowerShell (pwsh 7 if installed, else Windows PowerShell 5.1) — semantics are the same (state survives across calls), but use PS syntax on Windows. Check `console_status.shell` to see which one is active.',
            inputSchema: {
              type: 'object',
              properties: {
                command:     { type: 'string', description: 'Shell command to execute' },
                timeout:     { type: 'number', description: 'Timeout in seconds (default 30, max 300)' },
                working_dir: { type: 'string', description: 'Directory to start the session in (only used when opening a new session)' }
              },
              required: ['command']
            }
          },
          {
            name: 'close_console',
            description: 'Close and reset the persistent bash session. All session state (env vars, working directory, background jobs) is cleared.',
            inputSchema: { type: 'object', properties: {}, required: [] }
          },
          {
            name: 'console_status',
            description: 'Get the current status of the persistent bash session: open/closed, uptime, idle time, and seconds until auto-close.',
            inputSchema: { type: 'object', properties: {}, required: [] }
          },
          {
            name: 'console_history',
            description: 'Get recent command history from this shared bash session — timestamps, commands, outputs, and exit codes. Useful to review what has already been run before issuing new commands.',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Max entries to return (default 50, max 50)' }
              },
              required: []
            }
          }
        ]
      }
    });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    handleToolCall(msg.id, name, args || {});
  } else if (msg.id !== undefined) {
    sendMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

process.stdin.on('data', (chunk) => {
  inputBuffer += _stdinDecoder.write(chunk);
  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const clMatch = inputBuffer.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
    if (!clMatch) { inputBuffer = inputBuffer.slice(headerEnd + 4); break; }
    const len = parseInt(clMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (inputBuffer.length < bodyStart + len) break;
    const body = inputBuffer.slice(bodyStart, bodyStart + len);
    inputBuffer = inputBuffer.slice(bodyStart + len);
    try { handleMessage(JSON.parse(body)); } catch (e) { /* ignore parse errors */ }
  }
});

process.stdin.on('end', () => { inputBuffer += _stdinDecoder.end(); closeSession(); process.exit(0); });
process.on('SIGTERM', () => { closeSession(); process.exit(0); });
process.on('SIGINT', () => { closeSession(); process.exit(0); });
require('./_parent-watchdog').installParentWatchdog(() => { try { closeSession(); } catch (_) {} });

// ── Persistent bash session ──────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

let shellProc = null;
let sessionStartTime = null;
let lastActivityTime = null;
let idleTimer = null;
let accumBuffer = '';
let cmdQueue = []; // { marker, resolve, timer }

function resetIdleTimer() {
  lastActivityTime = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(closeSession, IDLE_TIMEOUT_MS);
}

function openSession(workingDir) {
  if (shellProc && shellProc.exitCode === null && !shellProc.killed) return;

  /** @type {import('child_process').SpawnOptions} */
  const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } };
  if (workingDir) {
    try { if (require('fs').statSync(workingDir).isDirectory()) spawnOpts.cwd = workingDir; } catch (_) {}
  }

  if (isWindows) {
    // PowerShell reads commands from stdin via `-Command -`.
    shellProc = spawn(SHELL_BIN, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], spawnOpts);
  } else {
    shellProc = spawn('bash', ['--norc', '--noprofile'], spawnOpts);
  }

  // stdio is ['pipe','pipe','pipe'], so all three streams are present; the guard
  // narrows ChildProcess's nullable stream types for the writes/handlers below.
  const { stdin, stdout, stderr } = shellProc;
  if (!stdin || !stdout || !stderr) return;

  sessionStartTime = Date.now();
  accumBuffer = '';
  cmdQueue = [];

  if (isWindows) {
    // UTF-8 stdout, suppress progress bars, make warning/info/verbose streams
    // visible (PS hides them when no host UI is attached), kill the prompt,
    // and disable ANSI rendering on PS7+. stderr from native exes is merged
    // into accumBuffer below — no PS-side equivalent of `exec 2>&1`.
    const bootstrap = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      '$OutputEncoding = [Text.Encoding]::UTF8',
      '$ProgressPreference = "SilentlyContinue"',
      '$ErrorActionPreference = "Continue"',
      '$WarningPreference = "Continue"',
      '$InformationPreference = "Continue"',
      'function prompt { "" }',
      'if (Get-Variable PSStyle -ErrorAction SilentlyContinue) { $PSStyle.OutputRendering = "PlainText" }',
      '',
    ].join('\n');
    stdin.write(bootstrap);
  } else {
    // Redirect stderr into stdout so all output comes through one stream
    stdin.write('exec 2>&1\n');
  }

  stdout.on('data', (data) => {
    accumBuffer += data.toString();
    drainQueue();
  });

  if (isWindows) {
    // PS error stream + native-exe stderr land here — merge into accumBuffer
    // so callers see them ordered with success-stream output.
    stderr.on('data', (data) => {
      accumBuffer += data.toString();
      drainQueue();
    });
  } else {
    stderr.on('data', () => {}); // drained — exec 2>&1 handles it
  }

  shellProc.on('exit', () => {
    for (const { resolve, timer } of cmdQueue) {
      clearTimeout(timer);
      resolve({ output: accumBuffer.trim(), exit_code: null, error: 'Session closed unexpectedly' });
    }
    cmdQueue = [];
    shellProc = null;
    accumBuffer = '';
    sessionStartTime = null;
    lastActivityTime = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  });

  resetIdleTimer();
}

function drainQueue() {
  while (cmdQueue.length > 0) {
    const { marker, resolve, timer } = cmdQueue[0];
    const idx = accumBuffer.indexOf(marker);
    if (idx === -1) break;
    // Find the end of the marker line — tolerate CRLF (PowerShell) and LF (bash).
    let endIdx = idx + marker.length;
    if (accumBuffer[endIdx] === '\r') endIdx++;
    if (accumBuffer[endIdx] === '\n') endIdx++;
    else if (endIdx === accumBuffer.length) break; // marker found but newline not yet flushed — wait

    clearTimeout(timer);
    const rawOutput = accumBuffer.slice(0, idx);
    accumBuffer = accumBuffer.slice(endIdx);
    cmdQueue.shift();

    // Extract exit code from last EXIT:\d+ line appended by the wrapper.
    // Trailing \r tolerated for the same CRLF reason.
    const lines = rawOutput.split('\n');
    let exitCode = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^EXIT:(\d+)\r?$/);
      if (m) {
        exitCode = parseInt(m[1], 10);
        lines.splice(i, 1);
        break;
      }
    }

    resolve({ output: lines.join('\n').replace(/\r\n/g, '\n').trim(), exit_code: exitCode });
  }
}

function closeSession() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (shellProc) {
    try { shellProc.kill('SIGTERM'); } catch (_) {}
    shellProc = null;
  }
  for (const { resolve, timer } of cmdQueue) {
    clearTimeout(timer);
    resolve({ output: '', exit_code: null, error: 'Session closed' });
  }
  cmdQueue = [];
  accumBuffer = '';
  sessionStartTime = null;
  lastActivityTime = null;
}

function runCommand(command, timeoutSecs, workingDir) {
  return new Promise((resolve) => {
    openSession(workingDir);
    resetIdleTimer();

    const marker = 'ENDOFCMD_' + crypto.randomBytes(16).toString('hex');
    const clampedTimeout = Math.min(Math.max(timeoutSecs, 1), 300);

    const timer = setTimeout(() => {
      const idx = cmdQueue.findIndex(c => c.marker === marker);
      if (idx !== -1) cmdQueue.splice(idx, 1);
      resolve({ output: accumBuffer.trim(), exit_code: null, error: 'Timed out after ' + clampedTimeout + 's' });
    }, clampedTimeout * 1000);

    cmdQueue.push({ marker, resolve, timer });

    if (isWindows) {
      // PS: user command runs at session scope (vars/cwd persist).
      //  - Reset $LASTEXITCODE first so we can distinguish "no native exe ran
      //    this turn" (null) from "native exe set it to N".
      //  - Capture $? BEFORE any assignment in the post-amble — assignments
      //    themselves set $? to $true and would mask a cmdlet failure.
      //  - Exit code precedence: real $LASTEXITCODE if a native exe set one,
      //    else 0/1 from $? for cmdlets.
      const wrapper = [
        '$LASTEXITCODE = $null',
        command,
        '$__yha_ok = $?; $__yha_lec = $LASTEXITCODE',
        'if ($null -eq $__yha_lec) { $__yha_lec = if ($__yha_ok) { 0 } else { 1 } }',
        '"EXIT:$__yha_lec"',
        '"' + marker + '"',
        '',
      ].join('\n');
      shellProc.stdin.write(wrapper);
    } else {
      // Wrap: run command, capture $?, then emit unique marker
      shellProc.stdin.write(command + '\necho "EXIT:$?"\necho "' + marker + '"\n');
    }
  });
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

function handleToolCall(id, name, args) {
  let p;

  if (name === 'run_command') {
    p = runCommand(args.command || '', args.timeout || 30, args.working_dir || '').then(r => {
      history.push({ ts: Date.now(), command: args.command || '', output: r.output || '', exitCode: r.exit_code });
      if (history.length > MAX_HISTORY) history.shift();
      return r;
    });
  } else if (name === 'close_console') {
    closeSession();
    p = Promise.resolve({ closed: true, message: 'Bash session closed and reset.' });
  } else if (name === 'console_status') {
    const isOpen = !!(shellProc && shellProc.exitCode === null && !shellProc.killed);
    const now = Date.now();
    p = Promise.resolve({
      open: isOpen,
      shell: SHELL_LABEL,
      uptime_seconds: isOpen && sessionStartTime ? Math.floor((now - sessionStartTime) / 1000) : null,
      idle_seconds: isOpen && lastActivityTime ? Math.floor((now - lastActivityTime) / 1000) : null,
      auto_close_in_seconds: isOpen && lastActivityTime
        ? Math.max(0, Math.floor((IDLE_TIMEOUT_MS - (now - lastActivityTime)) / 1000))
        : null,
    });
  } else if (name === 'console_history') {
    const limit = Math.min(Math.max(args.limit || 50, 1), 50);
    const isOpen = !!(shellProc && shellProc.exitCode === null && !shellProc.killed);
    // `shell` is included so the frontend (BashConsole modal, VS-Code-style
    // TerminalPanel) can render an accurate prompt sigil and label without a
    // second round-trip to console_status.
    p = Promise.resolve({ open: isOpen, shell: SHELL_LABEL, sessionStart: sessionStartTime, history: history.slice(-limit) });
  } else {
    sendMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } });
    return;
  }

  p.then(result => {
    sendMessage({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    });
  }).catch(err => {
    sendMessage({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true }
    });
  });
}
