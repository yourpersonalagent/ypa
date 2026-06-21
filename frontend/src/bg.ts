// ── WebGL background renderer removed ────────────────────────────────────────
// Previously drove #bg-canvas and #logo-canvas with a WebGL plasma shader,
// with chat-empty lifecycle management and a 10fps draw loop. Removed because
// CSS filter chains on WebGL canvases force Chrome to re-composite the entire
// viewport at 60fps regardless of actual draw rate — costing 33-35% GPU even
// while idle. Same fate befell the hero canvas on the marketing page and the
// voice-modal backdrop. RIP.

import { BG_THEMES } from './bg-themes.js';

export const bg = {
  init()    {},
  destroy() {},
  setTheme(_id: string) {},
  getTheme(): string { return 'none'; },
  listThemes() { return BG_THEMES; },
};
