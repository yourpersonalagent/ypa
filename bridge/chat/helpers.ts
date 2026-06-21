// ── Shared helpers for chat route handlers ────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const { config } = require('../core/state');
const {
  IMAGE_MIME,
  resolveLocalImageUrl,
  validateSessionId,
} = require('../sessions-internal');
const {
  EFFORT_LEVELS,
  isSlashCommand,
  getDefaultSystem,
  presetText,
  resolveModelId,
} = require('../providers');
// Phase-6: switched from a hard `require('../modules/multichat-personnel/employees')`
// to a `getModuleApi('multichat-personnel')` lookup at every call site so
// disabling the module in modules.json yields a clean null lookup instead
// of a require() blowup. `_getEmployee` wraps the lookup so the in-file
// callers stay short.
const { getModuleApi } = require('../core/modules');
function _getEmployee(id: string): any {
  const personnel: any = getModuleApi('multichat-personnel');
  return personnel?.getEmployee?.(id) ?? null;
}
const logger = require('../core/logger');

// ── Target agent resolution ───────────────────────────────────────────────────
function resolveTargetAgent(rawInput, session) {
  const participants = session?.participants || [];
  if (!participants.length) return null;
  const groupMode = session?.groupMode || 'sequential';
  const participantSet = new Set(participants.map((id) => String(id || '').toLowerCase()));

  const mentionMatch = rawInput.match(/^@([a-z0-9_-]+)\s*/i);
  if (mentionMatch) {
    const targetToken = String(mentionMatch[1] || '').toLowerCase();
    const emp = participants
      .map((id) => _getEmployee(id))
      .find((candidate) => {
        if (!candidate) return false;
        const cid = String(candidate.id || '').toLowerCase();
        const cname = String(candidate.name || '').toLowerCase();
        return participantSet.has(cid) && (cid === targetToken || cname === targetToken);
      });
    if (emp) {
      return {
        employees: [
          { emp, cleanInput: rawInput.slice(mentionMatch[0].length).trim() || rawInput.trim() },
        ],
        broadcast: false,
        viaMention: true,
      };
    }
  }

  if (groupMode === 'moderator') {
    const modEmp = _getEmployee(participants[0]);
    if (!modEmp) return null;
    return { employees: [{ emp: modEmp, cleanInput: rawInput }], broadcast: false };
  }

  const emps = participants.map((id) => _getEmployee(id)).filter(Boolean);
  if (!emps.length) return null;
  return {
    employees: emps.map((emp) => ({ emp, cleanInput: rawInput })),
    broadcast: true,
    mode: groupMode === 'versus' ? 'versus' : 'sequential',
  };
}

// Parse a leading `@token` from an assistant reply and resolve it to a session
// participant (employee or partner). Returns `{ emp, cleanInput }` when the
// mention targets a current participant, otherwise null. Used by the
// partner-to-partner mention-forwarding chain so a participant's reply that
// starts with `@otherParticipant ...` is re-dispatched as if the user had sent
// it directly to that participant.
function parseLeadingMentionToParticipant(text, session) {
  if (typeof text !== 'string' || !text) return null;
  const participants = session?.participants || [];
  if (!participants.length) return null;
  const m = text.match(/^@([a-z0-9_-]+)\s*/i);
  if (!m) return null;
  const targetToken = String(m[1] || '').toLowerCase();
  const participantSet = new Set(participants.map((id) => String(id || '').toLowerCase()));
  const emp = participants
    .map((id) => _getEmployee(id))
    .find((c) => {
      if (!c) return false;
      const cid = String(c.id || '').toLowerCase();
      const cname = String(c.name || '').toLowerCase();
      return participantSet.has(cid) && (cid === targetToken || cname === targetToken);
    });
  if (!emp) return null;
  const remainder = text.slice(m[0].length).trim();
  return { emp, cleanInput: remainder || text.trim() };
}

