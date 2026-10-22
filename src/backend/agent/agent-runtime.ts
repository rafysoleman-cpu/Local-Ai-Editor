/**
 * Agent runtime.
 *
 * A real execution loop: build context -> call the local model -> parse and
 * validate tool calls -> check permissions -> execute in the backend -> return
 * real results -> repeat until done, cancelled or a limit is reached. Every step
 * is streamed to the UI as an AgentEvent and persisted as real chat messages.
 */
import {
  type AgentEvent,
  type AgentRunState,
  type AgentStatusPhase,
  type AppSettings,
  type Chat,
  type ChatMessage,
  type ChatTurn,
  type GenerationResult,
  type Plan,
  type Project,
  type Task,
  type ToolCallRecord,
} from '@shared/app-types';
import { STORAGE_PATHS } from '../storage/paths';
import type { FileStorage } from '../storage/file-storage';
import type { Logger } from '../logging/logger';
import type { ProjectService } from '../projects/project-service';
import type { WorkspaceService } from '../projects/workspace-service';
import type { ChatService } from '../application/chat-service';
import type { TaskService } from '../application/task-service';
import type { MemoryService } from '../memory/memory-service';
import type { CommandService } from '../terminal/command-service';
import type { GitService } from '../tools/git/git-service';
import type { PermissionService } from '../permissions/permission-service';
import type { Provider } from '../providers/provider-interface';
import type { ContextCache } from '../cache/context-cache';
import { AppError } from '../util/errors';
import { nowIso, shortRandom } from '../util/ids';
import type { ContextBuilder } from './context-builder';
import { RunCancellation } from './cancellation';
import { ExecutionLimits } from './execution-limits';
import { WorkspaceLock } from './workspace-lock';
import type { ToolExecutor } from './tool-executor';
import type { ToolContext, ToolRegistry } from './tool-registry';
import { selectModel } from '../providers/model-catalog';

const MAX_TOOL_MESSAGE_CHARS = 16_000;
const PLAN_GATE_EXEMPTIONS = new Set([
  'save_plan',
  'update_task_status',
  'update_project_memory',
  'read_project_memory',
  'get_task_status',
]);

export interface AgentRuntimeDeps {
  storage: FileStorage;
  settings: () => AppSettings;
  projects: ProjectService;
  chats: ChatService;
  tasks: TaskService;
  memory: MemoryService;
  workspace: WorkspaceService;
  commands: CommandService;
  git: GitService;
  permissions: PermissionService;
  tools: ToolRegistry;
  executor: ToolExecutor;
  provider: Provider;
  contextBuilder: ContextBuilder;
  cache: ContextCache;
  logger: Logger;
  emit: (event: AgentEvent) => void;
}

interface ActiveRun {
  state: AgentRunState;
  cancellation: RunCancellation;
  limits: ExecutionLimits;
}

export interface StartAgentInput {
  projectId: string;
  chatId: string;
  prompt: string;
  mode: 'plan' | 'build';
}

function phaseForTool(toolName: string): AgentStatusPhase {
  if (toolName === 'run_command') return 'running_command';
  if (toolName.startsWith('run_')) return 'running_tests';
  if (['write_file', 'edit_file', 'create_file', 'create_directory', 'rename_file', 'delete_file'].includes(toolName)) {
    return 'editing_files';
  }
  if (['git_status', 'git_diff', 'git_log', 'git_branch_info'].includes(toolName)) return 'inspecting';
  if (toolName.startsWith('get_') || ['list_files', 'read_file', 'read_multiple_files', 'grep_search', 'find_symbol', 'find_references', 'search_files', 'check_environment'].includes(toolName)) {
    return 'inspecting';
  }
  return 'thinking';
}

export class AgentRuntime {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly lock = new WorkspaceLock();

  constructor(private readonly deps: AgentRuntimeDeps) {}

  listRuns(): AgentRunState[] {
    return [...this.runs.values()].map((run) => ({ ...run.state }));
  }

