// Thin API wrapper — single place to read/send to FawC backend.
// Exposes:
//   app.api.exec(command)           → POST /v1/command/
//   app.api.stream(command, onChunk) → POST /v1/stream-direct/ (SSE-ish)
//   app.api.getAllModels()          → parses #allmodels text
//
// Refactored to use Zustand stores instead of app.state directly.

import { getAppState, getAppActions } from './stores/appStore.js';
import { getToastActions } from './stores/toastStore.js';

function _toastEventEnabled(key: string): boolean {
  try {
    const cfg = JSON.parse(localStorage.getItem('yha.toast') || '{}');
    if (cfg.enabled === false) return false;
    const events = cfg.events || {};
    return events[key] !== false;
  } catch {
    return true;
  }
}

function _showApiErrorToast(payload: { url?: string; status?: number; message?: string }): void {
  if (!_toastEventEnabled('api:error')) return;
  const { url, status, message } = payload;
  const loc = url ? new URL(url, location.href).pathname : '';
  getToastActions().show(
    `${status ? status + ' ' : ''}${message || 'Request failed'}${loc ? ` (${loc})` : ''}`,
    'error',
    { title: 'API error' }
  );
}

interface ApiConfig {
  baseUrl: string;
  endpoints: { command: string; stream: string };
}

interface BuildBodyOpts {
  model?: unknown;
  preset?: unknown;
  attachments?: unknown[];
  allowedTools?: string[];
  // Per-node overrides (from workflow chat nodes)
  provider?: string;
  systemMode?: string;
  skillSet?: string;
  toolSetPreset?: string;
  caps?: unknown;
}

interface ExecOpts {
  model?: unknown;
  preset?: unknown;
  attachments?: unknown[];
  provider?: string;
  systemMode?: string;
  skillSet?: string;
  toolSetPreset?: string;
  caps?: unknown;
}

interface StreamOpts {
  model?: unknown;
  preset?: unknown;
  attachments?: unknown[];
  signal?: AbortSignal;
  allowedTools?: string[];
  // Per-node overrides (from workflow chat nodes)
  provider?: string;
  systemMode?: string;
  skillSet?: string;
  toolSetPreset?: string;
  caps?: unknown;
}

interface ApiBody {
  Input: string;
  Model: unknown;
  Provider?: string;
  Preset: unknown;
  Presets?: string[];
  SessionId: string;
  CWD?: string;
  Attachments?: unknown[];
  AllowedTools?: string[];
  Effort?: unknown;
  SystemMode?: string;
  Caps?: unknown;
  SkillSet?: string;
  ToolSetPreset?: string;
  HarnessInstance?: string;
  CodexInstance?: string;
}

declare global {
  interface Window {
    API_CONFIG?: ApiConfig;
  }
}

