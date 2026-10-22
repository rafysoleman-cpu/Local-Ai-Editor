/**
 * Backend composition root.
 *
 * Constructs storage, services, the tool registry, the permission service and
 * the agent runtime once, and exposes the operations used by the Electron IPC
 * layer. No renderer code is imported here.
 */
import path from 'node:path';
import {
  APP_DATA_DIR_NAME,
  type AgentEvent,
  type AppBootstrap,
  type AppSettings,
  type BackupInfo,
  type DataStorageInfo,
  type DiagnosticsInfo,
  type PermissionDecision,
  type PermissionRequest,
  type ProviderStatus,
  type PullProgress,
  type RelocationResult,
  type TerminalChunk,
  type TerminalExit,
  type ToolDescriptor,
} from '@shared/app-types';
import { Logger } from '../logging/logger';
import { FileStorage } from '../storage/file-storage';
import { BackupService } from '../storage/backup-service';
import { DataLocationManager } from '../storage/data-location';
import { runStorageMigrations, StorageVersionError } from '../storage/migrations';
import { SettingsService } from './settings-service';
import { ProjectService } from '../projects/project-service';
import { WorkspaceService } from '../projects/workspace-service';
import { ChatService } from './chat-service';
import { TaskService } from './task-service';
import { MemoryService } from '../memory/memory-service';
import { ProcessManager } from '../terminal/process-manager';
import { CommandService } from '../terminal/command-service';
import { TerminalService } from '../terminal/terminal-service';
import { GitService } from '../tools/git/git-service';
import { OllamaProvider } from '../providers/ollama-provider';
import { ContextCache } from '../cache/context-cache';
import { ContextBuilder } from '../agent/context-builder';
import { ToolRegistry } from '../agent/tool-registry';
import { registerFilesystemTools } from '../tools/filesystem/filesystem-tools';
import { registerSearchTools } from '../tools/search/search-tools';
import { registerTerminalTools } from '../tools/terminal/terminal-tools';
import { registerTestingTools } from '../tools/testing/testing-tools';
import { registerGitTools } from '../tools/git/git-tools';
import { registerProjectTools } from '../tools/project/project-tools';
import { CustomToolService } from '../tools/custom/custom-tool-service';
import { PermissionStorage } from '../permissions/permission-storage';
import { PermissionService } from '../permissions/permission-service';
import { ToolExecutor } from '../agent/tool-executor';
import { AgentRuntime } from '../agent/agent-runtime';
import { AppError } from '../util/errors';

export interface BackendEmitters {
  agentEvent: (event: AgentEvent) => void;
  terminalChunk: (chunk: TerminalChunk) => void;
  terminalExit: (exit: TerminalExit) => void;
  pullProgress: (progress: PullProgress) => void;
  storageWarning: (message: string) => void;
  permissionRequest: (request: PermissionRequest) => void;
  permissionResolved: (requestId: string, decision: PermissionDecision) => void;
}

export interface BackendOptions {
  userDataDirectory: string;
  documentsDirectory: string;
  dataDirectoryOverride?: string | null;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  isDev: boolean;
  emitters: BackendEmitters;
}

export class Backend {
  readonly storage: FileStorage;
  readonly logger: Logger;
  readonly backups: BackupService;
  readonly dataLocation: DataLocationManager;
  readonly settings: SettingsService;
  readonly projects: ProjectService;
  readonly workspace: WorkspaceService;
  readonly chats: ChatService;
  readonly tasks: TaskService;
  readonly memory: MemoryService;
  readonly processes: ProcessManager;
  readonly commands: CommandService;
  readonly git: GitService;
  readonly terminals: TerminalService;
  readonly provider: OllamaProvider;
  readonly cache: ContextCache;
  readonly contextBuilder: ContextBuilder;
  readonly tools: ToolRegistry;
  readonly customTools: CustomToolService;
  readonly permissions: PermissionService;
  readonly executor: ToolExecutor;
  readonly agent: AgentRuntime;

