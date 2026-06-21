'use strict';

interface Plan { slotIdx: number; plan: string }
interface Vote { slotIdx: number; voteFor: number; change: string | null }

function vote(plans: Plan[], votes: Vote[]): { winner: number; plan: string } {
  const counts = new Map<number, number>();
  const changes = new Map<string, number>();
  for (const v of votes) {
    const idx = Math.min(Math.max(0, v.voteFor), plans.length - 1);
    counts.set(idx, (counts.get(idx) || 0) + 1);
    if (v.change) changes.set(v.change, (changes.get(v.change) || 0) + 1);
  }
  // Plurality wins; tie-break by lowest slot index (deterministic)
  let winner = 0;
  let maxCount = 0;
  for (const [idx, count] of counts) {
    if (count > maxCount || (count === maxCount && idx < winner)) {
      winner = idx;
      maxCount = count;
    }
  }
  const base = plans[winner]?.plan || plans[0]?.plan || '';
  const threshold = votes.length / 2;
  const majority = [...changes.entries()]
    .filter(([, c]) => c > threshold)
    .map(([ch]) => ch);
  const plan = majority.length ? `${base}\n\nChanges: ${majority.join('; ')}` : base;
  return { winner, plan };
}

function moderatorPick(modResponse: string, plans: Plan[]): { winner: number; plan: string } {
  const pickMatch = modResponse.match(/PICK:\s*(\d+)/i);
  const amendMatch = modResponse.match(/AMENDMENT:\s*(.+?)(?:\n|$)/i);
  const idx = pickMatch ? Math.min(parseInt(pickMatch[1], 10), plans.length - 1) : 0;
  const base = plans[idx]?.plan || plans[0]?.plan || '';
  const amendment = amendMatch ? amendMatch[1].trim() : '';
  const plan = amendment && amendment.toLowerCase() !== 'none' ? `${base}\n\nAmendment: ${amendment}` : base;
  return { winner: idx, plan };
}

module.exports = { vote, moderatorPick };
