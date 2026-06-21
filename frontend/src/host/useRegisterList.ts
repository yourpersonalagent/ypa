// React hook that subscribes a component to a register and re-renders
// it whenever entries change. Used by every `<Slot>` component.

import { useSyncExternalStore } from 'react';
import type { Register, Entry } from './registers.js';

export function useRegisterList<T>(register: Register<T>): ReadonlyArray<Entry<T>> {
  return useSyncExternalStore(
    (cb) => register.on('change', cb),
    () => register.list(),
    () => register.list(),
  );
}

export function useRegisterListAll<T>(register: Register<T>): ReadonlyArray<Entry<T>> {
  return useSyncExternalStore(
    (cb) => register.on('change', cb),
    () => register.listAll(),
    () => register.listAll(),
  );
}
