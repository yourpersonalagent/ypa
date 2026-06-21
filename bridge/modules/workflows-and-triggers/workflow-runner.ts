// workflow-runner.ts — Headless server-side workflow execution
// Called when a trigger fires with a workflowId.
// Runs the full node graph without a frontend connection.
'use strict';

const http = require('http');
const { findWorkflow } = require('./workflows');
const { createBackgroundSession, pushDisplayMsg } = require('../../sessions-internal');
const { displaySessions } = require('../../core/state');
const { handleHashTool } = require('../../tools/exec');
const logger = require('../../core/logger');
const { getModuleApi } = require('../../core/modules');

function _telemetry() { return getModuleApi('observability-plus')?.telemetry; }

// ── Local types ───────────────────────────────────────────────────────────────
interface GraphNode { id: string; [key: string]: unknown }

// ── Kahn's topo sort ──────────────────────────────────────────────────────────
function topoSort(nodes, links) {
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map();
  ids.forEach((i) => incoming.set(i, 0));
  links.forEach((l) => {
    if (ids.has(l.to)) incoming.set(l.to, (incoming.get(l.to) || 0) + 1);
  });
  const queue = [...ids].filter((i) => (incoming.get(i) || 0) === 0);
  const order: GraphNode[] = [];
  while (queue.length) {
    const i = queue.shift();
    const node = nodes.find((n) => n.id === i);
    if (node) order.push(node);
    for (const l of links.filter((l) => l.from === i)) {
      incoming.set(l.to, incoming.get(l.to) - 1);
      if (incoming.get(l.to) === 0) queue.push(l.to);
    }
  }
  if (order.length !== ids.size) throw new Error('Workflow has a cycle');
  return order;
}

// ── Decision evaluation — mirrored from frontend/src/workflows/workflow.ts ────
function evaluateDecision(inputText, leftOperand, operator, rightOperand) {
  const str = inputText == null ? '' : String(inputText);
  let leftVal;
  switch (leftOperand) {
    case 'wordCount': leftVal = str.trim() === '' ? 0 : str.trim().split(/\s+/).length; break;
    case 'charCount': leftVal = str.length; break;
    case 'lineCount': leftVal = str === '' ? 0 : str.split('\n').length; break;
    default: leftVal = str; break;
  }
  const right = rightOperand;
  switch (operator) {
    case '>':           return leftVal > (isNaN(Number(right)) ? right : Number(right));
    case '<':           return leftVal < (isNaN(Number(right)) ? right : Number(right));
    case '>=':          return leftVal >= (isNaN(Number(right)) ? right : Number(right));
    case '<=':          return leftVal <= (isNaN(Number(right)) ? right : Number(right));
    case '==':          return String(leftVal) === String(right);
    case '!=':          return String(leftVal) !== String(right);
    case 'contains':    return str.includes(String(right));
    case 'notContains': return !str.includes(String(right));
    case 'isEmpty':     return str.trim() === '';
    case 'isNotEmpty':  return str.trim() !== '';
    default:            return false;
  }
}

// ── Combine node command with upstream output or manual input ─────────────────
function resolveCommand(node, outputMap, links) {
  const body = (node.command || '').trim();
  const inputMode = node.inputMode ?? (node.type === 'chat' ? 'upstream' : 'off');

  if (inputMode === 'off') return body;

  if (inputMode === 'manual') {
    const manual = (node.input || '').trim();
    if (!body) return manual;
    if (!manual) return body;
    return `${body}\n\n${manual}`;
  }

  // 'upstream'
  const upstreamOutput = links
    .filter((l) => l.to === node.id)
    .map((l) => outputMap.get(l.from) || '')
    .filter(Boolean)
    .join('\n\n');
  if (!body) return upstreamOutput;
  if (!upstreamOutput) return body;
  return `${body}\n\n${upstreamOutput}`;
}

// ── Session helpers ───────────────────────────────────────────────────────────
function genSessionId() { return 's' + Date.now(); }

function findOrCreateNamedSession(target) {
  for (const [id, s] of displaySessions.entries()) {
    if (String(s.id) === String(target) || s.name?.toLowerCase() === target.toLowerCase()) {
      return String(id);
    }
  }
  const sid = genSessionId();
  createBackgroundSession(sid, target);
  return sid;
}

