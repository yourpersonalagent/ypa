#!/usr/bin/env node
// @ts-check
// Build per-slug handoff.json manifests under bridge/knowledge/dirs/<slug>/.
// knowledge_ask reads these and ships a tier-shaped slice in every response,
// so even a cold caller gets a free orientation. Run nightly (or after
// build_code_graph). Phase 3 of docs/knowledge-unified-plan.md.
//
// Usage:
//   node build_handoff.js               # rebuild all slugs in index.json
//   node build_handoff.js <slug>        # rebuild one slug

'use strict';

const fs   = require('fs');
const path = require('path');

// Resolved through bridge/core/paths.ts — see knowledge-server.js for context.
const KNOWLEDGE_ROOT = require('../core/paths').knowledgeRoot;
const DIRS_ROOT      = path.join(KNOWLEDGE_ROOT, 'dirs');
const INDEX_JSON     = path.join(KNOWLEDGE_ROOT, 'index.json');

function readIndex() {
  if (!fs.existsSync(INDEX_JSON)) return {};
  try { return JSON.parse(fs.readFileSync(INDEX_JSON, 'utf8')); } catch (_) { return {}; }
}

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }
function dirExists(p)  { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

function countMd(dir) {
  if (!dirExists(dir)) return 0;
  let n = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) n++;
    }
  })(dir);
  return n;
}

