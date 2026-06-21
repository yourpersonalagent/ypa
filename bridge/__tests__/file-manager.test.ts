// File-manager smoke tests. Stand-alone so the bridge doesn't need a test
// runner — invoke with `tsx bridge/__tests__/file-manager.test.ts`.
//
// Spins up a tiny express app with the file-manager routes mounted, points
// HOME at a tmp dir so the confine check passes, and exercises every route
// end-to-end against real fs operations. Exit code is 0 on pass / 1 on fail.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

// Re-route HOME before the route module reads it. server-file-manager.ts
// reads process.env.HOME at request time (not module load) so this is enough.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'yha-fm-test-'));
process.env.HOME = sandbox;

const { registerFileManagerRoutes } = require('../modules/files-manager/lib');

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEq(label: string, actual: any, expected: any) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`);
    console.log(`  ✗ ${label}`);
  }
}
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

// HTTP helper with promise-based response collection.
function request(method: string, urlPath: string, opts: { body?: any; binaryBody?: Buffer; contentType?: string } = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL('http://localhost' + urlPath);
    const headers: any = {};
    let bodyBuf: Buffer | null = null;
    if (opts.body !== undefined) {
      bodyBuf = Buffer.from(JSON.stringify(opts.body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(bodyBuf.length);
    } else if (opts.binaryBody) {
      bodyBuf = opts.binaryBody;
      headers['Content-Type'] = opts.contentType || 'application/octet-stream';
      headers['Content-Length'] = String(bodyBuf.length);
    }
    const req = http.request({
      method,
      hostname: 'localhost',
      port: (server.address() as any).port,
      path: u.pathname + u.search,
      headers,
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      res.on('end', () => {
        let body: any = null;
        try { body = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode || 0, body, raw });
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Boot a tiny express app with just the file-manager routes ────────────────

const app = express();
app.use(express.json({ limit: '5mb' }));
registerFileManagerRoutes(app);
const server = http.createServer(app);

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run() {
  await new Promise<void>((r) => server.listen(0, () => r()));
  console.log(`\nFileManager smoke tests — sandbox: ${sandbox}\n`);

  // ── 1. mkdir ────────────────────────────────────────────────────────────────
  console.log('mkdir');
  {
    const r = await request('POST', '/v1/files/mkdir', { body: { path: path.join(sandbox, 'project') } });
    assertEq('creates a directory', r.status, 200);
    assert('returns success', r.body?.success === true);
    assert('directory exists on disk', fs.existsSync(path.join(sandbox, 'project')));
  }
  {
    const r = await request('POST', '/v1/files/mkdir', { body: { path: path.join(sandbox, 'project') } });
    assertEq('409 when dir already exists (recursive=false)', r.status, 409);
  }
  {
    const r = await request('POST', '/v1/files/mkdir', { body: { path: path.join(sandbox, 'project'), recursive: true } });
    assertEq('200 when dir exists with recursive=true', r.status, 200);
  }
  {
    const r = await request('POST', '/v1/files/mkdir', { body: { path: '/etc/yha-evil-dir' } });
    assertEq('403 outside HOME', r.status, 403);
  }

  // ── 2. upload-binary ───────────────────────────────────────────────────────
  console.log('upload-binary');
  {
    const data = Buffer.from('hello world');
    const dst = path.join(sandbox, 'project', 'hello.txt');
    const r = await request('POST', `/v1/files/upload-binary?path=${encodeURIComponent(dst)}`, { binaryBody: data });
    assertEq('uploads and writes file', r.status, 200);
    assert('file matches input', fs.readFileSync(dst, 'utf8') === 'hello world');
  }
  {
    const r = await request('POST', `/v1/files/upload-binary?path=${encodeURIComponent(path.join(sandbox, 'project', 'hello.txt'))}`, { binaryBody: Buffer.from('replacement') });
    assertEq('409 when file exists without overwrite', r.status, 409);
  }
  {
    const r = await request('POST', `/v1/files/upload-binary?path=${encodeURIComponent(path.join(sandbox, 'project', 'hello.txt'))}&overwrite=1`, { binaryBody: Buffer.from('replacement') });
    assertEq('overwrite=1 replaces', r.status, 200);
    assert('file content overwritten', fs.readFileSync(path.join(sandbox, 'project', 'hello.txt'), 'utf8') === 'replacement');
  }
  {
    const r = await request('POST', '/v1/files/upload-binary?path=' + encodeURIComponent(path.join(sandbox, 'foo.txt')), { body: { hi: 1 } });
    assertEq('rejects application/json content-type', r.status, 400);
  }

  // ── 3. rename ──────────────────────────────────────────────────────────────
  console.log('rename');
  {
    fs.writeFileSync(path.join(sandbox, 'project', 'old.txt'), 'data');
    const r = await request('POST', '/v1/files/rename', { body: { from: path.join(sandbox, 'project', 'old.txt'), to: path.join(sandbox, 'project', 'new.txt') } });
    assertEq('renames file', r.status, 200);
    assert('source gone', !fs.existsSync(path.join(sandbox, 'project', 'old.txt')));
    assert('target exists', fs.existsSync(path.join(sandbox, 'project', 'new.txt')));
  }
  {
    fs.writeFileSync(path.join(sandbox, 'project', 'a.txt'), '1');
    fs.writeFileSync(path.join(sandbox, 'project', 'b.txt'), '2');
    const r = await request('POST', '/v1/files/rename', { body: { from: path.join(sandbox, 'project', 'a.txt'), to: path.join(sandbox, 'project', 'b.txt') } });
    assertEq('409 when target exists', r.status, 409);
  }

  // ── 4. move ────────────────────────────────────────────────────────────────
  console.log('move');
  {
    fs.mkdirSync(path.join(sandbox, 'project', 'dest'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'project', 'm1.txt'), 'aa');
    fs.writeFileSync(path.join(sandbox, 'project', 'm2.txt'), 'bb');
    const r = await request('POST', '/v1/files/move', {
      body: {
        items: [path.join(sandbox, 'project', 'm1.txt'), path.join(sandbox, 'project', 'm2.txt')],
        destDir: path.join(sandbox, 'project', 'dest'),
      },
    });
    assertEq('moves multiple', r.status, 200);
    assert('two results', r.body.results.length === 2);
    assert('items in dest', fs.existsSync(path.join(sandbox, 'project', 'dest', 'm1.txt')) && fs.existsSync(path.join(sandbox, 'project', 'dest', 'm2.txt')));
  }
  {
    fs.writeFileSync(path.join(sandbox, 'project', 'dup.txt'), 'X');
    fs.writeFileSync(path.join(sandbox, 'project', 'dest', 'dup.txt'), 'Y');
    const r = await request('POST', '/v1/files/move', {
      body: {
        items: [path.join(sandbox, 'project', 'dup.txt')],
        destDir: path.join(sandbox, 'project', 'dest'),
        conflict: 'rename',
      },
    });
    assertEq('rename conflict policy moves with new name', r.status, 200);
    assert('original target preserved', fs.readFileSync(path.join(sandbox, 'project', 'dest', 'dup.txt'), 'utf8') === 'Y');
    assert('renamed copy exists', fs.existsSync(path.join(sandbox, 'project', 'dest', 'dup (1).txt')));
  }
  {
    fs.writeFileSync(path.join(sandbox, 'project', 'overwrite.txt'), 'NEW');
    fs.writeFileSync(path.join(sandbox, 'project', 'dest', 'overwrite.txt'), 'OLD');
    const r = await request('POST', '/v1/files/move', {
      body: {
        items: [path.join(sandbox, 'project', 'overwrite.txt')],
        destDir: path.join(sandbox, 'project', 'dest'),
        conflict: 'overwrite',
      },
    });
    assertEq('overwrite conflict policy ok', r.status, 200);
    assert('target replaced', fs.readFileSync(path.join(sandbox, 'project', 'dest', 'overwrite.txt'), 'utf8') === 'NEW');
  }
  {
    fs.writeFileSync(path.join(sandbox, 'project', 'skip.txt'), 'SRC');
    fs.writeFileSync(path.join(sandbox, 'project', 'dest', 'skip.txt'), 'DST');
    const r = await request('POST', '/v1/files/move', {
      body: {
        items: [path.join(sandbox, 'project', 'skip.txt')],
        destDir: path.join(sandbox, 'project', 'dest'),
        conflict: 'skip',
      },
    });
    assertEq('skip conflict policy ok', r.status, 200);
    assert('source still there', fs.existsSync(path.join(sandbox, 'project', 'skip.txt')));
    assert('target untouched', fs.readFileSync(path.join(sandbox, 'project', 'dest', 'skip.txt'), 'utf8') === 'DST');
    assert('result marks skipped', !!r.body.results[0].skipped);
  }

  // ── 5. copy ────────────────────────────────────────────────────────────────
  console.log('copy');
  {
    fs.mkdirSync(path.join(sandbox, 'project', 'src'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'project', 'src', 'c1.txt'), 'c1');
    fs.mkdirSync(path.join(sandbox, 'project', 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'project', 'src', 'sub', 'c2.txt'), 'c2');
    const r = await request('POST', '/v1/files/copy', {
      body: {
        items: [path.join(sandbox, 'project', 'src')],
        destDir: path.join(sandbox, 'project', 'dest'),
      },
    });
    assertEq('copies recursively', r.status, 200);
    assert('source preserved', fs.existsSync(path.join(sandbox, 'project', 'src', 'c1.txt')));
    assert('dest tree exists', fs.existsSync(path.join(sandbox, 'project', 'dest', 'src', 'sub', 'c2.txt')));
  }

  // ── 6. trash + untrash + empty-trash ───────────────────────────────────────
  console.log('trash');
  {
    fs.writeFileSync(path.join(sandbox, 'project', 'doomed.txt'), 'gone');
    const r = await request('POST', '/v1/files/trash', { body: { items: [path.join(sandbox, 'project', 'doomed.txt')] } });
    assertEq('trashes file', r.status, 200);
    assert('source gone', !fs.existsSync(path.join(sandbox, 'project', 'doomed.txt')));
    assert('trashId returned', typeof r.body.trashId === 'string' && r.body.trashId.length > 0);
    const trashDir = path.join(sandbox, '.trash');
    assert('trash dir created at host root', fs.existsSync(trashDir));
    assert('trash index written', fs.existsSync(path.join(trashDir, 'index.json')));

    // Untrash by trashId
    const u = await request('POST', '/v1/files/untrash', { body: { trashId: r.body.trashId } });
    assertEq('untrash restores', u.status, 200);
    assert('file back in original location', fs.existsSync(path.join(sandbox, 'project', 'doomed.txt')));
    assert('trash group dir gone', !fs.existsSync(path.join(trashDir, r.body.trashId)));
  }
  {
    fs.writeFileSync(path.join(sandbox, 'project', 'doomed2.txt'), 'gone');
    const r = await request('POST', '/v1/files/trash', { body: { items: [path.join(sandbox, 'project', 'doomed2.txt')] } });
    assertEq('trashes second file', r.status, 200);
    const e = await request('POST', '/v1/files/empty-trash', { body: { hostDir: sandbox } });
    assertEq('empty-trash ok', e.status, 200);
    assert('trash dir gone', !fs.existsSync(path.join(sandbox, '.trash')));
  }

  // ── 7. disk-usage ──────────────────────────────────────────────────────────
  console.log('disk-usage');
  {
    fs.writeFileSync(path.join(sandbox, 'project', 'sized.txt'), 'x'.repeat(1234));
    const r = await request('GET', `/v1/files/disk-usage?path=${encodeURIComponent(path.join(sandbox, 'project', 'sized.txt'))}`);
    assertEq('returns ok', r.status, 200);
    assertEq('reports correct size', r.body.totalBytes, 1234);
    assertEq('one file', r.body.fileCount, 1);
  }

  // ── 8. zip / unzip ─────────────────────────────────────────────────────────
  // Round-trip: zip a small folder, verify the archive file exists and is
  // non-empty; unzip it into a separate destination and check the contents
  // match the source. The actual archive byte-format is left to the system
  // `zip`/`unzip` binaries — we only assert the wrapper does the right thing
  // around them (path confine, conflict policy, hidden-exclude).
  console.log('zip/unzip');
  {
    fs.mkdirSync(path.join(sandbox, 'project', 'zipsrc'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'project', 'zipsrc', 'a.txt'), 'A-content');
    fs.mkdirSync(path.join(sandbox, 'project', 'zipsrc', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'project', 'zipsrc', 'sub', 'b.txt'), 'B-content');
    fs.mkdirSync(path.join(sandbox, 'project', 'zipsrc', 'node_modules', 'evil'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'project', 'zipsrc', 'node_modules', 'evil', 'pkg.json'), '{}');

    const archivePath = path.join(sandbox, 'project', 'zipsrc.zip');
    const r = await request('POST', '/v1/files/zip', {
      body: {
        items: [path.join(sandbox, 'project', 'zipsrc')],
        archivePath,
      },
    });
    assertEq('zip ok', r.status, 200);
    assert('archive exists on disk', fs.existsSync(archivePath));
    assert('archive non-empty', fs.statSync(archivePath).size > 0);
    assert('size returned', typeof r.body?.size === 'number' && r.body.size > 0);
  }
  {
    // Conflict: archive already exists, no overwrite → 409
    const archivePath = path.join(sandbox, 'project', 'zipsrc.zip');
    const r = await request('POST', '/v1/files/zip', {
      body: {
        items: [path.join(sandbox, 'project', 'zipsrc')],
        archivePath,
      },
    });
    assertEq('409 when archive exists without overwrite', r.status, 409);
  }
  {
    // overwrite=true succeeds and replaces
    const archivePath = path.join(sandbox, 'project', 'zipsrc.zip');
    const r = await request('POST', '/v1/files/zip', {
      body: {
        items: [path.join(sandbox, 'project', 'zipsrc')],
        archivePath,
        overwrite: true,
      },
    });
    assertEq('zip overwrite ok', r.status, 200);
  }
  {
    // archivePath must end in .zip
    const r = await request('POST', '/v1/files/zip', {
      body: {
        items: [path.join(sandbox, 'project', 'zipsrc')],
        archivePath: path.join(sandbox, 'project', 'foo.tar'),
      },
    });
    assertEq('rejects non-zip archivePath', r.status, 400);
  }
  {
    // outside HOME → 403
    const r = await request('POST', '/v1/files/zip', {
      body: {
        items: [path.join(sandbox, 'project', 'zipsrc')],
        archivePath: '/tmp/yha-evil.zip',
      },
    });
    assertEq('403 archivePath outside HOME', r.status, 403);
  }
  {
    // unzip into a fresh dir
    const archivePath = path.join(sandbox, 'project', 'zipsrc.zip');
    const destDir = path.join(sandbox, 'project', 'unpacked');
    const r = await request('POST', '/v1/files/unzip', {
      body: { archivePath, destDir },
    });
    assertEq('unzip ok', r.status, 200);
    assert('extracted top entry exists', fs.existsSync(path.join(destDir, 'zipsrc', 'a.txt')));
    assert('extracted nested entry exists', fs.existsSync(path.join(destDir, 'zipsrc', 'sub', 'b.txt')));
    assert('extracted top entry content matches', fs.readFileSync(path.join(destDir, 'zipsrc', 'a.txt'), 'utf8') === 'A-content');
    assert('node_modules excluded by default', !fs.existsSync(path.join(destDir, 'zipsrc', 'node_modules')));
    assert('destDir returned', typeof r.body?.destDir === 'string' && r.body.destDir.endsWith('unpacked'));
  }
  {
    // excludeHidden=false should keep node_modules
    const archivePath = path.join(sandbox, 'project', 'zipsrc-with-hidden.zip');
    const zr = await request('POST', '/v1/files/zip', {
      body: {
        items: [path.join(sandbox, 'project', 'zipsrc')],
        archivePath,
        excludeHidden: false,
      },
    });
    assertEq('zip excludeHidden=false ok', zr.status, 200);
    const destDir = path.join(sandbox, 'project', 'unpacked-hidden');
    const ur = await request('POST', '/v1/files/unzip', {
      body: { archivePath, destDir },
    });
    assertEq('unzip ok', ur.status, 200);
    assert('node_modules included when excludeHidden=false', fs.existsSync(path.join(destDir, 'zipsrc', 'node_modules', 'evil', 'pkg.json')));
  }
  {
    // unzip default refuses to overwrite (-n)
    const archivePath = path.join(sandbox, 'project', 'zipsrc.zip');
    const destDir = path.join(sandbox, 'project', 'unpacked');
    fs.writeFileSync(path.join(destDir, 'zipsrc', 'a.txt'), 'MUTATED');
    const r = await request('POST', '/v1/files/unzip', {
      body: { archivePath, destDir },
    });
    assertEq('unzip -n still ok (200) but file is preserved', r.status, 200);
    assert('existing file not overwritten by default', fs.readFileSync(path.join(destDir, 'zipsrc', 'a.txt'), 'utf8') === 'MUTATED');
  }
  {
    // unzip with overwrite=true does replace
    const archivePath = path.join(sandbox, 'project', 'zipsrc.zip');
    const destDir = path.join(sandbox, 'project', 'unpacked');
    const r = await request('POST', '/v1/files/unzip', {
      body: { archivePath, destDir, overwrite: true },
    });
    assertEq('unzip overwrite ok', r.status, 200);
    assert('file overwritten', fs.readFileSync(path.join(destDir, 'zipsrc', 'a.txt'), 'utf8') === 'A-content');
  }
  {
    // unzip rejects missing archive
    const r = await request('POST', '/v1/files/unzip', {
      body: { archivePath: path.join(sandbox, 'project', 'nope.zip'), destDir: path.join(sandbox, 'project', 'unp') },
    });
    assertEq('404 missing archive', r.status, 404);
  }

  // ── 9. list-trash ──────────────────────────────────────────────────────────
  console.log('list-trash');
  {
    fs.writeFileSync(path.join(sandbox, 'project', 'lt.txt'), '1');
    await request('POST', '/v1/files/trash', { body: { items: [path.join(sandbox, 'project', 'lt.txt')] } });
    const r = await request('GET', `/v1/files/list-trash?hostDir=${encodeURIComponent(sandbox)}`);
    assertEq('lists trash groups', r.status, 200);
    assert('one group', Array.isArray(r.body.groups) && r.body.groups.length === 1);
  }

  // ── Wrap up ────────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:\n');
    for (const f of failures) console.log('  ' + f + '\n');
  }
  // Cleanup
  fs.rmSync(sandbox, { recursive: true, force: true });
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Test runner crashed:', e);
  fs.rmSync(sandbox, { recursive: true, force: true });
  server.close();
  process.exit(1);
});
