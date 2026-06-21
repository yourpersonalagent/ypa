// Shared "Meta Bridge" section renderer — used by both tab-skills.ts and
// tab-tools.ts so each tab gets a second column listing the dynamically-managed
// items for that kind. Backed by /v1/meta/skills/* and /v1/meta/tools/*.
//
// Storage and behavior are described in docs/metaSkillsToolsHermesFormat.md.

import { esc } from './format.js';
import { api } from '../api.js';
import { liveSave, type LiveSaveHandle } from '../util/liveSave.js';
import { seedSkillCommand } from '../chat/seedCommand.js';
import { prefs } from '../preferences.js';
import { confirm } from '../stores/confirmStore.js';

type Kind = 'skill' | 'tool';
type Runtime = 'bash' | 'python-sandbox' | 'node-sandbox' | 'webhook';

// Seven canonical buckets — match the Matt Pocock taxonomy where possible,
// with two YHA-special additions (integrations + yha). Authors pick one of
// these in SKILL.md frontmatter; "+ new category…" in the per-row dropdown
// lets a user roll a custom bucket on the fly.
const KNOWN_CATEGORIES = ['engineering', 'writing', 'productivity', 'meta', 'setup', 'integrations', 'yha'];

interface SkillRow { name: string; description?: string; category?: string; mounted?: boolean }
interface ToolRow  { name: string; description?: string; runtime?: Runtime; mounted?: boolean }
interface ToolFull  {
  name: string; description?: string; runtime?: Runtime;
  inputSchema?: unknown; entry?: string | null; url?: string | null;
  code?: string; mounted?: boolean;
}

// Rewrite the `category:` line in a SKILL.md frontmatter block (or insert
// one after `name:` if absent). The author-declared category is the
// source of truth for grouping; this is the smallest mutation that keeps
// the rest of the frontmatter and body untouched.
function setCategoryInContent(content: string, newCat: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return content;
  const oldFm = fmMatch[1];
  let newFm: string;
  if (/^category:\s*/m.test(oldFm)) {
    newFm = oldFm.replace(/^category:\s*.*$/m, `category: ${newCat}`);
  } else {
    newFm = oldFm.replace(/^(name:\s*[^\r\n]+)$/m, `$1\ncategory: ${newCat}`);
  }
  return content.replace(oldFm, newFm);
}
const CODE_TEMPLATES: Record<Runtime, string> = {
  'bash': `#!/usr/bin/env bash\nset -euo pipefail\nARGS="$META_ARGS"\necho "$ARGS"\n`,
  'python-sandbox': `# ARGS is the parsed JSON object\nimport json\nprint(json.dumps(ARGS))\n`,
  'node-sandbox': `// ARGS is the parsed JSON object\nconsole.log(JSON.stringify(ARGS));\n`,
  'webhook': '',
};
const SCHEMA_TEMPLATE =
  `{\n  "type": "object",\n  "properties": {},\n  "required": []\n}`;

