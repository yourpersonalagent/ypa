// Browser-local, authenticated-tab automation surface for YPA.
//
// This intentionally controls the app through stable command/register APIs,
// not coordinates or visual selectors. Every method takes a fresh snapshot,
// so features registered later by hot-loaded modules appear automatically.

import { CORE_SHORTCUT_GROUPS } from './core-shortcuts.js';
import { registers } from './keys.js';
import {
  runAppCommandById,
  snapshotAppCommands,
} from './app-command-runtime.js';
import {
  closeAgentSurface,
  focusAgentSurface,
  listAgentSurfaces,
} from './surface-registry.js';
import { getAppActions, getAppState } from '../stores/appStore.js';
import { getSessionState, useSessionStore } from '../stores/sessionStore.js';
import { api } from '../api.js';
import { session } from '../session.js';
import { chat } from '../chat.js';
import { store } from '../store.js';

declare const __APP_VERSION__: string;

export interface FrontendAgentCommandResult {
  ok: boolean;
  id: string;
  error?: 'command-not-found' | 'command-failed';
}

export interface FrontendAgentApi {
  readonly apiVersion: 1;
  readonly appVersion: string;
  listCommands(): ReturnType<typeof commandManifest>;
  runCommand(id: string): FrontendAgentCommandResult;
  listHotkeys(): ReturnType<typeof hotkeyManifest>;
  listSurfaces(): ReturnType<typeof listAgentSurfaces>;
  focusSurface(id: string): boolean;
  closeSurface(id: string): boolean;
  getState(): ReturnType<typeof stateManifest>;
  listManifest(): ReturnType<typeof buildFrontendAgentManifest>;
  openTerminal(): FrontendAgentCommandResult;
  listModels(): Promise<AgentModel[]>;
  newSession(): { id: string };
  setModel(query: string): Promise<AgentModelSelection>;
  sendMessage(text: string): { sessionId: string; accepted: boolean };
}

interface AgentModel {
  id: number;
  name: string;
  provider?: string;
}

interface AgentModelSelection {
  selected?: AgentModel;
  candidates?: AgentModel[];
  error?: 'model-not-found' | 'model-ambiguous';
}

export interface FrontendAgentRequest {
  id: string;
  action: 'list_commands' | 'run_command' | 'get_state' | 'list_surfaces'
    | 'focus_surface' | 'close_surface' | 'list_manifest' | 'open_terminal'
    | 'list_models' | 'new_session' | 'set_model' | 'send_message';
  commandId?: string;
  surfaceId?: string;
  modelQuery?: string;
  message?: string;
}

declare global {
  interface Window {
    __ypa_agent?: FrontendAgentApi;
  }
}

function safeState(command: ReturnType<typeof snapshotAppCommands>[number]) {
  try { return command.state?.() ?? {}; }
  catch { return {}; }
}

function safeValue(getter: () => unknown): unknown {
  try { return getter(); }
  catch { return undefined; }
}

function commandManifest() {
  return snapshotAppCommands().map((command) => ({
    id: command.id,
    group: command.group,
    label: command.label,
    keywords: command.keywords ?? [],
    icon: command.icon,
    badge: command.badge,
    module: command.module ?? '<core>',
    state: safeState(command),
  }));
}

function hotkeyManifest() {
  const core = CORE_SHORTCUT_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      id: null,
      keys: item.keys,
      description: item.description,
      group: group.group,
      module: '<core>',
    })),
  );
  const dynamic = registers.hotkeys.list().map((entry) => ({
    id: entry.id,
    keys: entry.keys,
    description: entry.description ?? '',
    group: 'Module shortcuts',
    module: entry.module ?? '<unknown>',
  }));
  return [...core, ...dynamic];
}

function stateManifest() {
  const app = getAppState();
  const sessions = getSessionState();
  const currentId = String(sessions.currentId || app.currentSession || '');
  const currentSession = sessions.sessions.find((entry) => String(entry.id) === currentId)
    ?? sessions._cache.find((entry) => String(entry.id) === currentId);
  return {
    layout: {
      mode: app.layoutMode,
      view: app.viewMode,
      orientation: app.viewOrient,
      swapped: app.viewSwap,
      headerOpen: app.headerOpen,
      headerOrientation: app.headerOrient,
      openPanel: app.openPanel,
    },
    appearance: {
      colorTheme: app.colorTheme,
      designTheme: app.designTheme,
    },
    session: {
      id: currentId,
      name: currentSession?.name ?? '',
      workingDir: app.sessionWorkingDir ?? currentSession?.workingDir ?? sessions.defaultWorkingDir,
      loading: sessions.loading,
    },
    model: {
      id: app.currentModel.id,
      name: app.currentModel.name,
      provider: app.currentModel.provider,
      effort: app.effort,
      capabilities: app.modelCaps,
    },
    composer: {
      mode: app.composerMode,
      enhance: app.composerEnhance,
    },
    surfaces: listAgentSurfaces(),
  };
}

