/**
 * Executes validated tool calls: schema validation, mode checks, permission
 * prompts, timeouts, real backend execution, and structured results for the
 * model. The model can never fabricate a tool result: only what this module
 * captures is sent back.
 */
import type {
  AppSettings,
  PermissionRequest,
  ToolCallRecord,
  ToolExecutionLogEntry,
} from '@shared/app-types';
import { AppError } from '../util/errors';
import { nowIso, shortRandom } from '../util/ids';
import type { PermissionService } from '../permissions/permission-service';
import { normalizeToolResult } from './result-validator';
import type { ToolContext, ToolRegistry } from './tool-registry';
import { ToolError } from './tool-registry';

export interface ExecuteToolParams {
  call: { id: string; name: string; arguments: unknown };
  ctx: ToolContext;
  settings: AppSettings;
  onUpdate?: (record: ToolCallRecord) => void;
  onLog?: (entry: ToolExecutionLogEntry) => void | Promise<void>;
}

export interface ToolExecutionOutcome {
  record: ToolCallRecord;
  /** Text returned to the model as the tool message. */
  modelContent: string;
  ok: boolean;
  denied: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof AppError || error instanceof ToolError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissions: PermissionService,
  ) {}

  async execute(params: ExecuteToolParams): Promise<ToolExecutionOutcome> {
    const startedAtMs = Date.now();
    const { call, ctx, settings } = params;
    const tool = this.registry.get(call.name);
    const record: ToolCallRecord = {
      id: `tc_${shortRandom(8)}`,
      name: call.name,
      args: call.arguments,
      status: 'pending',
      startedAt: nowIso(),
      finishedAt: null,
      durationMs: null,
      result: null,
      error: null,
      permission: null,
      risk: tool?.risk ?? 'medium',
      summary: tool?.name ?? call.name,
      details: {},
      diff: null,
    };

    const emit = (): void => {
      params.onUpdate?.({ ...record });
    };

    const fail = async (
      status: ToolCallRecord['status'],
      message: string,
      modelContent: string,
    ): Promise<ToolExecutionOutcome> => {
      record.status = status;
      record.error = message.slice(0, 8000);
      record.finishedAt = nowIso();
      record.durationMs = Date.now() - startedAtMs;
      emit();
      await this.log(params, record);
      return {
        record,
        modelContent,
        ok: false,
        denied: status === 'denied' || status === 'cancelled',
      };
    };

    if (!tool) {
      return fail(
        'error',
        `Unknown tool: ${call.name}`,
        `Tool "${call.name}" does not exist. Available tools are listed in your instructions. Do not claim any action was performed.`,
      );
    }
    if (settings.disabledTools.includes(tool.name)) {
      return fail(
        'denied',
        `Tool "${tool.name}" is disabled in this project.`,
        `Tool "${tool.name}" is disabled. The action was NOT executed.`,
      );
    }
    if (!tool.modes.includes(ctx.mode)) {
      return fail(
        'denied',
        `Tool "${tool.name}" is not available in ${ctx.mode === 'plan' ? 'Plan' : 'Build'} Mode.`,
        `Tool "${tool.name}" is not available in ${ctx.mode} mode. The action was NOT executed.`,
      );
    }
    if (ctx.mode === 'plan' && tool.mutating && tool.category !== 'memory') {
      return fail(
        'denied',
        'Plan Mode cannot execute mutating tools.',
        'Plan Mode is read-only. The mutation was NOT executed. Present a plan instead.',
      );
    }

    const parsed = tool.inputSchema.safeParse(call.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
        .join('; ');
      return fail(
        'error',
        `Invalid arguments: ${issues}`,
        `The arguments for tool "${tool.name}" are invalid: ${issues}. The action was NOT executed. Fix the arguments and retry.`,
      );
    }
    const input = parsed.data;

    let summary = tool.name;
    let details: Record<string, string> = {};
    try {
      const described = tool.summarize(input, ctx);
      summary = described.summary;
      details = described.details;
    } catch {
      /* summarization is cosmetic */
    }
    record.summary = summary.slice(0, 500);
    record.details = details;
    emit();

    if (ctx.signal.aborted) {
      return fail('cancelled', 'The run was cancelled.', 'The run was cancelled before this tool executed.');
    }

    let permissionSpec;
    try {
      permissionSpec = tool.permission(input, ctx);
    } catch (error) {
      return fail('error', errorMessage(error), `Tool preparation failed: ${errorMessage(error)}`);
    }
    record.risk = permissionSpec.risk;
    record.details = { ...permissionSpec.details, ...details };

    if (permissionSpec.details.blocked === 'true') {
      const reason = permissionSpec.details.reason ?? 'This action is blocked by the safety policy.';
      return fail(
        'denied',
        reason,
        `BLOCKED: ${reason} The action was NOT executed and cannot be approved from chat.`,
      );
    }

    const request: PermissionRequest = {
      id: `permreq_${shortRandom(8)}`,
      runId: ctx.runId ?? 'manual',
      projectId: ctx.project.id,
      chatId: ctx.chat.id,
      toolName: tool.name,
      category: permissionSpec.category,
      actionKey: permissionSpec.actionKey,
      alwaysKey: permissionSpec.alwaysKey,
      title: summary,
      description: `${tool.description.split('\n')[0]}${permissionSpec.risk === 'high' ? ' (high risk)' : ''}`,
      risk: permissionSpec.risk,
      details: permissionSpec.details,
      allowAlwaysLabel: permissionSpec.allowAlwaysLabel,
      createdAt: nowIso(),
    };

    record.status = 'awaiting_permission';
    emit();
    let outcome;
    try {
      outcome = await this.permissions.authorize({
        request,
        settings,
        risk: permissionSpec.risk,
        commandRisk: permissionSpec.commandRisk,
        isDelete: permissionSpec.isDelete,
      });
    } catch (error) {
      return fail('error', errorMessage(error), `Permission check failed: ${errorMessage(error)}`);
    }
    record.permission = outcome.source === 'denied' ? 'denied' : outcome.source;
    if (!outcome.allowed) {
      return fail(
        'denied',
        outcome.reason,
        `PERMISSION DENIED for tool "${tool.name}": ${outcome.reason} The action was NOT executed. Do not retry the same action; explain the situation to the user or choose a safe alternative.`,
      );
    }
    if (ctx.signal.aborted) {
      return fail('cancelled', 'The run was cancelled.', 'The run was cancelled before this tool executed.');
    }

    record.status = 'running';
    emit();

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    ctx.signal.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ToolError(`Tool "${tool.name}" timed out after ${tool.timeoutMs} ms.`, 'TIMEOUT'));
      }, tool.timeoutMs);
      timer.unref?.();
    });

    try {
      const result = await Promise.race([
        tool.execute(input, { ...ctx, signal: controller.signal }),
        timeoutPromise,
      ]);
      const normalized = normalizeToolResult(result);
      record.status = 'success';
      record.result = normalized.storedContent;
      record.summary = normalized.summary || record.summary;
      record.diff = normalized.diff ?? null;
      record.details = { ...record.details, ...normalized.details };
      record.finishedAt = nowIso();
      record.durationMs = Date.now() - startedAtMs;
      emit();
      await this.log(params, record);
      return { record, modelContent: normalized.content, ok: true, denied: false };
    } catch (error) {
      if (ctx.signal.aborted && !timedOut) {
        return fail(
          'cancelled',
          'The run was cancelled.',
          'The run was cancelled while this tool was running. Its final state is unknown; verify before continuing.',
        );
      }
      const message = errorMessage(error);
      return fail(
        'error',
        message,
        `Tool "${tool.name}" failed: ${message}\nThe action may be incomplete. Inspect the actual state before continuing.`,
      );
    } finally {
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener('abort', abort);
    }
  }

  private async log(params: ExecuteToolParams, record: ToolCallRecord): Promise<void> {
    if (!params.onLog) return;
    const entry: ToolExecutionLogEntry = {
      id: `log_${shortRandom(6)}`,
      toolCallId: record.id,
      projectId: params.ctx.project.id,
      chatId: params.ctx.chat.id,
      runId: params.ctx.runId,
      toolName: record.name,
      args: record.args,
      status: record.status,
      permission: record.permission,
      resultPreview: (record.result ?? '').slice(0, 2000),
      error: record.error,
      startedAt: record.startedAt ?? nowIso(),
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
    };
    try {
      await params.onLog(entry);
    } catch {
      /* logging failures must not affect tool outcomes */
    }
  }
}
