#!/usr/bin/env node
// @ts-check
'use strict';

// Flat-file / dynamic-data MCP — CSV, TSV, JSON, JSONL, XLSX.
// Provides read, write, query (JMESPath), transform, merge, and file-watch tools.

const fs   = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const _stdinDecoder = new StringDecoder('utf8');

// ── MCP stdio transport ──────────────────────────────────────────────────────

// See data-server.js for the rationale. flatdata's `read_file` returns full
// file contents; without a cap a 1 GB CSV would buffer the whole thing in
// V8 heap on both ends. Override via YHA_MCP_TOOL_RESULT_MAX_BYTES.
const MCP_TOOL_RESULT_MAX_BYTES = (() => {
  const v = Number(process.env.YHA_MCP_TOOL_RESULT_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 262144;
})();

function _capResultText(text) {
  if (typeof text !== 'string') return { text, truncated: false };
  const buf = Buffer.byteLength(text, 'utf8');
  if (buf <= MCP_TOOL_RESULT_MAX_BYTES) return { text, truncated: false };
  const slice = text.slice(0, MCP_TOOL_RESULT_MAX_BYTES);
  return {
    text: `${slice}\n\n[truncated: ${buf} bytes → ${MCP_TOOL_RESULT_MAX_BYTES}; set YHA_MCP_TOOL_RESULT_MAX_BYTES to raise]`,
    truncated: true,
  };
}

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
        serverInfo: { name: 'flat-data', version: '1.0.0' }
      }
    });
  } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    // notification
  } else if (msg.method === 'ping') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
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
    try { handleMessage(JSON.parse(body)); } catch (_) {}
  }
});

process.stdin.on('end', () => { inputBuffer += _stdinDecoder.end(); stopAllWatches(); process.exit(0); });
process.on('SIGTERM', () => { stopAllWatches(); process.exit(0); });
process.on('SIGINT',  () => { stopAllWatches(); process.exit(0); });
require('./_parent-watchdog').installParentWatchdog(() => { try { stopAllWatches(); } catch (_) {} });

// ── File watches ─────────────────────────────────────────────────────────────

const watches = new Map(); // filePath → { timer, lastMtime, pollMs }

function stopAllWatches() {
  for (const { timer } of watches.values()) clearInterval(timer);
  watches.clear();
}

// ── Format detection ─────────────────────────────────────────────────────────

