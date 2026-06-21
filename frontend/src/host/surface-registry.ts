// Live registry for modal/window/picker state exposed to automation.
//
// New visible surfaces should register once while mounted and update their
// open state. This avoids DOM guessing and gives browser agents a stable,
// typed way to inspect/focus/close UI independently of its visual layout.

export type AgentSurfaceKind = 'modal' | 'window' | 'picker' | 'panel' | 'overlay';

export interface AgentSurfaceDescriptor {
  id: string;
  label: string;
  kind: AgentSurfaceKind;
  module?: string;
  openCommand?: string;
  closeCommand?: string;
  focus?: () => void;
  close?: () => void;
}

export interface AgentSurfaceSnapshot {
  id: string;
  label: string;
  kind: AgentSurfaceKind;
  module?: string;
  open: boolean;
  openCommand?: string;
  closeCommand?: string;
}

interface SurfaceRecord {
  descriptor: AgentSurfaceDescriptor;
  open: boolean;
}

export interface AgentSurfaceController {
  setOpen(open: boolean): void;
  dispose(): void;
}

const surfaces = new Map<string, SurfaceRecord>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    try { listener(); }
    catch (error) { console.warn('[surfaceRegistry] listener threw:', error); }
  }
  window.dispatchEvent(new CustomEvent('ypa:agent-surfaces-changed'));
}

export function registerAgentSurface(
  descriptor: AgentSurfaceDescriptor,
  initiallyOpen = false,
): AgentSurfaceController {
  if (!descriptor.id) throw new Error('[surfaceRegistry] descriptor.id is required');
  if (surfaces.has(descriptor.id)) {
    console.warn(`[surfaceRegistry] duplicate surface id="${descriptor.id}" — latest registration wins`);
  }
  const record: SurfaceRecord = { descriptor, open: initiallyOpen };
  surfaces.set(descriptor.id, record);
  emitChange();

  let disposed = false;
  return {
    setOpen(open) {
      if (disposed || record.open === open) return;
      record.open = open;
      emitChange();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (surfaces.get(descriptor.id) === record) {
        surfaces.delete(descriptor.id);
        emitChange();
      }
    },
  };
}

export function listAgentSurfaces(): AgentSurfaceSnapshot[] {
  return [...surfaces.values()]
    .map(({ descriptor, open }) => ({
      id: descriptor.id,
      label: descriptor.label,
      kind: descriptor.kind,
      module: descriptor.module,
      open,
      openCommand: descriptor.openCommand,
      closeCommand: descriptor.closeCommand,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function focusAgentSurface(id: string): boolean {
  const record = surfaces.get(id);
  if (!record) return false;
  record.descriptor.focus?.();
  return !!record.descriptor.focus;
}

export function closeAgentSurface(id: string): boolean {
  const record = surfaces.get(id);
  if (!record) return false;
  record.descriptor.close?.();
  return !!record.descriptor.close;
}

export function subscribeAgentSurfaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
