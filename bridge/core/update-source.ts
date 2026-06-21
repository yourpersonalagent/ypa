// Per-node update source preference (mirrors Updates tab public/custom choice).
// Stored server-side so YHA Net background sync can check the same source.
// @ts-nocheck
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { NET_DIR, atomicWriteJson, readJson, nowIso } = require('./net-identity');

const UPDATE_SOURCE_FILE = path.join(NET_DIR, 'update-source.json');
const STANDARD_UPDATE_URL = 'https://github.com/yourpersonalagent/ypa';

function defaultUpdateSource() {
  return {
    schemaVersion: 1,
    mode: 'standard',
    url: STANDARD_UPDATE_URL,
    token: '',
    updatedAt: null,
  };
}

function normalizeUpdateSource(input: any = {}) {
  const mode = input.mode === 'custom' ? 'custom' : 'standard';
  const url = String(input.url || (mode === 'custom' ? '' : STANDARD_UPDATE_URL)).trim();
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  return {
    schemaVersion: 1,
    mode,
    url: mode === 'custom' ? url : STANDARD_UPDATE_URL,
    token,
    updatedAt: input.updatedAt || nowIso(),
  };
}

function readUpdateSource() {
  const saved = readJson(UPDATE_SOURCE_FILE, null);
  if (saved && (saved.mode === 'custom' || saved.mode === 'standard')) {
    return normalizeUpdateSource(saved);
  }
  return defaultUpdateSource();
}

function writeUpdateSource(input: any = {}) {
  fs.mkdirSync(NET_DIR, { recursive: true });
  const next = normalizeUpdateSource({
    ...readUpdateSource(),
    ...input,
    updatedAt: nowIso(),
  });
  atomicWriteJson(UPDATE_SOURCE_FILE, next, 0o600);
  return next;
}

function publicUpdateSource(source = readUpdateSource()) {
  return {
    mode: source.mode,
    url: source.url,
    hasToken: !!source.token,
    updatedAt: source.updatedAt || null,
    sourceLabel: source.mode === 'custom' ? 'custom' : 'public',
  };
}

function updateCheckBody(source = readUpdateSource()) {
  return {
    mode: source.mode,
    url: source.url,
    token: source.token || undefined,
  };
}

module.exports = {
  STANDARD_UPDATE_URL,
  UPDATE_SOURCE_FILE,
  readUpdateSource,
  writeUpdateSource,
  publicUpdateSource,
  updateCheckBody,
};