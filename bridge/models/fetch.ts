// ── Live API fetchers + CLI subscription discovery (Claude / Codex) ───────────
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config, CONFIG_PATH, CODEX_BIN, modelCaches, writeJsonSync } = require('../core/state');
const logger = require('../core/logger');
const { detectModelType, detectModelCategory, expandHome, stripAnsi, uniqBy } = require('./detect');
const { pruneStaleConfigModels, withProviderConfigLock } = require('./config');
const modelTracker = require('../modules/model-tracker/tracker');

// Tracker hook — best-effort, runs once per provider per fetch. Diffs the
// incoming id set against the persisted snapshot and emits first_seen /
// last_seen / category_auto_changed events into bridge/model-tracker-events/.
// Wrapped in try/catch so a tracker fault never aborts a fetch.
function _trackProvider(name: string, ids: string[]): void {
  try {
    const incoming = ids.map((id) => ({ id, categoryAuto: detectModelCategory(id) }));
    modelTracker.recordFetch(name, incoming);
  } catch (e) {
    logger.warn('model-tracker.record-failed', {
      provider: name,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function getClaudeSubscriptionTargets() {
  const instances = Array.isArray(config.defaults?.claudeInstances)
    ? config.defaults.claudeInstances
    : [];
  const items = instances
    .map((inst) => ({
      label: String(inst?.label || '').trim() || 'Default',
      configDir: expandHome(inst?.configDir),
      binary: String(inst?.claudeBin || inst?.binary || '').trim(),
    }))
    .filter((inst) => inst.configDir);
  if (items.length) return uniqBy(items, (inst) => inst.configDir);
  return [
    {
      label: 'Default',
      configDir: expandHome(process.env.CLAUDE_CONFIG_DIR || '~/.claude'),
      binary: '',
    },
  ];
}

function getCodexSubscriptionTargets() {
  const instances = Array.isArray(config.defaults?.codexInstances)
    ? config.defaults.codexInstances
    : [];
  const items = instances
    .map((inst) => ({
      label: String(inst?.label || '').trim() || 'Default',
      configDir: expandHome(inst?.configDir),
      binary: String(inst?.codexBin || '').trim(),
    }))
    .filter((inst) => inst.configDir);
  if (items.length) return uniqBy(items, (inst) => inst.configDir);
  return [{ label: 'Default', configDir: expandHome(process.env.CODEX_HOME || '~/.codex'), binary: '' }];
}

function getGrokSubscriptionTargets() {
  const instances = Array.isArray(config.defaults?.grokInstances)
    ? config.defaults.grokInstances
    : [];
  const items = instances
    .map((inst) => ({
      label: String(inst?.label || '').trim() || 'Default',
      configDir: expandHome(inst?.configDir),
      binary: String(inst?.grokBin || '').trim(),
    }))
    .filter((inst) => inst.configDir);
  if (items.length) return uniqBy(items, (inst) => inst.configDir);
  return [{ label: 'Default', configDir: expandHome(process.env.GROK_HOME || '~/.grok'), binary: '' }];
}

function parseModelCandidates(raw, tool) {
  const cleaned = stripAnsi(raw)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const out = new Set();
  const patterns =
    tool === 'claude'
      ? [/\bclaude-[a-z0-9.-]+\b/gi]
      : [/\bgpt-[a-z0-9.-]+\b/gi, /\bo[134](?:-[a-z0-9.]+)?\b/gi, /\bchatgpt-[a-z0-9.-]+\b/gi];

  for (const line of cleaned) {
    let normalized = line
      .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, '')
      .replace(/\s+\(current\)\s*$/i, '')
      .trim();
    if (!normalized) continue;
    if (/\s{2,}/.test(normalized)) normalized = normalized.split(/\s{2,}/)[0].trim();
    for (const pattern of patterns) {
      for (const match of normalized.matchAll(pattern)) {
        const name = String(match[0] || '')
          .trim()
          .replace(/[),.:]+$/, '');
        if (name && (tool !== 'claude' || isClaudeModelCandidate(name))) out.add(name.toLowerCase());
      }
    }
  }
  return [...out];
}

const { isClaudeSubscriptionModelCandidate } = require('./claude-subscription');

function isClaudeModelCandidate(id) {
  return isClaudeSubscriptionModelCandidate(id);
}

function readDelimitedModelList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim()).filter(Boolean);
  return String(value)
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function configuredClaudeSubscriptionModels() {
  return [
    ...readDelimitedModelList(process.env.YHA_CLAUDE_SUBSCRIPTION_MODELS),
    ...readDelimitedModelList(config.defaults?.claudeSubscriptionModels),
  ].filter((id) => isClaudeModelCandidate(id) && detectModelType(id) === 'llm');
}

// Claude Code's interactive `/model` picker is TTY-only in recent releases, so
// the piped startup probe can legitimately return no output. As a second
// best-effort source, read Claude's own config/state files for model IDs it has
// already persisted. Session/project walks are intentionally omitted — they
// treated model names merely mentioned in old chats as available picker entries.
function readClaudeModelsFromState(configDir) {
  const root = expandHome(configDir);
  const found = new Set();
  if (!root) return [];

  const scanText = (text) => {
    for (const id of parseModelCandidates(text, 'claude')) {
      if (isClaudeModelCandidate(id) && detectModelType(id) === 'llm') found.add(id);
    }
  };
  const scanFile = (file) => {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) return;
      scanText(fs.readFileSync(file, 'utf8'));
    } catch (_) {}
  };

  for (const rel of ['.claude.json', 'settings.json', 'policy-limits.json']) {
    scanFile(path.join(root, rel));
  }

  return [...found];
}

