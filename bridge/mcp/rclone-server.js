#!/usr/bin/env node
// @ts-check
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── rclone binary resolution ──────────────────────────────────────────────────

function rcloneBin() {
  for (const c of ['rclone', '/home/user/.local/bin/rclone', '/usr/local/bin/rclone', '/usr/bin/rclone']) {
    try {
      const r = spawnSync(c, ['version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) return c;
    } catch {}
  }
  return 'rclone';
}

const RCLONE = rcloneBin();

// ── MCP stdio transport ───────────────────────────────────────────────────────

let inputBuffer = '';

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'rclone', version: '1.0.0' }
      }
    });
  }
  if (msg.method === 'initialized' || msg.method === 'notifications/initialized') return;
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });

  if (msg.method === 'tools/list') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          {
            name: 'rclone_remotes',
            description: 'List all configured rclone remotes with their type (ftp, sftp, s3, b2, etc.)',
            inputSchema: { type: 'object', properties: {}, required: [] }
          },
          {
            name: 'rclone_list',
            description: 'List files and directories on a rclone remote or local path. Returns JSON array with name, type, size.',
            inputSchema: {
              type: 'object',
              properties: {
                remote: { type: 'string', description: 'Remote name (e.g. "myserver") or "local" for local filesystem' },
                path:   { type: 'string', description: 'Path on the remote (default: /)' }
              },
              required: ['remote']
            }
          },
          {
            name: 'rclone_sync',
            description: 'Sync a local directory to a rclone remote (or vice versa). Supports sync (mirror), copy (upload only), and check (diff without transfer). Always run with dryRun=true first to preview changes.',
            inputSchema: {
              type: 'object',
              properties: {
                source:     { type: 'string', description: 'Source path — local absolute path OR "remote:path"' },
                dest:       { type: 'string', description: 'Destination — local absolute path OR "remote:path"' },
                mode:       { type: 'string', enum: ['sync', 'copy', 'check'], description: 'sync=mirror (may delete), copy=upload only, check=diff report. Default: sync' },
                dryRun:     { type: 'boolean', description: 'If true, simulate without transferring. Default: true' }
              },
              required: ['source', 'dest']
            }
          },
          {
            name: 'rclone_check',
            description: 'Compare source and destination and report differences (missing files, size mismatches). No files are transferred.',
            inputSchema: {
              type: 'object',
              properties: {
                source: { type: 'string', description: 'Source path or "remote:path"' },
                dest:   { type: 'string', description: 'Destination path or "remote:path"' }
              },
              required: ['source', 'dest']
            }
          }
        ]
      }
    });
  }

  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    try {
      const result = callTool(name, args || {});
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: result }] } });
    } catch (e) {
      return send({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32000, message: e.message }
      });
    }
  }

  // Unknown method
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
}

// ── Tool implementations ──────────────────────────────────────────────────────

function callTool(name, args) {
  if (name === 'rclone_remotes') {
    const r = spawnSync(RCLONE, ['listremotes', '--long'], { encoding: 'utf8', timeout: 8000 });
    if (r.error || r.status !== 0) throw new Error('rclone not available: ' + (r.stderr || ''));
    return r.stdout || '(no remotes configured)';
  }

  if (name === 'rclone_list') {
    const { remote, path: p } = args;
    const target = remote === 'local' ? (p || '/') : `${remote}:${p || '/'}`;
    const r = spawnSync(RCLONE, ['lsjson', target, '--no-modtime'], { encoding: 'utf8', timeout: 20_000 });
    if (r.error) throw new Error('rclone not available');
    if (r.status !== 0) throw new Error((r.stderr || 'list failed').trim());
    try {
      const items = JSON.parse(r.stdout || '[]').map(e => ({
        name: e.Name, type: e.IsDir ? 'dir' : 'file', size: e.Size
      }));
      return JSON.stringify(items, null, 2);
    } catch { return r.stdout; }
  }

  if (name === 'rclone_sync') {
    const { source, dest, mode, dryRun } = args;
    if (!source || !dest) throw new Error('source and dest required');
    const rcloneMode = mode === 'copy' ? 'copy' : mode === 'check' ? 'check' : 'sync';
    const cmdArgs = [rcloneMode, source, dest, '--verbose', '--stats-one-line', '--stats', '0'];
    if (dryRun !== false) cmdArgs.push('--dry-run'); // default dryRun=true for safety
    if (rcloneMode !== 'check') cmdArgs.push('--create-empty-src-dirs');
    const r = spawnSync(RCLONE, cmdArgs, { encoding: 'utf8', timeout: 180_000 });
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
    const dryRunNote = dryRun !== false ? '[DRY RUN — no files were transferred]\n' : '';
    return dryRunNote + (output || '(no output)') + (r.status !== 0 ? `\n[exit code: ${r.status}]` : '');
  }

  if (name === 'rclone_check') {
    const { source, dest } = args;
    if (!source || !dest) throw new Error('source and dest required');
    const r = spawnSync(RCLONE, ['check', source, dest, '--verbose'], { encoding: 'utf8', timeout: 60_000 });
    return [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(no differences found)';
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ── stdin framing ─────────────────────────────────────────────────────────────

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inputBuffer += chunk;
  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = inputBuffer.slice(0, headerEnd);
    const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lenMatch) { inputBuffer = inputBuffer.slice(headerEnd + 4); continue; }
    const len = parseInt(lenMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (inputBuffer.length < bodyStart + len) break;
    const body = inputBuffer.slice(bodyStart, bodyStart + len);
    inputBuffer = inputBuffer.slice(bodyStart + len);
    try { handleMessage(JSON.parse(body)); } catch {}
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
require('./_parent-watchdog').installParentWatchdog();
