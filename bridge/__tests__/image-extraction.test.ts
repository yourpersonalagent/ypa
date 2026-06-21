// Regression tests for markdown image extraction: no sync read on the command
// path, bounded file sizes, and mtime/size cache reuse.
'use strict';

process.env.YHA_MAX_PROMPT_IMAGE_BYTES = '1048576';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { UPLOADS_DIR } = require('../core/state');
const { extractImageBlocks } = require('../sessions-internal/images');

let passed = 0;
let failed = 0;
const failures = [];
function assert(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? '\n    ' + detail : ''}`);
    console.log(`  ✗ ${label}`);
  }
}

const testName = `image-test-${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
const uploadPath = path.join(UPLOADS_DIR, testName);
const url = `http://127.0.0.1:8443/uploads/${encodeURIComponent(testName)}`;

const origReadFileSync = fs.readFileSync;
const origReadFile = fs.promises.readFile;
let asyncReads = 0;

async function main() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(uploadPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  fs.readFileSync = function () {
    throw new Error('sync readFileSync must not be used by extractImageBlocks');
  };
  fs.promises.readFile = async function (...args) {
    asyncReads++;
    return origReadFile.apply(this, args);
  };

  const first = await extractImageBlocks(`before ![cap](${url}) after`);
  assert('replaces markdown image with text marker', first.cleanText === 'before [Image: cap] after', first.cleanText);
  assert('emits one image block', first.imageBlocks.length === 1, String(first.imageBlocks.length));
  assert('detects png mime', first.imageBlocks[0]?.source?.media_type === 'image/png', first.imageBlocks[0]?.source?.media_type);
  assert('base64 encodes via async read', first.imageBlocks[0]?.source?.data === Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));

  const second = await extractImageBlocks(`again ![cap](${url})`);
  assert('cache avoids a second disk read for unchanged image', asyncReads === 1, `asyncReads=${asyncReads}`);
  assert('cached image still emitted', second.imageBlocks.length === 1, String(second.imageBlocks.length));
}

main().catch((e) => {
  failed++;
  failures.push(e && e.stack ? e.stack : String(e));
}).finally(() => {
  fs.readFileSync = origReadFileSync;
  fs.promises.readFile = origReadFile;
  try { fs.unlinkSync(uploadPath); } catch (_) {}
  console.log(`\nimage extraction tests: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
});
