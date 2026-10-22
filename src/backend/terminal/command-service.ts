/**
 * Command execution service used by agent tools and the interactive terminal.
 * Tracks active/completed commands so they can be inspected and stopped.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ProcessManager, type ProcessResult, describeShell } from './process-manager';

export interface CommandLimits {
  maxCommandMs: number;
  maxOutputChars: number;
}

export interface ExecuteOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
}

interface ActiveCommand {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  controller: AbortController;
  buffer: string;
  settle: Promise<ProcessResult>;
}

export interface CommandSnapshot {
  commandId: string;
  command: string;
  cwd: string;
  running: boolean;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

const MAX_HISTORY = 40;

export class CommandService {
  private readonly active = new Map<string, ActiveCommand>();
  private readonly completed = new Map<string, ProcessResult>();

  constructor(
    private readonly processes: ProcessManager,
    private readonly limits: () => CommandLimits,
  ) {}

  get shell(): string {
    return describeShell();
  }

  async validateCwd(cwd: string): Promise<string> {
    const resolved = path.resolve(cwd);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Working directory does not exist: ${resolved}`);
    }
    return resolved;
  }

  execute(options: ExecuteOptions): { commandId: string; result: Promise<ProcessResult> } {
    const commandId = `cmd_${randomBytes(6).toString('hex')}`;
    const controller = new AbortController();
    const limits = this.limits();
    const startedAt = Date.now();

    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const entry: ActiveCommand = {
      id: commandId,
      command: options.command,
      cwd: options.cwd,
      startedAt,
      controller,
      buffer: '',
      settle: Promise.resolve({
        commandId,
        command: options.command,
        cwd: options.cwd,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        output: '',
        durationMs: 0,
        truncated: false,
        timedOut: false,
        cancelled: false,
        stdioMode: 'pipe',
        pid: null,
      }),
    };

    const result = this.processes.run({
      id: commandId,
      command: options.command,
      cwd: options.cwd,
      timeoutMs: Math.min(options.timeoutMs ?? limits.maxCommandMs, limits.maxCommandMs * 4),
      maxOutputChars: options.maxOutputChars ?? limits.maxOutputChars,
      signal: controller.signal,
      onChunk: (stream, text) => {
        entry.buffer = `${entry.buffer}${text}`;
        if (entry.buffer.length > 200000) entry.buffer = entry.buffer.slice(-200000);
        options.onChunk?.(stream, text);
      },
    });

    entry.settle = result;
    this.active.set(commandId, entry);
    void result.finally(() => {
      this.active.delete(commandId);
      options.signal?.removeEventListener('abort', onAbort);
    });
    void result.then((finished) => {
      this.completed.set(commandId, finished);
      while (this.completed.size > MAX_HISTORY) {
        const oldest = this.completed.keys().next().value;
        if (oldest === undefined) break;
        this.completed.delete(oldest);
      }
      options.signal?.removeEventListener('abort', onAbort);
    });
    return { commandId, result };
  }

  stop(commandId: string): boolean {
    const entry = this.active.get(commandId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  stopAll(): void {
    for (const id of this.active.keys()) this.stop(id);
    this.processes.killAll();
  }

  snapshot(commandId: string): CommandSnapshot | null {
    const active = this.active.get(commandId);
    if (active) {
      return {
        commandId,
        command: active.command,
        cwd: active.cwd,
        running: true,
        output: active.buffer,
        exitCode: null,
        durationMs: Date.now() - active.startedAt,
        truncated: false,
        timedOut: false,
        cancelled: false,
      };
    }
    const finished = this.completed.get(commandId);
    if (!finished) return null;
    return {
      commandId,
      command: finished.command,
      cwd: finished.cwd,
      running: false,
      output: finished.output,
      exitCode: finished.exitCode,
      durationMs: finished.durationMs,
      truncated: finished.truncated,
      timedOut: finished.timedOut,
      cancelled: finished.cancelled,
    };
  }

  listActive(): CommandSnapshot[] {
    return [...this.active.values()].map((entry) => ({
      commandId: entry.id,
      command: entry.command,
      cwd: entry.cwd,
      running: true,
      output: entry.buffer,
      exitCode: null,
      durationMs: Date.now() - entry.startedAt,
      truncated: false,
      timedOut: false,
      cancelled: false,
    }));
  }

  async diagnostics(cwd: string): Promise<Record<string, string>> {
    const probes: Array<[string, string]> = [
      ['node', 'node --version'],
      ['npm', 'npm --version'],
      ['git', 'git --version'],
      ['shell', 'echo shell-ok'],
    ];
    const results: Record<string, string> = {};
    for (const [name, command] of probes) {
      try {
        const result = await this.processes.run({
          command,
          cwd,
          timeoutMs: 15000,
          maxOutputChars: 4000,
        });
        results[name] = result.exitCode === 0 ? result.output.trim() : `unavailable (exit ${result.exitCode})`;
      } catch (error) {
        results[name] = `unavailable (${(error as Error).message})`;
      }
    }
    results.platform = process.platform;
    results.archive = process.arch;
    return results;
  }
}