  async start(input: StartAgentInput): Promise<{ runId: string }> {
    const settings = this.deps.settings();
    const project = await this.deps.projects.require(input.projectId);
    const chat = await this.deps.chats.require(input.projectId, input.chatId);
    const prompt = input.prompt.trim();
    if (!prompt) throw new AppError('Type a message first.', 'INVALID');

    if (this.runs.size > 0) {
      for (const run of this.runs.values()) {
        if (run.state.chatId === chat.id) {
          throw new AppError('This chat is already running. Stop it before sending another message.', 'CONFLICT');
        }
      }
    }
    const holder = this.lock.holder(project.id);
    if (holder) {
      throw new AppError(
        `Another run is already working in this project (started ${holder.startedAt}). Finish or cancel it first; Build Mode never runs twice in the same workspace.`,
        'CONFLICT',
      );
    }

    let models;
    try {
      models = await this.deps.provider.listModels();
    } catch (error) {
      throw new AppError(
        `Cannot reach the local model provider: ${(error as Error).message}`,
        'PROVIDER',
      );
    }
    const selection = selectModel(chat.model ?? project.defaultModel, settings.defaultModel, models);
    if (selection.error || !selection.model) {
      throw new AppError(selection.error ?? 'No model selected.', 'PROVIDER');
    }
    const model = selection.model;

    if (input.mode === 'build') {
      const current = await this.deps.tasks.listForChat(project.id, chat.id);
      if (current?.plan.status === 'draft') {
        throw new AppError(
          `This chat has a draft plan awaiting approval ("${current.plan.title}"). Approve it in the plan panel before running Build Mode.`,
          'CONFLICT',
        );
      }
    }

    const runId = `run_${shortRandom(8)}`;
    if (!this.lock.acquire(project.id, { runId, chatId: chat.id, startedAt: nowIso() }).ok) {
      throw new AppError('Another run is already active in this project.', 'CONFLICT');
    }

    const cancellation = new RunCancellation();
    const limits = new ExecutionLimits(settings.limits, settings.limits.maxRunMs);
    const state: AgentRunState = {
      runId,
      projectId: project.id,
      chatId: chat.id,
      mode: input.mode,
      status: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      error: null,
      toolCallCount: 0,
    };
    this.runs.set(runId, { state, cancellation, limits });

    const userMessage: ChatMessage = {
      id: `m_${shortRandom(8)}`,
      chatId: chat.id,
      projectId: project.id,
      role: 'user',
      content: prompt,
      createdAt: nowIso(),
      mode: input.mode,
      model: model.id,
      toolCalls: [],
      contextReport: null,
      error: null,
      interrupted: false,
    };

    try {
      await this.deps.chats.appendMessage(project.id, chat.id, userMessage);
      if (chat.mode !== input.mode) {
        await this.deps.chats.update({ projectId: project.id, chatId: chat.id, mode: input.mode });
      }
      await this.deps.chats.setStatus(project.id, chat.id, 'running');
    } catch (error) {
      this.lock.release(project.id, runId);
      this.runs.delete(runId);
      throw error;
    }

    this.emit({
      type: 'run_started',
      runId,
      projectId: project.id,
      chatId: chat.id,
      mode: input.mode,
      model: model.id,
      userMessage,
    });
    if (selection.note) {
      this.emit({ type: 'log', runId, level: 'warn', text: selection.note });
    }
    if (!model.supportsTools) {
      this.emit({
        type: 'log',
        runId,
        level: 'warn',
        text: `The model "${model.id}" does not report tool support. If it cannot produce structured tool calls, the agent will report that instead of pretending an action happened.`,
      });
    }

    void this.executeRun({
      runId,
      project,
      chat,
      mode: input.mode,
      modelId: model.id,
      prompt,
      userMessage,
      cancellation,
      limits,
      settings,
    }).catch((error) => {
      // executeRun handles its own errors; this is a final safety net.
      this.deps.logger.error('agent', 'Unhandled agent loop failure', {
        runId,
        error: (error as Error).message,
      });
      this.lock.release(project.id, runId);
      this.runs.delete(runId);
      this.emit({
        type: 'run_finished',
        runId,
        status: 'error',
        error: (error as Error).message,
      });
    });

    return { runId };
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new AppError(`Run not found or already finished: ${runId}`, 'NOT_FOUND');
    run.cancellation.cancel();
    this.deps.permissions.cancelRun(runId);
    this.deps.logger.info('agent', 'Run cancellation requested', { runId, chatId: run.state.chatId });
  }