  private storageWarning: string | null = null;
  private pullController: AbortController | null = null;
  private readonly options: BackendOptions;

  private constructor(options: BackendOptions, parts: {
    storage: FileStorage;
    logger: Logger;
    backups: BackupService;
    dataLocation: DataLocationManager;
    settings: SettingsService;
    projects: ProjectService;
    workspace: WorkspaceService;
    chats: ChatService;
    tasks: TaskService;
    memory: MemoryService;
    processes: ProcessManager;
    commands: CommandService;
    git: GitService;
    terminals: TerminalService;
    provider: OllamaProvider;
    cache: ContextCache;
    contextBuilder: ContextBuilder;
    tools: ToolRegistry;
    customTools: CustomToolService;
    permissions: PermissionService;
    executor: ToolExecutor;
    agent: AgentRuntime;
  }) {
    this.options = options;
    this.storage = parts.storage;
    this.logger = parts.logger;
    this.backups = parts.backups;
    this.dataLocation = parts.dataLocation;
    this.settings = parts.settings;
    this.projects = parts.projects;
    this.workspace = parts.workspace;
    this.chats = parts.chats;
    this.tasks = parts.tasks;
    this.memory = parts.memory;
    this.processes = parts.processes;
    this.commands = parts.commands;
    this.git = parts.git;
    this.terminals = parts.terminals;
    this.provider = parts.provider;
    this.cache = parts.cache;
    this.contextBuilder = parts.contextBuilder;
    this.tools = parts.tools;
    this.customTools = parts.customTools;
    this.permissions = parts.permissions;
    this.executor = parts.executor;
    this.agent = parts.agent;
  }

  static async create(options: BackendOptions): Promise<Backend> {
    const logger = new Logger(options.isDev ? 'debug' : 'info', true);
    const defaultDataDirectory = path.join(options.documentsDirectory, APP_DATA_DIR_NAME);
    const storage = new FileStorage(defaultDataDirectory);
    const backups = new BackupService(storage, logger, options.appVersion);
    const dataLocation = new DataLocationManager(
      options.userDataDirectory,
      defaultDataDirectory,
      storage,
      backups,
      logger,
      options.appVersion,
      options.dataDirectoryOverride ?? null,
    );

    const resolved = await dataLocation.resolve();
    logger.attachStorage(storage);
    storage.onWarning((warning) => {
      logger.warn('storage', warning.message, { path: warning.path });
      options.emitters.storageWarning(warning.message);
    });

    try {
      await runStorageMigrations(storage, options.appVersion, logger);
    } catch (error) {
      if (error instanceof StorageVersionError) throw new AppError(error.message, 'STORAGE');
      throw error;
    }

    const settings = new SettingsService(storage, logger);
    await settings.init();

    const processes = new ProcessManager(path.join(storage.root, 'cache', 'proc'));
    const commands = new CommandService(processes, () => ({
      maxCommandMs: settings.get().limits.maxCommandMs,
      maxOutputChars: settings.get().limits.maxOutputChars,
    }));
    const git = new GitService(processes, logger);
    const workspace = new WorkspaceService(logger);
    const projects = new ProjectService(
      storage,
      logger,
      options.appVersion,
      workspace,
      () => storage.root,
      (directory) => git.init(directory),
    );
    const chats = new ChatService(storage, projects, logger);
    const tasks = new TaskService(storage, projects, chats, logger);
    const memory = new MemoryService(storage, projects, logger);

    const cache = new ContextCache(5 * 60 * 1000);
    const contextBuilder = new ContextBuilder(cache, projects, memory, workspace, logger, commands.shell);
    const provider = new OllamaProvider(() => settings.get().ollamaBaseUrl, logger);

    const tools = new ToolRegistry();
    registerFilesystemTools(tools);
    registerSearchTools(tools);
    registerTerminalTools(tools);
    registerTestingTools(tools);
    registerGitTools(tools);
    registerProjectTools(tools);

    const customTools = new CustomToolService(storage, logger);
    await customTools.init();

    const permissionStorage = new PermissionStorage(storage, projects, logger);
    const permissions = new PermissionService(permissionStorage, logger);
    permissions.setRequestHandler((request) => options.emitters.permissionRequest(request));
    permissions.setResolvedHandler((requestId, decision) =>
      options.emitters.permissionResolved(requestId, decision),
    );

    const executor = new ToolExecutor(tools, permissions);
    const terminals = new TerminalService({
      processes,
      projects,
      settings: () => settings.get(),
      logger,
      emitChunk: options.emitters.terminalChunk,
      emitExit: options.emitters.terminalExit,
    });

    const agent = new AgentRuntime({
      storage,
      settings: () => settings.get(),
      projects,
      chats,
      tasks,
      memory,
      workspace,
      commands,
      git,
      permissions,
      tools,
      executor,
      provider,
      contextBuilder,
      cache,
      logger,
      emit: options.emitters.agentEvent,
    });

    const backend = new Backend(options, {
      storage,
      logger,
      backups,
      dataLocation,
      settings,
      projects,
      workspace,
      chats,
      tasks,
      memory,
      processes,
      commands,
      git,
      terminals,
      provider,
      cache,
      contextBuilder,
      tools,
      customTools,
      permissions,
      executor,
      agent,
    });

    backend.storageWarning = resolved.warning;
    await backend.refreshCustomTools();
    await projects.refreshManifest().catch((error) => {
      logger.warn('project', 'Could not refresh manifest', { error: (error as Error).message });
    });
    await backend.resetStaleChats();
    backend.wireInvalidation();
    return backend;
  }

