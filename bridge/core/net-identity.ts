'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const PATHS = require('./paths');

const NET_DIR = path.join(PATHS.dataRoot, 'net');
const NODE_FILE = path.join(NET_DIR, 'node.json');

function nowIso() { return new Date().toISOString(); }

function ensureNetDir() {
  fs.mkdirSync(NET_DIR, { recursive: true });
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function nodeId() {
  return `node_${b64url(crypto.randomBytes(16))}`;
}

function safeHostname() {
  try { return os.hostname() || ''; } catch { return ''; }
}

function defaultLabel() {
  return process.env.YHA_NODE_LABEL || process.env.YPA_NODE_LABEL || process.env.YPA_APP_NAME || safeHostname() || 'YPA Node';
}

function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  return {
    publicKey: `ed25519:${Buffer.from(pubDer).toString('base64')}`,
    privateKey: `ed25519-pkcs8:${Buffer.from(privDer).toString('base64')}`,
  };
}

function privateKeyObject(node = getNodeIdentity()) {
  const raw = String(node.privateKey || '');
  if (!raw.startsWith('ed25519-pkcs8:')) throw new Error('Unsupported node private key format.');
  return crypto.createPrivateKey({
    key: Buffer.from(raw.slice('ed25519-pkcs8:'.length), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

function publicKeyObject(publicKey) {
  const raw = String(publicKey || '');
  if (!raw.startsWith('ed25519:')) throw new Error('Unsupported node public key format.');
  return crypto.createPublicKey({
    key: Buffer.from(raw.slice('ed25519:'.length), 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function sha256Hex(input = '') {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function peerSignatureBase({ method, path, bodyHash, timestamp, nonce, networkId }) {
  return [
    String(method || 'GET').toUpperCase(),
    String(path || '/'),
    String(bodyHash || sha256Hex('')),
    String(timestamp || ''),
    String(nonce || ''),
    String(networkId || ''),
  ].join('\n');
}

function signPeerRequest({ method = 'GET', path = '/', networkId, body = '' }) {
  const node = getNodeIdentity();
  const timestamp = nowIso();
  const nonce = b64url(crypto.randomBytes(16));
  const bodyHash = sha256Hex(body || '');
  const base = peerSignatureBase({ method, path, bodyHash, timestamp, nonce, networkId });
  const sig = crypto.sign(null, Buffer.from(base), privateKeyObject(node)).toString('base64');
  return {
    'X-YHA-Node': node.id,
    'X-YHA-Network': String(networkId || ''),
    'X-YHA-Timestamp': timestamp,
    'X-YHA-Nonce': nonce,
    'X-YHA-Body-SHA256': bodyHash,
    'X-YHA-Signature': `ed25519:${sig}`,
  };
}

function verifyPeerSignature({ publicKey, method = 'GET', path = '/', networkId, timestamp, nonce, bodyHash, signature }) {
  const sig = String(signature || '');
  if (!sig.startsWith('ed25519:')) return false;
  const base = peerSignatureBase({ method, path, bodyHash, timestamp, nonce, networkId });
  return crypto.verify(
    null,
    Buffer.from(base),
    publicKeyObject(publicKey),
    Buffer.from(sig.slice('ed25519:'.length), 'base64'),
  );
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomicWriteJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  if (mode) {
    try { fs.chmodSync(file, mode); } catch { /* ignore */ }
  }
}

function normalizeNode(raw: any) {
  const kp: any = (!raw || !raw.publicKey || !raw.privateKey) ? makeKeyPair() : null;
  const isNew = !raw || !raw.id;
  const createdAt = raw && raw.createdAt ? raw.createdAt : nowIso();
  const updatedAt = isNew ? createdAt : (raw && raw.updatedAt ? raw.updatedAt : nowIso());
  return {
    schemaVersion: 1,
    id: raw && raw.id ? String(raw.id) : nodeId(),
    label: raw && raw.label ? String(raw.label) : defaultLabel(),
    hostname: safeHostname(),
    platform: process.platform,
    publicKey: raw && raw.publicKey ? String(raw.publicKey) : kp.publicKey,
    privateKey: raw && raw.privateKey ? String(raw.privateKey) : kp.privateKey,
    createdAt,
    updatedAt,
    endpoints: raw && raw.endpoints && typeof raw.endpoints === 'object' ? raw.endpoints : {},
  };
}

function getNodeIdentity() {
  ensureNetDir();
  const existing = readJson(NODE_FILE, null);
  const node = normalizeNode(existing || {});
  if (!existing || JSON.stringify(existing) !== JSON.stringify(node)) {
    atomicWriteJson(NODE_FILE, node, 0o600);
  }
  return node;
}

function publicNodeIdentity(extra: any = {}) {
  const node = getNodeIdentity();
  const endpoints = { ...(node.endpoints || {}), ...(extra.endpoints || {}) };
  return {
    id: node.id,
    label: node.label,
    hostname: node.hostname,
    platform: node.platform,
    publicKey: node.publicKey,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    endpoints,
  };
}

module.exports = {
  NET_DIR,
  NODE_FILE,
  getNodeIdentity,
  publicNodeIdentity,
  atomicWriteJson,
  readJson,
  nowIso,
  sha256Hex,
  signPeerRequest,
  verifyPeerSignature,
};
