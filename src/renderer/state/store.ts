import { create } from 'zustand';
import type {
  AgentEvent,
  AgentMode,
  AgentRunStatus,
  AgentStatusPhase,
  AppBootstrap,
  AppSettings,
  Chat,
  ChatMessage,
  ChatSummary,
  ContextReport,
  DataStorageInfo,
  FileDiff,
  GitStatus,
  LayoutSettings,
  ModelInfo,
  PermissionDecision,
  PermissionRecord,
  PermissionRequest,
  Plan,
  Project,
  ProjectSummary,
  ProviderStatus,
  PullProgress,
  Task,
  ToolCallRecord,
  ToolDescriptor,
  WorkspaceInfo,
} from '@shared/app-types';
import { api, formatError } from '../services/api';

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer _U>
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface RunView {
  runId: string;
  chatId: string;
  mode: AgentMode;
  status: AgentRunStatus;
  phase: AgentStatusPhase;
  detail: string;
  text: string;
  toolCalls: ToolCallRecord[];
  contextReport: ContextReport | null;
  startedAt: number;
}

export interface EditorTabView {
  relativePath: string;
  content: string;
  savedContent: string;
  language: string;
  modifiedAt: string;
  dirty: boolean;
  readOnly: boolean;
  truncated: boolean;
  externalChange: boolean;
}

export interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface ModalState {
  settings: boolean;
  models: boolean;
  tools: boolean;
  newProject: 'new' | 'existing' | null;
  projectSettings: boolean;
  quickOpen: boolean;
  diff: FileDiff | null;
  shortcuts: boolean;
}

interface AppState {
  bootstrapped: boolean;
  fatalError: string | null;
  bootstrap: AppBootstrap | null;
  settings: AppSettings | null;
  projects: ProjectSummary[];
  project: Project | null;
  workspaceInfo: WorkspaceInfo | null;
  chats: ChatSummary[];
  chat: Chat | null;
  messages: ChatMessage[];
  plan: Plan | null;
  tasks: Task[];
  tools: ToolDescriptor[];
  permissions: PermissionRecord[];
  providerStatus: ProviderStatus | null;
  dataInfo: DataStorageInfo | null;
  gitStatus: GitStatus | null;
  tabs: EditorTabView[];
  activeTab: string | null;
  run: RunView | null;
  permissionQueue: PermissionRequest[];
  pull: PullProgress | null;
  toasts: ToastItem[];
  modals: ModalState;
  treeVersion: number;
  draftMode: AgentMode;
  loadingProject: boolean;
  loadingChat: boolean;
  sending: boolean;

  init(): Promise<void>;
  refreshProjects(): Promise<void>;
  openProject(projectId: string): Promise<void>;
  closeProject(): Promise<void>;
  createProject(input: {
    name: string;
    workspacePath: string;
    createWorkspace: boolean;
    initializeGit: boolean;
  }): Promise<Project>;
  updateProject(input: {
    projectId: string;
    name?: string;
    workspacePath?: string;
    defaultModel?: string | null;
  }): Promise<void>;
  removeProject(projectId: string, permanent: boolean): Promise<void>;
  refreshWorkspace(): Promise<void>;
  refreshChats(): Promise<void>;
  openChat(chatId: string): Promise<void>;
  createChat(mode?: AgentMode): Promise<Chat>;
  renameChat(chatId: string, title: string): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  setMode(mode: AgentMode): Promise<void>;
  sendMessage(text: string): Promise<void>;
  cancelRun(): Promise<void>;
  refreshPlan(): Promise<void>;
  approvePlan(): Promise<void>;
  rejectPlan(): Promise<void>;
  refreshTools(): Promise<void>;
  toggleTool(toolName: string, enabled: boolean): Promise<void>;
  refreshPermissions(): Promise<void>;
  revokePermission(recordId: string): Promise<void>;
  respondPermission(decision: PermissionDecision): Promise<void>;
  refreshProvider(refresh: boolean): Promise<void>;
  refreshDataInfo(): Promise<void>;
  refreshGit(): Promise<void>;
  openFile(relativePath: string): Promise<void>;
  updateTabContent(relativePath: string, content: string): void;
  saveTab(relativePath: string): Promise<boolean>;
  closeTab(relativePath: string): Promise<void>;
  reloadTab(relativePath: string): Promise<void>;
  createEntry(relativePath: string, type: 'file' | 'directory'): Promise<void>;
  renameEntry(fromRelativePath: string, toRelativePath: string): Promise<void>;
  deleteEntry(relativePath: string): Promise<void>;
  updateSettings(patch: DeepPartial<AppSettings>, options?: { silent?: boolean }): Promise<void>;
  setLayout(layout: Partial<LayoutSettings>, persist?: boolean): void;
  setTerminalOpen(open: boolean): void;
  toast(message: string, kind?: ToastItem['kind']): void;
  dismissToast(id: number): void;
  openModal<K extends keyof ModalState>(key: K, value?: ModalState[K]): void;
  closeModal(key: keyof ModalState): void;
  closeTopModal(): boolean;
  handleAgentEvent(event: AgentEvent): void;
  handlePermissionRequest(request: PermissionRequest): void;
  handlePermissionResolved(requestId: string): void;
  handlePullProgress(progress: PullProgress): void;
  bumpTree(): void;
}

