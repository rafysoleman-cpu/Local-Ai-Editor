/**
 * Verification tools: tests, lint, build and type-check.
 *
 * The package manager is detected from lock files; a script is only run when it
 * actually exists in package.json. If a project has no script, the tool says so
 * instead of pretending verification happened.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  type AnyToolDefinition,
  type ToolContext,
  type ToolResult,
  ToolError,
  defineTool,
  objectSchema,
  stringParam,
  type ToolRegistry,
} from '../../agent/tool-registry';
import { analyzeCommand } from '../../terminal/command-policy';

type ScriptKind = 'test' | 'lint' | 'build' | 'typecheck';

interface ScriptToolConfig {
  name: string;
  kind: ScriptKind;
  description: string;
  candidates: string[];
  fallbackNote: string;
  timeoutMs: number;
}

const MAX_MODEL_OUTPUT = 25000;

async function findLocalBinary(workspacePath: string, name: string): Promise<string | null> {
  const candidates = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const candidate of candidates) {
    const full = path.join(workspacePath, 'node_modules', '.bin', candidate);
    const stat = await fs.stat(full).catch(() => null);
    if (stat?.isFile()) return full;
  }
  return null;
}

function runnerFor(packageManager: 'npm' | 'pnpm' | 'yarn' | null): string {
  if (packageManager === 'pnpm') return 'pnpm run';
  if (packageManager === 'yarn') return 'yarn';
  return 'npm run';
}

async function resolveCommand(
  ctx: ToolContext,
  config: ScriptToolConfig,
  requestedScript: string | undefined,
): Promise<{ command: string; script: string; note: string }> {
  const info = await ctx.services.workspace.workspaceInfo(ctx.project.workspacePath);
  const scripts = info.scripts;
  const available = Object.keys(scripts);

  if (requestedScript) {
    if (!scripts[requestedScript]) {
      throw new ToolError(
        `Script "${requestedScript}" does not exist in package.json. Available scripts: ${available.length ? available.join(', ') : 'none'}.`,
      );
    }
    return {
      command: `${runnerFor(info.packageManager)} ${requestedScript}`,
      script: requestedScript,
      note: '',
    };
  }

  const match = config.candidates.find((candidate) => Boolean(scripts[candidate]));
  if (match) {
    return { command: `${runnerFor(info.packageManager)} ${match}`, script: match, note: '' };
  }

  if (config.kind === 'typecheck') {
    const local = await findLocalBinary(ctx.project.workspacePath, 'tsc');
    if (local) {
      return {
        command: `"${local}" --noEmit --pretty false`,
        script: '(local tsc)',
        note: 'No typecheck script found; using the locally installed TypeScript compiler.',
      };
    }
    if (await fs.stat(path.join(ctx.project.workspacePath, 'tsconfig.json')).catch(() => null)) {
      throw new ToolError(
        'tsconfig.json exists but TypeScript is not installed locally and there is no "typecheck" script. Install TypeScript or add a script; verification was not run.',
      );
    }
  }

  if (config.kind === 'lint') {
    const local = await findLocalBinary(ctx.project.workspacePath, 'eslint');
    if (local) {
      return {
        command: `"${local}" .`,
        script: '(local eslint)',
        note: 'No lint script found; using the locally installed ESLint.',
      };
    }
  }

  throw new ToolError(
    `No ${config.kind} script found in package.json. Available scripts: ${available.length ? available.join(', ') : 'none'}. ${config.fallbackNote} Nothing was run.`,
  );
}

async function executeScript(
  ctx: ToolContext,
  config: ScriptToolConfig,
  requestedScript: string | undefined,
): Promise<ToolResult> {
  const { command, script, note } = await resolveCommand(ctx, config, requestedScript);
  const analysis = analyzeCommand(command);
  if (analysis.blocked) throw new ToolError(`Command refused: ${analysis.reason}`);
  const { result } = ctx.services.commands.execute({
    command,
    cwd: ctx.project.workspacePath,
    timeoutMs: config.timeoutMs,
    maxOutputChars: ctx.settings.limits.maxOutputChars,
    signal: ctx.signal,
  });
  const finished = await result;
  const output = finished.output.slice(0, MAX_MODEL_OUTPUT);
  const status =
    finished.exitCode === 0
      ? 'passed'
      : finished.timedOut
        ? 'timed out'
        : finished.cancelled
          ? 'cancelled'
          : `failed with exit code ${finished.exitCode}`;
  return {
    content: [
      `${config.kind} command: ${command}`,
      `script: ${script}`,
      ...(note ? [`note: ${note}`] : []),
      `result: ${status} (${finished.durationMs} ms)`,
      '',
      output.trim() || '(no output)',
      ...(finished.truncated ? ['', '[output truncated]'] : []),
    ].join('\n'),
    summary: `${config.kind} ${status}`,
    details: {
      command,
      script,
      exitCode: String(finished.exitCode),
      commandId: finished.commandId,
    },
    meta: {
      exitCode: finished.exitCode,
      commandId: finished.commandId,
      durationMs: finished.durationMs,
      timedOut: finished.timedOut,
      cancelled: finished.cancelled,
      script,
    },
  };
}

function makeScriptTool(config: ScriptToolConfig): AnyToolDefinition {
  return defineTool({
    name: config.name,
    description: config.description,
    category: 'execute',
    mutating: false,
    risk: 'medium',
    modes: ['build'],
    timeoutMs: config.timeoutMs,
    inputSummary: 'script?',
    parameters: objectSchema(
      {
        script: stringParam(
          `Optional package.json script name. Defaults to one of: ${config.candidates.join(', ')}.`,
        ),
      },
      [],
    ),
    inputSchema: z.object({ script: z.string().min(1).max(200).optional() }),
    summarize: (input) => ({
      summary: `Run ${config.kind}${input.script ? ` (${input.script})` : ''}`,
      details: { kind: config.kind, script: input.script ?? 'auto' },
    }),
    permission: (input, ctx) => {
      const script = input.script ?? config.candidates[0];
      return {
        category: 'execute',
        risk: 'medium',
        actionKey: `script:${config.kind}:${script}`,
        alwaysKey: `script:${config.kind}:${script}`,
        allowAlwaysLabel: `Always allow "${config.kind}" in this project`,
        commandRisk: 'medium',
        details: {
          command: `npm run ${script}`,
          script,
          cwd: ctx.project.workspacePath,
          reason: config.description.split('\n')[0],
        },
      };
    },
    execute: (input, ctx) => executeScript(ctx, config, input.script),
  });
}

export function registerTestingTools(registry: ToolRegistry): void {
  const configs: ScriptToolConfig[] = [
    {
      name: 'run_tests',
      kind: 'test',
      description:
        'Run the project test suite through a package.json script (detected automatically). Returns real exit code and output. It never claims tests passed when no test script exists.',
      candidates: ['test', 'test:unit', 'test:all', 'tests', 'vitest', 'jest'],
      fallbackNote: 'Add a test script to package.json to enable this tool.',
      timeoutMs: 600000,
    },
    {
      name: 'run_linter',
      kind: 'lint',
      description:
        'Run the project linter through a package.json script, or the locally installed ESLint when no script exists. Returns real exit code and output.',
      candidates: ['lint', 'lint:check', 'eslint', 'check'],
      fallbackNote: 'Add a lint script or install ESLint locally.',
      timeoutMs: 300000,
    },
    {
      name: 'run_build',
      kind: 'build',
      description: 'Run the project build command through a package.json script and report the real result.',
      candidates: ['build', 'compile', 'bundle', 'dist'],
      fallbackNote: 'Add a build script to package.json.',
      timeoutMs: 600000,
    },
    {
      name: 'run_typecheck',
      kind: 'typecheck',
      description:
        'Run the project type checker (a "typecheck" script or the locally installed TypeScript compiler) and report the real result.',
      candidates: ['typecheck', 'check-types', 'type-check', 'tsc'],
      fallbackNote: 'Add a typecheck script or install TypeScript locally.',
      timeoutMs: 300000,
    },
  ];
  for (const config of configs) registry.register(makeScriptTool(config));
}
