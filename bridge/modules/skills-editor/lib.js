'use strict';

// Shared helpers for the skills editor: storage layout, frontmatter
// parsing, name sanitization, mount-state, and one-time migration of
// legacy flat skills under bridge/skills/*.md.
//
// Imported as CommonJS by:
//   - bridge/modules/skills-editor/routes.ts (the Express routes)
//   - bridge/modules/skills-editor/index.ts (the module factory)
//   - bridge/mcp/meta-bridge-server.js (its own MCP child process — moves
//     into the future `mcp-servers` module in a follow-up batch).
//
// __dirname = bridge/modules/skills-editor/  → two `..`s lands on bridge/.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BRIDGE_DIR = path.join(__dirname, '..', '..');
const META_DIR = __dirname;
const META_TOOLS_DIR = path.join(META_DIR, 'tools');
const META_STATE_FILE = path.join(META_DIR, '_state.json');
const META_AUDIT_LOG = path.join(META_DIR, 'audit.log');
// Skill **definitions** all live in a single shared root (`bridge/skills/`):
// read-only, git-tracked, identical for every user. New imports + writes
// target this dir.
//
// Per-skill runtime **data** (tokens, OAuth state, scratch) lives separately
// under `$YHA_USER_SKILLS_DATA/<name>/` so the shared definitions stay
// portable across users. See `skillStateDir` below.
//
// (The legacy per-user override layout — `bridge/users/<email>/skills/` —
// was retired in the 2026-05-25 migration. The `/v1/config/skills/`
// flat-file API still uses the per-user path but is a separate surface.)
//
// Resolved lazily on each call so the env (set by core/paths.ts at bridge
// boot) is honoured even when this module is imported very early.
function sharedSkillsRoot() {
  return process.env.YHA_SHARED_SKILLS_DIR || path.join(BRIDGE_DIR, 'skills');
}
function metaSkillsDir() {
  return sharedSkillsRoot();
}
const HERMESHUB_REPO = 'amanning3390/hermeshub';
const HERMESHUB_BRANCH = 'main';

const NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.\- ]{0,63}$/;
const RESERVED_PREFIX = 'meta_';
const VALID_RUNTIMES = new Set(['bash', 'python-sandbox', 'node-sandbox', 'webhook']);

// ── Filesystem layout ───────────────────────────────────────────────────────

function ensureLayout() {
  for (const d of [META_DIR, metaSkillsDir(), META_TOOLS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
  if (!fs.existsSync(META_STATE_FILE)) {
    fs.writeFileSync(
      META_STATE_FILE,
      JSON.stringify({ mounted: { skills: [], tools: [] }, version: 1 }, null, 2),
      'utf8'
    );
  }
}

// ── Name sanitization ───────────────────────────────────────────────────────

function validateName(name) {
  if (typeof name !== 'string') return 'name must be a string';
  const trimmed = name.trim();
  if (!trimmed) return 'name is required';
  if (!NAME_RE.test(trimmed)) {
    return 'name must match [a-zA-Z0-9_][a-zA-Z0-9_.\\- ]{0,63}';
  }
  if (trimmed.startsWith(RESERVED_PREFIX)) {
    return `name must not start with reserved prefix "${RESERVED_PREFIX}"`;
  }
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
    return 'name must not contain path separators or be . / ..';
  }
  return null;
}

function assertName(name) {
  const err = validateName(name);
  if (err) {
    const e = new Error(err);
    e.code = -32602;
    throw e;
  }
}

// ── State (mount tracking) ──────────────────────────────────────────────────

function loadState() {
  ensureLayout();
  try {
    const raw = fs.readFileSync(META_STATE_FILE, 'utf8');
    const s = JSON.parse(raw);
    s.mounted = s.mounted || {};
    s.mounted.skills = Array.isArray(s.mounted.skills) ? s.mounted.skills : [];
    s.mounted.tools = Array.isArray(s.mounted.tools) ? s.mounted.tools : [];
    s.version = s.version || 1;
    return s;
  } catch (_) {
    return { mounted: { skills: [], tools: [] }, version: 1 };
  }
}

function saveState(s) {
  ensureLayout();
  fs.writeFileSync(META_STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function isMounted(kind, name) {
  const list = loadState().mounted[kind === 'skill' ? 'skills' : 'tools'];
  return list.includes(name);
}

function setMount(kind, name, mounted) {
  const s = loadState();
  const key = kind === 'skill' ? 'skills' : 'tools';
  const list = new Set(s.mounted[key]);
  if (mounted) list.add(name); else list.delete(name);
  s.mounted[key] = [...list].sort();
  saveState(s);
}

// Whether a freshly-imported skill/tool may be auto-mounted (made active and
// invokable) by the import itself. Default false: importing from an arbitrary
// path or GitHub repo only stages the files, and a human must explicitly enable
// it. This breaks the prompt-injection RCE chain where the model imports a
// bash-runtime tool and immediately invokes it — without an explicit enable,
// imported code never becomes live. Set YHA_ALLOW_IMPORT_AUTOMOUNT=1 to restore
// the legacy auto-mount-on-import behaviour.
function importAutoMountAllowed() {
  return process.env.YHA_ALLOW_IMPORT_AUTOMOUNT === '1';
}

// ── Frontmatter parser (top-level scalars only, mirrors hermes) ─────────────

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: content };
  const fm = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (/^\s/.test(rawLine)) continue;
    const km = rawLine.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!km) continue;
    let v = km[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[km[1]] = v;
  }
  return { fm, body: m[2] };
}

