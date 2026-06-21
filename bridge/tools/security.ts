// ── SSRF blocking + safe path resolution ──────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const dns = require('dns').promises;

const { BridgeInputError } = require('../core/errors');

// IPv4 ranges that must never be reachable through a server-side fetch:
// loopback, RFC1918 private, link-local (incl. cloud metadata 169.254.169.254),
// CGNAT, and the unspecified block.
const SSRF_BLOCKED_V4 = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '0.0.0.0/8',
];

// Lightweight IPv4 CIDR check — no external dependency needed. Uses >>> 0 to
// keep the 32-bit math unsigned (bitwise ops in JS are signed).
function _ip4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => ((acc << 8) + (parseInt(oct, 10) & 0xff)) >>> 0, 0) >>> 0;
}
function _ip4InCidr(ip, cidr) {
  const [range, bits] = cidr.split('/');
  const b = parseInt(bits, 10);
  const mask = b === 0 ? 0 : (~((1 << (32 - b)) - 1)) >>> 0;
  return ((_ip4ToInt(ip) & mask) >>> 0) === ((_ip4ToInt(range) & mask) >>> 0);
}

// Expand an IPv6 literal (already accepted by net.isIPv6) to its 16 octets.
// Handles :: compression, an embedded dotted-quad tail (::ffff:1.2.3.4), and a
// %zone suffix. Returns null if it can't parse (caller treats that as
// non-mapped and falls back to the prefix rules).
function _ipv6ToBytes(addr) {
  let s = String(addr);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  // A trailing dotted-quad encodes the low 32 bits; rewrite it as two hextets
  // so the rest of the parser only deals with hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.indexOf('.') !== -1) {
    if (!net.isIPv4(tail)) return null;
    const o = tail.split('.').map((n) => parseInt(n, 10) & 0xff);
    s =
      s.slice(0, lastColon + 1) +
      (((o[0] << 8) | o[1]) >>> 0).toString(16) +
      ':' +
      (((o[2] << 8) | o[3]) >>> 0).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    const v = parseInt(g || '0', 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

// If `v6` is an IPv4-mapped (::ffff:a.b.c.d) or deprecated IPv4-compatible
// (::a.b.c.d) address, return the embedded IPv4 in dotted form, else null.
// net.isIPv6 accepts the *hex* spelling of these (::ffff:7f00:1), which the
// old dotted-only regex missed; extracting the embedded v4 lets the v4 CIDR
// rules block ::ffff:127.0.0.1 / ::ffff:169.254.169.254 however they're written.
function _embeddedV4(v6) {
  const bytes = _ipv6ToBytes(v6);
  if (!bytes) return null;
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) carries the target IPv4 in
  // the low 32 bits. A fetch to [64:ff9b::7f00:1] traverses a NAT64 gateway to
  // 127.0.0.1, so the embedded v4 must face the same SSRF rules as a mapped
  // address. This sits before the ::/80 check below because byte[1]=0x64 ≠ 0.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    let rest = true;
    for (let i = 4; i < 12; i++) if (bytes[i] !== 0) { rest = false; break; }
    if (rest) return bytes.slice(12).join('.');
  }
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return null; // not in ::/80
  const mapped = bytes[10] === 0xff && bytes[11] === 0xff;
  const compat = bytes[10] === 0 && bytes[11] === 0;
  if (!mapped && !compat) return null;
  return bytes.slice(12).join('.');
}

// True when `host` is an IP literal inside a blocked range. Hostnames return
// false — the caller resolves them via assertPublicHost() first.
function isPrivateIp(host) {
  let h = String(host || '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (net.isIPv4(h)) {
    return SSRF_BLOCKED_V4.some((cidr) => _ip4InCidr(h, cidr));
  }
  if (net.isIPv6(h)) {
    // Unwrap IPv4-mapped / -compatible forms (including the hex spelling the
    // dotted-only regex used to miss) and apply the v4 rules to the embedded
    // address — otherwise ::ffff:7f00:1 (127.0.0.1) and ::ffff:a9fe:a9fe
    // (169.254.169.254 cloud metadata) pass through as "public".
    const embedded = _embeddedV4(h);
    if (embedded && net.isIPv4(embedded)) {
      return SSRF_BLOCKED_V4.some((cidr) => _ip4InCidr(embedded, cidr));
    }
    const lower = h.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
    if (/^f[cd]/.test(lower)) return true; // unique-local fc00::/7
    if (/^ff/.test(lower)) return true; // multicast ff00::/8
    return false;
  }
  return false;
}

function validateFetchUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new BridgeInputError('Invalid URL', { rawUrl });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BridgeInputError(`Blocked protocol: ${parsed.protocol}`, { protocol: parsed.protocol });
  }
  const hn = parsed.hostname.toLowerCase();
  if (hn === 'localhost' || hn.endsWith('.local') || hn.endsWith('.internal')) {
    throw new BridgeInputError(`Blocked hostname: ${parsed.hostname}`, { hostname: parsed.hostname });
  }
  if (isPrivateIp(parsed.hostname)) {
    throw new BridgeInputError(`Blocked private IP: ${parsed.hostname}`, { hostname: parsed.hostname });
  }
  return parsed.href; // normalized URL
}

// dns.lookup() has no built-in timeout — against a slow or blackholed resolver
// the promise can hang indefinitely. /v1/fetch-proxy calls assertPublicHost
// once per redirect hop, so a single bad host could leave pending lookups
// piling up and stall request handling. Bound it; on timeout we reject, which
// fails CLOSED (the host is treated as unresolvable = blocked).
const _DNS_TIMEOUT_MS = 5000;
function _lookupWithTimeout(hostname) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new BridgeInputError(`DNS resolution timed out: ${hostname}`, { hostname }));
    }, _DNS_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    dns.lookup(hostname, { all: true }).then(
      (addrs) => { if (settled) return; settled = true; clearTimeout(timer); resolve(addrs); },
      (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); }
    );
  });
}

// DNS-resolving SSRF guard. validateFetchUrl() only inspects literal hosts, so
// a name like metadata.example.com that resolves to 169.254.169.254 slips
// through. assertPublicHost resolves the name and rejects if ANY returned
// address is in a blocked range (defends against split-horizon / multi-A
// tricks). NOTE: this does not by itself stop DNS rebinding between this check
// and the eventual socket connect — callers that follow redirects must
// re-validate every hop (see /v1/fetch-proxy).
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new BridgeInputError(`Blocked private IP: ${hostname}`, { hostname });
    }
    return;
  }
  let addrs;
  try {
    addrs = await _lookupWithTimeout(hostname);
  } catch (e) {
    if (e instanceof BridgeInputError) throw e; // propagate the timeout reason
    throw new BridgeInputError(`DNS resolution failed: ${hostname}`, { hostname });
  }
  if (!addrs || !addrs.length) {
    throw new BridgeInputError(`No addresses for host: ${hostname}`, { hostname });
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new BridgeInputError(
        `Blocked: ${hostname} resolves to private IP ${a.address}`,
        { hostname, address: a.address }
      );
    }
  }
}

// Full async SSRF validation: literal checks + DNS resolution. Returns the
// normalized URL on success.
async function validateFetchUrlResolved(rawUrl) {
  const href = validateFetchUrl(rawUrl);
  await assertPublicHost(new URL(href).hostname);
  return href;
}