function buildFrontendAgentManifest() {
  return {
    schemaVersion: 1,
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
    generatedAt: new Date().toISOString(),
    state: stateManifest(),
    commands: commandManifest(),
    hotkeys: hotkeyManifest(),
    prefsTabs: registers.prefsTabs.list().map((entry) => ({
      id: entry.id,
      label: entry.label,
      group: entry.group,
      simpleMode: entry.simpleMode,
      module: entry.module ?? '<core>',
    })),
    prefsEntries: registers.prefsEntries.list().map((entry) => ({
      id: entry.id,
      tab: entry.tab,
      label: entry.label,
      description: entry.description,
      type: entry.type,
      value: safeValue(entry.get),
      module: entry.module ?? '<core>',
    })),
    panels: registers.panels.list().map((entry) => ({
      id: entry.id,
      slotId: entry.slotId,
      module: entry.module ?? '<core>',
    })),
    headerButtons: registers.headerIconButtons.list().map((entry) => ({
      id: entry.id,
      title: entry.title ?? entry.id,
      domId: entry.domId,
      group: entry.group,
      module: entry.module ?? '<core>',
    })),
    registers: Object.entries(registers).map(([id, register]) => ({
      id,
      activeEntries: register.list().length,
      totalEntries: register.listAll().length,
    })),
  };
}

function runCommand(id: string): FrontendAgentCommandResult {
  const exists = snapshotAppCommands().some((command) => command.id === id);
  if (!exists) return { ok: false, id, error: 'command-not-found' };
  return runAppCommandById(id)
    ? { ok: true, id }
    : { ok: false, id, error: 'command-failed' };
}

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function listModels(): Promise<AgentModel[]> {
  let models = getAppState().models as AgentModel[];
  if (!Array.isArray(models) || models.length === 0) {
    models = await api.getAllModels() as AgentModel[];
  }
  return models
    .filter((model) => Number.isFinite(model?.id) && typeof model?.name === 'string')
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }));
}

async function setModel(query: string): Promise<AgentModelSelection> {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return { error: 'model-not-found', candidates: [] };
  const models = await listModels();
  const exact = models.filter((model) => normalizeSearch(model.name) === normalizedQuery);
  const queryTokens = normalizedQuery.split(' ');
  const fuzzy = models.filter((model) => {
    const haystack = normalizeSearch(`${model.name} ${model.provider || ''}`);
    return queryTokens.every((token) => haystack.includes(token));
  });
  const candidates = exact.length ? exact : fuzzy;
  if (candidates.length === 0) return { error: 'model-not-found', candidates: [] };
  if (candidates.length > 1) return { error: 'model-ambiguous', candidates: candidates.slice(0, 12) };

  const selected = candidates[0];
  getAppActions().setCurrentModel(selected);
  store.set('model', selected);
  await api.exec(`#m ${selected.id}`);
  return { selected };
}

function newSession(): { id: string } {
  chat.clearAllowedTools?.();
  return { id: session.create() };
}

function sendMessage(text: string): { sessionId: string; accepted: boolean } {
  const trimmed = text.trim();
  const sessionId = String(getSessionState().currentId || getAppState().currentSession || '');
  if (!trimmed) return { sessionId, accepted: false };
  void chat.executeChatSend({ text: trimmed }).catch((error) => {
    console.warn('[frontend-agent] send_message failed:', error);
  });
  return { sessionId, accepted: true };
}

const completedRequests = new Map<string, { requestId: string; result: Record<string, unknown> }>();
let controlEvents: EventSource | null = null;
let controlSessionId = '';
let sessionSubscriptionInstalled = false;

function rememberCompleted(response: { requestId: string; result: Record<string, unknown> }): void {
  completedRequests.set(response.requestId, response);
  if (completedRequests.size > 100) {
    const oldest = completedRequests.keys().next().value as string | undefined;
    if (oldest) completedRequests.delete(oldest);
  }
}

async function postFrontendAgentResponse(
  sessionId: string,
  response: { requestId: string; result: Record<string, unknown> },
): Promise<void> {
  const url = `${api.config.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/frontend-agent-response`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(response),
      });
      // A replay can legitimately arrive after another tab/attempt already
      // resolved the request. Treat those terminal statuses as delivered.
      if (res.ok || res.status === 404 || res.status === 409) return;
      throw new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Execute an SSE-delivered request in this tab. Hidden tabs intentionally do
 * not respond, so the tool controls the app instance the user is looking at. */
