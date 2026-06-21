// cap-presets — per-model capability preset persistence.
// A preset is keyed by (provider, model name, harnessInstance, codexInstance).
// We only write a preset when the user actively diverges from the natural
// defaults (i.e. all model-supported caps fully enabled). When the resulting
// state matches the natural defaults, we delete the preset so unmodified
// models leave no trace in storage.

import type { CurrentModel, UserCaps, ModelCaps } from '../stores/index.js';

export type PresetEntry = UserCaps;

const KEY = 'yha.capPresets';

export function presetKey(
  model: Pick<CurrentModel, 'name' | 'provider'> | null | undefined,
  harnessInstance: string,
  codexInstance: string,
): string | null {
  if (!model?.name) return null;
  return `${model.provider || ''}|${model.name}|${harnessInstance || ''}|${codexInstance || ''}`;
}

export function readAllPresets(): Record<string, PresetEntry> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, PresetEntry>) : {};
  } catch {
    return {};
  }
}

export function loadPreset(key: string | null): PresetEntry | null {
  if (!key) return null;
  const all = readAllPresets();
  return all[key] || null;
}

function writeAll(all: Record<string, PresetEntry>): void {
  if (Object.keys(all).length === 0) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(all));
}

export function naturalDefaults(modelCaps: ModelCaps): UserCaps {
  return {
    vision: !!modelCaps.vision,
    reasoning: modelCaps.reasoning ? 'enabled' : null,
    tools: modelCaps.tools ? 'on' : false,
  };
}

export function isNaturalDefault(caps: UserCaps, modelCaps: ModelCaps): boolean {
  const def = naturalDefaults(modelCaps);
  return caps.vision === def.vision && caps.reasoning === def.reasoning && caps.tools === def.tools;
}

export function savePreset(key: string | null, caps: UserCaps, modelCaps: ModelCaps): void {
  if (!key) return;
  const all = readAllPresets();
  if (isNaturalDefault(caps, modelCaps)) {
    if (key in all) {
      delete all[key];
      writeAll(all);
    }
    return;
  }
  all[key] = { ...caps };
  writeAll(all);
}

export function clearAllPresets(): void {
  localStorage.removeItem(KEY);
}

export function countPresets(): number {
  return Object.keys(readAllPresets()).length;
}
