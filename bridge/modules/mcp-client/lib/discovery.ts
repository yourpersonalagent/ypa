// ── Skill/command discovery + grouped tool list builder ─────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const { mcpConnections } = require('../../../core/state');
const { readUpstreamRegistry } = require('./state');
const { listModuleSkills } = require('../../../core/modules');

const BRIDGE_DIR = path.join(__dirname, '..', '..', '..');
const CONFIG_SKILLS_DIR = path.join(BRIDGE_DIR, 'skills');
// Q16+: skills resolve through the skills-editor lib, which merges the
// shared `bridge/skills/` dir with any per-user override under
// `bridge/users/<email>/skills/`. We delegate listing to `listSkills()`
// rather than re-reading directories here, so the dedup + ordering rules
// stay in one place.
const _skillsResolver = require('../../skills-editor/lib');

function parseFrontmatterDesc(content) {
  return parseFrontmatterField(content, 'description');
}

function parseFrontmatterField(content, field) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'm');
  const m = fm[1].match(re);
  return m ? m[1].trim() : null;
}

// Enumerate YHA's own skills (config + meta-bridge) so they show in the
// `#` Chat Command Picker alongside other commands that produce direct
// chat output (tools, MCP, codex, local nodes). The `#skill-` prefix is
// what the chatSubmitInterceptor in frontend/src/commands.ts matches to
// expand the skill body and send it through chat. Each item is keyed by
// skill name, so a collision (e.g. a meta skill that shadows a config
// skill of the same name) keeps only the first occurrence — same dedup
// discipline as buildToolGroups.
//
// Note: the `#` prefix here is the on-screen / typed-into-textarea form.
// The `skill-` namespace is still reserved so any `#skill-*` token is
// unambiguously a YHA skill invocation regardless of MCP collisions.
function loadYhaSkills() {
  const out: { cmd: string; desc: string; origin: string; category?: string }[] = [];
  const seen = new Set<string>();
  // Config skills: bridge/skills/*.md (flat) — legacy; usually empty.
  try {
    for (const f of fs.readdirSync(CONFIG_SKILLS_DIR)) {
      if (!f.endsWith('.md')) continue;
      const name = f.slice(0, -3);
      if (seen.has(name)) continue;
      const raw = (() => { try { return fs.readFileSync(path.join(CONFIG_SKILLS_DIR, f), 'utf8'); } catch { return ''; } })();
      const desc = parseFrontmatterDesc(raw) || `YHA skill (config): ${name}`;
      const cat = parseFrontmatterField(raw, 'category') || '';
      out.push({ cmd: `#skill-${name}`, desc, origin: 'yha-config', category: cat });
      seen.add(name);
    }
  } catch (_) {}
  // Meta skills: bridge/skills/<name>/SKILL.md (shared, git-tracked) and
  // bridge/users/<email>/skills/<name>/SKILL.md (per-user override). Use the
  // skills-editor lib's listSkills() which already iterates both roots with
  // shared-first dedup, so callers don't need to re-implement the merge.
  try {
    const skills = _skillsResolver.listSkills ? _skillsResolver.listSkills() : [];
    for (const sk of skills) {
      if (!sk || !sk.name || seen.has(sk.name)) continue;
      const desc = sk.description || `YHA skill (meta): ${sk.name}`;
      out.push({ cmd: `#skill-${sk.name}`, desc, origin: 'yha-meta', category: sk.category || '' });
      seen.add(sk.name);
    }
  } catch (_) {}
  // Module-provided skills: a bridge module that declares `provides.skills:
  // ['<name>', ...]` in its manifest and ships
  // `<moduleDir>/skills/<name>/SKILL.md` shows up here while the module is
  // active. Disabling the module drops the skill on the next /v1/tools/
  // cache roll (TTL 60s, or instant via /v1/tools/refresh).
  try {
    for (const item of listModuleSkills()) {
      if (seen.has(item.name)) continue;
      out.push({ cmd: `#skill-${item.name}`, desc: item.desc, origin: `yha-module:${item.moduleName}`, category: item.category || '' });
      seen.add(item.name);
    }
  } catch (_) {}
  return out.sort((a, b) => a.cmd.localeCompare(b.cmd));
}

