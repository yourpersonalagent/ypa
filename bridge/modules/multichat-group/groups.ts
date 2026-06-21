'use strict';

const crypto = require('crypto');
const logger = require('../../core/logger');
const { saveGroup, loadGroup: loadGroupFromDisk, deleteGroupFile, loadAllGroups } = require('./persistence');

const _groups = new Map<string, any>();

function _slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24).replace(/-+$/, '') || 'group';
}

function createGroup({ title, mode, agentSlots, planMode, workingDir, hostSessionId }: any): any {
  const id = 'mcg-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const slug = _slugify(title || 'multichat');

  // Lazy-require to avoid circular deps at module load time
  const { createBackgroundSession } = require('../../sessions-internal');
  const { displaySessions } = require('../../core/state');

  const slotCwd = typeof workingDir === 'string' && workingDir ? workingDir : '';

  const slots = (agentSlots || []).map((spec: any, idx: number) => {
    const empId = String(spec.id || '');
    const ts = Date.now().toString(36);
    const safeEmpId = empId.slice(0, 6).replace(/[^a-z0-9]/gi, '');
    const sessionId = `mc-${slug}-${idx}-${safeEmpId}-${ts}`;
    const sessionName = `${title || 'multichat'} · slot ${idx + 1} · ${empId}`;
    createBackgroundSession(sessionId, sessionName);
    const s = displaySessions.get(sessionId);
    if (s) {
      s.multichatGroupId = id;
      // All slot sessions share the user's main-channel working directory
      // so file-tool resolution / path autocompletion is identical across
      // every column in the grid.
      if (slotCwd) s.workingDir = slotCwd;
    }
    return { id: empId, sessionId, label: spec.label || empId };
  });

  const now = Date.now();
  const group: any = {
    id,
    slug,
    title: title || 'multichat',
    mode: mode === 'mod' ? 'mod' : 'vs',
    agentSlots: slots,
    planMode: planMode !== false,
    planModel: 'claude-haiku-4-5-20251001',
    voteTimeoutMs: 30_000,
    currentTurn: 0,
    phase: 'idle',
    createdAt: now,
    lastUsed: now,
    workingDir: slotCwd || null,
    hostSessionId: hostSessionId ? String(hostSessionId) : null,
  };

  _groups.set(id, group);
  saveGroup(group).catch((e: Error) => logger.warn('multichat-group.save-failed', { id, error: e.message }));
  return group;
}

function getGroup(id: string): any | null {
  return _groups.get(id) || null;
}

function updateGroup(id: string, patch: any): any | null {
  const g = _groups.get(id);
  if (!g) return null;
  Object.assign(g, patch);
  saveGroup(g).catch((e: Error) => logger.warn('multichat-group.save-failed', { id, error: e.message }));
  return g;
}

function setPhase(id: string, phase: string): void {
  const g = _groups.get(id);
  if (g) g.phase = phase;
}

function deleteGroup(id: string, keepSessions: boolean): void {
  const g = _groups.get(id);
  if (!g) return;
  if (!keepSessions) {
    const { displaySessions, chatHistory, claudeSessions } = require('../../core/state');
    const { markSessionDeleted, deleteSessionFile, saveIndexToDisk } = require('../../sessions-internal');
    for (const slot of g.agentSlots || []) {
      markSessionDeleted(slot.sessionId);
      displaySessions.delete(slot.sessionId);
      chatHistory.delete(slot.sessionId);
      claudeSessions.delete(slot.sessionId);
      deleteSessionFile(slot.sessionId).catch(() => {});
    }
    saveIndexToDisk();
  }
  _groups.delete(id);
  deleteGroupFile(id).catch(() => {});
}

function listGroups(): any[] {
  return [..._groups.values()];
}

function loadGroupsFromDisk(): void {
  for (const g of loadAllGroups()) {
    // Legacy migration: old groups stored mode === 'each' for the parallel
    // democratic-vote mode. The new literal is 'vs'. Behaviour is identical;
    // we just rename so the wire is consistent everywhere.
    const mode = g.mode === 'each' ? 'vs' : g.mode;
    _groups.set(g.id, { ...g, mode, phase: 'idle' }); // reset phase to idle on restart
  }
  logger.info('multichat-group.loaded', { count: _groups.size });
}

module.exports = { createGroup, getGroup, updateGroup, setPhase, deleteGroup, listGroups, loadGroupsFromDisk };
