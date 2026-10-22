/**
 * Preload bridge.
 *
 * Exposes a narrow, explicitly typed API on `window.desktop`. No generic
 * `ipcRenderer` access, no Node.js globals, no arbitrary filesystem API.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopApi,
  IpcChannel,
  IpcEventName,
  IpcEvents,
  IpcRequest,
  IpcResponse,
  Unsubscribe,
} from '../shared/ipc-contracts';

function invoke<C extends IpcChannel>(
  channel: C,
  payload?: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResponse<C>>;
}

function subscribe<E extends IpcEventName>(
  event: E,
  handler: (payload: IpcEvents[E]) => void,
): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, payload: IpcEvents[E]): void => {
    handler(payload);
  };
  ipcRenderer.on(event, listener);
  return () => {
    ipcRenderer.removeListener(event, listener);
  };
}

const api: DesktopApi = {
  app: {
    bootstrap: () => invoke('app:bootstrap'),
    saveSettings: (patch) => invoke('app:save-settings', { patch }),
    diagnostics: () => invoke('app:diagnostics'),
    dataInfo: () => invoke('app:data-info'),
    openDataDir: () => invoke('app:open-data-dir'),
    openExternal: (url) => invoke('app:open-external', { url }),
    pickDirectory: (title) => invoke('app:pick-directory', title ? { title } : undefined),
  },
  storage: {
    listBackups: () => invoke('storage:list-backups'),
    createBackup: (label) => invoke('storage:create-backup', label ? { label } : {}),
    restoreBackup: (backupId) => invoke('storage:restore-backup', { backupId }),
    exportBackup: (targetDirectory) => invoke('storage:export-backup', { targetDirectory }),
    moveData: (targetDirectory) => invoke('storage:move-data', { targetDirectory, confirm: true }),
    validateTarget: (targetDirectory) => invoke('storage:validate-target', { targetDirectory }),
  },
  projects: {
    list: () => invoke('project:list'),
    create: (input) => invoke('project:create', input),
    pickFolder: (mode) => invoke('project:pick-folder', { mode }),
    get: (projectId) => invoke('project:get', { projectId }),
    update: (input) => invoke('project:update', input),
    remove: (projectId) => invoke('project:remove', { projectId }),
    delete: (projectId) => invoke('project:delete', { projectId, confirm: true }),
    openFolder: (projectId) => invoke('project:open-folder', { projectId }),
    workspaceInfo: (projectId) => invoke('project:workspace-info', { projectId }),
    getInstructions: (projectId) => invoke('project:get-instructions', { projectId }),
    saveInstructions: (projectId, content) =>
      invoke('project:save-instructions', { projectId, content }),
    getMemory: (projectId) => invoke('project:get-memory', { projectId }),
    saveMemory: (projectId, content) => invoke('project:save-memory', { projectId, content }),
    relocateWorkspace: (projectId, workspacePath) =>
      invoke('project:relocate-workspace', { projectId, workspacePath }),
  },
  chats: {
    list: (projectId) => invoke('chat:list', { projectId }),
    create: (projectId, mode, title) =>
      invoke('chat:create', { projectId, mode, ...(title ? { title } : {}) }),
    get: (projectId, chatId) => invoke('chat:get', { projectId, chatId }),
    update: (input) => invoke('chat:update', input),
    delete: (projectId, chatId) => invoke('chat:delete', { projectId, chatId }),
    messages: (projectId, chatId) => invoke('chat:messages', { projectId, chatId }),
  },
  tasks: {
    list: (projectId, chatId) => invoke('tasks:list', { projectId, chatId }),
    getPlan: (projectId, planId) => invoke('plan:get', { projectId, planId }),
    approvePlan: (projectId, planId) => invoke('plan:approve', { projectId, planId }),
    rejectPlan: (projectId, planId) => invoke('plan:reject', { projectId, planId }),
    update: (input) => invoke('task:update', input),
  },
  fs: {
    list: (projectId, relativePath, includeIgnored = false) =>
      invoke('fs:list', { projectId, relativePath, includeIgnored }),
    read: (projectId, relativePath) => invoke('fs:read', { projectId, relativePath }),
    write: (input) =>
      invoke('fs:write', {
        projectId: input.projectId,
        relativePath: input.relativePath,
        content: input.content,
        createDirectories: input.createDirectories ?? false,
        ...(input.expectedModifiedAt ? { expectedModifiedAt: input.expectedModifiedAt } : {}),
      }),
    create: (projectId, relativePath, type) => invoke('fs:create', { projectId, relativePath, type }),
    rename: (projectId, fromRelativePath, toRelativePath) =>
      invoke('fs:rename', { projectId, fromRelativePath, toRelativePath }),
    delete: (projectId, relativePath, recursive = false) =>
      invoke('fs:delete', { projectId, relativePath, recursive }),
    info: (projectId, relativePath) => invoke('fs:info', { projectId, relativePath }),
    searchFiles: (projectId, query, maxResults = 50) =>
      invoke('fs:search-files', { projectId, query, maxResults }),
    grep: (input) =>
      invoke('fs:grep', {
        projectId: input.projectId,
        query: input.query,
        relativePath: input.relativePath ?? '',
        isRegex: input.isRegex ?? false,
        caseSensitive: input.caseSensitive ?? false,
        maxResults: input.maxResults ?? 100,
      }),
    reveal: (projectId, relativePath) => invoke('fs:reveal', { projectId, relativePath }),
  },
  git: {
    status: (projectId) => invoke('git:status', { projectId }),
    diff: (projectId, relativePath) =>
      invoke('git:diff', { projectId, ...(relativePath ? { relativePath } : {}) }),
    log: (projectId) => invoke('git:log', { projectId }),
    branches: (projectId) => invoke('git:branches', { projectId }),
  },
  permissions: {
    respond: (requestId, decision) => invoke('permission:respond', { requestId, decision }),
    list: (projectId) => invoke('permission:list', { projectId }),
    revoke: (projectId, recordId) => invoke('permission:revoke', { projectId, recordId }),
  },
  provider: {
    status: (refresh) => invoke('provider:status', { refresh: Boolean(refresh) }),
    test: (model) => invoke('provider:test', { model }),
    pull: (model) => invoke('provider:pull', { model }),
    cancelPull: () => invoke('provider:pull-cancel'),
  },
  tools: {
    list: (projectId) => invoke('tools:list', { projectId }),
    setEnabled: (toolName, enabled) => invoke('tools:set-enabled', { toolName, enabled }),
    history: (projectId, limit = 100) => invoke('tools:history', { projectId, limit }),
    custom: {
      list: () => invoke('tools:custom:list'),
      add: (input) => invoke('tools:custom:add', input),
      approve: (name) => invoke('tools:custom:approve', { name }),
      remove: (name) => invoke('tools:custom:remove', { name }),
    },
  },
  terminal: {
    create: (projectId) => invoke('terminal:create', { projectId }),
    input: (sessionId, data) => invoke('terminal:input', { sessionId, data }),
    stop: (sessionId) => invoke('terminal:stop', { sessionId }),
    kill: (sessionId) => invoke('terminal:kill', { sessionId }),
    list: () => invoke('terminal:list'),
  },
  agent: {
    start: (input) => invoke('agent:start', input),
    cancel: (runId) => invoke('agent:cancel', { runId }),
    runs: () => invoke('agent:runs'),
  },
  dev: {
    cacheStats: () => invoke('dev:cache-stats'),
    clearCache: () => invoke('dev:clear-cache'),
    seedApprovedPlan: (input) => invoke('dev:seed-approved-plan', input),
  },
  events: {
    onAgentEvent: (handler) => subscribe('agent:event', handler),
    onTerminalChunk: (handler) => subscribe('terminal:chunk', handler),
    onTerminalExit: (handler) => subscribe('terminal:exit', handler),
    onPullProgress: (handler) => subscribe('provider:pull-progress', handler),
    onMenuAction: (handler) => subscribe('app:menu-action', (payload) => handler(payload)),
    onStorageWarning: (handler) => subscribe('app:storage-warning', handler),
    onPermissionRequest: (handler) => subscribe('permission:request', handler),
    onPermissionResolved: (handler) => subscribe('permission:resolved', handler),
  },
};

contextBridge.exposeInMainWorld('desktop', Object.freeze(api));
