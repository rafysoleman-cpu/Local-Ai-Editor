/**
 * Text search and symbol tools.
 *
 * Search is textual (no language server): it is fast, predictable and works for
 * any language, but it does not understand scopes or types. The tool
 * descriptions say so, and `get_diagnostics` reports clearly when a project has
 * no type-checking command available.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SearchMatch } from '@shared/app-types';
import {
  type AnyToolDefinition,
  booleanParam,
  defineTool,
  numberParam,
  objectSchema,
  readOnlyPermission,
  stringParam,
  type ToolRegistry,
} from '../../agent/tool-registry';

const MAX_RESULTS_HARD = 300;

function formatMatches(matches: SearchMatch[], truncated: boolean, scanned: number): string {
  if (matches.length === 0) {
    return `No matches found (scanned ${scanned} text files).`;
  }
  const lines = matches.map(
    (match) => `${match.relativePath}:${match.line}:${match.column}: ${match.text.trim()}`,
  );
  return `${matches.length} match${matches.length === 1 ? '' : 'es'}:\n${lines.join('\n')}${truncated ? '\n… (results truncated)' : ''}`;
}

export function registerSearchTools(registry: ToolRegistry): void {
  const grepSearch = defineTool({
    name: 'grep_search',
    description:
      'Search text file contents with a literal string or regular expression. Skips node_modules, .git, build output and binary files. Returns file:line:column matches.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 45000,
    inputSummary: 'query, relativePath?, isRegex?, caseSensitive?, maxResults?',
    parameters: objectSchema(
      {
        query: stringParam('Text or regular expression to search for.'),
        relativePath: stringParam('Optional workspace-relative folder to limit the search.'),
        isRegex: booleanParam('Treat query as a regular expression (default false).'),
        caseSensitive: booleanParam('Case-sensitive search (default false).'),
        maxResults: numberParam('Maximum matches (default 100, max 300).'),
      },
      ['query'],
    ),
    inputSchema: z.object({
      query: z.string().min(1).max(500),
      relativePath: z.string().max(4096).optional(),
      isRegex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      maxResults: z.number().int().min(1).max(MAX_RESULTS_HARD).optional(),
    }),
    summarize: (input) => ({
      summary: `Search "${input.query}"`,
      details: { query: input.query, path: input.relativePath ?? '.' },
    }),
    permission: (input) => readOnlyPermission(`search:grep:${input.query}`, { query: input.query }),
    async execute(input, ctx) {
      const result = await ctx.services.workspace.grep(ctx.project.workspacePath, input.query, {
        relativePath: input.relativePath,
        isRegex: input.isRegex,
        caseSensitive: input.caseSensitive,
        maxResults: input.maxResults ?? 100,
      });
      return {
        content: formatMatches(result.matches, result.truncated, result.scannedFiles),
        summary: `${result.matches.length} matches for "${input.query}"`,
        meta: { matches: result.matches.length, scanned: result.scannedFiles },
      };
    },
  });

  const findSymbol = defineTool({
    name: 'find_symbol',
    description:
      'Find where a symbol (class, function, constant, type, method) is declared, using declaration patterns across common languages. This is textual matching, not a language server.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 45000,
    inputSummary: 'name',
    parameters: objectSchema({ name: stringParam('Exact symbol name.') }, ['name']),
    inputSchema: z.object({ name: z.string().min(1).max(200) }),
    summarize: (input) => ({ summary: `Find symbol ${input.name}`, details: { symbol: input.name } }),
    permission: (input) => readOnlyPermission(`search:symbol:${input.name}`),
    async execute(input, ctx) {
      const escaped = input.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `(^|[^A-Za-z0-9_$])(class|interface|type|enum|function|const|let|var|def|fn|struct|impl|trait|public|private|protected|static|async|export|declare)\\b[^\\n]{0,80}\\b${escaped}\\b`,
        'g',
      );
      const result = await ctx.services.workspace.grep(ctx.project.workspacePath, pattern.source, {
        isRegex: true,
        caseSensitive: true,
        maxResults: 60,
      });
      if (result.matches.length === 0) {
        const fallback = await ctx.services.workspace.grep(ctx.project.workspacePath, input.name, {
          caseSensitive: true,
          maxResults: 40,
        });
        if (fallback.matches.length === 0) {
          return { content: `No declaration or reference found for "${input.name}".`, summary: 'Symbol not found' };
        }
        return {
          content: `No declaration pattern matched "${input.name}". References:\n${formatMatches(fallback.matches, fallback.truncated, fallback.scannedFiles)}`,
          summary: `No declaration for ${input.name}; ${fallback.matches.length} references`,
        };
      }
      return {
        content: formatMatches(result.matches, result.truncated, result.scannedFiles),
        summary: `${result.matches.length} declarations for ${input.name}`,
        meta: { matches: result.matches.length },
      };
    },
  });

  const findReferences = defineTool({
    name: 'find_references',
    description: 'Find textual references to an identifier across the workspace (word-boundary match).',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 45000,
    inputSummary: 'name, maxResults?',
    parameters: objectSchema(
      {
        name: stringParam('Identifier to look for.'),
        maxResults: numberParam('Maximum matches (default 100).'),
      },
      ['name'],
    ),
    inputSchema: z.object({
      name: z.string().min(1).max(200),
      maxResults: z.number().int().min(1).max(MAX_RESULTS_HARD).optional(),
    }),
    summarize: (input) => ({ summary: `Find references to ${input.name}`, details: { symbol: input.name } }),
    permission: (input) => readOnlyPermission(`search:references:${input.name}`),
    async execute(input, ctx) {
      const escaped = input.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const result = await ctx.services.workspace.grep(
        ctx.project.workspacePath,
        `\\b${escaped}\\b`,
        { isRegex: true, caseSensitive: true, maxResults: input.maxResults ?? 100 },
      );
      return {
        content: formatMatches(result.matches, result.truncated, result.scannedFiles),
        summary: `${result.matches.length} references to ${input.name}`,
        meta: { matches: result.matches.length },
      };
    },
  });

  const getDiagnostics = defineTool({
    name: 'get_diagnostics',
    description:
      'Report code diagnostics for the project. Uses the project type-check command (package script "typecheck", or a locally installed TypeScript compiler). Reports clearly when the project has no configured checker. Running the checker requires permission.',
    category: 'execute',
    mutating: false,
    risk: 'medium',
    modes: ['plan', 'build'],
    timeoutMs: 180000,
    inputSummary: 'none',
    parameters: objectSchema({}, []),
    inputSchema: z.object({}),
    summarize: () => ({ summary: 'Collect type diagnostics', details: {} }),
    permission: () => ({
      category: 'execute',
      risk: 'medium',
      actionKey: 'run_diagnostics:typecheck',
      alwaysKey: 'run_diagnostics:typecheck',
      allowAlwaysLabel: 'Always allow the type-checker in this project',
      commandRisk: 'medium',
      details: { command: 'project type-check', reason: 'Runs the project type checker.' },
    }),
    async execute(_input, ctx) {
      const info = await ctx.services.workspace.workspaceInfo(ctx.project.workspacePath);
      const scripts = Object.keys(info.scripts);
      let command: string;
      if (info.scripts.typecheck) {
        const runner = info.packageManager === 'pnpm' ? 'pnpm' : info.packageManager === 'yarn' ? 'yarn' : 'npm';
        command = runner === 'npm' ? 'npm run typecheck' : `${runner} run typecheck`;
      } else if (info.scripts['check-types']) {
        command = 'npm run check-types';
      } else {
        const tscName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
        const localTsc = path.join(ctx.project.workspacePath, 'node_modules', '.bin', tscName);
        const exists = await fs.stat(localTsc).catch(() => null);
        if (!exists) {
          throw new Error(
            `No diagnostics provider found. Available package scripts: ${scripts.length ? scripts.join(', ') : 'none'}. Add a "typecheck" script or install TypeScript locally.`,
          );
        }
        command = `"${localTsc}" --noEmit --pretty false`;
      }
      const { result } = ctx.services.commands.execute({
        command,
        cwd: ctx.project.workspacePath,
        timeoutMs: 170000,
        signal: ctx.signal,
      });
      const finished = await result;
      const output = finished.output.trim();
      return {
        content: `Type diagnostics command: ${command}\nexit code: ${finished.exitCode}\n\n${output || '(no output)'}`,
        summary:
          finished.exitCode === 0
            ? 'Type check passed'
            : `Type check reported problems (exit ${finished.exitCode})`,
        details: { command, cwd: finished.cwd },
        meta: { exitCode: finished.exitCode, commandId: finished.commandId },
      };
    },
  });

  const tools: AnyToolDefinition[] = [grepSearch, findSymbol, findReferences, getDiagnostics];
  for (const tool of tools) registry.register(tool);
}
