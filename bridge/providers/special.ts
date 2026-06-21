// ── Special command handler ───────────────────────────────────────────────────
'use strict';

const { activeModels } = require('../core/state');
const { persistActiveModels, clearHistory } = require('../sessions-internal');
const { buildModelList } = require('../models');
const { getModuleApi } = require('../core/modules');
const rewind = require('../core/rewind');

// `runDebugCommand` and `buildChathistoryDebug` live in the
// observability-plus module's debug.ts. Resolve them on every call
// through getModuleApi so disabling the module yields a clear error
// payload instead of crashing the special-command router.
function runDebugCommand(sessionId, subcmd, args) {
  const obs = getModuleApi<any>('observability-plus');
  if (!obs?.debug?.runDebugCommand) {
    const msg = '[debug] observability-plus module is disabled';
    return { handled: true, silent: true, response: msg, chatHistory: [msg] };
  }
  return obs.debug.runDebugCommand(sessionId, subcmd, args);
}

function buildChathistoryDebug(sessionId) {
  const obs = getModuleApi<any>('observability-plus');
  if (!obs?.debug?.buildChathistoryDebug) {
    return { error: 'observability-plus module is disabled', sessionId };
  }
  return obs.debug.buildChathistoryDebug(sessionId);
}

// ── /rewind helpers ──────────────────────────────────────────────────────────
// UUID v4 shape — distinguishes `/rewind <id>` from `/rewind <N>`. If it
// matches the pattern, treat the arg as an id. Anything else numeric is N.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function _summarizeRecord(rec: any): string {
  const files = Array.isArray(rec.files) ? rec.files : [];
  const ops: Record<string, number> = {};
  for (const f of files) ops[f.op] = (ops[f.op] || 0) + 1;
  const opsStr = Object.entries(ops).map(([k, v]) => `${v} ${k}`).join(', ') || '0 files';
  const short = String(rec.id || '').slice(0, 8);
  return `${short} (${rec.module || '?'}, ${rec.trigger || '?'}, ${opsStr})`;
}

function _summarizeResult(res: any): string {
  const w = res.written?.length || 0;
  const d = res.deleted?.length || 0;
  const e = res.errors?.length || 0;
  const parts: string[] = [];
  if (w) parts.push(`${w} restored`);
  if (d) parts.push(`${d} deleted`);
  if (e) parts.push(`${e} errors`);
  return parts.join(', ') || 'nothing changed';
}

async function handleRewindCmd(rawArg: string | undefined) {
  const wd = rewind.defaultWd();
  const arg = (rawArg || '').trim();

  // Wait briefly for in-flight tool calls to finish before snapping —
  // otherwise we might restore a file the model is still writing, then
  // the model's pending write lands on top and our restore is invisible.
  // Timeout is intentionally short: a runaway never-returning tool must
  // not pin /rewind forever; we'd rather proceed and let the user retry.
  let quietNote = '';
  const quiet = await rewind.waitForQuiescence(2000);
  if (!quiet) {
    quietNote = ` (warning: ${rewind.getInFlightToolCount()} tool call(s) still in flight; proceeded anyway)`;
  }

  // /rewind <id>
  if (arg && UUID_RE.test(arg)) {
    const rec = rewind.readRecordById(wd, arg);
    if (!rec) {
      const msg = `No rewind record with id ${arg.slice(0, 8)}…`;
      return { handled: true, response: msg, chatHistory: [msg] };
    }
    const res = rewind.restoreRecord(rec);
    const head = `Rewound ${_summarizeRecord(rec)}: ${_summarizeResult(res)}${quietNote}`;
    const lines = [head];
    for (const f of res.written) lines.push(`  ↩ ${f}`);
    for (const f of res.deleted) lines.push(`  ✗ ${f}`);
    for (const e of res.errors) lines.push(`  ! ${e}`);
    return { handled: true, response: lines.join('\n'), chatHistory: lines };
  }

  // /rewind <N>
  let n = 1;
  if (arg) {
    const parsed = Number(arg);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      const msg = `Usage: /rewind  |  /rewind <N>  |  /rewind <record-id>`;
      return { handled: true, response: msg, chatHistory: [msg] };
    }
    n = parsed;
  }

  const recs = rewind.listRecentRecords(wd, n);
  if (recs.length === 0) {
    const msg = 'No rewind records to undo.';
    return { handled: true, response: msg, chatHistory: [msg] };
  }

  const summaries: string[] = [`Rewinding ${recs.length} record(s) (newest first):${quietNote}`];
  for (const rec of recs) {
    const res = rewind.restoreRecord(rec);
    summaries.push(`• ${_summarizeRecord(rec)} → ${_summarizeResult(res)}`);
    for (const e of (res.errors || [])) summaries.push(`    ! ${e}`);
  }
  return { handled: true, response: summaries.join('\n'), chatHistory: summaries };
}