// ── Skill loading ─────────────────────────────────────────────────────────────
// `nameOrSet` is one of:
//   1. a key in config.skillSets (legacy named group; expanded to members), OR
//   2. a category slug — every mounted meta-skill whose frontmatter
//      `category:` matches is loaded, OR
//   3. a single skill name — resolved against the legacy config-skills dir
//      OR the meta-bridge skills dir, so /<skill> palette picks and one-off
//      sets work without authoring a real set.
// Each member is then resolved against both dirs (config first, meta second).
const CONFIG_SKILLS_DIR = path.join(__dirname, '..', 'skills');
// Q16: skills resolve through the per-user resolver. The skills-editor lib
// owns the live path (and the legacy fallback for fresh installs).
const _skillsResolver = require('../modules/skills-editor/lib');
function META_SKILLS_DIR(): string { return _skillsResolver.metaSkillsDir(); }

function sanitizeSkillName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_\-. ]/g, '_');
}

// Walk meta-skills (the only place skills carry `category:` today) and
// collect mounted skill names whose frontmatter category matches `cat`.
// Falls through silently when the skills-editor module is unavailable.
function listSkillsByCategory(cat: string): string[] {
  if (!cat) return [];
  try {
    const metaLib = require('../modules/skills-editor/lib');
    const skills = metaLib.listSkills ? metaLib.listSkills() : [];
    const state = metaLib.loadState ? metaLib.loadState() : null;
    const mounted = new Set<string>(state?.mounted?.skills || []);
    return skills
      .filter((s: any) => s && s.category === cat && mounted.has(s.name))
      .map((s: any) => s.name as string);
  } catch (_) {
    return [];
  }
}

async function readSkillBody(sname) {
  const safe = sanitizeSkillName(sname);
  const configFp = path.join(CONFIG_SKILLS_DIR, safe + '.md');
  try {
    const raw = await fs.promises.readFile(configFp, 'utf8');
    return raw.replace(/^---[\s\S]*?---\n?/, '').trim();
  } catch (_) {}
  // skillDir returns the shared skill location (`bridge/skills/<name>/`).
  const metaFp = path.join(_skillsResolver.skillDir(safe), 'SKILL.md');
  try {
    const raw = await fs.promises.readFile(metaFp, 'utf8');
    return raw.replace(/^---[\s\S]*?---\n?/, '').trim();
  } catch (_) {}
  return null;
}

async function resolveSkills(skillSet) {
  if (!skillSet) return [];
  let names;
  if (config.skillSets?.[skillSet]) {
    names = config.skillSets[skillSet];
  } else {
    // Try category match first — categories are the modern "skill set"
    // grouping (declared in each skill's frontmatter). Falls through to
    // single-skill name if no skills carry this category.
    const byCat = listSkillsByCategory(skillSet);
    names = byCat.length ? byCat : [skillSet];
  }
  const results: any[] = [];
  for (const sname of names) {
    const content = await readSkillBody(sname);
    if (content !== null) results.push({ name: sname, content });
  }
  return results;
}