// ── Skills ──────────────────────────────────────────────────────────────────

// Resolve an on-disk skill dir under the shared root. Callers that write to a
// fresh dir `mkdir -p` themselves.
function skillDir(name) {
  return path.join(sharedSkillsRoot(), name);
}

function skillFile(name) {
  return path.join(skillDir(name), 'SKILL.md');
}

function skillRefsDir(name) {
  return path.join(skillDir(name), 'references');
}

function listReferenceFiles(refsDir) {
  const out = [];
  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out.push({ relPath: r, absPath: p });
    }
  }
  if (fs.existsSync(refsDir) && fs.statSync(refsDir).isDirectory()) walk(refsDir, '');
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function readSkill(name) {
  const file = skillFile(name);
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf8');
  const { fm, body } = parseFrontmatter(content);
  const refs = listReferenceFiles(skillRefsDir(name));
  return {
    name,
    content,
    body,
    description: (fm.description || '').trim(),
    category: (fm.category || '').trim(),
    references: refs.map((r) => ({ relPath: r.relPath, absPath: r.absPath })),
  };
}

function listSkills() {
  ensureLayout();
  const state = loadState();
  const mounted = new Set(state.mounted.skills);
  const out = [];
  let entries;
  try { entries = fs.readdirSync(sharedSkillsRoot(), { withFileTypes: true }); }
  catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const sk = readSkill(e.name);
    if (!sk) continue;
    out.push({
      name: sk.name,
      description: sk.description,
      category: sk.category,
      mounted: mounted.has(sk.name),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function writeSkill(name, content, references /* {rel: text} | undefined */) {
  assertName(name);
  ensureLayout();
  const dir = skillDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(skillFile(name), String(content || ''), 'utf8');
  if (references && typeof references === 'object') {
    const refsDir = skillRefsDir(name);
    fs.mkdirSync(refsDir, { recursive: true });
    for (const [rel, body] of Object.entries(references)) {
      if (typeof rel !== 'string') continue;
      if (rel.includes('..') || rel.startsWith('/') || rel.startsWith('\\') || rel.includes('\\')) {
        const e = new Error(`invalid reference path: ${rel}`); e.code = -32602; throw e;
      }
      const target = path.resolve(refsDir, rel);
      if (target !== refsDir && !target.startsWith(refsDir + path.sep)) {
        const e = new Error('reference path escape rejected'); e.code = -32602; throw e;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(body || ''), 'utf8');
    }
  }
}

// Per-user runtime state for a skill. Lives under
// `$YHA_USER_SKILLS_DATA/<name>/` (set by core/paths.ts at bridge boot) so
// the shared skill definition stays free of user-specific data. Falls back
// to the in-skill `.yha-state` dir for back-compat and dev/CI without a
// pinned user.
function skillStateDir(name) {
  const dataRoot = process.env.YHA_USER_SKILLS_DATA;
  if (dataRoot) return path.join(dataRoot, name);
  return path.join(skillDir(name), '.yha-state');
}

function deleteSkill(name) {
  assertName(name);
  const dir = skillDir(name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  setMount('skill', name, false);
  return true;
}

function renderSkillInline(name) {
  const sk = readSkill(name);
  if (!sk) return null;
  let out = sk.body;
  for (const ref of sk.references) {
    let text;
    try { text = fs.readFileSync(ref.absPath, 'utf8'); }
    catch (e) { text = `(unable to read ${ref.relPath}: ${e.message})`; }
    out += `\n\n--- references/${ref.relPath} ---\n\n${text}`;
  }
  return out;
}

function isProbablyTextFile(file) {
  const ext = path.extname(file).toLowerCase();
  return [
    '',
    '.md',
    '.txt',
    '.py',
    '.sh',
    '.js',
    '.ts',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.cfg',
    '.ini',
  ].includes(ext);
}

function walkFilesRecursive(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === '.DS_Store' || e.name === '__pycache__') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFilesRecursive(full));
    else if (e.isFile()) out.push(full);
  }
  return out.sort();
}

function replaceAllPairs(input, pairs) {
  let out = input;
  for (const [from, to] of pairs) {
    out = out.replace(from, to);
  }
  return out;
}

function normalizeImportedSkill(name, dstDir, sourceMeta) {
  const stateDir = skillStateDir(name);
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch (_) {}

  // Store skillDir as a repo-relative path so the manifest stays portable
  // across machines / containers / dev<->prod. State location is recorded as
  // an env-var hint rather than a baked path for the same reason.
  const repoRoot = path.resolve(BRIDGE_DIR, '..');
  const relSkillDir = path.relative(repoRoot, dstDir).split(path.sep).join('/');
  const provenance = {
    importedAt: new Date().toISOString(),
    source: sourceMeta,
    normalizedFor: 'YHA',
    skillDir: relSkillDir,
    stateDirHint: `$YHA_USER_SKILLS_DATA/${name}`,
  };
  try {
    fs.writeFileSync(path.join(dstDir, '.yha-import.json'), JSON.stringify(provenance, null, 2), 'utf8');
  } catch (_) {}

  const oldHelper = path.join(dstDir, 'scripts', '_hermes_home.py');
  const newHelper = path.join(dstDir, 'scripts', '_yha_paths.py');
  if (fs.existsSync(oldHelper) && !fs.existsSync(newHelper)) {
    try { fs.renameSync(oldHelper, newHelper); } catch (_) {}
  }

  const replacements = [
    [/\bmeta-bridge\b/g, 'YHA Meta Bridge'],
    [/Hermes-managed/g, 'YHA-managed'],
    [/Hermes-facing/g, 'YHA-facing'],
    [/Hermes profile/g, 'YHA skill state directory'],
    [/same Hermes profile/g, 'same YHA skill state directory'],
    [/for Hermes Agent/g, 'for YHA'],
    [/for Hermes\b/g, 'for YHA'],
    [/\bHermes Agent\b/g, 'YHA'],
    [/\bHermes CLI\b/g, 'YHA Meta Bridge'],
    [/\bHERMES_GWS_BIN\b/g, 'YHA_GWS_BIN'],
    [/\bHERMES_HOME\b/g, 'YHA_SKILL_HOME'],
    [/\bget_hermes_home\b/g, 'get_yha_skill_home'],
    [/\bdisplay_hermes_home\b/g, 'display_yha_skill_home'],
    [/_hermes_home/g, '_yha_paths'],
    [/~\/\.hermes\/venv\/bin\/python/g, 'python3'],
    [/~\/\.hermes/g, stateDir],
    [/\$HOME\/\.hermes/g, stateDir],
    [/\$\{HERMES_HOME:-\$HOME\/\.hermes\}/g, stateDir],
    [/\$\{YHA_SKILL_HOME:-\$HOME\/\.hermes\}/g, stateDir],
  ];

  for (const file of walkFilesRecursive(dstDir)) {
    if (!isProbablyTextFile(file)) continue;
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const original = content;

    if (path.basename(file) === 'SKILL.md') {
      content = content.replace(/^name:\s*.*$/m, `name: ${name}`);
      content = content.replace(
        /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/,
        (m) => `${m}Imported into YHA and normalized for the local meta-bridge layout.\n\n`
      );
      content = content.replace(/skill_view\(([^)]*)\)/g, 'meta_invoke_skill($1)');
    }

    content = replaceAllPairs(content, replacements);

    if (file.endsWith(`${path.sep}_yha_paths.py`)) {
      content = content
        .replace(/Resolve YHA_SKILL_HOME for standalone skill scripts\./, 'Resolve YHA skill-local paths for standalone skill scripts.')
        .replace(/where ``hermes_constants`` is not importable/g, 'where YHA helper modules are not importable')
        .replace(/contracts as ``hermes_constants``/g, 'contracts for YHA-local state resolution')
        .replace(/When ``hermes_constants`` IS available[\s\S]*?stdlib\.\n\n/, '')
        // Skill state lookup order: YHA_SKILL_HOME (skill-specific env, set
        // by the bridge when it spawns per-skill subprocesses) → universal
        // YHA_USER_SKILLS_DATA/<skill-name>/ (set by core/paths.ts at bridge
        // boot, works across all skills) → baked-in absolute fallback (kept
        // for back-compat when scripts run outside the bridge).
        .replace(/def get_yha_skill_home\(\) -> Path:[\s\S]*?def display_yha_skill_home\(\) -> str:/, `def get_yha_skill_home() -> Path:\n        """Return the YHA skill state directory for this imported skill."""\n        val = os.environ.get("YHA_SKILL_HOME", "").strip()\n        if val:\n            return Path(val)\n        data_root = os.environ.get("YHA_USER_SKILLS_DATA", "").strip()\n        if data_root:\n            return Path(data_root) / ${JSON.stringify(name)}\n        return Path(${JSON.stringify(stateDir)})\n\n    def display_yha_skill_home() -> str:`);
      content = content.replace(/Mirrors ``hermes_constants\.get_hermes_home\(\)``\./g, 'Defaults to the imported skill-local `.yha-state` directory.');
      content = content.replace(/Mirrors ``hermes_constants\.display_hermes_home\(\)``\./g, 'Formats the YHA skill-local state path for display.');
    }

    if (content !== original) {
      fs.writeFileSync(file, content, 'utf8');
    }
  }
}

