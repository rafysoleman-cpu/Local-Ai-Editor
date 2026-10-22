/**
 * Backend process manager.
 *
 * Commands are spawned without a shell string built from user input beyond the
 * command itself, with a workspace working directory, a hard timeout, an output
 * cap and process-tree termination.
 *
 * Stdio strategy: pipes are preferred (true streaming). Some locked-down
 * environments forbid pipe creation; in that case the manager transparently
 * falls back to file-descriptor stdio and tails the output files, so the app
 * keeps working and reports it in diagnostics.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface ProcessSpec {
  command: string;
  /** When provided, the program is spawned directly with these arguments (no shell). */
  args?: string[];
  /** Human-readable command for logs and results. */
  displayCommand?: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Optional caller-supplied id, used to stop a running command. */
  id?: string;
}

export interface ProcessResult {
  commandId: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  output: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  stdioMode: 'pipe' | 'file';
  pid: number | null;
}

export class ProcessStartError extends Error {
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message);
    this.name = 'ProcessStartError';
  }
}

const isWindows = process.platform === 'win32';

function shellInvocation(command: string): { file: string; args: string[] } {
  if (isWindows) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: process.env.SHELL || '/bin/sh', args: ['-lc', command] };
}

export function describeShell(): string {
  return isWindows ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
}

