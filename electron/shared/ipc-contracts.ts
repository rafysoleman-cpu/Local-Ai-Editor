/**
 * Typed IPC contracts shared by main, preload and renderer.
 *
 * Only the channels listed here are reachable through the preload bridge.
 * Every payload is validated again in the main process.
 */
import type {
  AgentEvent,
  AgentRunState,
  AppBootstrap,
  AppSettings,
  BackupInfo,
  CacheStats,
  Chat,
  ChatMessage,
  ChatSummary,
  CommandResult,
  CustomToolDefinition,
  DataStorageInfo,
  DiagnosticsInfo,
  FileContent,
  FileDiff,
  FileEntry,
  FileInfo,
  FileSearchResult,
  GitBranchInfo,
  GitDiffResult,
  GitLogEntry,
  GitStatus,
  GrepResult,
  ModelTestResult,
  PermissionDecision,
  PermissionRecord,
  PermissionRequest,
  Plan,
  Project,
  ProjectInstructions,
  ProjectMemory,
  ProjectSummary,
  ProviderStatus,
  PullProgress,
  RelocationResult,
  Task,
  TerminalChunk,
  TerminalExit,
  TerminalSession,
  ToolCallRecord,
  ToolDescriptor,
  ToolExecutionLogEntry,
  WorkspaceInfo,
} from './app-types';

export interface IpcContract {
  'app:bootstrap': { request: void; response: AppBootstrap };
  'app:save-settings': { request: { patch: Record<string, unknown> }; response: AppSettings };
  'app:diagnostics': { request: void; response: DiagnosticsInfo };
  'app:data-info': { request: void; response: DataStorageInfo };
  'app:open-data-dir': { request: void; response: void };
  'app:open-external': { request: { url: string }; response: void };
  'app:pick-directory': { request: { title?: string } | undefined; response: string | null };

  'storage:list-backups': { request: void; response: BackupInfo[] };
  'storage:create-backup': { request: { label?: string }; response: BackupInfo };
  'storage:restore-backup': { request: { backupId: string }; response: { restored: boolean; warning: string | null } };
  'storage:export-backup': { request: { targetDirectory: string }; response: BackupInfo };
  'storage:move-data': { request: { targetDirectory: string; confirm: true }; response: RelocationResult };
  'storage:validate-target': { request: { targetDirectory: string }; response: { ok: boolean; reason: string | null; freeBytes: number | null } };

  'project:list': { request: void; response: ProjectSummary[] };
  'project:create': {
    request: { name: string; workspacePath: string; createWorkspace: boolean; initializeGit: boolean };
    response: Project;
  };
  'project:pick-folder': { request: { mode: 'create' | 'open' } | undefined; response: string | null };
  'project:get': { request: { projectId: string }; response: Project | null };
  'project:update': {
    request: { projectId: string; name?: string; workspacePath?: string; defaultModel?: string | null };
    response: Project;
  };
  'project:remove': { request: { projectId: string }; response: { removed: boolean } };
  'project:delete': { request: { projectId: string; confirm: true }; response: { deleted: boolean } };
  'project:open-folder': { request: { projectId: string }; response: void };
  'project:workspace-info': { request: { projectId: string }; response: WorkspaceInfo };
  'project:get-instructions': { request: { projectId: string }; response: ProjectInstructions };
  'project:save-instructions': { request: { projectId: string; content: string }; response: ProjectInstructions };
  'project:get-memory': { request: { projectId: string }; response: ProjectMemory };
  'project:save-memory': { request: { projectId: string; content: string }; response: ProjectMemory };
  'project:relocate-workspace': { request: { projectId: string; workspacePath: string }; response: Project };

  'chat:list': { request: { projectId: string }; response: ChatSummary[] };
  'chat:create': { request: { projectId: string; title?: string; mode: 'plan' | 'build' }; response: Chat };
  'chat:get': { request: { projectId: string; chatId: string }; response: Chat | null };
  'chat:update': { request: { projectId: string; chatId: string; title?: string; mode?: 'plan' | 'build' }; response: Chat };
  'chat:delete': { request: { projectId: string; chatId: string }; response: { deleted: boolean } };
  'chat:messages': { request: { projectId: string; chatId: string }; response: ChatMessage[] };