// ── POST a prompt to /v1/command/ and return the response text ────────────────
function dispatchCommand(prompt, sessionId, nodeConfig?) {
  return new Promise((resolve) => {
    const PORT = process.env.YHA_PORT || 8443;
    const payload: Record<string, unknown> = { Input: prompt, SessionId: sessionId };
    if (nodeConfig) {
      if (nodeConfig.model) payload.Model = nodeConfig.model;
      if (nodeConfig.provider) payload.Provider = nodeConfig.provider;
      if (nodeConfig.preset && nodeConfig.systemMode !== 'off') {
        payload.Preset = nodeConfig.preset;
        payload.SystemMode = nodeConfig.systemMode || 'replace';
      }
      if (nodeConfig.skillSet) payload.SkillSet = nodeConfig.skillSet;
      if (nodeConfig.toolSetPreset) payload.ToolSetPreset = nodeConfig.toolSetPreset;
      if (nodeConfig.caps) payload.Caps = nodeConfig.caps;
    }
    const body = JSON.stringify(payload);
    const chunks: Buffer[] = [];
    const req = http.request(
      {
        hostname: 'localhost',
        port: PORT,
        path: '/v1/command/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString());
            resolve(parsed.response || '');
          } catch {
            resolve('');
          }
        });
      }
    );
    req.on('error', () => resolve(''));
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
// broadcastFn(event, data) — optional, used to send SSE updates back to frontend
async function runWorkflow(workflowId, broadcastFn?) {
  const wf = findWorkflow(workflowId);
  if (!wf?.graph) {
    logger.warn('workflow-runner.notfound', { workflowId });
    return null;
  }

  const { nodes, links } = wf.graph;
  let sorted;
  try {
    sorted = topoSort(nodes, links);
  } catch (e) {
    logger.error('workflow-runner.cycle', { workflowId, error: e.message });
    if (broadcastFn) broadcastFn('workflow:error', { workflowId, error: e.message });
    return null;
  }

  sorted = sorted.filter((n) => !n.disabled);
  const _t0 = Date.now();
  const outputMap = new Map();

  // Use the session bound to this workflow if one exists.
  // #ns / #session nodes in the graph can still switch mid-run.
  let sessionId: string | null = null;
  for (const [sid, s] of displaySessions.entries()) {
    if (s.boundWorkflowName && (s.boundWorkflowName === wf.id || s.boundWorkflowName === wf.name)) {
      sessionId = String(sid);
      break;
    }
  }

  logger.info('workflow-runner.start', { workflowId, nodes: sorted.length });
  if (broadcastFn) broadcastFn('workflow:running', { workflowId, nodeCount: sorted.length });

  for (const node of sorted) {
    const cmd = resolveCommand(node, outputMap, links);

    // ── New session ─────────────────────────────────────────────────────────
    if (/^#ns\b|^#new\b/i.test(cmd.trim())) {
      sessionId = genSessionId();
      createBackgroundSession(sessionId);
      logger.info('workflow-runner.new-session', { workflowId, sessionId });
      outputMap.set(node.id, sessionId);
      continue;
    }

    // ── Switch/create named session ─────────────────────────────────────────
    const sessionMatch =
      cmd.trim().match(/^#session\s+"([^"]+)"/i) ||
      cmd.trim().match(/^#session\s+(\S+)/i);
    if (sessionMatch) {
      sessionId = findOrCreateNamedSession(sessionMatch[1]);
      logger.info('workflow-runner.switch-session', { workflowId, sessionId, target: sessionMatch[1] });
      outputMap.set(node.id, sessionId);
      continue;
    }

    // ── Note — record a display message, no AI call ─────────────────────────
    const noteMatch = cmd.trim().match(/^#note\s+([\s\S]+)$/i);
    if (noteMatch) {
      if (!sessionId) {
        sessionId = genSessionId();
        createBackgroundSession(sessionId);
      }
      pushDisplayMsg(sessionId, 'note', noteMatch[1].trim());
      outputMap.set(node.id, noteMatch[1].trim());
      continue;
    }

    // ── Decision node ───────────────────────────────────────────────────────
    if (node.type === 'if') {
      const input = links
        .filter((l) => l.to === node.id)
        .map((l) => outputMap.get(l.from) || '')
        .filter(Boolean)
        .join('\n\n');
      const { leftOperand = 'content', operator = '==', rightOperand = '' } = node.decisionLogic || {};
      const result = evaluateDecision(input, leftOperand, operator, rightOperand);
      outputMap.set(node.id, result ? '✓ true' : '✗ false');
      continue;
    }

    // ── #btw — frontend injection; treat as note in headless context ───────────
    const btwMatch = cmd.trim().match(/^#btw\s+([\s\S]+)$/i);
    if (btwMatch) {
      if (!sessionId) {
        sessionId = genSessionId();
        createBackgroundSession(sessionId);
      }
      pushDisplayMsg(sessionId, 'note', btwMatch[1].trim());
      outputMap.set(node.id, btwMatch[1].trim());
      continue;
    }

    // ── Any other #xxx — try handleHashTool first, fall back to /v1/command/ ──
    if (/^#\w/.test(cmd.trim())) {
      if (!sessionId) {
        sessionId = genSessionId();
        createBackgroundSession(sessionId);
      }
      try {
        const toolResult = await handleHashTool(cmd.trim(), sessionId);
        if (toolResult.handled) {
          pushDisplayMsg(sessionId, 'user', cmd.trim());
          pushDisplayMsg(sessionId, 'assistant', String(toolResult.result));
          outputMap.set(node.id, String(toolResult.result));
          continue;
        }
      } catch (e) {
        logger.error('workflow-runner.tool-error', { workflowId, nodeId: node.id, cmd, error: e.message });
      }
      // handleHashTool didn't handle it — fall through to /v1/command/
      // (handleSpecial there covers #m, #models, #clear, #help, #debug, etc.)
    }

    // ── Prompt node — send to AI via /v1/command/ ───────────────────────────
    if (!cmd) {
      outputMap.set(node.id, '');
      continue;
    }

    if (!sessionId) {
      sessionId = genSessionId();
      createBackgroundSession(sessionId);
    }

    // Extract per-node agent config (chat nodes)
    const nodeConfig = (node.type === 'chat' && (node.nodeModel || node.nodeModelProvider || node.nodePreset || node.nodeSkillSet || node.nodeToolSetPreset || node.nodeCapVision !== undefined || node.nodeCapReasoning !== undefined || node.nodeCapTools !== undefined))
      ? {
          model: node.nodeModel || undefined,
          provider: node.nodeModelProvider || undefined,
          preset: node.nodePreset || undefined,
          systemMode: node.nodeSystemMode || 'replace',
          skillSet: node.nodeSkillSet || undefined,
          toolSetPreset: node.nodeToolSetPreset || undefined,
          caps: (node.nodeCapVision !== undefined || node.nodeCapReasoning !== undefined || node.nodeCapTools !== undefined)
            ? { vision: node.nodeCapVision ?? false, reasoning: node.nodeCapReasoning ?? null, tools: node.nodeCapTools ?? false }
            : undefined,
        }
      : undefined;

    try {
      const output = await dispatchCommand(cmd, sessionId, nodeConfig);
      outputMap.set(node.id, output);
    } catch (e) {
      logger.error('workflow-runner.node-error', { workflowId, nodeId: node.id, error: e.message });
      if (broadcastFn) broadcastFn('workflow:error', { workflowId, nodeId: node.id, sessionId, error: e.message });
      _telemetry()?.record?.({ surface: 'workflow', name: workflowId, sessionId: sessionId || undefined, durationMs: Date.now() - _t0, ok: false, meta: { nodeCount: sorted.length, failedAt: node.id } });
      return sessionId;
    }
  }

  _telemetry()?.record?.({ surface: 'workflow', name: workflowId, sessionId: sessionId || undefined, durationMs: Date.now() - _t0, ok: true, meta: { nodeCount: sorted.length } });
  logger.info('workflow-runner.done', { workflowId, sessionId });
  if (broadcastFn) broadcastFn('workflow:done', { workflowId, sessionId });
  return sessionId;
}

module.exports = { runWorkflow };