function killTree(pid: number | null, force = true): void {
  if (!pid) return;
  if (isWindows) {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    return;
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

function appendCapped(current: string, chunk: string, cap: number): { text: string; truncated: boolean } {
  if (current.length >= cap) return { text: current, truncated: true };
  const remaining = cap - current.length;
  if (chunk.length <= remaining) return { text: current + chunk, truncated: false };
  return { text: current + chunk.slice(0, remaining), truncated: true };
}

export class ProcessManager {
  private readonly live = new Map<number, ChildProcess>();
  private readonly runningCommands = new Map<string, { pid: number | null; command: string; startedAt: number }>();

  constructor(private readonly tempRoot: string) {}

  listRunning(): Array<{ pid: number | null; command: string; startedAt: number }> {
    return [...this.runningCommands.values()];
  }

  killAll(): void {
    for (const pid of this.live.keys()) killTree(pid);
    this.live.clear();
  }

  /** Run a command to completion. Never rejects for a non-zero exit code. */
  async run(spec: ProcessSpec): Promise<ProcessResult> {
    const startedAt = Date.now();
    const commandId = spec.id ?? `cmd_${randomBytes(6).toString('hex')}`;
    const invocation = spec.args
      ? { file: spec.command, args: spec.args }
      : shellInvocation(spec.command);
    const displayCommand = spec.displayCommand ?? spec.command;
    const env = {
      ...process.env,
      ...spec.env,
      TERM: 'xterm-256color',
      LAIE_COMMAND_ID: commandId,
    };
    const options = {
      cwd: spec.cwd,
      env,
      windowsHide: true,
      // Node must not re-quote a cmd.exe command line: cmd performs its own
      // parsing, and backslash-escaped quotes break arguments like -e "code".
      ...(isWindows && !spec.args ? { windowsVerbatimArguments: true } : {}),
    } as const;

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let child: ChildProcess | null = null;
    let stdioMode: 'pipe' | 'file' = 'pipe';

    const pushChunk = (stream: 'stdout' | 'stderr', text: string): void => {
      if (!text) return;
      const target = stream === 'stdout' ? stdout : stderr;
      const capped = appendCapped(target, text, spec.maxOutputChars);
      if (capped.truncated) truncated = true;
      if (stream === 'stdout') stdout = capped.text;
      else stderr = capped.text;
      try {
        spec.onChunk?.(stream, text);
      } catch {
        /* listener errors must not break the process */
      }
    };

    let resolveDone: (result: ProcessResult) => void = () => undefined;
    const done = new Promise<ProcessResult>((resolve) => {
      resolveDone = resolve;
    });

    const finalize = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (spec.signal) spec.signal.removeEventListener('abort', onAbort);
      if (child?.pid) this.live.delete(child.pid);
      this.runningCommands.delete(commandId);
      const combined = [stdout, stderr].filter(Boolean).join('\n');
      resolveDone({
        commandId,
        command: displayCommand,
        cwd: spec.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        output: truncated ? `${combined}\n\n[output truncated at ${spec.maxOutputChars} characters]` : combined,
        durationMs: Date.now() - startedAt,
        truncated,
        timedOut,
        cancelled,
        stdioMode,
        pid: child?.pid ?? null,
      });
    };

    const onAbort = (): void => {
      cancelled = true;
      killTree(child?.pid ?? null);
      setTimeout(finalize, 800).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child?.pid ?? null);
      setTimeout(finalize, 800).unref?.();
    }, spec.timeoutMs);
    timer.unref?.();

    if (spec.signal) {
      if (spec.signal.aborted) {
        cancelled = true;
        exitCode = null;
        finalize();
        return done;
      }
      spec.signal.addEventListener('abort', onAbort, { once: true });
    }

    const attachPipeHandlers = (proc: ChildProcess): void => {
      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');
      proc.stdout?.on('data', (data: string) => pushChunk('stdout', data));
      proc.stderr?.on('data', (data: string) => pushChunk('stderr', data));
    };

    const handleExit = (code: number | null, sig: NodeJS.Signals | null): void => {
      exitCode = code;
      signal = sig ?? null;
      finalize();
    };

    // 1) Preferred: pipes.
    try {
      child = spawn(invocation.file, invocation.args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      stdioMode = 'pipe';
      attachPipeHandlers(child);
      child.on('error', (error) => {
        if (settled) return;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          exitCode = 127;
          pushChunk('stderr', `Command shell not found: ${invocation.file}\n`);
        } else {
          pushChunk('stderr', `Failed to start command: ${error.message}\n`);
          exitCode = 126;
        }
        finalize();
      });
      child.on('close', handleExit);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP') throw error;
      // 2) Fallback: file-descriptor stdio, then tail the files.
      stdout = '';
      stderr = '';
      const result = await this.runWithFileStdio(spec, invocation, env, startedAt, commandId, pushChunk);
      return result;
    }

    if (child.pid) {
      this.live.set(child.pid, child);
      this.runningCommands.set(commandId, {
        pid: child.pid,
        command: displayCommand,
        startedAt,
      });
    }

    return done;
  }

  private async runWithFileStdio(
    spec: ProcessSpec,
    invocation: { file: string; args: string[] },
    env: NodeJS.ProcessEnv,
    startedAt: number,
    commandId: string,
    pushChunk: (stream: 'stdout' | 'stderr', text: string) => void,
  ): Promise<ProcessResult> {
    const directory = path.join(this.tempRoot, commandId);
    await fs.mkdir(directory, { recursive: true });
    const stdoutPath = path.join(directory, 'stdout.log');
    const stderrPath = path.join(directory, 'stderr.log');
    await fs.writeFile(stdoutPath, '');
    await fs.writeFile(stderrPath, '');
    const { openSync, closeSync } = await import('node:fs');
    const outFd = openSync(stdoutPath, 'a');
    const errFd = openSync(stderrPath, 'a');

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let offsets = { out: 0, err: 0 };
    let child: ChildProcess | null = null;
    let pollTimer: NodeJS.Timeout | null = null;

    let resolveDone: (result: ProcessResult) => void = () => undefined;
    const done = new Promise<ProcessResult>((resolve) => {
      resolveDone = resolve;
    });

    const finalize = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      if (spec.signal) spec.signal.removeEventListener('abort', onAbort);
      void (async () => {
        await tailOnce();
        closeSync(outFd);
        closeSync(errFd);
        if (child?.pid) this.live.delete(child.pid);
        this.runningCommands.delete(commandId);
        const combined = [stdout, stderr].filter(Boolean).join('\n');
        resolveDone({
          commandId,
          command: spec.displayCommand ?? spec.command,
          cwd: spec.cwd,
          exitCode,
          signal,
          stdout,
          stderr,
          output: truncated ? `${combined}\n\n[output truncated at ${spec.maxOutputChars} characters]` : combined,
          durationMs: Date.now() - startedAt,
          truncated,
          timedOut,
          cancelled,
          stdioMode: 'file',
          pid: child?.pid ?? null,
        });
      })();
    };

    const tailOnce = async (): Promise<void> => {
      for (const [stream, file, key] of [
        ['stdout', stdoutPath, 'out'] as const,
        ['stderr', stderrPath, 'err'] as const,
      ]) {
        try {
          const buffer = await fs.readFile(file);
          if (buffer.length <= offsets[key]) continue;
          const chunk = buffer.subarray(offsets[key]).toString('utf8');
          offsets[key] = buffer.length;
          if (stream === 'stdout') {
            const capped = appendCapped(stdout, chunk, spec.maxOutputChars);
            if (capped.truncated) truncated = true;
            stdout = capped.text;
          } else {
            const capped = appendCapped(stderr, chunk, spec.maxOutputChars);
            if (capped.truncated) truncated = true;
            stderr = capped.text;
          }
          pushChunk(stream, chunk);
        } catch {
          /* ignore read races */
        }
      }
    };

    const onAbort = (): void => {
      cancelled = true;
      killTree(child?.pid ?? null);
      setTimeout(finalize, 600);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child?.pid ?? null);
      setTimeout(finalize, 600);
    }, spec.timeoutMs);
    timer.unref?.();

    if (spec.signal) {
      if (spec.signal.aborted) {
        cancelled = true;
        closeSync(outFd);
        closeSync(errFd);
        finalize();
        return done;
      }
      spec.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      child = spawn(invocation.file, invocation.args, {
        cwd: spec.cwd,
        env,
        windowsHide: true,
        ...(isWindows && !spec.args ? { windowsVerbatimArguments: true } : {}),
        stdio: ['ignore', outFd, errFd],
      });
    } catch (error) {
      closeSync(outFd);
      closeSync(errFd);
      throw new ProcessStartError(
        `Could not start command "${spec.command}": ${(error as Error).message}`,
        spec.command,
      );
    }
    if (child.pid) {
      this.live.set(child.pid, child);
      this.runningCommands.set(commandId, { pid: child.pid, command: spec.displayCommand ?? spec.command, startedAt });
    }
    pollTimer = setInterval(() => void tailOnce(), 60);
    pollTimer.unref?.();
    child.on('error', (error) => {
      pushChunk('stderr', `Failed to start command: ${error.message}\n`);
      exitCode = 126;
      finalize();
    });
    child.on('close', (code, sig) => {
      exitCode = code;
      signal = sig ?? null;
      finalize();
    });
    return done;
  }
}
