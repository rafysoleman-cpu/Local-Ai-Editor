/**
 * Central tool registry.
 *
 * Every tool declares a stable name, description, JSON-Schema parameters for
 * the model, a Zod schema for server-side validation, a permission category,
 * whether it mutates the workspace, its risk, and execution timeouts.
 */
import { z } from 'zod';
import type {
  AgentMode,
  AppSettings,
  Chat,
  FileDiff,
  PermissionCategory,
  PermissionRisk,
  Project,
  ToolDescriptor,
} from '@shared/app-types';
import type { ProjectService } from '../projects/project-service';
import type { WorkspaceService } from '../projects/workspace-service';
import type { ChatService } from '../application/chat-service';
import type { TaskService } from '../application/task-service';
import type { MemoryService } from '../memory/memory-service';
import type { CommandService } from '../terminal/command-service';
import type { GitService } from '../tools/git/git-service';

export type JsonSchema = Record<string, unknown>;

export interface ToolServices {
  workspace: WorkspaceService;
  projects: ProjectService;
  chats: ChatService;
  tasks: TaskService;
  memory: MemoryService;
  commands: CommandService;
  git: GitService;
}

export interface ToolContext {
  project: Project;
  chat: Chat;
  mode: AgentMode;
  runId: string | null;
  settings: AppSettings;
  signal: AbortSignal;
  services: ToolServices;
  /** Invalidate cached context (file tree / project block) after a mutation. */
  invalidateContext: (reason: string) => void;
}

export interface ToolPermissionSpec {
  category: PermissionCategory;
  risk: PermissionRisk;
  actionKey: string;
  alwaysKey: string | null;
  allowAlwaysLabel: string | null;
  details: Record<string, string>;
  commandRisk?: PermissionRisk;
  isDelete?: boolean;
}

export interface ToolResult {
  /** Text returned to the model and shown in the chat tool card. */
  content: string;
  /** One-line human summary. */
  summary: string;
  diff?: FileDiff;
  details?: Record<string, string>;
  meta?: Record<string, unknown>;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string = 'TOOL_ERROR',
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  category: PermissionCategory;
  mutating: boolean;
  risk: PermissionRisk;
  modes: AgentMode[];
  timeoutMs: number;
  inputSummary: string;
  parameters: JsonSchema;
  inputSchema: z.ZodType<I>;
  summarize(input: I, ctx: ToolContext): { summary: string; details: Record<string, string> };
  permission(input: I, ctx: ToolContext): ToolPermissionSpec;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export type AnyToolDefinition = ToolDefinition<any>;

export type ToolConfig<S extends z.ZodTypeAny> = Omit<ToolDefinition<z.infer<S>>, 'inputSchema'> & {
  inputSchema: S;
};

/**
 * Define a tool. The input type is inferred from the Zod schema, so handlers get
 * fully typed input objects.
 */
export function defineTool<S extends z.ZodTypeAny>(
  definition: ToolConfig<S>,
): ToolDefinition<z.infer<S>> {
  return definition as unknown as ToolDefinition<z.infer<S>>;
}

export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private customTools = new Map<string, AnyToolDefinition>();

