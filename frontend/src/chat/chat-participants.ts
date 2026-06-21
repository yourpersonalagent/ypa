// chat-participants.ts — session-participant lifecycle + textarea binding for
// at-mention detection. NOT a duplicate of pickers/MentionPickerForDirectMsg —
// the React picker renders the dropdown UI; this file handles the data side
// (server invitations, participant chip rendering, hide/show buttons based on
// the session's participants list, textarea binding).

import chatUtils from './chat-utils.js';
import { getSessionActions, useSessionStore, getAppState } from '../stores/index.js';
import { api } from '../api.js';
import { session } from '../session.js';
import { isBridgeModuleEnabled } from '../host/bridge-modules.js';

// ── Group-mode literal mapping ────────────────────────────────────────────────
// The chip-bar session-level groupMode uses long-form literals
// (`sequential` / `moderator` / `versus`) that match what the bridge
// persists in bridge/sessions/*.json and what go-core's broadcast runner
// expects. The multichat-group parallel-grid feature uses short literals
// (`vs` / `mod`) for its own state. This helper is the single point where
// the two vocabularies meet — keep it together so future renames don't
// scatter ad-hoc inline conditionals.
type SessionGroupMode = 'sequential' | 'moderator' | 'versus' | string;
type MultichatGroupMode = 'vs' | 'mod';
function sessionToGroupMode(sessionMode: SessionGroupMode): MultichatGroupMode | null {
  if (sessionMode === 'moderator') return 'mod';
  if (sessionMode === 'versus') return 'vs';
  return null; // 'sequential' or anything else → no parallel grid
}

let _ta: HTMLTextAreaElement | null = null;
let _autoGrow: (() => void) | null = null;

let _atPickerEmployees: Record<string, string>[] = [];
let _atPickerActive = false;
let _atPickerIdx = 0;
const _sessionParticipants = new Map<string, string[]>();
const _sessionGroupModes = new Map<string, string>();
// Set of employeeIds currently being invited per session. Used only to filter
// the picker so a user can't double-click the same row before the first POST
// completes — server is idempotent so multiple POSTs are harmless, but the
// picker dedup keeps the UI from queueing redundant requests.
const _sessionPendingAdds = new Map<string, Set<string>>();

function _pending(sid: string): Set<string> {
  let s = _sessionPendingAdds.get(sid);
  if (!s) { s = new Set(); _sessionPendingAdds.set(sid, s); }
  return s;
}

