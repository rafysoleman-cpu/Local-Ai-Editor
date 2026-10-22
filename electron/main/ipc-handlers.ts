/**
 * IPC handlers. Every channel from ipc-contracts is registered here, and every
 * payload is validated with Zod before touching a service. Requests are only
 * accepted from the application's own top-level frame.
 */
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z, type ZodTypeAny } from 'zod';
import type {
  IpcChannel,
  IpcRequest,
  IpcResponse,
} from '@shared/ipc-contracts';
import {
  addCustomToolInput,
  backupExportInput,
  backupRestoreInput,
  cancelRunInput,
  createChatInput,
  createEntryInput,
  createProjectInput,
  customToolNameInput,
  deleteEntryInput,
  gitCommandInput,
  grepInput,
  listDirectoryInput,
  moveDataInput,
  permissionResponseInput,
  permissionRevokeInput,
  planInput,
  projectChatInput,
  projectIdInput,
  projectIdString,
  providerPullInput,
  providerTestInput,
  readFileInput,
  renameEntryInput,
  saveInstructionsInput,
  saveMemoryInput,
  searchFilesInput,
  setToolEnabledInput,
  startAgentInput,
  taskUpdateInput,
  terminalCreateInput,
  terminalInput,
  terminalSessionInput,
  updateChatInput,
  updateProjectInput,
  writeFileInput,
} from '@shared/validation';
import type { Backend } from '@backend/application/backend';
import type { WindowManager } from './window-manager';
import { resolveWorkspacePath } from '@backend/projects/path-safety';
import { STORAGE_PATHS } from '@backend/storage/paths';

export interface IpcDeps {
  backend: Backend;
  windows: WindowManager;
}

