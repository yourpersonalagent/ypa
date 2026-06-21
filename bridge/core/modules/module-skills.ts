// ── Module-provided skill discovery ─────────────────────────────────────────
// Modules can declare `provides.skills: ['<name>', ...]` in their manifest
// and ship the body at `<moduleDir>/skills/<name>/SKILL.md`. Skills appear
// in the `#` Chat Command Picker as `#skill-<name>` only while the owning
// module is active — disabling/reloading the module is enough to drop them
// from the picker the next time the /v1/tools/ cache rolls.
//
// Files live at this convention because it matches the meta-skills layout
// (`modules/skills-editor/skills/<name>/SKILL.md`) so a meta-skill author
// can drop a SKILL.md anywhere and the same parser handles it.
'use strict';

const fs = require('fs');
const path = require('path');
const registry = require('./registry');

const MODULES_DIR = path.join(__dirname, '..', '..', 'modules');

function parseFrontmatterField(content: string, field: string): string | null {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'm');
  const m = fm[1].match(re);
  return m ? m[1].trim() : null;
}

function skillFile(moduleName: string, skillName: string): string {
  return path.join(MODULES_DIR, moduleName, 'skills', skillName, 'SKILL.md');
}

interface ModuleSkillItem {
  name: string;          // bare skill slug (used to build `#skill-<name>`)
  moduleName: string;    // owning module
  filePath: string;      // absolute path to SKILL.md
  desc: string;          // frontmatter description, or a synthesised fallback
  category: string;      // frontmatter category, or '' if untagged
}

// Walk the registry once per call. Cheap — there are ≤ ~40 modules and the
// /v1/tools/ result is cached for 60s upstream so this rarely fires.
function listModuleSkills(): ModuleSkillItem[] {
  const out: ModuleSkillItem[] = [];
  const seen = new Set<string>();
  for (const handle of registry.listAll()) {
    if (handle.state !== 'active') continue;
    const declared = handle.manifest?.provides?.skills;
    if (!Array.isArray(declared) || declared.length === 0) continue;
    for (const skillName of declared) {
      if (typeof skillName !== 'string' || !skillName) continue;
      if (seen.has(skillName)) continue;            // first-registrant wins
      const filePath = skillFile(handle.name, skillName);
      let desc = `Module skill (${handle.name}): ${skillName}`;
      let category = '';
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const d = parseFrontmatterField(raw, 'description');
        if (d) desc = d;
        const c = parseFrontmatterField(raw, 'category');
        if (c) category = c;
      } catch {
        // Manifest declared a skill but the file is missing. Skip silently;
        // the route handler will 404 if anyone tries to invoke it. We don't
        // throw at boot because the file may land on next module reload.
        continue;
      }
      out.push({ name: skillName, moduleName: handle.name, filePath, desc, category });
      seen.add(skillName);
    }
  }
  return out;
}

// Returns the raw SKILL.md body (frontmatter intact) and the owning module.
// Used by GET /v1/modules/skills/:name to serve the body to the frontend
// `#skill-` interceptor.
function readModuleSkillBody(name: string): { content: string; moduleName: string } | null {
  if (!name || typeof name !== 'string') return null;
  for (const handle of registry.listAll()) {
    if (handle.state !== 'active') continue;
    const declared = handle.manifest?.provides?.skills;
    if (!Array.isArray(declared) || !declared.includes(name)) continue;
    const filePath = skillFile(handle.name, name);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return { content, moduleName: handle.name };
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = { listModuleSkills, readModuleSkillBody };
