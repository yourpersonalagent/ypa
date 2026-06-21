// ── Presets / toolSets / skills / skillSets / harness-instance routes ───────
// Extracted from handler.ts (registerConfigRoutes) — see ./handler.ts.
// Skill file storage is shared with config-core (GET /v1/config/) via
// ./skills-helpers. Claude/Codex instance writes re-materialize MCP tools via
// the on-demand module-api helper so a disabled mcp-client degrades to a warn.
'use strict';

const fs = require('fs');

const { config, saveConfig, getSystemPromptsMap, saveSystemPrompts } = require('../core/state');
const { getModuleApi } = require('../core/modules');
const { ensureSkillsDir, skillNameToFile, listSkills } = require('./skills-helpers');

function _mcp() { return getModuleApi('mcp-client'); }

function registerPresetsRoutes(app) {
  // ── PUT /v1/config/presets/:name — create or update a preset ────────────────
  app.put('/v1/config/presets/:name', async (req, res) => {
    const name = req.params.name.trim();
    const { text } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    if (typeof text !== 'string')
      return res.status(400).json({ success: false, error: 'text required' });
    try {
      const presets = getSystemPromptsMap();
      presets[name] = text;
      await saveSystemPrompts(presets);
      res.json({ success: true, name, text });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── DELETE /v1/config/presets/:name — delete a preset ───────────────────────
  app.delete('/v1/config/presets/:name', async (req, res) => {
    const name = req.params.name.trim();
    const presets = getSystemPromptsMap();
    if (!(name in presets))
      return res.status(404).json({ success: false, error: 'not found' });
    try {
      delete presets[name];
      await saveSystemPrompts(presets);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── PUT /v1/config/toolSets/:name — create or update a tool-set preset ──────
  app.put('/v1/config/toolSets/:name', async (req, res) => {
    const name = req.params.name.trim();
    const { tools } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    if (!Array.isArray(tools))
      return res.status(400).json({ success: false, error: 'tools must be an array' });
    const cleaned = [...new Set(tools.map((v) => String(v || '').trim()).filter(Boolean))];
    config.toolSets = config.toolSets || {};
    config.toolSets[name] = cleaned;
    try {
      await saveConfig();
      res.json({ success: true, name, tools: cleaned });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── DELETE /v1/config/toolSets/:name — delete a tool-set preset ─────────────
  app.delete('/v1/config/toolSets/:name', async (req, res) => {
    const name = req.params.name.trim();
    if (!config.toolSets?.[name])
      return res.status(404).json({ success: false, error: 'not found' });
    delete config.toolSets[name];
    try {
      await saveConfig();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/config/skills/ — list all skills ────────────────────────────────
  app.get('/v1/config/skills/', async (req, res) => {
    try {
      res.json({ success: true, skills: await listSkills() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/config/skills/:name — get single skill content ─────────────────
  app.get('/v1/config/skills/:name', async (req, res) => {
    const name = req.params.name.trim();
    try {
      const content = await fs.promises.readFile(skillNameToFile(name), 'utf8');
      res.json({ success: true, name, content });
    } catch (_) {
      res.status(404).json({ success: false, error: 'not found' });
    }
  });

  // ── PUT /v1/config/skills/:name — create or update a skill ─────────────────
  app.put('/v1/config/skills/:name', async (req, res) => {
    await ensureSkillsDir();
    const name = req.params.name.trim();
    const { content } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    if (typeof content !== 'string')
      return res.status(400).json({ success: false, error: 'content required' });
    try {
      await fs.promises.writeFile(skillNameToFile(name), content, 'utf8');
      res.json({ success: true, name });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── DELETE /v1/config/skills/:name — delete a skill ─────────────────────────
  app.delete('/v1/config/skills/:name', async (req, res) => {
    const name = req.params.name.trim();
    try {
      await fs.promises.unlink(skillNameToFile(name));
      res.json({ success: true });
    } catch (_) {
      res.status(404).json({ success: false, error: 'not found' });
    }
  });

  // ── PUT /v1/config/skillSets/:name — create or update a skill set ───────────
  // Body: { skills: string[], activeInChat?: boolean }
  // When activeInChat is provided the set's membership in
  // config.skillSetsActiveInChat is updated; otherwise that membership is
  // preserved untouched (so unrelated PUTs from the editor don't toggle it).
  app.put('/v1/config/skillSets/:name', async (req, res) => {
    const name = req.params.name.trim();
    const { skills, activeInChat } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    if (!Array.isArray(skills))
      return res.status(400).json({ success: false, error: 'skills must be an array' });
    const cleaned = [...new Set(skills.map((v) => String(v || '').trim()).filter(Boolean))];
    config.skillSets = config.skillSets || {};
    config.skillSets[name] = cleaned;
    if (typeof activeInChat === 'boolean') {
      const cur: string[] = Array.isArray(config.skillSetsActiveInChat) ? config.skillSetsActiveInChat : [];
      const has = cur.includes(name);
      if (activeInChat && !has) cur.push(name);
      else if (!activeInChat && has) cur.splice(cur.indexOf(name), 1);
      config.skillSetsActiveInChat = cur;
    }
    try {
      await saveConfig();
      res.json({ success: true, name, skills: cleaned, activeInChat: (config.skillSetsActiveInChat || []).includes(name) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/config/activeSkillCategories — toggle a category's active-in-chat membership ──
  // Body: { name: string, active: boolean }
  // Categories are the modern grouping (declared in each skill's frontmatter
  // `category:`). resolveActiveChatSkills() treats names in
  // `skillSetsActiveInChat` as category slugs first, falling back to legacy
  // skillSets keys. We reuse the same wire field instead of forking schema
  // so config keeps one canonical "what's active in chat" list.
  app.post('/v1/config/activeSkillCategories', async (req, res) => {
    const { name, active } = req.body || {};
    if (typeof name !== 'string' || !name.trim())
      return res.status(400).json({ success: false, error: 'name required' });
    if (typeof active !== 'boolean')
      return res.status(400).json({ success: false, error: 'active must be boolean' });
    const cur: string[] = Array.isArray(config.skillSetsActiveInChat) ? config.skillSetsActiveInChat : [];
    const has = cur.includes(name);
    if (active && !has) cur.push(name);
    else if (!active && has) cur.splice(cur.indexOf(name), 1);
    config.skillSetsActiveInChat = cur;
    try {
      await saveConfig();
      res.json({ success: true, name, active: cur.includes(name) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── DELETE /v1/config/skillSets/:name — delete a skill set ──────────────────
  app.delete('/v1/config/skillSets/:name', async (req, res) => {
    const name = req.params.name.trim();
    if (!config.skillSets?.[name])
      return res.status(404).json({ success: false, error: 'not found' });
    delete config.skillSets[name];
    if (Array.isArray(config.skillSetsActiveInChat)) {
      const i = config.skillSetsActiveInChat.indexOf(name);
      if (i !== -1) config.skillSetsActiveInChat.splice(i, 1);
    }
    try {
      await saveConfig();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── PUT /v1/config/instances/:label — add or update a Claude harness instance
  app.put('/v1/config/instances/:label', async (req, res) => {
    const label = req.params.label.trim();
    const { configDir, binary, claudeBin } = req.body || {};
    if (!label) return res.status(400).json({ success: false, error: 'label required' });
    if (!configDir) return res.status(400).json({ success: false, error: 'configDir required' });
    config.defaults = config.defaults || {};
    config.defaults.claudeInstances = config.defaults.claudeInstances || [];
    const existing = config.defaults.claudeInstances.findIndex((i) => i.label === label);
    const entry: any = { label, configDir: String(configDir) };
    // claudeBin is the canonical field; legacy `binary` accepted for backcompat.
    const binPath = claudeBin || binary;
    if (binPath) entry.claudeBin = String(binPath);
    if (existing >= 0) config.defaults.claudeInstances[existing] = entry;
    else config.defaults.claudeInstances.push(entry);
    try {
      await saveConfig();
      try {
        const mcp = _mcp();
        if (mcp) mcp.promoteMcpTools(config);
        else console.warn('MCP materialize skipped: mcp-client module is disabled');
      } catch (e) { console.warn(`MCP materialize failed: ${e instanceof Error ? e.message : String(e)}`); }
      res.json({ success: true, instances: config.defaults.claudeInstances });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── DELETE /v1/config/instances/:label — remove a harness instance ───────────
  app.delete('/v1/config/instances/:label', async (req, res) => {
    const label = req.params.label.trim();
    const instances = config.defaults?.claudeInstances || [];
    const idx = instances.findIndex((i) => i.label === label);
    if (idx < 0) return res.status(404).json({ success: false, error: 'not found' });
    instances.splice(idx, 1);
    try {
      await saveConfig();
      try {
        const mcp = _mcp();
        if (mcp) mcp.promoteMcpTools(config);
        else console.warn('MCP materialize skipped: mcp-client module is disabled');
      } catch (e) { console.warn(`MCP materialize failed: ${e instanceof Error ? e.message : String(e)}`); }
      res.json({ success: true, instances });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── PUT /v1/config/codex-instances/:label — add or update a Codex instance ──
  app.put('/v1/config/codex-instances/:label', async (req, res) => {
    const label = req.params.label.trim();
    const { configDir, codexBin } = req.body || {};
    if (!label) return res.status(400).json({ success: false, error: 'label required' });
    if (!configDir) return res.status(400).json({ success: false, error: 'configDir required' });
    config.defaults = config.defaults || {};
    config.defaults.codexInstances = config.defaults.codexInstances || [];
    const existing = config.defaults.codexInstances.findIndex((i) => i.label === label);
    const entry: any = { label, configDir: String(configDir) };
    if (codexBin) entry.codexBin = String(codexBin);
    if (existing >= 0) config.defaults.codexInstances[existing] = entry;
    else config.defaults.codexInstances.push(entry);
    try {
      await saveConfig();
      try {
        const mcp = _mcp();
        if (mcp) mcp.promoteMcpTools(config);
        else console.warn('MCP materialize skipped: mcp-client module is disabled');
      } catch (e) { console.warn(`MCP materialize failed: ${e instanceof Error ? e.message : String(e)}`); }
      res.json({ success: true, instances: config.defaults.codexInstances });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── DELETE /v1/config/codex-instances/:label — remove a Codex instance ──────
  app.delete('/v1/config/codex-instances/:label', async (req, res) => {
    const label = req.params.label.trim();
    const instances = config.defaults?.codexInstances || [];
    const idx = instances.findIndex((i) => i.label === label);
    if (idx < 0) return res.status(404).json({ success: false, error: 'not found' });
    instances.splice(idx, 1);
    try {
      await saveConfig();
      try {
        const mcp = _mcp();
        if (mcp) mcp.promoteMcpTools(config);
        else console.warn('MCP materialize skipped: mcp-client module is disabled');
      } catch (e) { console.warn(`MCP materialize failed: ${e instanceof Error ? e.message : String(e)}`); }
      res.json({ success: true, instances });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── PUT /v1/config/grok-instances/:label — add or update a Grok instance ────
  app.put('/v1/config/grok-instances/:label', async (req, res) => {
    const label = req.params.label.trim();
    const { configDir, grokBin } = req.body || {};
    if (!label) return res.status(400).json({ success: false, error: 'label required' });
    if (!configDir) return res.status(400).json({ success: false, error: 'configDir required' });
    config.defaults = config.defaults || {};
    config.defaults.grokInstances = config.defaults.grokInstances || [];
    const existing = config.defaults.grokInstances.findIndex((i) => i.label === label);
    const entry: any = { label, configDir: String(configDir) };
    if (grokBin) entry.grokBin = String(grokBin);
    if (existing >= 0) config.defaults.grokInstances[existing] = entry;
    else config.defaults.grokInstances.push(entry);
    try {
      await saveConfig();
      try {
        const mcp = _mcp();
        if (mcp) mcp.promoteMcpTools(config);
        else console.warn('MCP materialize skipped: mcp-client module is disabled');
      } catch (e) { console.warn(`MCP materialize failed: ${e instanceof Error ? e.message : String(e)}`); }
      res.json({ success: true, instances: config.defaults.grokInstances });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── DELETE /v1/config/grok-instances/:label — remove a Grok instance ────────
  app.delete('/v1/config/grok-instances/:label', async (req, res) => {
    const label = req.params.label.trim();
    const instances = config.defaults?.grokInstances || [];
    const idx = instances.findIndex((i) => i.label === label);
    if (idx < 0) return res.status(404).json({ success: false, error: 'not found' });
    instances.splice(idx, 1);
    try {
      await saveConfig();
      try {
        const mcp = _mcp();
        if (mcp) mcp.promoteMcpTools(config);
        else console.warn('MCP materialize skipped: mcp-client module is disabled');
      } catch (e) { console.warn(`MCP materialize failed: ${e instanceof Error ? e.message : String(e)}`); }
      res.json({ success: true, instances });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = { registerPresetsRoutes };