function loadInstalledPluginSkills() {
  const pluginsFile = path.join(
    process.env.HOME || process.env.USERPROFILE || require('os').homedir(),
    '.claude',
    'plugins',
    'installed_plugins.json'
  );
  const skills: any[] = [];
  try {
    const data = JSON.parse(fs.readFileSync(pluginsFile, 'utf8'));
    for (const entries of Object.values(data.plugins || {}) as any[]) {
      for (const entry of entries) {
        const skillsDir = path.join(entry.installPath, 'skills');
        let names;
        try {
          names = fs.readdirSync(skillsDir);
        } catch (_) {
          continue;
        }
        for (const skillName of names) {
          const skillMd = path.join(skillsDir, skillName, 'SKILL.md');
          let desc = `Plugin skill`;
          try {
            const d = parseFrontmatterDesc(fs.readFileSync(skillMd, 'utf8'));
            if (d) desc = d;
          } catch (_) {}
          skills.push({ cmd: `/${skillName}`, desc });
        }
      }
    }
  } catch (_) {}
  return skills;
}

function loadUserCommands() {
  const cmdsDir = path.join(process.env.HOME || process.env.USERPROFILE || require('os').homedir(), '.claude', 'commands');
  const cmds: any[] = [];
  try {
    for (const file of fs.readdirSync(cmdsDir).filter((f) => f.endsWith('.md'))) {
      const name = path.basename(file, '.md');
      let desc = `User skill: ${name}`;
      try {
        const d = parseFrontmatterDesc(fs.readFileSync(path.join(cmdsDir, file), 'utf8'));
        if (d) desc = d;
      } catch (_) {}
      cmds.push({ cmd: `/${name}`, desc });
    }
  } catch (_) {}
  return cmds;
}

