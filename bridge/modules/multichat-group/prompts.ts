'use strict';

const PLAN_PREAMBLE = `You are in a multi-agent planning round. Your task is to write a PLAN — a concise description of what you intend to do — NOT to execute anything yet. After all agents submit plans, one plan will be selected and all agents will execute it.

Format your response as:
PLAN: <your intended approach, 2-5 sentences>
CRITIQUE (optional): <one concern about a different approach, if relevant>

Do NOT use any tools or take any real actions in this planning phase.`;

function VOTE_PREAMBLE(plans: Array<{ slotIdx: number; plan: string }>): string {
  const planList = plans.map((p) => `Slot ${p.slotIdx}: ${p.plan}`).join('\n\n');
  return `Planning round complete. Here are all submitted plans:\n\n${planList}\n\nVote for the plan number you would execute. Format:\nVOTE: <slot number>\nCHANGE: <one suggested change, or "none">`;
}

function MOD_DECIDE_PREAMBLE(plans: Array<{ slotIdx: number; plan: string }>): string {
  const planList = plans.map((p) => `Slot ${p.slotIdx}: ${p.plan}`).join('\n\n');
  return `You are the moderator. Here are all submitted plans:\n\n${planList}\n\nPick the best plan and optionally amend it. Format:\nPICK: <slot number>\nAMENDMENT: <amendment, or "none">`;
}

module.exports = { PLAN_PREAMBLE, VOTE_PREAMBLE, MOD_DECIDE_PREAMBLE };