// ── Tools ───────────────────────────────────────────────────────────────────

function toolDir(name) {
  return path.join(META_TOOLS_DIR, name);
}

function toolJsonFile(name) {
  return path.join(toolDir(name), 'tool.json');
}

function defaultEntryFor(runtime) {
  switch (runtime) {
    case 'bash': return 'main.sh';
    case 'python-sandbox': return 'main.py';
    case 'node-sandbox': return 'main.js';
    case 'webhook': return null;
    default: return 'main.txt';
  }
}

function readTool(name) {
  const f = toolJsonFile(name);
  if (!fs.existsSync(f)) return null;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (_) { return null; }
  meta.name = name;
  let code = '';
  if (meta.runtime !== 'webhook' && meta.entry) {
    const entryPath = path.join(toolDir(name), meta.entry);
    try { code = fs.readFileSync(entryPath, 'utf8'); } catch (_) {}
  }
  return { ...meta, code };
}

function listTools() {
  ensureLayout();
  const state = loadState();
  const mounted = new Set(state.mounted.tools);
  const out = [];
  let entries;
  try { entries = fs.readdirSync(META_TOOLS_DIR, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const t = readTool(e.name);
    if (!t) continue;
    out.push({
      name: t.name,
      description: t.description || '',
      runtime: t.runtime || 'bash',
      mounted: mounted.has(t.name),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function validateInputSchema(schema) {
  if (!schema || typeof schema !== 'object') return 'inputSchema must be an object';
  if (schema.type !== 'object') return 'inputSchema.type must be "object"';
  if (schema.properties && typeof schema.properties !== 'object') {
    return 'inputSchema.properties must be an object';
  }
  if (schema.required && !Array.isArray(schema.required)) {
    return 'inputSchema.required must be an array';
  }
  return null;
}

function validateUrl(url) {
  if (typeof url !== 'string' || !url) return 'webhook url is required';
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) {
    return 'webhook url must be https:// or http://localhost';
  }
  return null;
}

function writeTool(name, payload) {
  assertName(name);
  ensureLayout();
  const description = String(payload.description || '').trim();
  const runtime = String(payload.runtime || 'bash');
  if (!VALID_RUNTIMES.has(runtime)) {
    const e = new Error(`invalid runtime: ${runtime}`); e.code = -32602; throw e;
  }
  const schemaErr = validateInputSchema(payload.inputSchema);
  if (schemaErr) { const e = new Error(schemaErr); e.code = -32602; throw e; }
  const dir = toolDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    name,
    description,
    runtime,
    inputSchema: payload.inputSchema,
    version: 1,
  };
  if (runtime === 'webhook') {
    const urlErr = validateUrl(payload.url);
    if (urlErr) { const e = new Error(urlErr); e.code = -32602; throw e; }
    meta.url = payload.url;
    meta.entry = null;
  } else {
    const entry = defaultEntryFor(runtime);
    meta.entry = entry;
    meta.url = null;
    const code = String(payload.code || '');
    fs.writeFileSync(path.join(dir, entry), code, 'utf8');
    if (runtime === 'bash') {
      try { fs.chmodSync(path.join(dir, entry), 0o755); } catch (_) {}
    }
  }
  fs.writeFileSync(toolJsonFile(name), JSON.stringify(meta, null, 2), 'utf8');
}

function deleteTool(name) {
  assertName(name);
  const dir = toolDir(name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  setMount('tool', name, false);
  return true;
}

// ── Import a full skill directory from an external path ───────────────────
// e.g. ~/.hermes/skills/productivity/google-workspace/ → bridge/meta/skills/<name>/
// Copies SKILL.md + all sibling files (scripts, references/, etc.).

const SKIP_NAMES = new Set(['.git', '.github', '.hub', 'node_modules', '__pycache__', '.venv', 'venv']);

function copyDirRecursive(src, dst, stats) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyDirRecursive(s, d, stats);
    } else if (e.isFile()) {
      fs.copyFileSync(s, d);
      try {
        const m = fs.statSync(s).mode & 0o777;
        if (m & 0o111) fs.chmodSync(d, m);
      } catch (_) {}
      stats.files += 1;
    }
  }
}

function importToolFromPath(sourcePath, overrideName) {
  ensureLayout();
  if (typeof sourcePath !== 'string' || !sourcePath) {
    const e = new Error('source path required'); e.code = -32602; throw e;
  }
  let resolved = sourcePath.startsWith('~/')
    ? path.join(process.env.HOME || '', sourcePath.slice(2))
    : sourcePath;
  resolved = path.resolve(resolved);
  let stat;
  try { stat = fs.statSync(resolved); }
  catch (e) { const er = new Error(`source not found: ${resolved}`); er.code = -32602; throw er; }

  let srcDir;
  if (stat.isFile()) {
    if (path.basename(resolved) !== 'tool.json') {
      const e = new Error('source file must be tool.json'); e.code = -32602; throw e;
    }
    srcDir = path.dirname(resolved);
  } else if (stat.isDirectory()) {
    srcDir = resolved;
    if (!fs.existsSync(path.join(srcDir, 'tool.json'))) {
      const e = new Error(`no tool.json found in ${srcDir}`); e.code = -32602; throw e;
    }
  } else {
    const e = new Error('source must be a file or directory'); e.code = -32602; throw e;
  }

  let toolMeta;
  try { toolMeta = JSON.parse(fs.readFileSync(path.join(srcDir, 'tool.json'), 'utf8')); }
  catch (e) { const er = new Error(`invalid tool.json: ${e.message}`); er.code = -32602; throw er; }

  const name = (overrideName || toolMeta.name || path.basename(srcDir)).trim();
  const nameErr = validateName(name);
  if (nameErr) { const e = new Error(`invalid tool name "${name}": ${nameErr}`); e.code = -32602; throw e; }
  if (!VALID_RUNTIMES.has(toolMeta.runtime)) {
    const e = new Error(`invalid runtime: ${toolMeta.runtime}`); e.code = -32602; throw e;
  }
  const schemaErr = validateInputSchema(toolMeta.inputSchema);
  if (schemaErr) { const e = new Error(schemaErr); e.code = -32602; throw e; }
  if (toolMeta.runtime === 'webhook') {
    const urlErr = validateUrl(toolMeta.url);
    if (urlErr) { const e = new Error(urlErr); e.code = -32602; throw e; }
  } else {
    const entry = toolMeta.entry || defaultEntryFor(toolMeta.runtime);
    if (!fs.existsSync(path.join(srcDir, entry))) {
      const e = new Error(`entry script "${entry}" missing in source dir`); e.code = -32602; throw e;
    }
  }

  const dstDir = toolDir(name);
  if (fs.existsSync(dstDir)) {
    const e = new Error(`tool "${name}" already exists; delete it first`); e.code = -32602; throw e;
  }
  fs.mkdirSync(dstDir, { recursive: true });
  const stats = { files: 0 };
  copyDirRecursive(srcDir, dstDir, stats);
  // Normalize tool.json.name to the imported name
  toolMeta.name = name;
  fs.writeFileSync(path.join(dstDir, 'tool.json'), JSON.stringify(toolMeta, null, 2), 'utf8');
  // Preserve executable bit on entry script for bash
  if (toolMeta.runtime === 'bash' && toolMeta.entry) {
    try { fs.chmodSync(path.join(dstDir, toolMeta.entry), 0o755); } catch (_) {}
  }
  const mounted = importAutoMountAllowed();
  if (mounted) setMount('tool', name, true);
  return { name, files: stats.files, source: srcDir, target: dstDir, runtime: toolMeta.runtime, mounted };
}

function importSkillFromPath(sourcePath, overrideName) {
  ensureLayout();
  if (typeof sourcePath !== 'string' || !sourcePath) {
    const e = new Error('source path required'); e.code = -32602; throw e;
  }
  let resolved = sourcePath.startsWith('~/')
    ? path.join(process.env.HOME || '', sourcePath.slice(2))
    : sourcePath;
  resolved = path.resolve(resolved);
  let stat;
  try { stat = fs.statSync(resolved); }
  catch (e) { const er = new Error(`source not found: ${resolved}`); er.code = -32602; throw er; }

  let srcDir;
  if (stat.isFile()) {
    if (path.basename(resolved) !== 'SKILL.md') {
      const e = new Error('source file must be SKILL.md'); e.code = -32602; throw e;
    }
    srcDir = path.dirname(resolved);
  } else if (stat.isDirectory()) {
    srcDir = resolved;
    if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
      const e = new Error(`no SKILL.md found in ${srcDir}`); e.code = -32602; throw e;
    }
  } else {
    const e = new Error('source must be a file or directory'); e.code = -32602; throw e;
  }

  const skillContent = fs.readFileSync(path.join(srcDir, 'SKILL.md'), 'utf8');
  const { fm } = parseFrontmatter(skillContent);
  const name = (overrideName || fm.name || path.basename(srcDir)).trim();
  const nameErr = validateName(name);
  if (nameErr) { const e = new Error(`invalid skill name "${name}": ${nameErr}`); e.code = -32602; throw e; }

  const dstDir = skillDir(name);
  if (fs.existsSync(dstDir)) {
    const e = new Error(`skill "${name}" already exists; delete it first`); e.code = -32602; throw e;
  }
  fs.mkdirSync(dstDir, { recursive: true });
  const stats = { files: 0 };
  copyDirRecursive(srcDir, dstDir, stats);
  normalizeImportedSkill(name, dstDir, { type: 'path', source: srcDir });
  const mounted = importAutoMountAllowed();
  if (mounted) setMount('skill', name, true);
  return { name, files: stats.files, source: srcDir, target: dstDir, mounted };
}

