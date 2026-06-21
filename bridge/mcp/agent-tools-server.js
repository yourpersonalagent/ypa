#!/usr/bin/env node
// @ts-check
// Stdio MCP server "agent-tools" — exposes YHA employees + partners flagged
// with exposeAsAgent: true as MCP-callable agents. Two tools:
//
//   list_agents()          → enumerate published employees + partners
//   call_agent(id, input)  → run one of them once and return the reply
//
// All work goes through the bridge's HTTP layer (/proxy/agent-tools/*) so
// the bridge stays the single writer for session state. Same protocol as
// agent-multichat-server.js — different surface.
'use strict';

const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');

// Inherit BRIDGE_INTERNAL_KEY + PORT from the parent process.env (set by
// the bridge's MCP launcher). Fall back to bridge/.env for any env vars
// the bridge knew about that didn't propagate into the child.
{
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

const BRIDGE_PORT = parseInt(process.env.PORT || '8443', 10);
const USE_HTTP = process.env.USE_HTTP === 'true';
const BRIDGE_BASE = `${USE_HTTP ? 'http' : 'https'}://127.0.0.1:${BRIDGE_PORT}`;
const BRIDGE_KEY = process.env.BRIDGE_INTERNAL_KEY || '';

// Allow self-signed bridge certs when running over https
if (!USE_HTTP) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function bridgeFetch(method, urlPath, body) {
  const url = BRIDGE_BASE + urlPath;
  const init = {
    method,
    headers: { 'Authorization': `Bearer ${BRIDGE_KEY}` },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { success: false, error: text.slice(0, 200) }; }
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

// ── MCP stdio transport ──────────────────────────────────────────────────────
const _stdinDecoder = new StringDecoder('utf8');
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
        serverInfo: { name: 'agent-tools', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    // notification — no response
  } else if (msg.method === 'ping') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          {
            name: 'list_agents',
            description:
              'List YHA employees and partners that have been published as MCP-callable agents (exposeAsAgent: true). Returns each agent\'s id, display name, role, kind ("employee" | "partner"), and default model. Use to discover what specialised personas the host has wired up before calling one with call_agent.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'call_agent',
            description:
              "Invoke a single published YHA agent with one prompt and get its reply back. Each call is a fresh, isolated turn — the agent does NOT see prior call_agent history. The agent uses its configured model, system prompt, tool set, and (for partners) its native gateway. Returns the assistant's text reply. Errors if the id isn't published (exposeAsAgent: false) or doesn't exist.",
            inputSchema: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'Agent id from list_agents (employee or partner).',
                },
                input: {
                  type: 'string',
                  description: 'The prompt to send. Plain text; markdown is fine.',
                },
                model: {
                  type: 'string',
                  description: 'Optional override of the agent\'s default model (e.g. "claude-haiku-4-5-20251001"). Leave empty to use the agent\'s configured default.',
                },
              },
              required: ['id', 'input'],
            },
          },
          {
            name: 'list_org',
            description:
              'Read the YHA personnel org chart: departments → teams → member employee-ids, plus each team\'s description, lead, and system-prompt context. Use this before creating or modifying teams so you don\'t duplicate existing structure. A "team" is just a named, saved roster of employees the user can bulk-invite into a chat.',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'create_department',
            description:
              'Create a top-level department (an abstract group that can hold multiple teams). Departments are display/organisation buckets only.',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Optional slug (lowercase a-z0-9_-). Derived from label if omitted.' },
                label: { type: 'string', description: 'Human-readable department name, e.g. "Engineering".' },
                description: { type: 'string', description: 'Optional one-line description.' },
              },
              required: ['label'],
            },
          },
          {
            name: 'create_team',
            description:
              'Create a team inside a department. A team is a named roster of employee-ids the user can bulk-invite. Provide existing employee ids (from list_agents or the personnel roster) in `members`. The `context` is extra system-prompt guidance describing how the team works together.',
            inputSchema: {
              type: 'object',
              properties: {
                department: { type: 'string', description: 'Department id to create the team under.' },
                id: { type: 'string', description: 'Optional team slug. Derived from label if omitted.' },
                label: { type: 'string', description: 'Human-readable team name, e.g. "Backend Team".' },
                description: { type: 'string', description: 'Optional one-line description.' },
                lead: { type: 'string', description: 'Optional employee-id of the team lead.' },
                context: { type: 'string', description: 'Optional system-prompt context for how the team operates.' },
                members: { type: 'array', items: { type: 'string' }, description: 'Employee-ids that belong to the team.' },
              },
              required: ['department', 'label'],
            },
          },
          {
            name: 'assign_member',
            description: 'Add an existing employee to a team\'s roster. Use create_team first if the team does not exist.',
            inputSchema: {
              type: 'object',
              properties: {
                department: { type: 'string', description: 'Department id.' },
                team: { type: 'string', description: 'Team id within the department.' },
                employeeId: { type: 'string', description: 'Employee-id to add.' },
              },
              required: ['department', 'team', 'employeeId'],
            },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    handleToolCall(msg.id, name, args || {});
  } else if (msg.id !== undefined) {
    sendMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

async function handleToolCall(id, name, args) {
  try {
    let text;

    if (name === 'list_agents') {
      const result = await bridgeFetch('GET', '/proxy/agent-tools/agents');
      const agents = result.agents || [];
      if (!agents.length) {
        text = 'No agents are currently published. The host can publish an employee or partner by toggling "expose as MCP agent" in the personnel/partners UI.';
      } else {
        const lines = agents.map((a) =>
          `• ${a.id} — ${a.name}${a.role ? ` (${a.role})` : ''} [${a.kind}${a.defaultModel ? ', ' + a.defaultModel : ''}]`
        );
        text = `Published agents (${agents.length}):\n${lines.join('\n')}`;
      }

    } else if (name === 'call_agent') {
      if (!args.id) throw new Error('id is required');
      if (!args.input || !String(args.input).trim()) throw new Error('input is required');
      const result = await bridgeFetch('POST', '/proxy/agent-tools/call', {
        id: String(args.id),
        input: String(args.input),
        model: args.model ? String(args.model) : undefined,
      });
      text = String(result.text || '(empty response)');

    } else if (name === 'list_org') {
      const result = await bridgeFetch('GET', '/proxy/agent-tools/org');
      const depts = result.org?.departments || [];
      if (!depts.length) {
        text = 'No departments or teams defined yet. Use create_department then create_team to build the org chart.';
      } else {
        const lines = [];
        for (const d of depts) {
          lines.push(`▸ ${d.label} (${d.id})${d.description ? ` — ${d.description}` : ''}`);
          for (const t of d.teams || []) {
            const mem = (t.members || []).join(', ') || '(no members)';
            lines.push(`    • ${t.label} (${t.id})${t.lead ? ` lead=${t.lead}` : ''} — [${mem}]`);
          }
        }
        text = `Org chart (${depts.length} department${depts.length === 1 ? '' : 's'}):\n${lines.join('\n')}`;
      }

    } else if (name === 'create_department') {
      if (!args.label && !args.id) throw new Error('label is required');
      const result = await bridgeFetch('POST', '/proxy/agent-tools/org/department', {
        id: args.id ? String(args.id) : undefined,
        label: args.label ? String(args.label) : undefined,
        description: args.description ? String(args.description) : undefined,
      });
      const d = result.department;
      text = `Created department "${d.label}" (id: ${d.id}).`;

    } else if (name === 'create_team') {
      if (!args.department) throw new Error('department is required');
      if (!args.label && !args.id) throw new Error('label is required');
      const result = await bridgeFetch('POST', '/proxy/agent-tools/org/team', {
        department: String(args.department),
        id: args.id ? String(args.id) : undefined,
        label: args.label ? String(args.label) : undefined,
        description: args.description ? String(args.description) : undefined,
        lead: args.lead ? String(args.lead) : undefined,
        context: args.context ? String(args.context) : undefined,
        members: Array.isArray(args.members) ? args.members.map(String) : undefined,
      });
      const t = result.team;
      text = `Created team "${t.label}" (id: ${t.id}) with ${(t.members || []).length} member(s).`;

    } else if (name === 'assign_member') {
      if (!args.department || !args.team || !args.employeeId) throw new Error('department, team, employeeId are required');
      const result = await bridgeFetch('POST', '/proxy/agent-tools/org/member', {
        department: String(args.department),
        team: String(args.team),
        employeeId: String(args.employeeId),
      });
      const t = result.team;
      text = `Team "${t.label}" now has ${(t.members || []).length} member(s): ${(t.members || []).join(', ')}.`;

    } else {
      sendMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } });
      return;
    }

    sendMessage({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text }] },
    });
  } catch (e) {
    sendMessage({
      jsonrpc: '2.0', id,
      result: {
        content: [{ type: 'text', text: 'Error: ' + (e instanceof Error ? e.message : String(e)) }],
        isError: true,
      },
    });
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
    try { handleMessage(JSON.parse(body)); } catch (_) { /* ignore parse errors */ }
  }
});

process.stdin.on('end', () => { inputBuffer += _stdinDecoder.end(); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
require('./_parent-watchdog').installParentWatchdog();