  'tasks:list': { request: { projectId: string; chatId: string }; response: { plan: Plan | null; tasks: Task[] } };
  'plan:get': { request: { projectId: string; planId: string }; response: { plan: Plan | null; tasks: Task[] } };
  'plan:approve': { request: { projectId: string; planId: string }; response: Plan };
  'plan:reject': { request: { projectId: string; planId: string }; response: Plan };
  'task:update': {
    request: {
      projectId: string;
      taskId: string;
      status: Task['status'];
      notes?: string;
      evidence?: string[];
    };
    response: Task;
  };

  'fs:list': { request: { projectId: string; relativePath: string; includeIgnored: boolean }; response: FileEntry[] };
  'fs:read': { request: { projectId: string; relativePath: string }; response: FileContent };
  'fs:write': {
    request: {
      projectId: string;
      relativePath: string;
      content: string;
      expectedModifiedAt?: string;
      createDirectories: boolean;
    };
    response: FileInfo;
  };
  'fs:create': { request: { projectId: string; relativePath: string; type: 'file' | 'directory' }; response: FileEntry };
  'fs:rename': { request: { projectId: string; fromRelativePath: string; toRelativePath: string }; response: FileEntry };
  'fs:delete': { request: { projectId: string; relativePath: string; recursive: boolean }; response: { deleted: boolean } };
  'fs:info': { request: { projectId: string; relativePath: string }; response: FileInfo };
  'fs:search-files': { request: { projectId: string; query: string; maxResults: number }; response: FileSearchResult[] };
  'fs:grep': {
    request: {
      projectId: string;
      query: string;
      relativePath: string;
      isRegex: boolean;
      caseSensitive: boolean;
      maxResults: number;
    };
    response: GrepResult;
  };
  'fs:reveal': { request: { projectId: string; relativePath: string }; response: void };

  'git:status': { request: { projectId: string }; response: GitStatus };
  'git:diff': { request: { projectId: string; relativePath?: string }; response: GitDiffResult };
  'git:log': { request: { projectId: string }; response: GitLogEntry[] };
  'git:branches': { request: { projectId: string }; response: GitBranchInfo };

  'permission:respond': { request: { requestId: string; decision: PermissionDecision }; response: void };
  'permission:list': { request: { projectId: string }; response: PermissionRecord[] };
  'permission:revoke': { request: { projectId: string; recordId: string }; response: { revoked: boolean } };

  'provider:status': { request: { refresh: boolean } | undefined; response: ProviderStatus };
  'provider:test': { request: { model: string }; response: ModelTestResult };
  'provider:pull': { request: { model: string }; response: { started: boolean } };
  'provider:pull-cancel': { request: void; response: { cancelled: boolean } };

  'tools:list': { request: { projectId: string }; response: ToolDescriptor[] };
  'tools:set-enabled': { request: { toolName: string; enabled: boolean }; response: ToolDescriptor[] };
  'tools:history': { request: { projectId: string; limit: number }; response: ToolExecutionLogEntry[] };
  'tools:custom:list': { request: void; response: CustomToolDefinition[] };
  'tools:custom:add': {
    request: {
      name: string;
      description: string;
      command: string;
      parameters: Array<{ name: string; description: string; required: boolean }>;
    };
    response: CustomToolDefinition;
  };
  'tools:custom:approve': { request: { name: string }; response: CustomToolDefinition };
  'tools:custom:remove': { request: { name: string }; response: { removed: boolean } };

  'terminal:create': { request: { projectId: string }; response: TerminalSession };
  'terminal:input': { request: { sessionId: string; data: string }; response: void };
  'terminal:stop': { request: { sessionId: string }; response: void };
  'terminal:kill': { request: { sessionId: string }; response: void };
  'terminal:list': { request: void; response: TerminalSession[] };

  'agent:start': { request: { projectId: string; chatId: string; prompt: string; mode: 'plan' | 'build' }; response: { runId: string } };
  'agent:cancel': { request: { runId: string }; response: void };
  'agent:runs': { request: void; response: AgentRunState[] };

  'dev:seed-approved-plan': {
    request: { projectId: string; chatId: string; title: string; taskTitle: string };
    response: { plan: Plan; tasks: Task[] };
  };
  'dev:cache-stats': { request: void; response: CacheStats };
  'dev:clear-cache': { request: void; response: void };
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request'];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response'];

