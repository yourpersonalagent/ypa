// Phase 5 — push the live appCommands catalog to the bridge so the
// pet-vision MCP tool `pet_commands` can describe the YHA UI surface
// (settings, views, themes, panels, modules) to other agents.
//
// Subscribes to `registers.appCommands.on('change')`. The register fires
// once per add/remove (debounced via microtask), so on boot it'll fire
// many times in quick succession as modules register their entries —
// we coalesce with a 200 ms trailing-edge debounce so the bridge sees
// one push per "settling event" rather than 150 of them.
//
// Visibility-independent on purpose: the catalog reflects what the user
// CAN do, not what the pet is looking at. Even when the pet is hidden,
// agents may still want to know the available palette commands.
'use strict';

import host from '../../../host/index.js';
import type { AppCommand } from '../../../host/keys.js';

const DEBOUNCE_MS = 200;

interface CatalogCommand {
  id: string;
  group: string;
  label: string;
  keywords?: string[];
  badge?: string;
  state?: { active?: boolean; value?: string };
}

function bridgeBaseUrl(): string {
  const cfg = (window as Window & { API_CONFIG?: { baseUrl?: string } }).API_CONFIG;
  return cfg?.baseUrl || window.location.origin;
}

function projectEntry(e: AppCommand): CatalogCommand {
  // Evaluate state() once per push so the bridge sees the same active/value
  // the palette would render right now. Defensive try/catch — a buggy state()
  // shouldn't poison the entire catalog push.
  let state: CatalogCommand['state'];
  if (typeof e.state === 'function') {
    try {
      const s = e.state();
      if (s && (s.active !== undefined || s.value !== undefined)) {
        state = { active: s.active, value: s.value };
      }
    } catch {
      /* swallow — entry just won't carry state for this push */
    }
  }
  return {
    id: e.id,
    group: e.group,
    label: e.label,
    keywords: e.keywords && e.keywords.length ? e.keywords : undefined,
    badge: e.badge,
    state,
  };
}

function pushNow(): void {
  try {
    const cmds = host.registers.appCommands.list().map(projectEntry);
    void fetch(bridgeBaseUrl() + '/v1/pet-vision/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ commands: cmds }),
    }).catch(() => { /* fire-and-forget */ });
  } catch {
    /* never block on a catalog push failure */
  }
}

let pending = 0;
function schedulePush(): void {
  if (pending) window.clearTimeout(pending);
  pending = window.setTimeout(() => {
    pending = 0;
    pushNow();
  }, DEBOUNCE_MS);
}

let installed = false;
/** Idempotent — safe to call from the module's activate(). */
export function installCatalogPush(): void {
  if (installed) return;
  installed = true;
  // Push the current snapshot immediately so the MCP tool has data even
  // before the next register mutation fires.
  schedulePush();
  host.registers.appCommands.on('change', schedulePush);
}