  private wireInvalidation(): void {
    this.projects.onChange((projectId, reason) => {
      this.cache.invalidateProject(projectId, `project:${reason}`);
    });
    this.chats.onChange((projectId, chatId, reason) => {
      this.cache.invalidateChat(projectId, chatId, `chat:${reason}`);
    });
    this.memory.onChange((projectId) => {
      this.cache.invalidateProject(projectId, 'memory-updated');
    });
    this.tasks.onChange((projectId) => {
      this.cache.invalidateProject(projectId, 'tasks-updated');
    });
    this.settings.onChange((_settings, keys) => {
      if (
        keys.some((key) =>
          ['context', 'generation', 'defaultModel', 'ollamaBaseUrl', 'disabledTools'].includes(key),
        )
      ) {
        this.cache.invalidateAll('settings-changed');
      }
    });
  }

  private async resetStaleChats(): Promise<void> {
    try {
      const projects = await this.projects.list();
      for (const project of projects) {
        const chats = await this.chats.list(project.id);
        for (const chat of chats) {
          if (chat.status === 'running') {
            await this.chats.setStatus(project.id, chat.id, 'cancelled').catch(() => undefined);
          }
        }
      }
    } catch (error) {
      this.logger.warn('chat', 'Could not reset stale chat statuses', {
        error: (error as Error).message,
      });
    }
  }

  bootstrap(): AppBootstrap {
    return {
      appVersion: this.options.appVersion,
      electronVersion: this.options.electronVersion,
      nodeVersion: this.options.nodeVersion,
      chromeVersion: this.options.chromeVersion,
      platform: process.platform,
      arch: process.arch,
      isDev: this.options.isDev,
      dataDirectory: this.storage.root,
      settings: this.settings.get(),
      storageWarning: this.storageWarning,
    };
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.settings.update(patch);
  }

  async dataInfo(): Promise<DataStorageInfo> {
    return this.dataLocation.info();
  }