export const api = (() => {
  function deriveBaseUrl(): string {
    return window.location.origin;
  }

  const CONFIG: ApiConfig = (window.API_CONFIG = window.API_CONFIG || {
    baseUrl: deriveBaseUrl(),
    endpoints: { command: '/v1/command/', stream: '/v1/stream-direct/' },
  });
  let inFlight = false;

  function _buildBody(command: string, { model, preset, attachments, allowedTools, provider: providerOverride, systemMode: systemModeOverride, skillSet: skillSetOverride, toolSetPreset: toolSetPresetOverride, caps: capsOverride }: BuildBodyOpts = {}): ApiBody {
    const s = getAppState();
    const m = model ?? s.currentModel.name ?? s.currentModel.id;
    const p = preset ?? s.currentPreset;
    const body: ApiBody = {
      Input: command,
      Model: m,
      Preset: p,
      SessionId: String(s.currentSession || 'default'),
    };
    // FE is the single source of truth for the per-session working
    // directory — the picker / preferences modal mutate sessionWorkingDir
    // and the bridge persists it asynchronously, so passing it inline
    // here removes the race where the next stream POST lands before
    // SQLite has caught up.
    const cwd = (s.sessionWorkingDir ?? '').trim();
    if (cwd) body.CWD = cwd;
    // Send the model's provider (e.g. "Anthropic-SUB2") so the bridge can
    // route to the right subscription instance — without this, the backend
    // falls back to the FIRST subscription and ignores SUB2/SUB3 picks.
    const provider = providerOverride ?? (s.currentModel as { provider?: string })?.provider;
    if (provider) body.Provider = provider;
    if (attachments && attachments.length) body.Attachments = attachments;
    if (allowedTools && allowedTools.length) body.AllowedTools = allowedTools;
    const effort = s.effort;
    if (effort) body.Effort = effort;
    // System prompt: node override takes priority, then session-level sysPrompt
    if (systemModeOverride && preset) {
      body.Preset = preset;
      body.SystemMode = systemModeOverride;
    } else {
      const sysState = s.sysPrompt?.selection;
      if (sysState?.mode && sysState.mode !== 'off' && sysState?.preset) {
        // Send preset identifiers, not expanded preset bodies. Large presets are
        // resolved server-side; expanding them here bloats every request and can
        // trip /v1/command/ body validation before the backend has a chance to
        // resolve the configured preset normally.
        const names = sysState.presets?.length ? sysState.presets : [sysState.preset];
        const cleaned = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
        body.Preset = cleaned[0] || sysState.preset;
        if (cleaned.length > 1) body.Presets = cleaned;
        body.SystemMode = sysState.mode;
      }
    }
    if (capsOverride !== undefined) body.Caps = capsOverride;
    else if (s.caps) body.Caps = s.caps;
    if (skillSetOverride !== undefined) body.SkillSet = skillSetOverride;
    else if (s.skillSet) body.SkillSet = s.skillSet;
    if (toolSetPresetOverride) body.ToolSetPreset = toolSetPresetOverride;
    if (s.harnessInstance) body.HarnessInstance = s.harnessInstance;
    if (s.codexInstance) body.CodexInstance = s.codexInstance;
    return body;
  }

  async function exec(command: string, { model, preset, attachments }: ExecOpts = {}): Promise<unknown> {
    inFlight = true;
    try {
      const body = _buildBody(command, { model, preset, attachments });
      const res = await fetch(CONFIG.baseUrl + CONFIG.endpoints.command, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        mode: 'cors',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `API ${res.status} ${res.statusText}`;
        try {
          msg += ' — ' + (await res.text());
        } catch {
          // ignore body-read errors
        }
        const err = new Error(msg);
        _showApiErrorToast({
          url: CONFIG.baseUrl + CONFIG.endpoints.command,
          status: res.status,
          message: msg,
        });
        throw err;
      }
      const data = await res.json();
      if (data.success === false) {
        const msg = data.errorMessage || 'Unknown API error';
        _showApiErrorToast({
          url: CONFIG.baseUrl + CONFIG.endpoints.command,
          message: msg,
        });
        throw new Error(msg);
      }
      return data;
    } finally {
      inFlight = false;
    }
  }

  async function stream(
    command: string,
    onChunk?: (parsed: Record<string, unknown>, full: string) => void,
    { model, preset, attachments, signal, allowedTools, provider, systemMode, skillSet, toolSetPreset, caps }: StreamOpts = {}
  ): Promise<string> {
    inFlight = true;
    try {
      const body = _buildBody(command, { model, preset, attachments, allowedTools, provider, systemMode, skillSet, toolSetPreset, caps });
      const streamUrl = CONFIG.baseUrl + CONFIG.endpoints.stream;
      const res = await fetch(streamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        mode: 'cors',
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok || !res.body) {
        let detail = '';
        try {
          const bodyText = await res.text();
          if (bodyText) {
            try {
              const parsed = JSON.parse(bodyText) as { error?: unknown; errorMessage?: unknown; message?: unknown };
              const raw = parsed.errorMessage ?? parsed.message ?? parsed.error;
              detail = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : bodyText;
            } catch {
              detail = bodyText;
            }
          }
        } catch {
          // ignore body-read errors
        }
        const msg = `Stream failed ${res.status}${detail ? ` — ${detail}` : ''}`;
        // Chat owns stream errors visually via the in-chat fallback bubble.
        // Toasting here as well made one provider/API failure appear multiple
        // times (API toast + chat toast + error bubble).
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '',
        full = '';
      // Cap the in-memory accumulator so a 50 MB code-dump response can't keep
      // growing the V8 heap linearly while the bridge still has the full text.
      // After the cap, chunks are still forwarded (UI keeps streaming) but the
      // `full` string is frozen and `onChunk` receives a truncation marker once.
      const MAX_FULL_BYTES = 4 * 1024 * 1024; // 4 MiB
      let fullTruncated = false;
      // Watchdog measures silence between *real* SSE data chunks, not raw bytes.
      // The backend emits a `data: {_hb:ts}` heartbeat every 10 s. With that
      // baseline, 15 s without any data is a clear "dead connection" signal
      // (one missed heartbeat + a small grace window) and aborting + reconnecting
      // recovers in <1 s instead of the 30 s the user used to wait.
      //
      // Backgrounded sessions (detached when the user switches away) abort
      // their signal; the silence check honours that and becomes a no-op so a
      // detached stream can't fire StreamTimeoutError on its way out — that
      // path used to leave reconnecting=true on the session state and wedge
      // the eventual switch-back.
      const SILENCE_MS = 15000;
      let lastDataAt = Date.now();
      let silenceFired = false;
      const silenceCheck = setInterval(() => {
        if (signal?.aborted) return;
        if (Date.now() - lastDataAt > SILENCE_MS) {
          silenceFired = true;
          reader.cancel().catch(() => {});
        }
      }, 2000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() || '';
          for (const part of parts) {
            const line = part.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            lastDataAt = Date.now();
            let parsed: Record<string, unknown> | null = null;
            try {
              parsed = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              // non-JSON chunk — treat as raw text
            }
            // Heartbeat-only chunks: lastDataAt was already updated above;
            // don't pass them on to the chunk handler (they have no semantic
            // content, would otherwise show up as empty deltas).
            if (parsed && parsed['_hb'] !== undefined && Object.keys(parsed).length === 1) continue;
            if (parsed) {
              const text = (parsed.text || parsed.delta || '') as string;
              if (text && !fullTruncated) {
                if (full.length + text.length > MAX_FULL_BYTES) {
                  full += text.slice(0, Math.max(0, MAX_FULL_BYTES - full.length));
                  fullTruncated = true;
                  onChunk && onChunk({ truncated: true, fullBytes: full.length }, full);
                } else {
                  full += text;
                }
              }
              onChunk && onChunk(parsed, full);
            } else {
              if (!fullTruncated) {
                if (full.length + payload.length > MAX_FULL_BYTES) {
                  full += payload.slice(0, Math.max(0, MAX_FULL_BYTES - full.length));
                  fullTruncated = true;
                  onChunk && onChunk({ truncated: true, fullBytes: full.length }, full);
                } else {
                  full += payload;
                }
              }
              onChunk && onChunk({ text: payload }, full);
            }
          }
        }
        if (silenceFired) {
          const e = new Error('Stream timed out — reconnecting');
          e.name = 'StreamTimeoutError';
          throw e;
        }
        return full;
      } finally {
        clearInterval(silenceCheck);
      }
    } finally {
      inFlight = false;
    }
  }

  async function getAllModels(): Promise<unknown[]> {
    try {
      const data = await exec('#allmodels') as Record<string, unknown>;
      const raw = ((data.chatHistory as string[] | undefined)?.join('\n')) || (data.response as string) || '';
      // Lines like: "17: gemini-1.5-flash - Google"
      const re = /^\s*(\d+)\s*:\s*([\w\-.+]+)\s*-\s*(.+?)\s*$/gm;
      const out: { id: number; name: string; provider: string }[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)))
        out.push({ id: +m[1], name: m[2], provider: m[3].replace(/\(.*?\)/g, '').trim() });
      getAppActions().setModels(out, raw);
      return out;
    } catch (e) {
      console.warn('getAllModels failed:', (e as Error).message);
      return [];
    }
  }

  return { exec, stream, getAllModels, config: CONFIG, deriveBaseUrl, isBusy: () => inFlight };
})();
