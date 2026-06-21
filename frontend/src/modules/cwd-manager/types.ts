export type CwdMode = 'off' | 'active' | 'idle' | 'alert';
export type CwdNeedsAgent = null | 'progress' | 'checkup' | 'resume';
export type CwdLastAction = 'none' | 'started_chat' | 'checkup' | 'asked_human' | 'all_done';

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
  agentEnabled: boolean;
  workerEnabled: boolean;
  lastWorkerAt?: number;
  lastAction: CwdLastAction;
  lastError?: string;
}

export interface CwdManagerSummary {
  monitored: number;
  total: number;
  needingAgent: number;
  agentEnabled: number;
  workerEnabled: number;
}
