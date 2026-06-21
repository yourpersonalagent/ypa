// employeesStore — live employee data so badges (and other UI surfaces)
// re-render when something changes (color, name, role) without needing a
// reload. personnel.ts owns writes; consumers subscribe via the hook.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export interface EmployeeRecord {
  id: string;
  name?: string;
  role?: string;
  symbolColor?: string;
  fullName?: string;
  defaultModel?: string;
  fallbackModel?: string;
  toolSetPreset?: string;
  systemPromptPreset?: string;
  skillSetPreset?: string;
  standard?: boolean;
}

export interface EmployeesState {
  employees: EmployeeRecord[];
  byId: Record<string, EmployeeRecord>;
}

export interface EmployeesActions {
  setEmployees: (employees: EmployeeRecord[]) => void;
  upsertEmployee: (e: EmployeeRecord) => void;
  removeEmployee: (id: string) => void;
}

export type EmployeesStore = EmployeesState & EmployeesActions;

export const useEmployeesStore = create<EmployeesStore>()(
  devtools(
    (set) => ({
      employees: [],
      byId: {},
      setEmployees: (employees) => {
        const byId: Record<string, EmployeeRecord> = {};
        for (const e of employees) byId[e.id] = e;
        set({ employees, byId });
      },
      upsertEmployee: (e) =>
        set((s) => {
          const next = s.employees.filter((x) => x.id !== e.id);
          next.push(e);
          const byId = { ...s.byId, [e.id]: e };
          return { employees: next, byId };
        }),
      removeEmployee: (id) =>
        set((s) => {
          const { [id]: _drop, ...rest } = s.byId;
          return { employees: s.employees.filter((x) => x.id !== id), byId: rest };
        }),
    }),
    { name: 'EmployeesStore' }
  )
);

export function getEmployeesState(): EmployeesState {
  return useEmployeesStore.getState();
}

export function getEmployeesActions(): EmployeesActions {
  return useEmployeesStore.getState();
}
