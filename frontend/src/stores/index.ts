// Zustand stores — barrel export
// New code should import from here.

export { useAppStore, getAppState, getAppActions } from './appStore.js';
export type { AppState, AppActions, CurrentModel, SysPromptState, EditorState, ModelCaps, UserCaps } from './appStore.js';

export { useChatStore, getChatState, getChatActions } from './chatStore.js';
export type { ChatState, ChatActions, ChatStore, StreamState } from './chatStore.js';

export { useSessionStore, getSessionState, getSessionActions } from './sessionStore.js';
export type { SessionState, SessionActions, SessionStore, SessionEntry } from './sessionStore.js';

export { useGraphStore, getGraphState, getGraphActions } from './graphStore.js';
export type { GraphState, GraphActions, GraphStore, GraphNode, GraphLink, LastExecuted } from './graphStore.js';

export { useToastStore, getToastState, getToastActions } from './toastStore.js';
export type { ToastState, ToastActions, ToastEntry, ToastType, ToastPosition } from './toastStore.js';

export { useEmployeesStore, getEmployeesState, getEmployeesActions } from './employeesStore.js';
export type { EmployeesState, EmployeesActions, EmployeesStore, EmployeeRecord } from './employeesStore.js';

export { useConnectionStore, getConnectionState, getConnectionActions } from './connectionStore.js';
export type { ConnectionState, ConnectionActions, ConnectionStatus } from './connectionStore.js';
