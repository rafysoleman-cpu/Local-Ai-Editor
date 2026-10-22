/**
 * Terminal tools available to the agent.
 *
 * Commands run in the project workspace, inside the backend process manager,
 * with a hard timeout and output cap. Commands that could escape the workspace
 * are still only shell commands: the permission prompt is the real boundary,
 * and the prompt shows the exact command and working directory.
 */
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import {
  type AnyToolDefinition,
  ToolError,
  commandPermission,
  defineTool,
  numberParam,
  objectSchema,
  readOnlyPermission,
  stringParam,
  type ToolRegistry,
} from '../../agent/tool-registry';
import { analyzeCommand } from '../../terminal/command-policy';
import { resolveWorkspacePath } from '../../projects/path-safety';

const MAX_MODEL_OUTPUT = 30000;

function formatExecution(
  command: string,
  cwd: string,
  output: string,
  exitCode: number | null,
  durationMs: number,
  flags: { truncated?: boolean; timedOut?: boolean; cancelled?: boolean } = {},
): string {
  const status = flags.cancelled
    ? 'cancelled'
    : flags.timedOut
      ? 'timed out'
      : exitCode === 0
        ? 'success'
        : `failed (exit ${exitCode ?? 'unknown'})`;
  const notes = [
    flags.truncated ? 'output truncated' : null,
    flags.timedOut ? `killed after ${Math.round(durationMs / 1000)}s` : null,
    flags.cancelled ? 'cancelled by the user' : null,
  ].filter(Boolean);
  return [
    `$ ${command}`,
    `cwd: ${cwd}`,
    `status: ${status} (${durationMs} ms)`,
    ...(notes.length ? [`notes: ${notes.join('; ')}`] : []),
    '',
    output.trim() || '(no output)',
  ].join('\n');
}