function detectFormat(filePath, hint) {
  if (hint && hint !== 'auto') return hint;
  const ext = path.extname(filePath).toLowerCase().slice(1);
  if (ext === 'csv')  return 'csv';
  if (ext === 'tsv')  return 'tsv';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') return 'xlsx';
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl';
  return 'json';
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseFile(filePath, format) {
  const fmt = detectFormat(filePath, format);
  const raw = fs.readFileSync(filePath, 'utf8');

  if (fmt === 'json') {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  if (fmt === 'jsonl') {
    return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  if (fmt === 'csv' || fmt === 'tsv') {
    const Papa = require('papaparse');
    const delimiter = fmt === 'tsv' ? '\t' : ',';
    const result = Papa.parse(raw, { header: true, delimiter, skipEmptyLines: true, dynamicTyping: true });
    if (result.errors.length) throw new Error(result.errors[0].message);
    return result.data;
  }

  if (fmt === 'xlsx') {
    const ExcelJS = require('exceljs');
    // ExcelJS requires async for file I/O but we can use the in-memory sync path
    throw new Error('XLSX read requires async — use read_file with await (internally handled)');
  }

  throw new Error('Unsupported format: ' + fmt);
}

async function parseFileAsync(filePath, format) {
  const fmt = detectFormat(filePath, format);
  if (fmt !== 'xlsx') return parseFile(filePath, fmt);

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  let headers = null;
  ws.eachRow((row, idx) => {
    const vals = row.values.slice(1); // row.values[0] is undefined
    if (idx === 1) { headers = vals.map(v => String(v ?? '')); }
    else { const obj = {}; headers.forEach((h, i) => obj[h] = vals[i] ?? null); rows.push(obj); }
  });
  return rows;
}

function serializeFile(filePath, rows, format) {
  const fmt = detectFormat(filePath, format);

  if (fmt === 'json') {
    fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf8');
    return;
  }

  if (fmt === 'jsonl') {
    fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return;
  }

  if (fmt === 'csv' || fmt === 'tsv') {
    const Papa = require('papaparse');
    const delimiter = fmt === 'tsv' ? '\t' : ',';
    const csv = Papa.unparse(rows, { delimiter });
    fs.writeFileSync(filePath, csv, 'utf8');
    return;
  }

  throw new Error('Unsupported write format: ' + fmt + ' (xlsx write not supported)');
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a flat data file (CSV, TSV, JSON, JSONL, XLSX) and return its contents as a JSON array of row objects. Auto-detects format from extension or use the format parameter.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the data file' },
        format:   { type: 'string', enum: ['auto', 'csv', 'tsv', 'json', 'jsonl', 'xlsx'], description: 'File format (default: auto-detect from extension)' },
        limit:    { type: 'number', description: 'Max rows to return (default 1000)' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'get_headers',
    description: 'Read only the column headers of a flat data file without loading all rows. Fast for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the data file' },
        format:   { type: 'string', enum: ['auto', 'csv', 'tsv', 'json', 'jsonl', 'xlsx'], description: 'File format (default: auto)' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'write_file',
    description: 'Write an array of row objects to a flat data file (CSV, TSV, JSON, JSONL). Overwrites the file if it exists.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to write to' },
        rows:     { type: 'array',  description: 'Array of row objects to write', items: { type: 'object' } },
        format:   { type: 'string', enum: ['auto', 'csv', 'tsv', 'json', 'jsonl'], description: 'Output format (default: auto-detect from extension)' }
      },
      required: ['filePath', 'rows']
    }
  },
  {
    name: 'append_rows',
    description: 'Append rows to an existing flat data file. For JSON files the array is extended; for CSV/TSV rows are appended.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file' },
        rows:     { type: 'array',  description: 'Rows to append', items: { type: 'object' } },
        format:   { type: 'string', enum: ['auto', 'csv', 'tsv', 'json', 'jsonl'], description: 'Format (default: auto)' }
      },
      required: ['filePath', 'rows']
    }
  },
  {
    name: 'query_data',
    description: 'Load a flat data file and filter/transform it with a JMESPath expression. Great for extracting subsets, projecting columns, or aggregating. Example expression: "[?age > `30`].{name: name, age: age}"',
    inputSchema: {
      type: 'object',
      properties: {
        filePath:       { type: 'string', description: 'Absolute path to the data file' },
        jmesExpression: { type: 'string', description: 'JMESPath expression to apply to the loaded array' },
        format:         { type: 'string', enum: ['auto', 'csv', 'tsv', 'json', 'jsonl', 'xlsx'], description: 'File format (default: auto)' }
      },
      required: ['filePath', 'jmesExpression']
    }
  },
  {
    name: 'merge_files',
    description: 'Merge multiple flat data files by stacking rows (union) or joining on a key column (join). For join, all files must have the key column.',
    inputSchema: {
      type: 'object',
      properties: {
        filePaths:  { type: 'array', items: { type: 'string' }, description: 'Array of absolute file paths to merge' },
        outputPath: { type: 'string', description: 'Where to write the merged result' },
        mode:       { type: 'string', enum: ['union', 'join'], description: 'union = stack all rows; join = inner join on onKey' },
        onKey:      { type: 'string', description: 'Column name to join on (required when mode=join)' },
        format:     { type: 'string', enum: ['auto', 'csv', 'tsv', 'json', 'jsonl'], description: 'Output format (default: auto)' }
      },
      required: ['filePaths', 'outputPath', 'mode']
    }
  },
  {
    name: 'list_data_files',
    description: 'List data files in a directory filtered by extension.',
    inputSchema: {
      type: 'object',
      properties: {
        dirPath:    { type: 'string', description: 'Absolute directory path to search' },
        extensions: { type: 'array', items: { type: 'string' }, description: 'Extensions to include, e.g. ["csv","json"] (default: all data formats)' },
        recursive:  { type: 'boolean', description: 'Search subdirectories (default false)' }
      },
      required: ['dirPath']
    }
  },
  {
    name: 'watch_file',
    description: 'Watch a file for changes by polling its modification time. When a change is detected the server records it. Use watch_status to check. Useful for trigger-based workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath:       { type: 'string', description: 'Absolute file path to watch' },
        pollIntervalMs: { type: 'number', description: 'Poll interval in milliseconds (default 5000)' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'watch_status',
    description: 'Check the status of all active file watches and their last detected change times.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'unwatch_file',
    description: 'Stop watching a file.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute file path to stop watching' }
      },
      required: ['filePath']
    }
  }
];

// ── Tool implementations ─────────────────────────────────────────────────────

async function toolReadFile({ filePath, format, limit }) {
  const rows = await parseFileAsync(filePath, format || 'auto');
  const cap = limit ?? 1000;
  const sliced = rows.slice(0, cap);
  return { rows: sliced, totalRows: rows.length, returnedRows: sliced.length, filePath };
}

async function toolGetHeaders({ filePath, format }) {
  const rows = await parseFileAsync(filePath, format || 'auto');
  if (!rows.length) return { headers: [], filePath };
  return { headers: Object.keys(rows[0]), filePath };
}

function toolWriteFile({ filePath, rows, format }) {
  serializeFile(filePath, rows, format || 'auto');
  return { message: 'Written.', filePath, rows: rows.length };
}

