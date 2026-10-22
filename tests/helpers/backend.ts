import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Backend, type BackendEmitters } from '../../src/backend/application/backend';
import { AgentRuntime } from '../../src/backend/agent/agent-runtime';
import type { ToolContext } from '../../src/backend/agent/tool-registry';
import type { Provider, ChatRequest } from '../../src/backend/providers/provider-interface';
import type {
  AgentEvent,
  Chat,
  GenerationResult,
  ModelInfo,
  ModelTestResult,
  Project,
  ProviderStatus,
  PullProgress,
} from '@shared/app-types';

export const noopEmitters: BackendEmitters = {
  agentEvent: () => undefined,
  terminalChunk: () => undefined,
  terminalExit: () => undefined,
  pullProgress: () => undefined,
  storageWarning: () => undefined,
  permissionRequest: () => undefined,
  permissionResolved: () => undefined,
};

export interface TestBackend {
  backend: Backend;
  root: string;
  dataDirectory: string;
  cleanup: () => Promise<void>;
}

export async function createTestBackend(): Promise<TestBackend> {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp', 'laie-test-'));
  const documentsDirectory = path.join(root, 'documents');
  const dataDirectory = path.join(root, 'data');
  const userDataDirectory = path.join(root, 'user-data');
  await fs.mkdir(documentsDirectory, { recursive: true });
  const backend = await Backend.create({
    userDataDirectory,
    documentsDirectory,
    dataDirectoryOverride: dataDirectory,
    appVersion: 'test',
    electronVersion: 'test',
    nodeVersion: process.version,
    chromeVersion: 'test',
    isDev: false,
    emitters: noopEmitters,
  });
  return {
    backend,
    root,
    dataDirectory,
    cleanup: async () => {
      await backend.shutdown();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function createProjectWithWorkspace(
  backend: Backend,
  root: string,
  name: string,
): Promise<Project> {
  const workspacePath = path.join(root, 'workspaces', name);
  await fs.mkdir(workspacePath, { recursive: true });
  return backend.projects.create({
    name,
    workspacePath,
    createWorkspace: false,
    initializeGit: false,
  });
}

export interface EventCollector {
  emit: (event: AgentEvent) => void;
  events: AgentEvent[];
  waitForRun: (runId: string, timeoutMs?: number) => Promise<AgentEvent & { type: 'run_finished' }>;
}

export function createEventCollector(): EventCollector {
  const events: AgentEvent[] = [];
  const watchers = new Map<string, (event: AgentEvent & { type: 'run_finished' }) => void>();
  return {
    emit: (event) => {
      events.push(event);
      if (event.type === 'run_finished') watchers.get(event.runId)?.(event);
    },
    events,
    waitForRun: (runId, timeoutMs = 20000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Run ${runId} did not finish in time`)), timeoutMs);
        watchers.set(runId, (event) => {
          clearTimeout(timer);
          resolve(event);
        });
      }),
  };
}

export function buildAgentRuntime(
  backend: Backend,
  provider: Provider,
  collector?: EventCollector,
): AgentRuntime {  return new AgentRuntime({
    storage: backend.storage,
    settings: () => backend.settings.get(),
    projects: backend.projects,
    chats: backend.chats,
    tasks: backend.tasks,
    memory: backend.memory,
    workspace: backend.workspace,
    commands: backend.commands,
    git: backend.git,
    permissions: backend.permissions,
    tools: backend.tools,
    executor: backend.executor,
    provider,
    contextBuilder: backend.contextBuilder,
    cache: backend.cache,
    logger: backend.logger,
    emit: collector?.emit ?? (() => undefined),
  });
}

export function buildToolContext(
  backend: Backend,
  project: Project,
  chat: Chat,
  options: { mode?: 'plan' | 'build'; signal?: AbortSignal } = {},
): ToolContext {
  return {
    project,
    chat,
    mode: options.mode ?? 'build',
    runId: 'run_test',
    settings: backend.settings.get(),
    signal: options.signal ?? new AbortController().signal,
    services: {
      workspace: backend.workspace,
      projects: backend.projects,
      chats: backend.chats,
      tasks: backend.tasks,
      memory: backend.memory,
      commands: backend.commands,
      git: backend.git,
    },
    invalidateContext: () => undefined,
  };
}

interface MockModel {
  id: string;
  supportsTools: boolean;
}

/**
 * Deterministic in-process provider. Tests queue responses; the provider records
 * every request so tool schemas and messages can be asserted.
 */
export class MockProvider implements Provider {
  readonly name = 'ollama' as const;
  readonly requests: ChatRequest[] = [];
  private readonly queue: GenerationResult[] = [];
  readonly models: MockModel[];
  delayMs = 0;
  /** When true the next chat call waits until its abort signal fires. */
  hang = false;

  constructor(models: MockModel[] = [{ id: 'mock-model', supportsTools: true }]) {
    this.models = models;
  }

  queueText(content: string): void {
    this.queue.push({
      content,
      toolCalls: [],
      promptTokens: null,
      completionTokens: null,
      model: this.models[0].id,
    });
  }

  queueToolCalls(
    calls: Array<{ name: string; arguments: unknown }>,
    content = '',
  ): void {
    this.queue.push({
      content,
      toolCalls: calls.map((call, index) => ({
        id: `call_${this.queue.length}_${index}`,
        name: call.name,
        arguments: call.arguments,
      })),
      promptTokens: null,
      completionTokens: null,
      model: this.models[0].id,
    });
  }

  private modelInfos(): ModelInfo[] {
    return this.models.map((model) => ({
      id: model.id,
      name: model.id,
      sizeBytes: 1,
      family: 'mock',
      parameterSize: '1B',
      quantization: 'Q4',
      contextLength: 16384,
      capabilities: model.supportsTools ? ['completion', 'tools'] : ['completion'],
      supportsTools: model.supportsTools,
      modifiedAt: null,
    }));
  }

  async ping(): Promise<{ connected: boolean; version: string | null; error: string | null }> {
    return { connected: true, version: 'mock', error: null };
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.modelInfos();
  }

  async status(): Promise<ProviderStatus> {
    return {
      provider: 'ollama',
      baseUrl: 'mock://',
      connected: true,
      version: 'mock',
      error: null,
      models: this.modelInfos(),
      checkedAt: new Date().toISOString(),
    };
  }

  async chat(request: ChatRequest): Promise<GenerationResult> {
    this.requests.push(request);
    if (this.hang) {
      this.hang = false;
      return new Promise<GenerationResult>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(new Error('Request aborted')),
          { once: true },
        );
      });
    }
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    const next = this.queue.shift();
    if (!next) {
      return {
        content: 'Done.',
        toolCalls: [],
        promptTokens: null,
        completionTokens: null,
        model: this.models[0].id,
      };
    }
    if (next.content) request.onToken?.(next.content);
    return next;
  }

  async pull(
    _model: string,
    onProgress: (progress: PullProgress) => void,
    _signal: AbortSignal,
  ): Promise<void> {
    onProgress({
      model: _model,
      status: 'success',
      completed: 1,
      total: 1,
      percent: 100,
      done: true,
      error: null,
    });
  }

  async test(model: string): Promise<ModelTestResult> {
    return { ok: true, model, response: 'pong', durationMs: 1, error: null };
  }
}