export function registerTerminalTools(registry: ToolRegistry): void {
  const runCommand = defineTool({
    name: 'run_command',
    description:
      'Run a shell command in the project workspace and capture its output, exit code and duration. Non-zero exit codes are returned, not thrown. Use it to install dependencies, run scripts, and verify changes. Long-running or interactive commands are not supported.',
    category: 'execute',
    mutating: true,
    risk: 'medium',
    modes: ['build'],
    timeoutMs: 600000,
    inputSummary: 'command, cwd?, timeoutMs?',
    parameters: objectSchema(
      {
        command: stringParam('Shell command to execute.'),
        cwd: stringParam('Optional workspace-relative working directory (default: project root).'),
        timeoutMs: numberParam('Optional timeout in milliseconds (max 600000).'),
      },
      ['command'],
    ),
    inputSchema: z.object({
      command: z.string().min(1).max(4000),
      cwd: z.string().max(4096).optional(),
      timeoutMs: z.number().int().min(1000).max(600000).optional(),
    }),
    summarize: (input) => ({
      summary: `Run: ${input.command.slice(0, 140)}`,
      details: { command: input.command, cwd: input.cwd ?? '.' },
    }),
    permission: (input, ctx) =>
      commandPermission(
        input.command,
        analyzeCommand(input.command),
        input.cwd ? `${ctx.project.workspacePath}/${input.cwd}` : ctx.project.workspacePath,
      ),
    async execute(input, ctx) {
      const analysis = analyzeCommand(input.command);
      if (analysis.blocked) {
        throw new ToolError(`Command refused: ${analysis.reason}`);
      }
      const resolved = await resolveWorkspacePath(ctx.project.workspacePath, input.cwd ?? '', {
        mustExist: true,
      });
      const stat = await fs.stat(resolved.absolutePath).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        throw new ToolError(`Working directory is not a folder: ${input.cwd ?? '.'}`);
      }
      const timeout = Math.min(
        input.timeoutMs ?? ctx.settings.limits.maxCommandMs,
        ctx.settings.limits.maxCommandMs * 2,
      );
      const { result } = ctx.services.commands.execute({
        command: input.command,
        cwd: resolved.absolutePath,
        timeoutMs: timeout,
        maxOutputChars: ctx.settings.limits.maxOutputChars,
        signal: ctx.signal,
      });
      const finished = await result;
      const output = finished.output.slice(0, MAX_MODEL_OUTPUT);
      return {
        content: formatExecution(input.command, input.cwd || '.', output, finished.exitCode, finished.durationMs, {
          truncated: finished.truncated,
          timedOut: finished.timedOut,
          cancelled: finished.cancelled,
        }),
        summary:
          finished.exitCode === 0
            ? `Command succeeded: ${input.command.slice(0, 100)}`
            : `Command exited with ${finished.exitCode}: ${input.command.slice(0, 100)}`,
        details: {
          command: input.command,
          cwd: input.cwd || '.',
          exitCode: String(finished.exitCode),
          commandId: finished.commandId,
        },
        meta: {
          exitCode: finished.exitCode,
          commandId: finished.commandId,
          durationMs: finished.durationMs,
          timedOut: finished.timedOut,
          cancelled: finished.cancelled,
        },
      };
    },
  });

  const getCommandOutput = defineTool({
    name: 'get_command_output',
    description: 'Get the buffered output and status of a command started earlier by run_command.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['build'],
    timeoutMs: 5000,
    inputSummary: 'commandId',
    parameters: objectSchema({ commandId: stringParam('The commandId returned by run_command.') }, ['commandId']),
    inputSchema: z.object({ commandId: z.string().min(3).max(120) }),
    summarize: (input) => ({ summary: `Read output of ${input.commandId}`, details: { commandId: input.commandId } }),
    permission: (input) => readOnlyPermission(`read:command_output:${input.commandId}`),
    async execute(input, ctx) {
      const snapshot = ctx.services.commands.snapshot(input.commandId);
      if (!snapshot) throw new ToolError(`No command with id ${input.commandId} is known (it may have been evicted).`);
      return {
        content: [
          `command: ${snapshot.command}`,
          `running: ${snapshot.running}`,
          `exit code: ${snapshot.exitCode ?? 'n/a'}`,
          `duration: ${snapshot.durationMs ?? 'n/a'} ms`,
          '',
          snapshot.output || '(no output yet)',
        ].join('\n'),
        summary: snapshot.running ? 'Command is still running' : `Exit code ${snapshot.exitCode}`,
      };
    },
  });

  const stopCommand = defineTool({
    name: 'stop_command',
    description: 'Stop a command started by run_command or the interactive terminal. Terminates the whole process tree.',
    category: 'execute',
    mutating: false,
    risk: 'low',
    modes: ['build'],
    timeoutMs: 15000,
    inputSummary: 'commandId',
    parameters: objectSchema({ commandId: stringParam('The commandId to stop.') }, ['commandId']),
    inputSchema: z.object({ commandId: z.string().min(3).max(120) }),
    summarize: (input) => ({ summary: `Stop ${input.commandId}`, details: { commandId: input.commandId } }),
    permission: (input) => ({
      category: 'execute',
      risk: 'low',
      actionKey: `stop_command:${input.commandId}`,
      alwaysKey: null,
      allowAlwaysLabel: null,
      commandRisk: 'low',
      details: { commandId: input.commandId },
    }),
    async execute(input, ctx) {
      const stopped = ctx.services.commands.stop(input.commandId);
      return {
        content: stopped ? `Requested termination of ${input.commandId}.` : `No running command ${input.commandId}.`,
        summary: stopped ? 'Command stop requested' : 'Command was not running',
      };
    },
  });

  const checkEnvironment = defineTool({
    name: 'check_environment',
    description:
      'Report the local development environment for this project: Node, npm, git, shell, platform, package manager, scripts and detected languages. Read-only.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 60000,
    inputSummary: 'none',
    parameters: objectSchema({}, []),
    inputSchema: z.object({}),
    summarize: () => ({ summary: 'Check development environment', details: {} }),
    permission: () => readOnlyPermission('read:environment'),
    async execute(_input, ctx) {
      const diagnostics = await ctx.services.commands.diagnostics(ctx.project.workspacePath);
      const info = await ctx.services.workspace.workspaceInfo(ctx.project.workspacePath);
      const lines = [
        `platform: ${diagnostics.platform} (${diagnostics.archive})`,
        `shell: ${ctx.services.commands.shell}`,
        `node: ${diagnostics.node}`,
        `npm: ${diagnostics.npm}`,
        `git: ${diagnostics.git}`,
        `workspace: ${info.workspacePath}`,
        `git repository: ${info.isGitRepository}${info.gitBranch ? ` (branch ${info.gitBranch})` : ''}`,
        `package manager: ${info.packageManager ?? 'none detected'}`,
        `package scripts: ${Object.keys(info.scripts).length ? Object.keys(info.scripts).join(', ') : 'none'}`,
        `languages: ${info.languages.length ? info.languages.join(', ') : 'none detected'}`,
      ];
      return {
        content: lines.join('\n'),
        summary: 'Environment checked',
        details: { node: diagnostics.node, npm: diagnostics.npm, git: diagnostics.git },
      };
    },
  });

  const tools: AnyToolDefinition[] = [runCommand, getCommandOutput, stopCommand, checkEnvironment];
  for (const tool of tools) registry.register(tool);
}
