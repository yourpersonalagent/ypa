'use strict';

const fs = require('fs');
const path = require('path');
const PATHS = require('../../core/paths');
const { writeJsonAsync } = require('../../core/state');
const logger = require('../../core/logger');

function _ensureDir() {
  if (!fs.existsSync(PATHS.groupsDir)) {
    fs.mkdirSync(PATHS.groupsDir, { recursive: true });
  }
}

function groupFilePath(id: string): string {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return path.join(PATHS.groupsDir, `${safe}.json`);
}

async function saveGroup(group: any): Promise<void> {
  _ensureDir();
  await writeJsonAsync(groupFilePath(group.id), group);
}

function loadGroup(id: string): any | null {
  try {
    const fp = groupFilePath(id);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    logger.warn('multichat-group.load-failed', { id, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

async function deleteGroupFile(id: string): Promise<void> {
  try {
    await fs.promises.unlink(groupFilePath(id)).catch((e: any) => {
      if (e.code !== 'ENOENT') throw e;
    });
  } catch (e) {
    logger.warn('multichat-group.delete-failed', { id, error: e instanceof Error ? e.message : String(e) });
  }
}

function loadAllGroups(): any[] {
  _ensureDir();
  const groups: any[] = [];
  try {
    for (const file of fs.readdirSync(PATHS.groupsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PATHS.groupsDir, file), 'utf8'));
        if (data && data.id) groups.push(data);
      } catch (_) {}
    }
  } catch (_) {}
  return groups;
}

module.exports = { saveGroup, loadGroup, deleteGroupFile, loadAllGroups };
