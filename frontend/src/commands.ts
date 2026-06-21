// Command helper — fetches tool groups from bridge /v1/tools/ on boot.
//
// Groups: claude-commands | claude-tools | claude-mcp | local
//
// Behaviour rules:
//  - Typing '#' opens the picker; typing '/' also opens it for slash commands
//  - Picking a /command sets textarea to "/command " (no # prepended)
//  - Picking a #command sets textarea to "#command "
//  - Cancelling (Escape / outside click) removes the lone trigger prefix char
//    from the textarea (but leaves anything the user already typed beyond it)
//  - Claude Commands and Claude Tools are marked [CC] and disabled-looking
//    when the active model is not a Claude model

import { getAppState, getAppActions } from './stores/index.js';
import { useActiveModelsStore } from './stores/activeModelsStore.js';
import { buildMediaTurn } from './composer/mediaTurn.js';
import { api } from './api.js';
import { bus } from './state.js';
import { isBridgeModuleEnabledStrict, whenBridgeModuleEnabled } from './host/bridge-modules.js';
import { registers } from './host/keys.js';
import { chat } from './chat.js';

interface CommandItem {
  cmd: string;
  desc: string;
  toolName?: string;
}

interface CommandGroup {
  id: string;
  label: string;
  claudeOnly: boolean;
  items: CommandItem[];
}

interface FlatItem {
  _header?: boolean;
  label?: string;
  cmd?: string;
  desc?: string;
  toolName?: string;
  groupId: string;
  claudeOnly: boolean;
}