// Chat-path resolution when no SkillSet is explicitly provided (the chat-bar
// skill picker was removed). Rule:
//   1. If any skill sets are flagged in config.skillSetsActiveInChat, merge
//      their members (dedup, preserve order across sets).
//   2. Otherwise load every "mounted" skill — all .md files in the config
//      skills dir plus all meta-skills that the skills-editor lists as mounted.
async function resolveActiveChatSkills() {
  const activeSets: string[] = Array.isArray(config.skillSetsActiveInChat)
    ? config.skillSetsActiveInChat
    : [];
  let names: string[] = [];
  if (activeSets.length) {
    const seen = new Set<string>();
    for (const setName of activeSets) {
      // Each entry can be either a legacy skillSets[] key or a category slug
      // declared in frontmatter. Categories win when both exist with the
      // same name (the user's intent is "the new system"); legacy skillSets
      // remain functional as a fallback for any custom groups they keep.
      const byCat = listSkillsByCategory(setName);
      const members = byCat.length
        ? byCat
        : (Array.isArray(config.skillSets?.[setName]) ? config.skillSets[setName] : null);
      if (!Array.isArray(members)) continue;
      for (const m of members) {
        if (!seen.has(m)) { seen.add(m); names.push(m); }
      }
    }
  } else {
    const seen = new Set<string>();
    try {
      const files = await fs.promises.readdir(CONFIG_SKILLS_DIR);
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        const n = f.slice(0, -3);
        if (!seen.has(n)) { seen.add(n); names.push(n); }
      }
    } catch (_) {}
    try {
      const metaLib = require('../modules/skills-editor/lib');
      const state = metaLib.loadState ? metaLib.loadState() : null;
      const mounted: string[] = state?.mounted?.skills || [];
      for (const n of mounted) {
        if (!seen.has(n)) { seen.add(n); names.push(n); }
      }
    } catch (_) {}
  }
  const results: any[] = [];
  for (const sname of names) {
    const content = await readSkillBody(sname);
    if (content !== null) results.push({ name: sname, content });
  }
  return results;
}