let toastCounter = 0;

function mergeSettings(current: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  return {
    ...current,
    ...patch,
    generation: { ...current.generation, ...(patch.generation ?? {}) },
    context: { ...current.context, ...(patch.context ?? {}) },
    limits: { ...current.limits, ...(patch.limits ?? {}) },
    permissions: { ...current.permissions, ...(patch.permissions ?? {}) },
    layout: { ...current.layout, ...(patch.layout ?? {}) },
    disabledTools: patch.disabledTools ?? current.disabledTools,
    recentProjectIds: patch.recentProjectIds ?? current.recentProjectIds,
    lastChatByProject:
      (patch.lastChatByProject as Record<string, string> | undefined) ?? current.lastChatByProject,
  };
}

function effectiveMode(state: Pick<AppState, 'chat' | 'draftMode'>): AgentMode {
  return state.chat?.mode ?? state.draftMode;
}

export const useApp = create<AppState>()((set, get) => {
  const toast = (message: string, kind: ToastItem['kind'] = 'info'): void => {
    const id = (toastCounter += 1);
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }] }));
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 5000);
  };

  const persistSelection = (projectId: string | null, chatId?: string): void => {
    const settings = get().settings;
    if (!settings) return;
    const lastChatByProject = { ...settings.lastChatByProject };
    if (projectId && chatId) lastChatByProject[projectId] = chatId;
    const next = { ...settings, lastProjectId: projectId, lastChatByProject };
    set({ settings: next });
    void api.app
      .saveSettings({ lastProjectId: projectId, lastChatByProject })
      .then((saved) => set({ settings: saved }))
      .catch(() => undefined);
  };

  const refreshTabsAfterRun = async (): Promise<void> => {
    const { tabs, project } = get();
    if (!project) return;
    const updated = await Promise.all(
      tabs.map(async (tab) => {
        try {
          const file = await api.fs.read(project.id, tab.relativePath);
          if (file.content === tab.content) {
            return { ...tab, modifiedAt: file.modifiedAt };
          }
          if (!tab.dirty) {
            return {
              ...tab,
              content: file.content,
              savedContent: file.content,
              modifiedAt: file.modifiedAt,
              externalChange: false,
            };
          }
          return { ...tab, externalChange: true };
        } catch {
          return tab;
        }
      }),
    );
    set({ tabs: updated });
  };

  return {
    bootstrapped: false,
    fatalError: null,
    bootstrap: null,
    settings: null,
    projects: [],
    project: null,
    workspaceInfo: null,
    chats: [],
    chat: null,
    messages: [],
    plan: null,
    tasks: [],
    tools: [],
    permissions: [],
    providerStatus: null,
    dataInfo: null,
    gitStatus: null,
    tabs: [],
    activeTab: null,
    run: null,
    permissionQueue: [],
    pull: null,
    toasts: [],
    modals: {
      settings: false,
      models: false,
      tools: false,
      newProject: null,
      projectSettings: false,
      quickOpen: false,
      diff: null,
      shortcuts: false,
    },
    treeVersion: 0,
    draftMode: 'build',
    loadingProject: false,
    loadingChat: false,
    sending: false,

    async init() {
      try {
        const bootstrap = await api.app.bootstrap();
        set({ bootstrap, settings: bootstrap.settings, bootstrapped: true });
        document.documentElement.dataset.theme = bootstrap.settings.theme;
        if (bootstrap.storageWarning) toast(bootstrap.storageWarning, 'warning');
        await get().refreshProjects();
        void get().refreshProvider(false);
        const lastProjectId = bootstrap.settings.lastProjectId;
        if (lastProjectId && get().projects.some((project) => project.id === lastProjectId)) {
          await get().openProject(lastProjectId);
        }
      } catch (error) {
        set({ fatalError: formatError(error), bootstrapped: true });
      }
    },

    async refreshProjects() {
      try {
        const projects = await api.projects.list();
        set({ projects });
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async openProject(projectId) {
      set({ loadingProject: true });
      try {
        const project = await api.projects.get(projectId);
        if (!project) {
          toast('That project no longer exists.', 'warning');
          set({ loadingProject: false });
          return;
        }
        const [chats, workspaceInfo, tools, permissions] = await Promise.all([
          api.chats.list(projectId),
          api.projects.workspaceInfo(projectId),
          api.tools.list(projectId),
          api.permissions.list(projectId),
        ]);
        set({
          project: { ...project, workspaceMissing: workspaceInfo.missing },
          chats,
          workspaceInfo,
          tools,
          permissions,
          tabs: [],
          activeTab: null,
          chat: null,
          messages: [],
          plan: null,
          tasks: [],
          run: null,
          permissionQueue: [],
          draftMode: 'build',
          loadingProject: false,
        });
        persistSelection(projectId);
        const settings = get().settings;
        const lastChat = settings?.lastChatByProject[projectId];
        if (lastChat && chats.some((chat) => chat.id === lastChat)) {
          await get().openChat(lastChat);
        }
        void get().refreshGit();
        if (workspaceInfo.missing) {
          toast('The project folder is missing. Relocate it from Project Settings.', 'warning');
        }
      } catch (error) {
        set({ loadingProject: false });
        toast(formatError(error), 'error');
      }
    },

    async closeProject() {
      set({
        project: null,
        workspaceInfo: null,
        chats: [],
        chat: null,
        messages: [],
        plan: null,
        tasks: [],
        tabs: [],
        activeTab: null,
        run: null,
        permissionQueue: [],
        gitStatus: null,
      });
      persistSelection(null);
      await get().refreshProjects();
    },

    async createProject(input) {
      const project = await api.projects.create(input);
      await get().refreshProjects();
      await get().openProject(project.id);
      toast(`Project "${project.name}" created.`, 'success');
      return project;
    },

    async updateProject(input) {
      const project = await api.projects.update(input);
      set({ project });
      await get().refreshProjects();
      toast('Project settings saved.', 'success');
    },

    async removeProject(projectId, permanent) {
      if (permanent) await api.projects.delete(projectId);
      else await api.projects.remove(projectId);
      if (get().project?.id === projectId) await get().closeProject();
      await get().refreshProjects();
      toast(
        permanent
          ? 'Project application data was permanently deleted. Source files were left untouched.'
          : 'Project removed from the dashboard. Its data was archived under backups/.',
        'info',
      );
    },

    async refreshWorkspace() {
      const project = get().project;
      if (!project) return;
      try {
        const workspaceInfo = await api.projects.workspaceInfo(project.id);
        set({ workspaceInfo, project: { ...project, workspaceMissing: workspaceInfo.missing } });
        await get().refreshGit();
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async refreshChats() {
      const project = get().project;
      if (!project) return;
      try {
        const chats = await api.chats.list(project.id);
        set({ chats });
        const current = get().chat;
        if (current) {
          const updated = chats.find((chat) => chat.id === current.id);
          if (updated) {
            set({
              chat: {
                ...current,
                title: updated.title,
                mode: updated.mode,
                messageCount: updated.messageCount,
                status: updated.status,
              },
            });
          }
        }
      } catch {
        /* silent */
      }
    },

    async openChat(chatId) {
      const project = get().project;
      if (!project) return;
      set({ loadingChat: true });
      try {
        const chat = await api.chats.get(project.id, chatId);
        if (!chat) {
          set({ loadingChat: false });
          toast('Chat not found in this project.', 'warning');
          return;
        }
        const [messages, planData] = await Promise.all([
          api.chats.messages(project.id, chatId),
          api.tasks.list(project.id, chatId),
        ]);
        set({
          chat,
          messages,
          plan: planData.plan,
          tasks: planData.tasks,
          activeTab: get().activeTab,
          loadingChat: false,
          draftMode: chat.mode,
        });
        persistSelection(project.id, chat.id);
      } catch (error) {
        set({ loadingChat: false });
        toast(formatError(error), 'error');
      }
    },

    async createChat(mode) {
      const project = get().project;
      if (!project) throw new Error('Open a project first.');
      const chat = await api.chats.create(project.id, mode ?? get().draftMode);
      await get().refreshChats();
      await get().openChat(chat.id);
      return chat;
    },

    async renameChat(chatId, title) {
      const project = get().project;
      if (!project) return;
      const chat = await api.chats.update({ projectId: project.id, chatId, title });
      set({ chat: get().chat?.id === chatId ? chat : get().chat });
      await get().refreshChats();
    },

    async deleteChat(chatId) {
      const project = get().project;
      if (!project) return;
      if (get().run?.chatId === chatId) {
        toast('Stop the active run before deleting this chat.', 'warning');
        return;
      }
      await api.chats.delete(project.id, chatId);
      await get().refreshChats();
      if (get().chat?.id === chatId) {
        set({ chat: null, messages: [], plan: null, tasks: [] });
      }
      toast('Chat deleted (its messages were moved to chats/deleted).', 'info');
    },

    async setMode(mode) {
      const project = get().project;
      const chat = get().chat;
      if (get().run?.status === 'running') {
        toast('Stop the current run before changing mode.', 'warning');
        return;
      }
      set({ draftMode: mode });
      if (project && chat) {
        const updated = await api.chats.update({ projectId: project.id, chatId: chat.id, mode });
        set({ chat: updated });
        await get().refreshChats();
      }
    },

    async sendMessage(text) {
      const project = get().project;
      if (!project) return;
      const prompt = text.trim();
      if (!prompt) return;
      const activeRun = get().run;
      if (activeRun?.status === 'running') {
        toast('A run is already active in this project.', 'warning');
        return;
      }
      set({ sending: true });
      try {
        let chat = get().chat;
        if (!chat) {
          chat = await api.chats.create(project.id, get().draftMode);
          await get().openChat(chat.id);
        }
        const mode = chat.mode;
        const result = await api.agent.start({
          projectId: project.id,
          chatId: chat.id,
          prompt,
          mode,
        });
        set((state) => ({
          sending: false,
          run: state.run ?? {
            runId: result.runId,
            chatId: chat!.id,
            mode,
            status: 'running',
            phase: 'thinking',
            detail: 'Starting…',
            text: '',
            toolCalls: [],
            contextReport: null,
            startedAt: Date.now(),
          },
        }));
      } catch (error) {
        set({ sending: false });
        toast(formatError(error), 'error');
        throw error;
      }
    },

    async cancelRun() {
      const run = get().run;
      if (!run) return;
      try {
        await api.agent.cancel(run.runId);
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async refreshPlan() {
      const project = get().project;
      const chat = get().chat;
      if (!project || !chat) return;
      try {
        const data = await api.tasks.list(project.id, chat.id);
        set({ plan: data.plan, tasks: data.tasks });
      } catch {
        /* silent */
      }
    },

    async approvePlan() {
      const project = get().project;
      const plan = get().plan;
      if (!project || !plan) return;
      try {
        const approved = await api.tasks.approvePlan(project.id, plan.id);
        set({ plan: approved });
        await get().refreshPlan();
        await get().refreshChats();
        toast('Plan approved. Switch to Build Mode to implement it.', 'success');
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async rejectPlan() {
      const project = get().project;
      const plan = get().plan;
      if (!project || !plan) return;
      try {
        const rejected = await api.tasks.rejectPlan(project.id, plan.id);
        set({ plan: rejected });
        toast('Plan rejected. You can ask for a revised plan in Plan Mode.', 'info');
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async refreshTools() {
      const project = get().project;
      if (!project) return;
      try {
        set({ tools: await api.tools.list(project.id) });
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async toggleTool(toolName, enabled) {
      try {
        const tools = await api.tools.setEnabled(toolName, enabled);
        set({ tools });
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async refreshPermissions() {
      const project = get().project;
      if (!project) return;
      try {
        set({ permissions: await api.permissions.list(project.id) });
      } catch {
        /* silent */
      }
    },

    async revokePermission(recordId) {
      const project = get().project;
      if (!project) return;
      try {
        await api.permissions.revoke(project.id, recordId);
        await get().refreshPermissions();
        toast('Permission revoked.', 'info');
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async respondPermission(decision) {
      const request = get().permissionQueue[0];
      if (!request) return;
      try {
        await api.permissions.respond(request.id, decision);
      } catch (error) {
        toast(formatError(error), 'error');
      } finally {
        set((state) => ({
          permissionQueue: state.permissionQueue.filter((entry) => entry.id !== request.id),
        }));
        if (decision === 'always_allow') void get().refreshPermissions();
      }
    },

    async refreshProvider(refresh) {
      try {
        const status = await api.provider.status(refresh);
        set({ providerStatus: status });
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async refreshDataInfo() {
      try {
        set({ dataInfo: await api.app.dataInfo() });
      } catch {
        /* silent */
      }
    },

    async refreshGit() {
      const project = get().project;
      if (!project) return;
      try {
        set({ gitStatus: await api.git.status(project.id) });
      } catch {
        /* git is optional */
      }
    },

    async openFile(relativePath) {
      const project = get().project;
      if (!project) return;
      const existing = get().tabs.find((tab) => tab.relativePath === relativePath);
      if (existing) {
        set({ activeTab: relativePath });
        return;
      }
      try {
        const file = await api.fs.read(project.id, relativePath);
        if (file.isBinary) {
          toast('Binary files cannot be opened in the text editor.', 'warning');
          return;
        }
        const tab: EditorTabView = {
          relativePath: file.relativePath,
          content: file.content,
          savedContent: file.content,
          language: file.language,
          modifiedAt: file.modifiedAt,
          dirty: false,
          readOnly: file.truncated,
          truncated: file.truncated,
          externalChange: false,
        };
        set((state) => ({ tabs: [...state.tabs, tab], activeTab: relativePath }));
        if (file.truncated) {
          toast('This file is larger than 2 MB and was opened read-only.', 'warning');
        }
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    updateTabContent(relativePath, content) {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.relativePath === relativePath
            ? { ...tab, content, dirty: content !== tab.savedContent }
            : tab,
        ),
      }));
    },

    async saveTab(relativePath) {
      const project = get().project;
      const tab = get().tabs.find((entry) => entry.relativePath === relativePath);
      if (!project || !tab) return false;
      if (tab.readOnly) {
        toast('This file was opened read-only.', 'warning');
        return false;
      }
      if (!tab.dirty) return true;
      try {
        const info = await api.fs.write({
          projectId: project.id,
          relativePath,
          content: tab.content,
          expectedModifiedAt: tab.modifiedAt,
        });
        set((state) => ({
          tabs: state.tabs.map((entry) =>
            entry.relativePath === relativePath
              ? {
                  ...entry,
                  savedContent: entry.content,
                  dirty: false,
                  modifiedAt: info.modifiedAt,
                  externalChange: false,
                }
              : entry,
          ),
        }));
        set((state) => ({ treeVersion: state.treeVersion + 1 }));
        return true;
      } catch (error) {
        toast(formatError(error), 'error');
        set((state) => ({
          tabs: state.tabs.map((entry) =>
            entry.relativePath === relativePath ? { ...entry, externalChange: true } : entry,
          ),
        }));
        return false;
      }
    },

    async closeTab(relativePath) {
      set((state) => {
        const remaining = state.tabs.filter((tab) => tab.relativePath !== relativePath);
        const activeTab =
          state.activeTab === relativePath ? (remaining[remaining.length - 1]?.relativePath ?? null) : state.activeTab;
        return { tabs: remaining, activeTab };
      });
    },

    async reloadTab(relativePath) {
      const project = get().project;
      if (!project) return;
      try {
        const file = await api.fs.read(project.id, relativePath);
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.relativePath === relativePath
              ? {
                  ...tab,
                  content: file.content,
                  savedContent: file.content,
                  modifiedAt: file.modifiedAt,
                  dirty: false,
                  externalChange: false,
                }
              : tab,
          ),
        }));
        toast('File reloaded from disk.', 'info');
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async createEntry(relativePath, type) {
      const project = get().project;
      if (!project) return;
      try {
        await api.fs.create(project.id, relativePath, type);
        set((state) => ({ treeVersion: state.treeVersion + 1 }));
        if (type === 'file') await get().openFile(relativePath);
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async renameEntry(fromRelativePath, toRelativePath) {
      const project = get().project;
      if (!project) return;
      try {
        await api.fs.rename(project.id, fromRelativePath, toRelativePath);
        set((state) => ({
          treeVersion: state.treeVersion + 1,
          tabs: state.tabs
            .map((tab) => {
              if (tab.relativePath === fromRelativePath) {
                return { ...tab, relativePath: toRelativePath };
              }
              if (tab.relativePath.startsWith(`${fromRelativePath}/`)) {
                return {
                  ...tab,
                  relativePath: `${toRelativePath}${tab.relativePath.slice(fromRelativePath.length)}`,
                };
              }
              return tab;
            })
            .filter(Boolean),
          activeTab:
            state.activeTab === fromRelativePath
              ? toRelativePath
              : state.activeTab?.startsWith(`${fromRelativePath}/`)
                ? `${toRelativePath}${state.activeTab.slice(fromRelativePath.length)}`
                : state.activeTab,
        }));
        toast(`Renamed to ${toRelativePath}.`, 'success');
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async deleteEntry(relativePath) {
      const project = get().project;
      if (!project) return;
      try {
        await api.fs.delete(project.id, relativePath, true);
        set((state) => ({
          treeVersion: state.treeVersion + 1,
          tabs: state.tabs.filter(
            (tab) =>
              tab.relativePath !== relativePath && !tab.relativePath.startsWith(`${relativePath}/`),
          ),
        }));
        toast(`Deleted ${relativePath}.`, 'info');
      } catch (error) {
        toast(formatError(error), 'error');
      }
    },

    async updateSettings(patch, options) {
      const current = get().settings;
      if (!current) return;
      const optimistic = mergeSettings(current, patch);
      set({ settings: optimistic });
      if (optimistic.theme !== current.theme) {
        document.documentElement.dataset.theme = optimistic.theme;
      }
      try {
        const saved = await api.app.saveSettings(patch as Partial<AppSettings>);
        set({ settings: saved });
        if (saved.theme !== optimistic.theme) {
          document.documentElement.dataset.theme = saved.theme;
        }
        if (!options?.silent && patch.theme) {
          toast(`Switched to ${saved.theme} theme.`, 'info');
        }
      } catch (error) {
        set({ settings: current });
        toast(formatError(error), 'error');
      }
    },

    setLayout(layout, persist = false) {
      const settings = get().settings;
      if (!settings) return;
      const next = { ...settings, layout: { ...settings.layout, ...layout } };
      set({ settings: next });
      if (persist) {
        void api.app.saveSettings({ layout: next.layout }).catch(() => undefined);
      }
    },

    setTerminalOpen(open) {
      get().setLayout({ terminalOpen: open }, true);
    },

    toast,

    dismissToast(id) {
      set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
    },

    openModal(key, value) {
      set((state) => ({
        modals: {
          ...state.modals,
          [key]: value === undefined ? true : value,
        },
      }));
    },

    closeModal(key) {
      set((state) => ({
        modals: { ...state.modals, [key]: key === 'diff' || key === 'newProject' ? null : false },
      }));
    },

    closeTopModal() {
      const { modals } = get();
      const order: Array<keyof ModalState> = [
        'diff',
        'quickOpen',
        'models',
        'tools',
        'settings',
        'projectSettings',
        'newProject',
        'shortcuts',
      ];
      for (const key of order) {
        if (modals[key]) {
          get().closeModal(key);
          return true;
        }
      }
      return false;
    },

    handleAgentEvent(event) {
      switch (event.type) {
        case 'run_started': {
          set((state) => ({
            run: {
              runId: event.runId,
              chatId: event.chatId,
              mode: event.mode,
              status: 'running',
              phase: 'thinking',
              detail: `Model: ${event.model}`,
              text: '',
              toolCalls: [],
              contextReport: null,
              startedAt: Date.now(),
            },
            messages:
              state.chat?.id === event.chatId &&
              !state.messages.some((message) => message.id === event.userMessage.id)
                ? [...state.messages, event.userMessage]
                : state.messages,
          }));
          void get().refreshChats();
          break;
        }
        case 'status': {
          set((state) =>
            state.run
              ? { run: { ...state.run, phase: event.phase, detail: event.detail } }
              : {},
          );
          break;
        }
        case 'assistant_delta': {
          set((state) =>
            state.run ? { run: { ...state.run, text: state.run.text + event.text } } : {},
          );
          break;
        }
        case 'assistant_reset': {
          set((state) => (state.run ? { run: { ...state.run, text: event.text } } : {}));
          break;
        }
        case 'tool_call_started':
        case 'tool_call_updated': {
          set((state) => {
            if (!state.run) return {};
            const existingIndex = state.run.toolCalls.findIndex((call) => call.id === event.call.id);
            const toolCalls =
              existingIndex >= 0
                ? state.run.toolCalls.map((call, index) =>
                    index === existingIndex ? event.call : call,
                  )
                : [...state.run.toolCalls, event.call];
            return { run: { ...state.run, toolCalls } };
          });
          break;
        }
        case 'permission_request': {
          get().handlePermissionRequest(event.request);
          break;
        }
        case 'permission_resolved': {
          get().handlePermissionResolved(event.requestId);
          break;
        }
        case 'message_saved': {
          set((state) => {
            const exists = state.messages.some((message) => message.id === event.message.id);
            const messages = exists ? state.messages : [...state.messages, event.message];
            const isCurrentChat = state.chat?.id === event.message.chatId;
            return {
              messages: isCurrentChat ? messages : state.messages,
              run:
                state.run && event.message.role === 'assistant'
                  ? { ...state.run, status: 'completed', text: '', toolCalls: [] }
                  : state.run,
            };
          });
          void get().refreshChats();
          break;
        }
        case 'plan_updated': {
          set({ plan: event.plan, tasks: event.tasks });
          break;
        }
        case 'task_updated': {
          set((state) => ({
            tasks: state.tasks.map((task) => (task.id === event.task.id ? event.task : task)),
          }));
          break;
        }
        case 'context_report': {
          set((state) =>
            state.run ? { run: { ...state.run, contextReport: event.report } } : {},
          );
          break;
        }
        case 'run_finished': {
          set((state) =>
            state.run
              ? {
                  run: {
                    ...state.run,
                    status: event.status,
                    detail: event.error ?? state.run.detail,
                  },
                }
              : {},
          );
          const runId = event.runId;
          if (event.status === 'error' || event.status === 'limit') {
            toast(event.error ?? 'The run stopped unexpectedly.', 'error');
          } else if (event.status === 'cancelled') {
            toast('Run cancelled. Completed work was preserved.', 'warning');
          }
          void get().refreshChats();
          void get().refreshPlan();
          void get().refreshGit();
          void refreshTabsAfterRun();
          set((state) => ({ treeVersion: state.treeVersion + 1 }));
          window.setTimeout(() => {
            set((state) => (state.run?.runId === runId ? { run: null } : {}));
          }, 1800);
          break;
        }
        case 'log': {
          if (event.level === 'warn' || event.level === 'error') {
            toast(event.text, event.level === 'error' ? 'error' : 'warning');
          }
          set((state) =>
            state.run ? { run: { ...state.run, detail: event.text } } : {},
          );
          break;
        }
        default:
          break;
      }
    },

    handlePermissionRequest(request) {
      set((state) =>
        state.permissionQueue.some((entry) => entry.id === request.id)
          ? {}
          : { permissionQueue: [...state.permissionQueue, request] },
      );
    },

    handlePermissionResolved(requestId) {
      set((state) => ({
        permissionQueue: state.permissionQueue.filter((request) => request.id !== requestId),
      }));
    },

    handlePullProgress(progress) {
      set({ pull: progress });
      if (progress.error) {
        toast(progress.error, 'error');
      } else if (progress.done) {
        toast(`Model "${progress.model}" is ready.`, 'success');
        void get().refreshProvider(true);
      }
    },

    bumpTree() {
      set((state) => ({ treeVersion: state.treeVersion + 1 }));
    },
  };
});

export { effectiveMode };
export type { ModelInfo };