  async diagnostics(): Promise<DiagnosticsInfo> {
    const provider: ProviderStatus = await this.provider.status();
    return {
      cache: this.cache.stats(),
      storage: { dataDirectory: this.storage.root, formatVersion: (await this.dataLocation.readManifest())?.formatVersion ?? 0 },
      provider,
      activeRuns: this.agent.listRuns(),
      app: {
        version: this.options.appVersion,
        electron: this.options.electronVersion,
        node: this.options.nodeVersion,
        platform: `${process.platform} ${process.arch}`,
      },
    };
  }

  async createBackup(label?: string): Promise<BackupInfo> {
    return this.backups.create(label ?? 'Manual backup');
  }

  async exportBackup(targetDirectory: string): Promise<BackupInfo> {
    return this.backups.exportTo(targetDirectory);
  }

  async restoreBackup(backupId: string): Promise<{ restored: boolean; warning: string | null }> {
    const result = await this.backups.restore(backupId);
    await runStorageMigrations(this.storage, this.options.appVersion, this.logger);
    await this.settings.reload();
    await this.customTools.init();
    await this.refreshCustomTools();
    this.cache.invalidateAll('backup-restored');
    await this.projects.refreshManifest();
    return { restored: result.restored, warning: result.warning };
  }

  async validateDataTarget(targetDirectory: string): Promise<{ ok: boolean; reason: string | null; freeBytes: number | null }> {
    return this.dataLocation.validateTarget(targetDirectory);
  }

  async moveData(targetDirectory: string): Promise<RelocationResult> {
    const result = await this.dataLocation.moveData(targetDirectory);
    this.cache.invalidateAll('data-moved');
    this.storageWarning = null;
    await this.projects.refreshManifest();
    return result;
  }

  async refreshCustomTools(): Promise<ToolDescriptor[]> {
    const builtinNames = new Set(
      this.tools
        .all()
        .filter((tool) => this.tools.isBuiltin(tool.name))
        .map((tool) => tool.name),
    );
    const usable = this.customTools.definitions().filter((tool) => {
      if (builtinNames.has(tool.name)) {
        this.logger.warn('tools', 'Custom tool name conflicts with a built-in tool and was skipped', {
          name: tool.name,
        });
        return false;
      }
      return true;
    });
    this.tools.setCustomTools(usable);
    return this.tools.descriptors(this.settings.get().disabledTools);
  }

  async setToolEnabled(toolName: string, enabled: boolean): Promise<ToolDescriptor[]> {
    const disabled = new Set(this.settings.get().disabledTools);
    if (enabled) disabled.delete(toolName);
    else disabled.add(toolName);
    await this.settings.update({ disabledTools: [...disabled] });
    return this.tools.descriptors(this.settings.get().disabledTools);
  }

  async startPull(model: string): Promise<{ started: boolean }> {
    if (this.pullController) throw new AppError('A model download is already running.', 'CONFLICT');
    const controller = new AbortController();
    this.pullController = controller;
    const emit = this.options.emitters.pullProgress;
    void this.provider
      .pull(
        model,
        (progress) => {
          try {
            emit(progress);
          } catch {
            /* renderer may be gone */
          }
        },
        controller.signal,
      )
      .catch((error) => {
        try {
          emit({
            model,
            status: 'error',
            completed: 0,
            total: 0,
            percent: null,
            done: true,
            error: (error as Error).message,
          });
        } catch {
          /* ignore */
        }
      })
      .finally(() => {
        if (this.pullController === controller) this.pullController = null;
      });
    return { started: true };
  }

  cancelPull(): { cancelled: boolean } {
    if (!this.pullController) return { cancelled: false };
    this.pullController.abort();
    this.pullController = null;
    return { cancelled: true };
  }

  async shutdown(): Promise<void> {
    this.logger.info('app', 'Shutting down backend');
    this.terminals.disposeAll();
    this.commands.stopAll();
    this.processes.killAll();
    this.cache.invalidateAll('shutdown');
    await this.storage.waitForIdle().catch(() => undefined);
    await this.logger.flush();
  }
}