// ── Image attachment helpers ──────────────────────────────────────────────────
function appendImageAttachments(imageBlocks, attachments) {
  if (!Array.isArray(attachments)) return;
  for (const att of attachments) {
    if (att.type !== 'image' || !att.url) continue;
    const localPath = resolveLocalImageUrl(att.url);
    if (!localPath) continue;
    try {
      const data = fs.readFileSync(localPath);
      const ext = path.extname(localPath).slice(1).toLowerCase();
      imageBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: IMAGE_MIME[ext] || 'image/jpeg',
          data: data.toString('base64'),
        },
      });
    } catch (e) {
      logger.warn('attachment.read-failed', { path: localPath, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ── Instance config dir resolvers ─────────────────────────────────────────────
function resolveClaudeConfigDir(label) {
  const selected = label || config.defaults?.claudeInstances?.[0]?.label || '';
  const inst = (config.defaults?.claudeInstances || []).find((i) => i.label === selected);
  return inst?.configDir || null;
}

function resolveCodexConfigDir(label) {
  const selected = label || config.defaults?.codexInstances?.[0]?.label || '';
  const inst = (config.defaults?.codexInstances || []).find((i) => i.label === selected);
  return inst?.configDir || null;
}

// Per-instance binary override. Returns null when the instance has no claudeBin
// set; callers fall back to the global CLAUDE_BIN. Lets each subscription run
// on its own standalone Claude install so installs can't collide.
function resolveClaudeBin(label) {
  const selected = label || config.defaults?.claudeInstances?.[0]?.label || '';
  const inst = (config.defaults?.claudeInstances || []).find((i) => i.label === selected);
  return inst?.claudeBin || null;
}

function resolveCodexBin(label) {
  const selected = label || config.defaults?.codexInstances?.[0]?.label || '';
  const inst = (config.defaults?.codexInstances || []).find((i) => i.label === selected);
  return inst?.codexBin || null;
}

// Derive an isolated HOME from a Claude/Codex configDir. Multiple subscriptions
// on one box only stay isolated if the binary can't fall back to the shared
// $HOME (where it may write a credentials file or read a libsecret entry that
// belongs to another account). When configDir ends in ".claude" / ".codex"
// we use its parent as HOME; otherwise we fall back to configDir itself.
function deriveIsolatedHome(configDir, suffix /* ".claude" | ".codex" */) {
  if (!configDir) return null;
  const path = require('path');
  const base = path.basename(configDir);
  if (suffix && base === suffix) return path.dirname(configDir);
  return configDir;
}

// ── Request body validation ───────────────────────────────────────────────────
const MAX_INPUT_LENGTH = 100_000;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_MODEL_LENGTH = 200;
const MAX_PRESET_LENGTH = 50_000;
const ALLOWED_SYSTEM_MODES = new Set(['replace', 'append']);
const ALLOWED_EFFORTS = new Set(EFFORT_LEVELS);

function sanitizeAndValidateChatBody(body, route) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const Input = typeof body.Input === 'string' ? body.Input.trim() : '';
  if (!Input || Input.length === 0) {
    return { ok: false, error: 'Input is required and must be a non-empty string' };
  }
  if (Input.length > MAX_INPUT_LENGTH) {
    return { ok: false, error: `Input exceeds maximum length of ${MAX_INPUT_LENGTH} characters` };
  }
  const SessionId = typeof body.SessionId === 'string' ? body.SessionId.trim() : 'default';
  if (SessionId !== 'default') {
    const result = validateSessionId(SessionId);
    if (!result.ok) return { ok: false, error: result.error };
  }
  const Model = typeof body.Model === 'string' ? body.Model.trim() : '';
  if (Model && Model.length > MAX_MODEL_LENGTH) {
    return { ok: false, error: `Model exceeds maximum length of ${MAX_MODEL_LENGTH} characters` };
  }
  const Preset = typeof body.Preset === 'string' ? body.Preset.trim() : '';
  if (Preset && Preset.length > MAX_PRESET_LENGTH) {
    return { ok: false, error: `Preset exceeds maximum length of ${MAX_PRESET_LENGTH} characters` };
  }
  const Presets: string[] = Array.isArray(body.Presets)
    ? Array.from(new Set<string>(
        body.Presets
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      ))
    : [];
  for (const p of Presets) {
    if (p.length > MAX_PRESET_LENGTH) {
      return { ok: false, error: `Preset exceeds maximum length of ${MAX_PRESET_LENGTH} characters` };
    }
  }
  const SystemMode = typeof body.SystemMode === 'string' ? body.SystemMode : '';
  if (SystemMode && !ALLOWED_SYSTEM_MODES.has(SystemMode)) {
    return { ok: false, error: `SystemMode must be one of: ${[...ALLOWED_SYSTEM_MODES].join(', ')}` };
  }
  const Effort = typeof body.Effort === 'string' ? body.Effort : '';
  if (Effort && !ALLOWED_EFFORTS.has(Effort)) {
    return { ok: false, error: `Effort must be one of: ${[...ALLOWED_EFFORTS].join(', ')}` };
  }
  const SkillSet = typeof body.SkillSet === 'string' ? body.SkillSet.trim() : '';
  const HarnessInstance = typeof body.HarnessInstance === 'string' ? body.HarnessInstance.trim() : '';
  const CodexInstance = typeof body.CodexInstance === 'string' ? body.CodexInstance.trim() : '';
  // Provider hint sent alongside Model — encodes which subscription instance
  // (e.g. "Anthropic-SUB2") or routing path (e.g. "Anthropic API") to use.
  const Provider = typeof body.Provider === 'string' ? body.Provider.trim() : '';
  if (Provider && Provider.length > MAX_MODEL_LENGTH) {
    return { ok: false, error: `Provider exceeds maximum length of ${MAX_MODEL_LENGTH} characters` };
  }
  const Attachments = Array.isArray(body.Attachments) ? body.Attachments : [];
  if (Attachments.length > 50) {
    return { ok: false, error: 'Too many attachments (max 50)' };
  }
  return {
    ok: true,
    sanitized: { Input, Model, Provider, Preset, Presets, SessionId, Attachments, Effort, SystemMode, SkillSet, HarnessInstance, CodexInstance },
  };
}

module.exports = {
  resolveTargetAgent,
  parseLeadingMentionToParticipant,
  resolveSkills,
  resolveActiveChatSkills,
  appendImageAttachments,
  resolveClaudeConfigDir,
  resolveCodexConfigDir,
  resolveClaudeBin,
  resolveCodexBin,
  deriveIsolatedHome,
  sanitizeAndValidateChatBody,
};
