/**
 * Read-only Git tools. No reset, checkout, branch deletion or push is exposed.
 */
import { z } from 'zod';
import {
  type AnyToolDefinition,
  defineTool,
  objectSchema,
  readOnlyPermission,
  stringParam,
  type ToolRegistry,
} from '../../agent/tool-registry';
import { resolveWorkspacePath } from '../../projects/path-safety';

export function registerGitTools(registry: ToolRegistry): void {
  const gitStatus = defineTool({
    name: 'git_status',
    description: 'Show Git working-tree status (branch and changed/untracked files) for the project.',
    category: 'git',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 30000,
    inputSummary: 'none',
    parameters: objectSchema({}, []),
    inputSchema: z.object({}),
    summarize: () => ({ summary: 'Git status', details: {} }),
    permission: () => readOnlyPermission('git:status'),
    async execute(_input, ctx) {
      const status = await ctx.services.git.status(ctx.project.workspacePath);
      if (!status.isRepository) {
        return { content: 'This project is not a Git repository.', summary: 'Not a Git repository' };
      }
      if (status.error) return { content: `git status failed: ${status.error}`, summary: 'git status failed' };
      const lines = [
        `branch: ${status.branch ?? '(detached)'}`,
        `changes: ${status.entries.length}`,
        ...status.entries.map((entry) => `${entry.status}${entry.staged ? ' (staged)' : ''}  ${entry.path}`),
      ];
      return {
        content: lines.join('\n'),
        summary: `${status.entries.length} uncommitted change${status.entries.length === 1 ? '' : 's'}`,
        details: { branch: status.branch ?? '' },
      };
    },
  });

  const gitDiff = defineTool({
    name: 'git_diff',
    description: 'Show the unstaged Git diff for the project or a single file. Read-only; never applies or reverts changes.',
    category: 'git',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 30000,
    inputSummary: 'relativePath?',
    parameters: objectSchema(
      { relativePath: stringParam('Optional workspace-relative file path.') },
      [],
    ),
    inputSchema: z.object({ relativePath: z.string().max(4096).optional() }),
    summarize: (input) => ({ summary: `Git diff ${input.relativePath ?? '(all)'}`, details: {} }),
    permission: (input) => readOnlyPermission(`git:diff:${input.relativePath ?? ''}`),
    async execute(input, ctx) {
      if (input.relativePath) {
        await resolveWorkspacePath(ctx.project.workspacePath, input.relativePath, { mustExist: false });
      }
      const diff = await ctx.services.git.diff(ctx.project.workspacePath, input.relativePath);
      if (diff.error) return { content: `git diff failed: ${diff.error}`, summary: 'git diff failed' };
      if (!diff.patch.trim()) {
        return {
          content: 'No unstaged changes. (Staged changes are not included; use run_command with "git diff --cached" if needed.)',
          summary: 'No unstaged changes',
        };
      }
      return {
        content: `${diff.patch}${diff.truncated ? '\n\n[diff truncated]' : ''}`,
        summary: `Diff for ${input.relativePath ?? 'the project'}`,
      };
    },
  });

  const gitLog = defineTool({
    name: 'git_log',
    description: 'Show recent Git commits (hash, subject, author, date).',
    category: 'git',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 30000,
    inputSummary: 'none',
    parameters: objectSchema({}, []),
    inputSchema: z.object({}),
    summarize: () => ({ summary: 'Git log', details: {} }),
    permission: () => readOnlyPermission('git:log'),
    async execute(_input, ctx) {
      const entries = await ctx.services.git.log(ctx.project.workspacePath);
      if (entries.length === 0) return { content: 'No commits found (or not a Git repository).', summary: 'No commits' };
      return {
        content: entries.map((entry) => `${entry.hash.slice(0, 10)}  ${entry.date}  ${entry.author}  ${entry.subject}`).join('\n'),
        summary: `${entries.length} recent commits`,
      };
    },
  });

  const gitBranchInfo = defineTool({
    name: 'git_branch_info',
    description: 'List local Git branches and the current branch.',
    category: 'git',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 30000,
    inputSummary: 'none',
    parameters: objectSchema({}, []),
    inputSchema: z.object({}),
    summarize: () => ({ summary: 'Git branch info', details: {} }),
    permission: () => readOnlyPermission('git:branches'),
    async execute(_input, ctx) {
      const info = await ctx.services.git.branches(ctx.project.workspacePath);
      if (info.error) return { content: info.error, summary: 'Not a Git repository' };
      return {
        content: [`current: ${info.current ?? '(detached)'}`, `branches: ${info.branches.join(', ') || '(none)'}`].join('\n'),
        summary: `On ${info.current ?? 'detached HEAD'}`,
      };
    },
  });

  const tools: AnyToolDefinition[] = [gitStatus, gitDiff, gitLog, gitBranchInfo];
  for (const tool of tools) registry.register(tool);
}
