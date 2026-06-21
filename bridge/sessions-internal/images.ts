// ── Image MIME mapping, URL resolution, markdown image extraction ─────────────
'use strict';

const fs = require('fs');
const path = require('path');

const { UPLOADS_DIR } = require('../core/state');
const logger = require('../core/logger');

const IMAGE_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = (() => {
  const raw = Number(process.env.YHA_MAX_PROMPT_IMAGE_BYTES || '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_IMAGE_BYTES;
})();
const IMAGE_CACHE_MAX_ENTRIES = 16;
const imageCache = new Map();

function _cacheKey(localPath, stat) {
  return `${localPath}:${stat.size}:${stat.mtimeMs}`;
}

function _rememberImage(key, value) {
  imageCache.set(key, value);
  if (imageCache.size <= IMAGE_CACHE_MAX_ENTRIES) return;
  const oldest = imageCache.keys().next().value;
  if (oldest) imageCache.delete(oldest);
}

function resolveLocalImageUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith('/uploads/')) return null;
    const rel = parsed.pathname.replace(/^\/uploads\//, '');
    const localPath = path.join(UPLOADS_DIR, rel);
    if (!path.resolve(localPath).startsWith(path.resolve(UPLOADS_DIR))) return null;
    return localPath;
  } catch (_) {
    // Direct absolute server path (from server file browser image attach)
    // Validate against UPLOADS_DIR and HOME — !includes('..') is bypassable, use resolve+prefix check
    if (url.startsWith('/')) {
      const resolved = path.resolve(url);
      const HOME = process.env.HOME || process.env.USERPROFILE || require('os').homedir();
      if (resolved.startsWith(path.resolve(UPLOADS_DIR)) || resolved.startsWith(HOME + path.sep)) {
        return resolved;
      }
    }
    return null;
  }
}

// Parse ![alt](url) markdown in text. Local upload URLs → Anthropic image blocks.
// Returns { cleanText, imageBlocks: [{type:'image', source:{type:'base64',...}}] }
async function extractImageBlocks(text) {
  const imageBlocks = [];
  let cleanText = '';
  let cursor = 0;
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [match, alt, url] = m;
    cleanText += text.slice(cursor, m.index);
    cursor = m.index + match.length;
    const localPath = resolveLocalImageUrl(url);
    if (!localPath) {
      cleanText += match;
      continue;
    }
    try {
      const stat = await fs.promises.stat(localPath);
      if (!stat.isFile()) throw new Error('not a file');
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(`image too large (${stat.size} bytes > ${MAX_IMAGE_BYTES} byte cap)`);
      }
      const ext = path.extname(localPath).slice(1).toLowerCase();
      const mimeType = IMAGE_MIME[ext] || 'image/jpeg';
      const key = _cacheKey(localPath, stat);
      let cached = imageCache.get(key);
      if (!cached) {
        const data = await fs.promises.readFile(localPath);
        cached = { media_type: mimeType, data: data.toString('base64') };
        _rememberImage(key, cached);
      }
      imageBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: cached.media_type, data: cached.data },
      });
      cleanText += alt ? `[Image: ${alt}]` : '[Image]';
    } catch (e) {
      logger.warn('image.read-failed', { path: localPath, error: e instanceof Error ? e.message : String(e) });
      cleanText += match;
    }
  }
  cleanText += text.slice(cursor);
  return { cleanText, imageBlocks };
}
module.exports = {
  IMAGE_MIME,
  resolveLocalImageUrl,
  extractImageBlocks,
};
