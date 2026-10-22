/**
 * Small structured logger.
 *
 * Writes newline-delimited JSON to the data directory and mirrors important
 * events to the main-process console. Secrets are redacted before writing.
 */
import { STORAGE_PATHS } from '../storage/paths';
import type { Storage } from '../storage/storage-interface';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SECRET_PATTERN =
  /(api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*["']?([^\s"',;]{4,})/gi;
const BEARER_PATTERN = /bearer\s+[a-z0-9._-]{8,}/gi;

export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_PATTERN, (_match, key: string) => `${key}=[redacted]`)
    .replace(BEARER_PATTERN, 'Bearer [redacted]');
}

export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
}

export class Logger {
  private static readonly MAX_BUFFER = 500;
  private readonly buffer: LogEntry[] = [];
  private queue: Promise<void> = Promise.resolve();
  private storage: Storage | null = null;

  constructor(
    private readonly minimumLevel: LogLevel = 'info',
    private readonly mirrorToConsole = true,
  ) {}

  attachStorage(storage: Storage): void {
    this.storage = storage;
  }

  private levelRank(level: LogLevel): number {
    return { debug: 10, info: 20, warn: 30, error: 40 }[level];
  }

  log(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): void {
    if (this.levelRank(level) < this.levelRank(this.minimumLevel)) return;
    const entry: LogEntry = {
      at: new Date().toISOString(),
      level,
      scope,
      message: redactSecrets(message),
      meta: meta ? JSON.parse(redactSecrets(JSON.stringify(meta))) : undefined,
    };
    this.buffer.push(entry);
    if (this.buffer.length > Logger.MAX_BUFFER) this.buffer.shift();
    if (this.mirrorToConsole) {
      const line = `[${entry.at}] ${level.toUpperCase()} ${scope}: ${entry.message}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    this.persist(entry);
  }

  debug(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.log('debug', scope, message, meta);
  }
  info(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.log('info', scope, message, meta);
  }
  warn(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.log('warn', scope, message, meta);
  }
  error(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.log('error', scope, message, meta);
  }

  private persist(entry: LogEntry): void {
    const storage = this.storage;
    if (!storage) return;
    this.queue = this.queue
      .then(() => storage.appendJsonLine(STORAGE_PATHS.appLog, entry))
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  recent(limit = 200): LogEntry[] {
    return this.buffer.slice(-limit);
  }
}