// Honor GITHUB_TOKEN / GH_TOKEN env vars when set so the unauthenticated
// 60 req/hour limit doesn't bite during bulk imports. A single skill
// install can use 1–20 requests (listing + one per file), so a handful of
// retries blow the budget and the user sees 403. Authenticated requests
// get 5,000/hour. Token is optional — when unset we still work, just at
// the lower limit.
function _githubAuthHeader() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function githubJson(url) {
  const res = await fetch(url, {
    headers: {
      'accept': 'application/vnd.github+json',
      'user-agent': 'yha-meta-bridge',
      ..._githubAuthHeader(),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub request failed (${res.status}) for ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function githubText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'yha-meta-bridge',
      ..._githubAuthHeader(),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub raw request failed (${res.status}) for ${url}: ${body.slice(0, 200)}`);
  }
  return res.text();
}

async function listHermesHubSkills() {
  return listGithubSkills(HERMESHUB_REPO, HERMESHUB_BRANCH, 'skills');
}

// ── Generic GitHub skill importer ──────────────────────────────────────────
// Parameterized over (repo, branch, basePath). Walks one directory level deep
// under basePath, treating any subdir as a candidate skill (we require a
// SKILL.md only at install time, not at list time, so flat repos that mix
// skills with other dirs still surface for inspection).
//
// `repo` is "<owner>/<name>". `branch` defaults to "main". `basePath` is the
// directory containing the skill dirs — most repos use either "skills" or the
// repo root (basePath = "").

function validateRepoSpec(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    const e = new Error('repo must be "<owner>/<name>"'); e.code = -32602; throw e;
  }
}

function normalizeBasePath(basePath) {
  if (typeof basePath !== 'string') return '';
  return basePath.replace(/^\/+|\/+$/g, '');
}

async function listGithubSkills(repo, branch, basePath) {
  validateRepoSpec(repo);
  const br = String(branch || 'main').trim() || 'main';
  const bp = normalizeBasePath(basePath);
  const url = `https://api.github.com/repos/${repo}/contents/${bp ? encodeURIComponent(bp) : ''}?ref=${encodeURIComponent(br)}`;
  const items = await githubJson(url);
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && item.type === 'dir' && typeof item.name === 'string')
    .map((item) => ({
      name: item.name,
      path: item.path,
      html_url: item.html_url,
      api_url: item.url,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function getGithubSkill(repo, branch, basePath, skillName) {
  validateRepoSpec(repo);
  const name = String(skillName || '').trim();
  const nameErr = validateName(name);
  if (nameErr) { const e = new Error(`invalid skill name "${name}": ${nameErr}`); e.code = -32602; throw e; }
  const br = String(branch || 'main').trim() || 'main';
  const bp = normalizeBasePath(basePath);
  const skillPath = bp ? `${bp}/${name}` : name;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(skillPath)}?ref=${encodeURIComponent(br)}`;
  const items = await githubJson(url);
  if (!Array.isArray(items)) {
    const e = new Error(`skill "${name}" not found in ${repo}@${br}:${skillPath}`); e.code = -32602; throw e;
  }
  const files = items
    .filter((item) => item && item.type === 'file')
    .map((item) => ({
      name: item.name,
      path: item.path,
      download_url: item.download_url,
      size: item.size,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const skillMd = files.find((f) => f.name === 'SKILL.md');
  const content = skillMd?.download_url ? await githubText(skillMd.download_url) : '';
  const parsed = parseFrontmatter(content || '');
  return {
    name,
    files,
    content,
    description: (parsed.fm.description || '').trim(),
    html_url: `https://github.com/${repo}/tree/${br}/${skillPath}`,
    source_repo: repo,
    source_branch: br,
    source_base_path: bp,
  };
}

async function installGithubSkill(repo, branch, basePath, skillName, overrideName) {
  ensureLayout();
  const info = await getGithubSkill(repo, branch, basePath, skillName);
  if (!info.files.some((f) => f.name === 'SKILL.md')) {
    const e = new Error(`source "${info.html_url}" has no SKILL.md — not a skill`); e.code = -32602; throw e;
  }
  const name = (overrideName || info.name).trim();
  const nameErr = validateName(name);
  if (nameErr) { const e = new Error(`invalid skill name "${name}": ${nameErr}`); e.code = -32602; throw e; }
  const dstDir = skillDir(name);
  if (fs.existsSync(dstDir)) {
    const e = new Error(`skill "${name}" already exists; delete it first`); e.code = -32602; throw e;
  }

  const br = String(branch || 'main').trim() || 'main';
  const bp = normalizeBasePath(basePath);
  const skillPath = bp ? `${bp}/${info.name}` : info.name;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yha-github-'));
  const srcDir = path.join(tmpDir, name);
  fs.mkdirSync(srcDir, { recursive: true });
  for (const file of info.files) {
    if (!file.download_url) continue;
    const rel = file.path.replace(new RegExp(`^${skillPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '');
    if (!rel || rel.startsWith('..')) continue;
    const target = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await githubText(file.download_url), 'utf8');
  }

  try {
    fs.mkdirSync(dstDir, { recursive: true });
    const stats = { files: 0 };
    copyDirRecursive(srcDir, dstDir, stats);
    normalizeImportedSkill(name, dstDir, {
      type: 'github',
      repo,
      branch: br,
      base_path: bp,
      skill: info.name,
      html_url: info.html_url,
    });
    const mounted = importAutoMountAllowed();
    if (mounted) setMount('skill', name, true);
    return {
      name,
      files: stats.files,
      source: info.html_url,
      target: dstDir,
      source_repo: repo,
      source_branch: br,
      source_base_path: bp,
      mounted,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function getHermesHubSkill(skillName) {
  const name = String(skillName || '').trim();
  const nameErr = validateName(name);
  if (nameErr) { const e = new Error(`invalid skill name "${name}": ${nameErr}`); e.code = -32602; throw e; }
  const items = await githubJson(`https://api.github.com/repos/${HERMESHUB_REPO}/contents/skills/${encodeURIComponent(name)}?ref=${HERMESHUB_BRANCH}`);
  if (!Array.isArray(items)) {
    const e = new Error(`HermesHub skill "${name}" not found`); e.code = -32602; throw e;
  }
  const files = items
    .filter((item) => item && item.type === 'file')
    .map((item) => ({
      name: item.name,
      path: item.path,
      download_url: item.download_url,
      size: item.size,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const skillMd = files.find((f) => f.name === 'SKILL.md');
  const content = skillMd?.download_url ? await githubText(skillMd.download_url) : '';
  const parsed = parseFrontmatter(content || '');
  return {
    name,
    files,
    content,
    description: (parsed.fm.description || '').trim(),
    html_url: `https://github.com/${HERMESHUB_REPO}/tree/${HERMESHUB_BRANCH}/skills/${name}`,
    source_repo: HERMESHUB_REPO,
    source_branch: HERMESHUB_BRANCH,
  };
}

async function installHermesHubSkill(skillName, overrideName) {
  ensureLayout();
  const info = await getHermesHubSkill(skillName);
  const name = (overrideName || info.name).trim();
  const nameErr = validateName(name);
  if (nameErr) { const e = new Error(`invalid skill name "${name}": ${nameErr}`); e.code = -32602; throw e; }
  const dstDir = skillDir(name);
  if (fs.existsSync(dstDir)) {
    const e = new Error(`skill "${name}" already exists; delete it first`); e.code = -32602; throw e;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yha-hermeshub-'));
  const srcDir = path.join(tmpDir, name);
  fs.mkdirSync(srcDir, { recursive: true });
  for (const file of info.files) {
    if (!file.download_url) continue;
    const rel = file.path.replace(new RegExp(`^skills/${info.name}/`), '');
    if (!rel || rel.startsWith('..')) continue;
    const target = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await githubText(file.download_url), 'utf8');
  }

  try {
    fs.mkdirSync(dstDir, { recursive: true });
    const stats = { files: 0 };
    copyDirRecursive(srcDir, dstDir, stats);
    normalizeImportedSkill(name, dstDir, {
      type: 'hermeshub',
      repo: HERMESHUB_REPO,
      branch: HERMESHUB_BRANCH,
      skill: info.name,
      html_url: info.html_url,
    });
    setMount('skill', name, true);
    return {
      name,
      files: stats.files,
      source: info.html_url,
      target: dstDir,
      source_repo: HERMESHUB_REPO,
      source_branch: HERMESHUB_BRANCH,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── Audit log ───────────────────────────────────────────────────────────────

// Rotate audit.log when it crosses AUDIT_ROTATE_BYTES. The previous file is
// renamed audit.log.1; any existing audit.log.1 is overwritten. Single-tier
// rotation keeps two files at most (current + one backup) — enough to dig
// into yesterday's actions while bounding disk use. Gzip + multi-tier
// retention would belong in a dedicated logrotate config; for now the goal
// is just: don't grow unbounded across years of normal use.
const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024; // 10 MiB

function _maybeRotateAuditLog() {
  try {
    const st = fs.statSync(META_AUDIT_LOG);
    if (st.size < AUDIT_ROTATE_BYTES) return;
    const backup = META_AUDIT_LOG + '.1';
    try { fs.unlinkSync(backup); } catch (e) {
      if (e && e.code && e.code !== 'ENOENT') {
        // Surface unexpected unlink failures (EACCES, EBUSY); the rotate
        // attempt itself is still best-effort, but a silent failure here
        // would leave the active log growing.
        console.warn('[skills-editor] audit-log backup unlink failed:', e.code, e.message || String(e));
      }
    }
    fs.renameSync(META_AUDIT_LOG, backup);
  } catch (e) {
    if (e && e.code === 'ENOENT') return; // no file yet — nothing to rotate
    console.warn('[skills-editor] audit-log rotate failed:', e.code || '', e.message || String(e));
  }
}

function audit(action, name, extra) {
  ensureLayout();
  _maybeRotateAuditLog();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    name,
    ...(extra || {}),
  }) + '\n';
  try { fs.appendFileSync(META_AUDIT_LOG, line, 'utf8'); } catch (_) {}
}

module.exports = {
  // paths
  META_DIR, metaSkillsDir, META_TOOLS_DIR, META_STATE_FILE,
  // config
  VALID_RUNTIMES, RESERVED_PREFIX,
  // helpers
  ensureLayout, validateName, assertName, parseFrontmatter,
  loadState, saveState, isMounted, setMount,
  // skills
  listSkills, readSkill, writeSkill, deleteSkill, renderSkillInline,
  skillDir, skillFile, skillRefsDir, skillStateDir, normalizeImportedSkill,
  // tools
  listTools, readTool, writeTool, deleteTool, defaultEntryFor, toolDir, toolJsonFile,
  // import + audit
  importSkillFromPath, importToolFromPath, audit,
  listHermesHubSkills, getHermesHubSkill, installHermesHubSkill,
  listGithubSkills, getGithubSkill, installGithubSkill,
};