export async function handleFrontendAgentRequest(
  request: FrontendAgentRequest,
  sessionId: string,
): Promise<boolean> {
  const visibleSessionId = String(getSessionState().currentId || getAppState().currentSession || 'default');
  if (!request?.id || document.visibilityState !== 'visible' || visibleSessionId !== String(sessionId)) {
    return false;
  }

  const previous = completedRequests.get(request.id);
  if (previous) {
    await postFrontendAgentResponse(sessionId, previous).catch(() => {});
    return true;
  }

  const agent = installFrontendAgentApi();
  let result: Record<string, unknown>;
  try {
    let data: unknown;
    switch (request.action) {
      case 'list_commands': data = agent.listCommands(); break;
      case 'run_command': data = agent.runCommand(String(request.commandId || '')); break;
      case 'get_state': data = agent.getState(); break;
      case 'list_surfaces': data = agent.listSurfaces(); break;
      case 'focus_surface': {
        const id = String(request.surfaceId || '');
        data = { id, focused: agent.focusSurface(id) };
        break;
      }
      case 'close_surface': {
        const id = String(request.surfaceId || '');
        data = { id, closed: agent.closeSurface(id) };
        break;
      }
      case 'list_manifest': data = agent.listManifest(); break;
      case 'open_terminal': data = agent.openTerminal(); break;
      case 'list_models': data = await agent.listModels(); break;
      case 'new_session': data = agent.newSession(); break;
      case 'set_model': data = await agent.setModel(String(request.modelQuery || '')); break;
      case 'send_message': data = agent.sendMessage(String(request.message || '')); break;
      default: throw new Error(`Unknown frontend action: ${String(request.action)}`);
    }
    const actionFailed = typeof data === 'object' && data !== null && (
      (request.action === 'run_command' && (data as FrontendAgentCommandResult).ok === false)
      || (request.action === 'set_model' && !!(data as AgentModelSelection).error)
      || (request.action === 'send_message' && (data as { accepted?: boolean }).accepted === false)
    );
    result = actionFailed
      ? { ok: false, action: request.action, data }
      : { ok: true, action: request.action, data };
  } catch (error) {
    result = {
      ok: false,
      action: request.action,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const response = { requestId: request.id, result };
  rememberCompleted(response);
  await postFrontendAgentResponse(sessionId, response).catch((error) => {
    console.warn('[frontend-agent] failed to return command result:', error);
  });
  return true;
}

function connectFrontendAgentControl(sessionId: string | number): void {
  const sid = String(sessionId || '');
  if (sid === controlSessionId && controlEvents) return;
  controlEvents?.close();
  controlEvents = null;
  controlSessionId = sid;
  if (!sid) return;

  const url = `${api.config.baseUrl}/v1/sessions/${encodeURIComponent(sid)}/frontend-agent-events`;
  const events = new EventSource(url);
  events.addEventListener('request', (event) => {
    try {
      const request = JSON.parse((event as MessageEvent<string>).data) as FrontendAgentRequest;
      void handleFrontendAgentRequest(request, sid);
    } catch (error) {
      console.warn('[frontend-agent] invalid control request:', error);
    }
  });
  controlEvents = events;
}

function installFrontendAgentControl(): void {
  connectFrontendAgentControl(getSessionState().currentId || getAppState().currentSession);
  if (sessionSubscriptionInstalled) return;
  sessionSubscriptionInstalled = true;
  useSessionStore.subscribe((state, previous) => {
    if (state.currentId !== previous.currentId) connectFrontendAgentControl(state.currentId);
  });
}

export function installFrontendAgentApi(): FrontendAgentApi {
  if (window.__ypa_agent) {
    installFrontendAgentControl();
    return window.__ypa_agent;
  }
  const api: FrontendAgentApi = Object.freeze({
    apiVersion: 1 as const,
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
    listCommands: commandManifest,
    runCommand,
    listHotkeys: hotkeyManifest,
    listSurfaces: listAgentSurfaces,
    focusSurface: focusAgentSurface,
    closeSurface: closeAgentSurface,
    getState: stateManifest,
    listManifest: buildFrontendAgentManifest,
    openTerminal: () => runCommand('terminal.open'),
    listModels,
    newSession,
    setModel,
    sendMessage,
  });
  Object.defineProperty(window, '__ypa_agent', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api,
  });
  window.dispatchEvent(new CustomEvent('ypa:agent-ready', { detail: { apiVersion: 1 } }));
  installFrontendAgentControl();
  return api;
}
