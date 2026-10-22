/**
 * User-defined custom tools.
 *
 * A custom tool is a *declarative* command template with named string
 * parameters. Arbitrary JavaScript is never executed. Arguments are restricted
 * to a safe character set and quoted, the command always runs in the project
 * workspace, and every invocation requires an explicit approval (custom tools
 * cannot be "always allowed").
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type CustomToolDefinition } from '@shared/app-types';
import { STORAGE_PATHS } from '../../storage/paths';
import type { FileStorage } from '../../storage/file-storage';
import type { Logger } from '../../logging/logger';
import {
  type AnyToolDefinition,
  ToolError,
  defineTool,
  objectSchema,
} from '../../agent/tool-registry';
import { nowIso } from '../../util/ids';

const customToolsFileSchema = z.object({
  tools: z.array(
    z.object({
      name: z
        .string()
        .min(3)
        .max(60)
        .regex(/^[a-z][a-z0-9_]*$/),
      description: z.string().min(10).max(1000),
      command: z.string().min(1).max(4000),
      category: z.literal('execute'),
      parameters: z
        .array(
          z.object({
            name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
            description: z.string().min(1).max(400),
            required: z.boolean(),
          }),
        )
        .max(20),
      createdAt: z.string(),
      approvedAt: z.string().nullable(),
      approved: z.boolean(),
    }),
  ),
});

const SAFE_VALUE = /^[A-Za-z0-9 _./\\:+=,@-]*$/;

function quoteValue(value: string, name: string): string {
  if (!SAFE_VALUE.test(value)) {
    throw new ToolError(
      `Argument "${name}" contains characters that are not allowed in custom tool arguments. Use letters, digits, spaces, dots, slashes, dashes, underscores, colons, equals, plus, comma or @.`,
    );
  }
  return `"${value}"`;
}

export class CustomToolService {
  private tools: CustomToolDefinition[] = [];

  constructor(
    private readonly storage: FileStorage,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    const file = await this.storage.readJson<{ tools: CustomToolDefinition[] }>(
      STORAGE_PATHS.customTools,
      customToolsFileSchema,
      { tools: [] },
    );
    this.tools = file.tools.filter((tool: CustomToolDefinition) => Boolean(tool.name && tool.command));
    if (file.tools.length !== this.tools.length) {
      this.logger.warn('tools', 'Some custom tool definitions were invalid and were skipped.');
    }
  }

  list(): CustomToolDefinition[] {
    return this.tools.map((tool) => ({ ...tool }));
  }

  private async persist(): Promise<void> {
    await this.storage.writeJson(STORAGE_PATHS.customTools, { tools: this.tools });
  }

  private validateTemplate(command: string, parameters: CustomToolDefinition['parameters']): void {
    const names = new Set(parameters.map((parameter) => parameter.name));
    if (new Set(parameters.map((p) => p.name)).size !== parameters.length) {
      throw new ToolError('Parameter names must be unique.');
    }
    const placeholders = [...command.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]);
    for (const placeholder of placeholders) {
      if (!names.has(placeholder)) {
        throw new ToolError(
          `Command uses {${placeholder}} but no parameter with that name is defined.`,
        );
      }
    }
    for (const parameter of parameters) {
      if (!command.includes(`{${parameter.name}}`)) {
        throw new ToolError(`Parameter "${parameter.name}" is not used in the command template.`);
      }
    }
    if (/[\r\n\0]/.test(command)) {
      throw new ToolError('The command template cannot contain line breaks or null bytes.');
    }
  }

  async add(input: {
    name: string;
    description: string;
    command: string;
    parameters: Array<{ name: string; description: string; required: boolean }>;
  }): Promise<CustomToolDefinition> {
    if (this.tools.some((tool) => tool.name === input.name)) {
      throw new ToolError(`A custom tool named "${input.name}" already exists.`);
    }
    this.validateTemplate(input.command, input.parameters);
    const definition: CustomToolDefinition = {
      name: input.name,
      description: input.description,
      command: input.command,
      category: 'execute',
      parameters: input.parameters,
      createdAt: nowIso(),
      approvedAt: null,
      approved: false,
    };
    this.tools.push(definition);
    await this.persist();
    this.logger.info('tools', 'Custom tool added (pending approval)', { name: definition.name });
    return { ...definition };
  }

  async approve(name: string): Promise<CustomToolDefinition> {
    const tool = this.tools.find((entry) => entry.name === name);
    if (!tool) throw new ToolError(`Custom tool not found: ${name}`);
    tool.approved = true;
    tool.approvedAt = nowIso();
    await this.persist();
    this.logger.warn('tools', 'Custom tool approved', { name });
    return { ...tool };
  }

  async remove(name: string): Promise<boolean> {
    const before = this.tools.length;
    this.tools = this.tools.filter((tool) => tool.name !== name);
    if (this.tools.length === before) return false;
    await this.persist();
    this.logger.info('tools', 'Custom tool removed', { name });
    return true;
  }

  /** Only approved tools are exposed to the model. */
  definitions(): AnyToolDefinition[] {
    return this.tools.filter((tool) => tool.approved).map((tool) => this.toDefinition(tool));
  }

  private toDefinition(tool: CustomToolDefinition): AnyToolDefinition {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const parameter of tool.parameters) {
      properties[parameter.name] = { type: 'string', description: parameter.description };
      if (parameter.required) required.push(parameter.name);
    }
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const parameter of tool.parameters) {
      shape[parameter.name] = parameter.required
        ? z.string().min(1).max(4096)
        : z.string().max(4096).optional();
    }
    const inputSchema = z.object(shape) as z.ZodType<Record<string, string | undefined>>;

    const buildCommand = (input: Record<string, string | undefined>): string => {
      return tool.command.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
        const parameter = tool.parameters.find((entry) => entry.name === name);
        const value = input[name];
        if (parameter?.required && (value === undefined || value === '')) {
          throw new ToolError(`Missing required argument "${name}".`);
        }
        return quoteValue(value ?? '', name);
      });
    };

    return defineTool({
      name: tool.name,
      description: `[custom] ${tool.description}`,
      category: 'custom',
      mutating: true,
      risk: 'high',
      modes: ['build'],
      timeoutMs: 120000,
      inputSummary: tool.parameters.map((parameter) => parameter.name).join(', ') || 'none',
      parameters: objectSchema(properties, required),
      inputSchema,
      summarize: (input) => ({
        summary: `Custom tool ${tool.name}`,
        details: { command: tool.command, args: JSON.stringify(input) },
      }),
      permission: (input) => {
        const resolved = buildCommand(input);
        const digest = createHash('sha1').update(resolved).digest('hex').slice(0, 10);
        return {
          category: 'custom',
          risk: 'high',
          actionKey: `custom:${tool.name}:${digest}`,
          alwaysKey: null,
          allowAlwaysLabel: null,
          details: {
            command: resolved,
            reason: 'Custom tools always require explicit approval.',
          },
        };
      },
      async execute(input, ctx) {
        const command = buildCommand(input);
        const { result } = ctx.services.commands.execute({
          command,
          cwd: ctx.project.workspacePath,
          timeoutMs: 120000,
          maxOutputChars: ctx.settings.limits.maxOutputChars,
          signal: ctx.signal,
        });
        const finished = await result;
        return {
          content: [
            `custom tool: ${tool.name}`,
            `command: ${command}`,
            `exit code: ${finished.exitCode}`,
            `duration: ${finished.durationMs} ms`,
            '',
            finished.output.slice(0, 30000) || '(no output)',
          ].join('\n'),
          summary:
            finished.exitCode === 0
              ? `Custom tool ${tool.name} succeeded`
              : `Custom tool ${tool.name} exited with ${finished.exitCode}`,
          details: { command },
        };
      },
    });
  }
}
