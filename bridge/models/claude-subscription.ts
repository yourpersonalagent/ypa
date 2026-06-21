// Shared Claude Code subscription model helpers — discovery filtering,
// latest-per-family selection from the Anthropic API catalogue, and
// rolling-alias resolution at spawn time.
'use strict';

const { config, modelCaches } = require('../core/state');
const { detectModelType } = require('./detect');

const CLAUDE_SUBSCRIPTION_FALLBACK: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5',
};

function stripClaudeDateSuffix(id: string): string {
  return id.replace(/-\d{8}$/, '').replace(/-[a-z]+-\d{8}$/, '');
}

function claudeVersionParts(baseName: string): number[] {
  const m = baseName.match(/^claude-[a-z]+-(.+)$/);
  if (!m) return [];
  return m[1]
    .split('-')
    .map(Number)
    .filter((n) => !isNaN(n));
}

function compareClaudeVersions(a: string, b: string): number {
  const pa = claudeVersionParts(a);
  const pb = claudeVersionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function claudeFamily(baseName: string): string {
  const m = baseName.match(/^claude-([a-z]+)-/);
  return m ? m[1] : baseName;
}

function configuredAnthropicModels(): string[] {
  const p = config.providers.find((pp) => pp.name === 'Anthropic');
  return Object.keys(p?.models || {}).filter((name) => detectModelType(name) === 'llm');
}

// Pick the newest dated Claude id per family (opus / sonnet / haiku) from
// the live Anthropic API list and any configured Anthropic provider models.
// API availability is used only as a naming catalogue — subscription turns
// still route through the Claude Code OAuth binary, not the paid API key.
function latestClaudeFamilyCandidates(): string[] {
  const bestByFamily = new Map<string, string>();
  for (const id of [
    ...modelCaches.anthropic.map((m) => m.id),
    ...configuredAnthropicModels(),
  ]) {
    if (detectModelType(id) !== 'llm') continue;
    const base = stripClaudeDateSuffix(id);
    const family = claudeFamily(base);
    const cur = bestByFamily.get(family);
    if (!cur || compareClaudeVersions(base, cur) > 0) bestByFamily.set(family, base);
  }
  return [...bestByFamily.values()];
}

function claudeSubscriptionFallbackList(): string[] {
  return Object.values(CLAUDE_SUBSCRIPTION_FALLBACK);
}

function isClaudeRollingAlias(id: string): boolean {
  return /^(sonnet|opus|haiku)$/i.test(String(id || '').trim());
}

// Full Claude API ids only — rolling aliases are resolved at spawn, not listed.
function isClaudeSubscriptionModelCandidate(id: string): boolean {
  return /^claude-(?:(?:opus|sonnet|haiku)-\d+(?:[-.]\d+)*(?:-(?:latest|\d{8}))?|\d+(?:[-.]\d+)*-(?:opus|sonnet|haiku)(?:-(?:latest|\d{8}))?)$/i.test(
    String(id || '').trim(),
  );
}

// Map legacy picker values (sonnet/opus/haiku) and any stale alias to the
// newest full Claude id we know about. The Claude Code CLI accepts aliases
// interactively, but the API rejects bare names like "opus".
function resolveClaudeSubscriptionModel(modelId: string): string {
  const id = String(modelId || '').trim();
  if (!isClaudeRollingAlias(id)) return id;
  const family = id.toLowerCase();
  const latest = latestClaudeFamilyCandidates();
  const hit = latest.find((m) => claudeFamily(stripClaudeDateSuffix(m)) === family);
  if (hit) return hit;
  return CLAUDE_SUBSCRIPTION_FALLBACK[family] || id;
}

function buildClaudeSubscriptionModelList(): string[] {
  const discovered = (modelCaches.claudeSubscription || []).filter(
    (name) => isClaudeSubscriptionModelCandidate(name) && !isClaudeRollingAlias(name),
  );
  const fallbackCandidates =
    modelCaches.anthropic.length || configuredAnthropicModels().length
      ? latestClaudeFamilyCandidates()
      : claudeSubscriptionFallbackList();
  return [...new Set([...discovered, ...fallbackCandidates])].sort();
}

module.exports = {
  CLAUDE_SUBSCRIPTION_FALLBACK,
  stripClaudeDateSuffix,
  claudeFamily,
  latestClaudeFamilyCandidates,
  claudeSubscriptionFallbackList,
  isClaudeRollingAlias,
  isClaudeSubscriptionModelCandidate,
  resolveClaudeSubscriptionModel,
  buildClaudeSubscriptionModelList,
};