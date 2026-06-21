// ── Structured error hierarchy for YHA Bridge ────────────────────────────────
// All bridge-specific errors inherit from BridgeError, making it easy for
// middleware and callers to distinguish expected errors from unexpected crashes.
// Usage: throw new BridgeInputError('SessionId must not contain path separators');
//        catch (e) { if (e instanceof BridgeError) ... }

'use strict';

class BridgeError extends Error {
  statusCode: number;
  context: Record<string, unknown>;
  constructor(message: string, statusCode = 500, context: Record<string, unknown> = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }
}

// 4xx — User/request errors
class BridgeInputError extends BridgeError {
  constructor(message, context = {}) {
    super(message, 400, context);
  }
}

class BridgeAuthError extends BridgeError {
  constructor(message, context = {}) {
    super(message, 401, context);
  }
}

class BridgeNotFoundError extends BridgeError {
  constructor(message = 'Not found', context = {}) {
    super(message, 404, context);
  }
}

class BridgeRateLimitError extends BridgeError {
  constructor(message = 'Rate limit exceeded', context = {}) {
    super(message, 429, context);
  }
}

// 5xx — Server/provider errors
class BridgeProviderError extends BridgeError {
  constructor(message, statusCode = 502, context = {}) {
    super(message, statusCode, context);
  }
}

class BridgeTimeoutError extends BridgeError {
  constructor(message = 'Request timed out', context = {}) {
    super(message, 504, context);
  }
}

class BridgeConfigError extends BridgeError {
  constructor(message, context = {}) {
    super(message, 500, context);
  }
}

module.exports = {
  BridgeError,
  BridgeInputError,
  BridgeAuthError,
  BridgeNotFoundError,
  BridgeRateLimitError,
  BridgeProviderError,
  BridgeTimeoutError,
  BridgeConfigError,
};