export interface IpcEvents {
  'agent:event': AgentEvent;
  'terminal:chunk': TerminalChunk;
  'terminal:exit': TerminalExit;
  'terminal:command-result': CommandResult;
  'provider:pull-progress': PullProgress;
  'permission:request': PermissionRequest;
  'permission:resolved': { requestId: string; decision: PermissionDecision };
  'app:menu-action': { action: 'new-chat' | 'save' | 'toggle-terminal' | 'quick-open' | 'settings' };
  'app:storage-warning': { message: string };
}

export type IpcEventName = keyof IpcEvents;
export type IpcEventPayload<E extends IpcEventName> = IpcEvents[E];

export interface PermissionUiState {
  request: PermissionRequest;
  answer: (decision: PermissionDecision) => void;
}

export type Unsubscribe = () => void;

/**
 * The narrow API exposed on `window.desktop` by the preload script.
 * Arbitrary IPC channel names are never exposed to the renderer.
 */
export interface DesktopApi {
  app: {
    bootstrap(): Promise<AppBootstrap>;
    saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
    diagnostics(): Promise<DiagnosticsInfo>;
    dataInfo(): Promise<DataStorageInfo>;
    openDataDir(): Promise<void>;
    openExternal(url: string): Promise<void>;
    pickDirectory(title?: string): Promise<string | null>;
  };
  storage: {
    listBackups(): Promise<BackupInfo[]>;
    createBackup(label?: string): Promise<BackupInfo>;
    restoreBackup(backupId: string): Promise<{ restored: boolean; warning: string | null }>;
    exportBackup(targetDirectory: string): Promise<BackupInfo>;
    moveData(targetDirectory: string): Promise<RelocationResult>;
    validateTarget(targetDirectory: string): Promise<{ ok: boolean; reason: string | null; freeBytes: number | null }>;
  };
  projects: {
    list(): Promise<ProjectSummary[]>;
    create(input: {
      name: string;
      workspacePath: string;
      createWorkspace: boolean;
      initializeGit: boolean;
    }): Promise<Project>;
    pickFolder(mode: 'create' | 'open'): Promise<string | null>;
    get(projectId: string): Promise<Project | null>;
    update(input: {
      projectId: string;
      name?: string;
      workspacePath?: string;
      defaultModel?: string | null;
    }): Promise<Project>;
    remove(projectId: string): Promise<{ removed: boolean }>;
    delete(projectId: string): Promise<{ deleted: boolean }>;
    openFolder(projectId: string): Promise<void>;
    workspaceInfo(projectId: string): Promise<WorkspaceInfo>;
    getInstructions(projectId: string): Promise<ProjectInstructions>;
    saveInstructions(projectId: string, content: string): Promise<ProjectInstructions>;
    getMemory(projectId: string): Promise<ProjectMemory>;
    saveMemory(projectId: string, content: string): Promise<ProjectMemory>;
    relocateWorkspace(projectId: string, workspacePath: string): Promise<Project>;
  };
  chats: {
    list(projectId: string): Promise<ChatSummary[]>;
    create(projectId: string, mode: 'plan' | 'build', title?: string): Promise<Chat>;
    get(projectId: string, chatId: string): Promise<Chat | null>;
    update(input: {
      projectId: string;
      chatId: string;
      title?: string;
      mode?: 'plan' | 'build';
    }): Promise<Chat>;
    delete(projectId: string, chatId: string): Promise<{ deleted: boolean }>;
    messages(projectId: string, chatId: string): Promise<ChatMessage[]>;
  };
  tasks: {
    list(projectId: string, chatId: string): Promise<{ plan: Plan | null; tasks: Task[] }>;
    getPlan(projectId: string, planId: string): Promise<{ plan: Plan | null; tasks: Task[] }>;
    approvePlan(projectId: string, planId: string): Promise<Plan>;
    rejectPlan(projectId: string, planId: string): Promise<Plan>;
    update(input: {
      projectId: string;
      taskId: string;
      status: Task['status'];
      notes?: string;
      evidence?: string[];
    }): Promise<Task>;
  };
  fs: {
    list(projectId: string, relativePath: string, includeIgnored?: boolean): Promise<FileEntry[]>;
    read(projectId: string, relativePath: string): Promise<FileContent>;
    write(input: {
      projectId: string;
      relativePath: string;
      content: string;
      expectedModifiedAt?: string;
      createDirectories?: boolean;
    }): Promise<FileInfo>;
    create(projectId: string, relativePath: string, type: 'file' | 'directory'): Promise<FileEntry>;
    rename(projectId: string, fromRelativePath: string, toRelativePath: string): Promise<FileEntry>;
    delete(projectId: string, relativePath: string, recursive?: boolean): Promise<{ deleted: boolean }>;
    info(projectId: string, relativePath: string): Promise<FileInfo>;
    searchFiles(projectId: string, query: string, maxResults?: number): Promise<FileSearchResult[]>;
    grep(input: {
      projectId: string;
      query: string;
      relativePath?: string;
      isRegex?: boolean;
      caseSensitive?: boolean;
      maxResults?: number;
    }): Promise<GrepResult>;
    reveal(projectId: string, relativePath: string): Promise<void>;
  };
  git: {
    status(projectId: string): Promise<GitStatus>;
    diff(projectId: string, relativePath?: string): Promise<GitDiffResult>;
    log(projectId: string): Promise<GitLogEntry[]>;
    branches(projectId: string): Promise<GitBranchInfo>;
  };
  permissions: {
    respond(requestId: string, decision: PermissionDecision): Promise<void>;
    list(projectId: string): Promise<PermissionRecord[]>;
    revoke(projectId: string, recordId: string): Promise<{ revoked: boolean }>;
  };
  provider: {
    status(refresh?: boolean): Promise<ProviderStatus>;
    test(model: string): Promise<ModelTestResult>;
    pull(model: string): Promise<{ started: boolean }>;
    cancelPull(): Promise<{ cancelled: boolean }>;
  };
  tools: {
    list(projectId: string): Promise<ToolDescriptor[]>;
    setEnabled(toolName: string, enabled: boolean): Promise<ToolDescriptor[]>;
    history(projectId: string, limit?: number): Promise<ToolExecutionLogEntry[]>;
    custom: {
      list(): Promise<CustomToolDefinition[]>;
      add(input: {
        name: string;
        description: string;
        command: string;
        parameters: Array<{ name: string; description: string; required: boolean }>;
      }): Promise<CustomToolDefinition>;
      approve(name: string): Promise<CustomToolDefinition>;
      remove(name: string): Promise<{ removed: boolean }>;
    };
  };
  terminal: {
    create(projectId: string): Promise<TerminalSession>;
    input(sessionId: string, data: string): Promise<void>;
    stop(sessionId: string): Promise<void>;
    kill(sessionId: string): Promise<void>;
    list(): Promise<TerminalSession[]>;
  };
  agent: {
    start(input: { projectId: string; chatId: string; prompt: string; mode: 'plan' | 'build' }): Promise<{ runId: string }>;
    cancel(runId: string): Promise<void>;
    runs(): Promise<AgentRunState[]>;
  };
  dev: {
    cacheStats(): Promise<CacheStats>;
    clearCache(): Promise<void>;
    seedApprovedPlan(input: {
      projectId: string;
      chatId: string;
      title: string;
      taskTitle: string;
    }): Promise<{ plan: Plan; tasks: Task[] }>;
  };
  events: {
    onAgentEvent(handler: (event: AgentEvent) => void): Unsubscribe;
    onTerminalChunk(handler: (chunk: TerminalChunk) => void): Unsubscribe;
    onTerminalExit(handler: (exit: TerminalExit) => void): Unsubscribe;
    onPullProgress(handler: (progress: PullProgress) => void): Unsubscribe;
    onMenuAction(handler: (payload: { action: string }) => void): Unsubscribe;
    onStorageWarning(handler: (payload: { message: string }) => void): Unsubscribe;
    onPermissionRequest(handler: (request: PermissionRequest) => void): Unsubscribe;
    onPermissionResolved(
      handler: (payload: { requestId: string; decision: PermissionDecision }) => void,
    ): Unsubscribe;
  };
}

/** Extra helper types shared with the renderer UI. */
export interface EditorTab {
  relativePath: string;
  content: string;
  savedContent: string;
  language: string;
  modifiedAt: string;
  dirty: boolean;
}

export interface ToolRunView {
  call: ToolCallRecord;
  expanded: boolean;
}

export interface PendingFileDiff {
  diff: FileDiff;
  title: string;
}