export const chatParticipants = {
  async _loadAtEmployees(): Promise<void> {
    if (!isBridgeModuleEnabled('multichat-personnel')) return;
    try {
      const r = await fetch(api.config.baseUrl + '/v1/employees/').catch(() => null);
      if (r?.ok) {
        const d = await r.json();
        _atPickerEmployees = d.employees || [];
      }
    } catch (_) {}
  },

  _getCurrentSessionParticipants(): string[] {
    const sid = String(getAppState().currentSession || '');
    const local = _sessionParticipants.get(sid);
    if (Array.isArray(local) && local.length) return local;
    const cache = (session.getCached() || []) as unknown as Record<string, unknown>[];
    const curSession = cache.find((s) => String(s['id']) === sid) as Record<string, unknown> | undefined;
    return Array.isArray(curSession?.['participants']) ? curSession!['participants'] as string[] : [];
  },

  _mentionTokenForEmployee(emp: Record<string, string>): string {
    const preferred = String(emp?.['name'] || '').trim();
    if (/^[A-Za-z0-9_-]+$/.test(preferred)) return preferred;
    return String(emp?.['id'] || '').trim();
  },

  _atPickerClose(): void {
    const pop = document.getElementById('at-picker');
    if (pop) pop.remove();
    _atPickerActive = false;
    _atPickerIdx = 0;
  },

  _openAtPicker(anchor: HTMLElement, mode: string, filter = ''): void {
    this._atPickerClose();
    _atPickerActive = true;
    const q = String(filter || '').toLowerCase();
    const invited = new Set(this._getCurrentSessionParticipants().map((id) => String(id || '').toLowerCase()));
    const sidForFilter = String(getAppState().currentSession || '');
    const pendingLower = new Set(Array.from(_pending(sidForFilter)).map((id) => id.toLowerCase()));
    const source = _atPickerEmployees.filter((e) => {
      const eid = String(e['id'] || '').toLowerCase();
      if (mode === 'mention') return invited.has(eid);
      if (mode === 'invite') return !invited.has(eid) && !pendingLower.has(eid);
      return true;
    });
    const emps = source.filter((e) => {
      const mentionToken = this._mentionTokenForEmployee(e).toLowerCase();
      return !q || String(e['id'] || '').toLowerCase().includes(q) || mentionToken.includes(q) || String(e['name'] || '').toLowerCase().includes(q);
    });
    if (!emps.length && mode === 'mention') {
      _atPickerActive = false;
      return;
    }
    const pop = document.createElement('div');
    pop.id = 'at-picker';
    pop.className = 'at-picker';
    if (!emps.length) {
      pop.innerHTML = `<div class="at-picker-empty">No employees found</div>`;
    } else {
      pop.innerHTML = emps.map((e, i) => `
        <div class="at-picker-item${i === _atPickerIdx ? ' at-picker-active' : ''}" data-id="${chatUtils.escHtml(e['id'])}" data-mention="${chatUtils.escHtml(this._mentionTokenForEmployee(e))}" data-idx="${i}">
          <span class="at-picker-av">${chatUtils.escHtml((e['name'] || e['id'])[0].toUpperCase())}</span>
          <span class="at-picker-info">
            <span class="at-picker-name">${chatUtils.escHtml(e['name'] || e['id'])}</span>
            <span class="at-picker-role">${chatUtils.escHtml(e['role'] || '')}</span>
          </span>
          ${mode === 'invite' ? `<span class="at-picker-action">+ invite</span>` : `<span class="at-picker-action">@${chatUtils.escHtml(this._mentionTokenForEmployee(e))}</span>`}
        </div>`).join('');
    }
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const popH = Math.min(emps.length * 38 + 8, 280);
    pop.style.left = rect.left + 'px';
    pop.style.top = rect.top - popH - 4 + 'px';
    pop.style.width = Math.max(rect.width, 220) + 'px';

    const selectItem = (empId: string, mentionToken: string) => {
      this._atPickerClose();
      if (mode === 'mention' && _ta) {
        const val = _ta.value;
        const cur = _ta.selectionStart;
        const before = val.slice(0, cur);
        const atMatch = before.match(/@([a-z0-9_-]*)$/i);
        const token = mentionToken || empId;
        if (atMatch) {
          const start = cur - atMatch[0].length;
          _ta.value = val.slice(0, start) + '@' + token + ' ' + val.slice(cur);
          const newPos = start + token.length + 2;
          _ta.setSelectionRange(newPos, newPos);
        } else {
          _ta.value += '@' + token + ' ';
        }
        try {
          _ta.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (_) {}
        _ta.focus();
        _autoGrow?.();
      } else if (mode !== 'mention') {
        const sid = String(getAppState().currentSession || '');
        const pending = _pending(sid);
        if (pending.has(empId)) return;
        const cur = chatParticipants._getCurrentSessionParticipants();
        if (cur.includes(empId)) return;
        pending.add(empId);

        fetch(api.config.baseUrl + `/v1/sessions/${encodeURIComponent(sid)}/participants`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employeeId: empId })
        }).then(r => r.json()).then((d: Record<string, unknown>) => {
          pending.delete(empId);
          if (d['success']) {
            const cache = (session.getCached() || []) as unknown as Record<string, unknown>[];
            const s = cache.find((x) => String(x['id']) === sid) as Record<string, unknown> | undefined;
            if (s) s['participants'] = d['participants'];
            chatParticipants._updateParticipants((d['participants'] as string[]) || []);
            getSessionActions().bumpParticipantsRevision();
          }
        }).catch(() => { pending.delete(empId); });
      }
    };

    pop.querySelectorAll('.at-picker-item').forEach((item) => {
      const el = item as HTMLElement;
      el.addEventListener('mousedown', (e) => { e.preventDefault(); selectItem(el.dataset['id']!, el.dataset['mention']!); });
      el.addEventListener('mouseover', () => {
        pop.querySelectorAll('.at-picker-item').forEach((x) => (x as HTMLElement).classList.remove('at-picker-active'));
        el.classList.add('at-picker-active');
        _atPickerIdx = parseInt(el.dataset['idx']!, 10);
      });
    });

    setTimeout(() => {
      document.addEventListener('mousedown', function _close(e) {
        if (!pop.contains(e.target as Node)) {
          chatParticipants._atPickerClose();
          document.removeEventListener('mousedown', _close);
        }
      });
    }, 0);
  },

  _checkAtMention(): void {
    if (!_ta) return;
    const val = _ta.value;
    const cur = _ta.selectionStart;
    const before = val.slice(0, cur);
    const atMatch = before.match(/@([a-z0-9_-]*)$/i);
    if (!atMatch) { this._atPickerClose(); return; }
    const partial = atMatch[1];
    const hasParticipants = this._getCurrentSessionParticipants().length > 0;
    if (!hasParticipants) { this._atPickerClose(); return; }
    this._openAtPicker(_ta, 'mention', partial);
  },

  _atPickerKeydown(e: KeyboardEvent): boolean {
    const pop = document.getElementById('at-picker');
    if (!pop || !_atPickerActive) return false;
    const items = pop.querySelectorAll('.at-picker-item');
    if (!items.length) {
      if (e.key === 'Escape') { e.preventDefault(); this._atPickerClose(); return true; }
      return false;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _atPickerIdx = Math.min(_atPickerIdx + 1, items.length - 1);
      items.forEach((x, i) => (x as HTMLElement).classList.toggle('at-picker-active', i === _atPickerIdx));
      (items[_atPickerIdx] as HTMLElement)?.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _atPickerIdx = Math.max(_atPickerIdx - 1, 0);
      items.forEach((x, i) => (x as HTMLElement).classList.toggle('at-picker-active', i === _atPickerIdx));
      (items[_atPickerIdx] as HTMLElement)?.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const active = pop.querySelector('.at-picker-active');
      if (active) { e.preventDefault(); active.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; }
    }
    if (e.key === 'Escape') { e.preventDefault(); this._atPickerClose(); return true; }
    return false;
  },

  async _updateParticipants(participants: string[], forcedGroupMode: string | null = null): Promise<void> {
    const pBar = document.getElementById('chat-participants');
    const modelBtn = document.getElementById('chat-model-btn');
    const sysBtn = document.getElementById('chat-sys-btn');
    const toolsBtn = document.getElementById('cap-tools');
    const visionBtn = document.getElementById('cap-vision');
    const reasoningBtn = document.getElementById('cap-reasoning');
    const has = Array.isArray(participants) && participants.length > 0;
    if (!pBar) return;
    for (const btn of [modelBtn, sysBtn, toolsBtn, visionBtn, reasoningBtn]) {
      if (!btn) continue;
      (btn as HTMLElement).style.opacity = has ? '0.38' : '';
      (btn as HTMLElement).style.pointerEvents = has ? 'none' : '';
      (btn as HTMLElement).title = has ? ((btn as HTMLElement).title ? (btn as HTMLElement).title + ' (controlled by employee)' : 'controlled by employee') : (btn as HTMLElement).title?.replace(' (controlled by employee)', '') || '';
    }
    const curId = String(getAppState().currentSession || '');
    _sessionParticipants.set(curId, Array.isArray(participants) ? [...participants] : []);
    if (!has) { pBar.style.display = 'none'; pBar.innerHTML = ''; return; }
    pBar.style.display = 'flex';
    const cache = (session.getCached() || []) as unknown as Record<string, unknown>[];
    const curSession = cache.find((s) => String(s['id']) === curId) as Record<string, unknown> | undefined;
    const parts: string[] = Array.isArray(curSession?.['participants']) && (curSession!['participants'] as unknown[]).length
      ? curSession!['participants'] as string[]
      : participants;
    const groupMode = forcedGroupMode || (curSession?.['groupMode'] as string | undefined) || _sessionGroupModes.get(curId) || 'sequential';
    _sessionGroupModes.set(curId, groupMode);
    let empMap: Record<string, Record<string, string>> = {};
    if (isBridgeModuleEnabled('multichat-personnel')) {
      try {
        const er = await fetch(api.config.baseUrl + '/v1/employees/').catch(() => null);
        if (er?.ok) {
          const ed = await er.json();
          for (const e of (ed.employees || []) as Record<string, string>[]) empMap[e['id']] = e;
        }
      } catch (_) {}
    }
    const chipsHtml = parts.map((empId, idx) => {
      const emp = empMap[empId];
      const displayName = emp?.['name'] || empId;
      const isMod = groupMode === 'moderator' && idx === 0;
      return `<span class="chat-participant-chip${isMod ? ' chip-moderator' : ''}" data-id="${chatUtils.escHtml(empId)}" data-idx="${idx}" draggable="true">
        <span class="chip-drag" title="Drag to reorder">⠿</span>
        ${isMod ? `<span class="chip-mod-badge" title="Moderator">◆</span>` : ''}
        <span class="chip-name">${chatUtils.escHtml(displayName)}</span>
        <button class="chip-remove" data-id="${chatUtils.escHtml(empId)}" title="Remove from chat">✕</button>
      </span>`;
    }).join('');
    const _modeLabel: Record<string, string> = {
      sequential: '↓ each',
      moderator: '◆ mod',
      versus: '⇆ vs',
    };
    const _modeTitle: Record<string, string> = {
      sequential: 'Sequential: all agents reply one after another. Click for moderator mode.',
      moderator: 'Moderator: first agent responds to all; others reply only on @mention. Click for versus mode.',
      versus: 'Versus: all agents answer the SAME prompt in parallel; nobody sees the others\' replies until done. Click for sequential mode.',
    };
    const _modeForBtn = _modeLabel[groupMode] ? groupMode : 'sequential';
    const modeToggleHtml = parts.length >= 2
      ? `<button class="chat-mode-toggle" id="chat-mode-toggle" data-mode="${chatUtils.escHtml(_modeForBtn)}" title="${_modeTitle[_modeForBtn]}">${_modeLabel[_modeForBtn]}</button>`
      : '';
    // ⊞ multichat is the parallel split-view grid. It only makes sense for the
    // two parallel modes (`versus` = democratic plan-vote, `moderator` =
    // moderator decides). `sequential` ("each") is the legacy serial
    // single-stream chat by definition — no grid for that mode.
    const _gridEligible = parts.length >= 2 && (groupMode === 'versus' || groupMode === 'moderator');
    const _gridLabel = groupMode === 'moderator' ? '⊞ multichat (mod)' : '⊞ multichat (vs)';
    const _gridTitle = groupMode === 'moderator'
      ? 'Launch agentic multichat — each agent gets its own column; moderator (slot 1) decides the plan'
      : 'Launch agentic multichat — each agent gets its own column; democratic plan vote';
    const multichatBtnHtml = _gridEligible
      ? `<button class="mcg-create-btn" id="mcg-create-btn" title="${_gridTitle}">${_gridLabel}</button>`
      : '';
    pBar.innerHTML = chipsHtml + modeToggleHtml + `<button class="chat-participant-add" id="chat-participant-add" title="Invite employee (or type @ in message)">+ invite</button>` + multichatBtnHtml;

    pBar.querySelectorAll('.chip-remove').forEach((btn) => {
      (btn as HTMLElement).addEventListener('click', async () => {
        const sid = String(getAppState().currentSession || '');
        const empId = (btn as HTMLElement).dataset['id']!;
        const chip = (btn as HTMLElement).closest('.chat-participant-chip') as HTMLElement | null;
        const chipIdx = chip ? parseInt(chip.dataset['idx']!, 10) : -1;
        _pending(sid).delete(empId);
        const r = await fetch(api.config.baseUrl + `/v1/sessions/${encodeURIComponent(sid)}/participants/${encodeURIComponent(empId)}`, { method: 'DELETE' }).catch(() => null);
        const s = cache.find((x) => String(x['id']) === sid) as Record<string, unknown> | undefined;
        let nextParticipants: string[] | null = r?.ok ? (await r.json()).participants : null;
        if (!nextParticipants && s) {
          const partsArr = [...((s['participants'] as string[]) || [])];
          if (chipIdx >= 0 && chipIdx < partsArr.length) partsArr.splice(chipIdx, 1);
          else { const idx2 = partsArr.indexOf(empId); if (idx2 !== -1) partsArr.splice(idx2, 1); }
          nextParticipants = partsArr;
        }
        if (s && Array.isArray(nextParticipants)) s['participants'] = nextParticipants;
        chatParticipants._updateParticipants(nextParticipants || []);
        getSessionActions().bumpParticipantsRevision();
      });
    });

    const modeToggle = pBar.querySelector('#chat-mode-toggle') as HTMLElement | null;
    if (modeToggle) modeToggle.addEventListener('click', async () => {
      const sid = String(getAppState().currentSession || '');
      const _cycle: Record<string, string> = { sequential: 'moderator', moderator: 'versus', versus: 'sequential' };
      const nextMode = _cycle[groupMode] || 'sequential';
      const r = await fetch(api.config.baseUrl + `/v1/sessions/${encodeURIComponent(sid)}/group-mode`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: nextMode })
      }).catch(() => null);
      if (r?.ok) {
        const d = await r.json();
        const appliedMode = d?.groupMode || nextMode;
        const s = cache.find((x) => String(x['id']) === sid) as Record<string, unknown> | undefined;
        if (s) s['groupMode'] = appliedMode;
        _sessionGroupModes.set(sid, appliedMode);
        this._updateParticipants(parts, appliedMode);
      }
    });

    (pBar.querySelector('#chat-participant-add') as HTMLElement | null)?.addEventListener('click', () => {
      this._openAtPicker(pBar.querySelector('#chat-participant-add') as HTMLElement, 'invite');
    });

    (pBar.querySelector('#mcg-create-btn') as HTMLElement | null)?.addEventListener('click', () => {
      const mode = sessionToGroupMode(groupMode);
      if (!mode) return; // sequential — button is hidden anyway
      this._createMultichatGroup(parts, mode, empMap);
    });

    let _dragSrcIdx: number | null = null;
    let _chipDragged = false;
    pBar.querySelectorAll('.chat-participant-chip').forEach((chip) => {
      const chipEl = chip as HTMLElement;
      chipEl.addEventListener('dragstart', (e: DragEvent) => {
        _dragSrcIdx = parseInt(chipEl.dataset['idx']!, 10);
        _chipDragged = true;
        chipEl.classList.add('chip-dragging');
        e.dataTransfer!.effectAllowed = 'move';
      });
      chipEl.addEventListener('dragend', () => {
        chipEl.classList.remove('chip-dragging');
        // Also clear _dragSrcIdx so a cancelled drag (released outside the
        // chip bar — no drop fires) can't combine with a later target idx.
        _dragSrcIdx = null;
        setTimeout(() => _chipDragged = false, 0);
      });
      (chipEl.querySelector('.chip-name') as HTMLElement | null)?.addEventListener('click', () => {
        if (_chipDragged) return;
        const empId = chipEl.dataset['id']!;
        const emp = empMap[empId] || { id: empId };
        const token = this._mentionTokenForEmployee(emp);
        if (!_ta) return;
        const cur = _ta.selectionStart ?? _ta.value.length;
        const before = _ta.value.slice(0, cur);
        const after = _ta.value.slice(cur);
        const needsSpace = before.length > 0 && !before.endsWith(' ');
        _ta.value = before + (needsSpace ? ' ' : '') + '@' + token + ' ' + after;
        const newPos = cur + (needsSpace ? 1 : 0) + token.length + 2;
        _ta.setSelectionRange(newPos, newPos);
        try {
          _ta.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (_) {}
        _ta.focus();
        _autoGrow?.();
      });
      chipEl.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'move'; chipEl.classList.add('chip-drag-over'); });
      chipEl.addEventListener('dragleave', () => chipEl.classList.remove('chip-drag-over'));
      chipEl.addEventListener('drop', async (e: DragEvent) => {
        e.preventDefault();
        chipEl.classList.remove('chip-drag-over');
        const targetIdx = parseInt(chipEl.dataset['idx']!, 10);
        if (_dragSrcIdx === null || _dragSrcIdx === targetIdx) return;
        const newOrder = [...parts];
        const [moved] = newOrder.splice(_dragSrcIdx, 1);
        newOrder.splice(targetIdx, 0, moved);
        _dragSrcIdx = null;
        const sid = String(getAppState().currentSession || '');
        const r = await fetch(api.config.baseUrl + `/v1/sessions/${encodeURIComponent(sid)}/participants/order`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: newOrder })
        }).catch(() => null);
        if (r?.ok) {
          const s = cache.find((x) => String(x['id']) === sid) as Record<string, unknown> | undefined;
          if (s) s['participants'] = newOrder;
          this._updateParticipants(newOrder);
        }
      });
    });
  },

  async _createMultichatGroup(empIds: string[], mode: 'vs' | 'mod', empMap: Record<string, Record<string, string>>): Promise<void> {
    const btn = document.getElementById('mcg-create-btn') as HTMLButtonElement | null;
    const _restoreLabel = mode === 'mod' ? '⊞ multichat (mod)' : '⊞ multichat (vs)';
    if (btn) { btn.disabled = true; btn.textContent = '…creating'; }
    try {
      const agentSlots = empIds.map((id) => ({
        id,
        label: empMap[id]?.['name'] || id,
      }));
      // Propagate the user's main-channel CWD so every slot session inherits
      // the same working directory — keeps file-tool resolution consistent
      // across all per-agent columns the row will render.
      const workingDir = getAppState().sessionWorkingDir || '';
      // Tag the user's CURRENT session as the multichat host. After this
      // POST returns, the host session has multichatGroupId set on the
      // server; subsequent /turn calls write a multichat-turn marker into
      // its message log, which MessageList renders as an inline row of
      // mini-bubbles (one per slot agent).
      const mainSessionId = String(getAppState().currentSession || '');
      const r = await fetch(api.config.baseUrl + '/v1/multichat/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Multichat', mode, planMode: true, agentSlots, workingDir, mainSessionId }),
      });
      const d = await r.json();
      if (d.success && d.group?.id) {
        // Refresh the session list so the host session's new
        // multichatGroupId tag flows into the FE store — chat.ts::send()
        // reads it to route prompts to /v1/multichat/groups/:id/turn.
        try { await session.fetchList(); } catch (_) {}
        if (btn) { btn.disabled = false; btn.textContent = _restoreLabel; }
      } else {
        console.error('multichat-group create failed:', d.error);
        if (btn) { btn.disabled = false; btn.textContent = _restoreLabel; }
      }
    } catch (e) {
      console.error('multichat-group create error:', e);
      if (btn) { btn.disabled = false; btn.textContent = _restoreLabel; }
    }
  },

  init(textarea: HTMLTextAreaElement, autoGrowFn: () => void): void {
    _ta = textarea;
    _autoGrow = autoGrowFn;

    // session:switched → reload @-mention employees + sync participants
    let _prevSid = useSessionStore.getState().currentId;
    useSessionStore.subscribe((state) => {
      if (state.currentId === _prevSid) return;
      _prevSid = state.currentId;
      this._loadAtEmployees();
      const cache = (session.getCached() || []) as unknown as Record<string, unknown>[];
      const cur = cache.find((s) => String(s['id']) === String(getAppState().currentSession || '')) as Record<string, unknown> | undefined;
      this._updateParticipants((cur?.['participants'] as string[]) || []);
    });

    // session:participants:changed → re-derive participants from cache
    let _prevPartRev = useSessionStore.getState().participantsRevision;
    useSessionStore.subscribe((state) => {
      if (state.participantsRevision === _prevPartRev) return;
      _prevPartRev = state.participantsRevision;
      const cache = (session.getCached() || []) as unknown as Record<string, unknown>[];
      const cur = cache.find((s) => String(s['id']) === String(getAppState().currentSession || '')) as Record<string, unknown> | undefined;
      this._updateParticipants((cur?.['participants'] as string[]) || []);
    });

    this._loadAtEmployees();
    setTimeout(() => {
      const cache = (session.getCached() || []) as unknown as Record<string, unknown>[];
      const cur = cache.find((s) => String(s['id']) === String(getAppState().currentSession || '')) as Record<string, unknown> | undefined;
      this._updateParticipants((cur?.['participants'] as string[]) || []);
    }, 500);
  },

  bindTextarea(textarea: HTMLTextAreaElement, autoGrowFn: () => void): void {
    _ta = textarea;
    _autoGrow = autoGrowFn;
  }
};

export default chatParticipants;
