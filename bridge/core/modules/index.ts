// Bridge module-loader public surface.
'use strict';

const { boot, reload, getActiveRequests, getReloadPosture, MODULES_JSON, MODULES_DIR } = require('./loader');
const { registerModuleRoutes } = require('./routes');
const registry = require('./registry');
const { getModuleApi, requireModuleApi, isModuleActive } = require('./api');
const { listModuleSkills, readModuleSkillBody } = require('./module-skills');
const watcher = require('./watcher');

module.exports = {
  boot,
  reload,
  getActiveRequests,
  getReloadPosture,
  startWatcher: watcher.start,
  stopWatcher: watcher.stop,
  registry,
  registerModuleRoutes,
  // Cross-module API lookup (Phase-6 unblocker). Core call-sites that
  // used to `require('../modules/X/Y')` should call getModuleApi('X')
  // and read the function off the returned api object. Disabling X in
  // modules.json then cleanly removes the API; callers that bound it
  // with `requireModuleApi` get a clear thrown error instead of a
  // module-not-found explosion.
  getModuleApi,
  requireModuleApi,
  isModuleActive,
  // Module-provided skills: a module that declares
  // `provides.skills: ['<name>', ...]` in its manifest and ships
  // `<moduleDir>/skills/<name>/SKILL.md` gets `#skill-<name>` in the
  // chat command picker while it is active. Discovery walks the active
  // registry so disabling the module drops the skill on next cache roll.
  listModuleSkills,
  readModuleSkillBody,
  MODULES_JSON,
  MODULES_DIR,
};