  private emit(event: AgentEvent): void {
    try {
      this.deps.emit(event);
    } catch (error) {
      this.deps.logger.warn('agent', 'Failed to emit agent event', { error: (error as Error).message });
    }
  }

  private async loadPlan(projectId: string, chatId: string): Promise<{ plan: Plan; tasks: Task[] } | null> {
    try {
      return await this.deps.tasks.listForChat(projectId, chatId);
    } catch {
      return null;
    }
  }

  private async reloadPlan(
    runId: string,
    projectId: string,
    chatId: string,
  ): Promise<{ plan: Plan; tasks: Task[] } | null> {
    const current = await this.loadPlan(projectId, chatId);
    this.emit({ type: 'plan_updated', runId, plan: current?.plan ?? null, tasks: current?.tasks ?? [] });
    return current;
  }

  private async executeRun(input: {
    runId: string;
    project: Project;
    chat: Chat;
    mode: 'plan' | 'build';
    modelId: string;
    prompt: string;
    userMessage: ChatMessage;
    cancellation: RunCancellation;
    limits: ExecutionLimits;
    settings: AppSettings;
  }): Promise<void> {
    const { runId, project, chat, mode, modelId, prompt, userMessage, cancellation, limits, settings } = input;
    const run = this.runs.get(runId);
    limits.start();
    let finalStatus: 'completed' | 'cancelled' | 'error' | 'limit' = 'completed';
    let finalError: string | null = null;
    let assistantText = '';
    const toolRecords: ToolCallRecord[] = [];
    let contextReport: ChatMessage['contextReport'] = null;
    let plan: Plan | null = null;
    let tasks: Task[] = [];

    try {
      const history = (await this.deps.chats.messages(project.id, chat.id)).filter(
        (message) => message.id !== userMessage.id,
      );
      const initialPlan = await this.loadPlan(project.id, chat.id);
      plan = initialPlan?.plan ?? null;
      tasks = initialPlan?.tasks ?? [];
      let planGate = mode === 'build' && !(plan && ['approved', 'in_progress'].includes(plan.status));

      const toolList = this.deps.tools.describeForPrompt(mode, settings.disabledTools);
      const built = await this.deps.contextBuilder.build({
        project,
        chat,
        mode,
        userPrompt: prompt,
        settings,
        modelId,
        history,
        plan,
        tasks,
        toolList,
      });
      contextReport = built.report;
      this.emit({ type: 'context_report', runId, report: built.report });
      this.emit({
        type: 'status',
        runId,
        phase: 'thinking',
        detail: `Contacting ${modelId} (context ≈ ${built.report.estimatedTokens} tokens, cache ${built.report.cache})`,
      });

      let conversation: ChatTurn[] = built.messages;
      const toolDefinitions = this.deps.tools.forModel(mode, settings.disabledTools);
      const startedCalls = new Set<string>();

      while (true) {
        if (cancellation.aborted) {
          finalStatus = 'cancelled';
          finalError = cancellation.reason ?? 'Cancelled by the user.';
          break;
        }
        const limitReason = limits.check();
        if (limitReason) {
          finalStatus = 'limit';
          finalError = limitReason;
          break;
        }
        if (!limits.beginIteration()) {
          finalStatus = 'limit';
          finalError = limits.stoppedReason ?? 'Execution limit reached.';
          break;
        }

        let iterationText = '';
        let result: GenerationResult | null = null;
        let providerFailure: Error | null = null;
        for (let attempt = 0; attempt <= settings.limits.maxModelRetries; attempt += 1) {
          iterationText = '';
          try {
            result = await this.deps.provider.chat({
              model: modelId,
              messages: conversation,
              tools: toolDefinitions,
              options: {
                temperature: settings.generation.temperature,
                topP: settings.generation.topP,
                numCtx: settings.generation.numCtx,
              },
              signal: cancellation.signal,
              onToken: (text) => {
                if (cancellation.aborted) return;
                iterationText += text;
                this.emit({ type: 'assistant_delta', runId, text });
              },
            });
            providerFailure = null;
            break;
          } catch (error) {
            providerFailure = error as Error;
            if (cancellation.aborted) break;
            const retryable =
              attempt < settings.limits.maxModelRetries &&
              (error as { code?: string }).code !== 'CANCELLED';
            if (!retryable) break;
            this.emit({
              type: 'log',
              runId,
              level: 'warn',
              text: `Model request failed (${(error as Error).message}). Retrying (${attempt + 1}/${settings.limits.maxModelRetries})…`,
            });
            await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
            this.emit({ type: 'assistant_reset', runId, text: assistantText });
          }
        }

        if (!result) {
          if (cancellation.aborted) {
            finalStatus = 'cancelled';
            finalError = cancellation.reason ?? 'Cancelled by the user.';
          } else {
            finalStatus = 'error';
            finalError = providerFailure?.message ?? 'The model did not return a response.';
          }
          break;
        }

        if (result.content && !iterationText) {
          // Providers that do not stream still need to show the text.
          iterationText = result.content;
          this.emit({ type: 'assistant_delta', runId, text: result.content });
        }
        assistantText += iterationText;

        const toolCalls = result.toolCalls;
        if (toolCalls.length === 0) {
          finalStatus = 'completed';
          break;
        }

        conversation.push({
          role: 'assistant',
          content: iterationText,
          tool_calls: toolCalls.map((call) => ({
            function: { name: call.name, arguments: call.arguments },
          })),
        });

        this.emit({
          type: 'status',
          runId,
          phase: 'thinking',
          detail: `Executing ${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'}…`,
        });

        for (const call of toolCalls) {
          if (cancellation.aborted) {
            finalStatus = 'cancelled';
            finalError = cancellation.reason ?? 'Cancelled by the user.';
            break;
          }
          if (!limits.beforeToolCall()) {
            finalStatus = 'limit';
            finalError = limits.stoppedReason ?? 'Execution limit reached.';
            break;
          }

          let outcome;
          const gateBlocked =
            planGate && !PLAN_GATE_EXEMPTIONS.has(call.name) && this.deps.tools.get(call.name)?.mutating === true;
          if (gateBlocked) {
            outcome = this.gatedToolOutcome(call, project, chat, runId);
          } else {
            limits.recordToolCall();
            const ctx: ToolContext = {
              project,
              chat,
              mode,
              runId,
              settings,
              signal: cancellation.signal,
              services: {
                workspace: this.deps.workspace,
                projects: this.deps.projects,
                chats: this.deps.chats,
                tasks: this.deps.tasks,
                memory: this.deps.memory,
                commands: this.deps.commands,
                git: this.deps.git,
              },
              invalidateContext: (reason) => this.deps.cache.invalidateProject(project.id, reason),
            };
            outcome = await this.deps.executor.execute({
              call,
              ctx,
              settings,
              onUpdate: (record) => {
                if (!startedCalls.has(record.id)) {
                  startedCalls.add(record.id);
                  this.emit({ type: 'tool_call_started', runId, call: record });
                } else {
                  this.emit({ type: 'tool_call_updated', runId, call: record });
                }
                if (record.status === 'awaiting_permission') {
                  this.emit({
                    type: 'status',
                    runId,
                    phase: 'awaiting_permission',
                    detail: `Waiting for approval: ${record.summary}`,
                  });
                } else if (record.status === 'running') {
                  this.emit({
                    type: 'status',
                    runId,
                    phase: phaseForTool(record.name),
                    detail: record.summary,
                  });
                }
              },
              onLog: (entry) => {
                void this.deps.storage
                  .appendJsonLine(STORAGE_PATHS.executionsLog(project.id), entry)
                  .catch(() => undefined);
              },
            });
          }

          toolRecords.push(outcome.record);
          this.emit({ type: 'tool_call_updated', runId, call: outcome.record });
          if (run) {
            run.state.toolCallCount = limits.toolCallCount;
          }

          if (outcome.ok) {
            limits.recordSuccess(call.name);
          } else {
            const failureLimit = limits.recordFailure(call.name, outcome.record.error ?? 'failed');
            if (failureLimit) {
              finalStatus = 'limit';
              finalError = failureLimit;
            }
          }

          const toolContent =
            outcome.modelContent.length > MAX_TOOL_MESSAGE_CHARS
              ? `${outcome.modelContent.slice(0, MAX_TOOL_MESSAGE_CHARS)}\n\n[tool output truncated for the conversation]`
              : outcome.modelContent;
          conversation.push({ role: 'tool', tool_name: call.name, content: toolContent });

          if (call.name === 'save_plan' || call.name === 'update_task_status') {
            const refreshed = await this.reloadPlan(runId, project.id, chat.id);
            plan = refreshed?.plan ?? null;
            tasks = refreshed?.tasks ?? [];
            if (mode === 'build' && plan && ['approved', 'in_progress'].includes(plan.status)) {
              planGate = false;
            }
          }

          if (finalStatus === 'limit') break;
        }

        if (finalStatus !== 'completed') break;
        conversation = this.fitConversation(conversation, settings, assistantText);
      }
    } catch (error) {
      finalStatus = cancellation.aborted ? 'cancelled' : 'error';
      finalError = (error as Error).message;
      this.deps.logger.error('agent', 'Agent run failed', { runId, error: finalError });
    }

    await this.finalizeRun({
      runId,
      project,
      chat,
      mode,
      modelId,
      assistantText,
      toolRecords,
      contextReport,
      finalStatus,
      finalError,
      plan,
      tasks,
      limits,
      cancellation,
    });
  }

