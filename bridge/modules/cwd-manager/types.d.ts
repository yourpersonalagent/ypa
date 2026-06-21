// cwd-manager — shared type surface.
//
// A .d.ts so it is never executed at runtime (no risk of flipping an
// executed .ts module to ESM, where `module.exports` would throw
// "module is not defined" under bun). Executed .ts files in this module
// stay pure CommonJS — no `import`/`export` statements — and reference
// these types via inline `import('./types').T` type expressions, which the
// transpiler erases.

export type CwdMode = 'off' | 'active' | 'idle' | 'alert';
export type CwdLastAction = 'none' | 'started_chat' | 'checkup' | 'asked_human' | 'all_done';
export type CwdNeedsAgent = null | 'progress' | 'checkup' | 'resume';

export interface CwdManagerEntry {
  cwd: string;
  enabled: boolean;
  activeIntervalMs: number;
  idleIntervalMs: number;
  mode: CwdMode;
  lastProgrammaticAt: number;
  lastAgentAt: number;
  lastTodoHash: string;
  openTodoCount: number;
  inProgressCount: number;
  needsAgent: CwdNeedsAgent;
  needsAgentReason: string;
  managerSessionId?: string;
  activeCheckupSessionId?: string;
  pendingHumanQuestion?: boolean;
  /** Explicit opt-in for LLM-backed manager ticks. Monitoring can be on while this stays false. */
  agentEnabled: boolean;
  /** Explicit opt-in for autonomous task worker chats. Separate because these can modify files. */
  workerEnabled: boolean;
  lastWorkerAt?: number;
  lastAction: CwdLastAction;
  lastError?: string;
}

export interface CwdManagerStore {
  normalizeCwd(cwd: string | undefined): string;
  list(): CwdManagerEntry[];
  get(cwd: string): CwdManagerEntry | undefined;
  /** Get an entry, materializing a default (unsaved) one if absent. */
  ensure(cwd: string): CwdManagerEntry;
  upsert(entry: CwdManagerEntry): CwdManagerEntry;
  remove(cwd: string): boolean;
  save(): void;
}

export interface ProgrammaticResult {
  entry: CwdManagerEntry;
  changed: boolean;
}

export interface AgentRunner {
  run(entry: CwdManagerEntry): Promise<CwdManagerEntry>;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** Run a programmatic tick for one cwd immediately (force / wake). */
  tickNow(cwd: string): Promise<CwdManagerEntry | undefined>;
}
