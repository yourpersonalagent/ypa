// Workflow runner + server-backed persistence.
// Unified picker for save/load/rename/search/delete.
// Workflows stored as .md files on the server via /v1/workflows/.

import { getAppState, getAppActions, getGraphState, getGraphActions } from '../stores/index.js';
import { getToastActions } from '../stores/toastStore.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from '../toast.js';
import { save as appSave, bus } from '../state.js';
import { session } from '../session.js';
import { editor } from './editor.js';
import { chat } from '../chat.js';
import { WORKFLOW_MASTER_PROMPT } from './masterPrompt.js';

function _toastEventEnabled(key: string): boolean {
  try {
    const cfg = JSON.parse(localStorage.getItem('yha.toast') || '{}');
    if (cfg.enabled === false) return false;
    const events = cfg.events || {};
    return events[key] !== false;
  } catch {
    return true;
  }
}

interface WorkflowEntry {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  graph?: unknown;
}

interface DecisionLogic {
  leftOperand: string;
  operator: string;
  rightOperand: string;
}

interface GraphNode {
  id: string;
  type: string;
  command?: string;
  input?: string;
  output?: string;
  status?: string;
  title?: string;
  disabled?: boolean;
  inputMode?: 'upstream' | 'manual' | 'off';
  decisionLogic?: DecisionLogic;
  meta?: unknown;
  x?: number;
  y?: number;
  [key: string]: unknown;
}