export function renderMetaSection(host: HTMLElement, kind: Kind): void {
  const base = api.config.baseUrl as string;
  const root = base + (kind === 'skill' ? '/v1/meta/skills' : '/v1/meta/tools');

  // Track the currently-open editor's live handle so we can flush before
  // re-rendering or when collapsing — keeps pending PATCHes from racing the
  // next list GET.
  let openLive: LiveSaveHandle | null = null;

  function api_list(): Promise<{ skills?: SkillRow[]; tools?: ToolRow[] }> {
    return fetch(`${root}/`).then((r) => r.json()).catch(() => ({}));
  }
  function api_get(name: string): Promise<{ name?: string; content?: string; tool?: ToolFull; mounted?: boolean }> {
    return fetch(`${root}/${encodeURIComponent(name)}`).then((r) => r.json()).catch(() => ({}));
  }
  function api_save(name: string, body: unknown): Promise<{ success?: boolean; error?: string }> {
    return fetch(`${root}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()).catch((e) => ({ success: false, error: String(e) }));
  }
  function api_del(name: string): Promise<unknown> {
    return fetch(`${root}/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => r.json()).catch(() => null);
  }
  function api_mount(name: string, mounted: boolean): Promise<unknown> {
    return fetch(`${base}/v1/meta/${mounted ? 'mount' : 'unmount'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, name }),
    }).then((r) => r.json()).catch(() => null);
  }
  function api_invoke(name: string, args: unknown): Promise<{ success?: boolean; result?: { stdout?: string; stderr?: string; exit_code?: number }; error?: string }> {
    return fetch(`${root}/${encodeURIComponent(name)}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: args }),
    }).then((r) => r.json()).catch((e) => ({ success: false, error: String(e) }));
  }
  function rowHtml(
    name: string,
    mounted: boolean,
    subtitle: string,
    opensInvoke: boolean,
    category?: string,
    allCats?: string[],
  ): string {
    const catBlock = (category !== undefined && allCats)
      ? `<select class="m-cat-select" data-name="${esc(name)}" data-current="${esc(category)}" style="font-size:10px;padding:1px 4px;background:transparent;color:var(--fg-dim);border:1px solid var(--border-dim, rgba(255,255,255,.15));border-radius:3px" title="Change skill category">
          ${allCats.map((c) => `<option value="${esc(c)}" ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          <option value="__new__">+ new category…</option>
         </select>`
      : '';
    return `<div class="prefs-prompt-row" data-mname="${esc(name)}">
      <div class="prefs-prompt-header">
        <span class="prefs-prompt-name">${esc(name)}</span>
        ${subtitle ? `<span class="dim" style="font-size:10px;margin-left:6px">${esc(subtitle)}</span>` : ''}
        <div style="display:flex;gap:4px;margin-left:auto;align-items:center">
          ${catBlock}
          <label style="font-size:10px;display:flex;align-items:center;gap:3px;cursor:pointer">
            <input type="checkbox" class="m-mount-chk" data-name="${esc(name)}" ${mounted ? 'checked' : ''} style="accent-color:var(--accent)">
            mounted
          </label>
          ${opensInvoke ? `<button class="prefs-btn m-invoke-btn" data-name="${esc(name)}" style="padding:3px 8px;font-size:11px">Run</button>` : ''}
          <button class="prefs-btn m-edit-btn" data-name="${esc(name)}" style="padding:3px 8px;font-size:11px">Edit</button>
          <button class="prefs-btn prefs-btn-danger m-del-btn" data-name="${esc(name)}" style="padding:3px 8px;font-size:11px">Del</button>
        </div>
      </div>
      <div class="m-edit-pane" data-pane="${esc(name)}" style="display:none;margin-top:6px"></div>
      <div class="m-invoke-pane" data-invoke="${esc(name)}" style="display:none;margin-top:6px"></div>
    </div>`;
  }

  async function render(editing: string | null = null): Promise<void> {
    if (openLive) { await openLive.flush(); openLive = null; }
    const blurb = kind === 'skill'
      ? 'Every skill is a SKILL.md file. The category in its frontmatter groups related skills together — the per-row <strong>mounted</strong> checkbox is the only thing that controls whether a skill is available in chat.'
      : 'Tools authored at runtime through the Meta Bridge MCP. Each tool has a runtime (bash / python-sandbox / node-sandbox / webhook), an input schema, and an executable body.';
    host.innerHTML = `
      <div class="prefs-row" style="align-items:flex-end;gap:8px;margin-bottom:8px">
        <input class="prefs-input" id="m-new-name" placeholder="New ${kind === 'skill' ? 'skill' : 'tool'} name…" style="flex:1;max-width:200px">
        <button class="prefs-btn" id="m-add">+ Add</button>
      </div>
      <p class="dim" style="font-size:11px;margin:0 0 10px">${blurb}</p>
      <div id="m-list"><div class="prefs-loading" style="font-size:12px">Loading…</div></div>`;

    const data = await api_list();
    const list = host.querySelector('#m-list') as HTMLElement;
    const items: (SkillRow | ToolRow)[] = (kind === 'skill' ? data.skills : data.tools) || [];
    if (!items.length) {
      list.innerHTML = `<div class="dim" style="padding:8px 0;font-size:12px">No ${kind === 'skill' ? 'meta skills' : 'meta tools'} yet. Add one above.</div>`;
    } else if (kind === 'skill') {
      // Group skill rows by `category:` from frontmatter. Author-declared
      // categories are the source of truth for grouping; missing/unknown
      // ones fall into `other` so a single uncategorized skill can't disable
      // grouping. The seven canonical buckets (engineering, writing,
      // productivity, meta, setup, integrations, yha) are seeded into the
      // per-row dropdown alongside whatever else exists in the wild —
      // picking "+ new category…" lets the user add a custom one on the fly.
      const skills = items as SkillRow[];
      const byCat = new Map<string, SkillRow[]>();
      for (const s of skills) {
        const c = s.category || 'other';
        if (!byCat.has(c)) byCat.set(c, []);
        byCat.get(c)!.push(s);
      }
      const liveCats = Array.from(byCat.keys());
      const allCats = Array.from(new Set([...KNOWN_CATEGORIES, ...liveCats])).sort();
      let html = '';
      const renderOrder = Array.from(byCat.keys()).sort();
      for (const cat of renderOrder) {
        const rows = byCat.get(cat) || [];
        if (!rows.length) continue;
        html += `<div class="m-cat-header" style="margin:10px 0 4px;padding:4px 8px;background:rgba(255,255,255,.04);border-radius:4px;display:flex;align-items:center;gap:8px">
          <span style="font-size:11px;color:var(--fg-dim);text-transform:uppercase;letter-spacing:.04em">${esc(cat)}</span>
          <span class="dim" style="font-size:10px">· ${rows.length}</span>
        </div>`;
        for (const s of rows) {
          html += rowHtml(s.name, !!s.mounted, s.description || '', false, s.category || 'other', allCats);
        }
      }
      list.innerHTML = html;
    } else {
      let html = '';
      for (const it of items) {
        const sub = `${(it as ToolRow).runtime || 'bash'}${it.description ? ' — ' + it.description : ''}`;
        html += rowHtml(it.name, !!it.mounted, sub, true);
      }
      list.innerHTML = html;
    }

    host.querySelector('#m-add')?.addEventListener('click', async () => {
      const inp = host.querySelector('#m-new-name') as HTMLInputElement | null;
      const name = inp?.value.trim() || '';
      if (kind === 'skill') {
        // Unify the +Add flow with the write-a-skill meta skill: hand off
        // to the LLM through the chat composer so the new skill gets
        // author-friendly scaffolding (frontmatter, category, references)
        // from the start. The typed name (if any) flows in as the trailing
        // arg so write-a-skill knows what to call it.
        if (name && items.some((i) => i.name === name)) {
          if (inp) { inp.style.borderColor = 'var(--danger)'; setTimeout(() => { inp.style.borderColor = ''; }, 1500); }
          return;
        }
        if (openLive) { await openLive.flush(); openLive = null; }
        seedSkillCommand('write-a-skill', name || undefined);
        prefs.close();
        return;
      }
      // Tools keep the inline-create path — they have a structured
      // tool.json schema the editor needs to fill in directly.
      if (!name) return;
      if (items.some((i) => i.name === name)) {
        if (inp) { inp.style.borderColor = 'var(--danger)'; setTimeout(() => { inp.style.borderColor = ''; }, 1500); }
        return;
      }
      await api_save(name, {
        description: '',
        runtime: 'bash',
        inputSchema: JSON.parse(SCHEMA_TEMPLATE),
        code: CODE_TEMPLATES.bash,
      });
      render(name);
    });

    host.querySelectorAll('.m-cat-select').forEach((el) => {
      el.addEventListener('change', async (e) => {
        const sel = e.currentTarget as HTMLSelectElement;
        const name = sel.dataset.name!;
        let newCat = sel.value;
        if (newCat === '__new__') {
          const typed = (window.prompt('New category name:') || '').trim();
          if (!typed) {
            sel.value = sel.dataset.current || 'other';
            return;
          }
          newCat = typed;
        }
        if (openLive) { await openLive.flush(); openLive = null; }
        const detail = await api_get(name);
        const next = setCategoryInContent(detail.content || '', newCat);
        await api_save(name, { content: next });
        render(null);
      });
    });

    host.querySelectorAll('.m-mount-chk').forEach((el) => {
      el.addEventListener('change', async (e) => {
        const cb = e.currentTarget as HTMLInputElement;
        await api_mount(cb.dataset.name!, cb.checked);
      });
    });

    host.querySelectorAll('.m-del-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = (btn as HTMLElement).dataset.name!;
        const ok = await confirm({
          scope: `delete-meta-${kind}`,
          title: `Delete ${kind}?`,
          message: `Delete ${kind} "${name}"?`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await api_del(name);
        render(null);
      });
    });

    host.querySelectorAll('.m-edit-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = (btn as HTMLElement).dataset.name!;
        const pane = host.querySelector(`.m-edit-pane[data-pane="${CSS.escape(name)}"]`) as HTMLElement | null;
        if (!pane) return;
        if (pane.style.display === 'block') {
          if (openLive) { await openLive.flush(); openLive = null; }
          pane.style.display = 'none';
          pane.innerHTML = '';
          return;
        }
        if (openLive) { await openLive.flush(); openLive = null; }
        pane.style.display = 'block';
        pane.innerHTML = '<div class="prefs-loading" style="font-size:11px">Loading…</div>';
        const detail = await api_get(name);
        if (kind === 'skill') {
          const content = detail.content || '';
          pane.innerHTML = `
            <div class="prefs-hint" style="margin:0 0 4px">SKILL.md — use frontmatter for <code>name:</code> and <code>description:</code></div>
            <textarea class="prefs-prompt-ta m-skill-ta" rows="12" style="font-family:monospace;font-size:11px;width:100%">${esc(content)}</textarea>
            <div style="margin-top:5px;display:flex;gap:6px;align-items:center;justify-content:flex-end">
              <span class="prefs-live-status m-status" style="font-size:11px;color:var(--fg-dim);min-width:60px;text-align:right"></span>
            </div>`;
          const ta = pane.querySelector('.m-skill-ta') as HTMLTextAreaElement;
          const statusEl = pane.querySelector('.m-status') as HTMLElement;
          const live = liveSave({
            endpoint: `${root}/${encodeURIComponent(name)}`,
            method: 'PUT',
            debounceMs: 500,
            statusEl,
            errorLabel: 'Save skill failed',
          });
          ta.addEventListener('input', () => live.patch({ content: ta.value }));
          ta.addEventListener('blur', () => { void live.flush(); });
          openLive = live;
          ta.focus();
        } else {
          const t = (detail.tool || {}) as ToolFull;
          const runtime: Runtime = (t.runtime as Runtime) || 'bash';
          pane.innerHTML = `
            <div class="prefs-row" style="gap:6px;margin-bottom:4px">
              <input class="prefs-input m-tool-desc" placeholder="Description (one sentence)" value="${esc(t.description || '')}" style="flex:1">
              <select class="prefs-input m-tool-runtime" style="width:140px">
                <option value="bash" ${runtime === 'bash' ? 'selected' : ''}>bash (host)</option>
                <option value="python-sandbox" ${runtime === 'python-sandbox' ? 'selected' : ''}>python-sandbox</option>
                <option value="node-sandbox" ${runtime === 'node-sandbox' ? 'selected' : ''}>node-sandbox</option>
                <option value="webhook" ${runtime === 'webhook' ? 'selected' : ''}>webhook</option>
              </select>
            </div>
            <div class="prefs-hint" style="margin:6px 0 2px">Input schema (JSON-Schema, type=object)</div>
            <textarea class="prefs-prompt-ta m-tool-schema" rows="5" style="font-family:monospace;font-size:11px;width:100%">${esc(JSON.stringify(t.inputSchema || JSON.parse(SCHEMA_TEMPLATE), null, 2))}</textarea>
            <div class="m-tool-body-wrap">
              <div class="prefs-hint m-tool-code-label" style="margin:6px 0 2px">Code body (\$META_ARGS for bash; ARGS for python/node sandboxes)</div>
              <textarea class="prefs-prompt-ta m-tool-code" rows="10" style="font-family:monospace;font-size:11px;width:100%;${runtime === 'webhook' ? 'display:none' : ''}">${esc(t.code || '')}</textarea>
              <div class="prefs-hint m-tool-url-label" style="margin:6px 0 2px;${runtime === 'webhook' ? '' : 'display:none'}">Webhook URL (https:// or http://localhost)</div>
              <input class="prefs-input m-tool-url" placeholder="https://…" value="${esc(t.url || '')}" style="width:100%;${runtime === 'webhook' ? '' : 'display:none'}">
            </div>
            <div style="margin-top:6px;display:flex;gap:6px;align-items:center;justify-content:flex-end">
              <span class="prefs-live-status m-status" style="font-size:11px;color:var(--fg-dim);min-width:60px;text-align:right"></span>
            </div>`;
          const descInp = pane.querySelector('.m-tool-desc') as HTMLInputElement;
          const rtSel = pane.querySelector('.m-tool-runtime') as HTMLSelectElement;
          const schemaTa = pane.querySelector('.m-tool-schema') as HTMLTextAreaElement;
          const codeTa = pane.querySelector('.m-tool-code') as HTMLTextAreaElement;
          const codeLbl = pane.querySelector('.m-tool-code-label') as HTMLElement;
          const urlInp = pane.querySelector('.m-tool-url') as HTMLInputElement;
          const urlLbl = pane.querySelector('.m-tool-url-label') as HTMLElement;
          const statusEl = pane.querySelector('.m-status') as HTMLElement;

          const live = liveSave({
            endpoint: `${root}/${encodeURIComponent(name)}`,
            method: 'PUT',
            debounceMs: 500,
            statusEl,
            errorLabel: 'Save tool failed',
          });

          // Push the current full state of the editor as a single PATCH body.
          // PUT replaces the document so we always send every field; if the
          // schema textarea isn't valid JSON we surface that inline and skip
          // the save until the user fixes it.
          const pushAll = (): void => {
            let inputSchema: unknown;
            try { inputSchema = JSON.parse(schemaTa.value); }
            catch {
              statusEl.textContent = 'schema not JSON';
              statusEl.style.color = 'var(--danger, #ff5060)';
              return;
            }
            const runtimeNow = rtSel.value as Runtime;
            const body: Record<string, unknown> = {
              description: descInp.value,
              runtime: runtimeNow,
              inputSchema,
            };
            if (runtimeNow === 'webhook') body.url = urlInp.value.trim();
            else body.code = codeTa.value;
            live.patch(body);
          };

          rtSel.addEventListener('change', () => {
            const isWebhook = rtSel.value === 'webhook';
            codeTa.style.display = isWebhook ? 'none' : 'block';
            codeLbl.style.display = isWebhook ? 'none' : 'block';
            urlInp.style.display = isWebhook ? 'block' : 'none';
            urlLbl.style.display = isWebhook ? 'block' : 'none';
            if (!isWebhook && !codeTa.value.trim()) codeTa.value = CODE_TEMPLATES[rtSel.value as Runtime] || '';
            pushAll();
          });
          descInp.addEventListener('input', pushAll);
          schemaTa.addEventListener('input', pushAll);
          codeTa.addEventListener('input', pushAll);
          urlInp.addEventListener('input', pushAll);
          [descInp, schemaTa, codeTa, urlInp].forEach((el) => {
            el.addEventListener('blur', () => { void live.flush(); });
          });
          openLive = live;
        }
      });
    });

    host.querySelectorAll('.m-invoke-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = (btn as HTMLElement).dataset.name!;
        const pane = host.querySelector(`.m-invoke-pane[data-invoke="${CSS.escape(name)}"]`) as HTMLElement | null;
        if (!pane) return;
        if (pane.style.display === 'block') { pane.style.display = 'none'; pane.innerHTML = ''; return; }
        // Make sure pending edits are persisted before invoking — otherwise
        // the run might execute against stale code.
        if (openLive) await openLive.flush();
        pane.style.display = 'block';
        pane.innerHTML = `
          <div class="prefs-hint" style="margin:0 0 2px">Args JSON</div>
          <textarea class="prefs-prompt-ta m-run-args" rows="3" style="font-family:monospace;font-size:11px;width:100%">{}</textarea>
          <div style="margin-top:5px;display:flex;gap:6px;align-items:center">
            <button class="prefs-btn m-run-go" style="padding:4px 12px">Invoke</button>
            <span class="m-run-status dim" style="font-size:11px"></span>
          </div>
          <pre class="m-run-out" style="margin-top:6px;padding:8px;background:rgba(0,0,0,.45);border-radius:4px;font-size:11px;white-space:pre-wrap;display:none"></pre>`;
        (pane.querySelector('.m-run-go') as HTMLButtonElement).addEventListener('click', async () => {
          const status = pane.querySelector('.m-run-status') as HTMLElement;
          const out = pane.querySelector('.m-run-out') as HTMLElement;
          let args: unknown;
          try { args = JSON.parse((pane.querySelector('.m-run-args') as HTMLTextAreaElement).value || '{}'); }
          catch {
            status.textContent = 'args not valid JSON';
            return;
          }
          if (openLive) await openLive.flush();
          status.textContent = 'Running…';
          out.style.display = 'none';
          const r = await api_invoke(name, args);
          status.textContent = r.success ? 'Done' : (r.error || 'Failed');
          out.style.display = 'block';
          out.textContent = JSON.stringify(r.result || r, null, 2);
        });
      });
    });

    if (editing) {
      const btn = host.querySelector(`.m-edit-btn[data-name="${CSS.escape(editing)}"]`) as HTMLButtonElement | null;
      btn?.click();
    }
  }

  render().catch(() => { host.innerHTML = '<div class="dim" style="padding:8px 0;font-size:12px">Failed to load.</div>'; });
}
