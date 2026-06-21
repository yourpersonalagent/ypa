import { store } from '../store.js';

export interface DayCosts {
  total: number;
  byModel: Record<string, number>;
  byProvider: Record<string, number>;
}

export interface CostsData {
  allTime: { total: number; byModel: Record<string, number>; byProvider: Record<string, number> };
  daily: Record<string, DayCosts>;
}

export function emptyCosts(): CostsData {
  return { allTime: { total: 0, byModel: {}, byProvider: {} }, daily: {} };
}

export async function loadCosts(): Promise<CostsData> {
  try {
    const r = await fetch('/v1/costs');
    if (r.ok) return (await r.json()) as CostsData;
  } catch { }
  return emptyCosts();
}

export function trackCost(): void {}

export async function clearCosts(): Promise<void> {
  try {
    await fetch('/v1/costs', { method: 'DELETE' });
  } catch { }
}

export function getHiddenModels(): Set<string> {
  const stored = store.get('hiddenModels', []) as unknown;
  return new Set(Array.isArray(stored) ? (stored as string[]) : []);
}
