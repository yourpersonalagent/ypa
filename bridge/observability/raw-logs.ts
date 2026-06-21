'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');

const LOG_DIR = path.join(__dirname, '..', 'api-inout-log');
const MAX_SESSION_FILES = 5;
// Cap a single serialized payload at 256 KB. Vision uploads, big tool outputs,
// and pasted-document responses would otherwise expand the log dir by tens of
// MB per session.
const MAX_PAYLOAD_BYTES = 256 * 1024;

let loggingEnabled = true;
let sessionFilePath = null;

// Cached append-mode WriteStreams keyed by absolute path. We hold one stream
// per log file for the life of the process so per-SSE-chunk writes don't pay
// for an open/close/fsync cycle each time (the previous `fs.appendFileSync`
// blocked the event loop on every model token).
const writeStreams = new Map();
// Per-stream backpressure state: once write() returns false we mark the stream
// as backed up and drop further log lines until 'drain' fires. SSE chunks are
// fire-and-forget telemetry — dropping a burst is preferable to ballooning the
// V8 heap with userland buffer.
const streamBackpressure = new WeakMap();

function setLoggingEnabled(val) {
  loggingEnabled = !!val;
}

function isLoggingEnabled() {
  return loggingEnabled;
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function sessionFileNameFromIndex(index) {
  return `session-${String(index).padStart(4, '0')}.log`;
}

function parseSessionIndex(fileName) {
  const m = /^session-(\d+)\.log$/.exec(fileName);
  return m ? parseInt(m[1], 10) : null;
}

function pruneOldFiles() {
  const files = fs
    .readdirSync(LOG_DIR)
    .map((name) => ({ name, index: parseSessionIndex(name) }))
    .filter((f) => Number.isFinite(f.index))
    .sort((a, b) => b.index - a.index);
  for (const stale of files.slice(MAX_SESSION_FILES)) {
    try {
      fs.unlinkSync(path.join(LOG_DIR, stale.name));
    } catch (_) {}
  }
}

function initSessionFile() {
  ensureLogDir();
  const files = fs.readdirSync(LOG_DIR);
  const indices = files.map(parseSessionIndex).filter(Number.isFinite);
  const nextIndex = indices.length ? Math.max(...indices) + 1 : 1;
  const filePath = path.join(LOG_DIR, sessionFileNameFromIndex(nextIndex));
  fs.writeFileSync(filePath, '', 'utf8');
  pruneOldFiles();
  return filePath;
}

function getSessionFilePath() {
  if (!sessionFilePath) {
    sessionFilePath = initSessionFile();
  }
  return sessionFilePath;
}

// Property names that should never reach disk. Match is case-insensitive on
// the *key* — values are redacted to `[REDACTED]` before JSON.stringify so
// neither a future "log everything for debugging" toggle nor a caller that
// accidentally passes a provider request body to logRaw can leak credentials.
// Note: the headers/query-string forms (e.g. `?api_key=…`, `Authorization:
// Bearer …`) live inside string payloads; those still pass through, but the
// structured-object leak vector this finding called out is closed.
const SENSITIVE_FIELDS = new Set([
  'api_key', 'apikey', 'api-key',
  'authorization', 'auth_token', 'bearer',
  'secret', 'client_secret', 'access_token', 'refresh_token',
  'password', 'passwd',
  'private_key', 'privatekey',
  'token', // last so longer matches above win first
]);

function _redactSensitive(value: any, seen?: WeakSet<object>): any {
  if (value === null || typeof value !== 'object') return value;
  const guard = seen ?? new WeakSet<object>();
  if (guard.has(value)) return value;
  guard.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => _redactSensitive(v, guard));
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_FIELDS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = _redactSensitive(v, guard);
    }
  }
  return out;
}

function safeSerialize(value) {
  let out;
  if (value === undefined) out = 'undefined';
  else if (typeof value === 'string') out = value;
  else {
    try {
      out = JSON.stringify(_redactSensitive(value), null, 2);
    } catch (_) {
      try {
        out = String(value);
      } catch (_) {
        out = '[unserializable]';
      }
    }
  }
  if (typeof out === 'string' && out.length > MAX_PAYLOAD_BYTES) {
    const dropped = out.length - MAX_PAYLOAD_BYTES;
    out = out.slice(0, MAX_PAYLOAD_BYTES) + `\n… [truncated ${dropped} bytes]`;
  }
  return out;
}