// Resolve a hostname to ONE validated public IP for the caller to PIN the
// socket to. Returns { address, family }. Fails closed if the host is
// missing, unresolvable, or ANY resolved address is in a blocked range
// (same multi-A defense as assertPublicHost).
//
// Why pin: assertPublicHost/validateFetchUrlResolved resolve the name and
// approve it, but a plain fetch() then resolves the name AGAIN at connect
// time. A hostile resolver can answer "public" for our check and "private"
// (169.254.169.254, 127.0.0.1, …) for the connect — a DNS-rebind TOCTOU.
// Connecting straight to the IP we validated removes that second lookup.
async function resolvePinnedAddress(hostname) {
  const hn = String(hostname || '');
  if (net.isIP(hn)) {
    if (isPrivateIp(hn)) {
      throw new BridgeInputError(`Blocked private IP: ${hn}`, { hostname: hn });
    }
    return { address: hn, family: net.isIPv6(hn) ? 6 : 4 };
  }
  let addrs;
  try {
    addrs = await _lookupWithTimeout(hn);
  } catch (e) {
    if (e instanceof BridgeInputError) throw e; // propagate the timeout reason
    throw new BridgeInputError(`DNS resolution failed: ${hn}`, { hostname: hn });
  }
  if (!addrs || !addrs.length) {
    throw new BridgeInputError(`No addresses for host: ${hn}`, { hostname: hn });
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new BridgeInputError(`Blocked: ${hn} resolves to private IP ${a.address}`, {
        hostname: hn,
        address: a.address,
      });
    }
  }
  const first = addrs[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

// Single-hop GET pinned to a pre-validated IP. Deliberately does NOT follow
// redirects — the caller re-validates every hop (see WebFetch) so a 3xx to
// 169.254.169.254 or a DNS-rebound private host can't be chased blindly. The
// socket is pinned to `ip`/`family` via the `lookup` hook so there is no second
// DNS resolution after resolvePinnedAddress approved the name (defeats the
// rebind TOCTOU), while Host + TLS servername stay set to the real hostname so
// vhosts and certificate verification still work. Body streaming stops after
// opts.maxBytes (default 1 MiB). Resolves { statusCode, headers, body (Buffer),
// truncated }. HTTPS keeps cert validation ON — this is for public fetches.
function pinnedGet(urlStr, ip, family, opts = {}) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;
  const maxBytes = opts.maxBytes || 1024 * 1024;
  const timeoutMs = opts.timeoutMs || 15000;
  const headers = Object.assign({ 'User-Agent': 'YHA-Bridge/1.0' }, opts.headers || {});
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
    const req = lib.request(
      {
        protocol: u.protocol,
        host: u.hostname, // drives the Host header + (for TLS) the SNI below
        servername: isHttps ? u.hostname : undefined,
        port: u.port || (isHttps ? 443 : 80),
        path: (u.pathname || '/') + u.search,
        method: 'GET',
        headers,
        // Pin to the validated address; never resolve the name a second time.
        lookup: (_h, _o, cb) => cb(null, ip, family),
      },
      (res) => {
        // Early-out on an honest oversized Content-Length to avoid streaming a
        // body we'd only discard. A lying/absent CL is still capped below.
        const cl = Number(res.headers['content-length'] || 0);
        if (cl && cl > maxBytes) {
          res.destroy();
          finish(resolve, { statusCode: res.statusCode, headers: res.headers, body: Buffer.alloc(0), truncated: true });
          return;
        }
        const chunks = [];
        let total = 0;
        let truncated = false;
        res.on('data', (c) => {
          if (truncated) return;
          total += c.length;
          if (total > maxBytes) {
            truncated = true;
            const keep = c.length - (total - maxBytes);
            if (keep > 0) chunks.push(c.subarray(0, keep));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const done = () => finish(resolve, {
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          truncated,
        });
        res.on('end', done);
        res.on('close', done);
        res.on('error', (e) => finish(reject, e));
      }
    );
    req.on('error', (e) => finish(reject, e));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`fetch timed out after ${timeoutMs}ms`)));
    req.end();
  });
}

