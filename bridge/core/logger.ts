// ── Lightweight structured logger ─────────────────────────────────────────────
// Drop-in replacement for console.log/warn/error that adds timestamps and structured
// JSON output. In production, swap this for pino/winston by changing the backend.
// Usage:  logger.info('Session loaded', { sid, count })
//         logger.warn('Rate limit approaching', { ip, hits })
//         logger.error('Provider failed', { provider, status })

'use strict';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const PREFIXES = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };

function formatTimestamp() {
  return new Date().toISOString();
}

function isBrokenPipe(err) {
  const code = err && err.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (isBrokenPipe(err)) return;
    setTimeout(() => { throw err; }, 0);
  });
}

function safeWrite(stream, line) {
  try {
    stream.write(line + '\n');
  } catch (err) {
    if (!isBrokenPipe(err)) throw err;
  }
}

function emit(level, message, meta = {}) {
  const entry = {
    t: formatTimestamp(),
    level,
    msg: message,
    ...(Object.keys(meta).length ? { meta } : {}),
  };
  const line = JSON.stringify(entry);
  switch (level) {
    case 'error': safeWrite(process.stderr, line); break;
    case 'warn':  safeWrite(process.stderr, line); break;
    default:      safeWrite(process.stdout, line); break;
  }
}

const logger = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  // Legacy console-compatible shim: logger.log('msg', {key: val})
  log: (msg, meta) => emit('info', msg, meta),
};

module.exports = logger;