// Circuit breaker: if the same path errors N times in a row the next
// `getWriteStream` call returns null until the cooldown expires. Without
// this latch, every `logRaw` call would open a fresh stream on a
// persistently-broken target (deleted file, full disk, EMFILE) and burn an
// FD per write. After N consecutive failures we drop log lines silently for
// the cooldown window, then re-arm on the next attempt.
const _streamErrorCounts = new Map(); // path → consecutive-error count
const _streamCircuitUntil = new Map(); // path → ms timestamp when retry allowed
const STREAM_ERROR_TRIP_AT = 5;
const STREAM_CIRCUIT_COOLDOWN_MS = 30_000;

function getWriteStream(filePath) {
  const now = Date.now();
  const circuitUntil = _streamCircuitUntil.get(filePath);
  if (circuitUntil && circuitUntil > now) return null; // tripped, still cooling down
  if (circuitUntil && circuitUntil <= now) {
    _streamCircuitUntil.delete(filePath);
    _streamErrorCounts.delete(filePath);
  }
  let stream = writeStreams.get(filePath);
  if (stream) return stream;
  try {
    stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
  } catch (err) {
    // Open failed synchronously — count this as an error so the breaker
    // trips before we even hand back a stream.
    const next = (_streamErrorCounts.get(filePath) || 0) + 1;
    _streamErrorCounts.set(filePath, next);
    if (next >= STREAM_ERROR_TRIP_AT) {
      _streamCircuitUntil.set(filePath, now + STREAM_CIRCUIT_COOLDOWN_MS);
      logger.warn('raw-logs.circuit-tripped', { filePath, consecutiveErrors: next, cooldownMs: STREAM_CIRCUIT_COOLDOWN_MS });
    } else {
      logger.warn('raw-logs.stream-open-failed', { filePath, error: (err as any)?.message || String(err) });
    }
    return null;
  }
  stream.on('error', (err) => {
    const count = (_streamErrorCounts.get(filePath) || 0) + 1;
    _streamErrorCounts.set(filePath, count);
    if (count >= STREAM_ERROR_TRIP_AT) {
      _streamCircuitUntil.set(filePath, Date.now() + STREAM_CIRCUIT_COOLDOWN_MS);
      logger.warn('raw-logs.circuit-tripped', { filePath, consecutiveErrors: count, cooldownMs: STREAM_CIRCUIT_COOLDOWN_MS });
    } else {
      logger.warn('raw-logs.stream-error', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
        consecutiveErrors: count,
      });
    }
    // Drop the broken stream so the next write tries to reopen. The kernel
    // may have unlinked the file underneath us or hit EMFILE.
    if (writeStreams.get(filePath) === stream) writeStreams.delete(filePath);
  });
  stream.on('drain', () => {
    const state = streamBackpressure.get(stream);
    if (state && state.dropped > 0) {
      logger.warn('raw-logs.backpressure-resumed', {
        filePath,
        droppedLines: state.dropped,
      });
    }
    streamBackpressure.delete(stream);
  });
  writeStreams.set(filePath, stream);
  return stream;
}

function logRaw(kind, phase, payload, meta = {}) {
  if (!loggingEnabled) return;
  const filePath = getSessionFilePath();
  try {
    const stream = getWriteStream(filePath);
    if (!stream) return; // breaker is tripped — drop silently for cooldown window
    const state = streamBackpressure.get(stream);
    if (state) {
      // Stream said "slow down" earlier; drop this line until 'drain' clears.
      // Bail *before* serializing: building the line runs safeSerialize on the
      // payload (recursive redact-clone + JSON.stringify), which is the real
      // per-SSE-chunk cost. It used to run even for lines we immediately drop,
      // so backpressure throttled the disk write but not the CPU.
      state.dropped += 1;
      return;
    }
    const line = [
      '---',
      `ts: ${new Date().toISOString()}`,
      `kind: ${kind}`,
      `phase: ${phase}`,
      `meta: ${safeSerialize(meta)}`,
      'payload:',
      safeSerialize(payload),
      '',
    ].join('\n');
    const ok = stream.write(line);
    if (!ok) streamBackpressure.set(stream, { dropped: 0 });
    // Successful write — clear the consecutive-error counter so a transient
    // EBUSY / EAGAIN doesn't accumulate toward the breaker trip threshold.
    if (_streamErrorCounts.has(filePath)) _streamErrorCounts.delete(filePath);
  } catch (e) {
    logger.warn('raw-logs.append-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

async function closeAllStreams() {
  const streams = Array.from(writeStreams.values());
  writeStreams.clear();
  await Promise.all(
    streams.map(
      (s) =>
        new Promise((resolve) => {
          try {
            s.end(() => resolve(undefined));
          } catch (_) {
            resolve(undefined);
          }
        })
    )
  );
}

module.exports = {
  LOG_DIR,
  get SESSION_FILE_PATH() {
    return sessionFilePath;
  },
  logRaw,
  setLoggingEnabled,
  isLoggingEnabled,
  closeAllStreams,
};