// ── Graph slice ─────────────────────────────────────────────────────────────
function loadGraph(slug) {
  const p = path.join(DIRS_ROOT, slug, 'graph', 'graph.json');
  if (!fileExists(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function topGodNodes(graph, limit) {
  const deg = new Map();
  for (const link of graph.links || []) {
    deg.set(link.source, (deg.get(link.source) || 0) + 1);
    deg.set(link.target, (deg.get(link.target) || 0) + 1);
  }
  const byId = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const ranked = [...deg.entries()]
    .map(([id, d]) => ({ id, degree: d, node: byId.get(id) }))
    .filter((r) => r.node && r.node.file_type === 'code')
    .sort((a, b) => b.degree - a.degree)
    .slice(0, limit);
  return ranked.map((r) => ({
    id: r.id,
    label: r.node.label,
    source_file: r.node.source_file,
    community: r.node.community,
    degree: r.degree,
  }));
}

// Map module folder → centrality so handoff can rank modules by hub score.
// Falls back to <workingDir>-modular/bridge/modules to tolerate the yha → yha-modular
// migration where the recorded workingDir still points at the legacy tree.
function buildModuleIndex(workingDir, graph) {
  const candidates = [
    path.join(workingDir, 'bridge', 'modules'),
    path.join(workingDir + '-modular', 'bridge', 'modules'),
    path.resolve(__dirname, '..', 'modules'),
  ];
  const modulesDir = candidates.find(dirExists);
  if (!modulesDir) return [];
  const deg = new Map();
  if (graph) {
    for (const link of graph.links || []) {
      deg.set(link.source, (deg.get(link.source) || 0) + 1);
      deg.set(link.target, (deg.get(link.target) || 0) + 1);
    }
  }
  const out = [];
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mjsonPath = path.join(modulesDir, entry.name, 'module.json');
    if (!fileExists(mjsonPath)) continue;
    let mod;
    try { mod = JSON.parse(fs.readFileSync(mjsonPath, 'utf8')); } catch (_) { continue; }
    const rel = path.relative(workingDir, path.join(modulesDir, entry.name));
    let hub = 0;
    if (graph) {
      for (const n of graph.nodes || []) {
        if (typeof n.source_file === 'string' && n.source_file.startsWith(rel + path.sep)) {
          hub += deg.get(n.id) || 0;
        }
      }
    }
    out.push({
      name: mod.name || entry.name,
      path: rel,
      category: mod.category || null,
      one_liner: (mod.description || '').split('\n')[0].slice(0, 240),
      hub_score: hub,
    });
  }
  return out.sort((a, b) => b.hub_score - a.hub_score);
}

// ── Activity log slice ──────────────────────────────────────────────────────
function recentActivity(slug, limit) {
  const p = path.join(DIRS_ROOT, slug, 'synthesis', 'log.md');
  if (!fileExists(p)) return [];
  const body = fs.readFileSync(p, 'utf8');
  const blocks = body.split(/\n(?=## )/).filter((b) => b.trim().startsWith('## '));
  return blocks.slice(-limit).reverse().map((b) => {
    const lines = b.split('\n');
    const header = lines[0].replace(/^##\s*/, '');
    const m = header.match(/^\[(\d{4}-\d{2}-\d{2})\]\s+(\w+)\s*\|\s*(.+)$/);
    const summary = (lines.find((l, i) => i > 0 && l.trim()) || '').slice(0, 240);
    return m
      ? { date: m[1], kind: m[2], title: m[3], summary }
      : { date: null, kind: null, title: header, summary };
  });
}

// ── Glossary mining ─────────────────────────────────────────────────────────
// Pulls lines of the form: `- **term** — definition` or `**term** — definition`
// from synthesis/summaries/*.md.
function mineGlossary(slug, limit) {
  const dir = path.join(DIRS_ROOT, slug, 'synthesis', 'summaries');
  if (!dirExists(dir)) return [];
  const out = [];
  const seen = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of body.split('\n')) {
      const m = line.match(/\*\*`?([^`*]+?)`?\*\*\s+[—–-]\s+(.+)/);
      if (!m) continue;
      const term = m[1].trim();
      if (seen.has(term)) continue;
      seen.add(term);
      out.push({ term, definition: m[2].trim().slice(0, 240), source: f });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ── Category counts ─────────────────────────────────────────────────────────
// Pulls per-category counts from bridge/data/sessions.db if reachable. We avoid
// pulling in sqlite as a dependency — if better-sqlite3 isn't installed at the
// workspace level, return null and let the consumer treat it as missing.
function categoryCounts(workingDir) {
  const dbPath = path.join(workingDir, 'bridge', 'data', 'sessions.db');
  if (!fileExists(dbPath)) return null;
  let Db;
  try { Db = require('better-sqlite3'); } catch (_) { return null; }
  try {
    const db = new Db(dbPath, { readonly: true, fileMustExist: true });
    const cols = db.prepare("PRAGMA table_info(sessions)").all().map((r) => r.name);
    if (!cols.includes('category')) { db.close(); return null; }
    const rows = db.prepare('SELECT category, COUNT(*) AS n FROM sessions GROUP BY category').all();
    db.close();
    const counts = {};
    for (const r of rows) counts[r.category || '(none)'] = r.n;
    return counts;
  } catch (_) { return null; }
}

// ── Per-slug build ──────────────────────────────────────────────────────────
function buildSlug(slug, workingDir) {
  const slugDir = path.join(DIRS_ROOT, slug);
  if (!dirExists(slugDir)) return { slug, skipped: 'no slug dir' };

  const synDir = path.join(slugDir, 'synthesis');
  const synCode = countMd(path.join(synDir, 'code'));
  const synSummaries = countMd(path.join(synDir, 'summaries'));
  const logBytes = fileExists(path.join(synDir, 'log.md')) ? fs.statSync(path.join(synDir, 'log.md')).size : 0;

  const graph = loadGraph(slug);
  const coverage = {
    synthesis_code: synCode,
    synthesis_summaries: synSummaries,
    log_bytes: logBytes,
    graph_available: !!graph,
    graph_nodes: graph?.nodes?.length || 0,
    graph_built_at: graph?.yhaMeta?.generatedAt || null,
  };

  const manifest = {
    slug,
    workingDir,
    last_built: new Date().toISOString(),
    coverage,
    god_nodes: graph ? topGodNodes(graph, 20) : [],
    module_index: workingDir ? buildModuleIndex(workingDir, graph) : [],
    recent_activity: recentActivity(slug, 10),
    glossary: mineGlossary(slug, 20),
    category_counts: workingDir ? categoryCounts(workingDir) : null,
  };

  const outPath = path.join(slugDir, 'handoff.json');
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
  return {
    slug,
    wrote: outPath,
    gods: manifest.god_nodes.length,
    mods: manifest.module_index.length,
    activity: manifest.recent_activity.length,
    glossary: manifest.glossary.length,
    bytes: fs.statSync(outPath).size,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const idx = readIndex();
  const argSlug = process.argv[2];
  const targets = argSlug ? [argSlug] : Object.keys(idx);
  if (!targets.length) {
    console.error('No slugs in', INDEX_JSON);
    process.exit(1);
  }
  const results = [];
  for (const slug of targets) {
    const wd = idx[slug] || null;
    try {
      results.push(buildSlug(slug, wd));
    } catch (e) {
      results.push({ slug, error: e.message });
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

if (require.main === module) main();

module.exports = { buildSlug, readIndex };
