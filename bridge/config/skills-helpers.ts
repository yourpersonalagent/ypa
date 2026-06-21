// ── Skills file storage helpers ─────────────────────────────────────────────
// Extracted from handler.ts. Per-user (Q16) — routed via bridge/core/paths.ts.
// Shared by config-core-routes (GET /v1/config/) and presets-routes
// (/v1/config/skills/*). `skillsDir` on core/paths is a getter that re-resolves
// per access (once the per-user migration runs), so resolve it at call-time
// here rather than caching it at import.
'use strict';

const fs = require('fs');
const path = require('path');

function skillsDir() {
  return require('../core/paths').skillsDir;
}

async function ensureSkillsDir() {
  try {
    await fs.promises.mkdir(skillsDir(), { recursive: true });
  } catch (_) {}
}

function skillNameToFile(name) {
  return path.join(skillsDir(), name.replace(/[^a-zA-Z0-9_\-. ]/g, '_') + '.md');
}

async function listSkills() {
  await ensureSkillsDir();
  let files;
  try {
    files = await fs.promises.readdir(skillsDir());
  } catch (_) {
    return [];
  }
  const skills: any[] = [];
  for (const f of files.filter((f) => f.endsWith('.md'))) {
    const name = f.slice(0, -3);
    try {
      const raw = await fs.promises.readFile(path.join(skillsDir(), f), 'utf8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      let description = '';
      if (fm) {
        const m = fm[1].match(/^description:\s*(.+)$/m);
        if (m) description = m[1].trim();
      }
      skills.push({ name, description });
    } catch (_) {
      skills.push({ name, description: '' });
    }
  }
  return skills;
}

module.exports = { ensureSkillsDir, skillNameToFile, listSkills };
