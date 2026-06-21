// mediaSchemaClient — fetches + caches /v1/media/schema/<provider>/<model>.
//
// Schemas are static per bridge process — we cache by `provider:model` key for
// the lifetime of the page. A null result (no schema match) is also cached so
// repeat lookups for unmodeled provider/model pairs are free.

import { api } from '../api.js';

export type MediaWidget =
  | 'select'
  | 'aspect-ratio'
  | 'range'
  | 'number'
  | 'text'
  | 'multiline'
  | 'bool';

export interface MediaFieldOption { value: string; label: string }

export interface MediaField {
  key: string;
  label: string;
  widget: MediaWidget;
  default?: string | number | boolean;
  values?: MediaFieldOption[];
  min?: number;
  max?: number;
  step?: number;
  help?: string;
}

export interface MediaSchema {
  provider: string;
  model: string;
  category: 'image' | 'tts' | 'music' | 'video' | 'stt';
  fields: MediaField[];
  deprecation?: { date: string; message: string };
  source?: 'builtin' | 'plugin';
  pluginName?: string;
}

const cache = new Map<string, MediaSchema | null>();
const inflight = new Map<string, Promise<MediaSchema | null>>();

export function getCachedSchema(provider: string, model: string): MediaSchema | null | undefined {
  return cache.get(`${provider}:${model}`);
}

export async function fetchSchema(provider: string, model: string): Promise<MediaSchema | null> {
  const key = `${provider}:${model}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const url = `${api.config.baseUrl}/v1/media/schema/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
      const res = await fetch(url);
      if (!res.ok) {
        cache.set(key, null);
        return null;
      }
      const data = (await res.json()) as { success?: boolean; schema?: MediaSchema | null };
      const schema = data && data.success !== false && data.schema ? data.schema : null;
      cache.set(key, schema);
      return schema;
    } catch (e) {
      console.warn('media schema fetch failed', provider, model, (e as Error).message);
      cache.set(key, null);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function clearSchemaCache(): void {
  cache.clear();
}
