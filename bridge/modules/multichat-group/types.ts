'use strict';

export type MultichatPhase = 'idle' | 'plan' | 'decide' | 'execute';
// 'vs' = democratic vote (parallel grid + plan-vote)
// 'mod' = moderator decides (parallel grid + first-slot picks)
// (Legacy 'each' = serial single-chat lives in chat-participants.ts as
// `groupMode === 'sequential'` and never spawns a multichat group.)
export type MultichatMode = 'vs' | 'mod';

export interface AgentSlot {
  id: string;        // employee ID
  sessionId: string; // member session ID
  label?: string;    // display name override (defaults to employee name)
}

export interface VotePayload {
  slotIdx: number;
  voteFor: number;   // slot index of chosen plan
  change: string | null;
}

export interface PlanEmit {
  slotIdx: number;
  sessionId: string;
  plan: string;
  ts: number;
}

export interface MultichatGroup {
  id: string;
  slug: string;
  title: string;
  mode: MultichatMode;
  agentSlots: AgentSlot[];
  planMode: boolean;
  planModel: string;
  voteTimeoutMs: number;
  currentTurn: number;
  phase: MultichatPhase;
  createdAt: number;
  lastUsed: number;
}