const idSchema = projectIdString;
const targetDirectorySchema = z.string().min(1).max(4096);
const toolHistoryInput = z.object({
  projectId: idSchema,
  limit: z.number().int().min(1).max(500),
});
const executionLogSchema = z.object({
  id: z.string(),
  toolCallId: z.string(),
  projectId: z.string(),
  chatId: z.string().nullable(),
  runId: z.string().nullable(),
  toolName: z.string(),
  args: z.unknown(),
  status: z.string(),
  permission: z.string().nullable(),
  resultPreview: z.string(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
});
const settingsPatchSchema = z.object({
  patch: z.record(z.string(), z.unknown()),
});
const pickDirectorySchema = z.object({ title: z.string().max(200).optional() }).optional();
const projectPickFolderSchema = z.object({ mode: z.enum(['create', 'open']) }).optional();
const relocatWorkspaceSchema = z.object({
  projectId: idSchema,
  workspacePath: z.string().min(1).max(4096),
});
const providerStatusSchema = z.object({ refresh: z.boolean().optional() }).optional();
const openExternalSchema = z.object({ url: z.string().url().max(2048) });

export function registerIpcHandlers({ backend, windows }: IpcDeps): void {
  const assertSender = (event: IpcMainInvokeEvent): void => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window !== windows.current) {
      throw new Error('Rejected IPC request from an unknown window.');
    }
    if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Rejected IPC request from a sub-frame.');
    }
  };

  const handle = <C extends IpcChannel>(
    channel: C,
    schema: ZodTypeAny | null,
    handler: (payload: IpcRequest<C>, event: IpcMainInvokeEvent) => Promise<IpcResponse<C>> | IpcResponse<C>,
  ): void => {
    ipcMain.handle(channel, async (event, rawPayload: unknown) => {
      assertSender(event);
      const payload = (schema ? schema.parse(rawPayload) : rawPayload) as IpcRequest<C>;
      return handler(payload, event);
    });
  };

  const requireProject = async (projectId: string) => {
    const project = await backend.projects.require(projectId);
    return project;
  };

  /* ---------------------------------------------------------------- */
  /* App                                                               */
  /* ---------------------------------------------------------------- */

  handle('app:bootstrap', null, () => backend.bootstrap());
  handle('app:save-settings', settingsPatchSchema, async (payload) => {
    return backend.updateSettings(payload.patch as never);
  });
  handle('app:diagnostics', null, () => backend.diagnostics());
  handle('app:data-info', null, () => backend.dataInfo());
  handle('app:open-data-dir', null, async () => {
    const result = await shell.openPath(backend.storage.root);
    if (result) throw new Error(result);
  });
  handle('app:open-external', openExternalSchema, async (payload) => {
    const parsed = new URL(payload.url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only http(s) links can be opened.');
    }
    await shell.openExternal(payload.url);
  });
  handle('app:pick-directory', pickDirectorySchema, async (payload) => {
    const window = windows.current;
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: payload?.title ?? 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /* ---------------------------------------------------------------- */
  /* Storage and backups                                               */
  /* ---------------------------------------------------------------- */

  handle('storage:list-backups', null, () => backend.backups.list());
  handle('storage:create-backup', z.object({ label: z.string().max(200).optional() }).optional(), async (payload) => {
    return backend.createBackup(payload?.label);
  });
  handle('storage:restore-backup', backupRestoreInput, async (payload) => {
    const result = await backend.restoreBackup(payload.backupId);
    return { restored: result.restored, warning: result.warning };
  });
  handle('storage:export-backup', backupExportInput, async (payload) => {
    return backend.exportBackup(payload.targetDirectory);
  });
  handle('storage:move-data', moveDataInput, async (payload) => {
    return backend.moveData(payload.targetDirectory);
  });
  handle('storage:validate-target', z.object({ targetDirectory: targetDirectorySchema }), async (payload) => {
    return backend.validateDataTarget(payload.targetDirectory);
  });

  /* ---------------------------------------------------------------- */
  /* Projects                                                          */
  /* ---------------------------------------------------------------- */

  handle('project:list', null, () => backend.projects.list());
  handle('project:create', createProjectInput, async (payload) => backend.projects.create(payload));
  handle('project:pick-folder', projectPickFolderSchema, async (payload) => {
    const window = windows.current;
    if (!window) return null;
    const creating = payload?.mode === 'create';
    const result = await dialog.showOpenDialog(window, {
      title: creating ? 'Choose an empty folder for the new project' : 'Open an existing project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  handle('project:get', projectIdInput, async (payload) => backend.projects.get(payload.projectId));
  handle('project:update', updateProjectInput, async (payload) => {
    return backend.projects.update({
      projectId: payload.projectId,
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.workspacePath !== undefined ? { workspacePath: payload.workspacePath } : {}),
      ...(payload.defaultModel !== undefined ? { defaultModel: payload.defaultModel } : {}),
    });
  });
  handle('project:remove', projectIdInput, async (payload) => {
    await backend.projects.remove(payload.projectId);
    await cleanupSettingsForProject(payload.projectId);
    return { removed: true };
  });
  handle('project:delete', z.object({ projectId: idSchema, confirm: z.literal(true) }), async (payload) => {
    await backend.projects.deletePermanently(payload.projectId);
    await cleanupSettingsForProject(payload.projectId);
    return { deleted: true };
  });
  handle('project:open-folder', projectIdInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    const result = await shell.openPath(project.workspacePath);
    if (result) throw new Error(result);
  });
  handle('project:workspace-info', projectIdInput, async (payload) => {
    return backend.projects.getWorkspaceInfo(payload.projectId);
  });
  handle('project:get-instructions', projectIdInput, async (payload) => {
    return backend.projects.getInstructions(payload.projectId);
  });
  handle('project:save-instructions', saveInstructionsInput, async (payload) => {
    return backend.projects.saveInstructions(payload.projectId, payload.content);
  });
  handle('project:get-memory', projectIdInput, async (payload) => backend.memory.get(payload.projectId));
  handle('project:save-memory', saveMemoryInput, async (payload) => {
    return backend.memory.save(payload.projectId, payload.content);
  });
  handle('project:relocate-workspace', relocatWorkspaceSchema, async (payload) => {
    return backend.projects.update({
      projectId: payload.projectId,
      workspacePath: payload.workspacePath,
    });
  });

  const cleanupSettingsForProject = async (projectId: string): Promise<void> => {
    const settings = backend.settings.get();
    const recent = settings.recentProjectIds.filter((id) => id !== projectId);
    const lastChats = { ...settings.lastChatByProject };
    delete lastChats[projectId];
    await backend.settings.update({
      recentProjectIds: recent,
      lastProjectId: settings.lastProjectId === projectId ? (recent[0] ?? null) : settings.lastProjectId,
      lastChatByProject: lastChats,
    });
  };

  /* ---------------------------------------------------------------- */
  /* Chats                                                             */
  /* ---------------------------------------------------------------- */

  handle('chat:list', projectIdInput, async (payload) => backend.chats.list(payload.projectId));
  handle('chat:create', createChatInput, async (payload) => {
    return backend.chats.create(payload.projectId, payload.mode, payload.title);
  });
  handle('chat:get', projectChatInput, async (payload) => {
    return backend.chats.get(payload.projectId, payload.chatId);
  });
  handle('chat:update', updateChatInput, async (payload) => {
    return backend.chats.update({
      projectId: payload.projectId,
      chatId: payload.chatId,
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.mode !== undefined ? { mode: payload.mode } : {}),
    });
  });
  handle('chat:delete', projectChatInput, async (payload) => {
    await backend.chats.delete(payload.projectId, payload.chatId);
    return { deleted: true };
  });
  handle('chat:messages', projectChatInput, async (payload) => {
    return backend.chats.messages(payload.projectId, payload.chatId);
  });

  /* ---------------------------------------------------------------- */
  /* Plans and tasks                                                   */
  /* ---------------------------------------------------------------- */

  handle('tasks:list', projectChatInput, async (payload) => {
    const current = await backend.tasks.listForChat(payload.projectId, payload.chatId);
    return { plan: current?.plan ?? null, tasks: current?.tasks ?? [] };
  });
  handle('plan:get', planInput, async (payload) => {
    return backend.tasks.getPlan(payload.projectId, payload.planId);
  });
  handle('plan:approve', planInput, async (payload) => {
    return backend.tasks.approvePlan(payload.projectId, payload.planId);
  });
  handle('plan:reject', planInput, async (payload) => {
    return backend.tasks.rejectPlan(payload.projectId, payload.planId);
  });
  handle('task:update', taskUpdateInput, async (payload) => {
    return backend.tasks.updateTask({
      projectId: payload.projectId,
      taskId: payload.taskId,
      status: payload.status,
      ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
      ...(payload.evidence !== undefined ? { evidence: payload.evidence } : {}),
    });
  });

  /* ---------------------------------------------------------------- */
  /* Files                                                             */
  /* ---------------------------------------------------------------- */

  handle('fs:list', listDirectoryInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    return backend.workspace.list(
      project.workspacePath,
      payload.relativePath,
      payload.includeIgnored,
    );
  });
  handle('fs:read', readFileInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    return backend.workspace.readFile(project.workspacePath, payload.relativePath);
  });
  handle('fs:write', writeFileInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    const info = await backend.workspace.writeFile(project.workspacePath, payload.relativePath, payload.content, {
      ...(payload.expectedModifiedAt ? { expectedModifiedAt: payload.expectedModifiedAt } : {}),
      createDirectories: payload.createDirectories,
    });
    backend.cache.invalidateProject(payload.projectId, 'file-saved-in-editor');
    return info;
  });
  handle('fs:create', createEntryInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    const entry = await backend.workspace.createEntry(project.workspacePath, payload.relativePath, payload.type);
    backend.cache.invalidateProject(payload.projectId, 'entry-created');
    return entry;
  });
  handle('fs:rename', renameEntryInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    const entry = await backend.workspace.rename(
      project.workspacePath,
      payload.fromRelativePath,
      payload.toRelativePath,
    );
    backend.cache.invalidateProject(payload.projectId, 'entry-renamed');
    return entry;
  });
  handle('fs:delete', deleteEntryInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    await backend.workspace.delete(project.workspacePath, payload.relativePath, payload.recursive);
    backend.cache.invalidateProject(payload.projectId, 'entry-deleted');
    return { deleted: true };
  });
  handle('fs:info', readFileInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    return backend.workspace.info(project.workspacePath, payload.relativePath);
  });
  handle('fs:search-files', searchFilesInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    return backend.workspace.searchFiles(project.workspacePath, payload.query, payload.maxResults);
  });
  handle('fs:grep', grepInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    return backend.workspace.grep(project.workspacePath, payload.query, {
      relativePath: payload.relativePath,
      isRegex: payload.isRegex,
      caseSensitive: payload.caseSensitive,
      maxResults: payload.maxResults,
    });
  });
  handle('fs:reveal', readFileInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    const resolved = await resolveWorkspacePath(project.workspacePath, payload.relativePath, {
      mustExist: false,
    });
    shell.showItemInFolder(resolved.absolutePath);
  });

  /* ---------------------------------------------------------------- */
  /* Git                                                               */
  /* ---------------------------------------------------------------- */

  handle('git:status', projectIdInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    return backend.git.status(project.workspacePath);
  });
  handle('git:diff', gitCommandInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    if (payload.relativePath) {
      await resolveWorkspacePath(project.workspacePath, payload.relativePath, { mustExist: false });
    }
    return backend.git.diff(project.workspacePath, payload.relativePath);
  });
  handle('git:log', projectIdInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    return backend.git.log(project.workspacePath);
  });
  handle('git:branches', projectIdInput, async (payload) => {
    const project = await requireProject(payload.projectId);
    return backend.git.branches(project.workspacePath);
  });

  /* ---------------------------------------------------------------- */
  /* Permissions                                                       */
  /* ---------------------------------------------------------------- */

  handle('permission:respond', permissionResponseInput, async (payload) => {
    backend.permissions.respond(payload.requestId, payload.decision);
  });
  handle('permission:list', projectIdInput, async (payload) => {
    return backend.permissions.list(payload.projectId);
  });
  handle('permission:revoke', permissionRevokeInput, async (payload) => {
    const revoked = await backend.permissions.revoke(payload.projectId, payload.recordId);
    return { revoked };
  });

  /* ---------------------------------------------------------------- */
  /* Provider                                                          */
  /* ---------------------------------------------------------------- */

  handle('provider:status', providerStatusSchema, async () => backend.provider.status());
  handle('provider:test', providerTestInput, async (payload) => backend.provider.test(payload.model));
  handle('provider:pull', providerPullInput, async (payload) => backend.startPull(payload.model));
  handle('provider:pull-cancel', null, () => backend.cancelPull());

  /* ---------------------------------------------------------------- */
  /* Tools                                                             */
  /* ---------------------------------------------------------------- */

  handle('tools:list', projectIdInput, async (payload) => {
    await requireProject(payload.projectId);
    return backend.tools.descriptors(backend.settings.get().disabledTools);
  });
  handle('tools:set-enabled', setToolEnabledInput, async (payload) => {
    return backend.setToolEnabled(payload.toolName, payload.enabled);
  });
  handle('tools:history', toolHistoryInput, async (payload) => {
    await requireProject(payload.projectId);
    const entries = await backend.storage.readJsonLines(
      STORAGE_PATHS.executionsLog(payload.projectId),
      executionLogSchema,
    );
    return entries.slice(-payload.limit).reverse() as never;
  });
  handle('tools:custom:list', null, () => backend.customTools.list());
  handle('tools:custom:add', addCustomToolInput, async (payload) => {
    const definition = await backend.customTools.add(payload);
    await backend.refreshCustomTools();
    return definition;
  });
  handle('tools:custom:approve', customToolNameInput, async (payload) => {
    const definition = await backend.customTools.approve(payload.name);
    await backend.refreshCustomTools();
    return definition;
  });
  handle('tools:custom:remove', customToolNameInput, async (payload) => {
    const removed = await backend.customTools.remove(payload.name);
    await backend.refreshCustomTools();
    return { removed };
  });

  /* ---------------------------------------------------------------- */
  /* Terminal                                                          */
  /* ---------------------------------------------------------------- */

  handle('terminal:create', terminalCreateInput, async (payload) => {
    return backend.terminals.create(payload.projectId);
  });
  handle('terminal:input', terminalInput, async (payload) => {
    await backend.terminals.input(payload.sessionId, payload.data);
  });
  handle('terminal:stop', terminalSessionInput, async (payload) => {
    backend.terminals.stop(payload.sessionId);
  });
  handle('terminal:kill', terminalSessionInput, async (payload) => {
    backend.terminals.dispose(payload.sessionId);
  });
  handle('terminal:list', null, () => backend.terminals.list());

  /* ---------------------------------------------------------------- */
  /* Agent                                                             */
  /* ---------------------------------------------------------------- */

  handle('agent:start', startAgentInput, async (payload) => {
    return backend.agent.start(payload);
  });
  handle('agent:cancel', cancelRunInput, async (payload) => {
    await backend.agent.cancel(payload.runId);
  });
  handle('agent:runs', null, () => backend.agent.listRuns());

  /* ---------------------------------------------------------------- */
  /* Development diagnostics                                           */
  /* ---------------------------------------------------------------- */

  handle('dev:cache-stats', null, () => backend.cache.stats());
  handle('dev:clear-cache', null, () => {
    backend.cache.invalidateAll('manual-clear');
  });
  handle(
    'dev:seed-approved-plan',
    z.object({
      projectId: idSchema,
      chatId: idSchema,
      title: z.string().min(1).max(300),
      taskTitle: z.string().min(1).max(300),
    }),
    async (payload) => {
      if (process.env.LAIE_TEST_MODE !== '1') {
        throw new Error('The seed-approved-plan development hook is disabled.');
      }
      return backend.tasks.createPlan({
        projectId: payload.projectId,
        chatId: payload.chatId,
        title: payload.title,
        tasks: [{ title: payload.taskTitle }],
        approve: true,
      });
    },
  );
}

export type { IpcResponse };
