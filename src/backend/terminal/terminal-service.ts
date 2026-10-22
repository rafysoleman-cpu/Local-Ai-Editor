/**
 * Interactive terminal sessions.
 *
 * The renderer (xterm.js) handles display and line editing; this service owns
 * the process, the working directory and command lifecycle. Each entered line is
 * executed by the ProcessManager in the project workspace.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AppSettings,
  Project,
  TerminalChunk,
  TerminalExit,
  TerminalSession,
} from '@shared/app-types';
import type { Logger } from '../logging/logger';
import type { ProjectService } from '../projects/project-service';
import { resolveWorkspacePath } from '../projects/path-safety';
import type { ProcessManager } from './process-manager';
import { nowIso, shortRandom } from '../util/ids';
import { analyzeCommand } from './command-policy';

interface Session {
  info: TerminalSession;
  controller: AbortController | null;
  running: boolean;
  history: string[];
}

export interface TerminalServiceDeps {
  processes: ProcessManager;
  projects: ProjectService;
  settings: () => AppSettings;
  logger: Logger;
  emitChunk: (chunk: TerminalChunk) => void;
  emitExit: (exit: TerminalExit) => void;
}

export class TerminalService {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: TerminalServiceDeps) {}

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info }));
  }

  private chunk(sessionId: string, data: string, stream: TerminalChunk['stream'] = 'system'): void {
    this.deps.emitChunk({ sessionId, data, stream });
  }

  private prompt(session: Session): void {
    this.chunk(session.info.id, `${this.shortCwd(session)}> `);
  }

  private shortCwd(session: Session): string {
    const root = this.workspaceRoot(session.info.projectId);
    if (!root) return session.info.cwd;
    const relative = path.relative(root, session.info.cwd);
    if (!relative) return '.';
    return relative.startsWith('..') ? session.info.cwd : relative;
  }

  private readonly projectRoots = new Map<string, string>();

  private workspaceRoot(projectId: string): string | null {
    return this.projectRoots.get(projectId) ?? null;
  }

  async create(projectId: string): Promise<TerminalSession> {
    const project = await this.deps.projects.require(projectId);
    await this.ensureWorkspace(project);
    const id = `term_${shortRandom(6)}`;
    const info: TerminalSession = {
      id,
      projectId,
      cwd: project.workspacePath,
      shell: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh',
      platform: process.platform,
      createdAt: nowIso(),
    };
    this.projectRoots.set(projectId, project.workspacePath);
    this.sessions.set(id, { info, controller: null, running: false, history: [] });
    this.chunk(
      id,
      `Local AI Editor terminal\r\n${info.platform} · ${info.shell}\r\nType "help" for built-in commands.\r\n\r\n`,
    );
    this.prompt(this.sessions.get(id)!);
    return info;
  }

  private async ensureWorkspace(project: Project): Promise<void> {
    const stat = await fs.stat(project.workspacePath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Project workspace does not exist: ${project.workspacePath}`);
    }
  }

  async input(sessionId: string, data: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Terminal session not found.');
    const line = data.replace(/[\r\n]+$/, '');
    if (!line.trim()) {
      this.prompt(session);
      return;
    }
    if (session.running) {
      this.chunk(sessionId, `\r\nA command is still running. Press Ctrl+C to stop it.\r\n`, 'stderr');
      return;
    }
    session.history.push(line);
    if (session.history.length > 100) session.history.shift();

    const trimmed = line.trim();
    const [commandName] = trimmed.split(/\s+/);
    const argument = trimmed.slice(commandName.length).trim();

    if (commandName === 'help') {
      this.chunk(
        sessionId,
        [
          'Built-in commands:',
          '  cd <path>   change directory inside the project',
          '  pwd         print working directory',
          '  clear/cls   clear the screen',
          '  exit        close this terminal',
          'All other input runs in the project shell.',
          '',
        ].join('\r\n'),
      );
      this.prompt(session);
      return;
    }
    if (commandName === 'pwd') {
      this.chunk(sessionId, `${session.info.cwd}\r\n`, 'stdout');
      this.prompt(session);
      return;
    }
    if (commandName === 'clear' || commandName === 'cls') {
      this.chunk(sessionId, '\x1b[2J\x1b[H');
      this.prompt(session);
      return;
    }
    if (commandName === 'exit' || commandName === 'quit') {
      this.dispose(sessionId);
      return;
    }
    if (commandName === 'cd') {
      try {
        const target = argument || '.';
        const resolved = await resolveWorkspacePath(this.projectRoots.get(session.info.projectId) ?? session.info.cwd, target, {
          mustExist: true,
        });
        const stat = await fs.stat(resolved.absolutePath);
        if (!stat.isDirectory()) throw new Error('Not a folder.');
        session.info.cwd = resolved.absolutePath;
      } catch (error) {
        this.chunk(sessionId, `cd: ${(error as Error).message}\r\n`, 'stderr');
      }
      this.prompt(session);
      return;
    }

    const analysis = analyzeCommand(trimmed);
    if (analysis.blocked) {
      this.chunk(sessionId, `Refused: ${analysis.reason}\r\n`, 'stderr');
      this.prompt(session);
      return;
    }

    session.running = true;
    session.controller = new AbortController();
    const startedAt = Date.now();
    try {
      const result = await this.deps.processes.run({
        command: line,
        cwd: session.info.cwd,
        timeoutMs: this.deps.settings().limits.maxCommandMs,
        maxOutputChars: this.deps.settings().limits.maxOutputChars,
        signal: session.controller.signal,
        onChunk: (stream, text) => this.chunk(sessionId, text, stream),
      });
      this.deps.emitExit({
        sessionId,
        code: result.exitCode,
        signal: result.signal,
        durationMs: Date.now() - startedAt,
        cancelled: result.cancelled,
        timedOut: result.timedOut,
      });
    } catch (error) {
      this.chunk(sessionId, `\r\n${(error as Error).message}\r\n`, 'stderr');
      this.deps.emitExit({
        sessionId,
        code: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        cancelled: false,
        timedOut: false,
      });
    } finally {
      session.running = false;
      session.controller = null;
      if (this.sessions.has(sessionId)) this.prompt(session);
    }
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.controller) {
      session.controller.abort();
      this.chunk(sessionId, '^C\r\n', 'system');
    }
  }

  dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.controller?.abort();
    this.sessions.delete(sessionId);
    this.chunk(sessionId, '\r\n[terminal closed]\r\n', 'system');
    this.deps.logger.debug('terminal', 'Terminal session disposed', { sessionId });
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id);
  }
}