function readCodexModelsCache(configDir) {
  const cachePath = path.join(configDir, 'models_cache.json');
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const entries = Array.isArray(data?.models) ? data.models : [];
    return entries
      .filter((model) => {
        const name = String(model?.slug || '').trim();
        if (!name) return false;
        if (model?.visibility && model.visibility !== 'list') return false;
        return /^(gpt-|o[134]|chatgpt-)/i.test(name);
      })
      .map((model) => ({
        name: String(model.slug).trim(),
        displayName: String(model.display_name || model.slug).trim(),
        description: String(model.description || '').trim(),
        context_length: model.max_context_window || model.context_window || undefined,
        vision: Array.isArray(model.input_modalities) && model.input_modalities.includes('image'),
        reasoning:
          Array.isArray(model.supported_reasoning_levels) &&
          model.supported_reasoning_levels.length > 0,
        tools: true,
      }));
  } catch (_) {
    return [];
  }
}

function discoverCliModels({ command, env, tool, args = [], timeoutMs = 12000 }) {
  return new Promise<any[]>((resolve) => {
    let stdout = '';
    let stderr = '';
    let sentModelCommand = false;
    let finished = false;
    let settleTimer = null;

    const proc = spawn(command, args, {
      env,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      try {
        proc.kill('SIGTERM');
      } catch (_) {}
      const models = parseModelCandidates(stdout + '\n' + stderr, tool);
      resolve(models);
    };

    const scheduleFinish = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, 500);
    };

    const maybeSendModelCommand = (text) => {
      if (sentModelCommand) return;
      if (/[>#]\s*$/.test(text) || text.includes('Type /help') || text.includes('/model')) {
        sentModelCommand = true;
        try {
          proc.stdin.write('/model\n');
        } catch (_) {}
        scheduleFinish();
      }
    };

    const killTimer = setTimeout(finish, timeoutMs);
    setTimeout(() => {
      if (finished || sentModelCommand) return;
      sentModelCommand = true;
      try {
        proc.stdin.write('/model\n');
      } catch (_) {}
      scheduleFinish();
    }, 1500);

    proc.stdout.on('data', (data) => {
      const chunk = stripAnsi(data.toString());
      stdout += chunk;
      maybeSendModelCommand(stdout);
      if (sentModelCommand && parseModelCandidates(chunk, tool).length) scheduleFinish();
    });
    proc.stderr.on('data', (data) => {
      const chunk = stripAnsi(data.toString());
      stderr += chunk;
      maybeSendModelCommand(stderr);
      if (sentModelCommand && parseModelCandidates(chunk, tool).length) scheduleFinish();
    });
    proc.on('error', () => finish());
    proc.on('close', () => finish());
  });
}