export const commands = (() => {
  // ── Fallback groups (shown before bridge responds) ────────────────────────
  const FALLBACK_GROUPS: CommandGroup[] = [
    {
      id: 'claude-tools',
      label: 'Claude Tools',
      claudeOnly: false,
      items: [
        { cmd: '#read', desc: 'Read file: #read <path>', toolName: 'Read' },
        { cmd: '#write', desc: 'Write file: #write <path>', toolName: 'Write' },
        { cmd: '#edit', desc: 'Edit file (replace): #edit <path>', toolName: 'Edit' },
        { cmd: '#bash', desc: 'Run shell command: #bash <cmd>', toolName: 'Bash' },
        { cmd: '#powershell', desc: 'Run PowerShell command: #powershell <cmd>', toolName: 'PowerShell' },
        { cmd: '#glob', desc: 'Find files: #glob <pattern>', toolName: 'Glob' },
        { cmd: '#grep', desc: 'Search content: #grep <pattern>', toolName: 'Grep' },
        { cmd: '#webfetch', desc: 'Fetch URL: #webfetch <url>', toolName: 'WebFetch' },
        { cmd: '#task', desc: 'Spawn subagent: #task <goal>', toolName: 'Task' },
        { cmd: '#todoread', desc: 'Read task list', toolName: 'TodoRead' },
        { cmd: '#todowrite', desc: 'Update task list', toolName: 'TodoWrite' },
        { cmd: '#multiedit', desc: 'Multiple file edits in one operation', toolName: 'MultiEdit' },
        {
          cmd: '#notebook',
          desc: 'Read Jupyter notebook: #notebook <path>',
          toolName: 'NotebookRead',
        },
      ],
    },
    {
      id: 'claude-mcp',
      label: 'MCP Tools',
      claudeOnly: true,
      items: [], // populated from bridge
    },
    {
      id: 'codex-tools',
      label: 'Codex Tools',
      claudeOnly: false,
      items: [
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
      ],
    },
    {
      id: 'local',
      label: 'Local',
      claudeOnly: false,
      items: [
        { cmd: '#debug', desc: 'Inspect internal state: #debug [overview|monitoring|rawlog|modeltracker|mcp|toolsmon|costs|tokens|chathistory|routing]' },
        { cmd: '/debug', desc: 'Same as #debug — open the debug modal: /debug [overview|monitoring|mcp|tokens|…]' },
        {
          cmd: '#note',
          desc: 'Private annotation — sits in history, included as context on next send',
        },
        {
          cmd: '#btw',
          desc: 'Mid-response addition — injected into the running stream at the next tool boundary',
        },
        { cmd: '#if', desc: 'Decision/branch node — dual output (true / false)' },
        { cmd: '#trigger', desc: 'Automation trigger — timer, daily, website, data' },
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
        // /pet commands moved to the `/` App Command Palette under
        // `module:pet` (frontend/src/modules/pet/index.ts). They were
        // listed here pre-modularity; the chatSubmitInterceptor still
        // handles a literal `/pet …` typed into chat.
      ],
    },
    {
      id: 'claude-commands',
      label: 'Claude Commands',
      claudeOnly: true,
      items: [
        { cmd: '/review', desc: 'Review code changes on current branch' },
        { cmd: '/commit', desc: 'Create git commit with AI-generated message' },
        { cmd: '/init', desc: 'Initialize CLAUDE.md project documentation' },
        { cmd: '/compact', desc: 'Compact conversation to save context' },
        { cmd: '/cost', desc: 'Show session token usage and cost' },
        { cmd: '/clear', desc: 'Clear conversation history' },
        { cmd: '/status', desc: 'Show model and connection status' },
        { cmd: '/memory', desc: 'Edit Claude Code memory files' },
        { cmd: '/permissions', desc: 'View tool permissions' },
        { cmd: '/config', desc: 'Open Claude Code settings' },
        { cmd: '/help', desc: 'Show Claude Code help' },
      ],
    },
  ];

  let groups: CommandGroup[] = FALLBACK_GROUPS.map((g) => ({ ...g, items: [...g.items] }));

  // Toggle: include Claude Code's built-in /commands (/help, /clear, …) in the
  // pickers. Persists in localStorage; default ON to preserve existing behavior.
  // Set from the Harness preferences tab.
  let showClaudeCommands: boolean = (() => {
    try { return localStorage.getItem('yha.showClaudeCommands') !== '0'; }
    catch { return true; }
  })();

  function getVisibleGroups(): CommandGroup[] {
    if (showClaudeCommands) return groups;
    return groups.filter((g) => g.id !== 'claude-commands');
  }

  function setShowClaudeCommands(v: boolean): void {
    showClaudeCommands = !!v;
    try { localStorage.setItem('yha.showClaudeCommands', showClaudeCommands ? '1' : '0'); }
    catch { /* ignore */ }
    bus.emit('commands:loaded', getVisibleGroups());
  }

  function getShowClaudeCommands(): boolean {
    return showClaudeCommands;
  }

  // ── Flat list helpers ─────────────────────────────────────────────────────
  // Each entry is either a header sentinel {_header, label, groupId, claudeOnly}
  // or a command item {cmd, desc, groupId, claudeOnly, ...}.
  function buildFlat(grps: CommandGroup[]): FlatItem[] {
    const out: FlatItem[] = [];
    for (const g of grps) {
      if (!g.items.length) continue;
      out.push({ _header: true, label: g.label, groupId: g.id, claudeOnly: !!g.claudeOnly });
      for (const item of g.items) out.push({ ...item, groupId: g.id, claudeOnly: !!g.claudeOnly });
    }
    return out;
  }

  function filterFlat(grps: CommandGroup[], query: string): FlatItem[] {
    const q = query.toLowerCase().replace(/^[#/]/, '');
    if (!q) return buildFlat(grps);

    // Rank each item: 0 = exact, 1 = cmd starts with query, 2 = cmd contains query, 3 = desc only
    function rank(i: CommandItem): number {
      const cmd = i.cmd.toLowerCase().replace(/^[#/]/, '');
      if (cmd === q) return 0;
      if (cmd.startsWith(q)) return 1;
      if (cmd.includes(q)) return 2;
      if (i.desc.toLowerCase().includes(q)) return 3;
      return 99;
    }

    // Collect all matching items across all groups (flat, no headers yet)
    const allHits: { item: CommandItem; group: CommandGroup; rank: number }[] = [];
    for (const g of grps) {
      for (const i of g.items) {
        const r = rank(i);
        if (r < 99) allHits.push({ item: i, group: g, rank: r });
      }
    }

    // Sort by rank first, then preserve original group order as tiebreak
    allHits.sort((a, b) => a.rank - b.rank);

    // Re-bucket into groups (preserving sorted order) so headers still show
    const seen = new Map<string, CommandItem[]>(); // groupId → [items]
    const groupOrder: CommandGroup[] = [];
    for (const { item, group } of allHits) {
      if (!seen.has(group.id)) {
        seen.set(group.id, []);
        groupOrder.push(group);
      }
      seen.get(group.id)!.push(item);
    }

    const out: FlatItem[] = [];
    for (const g of groupOrder) {
      out.push({ _header: true, label: g.label, groupId: g.id, claudeOnly: !!g.claudeOnly });
      for (const h of seen.get(g.id)!) out.push({ ...h, groupId: g.id, claudeOnly: !!g.claudeOnly });
    }
    return out;
  }

  function isClaudeActive(): boolean {
    return /^claude-/i.test(String(getAppState().currentModel?.name || ''));
  }

  // ── Fetch tools from bridge ───────────────────────────────────────────────
  // /v1/tools/ is owned by the `mcp-client` bridge module (see
  // bridge/modules/mcp-client/index.ts). Skip the fetch when mcp-client is off
  // — otherwise it 404s on every boot for users who run without MCP.
  async function fetchTools(): Promise<void> {
    if (!isBridgeModuleEnabledStrict('mcp-client')) return;
    try {
      const res = await fetch(api.config.baseUrl + '/v1/tools/', { mode: 'cors' });
      if (!res.ok) return;
      const data = (await res.json()) as { groups?: CommandGroup[] };
      if (!data.groups) return;

      const merged = [...data.groups];
      // Ensure local group always present
      const bridgeIds = new Set(data.groups.map((g) => g.id));
      if (!bridgeIds.has('local')) {
        const local = FALLBACK_GROUPS.find((g) => g.id === 'local');
        if (local) merged.push(local);
      }
      // claude-commands (/ slash commands) always last
      const ccIdx = merged.findIndex((g) => g.id === 'claude-commands');
      if (ccIdx > -1) merged.push(merged.splice(ccIdx, 1)[0]);

      groups = merged;
      // Notify React CommandPicker (and any other subscriber) — without this
      // emit, the picker's mount-time sync grabs an empty list and never
      // updates, so clicking the # button shows nothing.
      bus.emit('commands:loaded', getVisibleGroups());
    } catch (e) {
      console.warn('commands: fetchTools failed:', (e as Error).message);
    }
  }

  // ── Add-node popover state ────────────────────────────────────────────────
  // (Chat textarea picker is handled entirely by ChatInput.tsx / CommandPicker.tsx)
  let addPop: HTMLElement = null!;
  let addInput: HTMLInputElement = null!;
  let addList: HTMLElement = null!;
  let selectedIdx = 0;
  let addOutsideHandler: ((e: MouseEvent) => void) | null = null;
  let addPickCallback: ((cmd: string) => void) | null = null;

  function init(): void {
    const pop = document.getElementById('add-node') as HTMLElement | null;
    const input = document.getElementById('add-node-input') as HTMLInputElement | null;
    const list = document.getElementById('add-node-list') as HTMLElement | null;

    // React may not have committed yet (or a portal crash unmounted the tree).
    // Retry via MutationObserver so the popover wires up once the DOM exists.
    if (!pop || !input || !list) {
      const obs = new MutationObserver(() => {
        if (
          document.getElementById('add-node') &&
          document.getElementById('add-node-input') &&
          document.getElementById('add-node-list')
        ) {
          obs.disconnect();
          init();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      return;
    }

    addPop = pop;
    addInput = input;
    addList = list;

    addInput.addEventListener('input', () => renderAddList(addInput.value));
    addInput.addEventListener('keydown', onAddKey);

    // Defer the boot-time tool fetch until the bridge confirms mcp-client
    // is enabled. The fetchTools call sites elsewhere keep the inline gate
    // so user-initiated re-fetches don't queue up forever when MCP is off.
    whenBridgeModuleEnabled('mcp-client', () => { fetchTools(); });
  }

  function getCommandGroups(): CommandGroup[] {
    return getVisibleGroups();
  }

  function getAddNodeGroups(): CommandGroup[] {
    const addGroups = getVisibleGroups().map((g) => ({ ...g, items: [...(g.items || [])] }));
    const hasChatItem = addGroups.some((g) => (g.items || []).some((item) => item.cmd === 'chat'));
    if (hasChatItem) return addGroups;

    const localGroup = addGroups.find((g) => g.id === 'local');
    const chatItem: CommandItem = {
      cmd: 'chat',
      desc: 'Plain chat/prompt node — same behavior as a normal chat prompt',
    };
    if (localGroup) localGroup.items.unshift(chatItem);
    else addGroups.unshift({ id: 'local', label: 'Local', claudeOnly: false, items: [chatItem] });
    return addGroups;
  }

  // ── Add-node popover ──────────────────────────────────────────────────────
  function openAddNode(clientX: number, clientY: number, callback: (cmd: string) => void): void {
    addPickCallback = callback;
    addInput.value = '';
    selectedIdx = 0;
    renderAddList('');
    const pw = 420;
    const left = Math.max(8, Math.min(window.innerWidth - pw - 8, clientX));
    const top = Math.max(8, Math.min(window.innerHeight - 380, clientY));
    addPop.style.left = left + 'px';
    addPop.style.top = top + 'px';
    addPop.hidden = false;
    setTimeout(() => addInput.focus(), 0);
    setTimeout(() => {
      addOutsideHandler = (e) => {
        if (addPop.hidden) return;
        if (addPop.contains(e.target as Node)) return;
        closeAddNode();
      };
      document.addEventListener('mousedown', addOutsideHandler, true);
    }, 0);
  }

  function closeAddNode(): void {
    addPop.hidden = true;
    addPickCallback = null;
    if (addOutsideHandler) {
      document.removeEventListener('mousedown', addOutsideHandler, true);
      addOutsideHandler = null;
    }
  }

  function renderAddList(filter: string): void {
    const flat = filterFlat(getAddNodeGroups(), filter);
    const sel = flat.filter((i) => !i._header);
    selectedIdx = 0;
    const claudeActive = isClaudeActive();

    addList.innerHTML = flat
      .map((item) => {
        if (item._header) {
          const dimmed =
            item.claudeOnly && !claudeActive
              ? ' <span class="cmd-badge-dim">Claude only</span>'
              : '';
          return `<div class="popover-group-header">${esc(item.label)}${dimmed}</div>`;
        }
        const selIdx = sel.indexOf(item);
        const isSel = selIdx === 0;
        const dimmed = item.claudeOnly && !claudeActive ? ' cmd-item-dim' : '';
        const badge = groupBadge(item.groupId);
        return `<div class="popover-item${isSel ? ' selected' : ''}${dimmed}" data-cmd="${esc(item.cmd)}" data-idx="${selIdx}">
        <span class="cmd-label">${esc(item.cmd)}</span>${badge}<span class="dim">${esc(item.desc)}</span>
      </div>`;
      })
      .join('');

    addList.querySelectorAll<HTMLElement>('.popover-item').forEach((el) =>
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const cmd = el.dataset.cmd!;
        const cb = addPickCallback;
        closeAddNode();
        if (cb) cb(cmd);
      })
    );
  }

  function onAddKey(e: KeyboardEvent): void {
    const flat = filterFlat(getAddNodeGroups(), addInput.value);
    const sel = flat.filter((i) => !i._header);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(sel.length - 1, selectedIdx + 1);
      addList
        .querySelectorAll<HTMLElement>('.popover-item')
        .forEach((el) => el.classList.toggle('selected', +el.dataset.idx! === selectedIdx));
      const s = addList.querySelector<HTMLElement>('.selected');
      if (s) s.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(0, selectedIdx - 1);
      addList
        .querySelectorAll<HTMLElement>('.popover-item')
        .forEach((el) => el.classList.toggle('selected', +el.dataset.idx! === selectedIdx));
    } else if (e.key === 'Enter' || e.key === 'Tab' || e.key === ' ') {
      e.preventDefault();
      const free = addInput.value.trim();
      const picked = sel[selectedIdx]?.cmd || free;
      if (!picked) return;
      const cb = addPickCallback;
      closeAddNode();
      if (cb) cb(picked);
    } else if (e.key === 'Escape') {
      closeAddNode();
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function esc(s: unknown): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    };
    return String(s ?? '').replace(/[&<>"]/g, (c) => map[c] || c);
  }

  function groupBadge(groupId: string): string {
    return (
      ({
        'claude-commands': '<span class="cmd-badge cc">CC</span>',
        'claude-tools': '<span class="cmd-badge ct">Tool</span>',
        'codex-tools': '<span class="cmd-badge oc">OC</span>',
        'claude-mcp': '<span class="cmd-badge mcp">MCP</span>',
        local: '<span class="cmd-badge loc">Local</span>',
        'yha-skills': '<span class="cmd-badge loc">Skill</span>',
      } as Record<string, string>)[groupId] || ''
    );
  }

  // Intercept local bridge-handled commands before they reach the AI.
  // Matches everything handleSpecial() in bridge/providers/special.ts recognises.
  registers.chatSubmitInterceptors.add(
    {
      id: 'local-bridge-commands',
      handle(text, _ctx) {
        const cmd = text.trim();
        // #debug is intentionally excluded — it has a dedicated path in
        // chat/chat-streaming.ts that fetches /v1/debug/<sub> and opens the
        // debug modal. Intercepting here would short-circuit that and just
        // echo the bridge's one-line summary into chat.
        if (!/^#(models|allmodels|m(\s|$)|imgm\s|vidm\s|audm\s|clear$|help$)/i.test(cmd)) {
          return false;
        }
        chat.pushMessage({ role: 'user', text: cmd });
        api.exec(cmd)
          .then((data: unknown) => {
            const d = data as Record<string, unknown>;
            if (d?.response) chat.pushMessage({ role: 'agent', text: String(d.response) });
            // Sync frontend store when switching LLM model
            const mMatch = cmd.match(/^#m\s+(\d+)/);
            if (mMatch && d?.response && !String(d.response).includes('not found')) {
              const id = parseInt(mMatch[1], 10);
              const models = (getAppState() as unknown as Record<string, unknown>).models as Array<{ id: number; name: string; provider?: string }> | undefined;
              const found = models?.find((m) => m.id === id);
              if (found) {
                getAppActions().setCurrentModel(found as Parameters<ReturnType<typeof getAppActions>['setCurrentModel']>[0]);
              }
            }
          })
          .catch((err: Error) => {
            chat.pushMessage({ role: 'error', text: err.message });
          });
        return true;
      },
    },
    'commands',
  );

  // Execute one or more chained YHA skills when the user submits
  // `#skill-<name> [#skill-<name> ...] [args]`. The "skill-" sub-namespace
  // is reserved: any leading `#skill-*` token is treated as a YHA skill
  // invocation, independent of whether the /v1/tools/ payload has loaded
  // yet — which matters because chat-submit can fire before fetchTools
  // resolves. We fetch each skill's Markdown body and send the
  // concatenated bodies as the user message, with any trailing text
  // appended as "User input" or an "ask before proceeding" hint when
  // bare.
  //
  // Chaining: tokens must be whitespace-separated (`#skill-a #skill-b`).
  // `#skill-a#skill-b` (no separator) is *not* a chain — the lookahead
  // after the name forces a `\s|$` boundary so we don't silently split
  // names that happen to abut. Anything after the last skill token is
  // user args for the combined invocation.
  //
  // Why `#` and not `/`: skills produce direct chat output (the expanded
  // skill body becomes a user message), so they belong to the `#` Chat
  // Command Picker. The `/` App Command Palette is reserved for
  // interface / settings / module commands that never enter the chat
  // stream. See LayoutPlan.md §Two-surface design.
  registers.chatSubmitInterceptors.add(
    {
      id: 'yha-skills-hash',
      handle(text, _ctx) {
        const trimmed = text.trim();
        const TOKEN_RE = /^#skill-([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63})(?=\s|$)/;
        const names: string[] = [];
        let rest = trimmed;
        while (true) {
          const m = rest.match(TOKEN_RE);
          if (!m) break;
          names.push(m[1]);
          rest = rest.slice(m[0].length).replace(/^\s+/, '');
        }
        if (names.length === 0) return false;
        const args = rest;

        // Fire-and-forget: we claim the message (return true) so the input
        // clears, then async-fetch each skill body + send the expansion.
        void (async () => {
          // Lookup order: meta-skills → config-skills → module-provided.
          // Module-provided is last so a meta/config skill can intentionally
          // shadow a module's offering (e.g. a user-edited override that
          // tweaks the module's prompt without forking the module).
          type SkillResult = { body: string; fm: Record<string, string> };
          const fetchSkill = async (name: string): Promise<SkillResult | null> => {
            for (const path of [
              `/v1/meta/skills/${encodeURIComponent(name)}`,
              `/v1/config/skills/${encodeURIComponent(name)}`,
              `/v1/modules/skills/${encodeURIComponent(name)}`,
            ]) {
              try {
                const r = await fetch(api.config.baseUrl + path);
                if (!r.ok) continue;
                const d = (await r.json()) as { content?: string };
                if (!d.content) continue;
                const raw = d.content;
                // Parse YAML frontmatter for metadata the interceptor needs.
                const fm: Record<string, string> = {};
                const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
                if (fmMatch) {
                  for (const line of fmMatch[1].split('\n')) {
                    const colon = line.indexOf(':');
                    if (colon === -1) continue;
                    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
                  }
                }
                const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
                return { body, fm };
              } catch { /* try next source */ }
            }
            return null;
          };

          const results = await Promise.all(names.map(fetchSkill));
          const missing: string[] = [];
          const skills: Array<SkillResult & { name: string }> = [];
          for (let i = 0; i < names.length; i++) {
            const res = results[i];
            if (res == null) missing.push(names[i]);
            else skills.push({ name: names[i], ...res });
          }
          if (missing.length) {
            const list = missing.map((n) => `#skill-${n}`).join(', ');
            chat.pushMessage({ role: 'error', text: `Skill body could not be loaded for: ${list} — installed?` });
            return;
          }

          const tokensJoined = names.map((n) => `#skill-${n}`).join(' ');
          // Single-skill submits keep the original shape (no synthetic
          // heading). Chained submits get per-section labels so the model
          // sees a clear boundary between skill bodies.
          const bodies = skills.map((s) => s.body);
          const skillsBlock = bodies.length === 1
            ? bodies[0]
            : bodies.map((b, i) => `## Skill: #skill-${names[i]}\n\n${b}`).join('\n\n---\n\n');

          // If any skill declares `composer-mode`, replace user-input with a
          // live <media-request> block built from the current picker state.
          // The skill body still ships so chat history shows the full
          // instructions alongside the dynamic config the model received.
          const mediaSkill = skills.find((s) => s.fm['composer-mode']);
          let userInputBlock: string;
          if (mediaSkill) {
            const fmMode = mediaSkill.fm['composer-mode'];
            const appState = getAppState();
            const resolved = fmMode === 'auto' ? appState.composerMode : fmMode;
            const mode = (resolved === 'image' || resolved === 'audio' || resolved === 'video')
              ? resolved
              : 'image'; // default when in chat mode
            await useActiveModelsStore.getState().load();
            const active = useActiveModelsStore.getState().byCategory[mode] ?? null;
            const params = appState.mediaParams[mode as keyof typeof appState.mediaParams] ?? {};
            const enhance = appState.composerEnhance;
            const { text: mediaTurn } = buildMediaTurn({
              mode,
              prompt: args || '(no prompt — use the params alone if possible)',
              active,
              params,
              enhance,
            });
            userInputBlock = `**User input for ${tokensJoined}:**\n\n${mediaTurn}`;
          } else if (args) {
            userInputBlock = `**User input for ${tokensJoined}:** ${args}`;
          } else {
            const possessive = names.length > 1 ? "skills'" : "skill's";
            userInputBlock = `_The user invoked ${tokensJoined} without further input. If you need any details before proceeding, ask first; otherwise carry out the ${possessive} instructions._`;
          }
          const expanded = `${skillsBlock}\n\n---\n\n${userInputBlock}`;
          await chat.executeChatSend({ text: expanded, displayText: trimmed });
        })();
        return true;
      },
    },
    'commands',
  );

  // Dynamic hash-tool interceptor — forwards `#<tool> <args>` typed into
  // chat to bridge's `/v1/hash-tool/` for direct execution (no model in the
  // loop). Restores the pre-Phase-7 behaviour where `#bash ls` ran Bash
  // immediately instead of being forwarded to a model that then chose to
  // call its own Bash tool.
  //
  // Why the regex doesn't enumerate tool names: `handleHashTool()` on the
  // bridge is the source of truth for "what `#word` means right now" — it
  // already covers every built-in tool, every Codex alias (`#functions.*`),
  // and every currently-connected MCP tool by lookup. We send anything
  // shaped like `#<word>` that isn't already claimed by an earlier
  // interceptor or by `executeChatSend` itself, and let the bridge tell us
  // whether it recognised it. New tools/MCP servers light up here with no
  // frontend change.
  //
  // SKIP list covers commands that have client-only paths and must reach
  // `executeChatSend` (`#ns`, `#session`, `#note`, `#btw`, `#debug`) plus
  // `#skill-*` which is already handled by the interceptor above. The
  // `local-bridge-commands` interceptor registered earlier catches
  // `#models|#allmodels|#m|#imgm|…|#help` before we run, so we don't need
  // to list those here.
  registers.chatSubmitInterceptors.add(
    {
      id: 'bridge-hash-tools',
      handle(text, ctx) {
        const trimmed = text.trim();
        if (!/^#[a-zA-Z0-9_.][a-zA-Z0-9_.\-]*(\s|$)/.test(trimmed)) return false;
        if (/^#(skill-|ns(\s|$)|session(\s|$)|note(\s|$)|btw(\s|$)|debug(\s|$))/i.test(trimmed)) return false;
        void (async () => {
          try {
            const r = await fetch(api.config.baseUrl + '/v1/hash-tool/', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ input: trimmed, sessionId: ctx.sessionId }),
            });
            const d = (await r.json()) as { handled?: boolean; result?: string };
            if (d.handled) {
              chat.pushMessage({ role: 'user', text: trimmed });
              chat.pushMessage({ role: 'agent', text: String(d.result ?? '') });
              return;
            }
            // Bridge doesn't recognise this `#word` — fall back to a normal
            // chat send so the model still sees it.
            await chat.executeChatSend({ text: trimmed, displayText: trimmed });
          } catch (err) {
            chat.pushMessage({ role: 'error', text: `Hash tool failed: ${(err as Error).message}` });
          }
        })();
        return true;
      },
    },
    'commands',
  );

  return {
    init,
    openAddNode,
    closeAddNode,
    fetchTools,
    getCommandGroups,
    setShowClaudeCommands,
    getShowClaudeCommands,
  };
})();
