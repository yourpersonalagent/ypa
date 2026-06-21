// ── Routes for the Code-view UI persistence ──────────────────────────────────
// GET  /v1/code-view/state          → returns the saved state (or empty
//                                     defaults if no file exists yet).
// PUT  /v1/code-view/state          → overwrites the state file with the
//                                     posted JSON body.
//
// State shape mirrors what frontend/src/layouts/full/code/EditorRegion.tsx
// owns: the list of open tabs (path + name + last cursor offset) and the
// active tab path. Chat-column width is held client-side in localStorage
// (M8); the bridge does not store layout sizes.
//
// Storage path: bridge/state/code-view/state.json. Single-user setup means
// one file is enough — multi-workspace support can extend the key later.
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const STATE_DIR = path.join(__dirname, '..', 'state', 'code-view');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

interface CodeViewTab {
  path: string;
  name?: string;
  cursor?: number;
}
interface CodeViewLayout {
  right?: string[];
  bottom?: string[];
  rightActive?: string | null;
  bottomActive?: string | null;
}
interface CodeViewState {
  tabs: CodeViewTab[];
  activeTab: string | null;
  layout?: CodeViewLayout;
}

const EMPTY_STATE: CodeViewState = { tabs: [], activeTab: null };

async function readState(): Promise<CodeViewState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CodeViewState>;
    const out: CodeViewState = {
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs.filter((t: unknown) => t && typeof (t as CodeViewTab).path === 'string') : [],
      activeTab: typeof parsed.activeTab === 'string' ? parsed.activeTab : null,
    };
    if (parsed.layout && typeof parsed.layout === 'object') out.layout = parsed.layout;
    return out;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ...EMPTY_STATE };
    console.warn('[code-view] state.json unreadable, using empty:', e?.message);
    return { ...EMPTY_STATE };
  }
}

async function writeState(next: CodeViewState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  // Cap tabs at 50 — guards against an accidentally-bloated payload writing
  // a huge state file on every keystroke. The UI's LRU is 6 active states,
  // but tab descriptors are cheap so we tolerate more.
  const safe: CodeViewState = {
    tabs: (next.tabs || []).slice(0, 50).map((t) => ({
      path: String(t.path),
      name: t.name ? String(t.name) : undefined,
      cursor: typeof t.cursor === 'number' ? t.cursor : undefined,
    })),
    activeTab: next.activeTab ? String(next.activeTab) : null,
  };
  if (next.layout) {
    const l = next.layout;
    safe.layout = {
      right:  Array.isArray(l.right)  ? l.right.filter((x) => typeof x === 'string').slice(0, 20)  : undefined,
      bottom: Array.isArray(l.bottom) ? l.bottom.filter((x) => typeof x === 'string').slice(0, 20) : undefined,
      rightActive:  typeof l.rightActive  === 'string' ? l.rightActive  : null,
      bottomActive: typeof l.bottomActive === 'string' ? l.bottomActive : null,
    };
  }
  await fs.writeFile(STATE_FILE, JSON.stringify(safe, null, 2), 'utf8');
}

function registerCodeViewRoutes(app: any): void {
  app.get('/v1/code-view/state', async (_req: any, res: any) => {
    try {
      const state = await readState();
      res.json({ success: true, state });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message || 'read failed' });
    }
  });

  app.put('/v1/code-view/state', async (req: any, res: any) => {
    const body = req.body || {};
    if (typeof body !== 'object' || !Array.isArray(body.tabs)) {
      return res.status(400).json({ success: false, error: 'expected { tabs: [], activeTab }' });
    }
    try {
      await writeState({
        tabs: body.tabs,
        activeTab: body.activeTab ?? null,
        layout: body.layout && typeof body.layout === 'object' ? body.layout : undefined,
      });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message || 'write failed' });
    }
  });
}

module.exports = { registerCodeViewRoutes };
