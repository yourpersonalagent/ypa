#!/usr/bin/env node
// @ts-check
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // eslint-disable-line no-redeclare
const { StringDecoder } = require('string_decoder');
const _stdinDecoder = new StringDecoder('utf8');

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
        serverInfo: { name: 'code-exec', version: '1.0.0' }
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
            name: 'run_python',
            description: 'Execute Python code in a Docker container. Pre-installed: numpy, pandas, matplotlib, yfinance, ccxt, tabulate, lxml, pandas_ta. Scripts can write output files to /exchange which maps to bridge/mcp/exchange/ on the host.',
            inputSchema: {
              type: 'object',
              properties: {
                code: { type: 'string', description: 'Python code to execute' },
                timeout: { type: 'number', description: 'Timeout in seconds (default 30)' }
              },
              required: ['code']
            }
          },
          {
            name: 'run_nodejs',
            description: 'Execute Node.js code in a Docker container. Pre-installed: canvas, chart.js, d3, mathjs, axios, moment, csv-parser, csv-writer, fs-extra. Scripts can write output files to /exchange.',
            inputSchema: {
              type: 'object',
              properties: {
                code: { type: 'string', description: 'Node.js code to execute' },
                timeout: { type: 'number', description: 'Timeout in seconds (default 30)' }
              },
              required: ['code']
            }
          },
          {
            name: 'list_packages',
            description: 'List pre-installed packages available in each runtime',
            inputSchema: { type: 'object', properties: {}, required: [] }
          },
          {
            name: 'list_exchange',
            description: 'List files in the exchange folder (output from code execution)',
            inputSchema: { type: 'object', properties: {}, required: [] }
          },
          {
            name: 'read_exchange',
            description: 'Read a file from the exchange folder. Text files returned as text, binary files as base64.',
            inputSchema: {
              type: 'object',
              properties: {
                filename: { type: 'string', description: 'Filename to read from exchange folder' }
              },
              required: ['filename']
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

process.stdin.on('end', () => { inputBuffer += _stdinDecoder.end(); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
require('./_parent-watchdog').installParentWatchdog();

// ── Paths ────────────────────────────────────────────────────────────────────

const EXCHANGE_DIR = path.join(__dirname, 'exchange');
const PYTHON_TEMP_DIR = path.join(__dirname, 'PythonTemp');
const NODEJS_TEMP_DIR = path.join(__dirname, 'NodeJsTemp');

for (const d of [EXCHANGE_DIR, PYTHON_TEMP_DIR, NODEJS_TEMP_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

function handleToolCall(id, name, args) {
  let p;

  if (name === 'run_python') {
    p = runInDocker('python', args.code, args.timeout || 30);
  } else if (name === 'run_nodejs') {
    p = runInDocker('nodejs', args.code, args.timeout || 30);
  } else if (name === 'list_packages') {
    p = Promise.resolve({
      python: ['numpy', 'pandas', 'pandas_ta', 'lxml', 'yfinance', 'tabulate', 'ccxt', 'matplotlib', 'datetime'],
      nodejs: ['canvas', 'chart.js', 'd3', 'mathjs', 'axios', 'moment', 'csv-parser', 'csv-writer', 'fs-extra']
    });
  } else if (name === 'list_exchange') {
    try {
      const files = fs.readdirSync(EXCHANGE_DIR).map(f => {
        const stat = fs.statSync(path.join(EXCHANGE_DIR, f));
        return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
      });
      p = Promise.resolve(files);
    } catch (e) {
      p = Promise.resolve([]);
    }
  } else if (name === 'read_exchange') {
    try {
      const fp = path.join(EXCHANGE_DIR, path.basename(args.filename));
      const content = fs.readFileSync(fp);
      const isText = /\.(txt|csv|json|log|md|py|js|html|xml|svg)$/i.test(args.filename);
      p = Promise.resolve(isText
        ? { type: 'text', content: content.toString('utf8') }
        : { type: 'binary', encoding: 'base64', content: content.toString('base64') });
    } catch (e) {
      p = Promise.reject(new Error('Cannot read file: ' + e.message));
    }
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

// ── Docker execution ─────────────────────────────────────────────────────────

// Per-exec container hardening. Deliberately NOT included:
//   --network none — the sandbox's documented job is fetching data (python:
//     yfinance/ccxt, node: axios), so it needs egress; cutting it breaks the
//     primary use case.
//   --user — the script writes outputs to the bind-mounted /exchange, which is
//     owned by the host user; forcing a container uid breaks those writes.
// What's here caps blast radius without touching either: RAM + no swap headroom
// via the single cap, CPU share, PID count (fork-bomb guard), no privilege
// escalation, and all Linux caps dropped (plain userland TCP/file I/O needs
// none). Host is an 8 GB box, so 1g leaves room for the bridge + go-core.
const DOCKER_HARDENING = [
  '--memory', '1g',
  '--cpus', '2',
  '--pids-limit', '256',
  '--security-opt', 'no-new-privileges',
  '--cap-drop', 'ALL',
];

function runInDocker(runtime, code, timeoutSecs) {
  return new Promise((resolve, reject) => {
    // Preflight: surface a missing container runtime as an actionable error
    // (see Preferences -> Dependencies) instead of a raw spawn ENOENT, and
    // before any temp file is written. Only a confirmed-missing dep rejects;
    // if the shared scanner can't load for some other reason, fall through and
    // let the spawn proceed exactly as before.
    try {
      require('../lib/deps').assertDep('docker');
    } catch (e) {
      if (e && e.code === 'EDEPMISSING') { reject(e); return; }
    }
    const execId = crypto.randomUUID();
    let filePath, dockerImage, dockerArgs;

    if (runtime === 'python') {
      filePath = path.join(PYTHON_TEMP_DIR, execId + '.py');
      const indented = code.split('\n').map(l => '    ' + l).join('\n');
      const wrapped = [
        'import sys, os',
        "os.chdir('/exchange')",
        'try:',
        indented,
        'except Exception as e:',
        '    print("Error: " + str(e), file=sys.stderr)'
      ].join('\n') + '\n';
      fs.writeFileSync(filePath, wrapped, 'utf8');
      dockerImage = 'my-python-app';
      dockerArgs = [
        'run', '--rm',
        ...DOCKER_HARDENING,
        '-v', PYTHON_TEMP_DIR + ':/app/pythonapifiles',
        '-v', EXCHANGE_DIR + ':/exchange',
        dockerImage,
        'python', '-u', '/app/pythonapifiles/' + execId + '.py'
      ];
    } else {
      filePath = path.join(NODEJS_TEMP_DIR, execId + '.js');
      fs.writeFileSync(filePath, code, 'utf8');
      dockerImage = 'my-nodejs-app';
      dockerArgs = [
        'run', '--rm',
        ...DOCKER_HARDENING,
        '-v', NODEJS_TEMP_DIR + ':/app/nodejsapifiles',
        '-v', EXCHANGE_DIR + ':/exchange',
        dockerImage,
        'node', '/app/nodejsapifiles/' + execId + '.js'
      ];
    }

    const proc = spawn('docker', dockerArgs);
    let stdout = '', stderr = '';

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Execution timed out after ' + timeoutSecs + 's'));
    }, timeoutSecs * 1000);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
      let exchangeFiles = [];
      try { exchangeFiles = fs.readdirSync(EXCHANGE_DIR); } catch (e) { /* ignore */ }
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: exitCode,
        exchange_files: exchangeFiles
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
      reject(err);
    });
  });
}