async function toolAppendRows({ filePath, rows, format }) {
  let existing = [];
  if (fs.existsSync(filePath)) {
    existing = await parseFileAsync(filePath, format || 'auto');
  }
  const merged = existing.concat(rows);
  serializeFile(filePath, merged, format || 'auto');
  return { message: 'Appended.', filePath, newTotal: merged.length };
}

async function toolQueryData({ filePath, jmesExpression, format }) {
  const jmespath = require('jmespath');
  const rows = await parseFileAsync(filePath, format || 'auto');
  const result = jmespath.search(rows, jmesExpression);
  return { result, type: Array.isArray(result) ? 'array' : typeof result };
}

async function toolMergeFiles({ filePaths, outputPath, mode, onKey, format }) {
  const datasets = await Promise.all(filePaths.map(fp => parseFileAsync(fp, 'auto')));

  let result;
  if (mode === 'union') {
    result = datasets.flat();
  } else if (mode === 'join') {
    if (!onKey) throw new Error('onKey is required for join mode');
    result = datasets[0];
    for (let i = 1; i < datasets.length; i++) {
      const lookup = new Map(datasets[i].map(r => [r[onKey], r]));
      result = result
        .filter(r => lookup.has(r[onKey]))
        .map(r => ({ ...r, ...lookup.get(r[onKey]) }));
    }
  } else {
    throw new Error('Unknown mode: ' + mode);
  }

  serializeFile(outputPath, result, format || 'auto');
  return { message: 'Merged.', outputPath, rows: result.length, mode };
}

function toolListDataFiles({ dirPath, extensions, recursive }) {
  const DATA_EXTS = new Set(['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xlsx', 'xls', 'xlsm']);
  const allowed = extensions ? new Set(extensions.map(e => e.toLowerCase().replace(/^\./, ''))) : DATA_EXTS;
  const files = [];

  function scan(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && recursive) { scan(full); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase().slice(1);
      if (allowed.has(ext)) {
        const stat = fs.statSync(full);
        files.push({ path: full, name: e.name, size: stat.size, modified: stat.mtime.toISOString() });
      }
    }
  }
  scan(dirPath);
  return { files, count: files.length };
}

function toolWatchFile({ filePath, pollIntervalMs }) {
  if (watches.has(filePath)) return { message: 'Already watching.', filePath };
  const poll = Math.max(pollIntervalMs ?? 5000, 1000);
  let lastMtime = null;
  let changeCount = 0;
  let lastChange = null;
  try { lastMtime = fs.statSync(filePath).mtimeMs; } catch (_) {}

  const timer = setInterval(() => {
    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      if (lastMtime !== null && mtime !== lastMtime) {
        changeCount++;
        lastChange = new Date().toISOString();
      }
      lastMtime = mtime;
    } catch (_) {}
  }, poll);

  watches.set(filePath, { timer, pollMs: poll, changeCount: () => changeCount, lastChange: () => lastChange });
  return { message: 'Watching.', filePath, pollIntervalMs: poll };
}

function toolWatchStatus() {
  const status = [];
  for (const [fp, w] of watches.entries()) {
    status.push({ filePath: fp, pollIntervalMs: w.pollMs, changeCount: w.changeCount(), lastChange: w.lastChange() });
  }
  return { watches: status };
}

function toolUnwatchFile({ filePath }) {
  const w = watches.get(filePath);
  if (!w) return { message: 'Not being watched.', filePath };
  clearInterval(w.timer);
  watches.delete(filePath);
  return { message: 'Stopped watching.', filePath };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

function handleToolCall(id, name, args) {
  let p;
  switch (name) {
    case 'read_file':        p = toolReadFile(args); break;
    case 'get_headers':      p = toolGetHeaders(args); break;
    case 'write_file':       p = Promise.resolve(toolWriteFile(args)); break;
    case 'append_rows':      p = toolAppendRows(args); break;
    case 'query_data':       p = toolQueryData(args); break;
    case 'merge_files':      p = toolMergeFiles(args); break;
    case 'list_data_files':  p = Promise.resolve(toolListDataFiles(args)); break;
    case 'watch_file':       p = Promise.resolve(toolWatchFile(args)); break;
    case 'watch_status':     p = Promise.resolve(toolWatchStatus()); break;
    case 'unwatch_file':     p = Promise.resolve(toolUnwatchFile(args)); break;
    default:
      sendMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } });
      return;
  }

  p.then(result => {
    const capped = _capResultText(JSON.stringify(result, null, 2));
    sendMessage({
      jsonrpc: '2.0', id,
      result: {
        content: [{ type: 'text', text: capped.text }],
        ...(capped.truncated ? { _truncated: true } : {}),
      }
    });
  }).catch(err => {
    sendMessage({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true }
    });
  });
}