  register(tool: AnyToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AnyToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  all(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  setCustomTools(tools: AnyToolDefinition[]): void {
    for (const name of this.customTools.keys()) this.tools.delete(name);
    this.customTools.clear();
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`Custom tool "${tool.name}" conflicts with a built-in tool.`);
      }
      this.tools.set(tool.name, tool);
      this.customTools.set(tool.name, tool);
    }
  }

  isCustom(name: string): boolean {
    return this.customTools.has(name);
  }

  isBuiltin(name: string): boolean {
    return this.tools.has(name) && !this.customTools.has(name);
  }

  enabledTools(mode: AgentMode, disabledTools: string[]): AnyToolDefinition[] {
    return this.all().filter(
      (tool) => tool.modes.includes(mode) && !disabledTools.includes(tool.name),
    );
  }

  forModel(mode: AgentMode, disabledTools: string[]): OllamaToolDefinition[] {
    return this.enabledTools(mode, disabledTools).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  descriptors(disabledTools: string[]): ToolDescriptor[] {
    return this.all()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        mutating: tool.mutating,
        risk: tool.risk,
        source: this.customTools.has(tool.name) ? ('custom' as const) : ('builtin' as const),
        enabled: !disabledTools.includes(tool.name),
        modes: tool.modes,
        inputSummary: tool.inputSummary,
        timeoutMs: tool.timeoutMs,
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  describeForPrompt(mode: AgentMode, disabledTools: string[]): string {
    const lines = this.enabledTools(mode, disabledTools).map(
      (tool) => `- ${tool.name}: ${tool.description.split('\n')[0]}`,
    );
    return lines.join('\n');
  }
}

/* ------------------------------------------------------------------ */
/* Schema helpers                                                      */
/* ------------------------------------------------------------------ */

export const stringParam = (description: string, extra: JsonSchema = {}): JsonSchema => ({
  type: 'string',
  description,
  ...extra,
});

export const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const arrayParam = (description: string, items: JsonSchema): JsonSchema => ({
  type: 'array',
  description,
  items,
});

export const booleanParam = (description: string): JsonSchema => ({
  type: 'boolean',
  description,
});

export const numberParam = (description: string, extra: JsonSchema = {}): JsonSchema => ({
  type: 'number',
  description,
  ...extra,
});

export function projectRootPathHint(relativePath: string): string {
  return relativePath || '.';
}

/** Build the permission spec for a workspace path mutation. */
export function writePermission(
  toolName: string,
  relativePath: string,
  summary: string,
  details: Record<string, string> = {},
  risk: PermissionRisk = 'low',
): ToolPermissionSpec {
  const directory = relativePath.includes('/')
    ? relativePath.slice(0, relativePath.lastIndexOf('/'))
    : '';
  return {
    category: 'write',
    risk,
    actionKey: `${toolName}:${relativePath}`,
    alwaysKey: `write_dir:${directory || '<project-root>'}`,
    allowAlwaysLabel: `Always allow file edits in ${directory || 'the project root'} (this project only)`,
    details: { path: relativePath, summary, ...details },
  };
}

export function deletePermission(
  relativePath: string,
  summary: string,
  recursive: boolean,
): ToolPermissionSpec {
  return {
    category: 'delete',
    risk: 'high',
    actionKey: `delete:${relativePath}`,
    alwaysKey: null,
    allowAlwaysLabel: null,
    isDelete: true,
    details: { path: relativePath, recursive: String(recursive), summary },
  };
}

export function commandPermission(
  command: string,
  analysis: { risk: PermissionRisk; actionKey: string; blocked: boolean; reason: string },
  cwd: string,
): ToolPermissionSpec {
  return {
    category: 'execute',
    risk: analysis.risk,
    actionKey: analysis.actionKey,
    alwaysKey: analysis.blocked ? null : analysis.actionKey,
    allowAlwaysLabel: analysis.blocked ? null : 'Always allow this exact command (this project only)',
    commandRisk: analysis.risk,
    details: {
      command,
      cwd,
      reason: analysis.reason,
      ...(analysis.blocked ? { blocked: 'true' } : {}),
    },
  };
}

export function readOnlyPermission(actionKey: string, details: Record<string, string> = {}): ToolPermissionSpec {
  return {
    category: 'read',
    risk: 'low',
    actionKey,
    alwaysKey: null,
    allowAlwaysLabel: null,
    details,
  };
}

export function memoryPermission(actionKey: string, details: Record<string, string> = {}): ToolPermissionSpec {
  return {
    category: 'memory',
    risk: 'low',
    actionKey,
    alwaysKey: null,
    allowAlwaysLabel: null,
    details,
  };
}

export { z };
