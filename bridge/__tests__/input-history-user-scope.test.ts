// Stand-alone regression test for chat-extras input history storage.
// Verifies /v1/input-history writes per active user under bridge/users/<email>/
// and never recreates the legacy bridge/input-history.json global file.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const canonicalEmail = `yha-input-history-${stamp}@example.com`;
const aliasEmail = `yha-input-history-alias-${stamp}@example.com`;
const directEmail = `yha-input-history-direct-${stamp}@example.com`;
const localEmail = 'local@localhost.test';
process.env.ALLOWED_EMAILS = `{${canonicalEmail};${aliasEmail}}`;

const resolver = require('../users/resolver');
const PATHS = require('../core/paths');
const { registerInputHistoryRoutes } = require('../modules/chat-extras/input-history');

const legacyFile = path.join(PATHS.bridgeRoot, 'input-history.json');
const legacyBackup = path.join(PATHS.bridgeRoot, `input-history.json.__testbak_${stamp}`);
const touchedDirs = new Set([
  resolver.userDir(canonicalEmail),
  resolver.userDir(directEmail),
]);
const localDir = resolver.userDir(localEmail);
const localExisted = fs.existsSync(localDir);
if (!localExisted) touchedDirs.add(localDir);

let passed = 0;
let failed = 0;
const failures: string[] = [];
let server: any;

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? '\n    ' + detail : ''}`);
    console.log(`  ✗ ${label}`);
  }
}

function assertEq(label: string, actual: any, expected: any) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(label, a === e, `expected ${e}, got ${a}`);
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function request(method: string, urlPath: string, opts: { body?: any; user?: string } = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const headers: any = {};
    if (opts.user) headers['x-test-user'] = opts.user;
    let bodyBuf: Buffer | null = null;
    if (opts.body !== undefined) {
      bodyBuf = Buffer.from(JSON.stringify(opts.body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(bodyBuf.length);
    }
    const req = http.request(
      {
        method,
        hostname: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk.toString('utf8'); });
        res.on('end', () => {
          let body: any = null;
          try { body = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode || 0, body, raw });
        });
      },
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function main() {
  if (fs.existsSync(legacyFile)) fs.renameSync(legacyFile, legacyBackup);
  fs.writeFileSync(legacyFile, JSON.stringify({ history: ['legacy seed'] }, null, 2));

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    const email = String(req.headers['x-test-user'] || '');
    if (email) req.session = { user: { email } };
    next();
  });
  registerInputHistoryRoutes(app);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const postAlias = await request('POST', '/v1/input-history', { user: aliasEmail, body: { text: 'hello from alias' } });
  assertEq('POST alias status', postAlias.status, 200);
  assertEq('POST alias merges legacy seed once', postAlias.body.history, ['hello from alias', 'legacy seed']);

  const canonicalFile = resolver.userPath('input-history', canonicalEmail);
  assert('alias writes canonical per-user file', fs.existsSync(canonicalFile), canonicalFile);
  assertEq('canonical file contents', readJson(canonicalFile).history, ['hello from alias', 'legacy seed']);
  assertEq('legacy root file remains a seed only', readJson(legacyFile).history, ['legacy seed']);

  const getCanonical = await request('GET', '/v1/input-history', { user: canonicalEmail });
  assertEq('GET canonical reads canonical user file', getCanonical.body.history, ['hello from alias', 'legacy seed']);

  process.env.ALLOWED_EMAILS = '';
  const postDirect = await request('POST', '/v1/input-history', { user: directEmail, body: { text: 'direct user text' } });
  assertEq('POST direct status', postDirect.status, 200);
  assert('direct active user writes direct per-user file', fs.existsSync(resolver.userPath('input-history', directEmail)));

  const postLocal = await request('POST', '/v1/input-history', { body: { text: 'local dev text' } });
  assertEq('POST no-auth local status', postLocal.status, 200);
  assert('no-auth fallback writes bridge/users/local@localhost.test', fs.existsSync(resolver.userPath('input-history', localEmail)));
  assertEq('legacy root still not overwritten by no-auth fallback', readJson(legacyFile).history, ['legacy seed']);
}

function cleanup() {
  try { if (server) server.close(); } catch (_) {}
  for (const dir of touchedDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  try { fs.rmSync(legacyFile, { force: true }); } catch (_) {}
  if (fs.existsSync(legacyBackup)) fs.renameSync(legacyBackup, legacyFile);
}

main()
  .catch((e) => {
    failed++;
    failures.push(e?.stack || String(e));
  })
  .finally(() => {
    cleanup();
    if (failures.length) {
      console.error('\nFailures:');
      for (const f of failures) console.error(' - ' + f);
    }
    console.log(`\ninput-history user-scope: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