  private gatedToolOutcome(
    call: { id: string; name: string; arguments: unknown },
    project: Project,
    chat: Chat,
    runId: string,
  ): { record: ToolCallRecord; modelContent: string; ok: boolean; denied: boolean } {
    const message =
      'Build Mode requires a plan before changing files. Call save_plan first (use internal: true for a small plan of at most 5 tasks).';
    const record: ToolCallRecord = {
      id: `tc_${shortRandom(8)}`,
      name: call.name,
      args: call.arguments,
      status: 'denied',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      durationMs: 0,
      result: null,
      error: message,
      permission: 'denied',
      risk: 'medium',
      summary: `Blocked: ${call.name} needs an approved plan`,
      details: { projectId: project.id, chatId: chat.id, runId },
      diff: null,
    };
    this.emit({ type: 'tool_call_started', runId, call: record });
    return {
      record,
      modelContent: `BLOCKED: ${message} The action was NOT executed.`,
      ok: false,
      denied: true,
    };
  }

  private fitConversation(
    conversation: ChatTurn[],
    settings: AppSettings,
    committedText: string,
  ): ChatTurn[] {
    const budget = Math.floor(settings.context.maxChars * 1.1);
    const total = conversation.reduce((sum, turn) => sum + turn.content.length, 0);
    if (total <= budget) return conversation;
    const system = conversation[0];
    if (!system || system.role !== 'system') return conversation;
    let used = system.content.length;
    const kept: ChatTurn[] = [];
    for (let index = conversation.length - 1; index >= 1; index -= 1) {
      const turn = conversation[index];
      const size = turn.content.length;
      if (used + size > budget * 0.9) break;
      kept.unshift(turn);
      used += size;
    }
    while (kept.length > 0 && kept[0].role === 'tool') kept.shift();
    if (kept.length === 0) return conversation;
    const note = kept.length < conversation.length - 1 ? '\n\n[Earlier conversation turns were omitted to fit the context budget.]' : '';
    this.deps.logger.debug('agent', 'Conversation compacted for context budget', {
      dropped: conversation.length - 1 - kept.length,
      committedChars: committedText.length,
    });
    return [{ ...system, content: `${system.content}${note}` }, ...kept];
  }