function handleSpecial(input, sessionId) {
  const cmd = String(input).trim();

  if (cmd === '#allmodels' || cmd === '#models') {
    const models = buildModelList();
    const lines = models.map((m) => `${m.id}: ${m.name} - ${m.provider}`);
    return { handled: true, response: lines.join('\n'), chatHistory: lines };
  }

  const mSwitch = cmd.match(/^#m\s+(\d+)(\s+.*)?$/);
  if (mSwitch) {
    const id = parseInt(mSwitch[1], 10);
    const models = buildModelList();
    const target = models.find((m) => m.id === id);
    if (target) {
      activeModels.llm = { model: target.name, provider: target.provider };
      persistActiveModels();
      const msg = `Switched to ${target.name} (${target.provider})`;
      return { handled: true, response: msg, chatHistory: [msg] };
    }
    return {
      handled: true,
      response: `Model ${id} not found`,
      chatHistory: [`Model ${id} not found`],
    };
  }

  const imgSwitch = cmd.match(/^#imgm\s+(\d+)$/);
  if (imgSwitch) {
    const id = parseInt(imgSwitch[1], 10);
    const target = buildModelList().find((m) => m.id === id);
    if (target) {
      activeModels.image = { model: target.name, provider: target.provider };
      persistActiveModels();
      const msg = `Image model switched to ${target.name}`;
      return { handled: true, response: msg, chatHistory: [msg] };
    }
    return {
      handled: true,
      response: `Model ${id} not found`,
      chatHistory: [`Model ${id} not found`],
    };
  }

  const vidSwitch = cmd.match(/^#vidm\s+(\d+)$/);
  if (vidSwitch) {
    const id = parseInt(vidSwitch[1], 10);
    const target = buildModelList().find((m) => m.id === id);
    if (target) {
      activeModels.video = { model: target.name, provider: target.provider };
      persistActiveModels();
      const msg = `Video model switched to ${target.name}`;
      return { handled: true, response: msg, chatHistory: [msg] };
    }
    return {
      handled: true,
      response: `Model ${id} not found`,
      chatHistory: [`Model ${id} not found`],
    };
  }

  const audSwitch = cmd.match(/^#audm\s+(\d+)$/);
  if (audSwitch) {
    const id = parseInt(audSwitch[1], 10);
    const target = buildModelList().find((m) => m.id === id);
    if (target) {
      activeModels.audio = { model: target.name, provider: target.provider };
      persistActiveModels();
      const msg = `Audio model switched to ${target.name}`;
      return { handled: true, response: msg, chatHistory: [msg] };
    }
    return {
      handled: true,
      response: `Model ${id} not found`,
      chatHistory: [`Model ${id} not found`],
    };
  }

  if (cmd === '#clear') {
    clearHistory(sessionId);
    return { handled: true, response: 'History cleared.', chatHistory: ['History cleared.'] };
  }

  if (cmd === '#help') {
    const help = [
      'Claude Commands: /review /commit /init /clear /compact /cost /status …',
      'Claude Tools:    #read #write #edit #bash #powershell #glob #grep #webfetch',
      'Local:           #note  #btw  #if  #trigger  #session  #ns',
      'Models:          #models  #m <id>  #clear',
    ].join('\n');
    return { handled: true, response: help, chatHistory: [help] };
  }

  if (cmd === '/clear') {
    clearHistory(sessionId);
    return {
      handled: true,
      response: 'Conversation cleared.',
      chatHistory: ['Conversation cleared.'],
    };
  }

  if (cmd === '/compact') {
    clearHistory(sessionId);
    return {
      handled: true,
      response: 'Context compacted (history cleared).',
      chatHistory: ['Context compacted.'],
    };
  }

  // /rewind — three forms:
  //   /rewind          → undo the most recent edit
  //   /rewind <N>      → undo the last N edits (newest first)
  //   /rewind <id>     → undo a specific record by id (uuid)
  // Records are scoped to the bridge's wd (defaults to process.cwd()).
  // The Go service in cmd/yha-rewind/main.go has a parallel implementation
  // for the bridge-is-down case; this path is what the live system uses
  // when the user just types into chat.
  const rewindMatch = cmd.match(/^\/rewind(?:\s+(.+))?$/);
  if (rewindMatch) {
    return handleRewindCmd(rewindMatch[1]);
  }

  if (cmd.startsWith('#debug')) {
    const parts = cmd.split(/\s+/);
    return runDebugCommand(sessionId, parts[1], parts.slice(2));
  }

  return { handled: false };
}

module.exports = {
  handleSpecial,
  buildChathistoryDebug,
};
