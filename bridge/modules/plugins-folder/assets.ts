'use strict';

const fs = require('fs');
const path = require('path');
const { SLUG_RE, PLUGINS_DIRNAME } = require('./scanner');

// Whitelist by extension. Iframe content can pull in JS/CSS/img/font, so
// allow them. Everything else (executable, .env-shaped, etc.) is 404'd.
const ALLOWED_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface ResolveAssetParams {
  cwdResolved: string; // already safeResolve'd by caller
  plugin: string;
  tile?: string;
  relPath: string;
}

export interface ResolvedAsset {
  absPath: string;
  contentType: string;
}

// Resolve a request to an asset on disk and verify it stays inside the
// plugin (or specific tile) root. Throws { status, message } on rejection.
export async function resolveAsset(p: ResolveAssetParams): Promise<ResolvedAsset> {
  if (!SLUG_RE.test(p.plugin)) throw { status: 400, message: 'invalid plugin name' };
  if (p.tile != null && !SLUG_RE.test(p.tile)) throw { status: 400, message: 'invalid tile name' };
  if (!p.relPath || typeof p.relPath !== 'string') throw { status: 400, message: 'path required' };
  if (p.relPath.includes('\0')) throw { status: 400, message: 'invalid path' };

  const pluginRoot = path.join(p.cwdResolved, PLUGINS_DIRNAME, p.plugin);
  const scopeRoot = p.tile ? path.join(pluginRoot, 'tiles', p.tile) : pluginRoot;

  // Strip a leading slash if the caller sent one, then join under scope.
  const cleaned = p.relPath.replace(/^\/+/, '');
  const joined = path.join(scopeRoot, cleaned);
  // path.resolve normalizes ../ — confirm the result is still inside scopeRoot.
  const resolved = path.resolve(joined);
  const rel = path.relative(scopeRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw { status: 403, message: 'path escapes plugin root' };
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = ALLOWED_EXT[ext];
  if (!contentType) throw { status: 404, message: 'unsupported file type' };

  // Must exist and be a regular file (block symlinks pointing outside).
  let stat: any;
  try {
    stat = await fs.promises.lstat(resolved);
  } catch (_) {
    throw { status: 404, message: 'not found' };
  }
  if (stat.isSymbolicLink()) {
    // Follow once via realpath and re-confine.
    let real: string;
    try { real = await fs.promises.realpath(resolved); }
    catch (_) { throw { status: 404, message: 'not found' }; }
    const realRel = path.relative(scopeRoot, real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw { status: 403, message: 'symlink escapes plugin root' };
    }
    return { absPath: real, contentType };
  }
  if (!stat.isFile()) throw { status: 404, message: 'not a file' };

  return { absPath: resolved, contentType };
}

// CSP we set on every asset response. allow-scripts only; no
// allow-same-origin so the iframe is a null origin and can't read parent
// cookies/storage. data: + https: lets tiles fetch external charts. The
// `sandbox` token in CSP is belt-and-braces alongside the iframe's
// sandbox attribute.
export const ASSET_CSP =
  "sandbox allow-scripts; " +
  "default-src 'self' data: https:; " +
  "img-src 'self' data: https:; " +
  "script-src 'self' 'unsafe-inline' https:; " +
  "style-src 'self' 'unsafe-inline' https:; " +
  "connect-src https:; " +
  "frame-ancestors *";
