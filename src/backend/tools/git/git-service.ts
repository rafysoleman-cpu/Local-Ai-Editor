/**
 * Read-only Git integration.
 *
 * Git is spawned directly (no shell) so file paths cannot be interpreted as
 * shell syntax. No mutating Git command is exposed to the agent.
 */
import type { GitBranchInfo, GitDiffResult, GitLogEntry, GitStatus, GitStatusEntry } from '@shared/app-types';
import type { Logger } from '../../logging/logger';
import type { ProcessManager } from '../../terminal/process-manager';

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export class GitService {
  constructor(
    private readonly processes: ProcessManager,
    private readonly logger: Logger,
  ) {}

  private async run(cwd: string, args: string[], timeoutMs = 20000): Promise<GitRunResult> {
    const result = await this.processes.run({
      command: 'git',
      args,
      displayCommand: `git ${args.join(' ')}`,
      cwd,
      timeoutMs,
      maxOutputChars: 400000,
    });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
    };
  }

  async isRepository(workspacePath: string): Promise<boolean> {
    const result = await this.run(workspacePath, ['rev-parse', '--is-inside-work-tree']);
    return result.ok && result.stdout.trim() === 'true';
  }

  async init(workspacePath: string): Promise<void> {
    const result = await this.run(workspacePath, ['init']);
    if (!result.ok) {
      throw new Error(result.stderr.trim() || `git init failed with exit code ${result.code}`);
    }
    this.logger.info('git', 'Initialized git repository', { workspacePath });
  }

  async status(workspacePath: string): Promise<GitStatus> {
    if (!(await this.isRepository(workspacePath))) {
      return { isRepository: false, branch: null, entries: [], error: null };
    }
    const branchResult = await this.run(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchResult.ok ? branchResult.stdout.trim() : null;
    const status = await this.run(workspacePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!status.ok) {
      return {
        isRepository: true,
        branch,
        entries: [],
        error: status.stderr.trim() || `git status exited with ${status.code}`,
      };
    }
    const entries: GitStatusEntry[] = [];
    const chunks = status.stdout.split('\0');
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk || chunk.length < 4) continue;
      const code = chunk.slice(0, 2);
      let filePath = chunk.slice(3);
      if (code.startsWith('R') || code.startsWith('C')) {
        // With -z, rename/copy entries are followed by the original path.
        index += 1;
      }
      if (code === '??') {
        entries.push({ path: filePath, status: 'untracked', staged: false });
        continue;
      }
      if (code.includes('D')) entries.push({ path: filePath, status: 'deleted', staged: code[0] !== ' ' });
      else if (code.includes('A')) entries.push({ path: filePath, status: 'added', staged: code[0] !== ' ' });
      else if (code.includes('R')) entries.push({ path: filePath, status: 'renamed', staged: code[0] !== ' ' });
      else if (code.includes('M')) entries.push({ path: filePath, status: 'modified', staged: code[0] !== ' ' });
      else entries.push({ path: filePath, status: 'changed', staged: false });
    }
    return { isRepository: true, branch, entries, error: null };
  }

  async diff(workspacePath: string, relativePath?: string): Promise<GitDiffResult> {
    if (!(await this.isRepository(workspacePath))) {
      return { patch: '', truncated: false, error: 'Not a git repository.' };
    }
    const args = ['diff', '--no-color', '--no-ext-diff'];
    if (relativePath) args.push('--', relativePath);
    const result = await this.run(workspacePath, args);
    if (!result.ok) {
      return { patch: '', truncated: false, error: result.stderr.trim() || `git diff exited with ${result.code}` };
    }
    const limit = 300000;
    return {
      patch: result.stdout.length > limit ? result.stdout.slice(0, limit) : result.stdout,
      truncated: result.stdout.length > limit,
      error: null,
    };
  }

  async log(workspacePath: string, limit = 30): Promise<GitLogEntry[]> {
    if (!(await this.isRepository(workspacePath))) return [];
    const format = '%H%x1f%s%x1f%an%x1f%aI';
    const result = await this.run(workspacePath, ['log', `-n`, String(limit), `--pretty=format:${format}`]);
    if (!result.ok) return [];
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash = '', subject = '', author = '', date = ''] = line.split('\x1f');
        return { hash, subject, author, date };
      });
  }

  async branches(workspacePath: string): Promise<GitBranchInfo> {
    if (!(await this.isRepository(workspacePath))) {
      return { branches: [], current: null, error: 'Not a git repository.' };
    }
    const [list, current] = await Promise.all([
      this.run(workspacePath, ['branch', '--no-color', '--format=%(refname:short)']),
      this.run(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    if (!list.ok) {
      return { branches: [], current: null, error: list.stderr.trim() || 'git branch failed' };
    }
    return {
      branches: list.stdout.split('\n').map((entry) => entry.trim()).filter(Boolean),
      current: current.ok ? current.stdout.trim() : null,
      error: null,
    };
  }
}