// ── Build grouped tool list (for /v1/tools/ endpoint) ────────────────────────
async function buildToolGroups() {
  const settings = readUpstreamRegistry();
  const mcpServers = settings.mcpServers || {};

  // Group 1: Claude Slash Commands (built-in + dynamic skills/commands)
  const claudeCommands = [
    { cmd: '/help', desc: 'Show Claude Code help and available commands' },
    { cmd: '/clear', desc: 'Clear conversation history' },
    { cmd: '/compact', desc: 'Compact conversation to save context space' },
    { cmd: '/commit', desc: 'Create a git commit with AI-generated message' },
    { cmd: '/review', desc: 'Review code changes on current branch' },
    { cmd: '/init', desc: 'Initialize CLAUDE.md project documentation' },
    { cmd: '/doctor', desc: 'Check Claude Code installation and config' },
    { cmd: '/cost', desc: 'Show token usage and cost for this session' },
    { cmd: '/status', desc: 'Show Claude Code connection and model status' },
    { cmd: '/model', desc: 'Show or change the active model' },
    { cmd: '/memory', desc: 'Edit Claude Code memory files' },
    { cmd: '/permissions', desc: 'View and manage tool permissions' },
    { cmd: '/config', desc: 'Open Claude Code settings' },
    { cmd: '/bug', desc: 'Report a bug to the Claude Code team' },
    { cmd: '/upgrade', desc: 'Upgrade Claude Code to the latest version' },
    { cmd: '/logout', desc: 'Log out of Claude Code' },
    { cmd: '/login', desc: 'Log in to Claude Code' },
  ];

  // Append dynamically discovered skills (plugin + user commands), no duplicates
  const existingCmds = new Set(claudeCommands.map((c) => c.cmd));
  for (const s of [...loadInstalledPluginSkills(), ...loadUserCommands()]) {
    if (!existingCmds.has(s.cmd)) {
      claudeCommands.push(s);
      existingCmds.add(s.cmd);
    }
  }

  // Group 2: Claude Built-in Tools
  const claudeTools = [
    { cmd: '#read', desc: 'Read file contents: #read <path>', toolName: 'Read' },
    { cmd: '#write', desc: 'Write file: #write <path> <content>', toolName: 'Write' },
    { cmd: '#edit', desc: 'Edit file (replace string): #edit <path>', toolName: 'Edit' },
    { cmd: '#multiedit', desc: 'Multiple file edits in one operation', toolName: 'MultiEdit' },
    { cmd: '#bash', desc: 'Run shell command: #bash <command>', toolName: 'Bash' },
    { cmd: '#powershell', desc: 'Run PowerShell command: #powershell <command>', toolName: 'PowerShell' },
    { cmd: '#glob', desc: 'Find files by pattern: #glob <pattern>', toolName: 'Glob' },
    { cmd: '#grep', desc: 'Search file contents: #grep <pattern> [path]', toolName: 'Grep' },
    { cmd: '#webfetch', desc: 'Fetch URL content: #webfetch <url>', toolName: 'WebFetch' },
    { cmd: '#search', desc: 'Web search (Tavily → Exa → Google CSE → Bing → DDG fallback): #search <query>', toolName: 'WebSearch' },
    { cmd: '#task', desc: 'Spawn a subagent for a parallel task: #task <goal>', toolName: 'Task' },
    { cmd: '#todoread', desc: 'Read the current task list', toolName: 'TodoRead' },
    { cmd: '#todowrite', desc: 'Create or update task list: #todowrite', toolName: 'TodoWrite' },
    {
      cmd: '#notebook',
      desc: 'Read a Jupyter notebook: #notebook <path>',
      toolName: 'NotebookRead',
    },
  ];

  // Group 3: MCP Tools — only from servers currently running and connected
  // Dedupe against claudeTools so an MCP tool whose name collides with a built-in
  // (e.g. websearch's `search` vs. the bridge `WebSearch` mapped to `#search`)
  // doesn't show twice. The built-in entry takes precedence; the MCP one is
  // skipped because both routes ultimately call the same orchestrator anyway.
  const claudeToolCmds = new Set(claudeTools.map((c) => c.cmd));
  const mcpItems: any[] = [];
  for (const [serverName] of Object.entries(mcpServers)) {
    const conn = mcpConnections.get(serverName);
    let isRunning = false;
    try { isRunning = !!require('./protocol').isMcpConnAlive(conn) && !!conn.ok; }
    catch (_) { isRunning = !!(conn?.proc && conn.proc.exitCode === null && !conn.proc.killed && conn.ok); }
    if (isRunning && conn.tools?.length) {
      for (const t of conn.tools) {
        const cmd = `#${t.name}`;
        if (claudeToolCmds.has(cmd)) continue;
        mcpItems.push({
          cmd,
          desc: `[${serverName}] ${t.desc}`,
          server: serverName,
          toolName: t.name,
        });
      }
    }
    // offline servers: show nothing — they appear in the MCP management panel instead
  }

  // Group 4: Codex tool namespaces/functions exposed by the Codex harness.
  const codexTools = [
    {
      cmd: '#functions.exec_command',
      desc: 'Run shell commands in the workspace terminal',
      toolName: 'functions.exec_command',
    },
    {
      cmd: '#functions.apply_patch',
      desc: 'Edit files with structured patches',
      toolName: 'functions.apply_patch',
    },
    {
      cmd: '#functions.update_plan',
      desc: 'Track and update a structured task plan',
      toolName: 'functions.update_plan',
    },
    {
      cmd: '#functions.spawn_agent',
      desc: 'Spawn a delegated sub-agent',
      toolName: 'functions.spawn_agent',
    },
    {
      cmd: '#functions.send_input',
      desc: 'Send follow-up input to a sub-agent',
      toolName: 'functions.send_input',
    },
    {
      cmd: '#functions.wait_agent',
      desc: 'Wait for sub-agent completion',
      toolName: 'functions.wait_agent',
    },
    {
      cmd: '#functions.close_agent',
      desc: 'Close a finished sub-agent',
      toolName: 'functions.close_agent',
    },
    { cmd: '#web.search_query', desc: 'Search the web', toolName: 'web.search_query' },
    { cmd: '#web.open', desc: 'Open a web page result', toolName: 'web.open' },
    { cmd: '#web.find', desc: 'Find text inside an opened page', toolName: 'web.find' },
    { cmd: '#web.click', desc: 'Follow a link from an opened page', toolName: 'web.click' },
    { cmd: '#web.finance', desc: 'Fetch finance/market data', toolName: 'web.finance' },
    { cmd: '#web.weather', desc: 'Fetch weather data', toolName: 'web.weather' },
    {
      cmd: '#multi_tool_use.parallel',
      desc: 'Run multiple developer tools in parallel',
      toolName: 'multi_tool_use.parallel',
    },
  ];

  // Group 5: Local node types
  const localItems = [
    { cmd: '#debug', desc: 'Inspect internal state: #debug [overview|monitoring|modeltracker|mcp|toolsmon|costs|tokens|chathistory|routing]' },
    {
      cmd: '#note',
      desc: 'Private annotation — sits in history, included as context on next send',
    },
    {
      cmd: '#btw',
      desc: 'Mid-response addition — injected into the running stream at the next tool boundary',
    },
    { cmd: '#if', desc: 'Decision/branch node — dual output (true / false)' },
    { cmd: '#trigger', desc: 'Automation trigger — timer, daily, website change, data' },
    {
      cmd: '#session',
      desc: 'Switch session: #session 0 | #session <n> | #session "name"  (1 = last session)',
    },
    { cmd: '#ns', desc: 'New session — start a normal new chat' },
    { cmd: '#models', desc: 'List available LLM models with IDs' },
    { cmd: '#m', desc: 'Switch LLM model: #m <id>  (use #models to list IDs)' },
    { cmd: '#imgm', desc: 'Switch image model: #imgm <id>' },
    { cmd: '#vidm', desc: 'Switch video model: #vidm <id>' },
    { cmd: '#audm', desc: 'Switch audio model: #audm <id>' },
  ];

  // Group 6: YHA Skills — config + meta skills surfaced as #skill-<name>
  // chat-tool commands. They live in the `#` Chat Command Picker because
  // expanding a skill produces a user-message in chat (direct chat output).
  // The "skill-" sub-namespace is reserved so `#skill-*` never collides
  // with built-in `#` tools (`#read`, `#bash`, …) or MCP tools.
  const yhaSkills = loadYhaSkills();

  return [
    { id: 'claude-commands', label: 'Claude Commands', claudeOnly: true, items: claudeCommands },
    { id: 'claude-tools', label: 'Tools', claudeOnly: false, items: claudeTools },
    { id: 'claude-mcp', label: 'MCP Tools', claudeOnly: false, items: mcpItems },
    { id: 'codex-tools', label: 'Codex Tools', claudeOnly: false, items: codexTools },
    { id: 'local', label: 'Local', claudeOnly: false, items: localItems },
    { id: 'yha-skills', label: 'Skills', claudeOnly: false, items: yhaSkills },
  ];
}

let _toolGroupsCache: any = null;
let _toolGroupsCacheAt = 0;
const TOOL_GROUPS_TTL_MS = 60_000;

function invalidateToolGroupsCache() {
  _toolGroupsCache = null;
  _toolGroupsCacheAt = 0;
}

async function getToolGroups() {
  if (!_toolGroupsCache || Date.now() - _toolGroupsCacheAt > TOOL_GROUPS_TTL_MS) {
    _toolGroupsCache = await buildToolGroups();
    _toolGroupsCacheAt = Date.now();
  }
  return _toolGroupsCache;
}

module.exports = {
  buildToolGroups,
  getToolGroups,
  invalidateToolGroupsCache,
};