async function fetchClaudeSubscriptionModels() {
  const targets = getClaudeSubscriptionTargets();
  const discovered = new Set(configuredClaudeSubscriptionModels());

  for (const target of targets) {
    const command = target.binary || process.env.CLAUDE_BIN || 'claude';
    const { deriveIsolatedHome } = require('../chat/helpers');
    const home = deriveIsolatedHome(target.configDir, '.claude');
    const env: Record<string, string> = { ...process.env, CLAUDE_CONFIG_DIR: target.configDir };
    if (home) env.HOME = home;
    for (const model of readClaudeModelsFromState(target.configDir)) {
      discovered.add(model);
    }
    const models = await discoverCliModels({ command, env, tool: 'claude' });
    for (const model of models) {
      if (isClaudeModelCandidate(model) && detectModelType(model) === 'llm') discovered.add(model);
    }
    logger.info('models.claude-subscription-target', {
      label: target.label,
      configDir: target.configDir,
      cliCount: models.length,
    });
  }

  modelCaches.claudeSubscription = [...discovered].sort();
  modelCaches.list = null;
  _trackProvider('Anthropic-SUB', modelCaches.claudeSubscription);
  logger.info('models.claude-subscription', { count: modelCaches.claudeSubscription.length });
}

// Run `<grokBin> models` (non-interactive subcommand that prints the list
// and exits) and return the parsed model names. Output looks like:
//   You are logged in with grok.com.
//   Default model: grok-build
//   Available models:
//     * grok-build (default)
// We extract every "* <name>" line, stripping the "(default)" suffix.
function runGrokModelsList({ command, env, timeoutMs = 8000 }: { command: string; env: Record<string, string>; timeoutMs?: number }) {
  return new Promise<string[]>((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (timedOut = false) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      // On Bun/Windows, killing from the child's close handler can race the
      // already-closed stdio pipe and surface as an uncaught EPIPE. Only the
      // timeout path needs to terminate the process.
      if (timedOut) {
        try { proc.kill('SIGTERM'); } catch (_) {}
      }
      const text = stripAnsi(out + '\n' + err);
      const names = new Set<string>();
      for (const raw of text.split(/\r?\n/)) {
        const m = raw.match(/^\s*\*\s+([a-z0-9][a-z0-9._:-]*)/i);
        if (m) names.add(m[1].trim());
      }
      resolve([...names]);
    };
    const proc = spawn(command, ['models'], { env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const killTimer = setTimeout(() => finish(true), timeoutMs);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', () => finish());
    proc.on('close', () => finish());
  });
}

async function fetchGrokSubscriptionModels() {
  const targets = getGrokSubscriptionTargets();
  const defaultGrokBin = String(config.defaults?.grokBin || '').trim() || 'grok';
  const discovered = new Set<string>();
  for (const target of targets) {
    const { deriveIsolatedHome } = require('../chat/helpers');
    const home = deriveIsolatedHome(target.configDir, '.grok');
    const env: Record<string, string> = { ...process.env };
    if (home) env.HOME = home;
    const command = target.binary || defaultGrokBin;
    try {
      const names = await runGrokModelsList({ command, env });
      for (const n of names) discovered.add(n);
    } catch (_) { /* ignore — best-effort */ }
  }
  modelCaches.grokSubscription = [...discovered].sort();
  modelCaches.list = null;
  _trackProvider('Grok-SUB', modelCaches.grokSubscription);
  logger.info('models.grok-subscription', { count: modelCaches.grokSubscription.length });
}

// ── Grok-SUB media (image/video) discovery ─────────────────────────────────
// Subscription media uses the user's SuperGrok OAuth token from auth.json
// rather than the team's API key. We declare media model ids per grokInstance
// when its auth.json exists and is unexpired — the picker then renders one
// row per (model, instance) tagged `Grok-SUB` / `Grok-SUB2` / …
//
// auth.json shape (one entry per OAuth client):
//   { "<issuer>::<client-id>": { key, refresh_token, expires_at, … } }
// We only require *some* entry with a `key` field. Token freshness is the
// CLI's job to refresh — we don't second-guess it here.
const GROK_SUB_MEDIA_MODELS = [
  { name: 'grok-imagine-image-pro', kind: 'image' as const },
  { name: 'grok-imagine-video',     kind: 'video' as const },
];

function _grokInstanceHasAuth(target: { configDir: string }) {
  try {
    const authPath = path.join(target.configDir, 'auth.json');
    if (!fs.existsSync(authPath)) return false;
    const raw = fs.readFileSync(authPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return false;
    for (const v of Object.values(parsed as Record<string, any>)) {
      if (v && typeof v === 'object' && typeof (v as any).key === 'string' && (v as any).key.length > 0) {
        return true;
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function fetchGrokSubscriptionMedia() {
  const targets = getGrokSubscriptionTargets();
  const usable = targets.filter(_grokInstanceHasAuth);
  modelCaches.grokSubscriptionMedia = usable.length ? GROK_SUB_MEDIA_MODELS.slice() : [];
  modelCaches.list = null;
  _trackProvider('Grok-SUB-Media', modelCaches.grokSubscriptionMedia.map((m) => m.name));
  logger.info('models.grok-subscription-media', {
    instances: usable.length,
    models: modelCaches.grokSubscriptionMedia.length,
  });
}

async function fetchCodexSubscriptionModels() {
  const defaultCodexBin = String(config.defaults?.codexBin || CODEX_BIN || 'codex').trim() || 'codex';
  const targets = getCodexSubscriptionTargets();
  const discovered = new Map();

  for (const target of targets) {
    const cachedModels = readCodexModelsCache(target.configDir);
    for (const model of cachedModels) discovered.set(model.name, model);
    if (cachedModels.length) continue;

    const { deriveIsolatedHome } = require('../chat/helpers');
    const codexHome = deriveIsolatedHome(target.configDir, '.codex');
    const env: Record<string, string> = { ...process.env, CODEX_HOME: target.configDir };
    if (codexHome) env.HOME = codexHome;
    const command = target.binary || defaultCodexBin;
    const models = await discoverCliModels({ command, env, tool: 'codex' });
    for (const model of models) {
      discovered.set(model, {
        name: model,
        displayName: model,
        description: '',
        vision: /^gpt-4|^gpt-5|^chatgpt-/i.test(model),
        reasoning: model.startsWith('o'),
        tools: true,
      });
    }
  }

  modelCaches.codexSubscription = [...discovered.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  modelCaches.list = null;
  _trackProvider('OpenAI-SUB', modelCaches.codexSubscription.map((m) => m.name));
  logger.info('models.codex-subscription', { count: modelCaches.codexSubscription.length });
}

// ── Live API model fetchers ───────────────────────────────────────────────────
async function fetchOpenAIModels() {
  const op = config.providers.find((p) => p.name === 'OpenAI');
  if (!op?.api_key) return;
  try {
    const base = (op.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${op.api_key}` },
    });
    if (!res.ok) return;
    const data: any = await res.json();
    const KEEP =
      /^(gpt-|o1|o3|o4|chatgpt-)(?!.*instruct)(?!.*whisper)(?!.*embed)(?!.*tts)(?!.*dall-e)(?!.*realtime)(?!.*audio)(?!.*search)(?!.*image)/;
    modelCaches.openai = (data.data || [])
      .filter((m) => m.id && KEEP.test(m.id))
      .map((m) => ({ id: m.id, name: m.id }));
    modelCaches.list = null;
    _trackProvider('OpenAI', modelCaches.openai.map((m) => m.id));
    logger.info('models.openai-fetched', { count: modelCaches.openai.length });
    await pruneStaleConfigModels(
      'OpenAI',
      modelCaches.openai.map((m) => m.id)
    );
  } catch (e) {
    logger.warn('models.openai-fetch-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

async function fetchOpenAIImageModels() {
  const op =
    config.providers.find((p) => p.name === 'OpenAI') ||
    config.providers.find((p) => p.name === 'OpenAI-Image');
  if (!op?.api_key) return;
  try {
    const base = (op.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${op.api_key}` },
    });
    if (!res.ok) return;
    const data: any = await res.json();
    const KEEP_IMAGE = /^(dall-e|gpt-image|chatgpt-image)/;
    modelCaches.openaiImage = (data.data || [])
      .filter((m) => m.id && KEEP_IMAGE.test(m.id))
      .map((m) => ({ id: m.id, name: m.id }));
    modelCaches.list = null;
    _trackProvider('OpenAI-Image', modelCaches.openaiImage.map((m) => m.id));
    logger.info('models.openai-image-fetched', { count: modelCaches.openaiImage.length });
  } catch (e) {
    logger.warn('models.openai-image-fetch-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

async function fetchGoogleModels() {
  const gp = config.providers.find((p) => p.name === 'Google');
  if (!gp?.api_key) return;
  try {
    const base = (gp.endpoint || 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/$/,
      ''
    );
    const res = await fetch(`${base}/models?key=${gp.api_key}`);
    if (!res.ok) return;
    const data: any = await res.json();
    const UTILITY_ONLY = new Set([
      'embedContent',
      'countTokens',
      'batchEmbedContents',
      'embedText',
    ]);
    modelCaches.google = (data.models || [])
      .filter((m) => {
        if (!m.name) return false;
        const methods = m.supportedGenerationMethods || [];
        return methods.length > 0 && methods.some((x) => !UTILITY_ONLY.has(x));
      })
      .map((m) => {
        const id = m.name.replace('models/', '');
        return { id, name: id, displayName: m.displayName || id };
      });
    modelCaches.list = null;
    _trackProvider('Google', modelCaches.google.map((m) => m.id));
    logger.info('models.google-fetched', { count: modelCaches.google.length });
    await pruneStaleConfigModels(
      'Google',
      modelCaches.google.map((m) => m.id)
    );
  } catch (e) {
    logger.warn('models.google-fetch-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

async function fetchGrokModels() {
  const gk = config.providers.find((p) => p.name === 'Grok');
  if (!gk?.api_key || gk.api_key === 'YOUR_XAI_API_KEY_HERE') return;
  try {
    const base = (gk.endpoint || 'https://api.x.ai/v1').replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${gk.api_key}` },
    });
    if (!res.ok) return;
    const data: any = await res.json();
    modelCaches.grok = (data.data || []).filter((m) => m.id).map((m) => ({ id: m.id, name: m.id }));
    modelCaches.list = null;
    _trackProvider('Grok', modelCaches.grok.map((m) => m.id));
    logger.info('models.grok-fetched', { count: modelCaches.grok.length });
    await pruneStaleConfigModels(
      'Grok',
      modelCaches.grok.map((m) => m.id)
    );
  } catch (e) {
    logger.warn('models.grok-fetch-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

async function fetchOpenRouterModels() {
  const op = config.providers.find((p) => p.name === 'OpenRouter');
  if (!op?.api_key) return;
  try {
    const base = (op.endpoint || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${op.api_key}` },
    });
    if (!res.ok) return;
    const data: any = await res.json();
    const round3 = (v) => Math.round(v * 1e9) / 1e9;
    modelCaches.openrouter = (data.data || [])
      .filter((m) => m.id)
      .map((m) => {
        const entry: any = { id: m.id, name: m.id, displayName: m.name };
        if (m.context_length) entry.context_length = m.context_length;
        const pi = parseFloat(m.pricing?.prompt);
        const po = parseFloat(m.pricing?.completion);
        if (!isNaN(pi) && pi > 0) entry.price_input = round3(pi * 1e6);
        if (!isNaN(po) && po > 0) entry.price_output = round3(po * 1e6);
        // Capture tool support from OpenRouter's supported_parameters field
        const params = m.supported_parameters || [];
        entry.tools = params.includes('tools');
        return entry;
      });
    // Upsert pricing into config so it persists and shows in the Models tab.
    // Serialized per-provider so two concurrent fetch-models POSTs for
    // OpenRouter can't interleave their merge/write phases.
    await withProviderConfigLock('OpenRouter', () => {
      if (!op.models) op.models = {};
      let changed = false;
      for (const m of modelCaches.openrouter) {
        if (!op.models[m.name]) {
          op.models[m.name] = { model_id: m.name, type: detectModelType(m.name) };
          changed = true;
        }
        const cfg = op.models[m.name];
        for (const field of ['price_input', 'price_output', 'context_length']) {
          if (m[field] !== undefined && cfg[field] !== m[field]) {
            cfg[field] = m[field];
            changed = true;
          }
        }
        // Also write tool capability if available
        if (m.tools !== undefined && cfg.supports_function_calling !== m.tools) {
          cfg.supports_function_calling = m.tools;
          changed = true;
        }
      }
      if (changed) {
        try {
          writeJsonSync(CONFIG_PATH, config);
        } catch (e) {
          logger.warn('models.openrouter-config-write-failed', { error: e instanceof Error ? e.message : String(e) });
        }
      }
    });
    modelCaches.list = null;
    _trackProvider('OpenRouter', modelCaches.openrouter.map((m) => m.id));
    logger.info('models.openrouter-fetched', { count: modelCaches.openrouter.length });
  } catch (e) {
    logger.warn('models.openrouter-fetch-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

async function fetchNVIDIAModels() {
  const np = config.providers.find((p) => p.name === 'NVIDIA');
  if (!np) return;
  try {
    const base = (np.endpoint || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
    const headers = np.api_key ? { Authorization: `Bearer ${np.api_key}` } : {};
    const res = await fetch(`${base}/models`, { headers });
    if (!res.ok) return;
    const data: any = await res.json();
    modelCaches.nvidia = (data.data || [])
      .filter((m) => m.id)
      .map((m) => ({ id: m.id, name: m.id }));
    modelCaches.list = null;
    _trackProvider('NVIDIA', modelCaches.nvidia.map((m) => m.id));
    logger.info('models.nvidia-fetched', { count: modelCaches.nvidia.length });
    await pruneStaleConfigModels(
      'NVIDIA',
      modelCaches.nvidia.map((m) => m.id)
    );
  } catch (e) {
    logger.warn('models.nvidia-fetch-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

async function fetchDeepSeekModels() {
  const dp = config.providers.find((p) => p.name === 'DeepSeek');
  if (!dp?.api_key) return;
  try {
    const base = (dp.endpoint || 'https://api.deepseek.com/v1').replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${dp.api_key}` },
    });
    if (!res.ok) return;
    const data: any = await res.json();
    modelCaches.deepseek = (data.data || [])
      .filter((m) => m.id)
      .map((m) => ({ id: m.id, name: m.id }));
    modelCaches.list = null;
    _trackProvider('DeepSeek', modelCaches.deepseek.map((m) => m.id));
    logger.info('models.deepseek-fetched', { count: modelCaches.deepseek.length });
  } catch (e) {
    logger.warn('models.deepseek-fetch-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

async function fetchAnthropicModels() {
  const ap = config.providers.find((p) => p.name === 'Anthropic');
  if (!ap?.api_key) return;
  try {
    const base = 'https://api.anthropic.com/v1/models';
    const headers = { 'x-api-key': ap.api_key, 'anthropic-version': '2023-06-01' };
    const allModels = [];
    let afterId = null;
    // Paginate through all pages (Anthropic returns newest-first, default limit 20)
    for (let page = 0; page < 20; page++) {
      const url = base + '?limit=100' + (afterId ? `&after_id=${encodeURIComponent(afterId)}` : '');
      const res = await fetch(url, { headers });
      if (!res.ok) break;
      const data: any = await res.json();
      allModels.push(...(data.data || []));
      if (!data.has_more) break;
      afterId = data.last_id;
      if (!afterId) break;
    }
    modelCaches.anthropic = allModels
      .filter((m) => m.id && !m.id.startsWith('claude-2')) // skip legacy
      .map((m) => ({ id: m.id, name: m.id, displayName: m.display_name || m.id }));
    modelCaches.list = null;
    _trackProvider('Anthropic', modelCaches.anthropic.map((m) => m.id));
    logger.info('models.anthropic-fetched', { count: modelCaches.anthropic.length });
    await pruneStaleConfigModels(
      'Anthropic',
      modelCaches.anthropic.map((m) => m.id)
    );
  } catch (e) {
    logger.warn('models.anthropic-fetch-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Generic fetcher for user-added providers ──────────────────────────────────
// Built-in providers (Anthropic, OpenAI, Google, Grok, OpenRouter, NVIDIA,
// DeepSeek) each have a dedicated fetcher above with provider-specific filters.
// Anything else added through the dynamic-provider UI (Ollama, LM Studio,
// custom OpenAI-compat servers, …) goes through this generic /models call.
const BUILT_IN_PROVIDERS = new Set([
  'Anthropic',
  'OpenAI',
  'OpenAI-Image',
  'Google',
  'Grok',
  'OpenRouter',
  'NVIDIA',
  'DeepSeek',
]);

async function fetchExtraProvidersModels() {
  const targets = (config.providers || []).filter(
    (p) =>
      p &&
      !p.hidden &&
      p.fetch_live &&
      !BUILT_IN_PROVIDERS.has(p.name) &&
      p.endpoint
  );
  if (!targets.length) return;

  await Promise.allSettled(
    targets.map(async (p) => {
      try {
        const models = await fetchModelsGeneric(p);
        if (!models) return;
        modelCaches.byProvider[p.name] = models;
        modelCaches.list = null;
        _trackProvider(p.name, models.map((m) => m.id));
        logger.info('models.extra-provider-fetched', { provider: p.name, count: models.length });
      } catch (e) {
        logger.warn('models.extra-provider-fetch-failed', {
          provider: p.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })
  );
}

async function fetchModelsGeneric(provider) {
  switch (provider.api_style) {
    case 'google':    return fetchGoogleStyle(provider);
    case 'anthropic': return fetchAnthropicStyle(provider);
    case 'openai':
    default:          return fetchOpenAICompatStyle(provider);
  }
}

async function fetchOpenAICompatStyle(provider) {
  const base = String(provider.endpoint || '').replace(/\/$/, '');
  if (!base) return null;
  const headers: Record<string, string> = {};
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;
  const res = await fetch(`${base}/models`, { headers });
  if (!res.ok) return null;
  const data: any = await res.json();
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return list
    .map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m.id || m.name || m.model, name: m.id || m.name || m.model }))
    .filter((m) => m.id);
}

async function fetchGoogleStyle(provider) {
  const base = String(provider.endpoint || '').replace(/\/$/, '');
  if (!base || !provider.api_key) return null;
  const res = await fetch(`${base}/models?key=${provider.api_key}`);
  if (!res.ok) return null;
  const data: any = await res.json();
  return (data.models || [])
    .filter((m) => m.name)
    .map((m) => {
      const id = String(m.name).replace('models/', '');
      return { id, name: id };
    });
}

async function fetchAnthropicStyle(provider) {
  const base = String(provider.endpoint || '').replace(/\/$/, '').replace(/\/v1$/, '');
  if (!base || !provider.api_key) return null;
  const res = await fetch(`${base}/v1/models?limit=100`, {
    headers: { 'x-api-key': provider.api_key, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  return (data.data || []).filter((m) => m.id).map((m) => ({ id: m.id, name: m.id }));
}

module.exports = {
  fetchClaudeSubscriptionModels,
  fetchCodexSubscriptionModels,
  fetchGrokSubscriptionModels,
  fetchGrokSubscriptionMedia,
  fetchOpenAIModels,
  fetchOpenAIImageModels,
  fetchGoogleModels,
  fetchGrokModels,
  fetchOpenRouterModels,
  fetchNVIDIAModels,
  fetchDeepSeekModels,
  fetchAnthropicModels,
  fetchExtraProvidersModels,
  fetchModelsGeneric,
};