  private async finalizeRun(input: {
    runId: string;
    project: Project;
    chat: Chat;
    mode: 'plan' | 'build';
    modelId: string;
    assistantText: string;
    toolRecords: ToolCallRecord[];
    contextReport: ChatMessage['contextReport'];
    finalStatus: 'completed' | 'cancelled' | 'error' | 'limit';
    finalError: string | null;
    plan: Plan | null;
    tasks: Task[];
    limits: ExecutionLimits;
    cancellation: RunCancellation;
  }): Promise<void> {
    const { runId, project, chat, mode, modelId } = input;
    let status = input.finalStatus;
    let error = input.finalError;

    if (input.cancellation.aborted && status === 'completed') {
      status = 'cancelled';
      error = input.cancellation.reason ?? 'Cancelled by the user.';
    }

    let plan = input.plan;
    let tasks = input.tasks;
    try {
      const refreshed = await this.deps.tasks.listForChat(project.id, chat.id);
      plan = refreshed?.plan ?? plan;
      tasks = refreshed?.tasks ?? tasks;
    } catch {
      /* keep the last known plan */
    }

    let content = input.assistantText.trim();
    if (!content) {
      if (status === 'error') content = `The run failed: ${error ?? 'unknown error'}`;
      else if (status === 'cancelled') content = 'Run cancelled before the model produced a response.';
      else if (status === 'limit') content = `The run stopped: ${error ?? 'execution limit reached'}`;
      else content = 'The model returned an empty response.';
    }

    const footer: string[] = [];
    if (plan && tasks.length > 0) {
      const completed = tasks.filter((task) => task.status === 'completed').length;
      footer.push(`Plan progress: ${completed}/${tasks.length} tasks complete ("${plan.title}", status: ${plan.status}).`);
      const next = tasks.find((task) => task.status !== 'completed' && task.status !== 'cancelled');
      if (next && plan.status !== 'completed') footer.push(`Next task: ${next.index + 1}. ${next.title}`);
    }
    if (status === 'cancelled' || status === 'limit' || status === 'error') {
      footer.push(`Run status: ${status}${error ? ` — ${error}` : ''}`);
    }
    if (footer.length > 0) {
      content = `${content}\n\n---\n${footer.join('\n')}`;
    }
    if (input.assistantText.trim().length === 0 && input.toolRecords.length > 0) {
      content = `${content}\n\n(No written summary was returned by the model; the tool activity above is the real result.)`;
    }

    const assistantMessage: ChatMessage = {
      id: `m_${shortRandom(8)}`,
      chatId: chat.id,
      projectId: project.id,
      role: 'assistant',
      content,
      createdAt: nowIso(),
      mode,
      model: modelId,
      toolCalls: input.toolRecords,
      contextReport: input.contextReport,
      error: status === 'error' || status === 'limit' ? error : null,
      interrupted: status === 'cancelled',
    };

    const run = this.runs.get(runId);
    if (run) run.state.status = status === 'limit' ? 'limit' : status;

    try {
      await this.deps.chats.appendMessage(project.id, chat.id, assistantMessage);
      this.emit({ type: 'message_saved', runId, message: assistantMessage });
    } catch (persistError) {
      this.deps.logger.error('agent', 'Could not persist assistant message', {
        runId,
        error: (persistError as Error).message,
      });
    }

    try {
      await this.deps.chats.setStatus(
        project.id,
        chat.id,
        status === 'completed' ? 'idle' : status === 'cancelled' ? 'cancelled' : 'error',
      );
    } catch {
      /* chat may have been deleted mid-run */
    }

    if (plan) {
      this.emit({ type: 'plan_updated', runId, plan, tasks });
    }
    this.emit({
      type: 'run_finished',
      runId,
      status,
      error: error ?? null,
    });
    this.deps.logger.info('agent', 'Agent run finished', {
      runId,
      status,
      toolCalls: input.toolRecords.length,
      durationMs: input.limits.elapsedMs,
    });

    this.lock.release(project.id, runId);
    this.runs.delete(runId);
  }
}
