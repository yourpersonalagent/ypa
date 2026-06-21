'use strict';

// ── Single source of truth for OS detection ───────────────────────────────
// Replaces scattered `process.platform === 'win32'` checks across the bridge
// and is the value injected into plugin tile loaders via `DataCtx.platform`.
// `serverPlatform` on `/v1/config/` (handler.ts) still re-exports this so the
// FE TabHarness can pick shell syntax (bash vs PowerShell) when generating
// copy-pasteable auth commands.

export type Platform = NodeJS.Platform;

export const PLATFORM: Platform = process.platform;
export const IS_WINDOWS = PLATFORM === 'win32';
export const IS_LINUX = PLATFORM === 'linux';
export const IS_MAC = PLATFORM === 'darwin';