export const workflow = (() => {
  // ── Decision evaluation ──────────────────────────────────────────────────────
  function evaluateDecision(inputText: unknown, leftOperand: string, operator: string, rightOperand: string): boolean {
    const str = inputText == null ? '' : String(inputText);
    let leftVal: string | number;
    switch (leftOperand) {
      case 'wordCount':
        leftVal = str.trim() === '' ? 0 : str.trim().split(/\s+/).length;
        break;
      case 'charCount':
        leftVal = str.length;
        break;
      case 'lineCount':
        leftVal = str === '' ? 0 : str.split('\n').length;
        break;
      case 'content':
      default:
        leftVal = str;
        break;
    }
    const right = rightOperand;
    switch (operator) {
      case '>':
        return leftVal > (isNaN(Number(right)) ? right : Number(right));
      case '<':
        return leftVal < (isNaN(Number(right)) ? right : Number(right));
      case '>=':
        return leftVal >= (isNaN(Number(right)) ? right : Number(right));
      case '<=':
        return leftVal <= (isNaN(Number(right)) ? right : Number(right));
      case '==':
        return String(leftVal) === String(right);
      case '!=':
        return String(leftVal) !== String(right);
      case 'contains':
        return String(str).includes(String(right));
      case 'notContains':
        return !String(str).includes(String(right));
      case 'isEmpty':
        return str.trim() === '';
      case 'isNotEmpty':
        return str.trim() !== '';
      default:
        return false;
    }
  }

  // ── Server API ───────────────────────────────────────────────────────────────
  function base(): string {
    return api.config.baseUrl || window.location.origin;
  }

  async function _apiCreate(name: string, graph: unknown): Promise<{ success: boolean; workflow: WorkflowEntry }> {
    const r = await fetch(base() + '/v1/workflows/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, graph }),
    });
    return r.json();
  }

  async function _apiGet(id: string): Promise<{ success: boolean; workflow: WorkflowEntry & { graph: unknown } }> {
    const r = await fetch(base() + `/v1/workflows/${encodeURIComponent(id)}`);
    return r.json();
  }

  async function _apiPatch(id: string, patch: Record<string, unknown>): Promise<unknown> {
    const r = await fetch(base() + `/v1/workflows/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return r.json();
  }


  // ── Current workflow state ────────────────────────────────────────────────────
  function _setCurrentWorkflow(id: string | null, name: string | null): void {
    getAppActions().setWorkflow({ id: id || null, name: name || '' });
    if (id) localStorage.setItem('yha.wfId', id);
    else localStorage.removeItem('yha.wfId');
  }

  // ── Session binding ───────────────────────────────────────────────────────────
  function _listBindings(): Record<string, string> {
    return store.get('wfBindings', {}) as Record<string, string>;
  }
  function getBoundSession(wfId: string): string | null {
    return _listBindings()[wfId] || null;
  }

  function bindToSession(wfId: string, sessionId: string | null): void {
    const b = { ..._listBindings() };
    if (sessionId) b[wfId] = sessionId;
    else delete b[wfId];
    store.set('wfBindings', b);
    if (sessionId) {
      fetch(base() + `/v1/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boundWorkflowName: wfId }),
      }).catch(() => {});
    }
  }

  function bindCurrentToSession(): void {
    const wfId = getAppState().workflow.id;
    if (!wfId) {
      alert('Save the workflow first.');
      return;
    }
    const sid = String(session?.getCurrentId() || '');
    if (!sid) {
      alert('No active session.');
      return;
    }
    const bound = getBoundSession(wfId);
    if (bound && String(bound) === sid) {
      bindToSession(wfId, null);
      toast.show(`Workflow unbound`);
    } else {
      bindToSession(wfId, sid);
      toast.show(`Workflow bound to current session`);
    }
    window.dispatchEvent(new CustomEvent('yha:wf-binding-changed'));
  }

  // ── Save / Load / Clear ───────────────────────────────────────────────────────
  // Save current graph. If name matches current workflow → update it.
  // If name differs or no workflow yet → create a new one.
  async function save(nameOverride?: string): Promise<void> {
    const name = (nameOverride || '').trim();
    const { id, name: wfName } = getAppState().workflow;
    const { nodes, links } = getGraphState();
    if (id && (!name || name === wfName)) {
      await _apiPatch(id, { graph: { nodes, links } });
      toast.show(`Saved "${wfName}"`);
    } else if (name) {
      const d = await _apiCreate(name, { nodes, links });
      if (d.success) {
        _setCurrentWorkflow(d.workflow.id, d.workflow.name);
        toast.show(`Saved as "${d.workflow.name}"`);
      }
    }
  }

  async function load(id: string): Promise<void> {
    if (!id) return;
    const d = await _apiGet(id);
    if (!d.success) {
      console.warn('[workflow] load failed:', id);
      return;
    }
    const wf = d.workflow;
    const g = (wf.graph || { nodes: [], links: [] }) as { nodes?: unknown[]; links?: unknown[] };
    getGraphActions().setNodes((g.nodes || []) as any);
    getGraphActions().setLinks((g.links || []) as any);
    _setCurrentWorkflow(wf.id, wf.name);
    appSave.graph();
    editor.fit();
    // Auto-switch to bound session
    const boundSid = getBoundSession(id);
    if (boundSid && String(session.getCurrentId()) !== String(boundSid)) {
      session.switchTo(boundSid).catch(() => {});
    }
  }

  function clear(): void {
    if (!confirm('Clear graph?')) return;
    getGraphActions().clear();
    _setCurrentWorkflow(null, null);
    appSave.graph();
  }

  // ── Import / Export ───────────────────────────────────────────────────────────
  function exportJson(): void {
    _openModal(
      'Export Workflow',
      '<textarea id="export-ta" readonly style="width:100%;height:300px;font-family:monospace;font-size:12px"></textarea>'
    );
    const ta = document.getElementById('export-ta') as HTMLTextAreaElement | null;
    if (ta) {
      const { nodes, links } = getGraphState();
      ta.value = JSON.stringify({ nodes, links }, null, 2);
    }
  }

  function importJson(): void {
    _openModal(
      'Import Workflow',
      `<textarea id="import-ta" placeholder="Paste workflow JSON" style="width:100%;height:300px;font-family:monospace;font-size:12px"></textarea>`,
      () => {
        const ta = document.getElementById('import-ta') as HTMLTextAreaElement | null;
        try {
          const g = JSON.parse(ta?.value ?? '');
          if (!g.nodes || !g.links) throw new Error('Missing nodes/links');
          getGraphActions().setNodes(g.nodes);
          getGraphActions().setLinks(g.links);
          appSave.graph();
          editor.fit();
          _setCurrentWorkflow(null, null);
          _closeModal();
        } catch (e) {
          alert('Invalid JSON: ' + (e as Error).message);
        }
      }
    );
  }

  function exportMd(): void {
    const sid = String(getAppState().currentSession || '');
    if (!sid) {
      alert('No active session.');
      return;
    }
    window.open(base() + `/v1/sessions/${encodeURIComponent(sid)}/export.md`, '_blank');
  }

  // Push the workflow master prompt into the chat textarea so the user can append a
  // free-form workflow description below the "WORKFLOW DESCRIPTION:" footer and send it
  // to the LLM. The LLM should respond with a fenced markdown workflow file.
  function injectMasterPrompt(): void {
    bus.emit('chat:set-input', WORKFLOW_MASTER_PROMPT);
    toast.show('Master prompt inserted — append your workflow description and send.');
  }

  // Parse arbitrary MD content (paste or file body) via /v1/workflows/parse-md and drop the
  // resulting graph onto the canvas. Returns { ok, error? } so callers can render inline
  // errors instead of relying on alert(). The workflow is NOT saved automatically — the
  // user must hit "Save" to persist it.
  async function importMdFromContent(content: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(base() + '/v1/workflows/parse-md', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const d = (await r.json()) as {
        success: boolean;
        error?: string;
        name?: string;
        graph?: { nodes: unknown[]; links: unknown[] };
      };
      if (!d.success || !d.graph) {
        return { ok: false, error: d.error || 'unknown error' };
      }
      const nodes = (d.graph.nodes || []) as Array<Record<string, unknown>>;
      const links = (d.graph.links || []) as unknown[];
      // Fallback layout for nodes missing valid coords
      nodes.forEach((n, i) => {
        const x = Number(n.x);
        const y = Number(n.y);
        if (!Number.isFinite(x)) n.x = (i % 4) * 280 + 80;
        if (!Number.isFinite(y)) n.y = Math.floor(i / 4) * 200 + 80;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getGraphActions().setNodes(nodes as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getGraphActions().setLinks(links as any);
      appSave.graph();
      editor.fit();
      // Detach from any current workflow id; the user must save explicitly. Pre-fill the
      // name input via the workflow store so the picker shows the imported name.
      getAppActions().setWorkflow({ id: null, name: d.name || '' });
      localStorage.removeItem('yha.wfId');
      toast.show(
        `Imported "${d.name || 'workflow'}" (${nodes.length} node${nodes.length !== 1 ? 's' : ''}, ${links.length} link${links.length !== 1 ? 's' : ''}) — hit Save to persist.`
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Import a workflow from an LLM-generated .md file. Opens a file picker and delegates
  // to importMdFromContent(). Kept for any external callers; the picker uses the inline
  // textarea panel + per-file shortcut directly via importMdFromContent().
  function importMd(): void {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.md,text/markdown,text/plain';
    inp.style.display = 'none';
    inp.onchange = async () => {
      const file = inp.files?.[0];
      document.body.removeChild(inp);
      if (!file) return;
      const content = await file.text();
      const r = await importMdFromContent(content);
      if (!r.ok) alert('Invalid workflow MD: ' + (r.error || 'unknown error'));
    };
    document.body.appendChild(inp);
    inp.click();
  }

  function _openModal(title: string, body: string, onOk?: () => void): void {
    const m = document.getElementById('modal')!;
    document.getElementById('modal-title')!.textContent = title;
    document.getElementById('modal-body')!.innerHTML = body;
    m.hidden = false;
    const close = () => {
      m.hidden = true;
    };
    (document.getElementById('modal-ok') as HTMLElement).onclick = onOk || close;
    (document.getElementById('modal-close') as HTMLElement).onclick = close;
  }
  function _closeModal(): void {
    (document.getElementById('modal') as HTMLElement).hidden = true;
  }

  // ── Run workflow ──────────────────────────────────────────────────────────────
  async function runNode(id: string): Promise<string | undefined> {
    const n = getGraphActions().getNode(id) as GraphNode | null;
    if (!n) return;

    if (n.type === 'if') {
      const ups = getGraphActions().upstreamOf(id) as GraphNode[];
      const input = ups.length
        ? ups
            .map((u) => u.output || '')
            .filter(Boolean)
            .join('\n\n') || ''
        : n.input || '';
      const logic: DecisionLogic = n.decisionLogic || { leftOperand: 'content', operator: '==', rightOperand: '' };
      const result = evaluateDecision(input, logic.leftOperand, logic.operator, logic.rightOperand);
      const output = result ? '✓ true' : '✗ false';
      getGraphActions().updateNode(id, {
        output,
        status: 'done',
        meta: { decision: result, branch: result ? 'true' : 'false' },
      });
      appSave.graph();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getGraphActions().setLastExecuted({ nodeId: String(id), node: n as any, output, error: false });
      return output;
    }

    const inputMode = (n.inputMode as string) ?? (n.type === 'chat' ? 'upstream' : 'off');
    const ups = getGraphActions().upstreamOf(id) as GraphNode[];
    if (inputMode === 'upstream') {
      if (ups.length && !n.input) {
        n.input = ups
          .map((u) => u.output || '')
          .filter(Boolean)
          .join('\n\n');
      }
    } else if (inputMode === 'off') {
      n.input = '';
    }
    // 'manual' → use n.input as-is
    getGraphActions().updateNode(id, { status: 'running' });
    const cmd = _resolveCommand(n);
    try {
      const result = await chat.executeChatSend({
        text: cmd,
        graphNode: n as unknown as Record<string, unknown>,
        recordInGraph: false,
      }) as { output?: string } | undefined;
      const out: string = result?.output || '';
      getGraphActions().updateNode(id, { output: out, status: n.status === 'error' ? 'error' : 'done' });
      appSave.graph();
      getGraphActions().setLastExecuted({
        nodeId: String(id),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node: n as any,
        output: out,
        error: false,
        data: result,
        viaChatEngine: true,
      });
      return out;
    } catch (e) {
      getGraphActions().updateNode(id, { output: (e as Error).message, status: 'error' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getGraphActions().setLastExecuted({ nodeId: String(id), node: n as any, output: (e as Error).message, error: true });
      throw e;
    }
  }

  function _resolveCommand(n: GraphNode): string {
    const inputMode = (n.inputMode as string) ?? (n.type === 'chat' ? 'upstream' : 'off');
    const body = (n.command || '').trim();
    if (inputMode === 'off') return body;
    const input = (n.input || '').trim();
    if (!body) return input || '';
    if (!input) return body;
    return `${body}\n\n${input}`;
  }

  async function run(): Promise<void> {
    let order: GraphNode[];
    try {
      order = getGraphActions().topoOrder() as GraphNode[];
    } catch (e) {
      alert((e as Error).message);
      return;
    }
    order = order.filter((n) => !n.disabled);
    if (_toastEventEnabled('workflow:run')) {
      const _nodeCount = order.length;
      getToastActions().show(
        `Running ${_nodeCount || '?'} node${_nodeCount !== 1 ? 's' : ''}…`,
        'running',
        { id: 'workflow-run', duration: 0 }
      );
    }
    for (const n of order) {
      try {
        await runNode(n.id);
      } catch (e) {
        getToastActions().dismiss('workflow-run');
        getToastActions().show('Workflow done', 'success', { duration: 2000 });
        console.error('Workflow halted at', n.id, e);
        return;
      }
    }
    getToastActions().dismiss('workflow-run');
    getToastActions().show('Workflow done', 'success', { duration: 2000 });
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  async function _afterBoot(): Promise<void> {
    // Restore last active workflow name (for display only — graph is already restored from lastGraph)
    const lastId = localStorage.getItem('yha.wfId');
    if (lastId) {
      try {
        const d = await _apiGet(lastId);
        if (d.success) {
          getAppActions().setWorkflow({ id: d.workflow.id, name: d.workflow.name });
        }
      } catch (_) {}
    }
  }

  function init(): void {}

  // Legacy no-op kept so any code calling refreshList() doesn't throw
  function refreshList(): void {}

  return {
    init,
    _afterBoot,
    refreshList,
    save,
    load,
    clear,
    run,
    runNode,
    exportJson,
    importJson,
    exportMd,
    importMd,
    importMdFromContent,
    injectMasterPrompt,
    bindCurrentToSession,
    bindToSession,
    getBoundSession,
  };
})();