// JS counterpart of go-core's canonicalizePath. Resolve `abs` to where the OS
// would actually act, following symlinks at every component — including
// dangling ones that fs.realpathSync refuses to resolve — so a symlink inside
// cwd cannot redirect a Read/Write/Edit outside it. The non-existent tail of a
// Write target is reattached lexically. Bounded against dangling-link loops.
const _MAX_SYMLINK_DEPTH = 40;
function _canonicalizePath(abs, depth) {
  if (depth > _MAX_SYMLINK_DEPTH) {
    throw new BridgeInputError('Symlink resolution too deep', { path: abs });
  }
  // Fast path: the whole path exists — realpath resolves every link and throws
  // (non-ENOENT) on loops/ENOTDIR in the existing portion, which fails closed.
  try {
    return fs.realpathSync(abs);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  // abs doesn't fully exist. If abs itself is a (dangling) symlink, follow it.
  let st = null;
  try {
    st = fs.lstatSync(abs);
  } catch (_) {
    st = null;
  }
  if (st && st.isSymbolicLink()) {
    const target = fs.readlinkSync(abs);
    // path.resolve anchors an absolute or driveless-rooted (Windows "\etc")
    // target to a drive the same way the OS does, and a relative target to the
    // link's directory.
    const next = path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(path.dirname(abs), target);
    return _canonicalizePath(next, depth + 1);
  }
  // Non-existent, non-symlink leaf: resolve the parent (which may itself be or
  // sit behind a dangling symlink) and reattach the basename.
  const parent = path.dirname(abs);
  if (parent === abs) return abs; // reached the root
  return path.join(_canonicalizePath(parent, depth + 1), path.basename(abs));
}

function resolveSafePath(rawPath, cwd) {
  // Fail closed: without a working directory we cannot confine the path. The
  // old code used `path.parse(resolved).root` as the safe-base when cwd was
  // falsy — i.e. the filesystem root — which silently disabled confinement and
  // let any absolute path through (e.g. /etc/shadow). A missing cwd means the
  // tool was invoked outside a session context; deny rather than expose the
  // whole filesystem. (getSessionCwd always returns workingDir||homedir, so
  // this never fires on the normal Read/Write/Edit path — it is a backstop.)
  const base = typeof cwd === 'string' ? cwd.trim() : '';
  if (!base) {
    throw new BridgeInputError(
      'Refusing file access: no working directory is set for this call',
      { rawPath }
    );
  }
  let fp = !path.isAbsolute(rawPath) ? path.join(base, rawPath) : rawPath;
  // Remap stale /workspace prefix that models hallucinate from training data
  if (fp.startsWith('/workspace/') && !fs.existsSync('/workspace')) {
    fp = path.join(base, fp.slice('/workspace/'.length));
  }
  const resolved = path.resolve(fp);
  // Guard: the resolved path must reside under the resolved cwd. This prevents
  // ../../../etc/shadow traversal and absolute-path escapes.
  const safeBase = path.resolve(base);
  if (!resolved.startsWith(safeBase + path.sep) && resolved !== safeBase) {
    throw new BridgeInputError(
      `Path traversal blocked: "${resolved}" is outside allowed directory "${safeBase}"`,
      { resolved, safeBase }
    );
  }
  // The lexical guard above stops ../ traversal and absolute escapes, but
  // path.resolve never follows symlinks — so a symlink *inside* cwd (cwd/link
  // -> /etc, then read link/shadow) still escapes. Canonicalise both sides
  // (resolving links, including dangling ones) and re-confine. Resolving the
  // base too keeps the comparison realpath-vs-realpath and normalises Windows
  // drive-letter casing that fs.realpathSync rewrites to the on-disk form.
  let canonicalBase;
  let finalPath;
  try {
    canonicalBase = _canonicalizePath(safeBase, 0);
    finalPath = _canonicalizePath(resolved, 0);
  } catch (e) {
    if (e instanceof BridgeInputError) throw e;
    throw new BridgeInputError('Cannot resolve path symlinks', { rawPath });
  }
  if (finalPath !== canonicalBase && !finalPath.startsWith(canonicalBase + path.sep)) {
    throw new BridgeInputError(
      `Path traversal blocked: "${finalPath}" is outside allowed directory "${canonicalBase}"`,
      { resolved: finalPath, safeBase: canonicalBase }
    );
  }
  return finalPath;
}

module.exports = {
  isPrivateIp,
  validateFetchUrl,
  assertPublicHost,
  validateFetchUrlResolved,
  resolvePinnedAddress,
  pinnedGet,
  resolveSafePath,
};
