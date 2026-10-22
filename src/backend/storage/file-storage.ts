/**
 * File-based implementation of the Storage interface.
 *
 * All paths handed to this class are relative to the active data root and are
 * re-validated here, so a bug elsewhere cannot write outside the data root.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ZodTypeAny } from 'zod';
import {
  ensureDir,
  readJsonResilient,
  readJsonRaw,
  writeFileAtomic,
  directorySize,
} from './atomic-write';
import {
  type Storage,
  type StorageWarning,
  type WriteOptions,
  validateWithSchema,
} from './storage-interface';

export class StoragePausedError extends Error {
  constructor() {
    super('Storage is temporarily paused while application data is being moved. Try again in a moment.');
    this.name = 'StoragePausedError';
  }
}

export class PathEscapeError extends Error {
  constructor(relativePath: string) {
    super(`Path is outside the application data directory: ${relativePath}`);
    this.name = 'PathEscapeError';
  }
}

export class FileStorage implements Storage {
  private rootPath: string;
  private paused = false;
  private pendingWrites = 0;
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private idleWaiters: Array<() => void> = [];
  private readonly warnings: StorageWarning[] = [];
  private readonly warningListeners = new Set<(warning: StorageWarning) => void>();

  constructor(root: string) {
    this.rootPath = path.resolve(root);
  }

  get root(): string {
    return this.rootPath;
  }

  setRoot(nextRoot: string): void {
    this.rootPath = path.resolve(nextRoot);
    this.writeQueues.clear();
  }

  async init(): Promise<void> {
    await ensureDir(this.rootPath);
    for (const dir of ['app', 'projects', 'backups', 'logs', 'cache']) {
      await ensureDir(path.join(this.rootPath, dir));
    }
  }

  absolute(relativePath: string): string {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new PathEscapeError(String(relativePath));
    }
    if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
      throw new PathEscapeError(relativePath);
    }
    if (relativePath.includes('\0')) throw new PathEscapeError(relativePath);
    const resolved = path.resolve(this.rootPath, relativePath);
    const relative = path.relative(this.rootPath, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new PathEscapeError(relativePath);
    }
    return resolved;
  }

  private recordWarning(message: string, filePath: string | null): void {
    const warning: StorageWarning = { message, path: filePath, at: new Date().toISOString() };
    this.warnings.push(warning);
    if (this.warnings.length > 100) this.warnings.shift();
    for (const listener of this.warningListeners) listener(warning);
  }

  getWarnings(): StorageWarning[] {
    return [...this.warnings];
  }

  onWarning(listener: (warning: StorageWarning) => void): () => void {
    this.warningListeners.add(listener);
    return () => this.warningListeners.delete(listener);
  }

  pauseWrites(): void {
    this.paused = true;
  }

  resumeWrites(): void {
    this.paused = false;
  }

  async waitForIdle(): Promise<void> {
    if (this.pendingWrites === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private trackWrite<T>(operation: () => Promise<T>): Promise<T> {
    if (this.paused) return Promise.reject(new StoragePausedError());
    this.pendingWrites += 1;
    const run = operation().finally(() => {
      this.pendingWrites -= 1;
      if (this.pendingWrites === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const waiter of waiters) waiter();
      }
    });
    return run;
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.writeQueues.set(
      key,
      next.finally(() => {
        if (this.writeQueues.get(key) === next) this.writeQueues.delete(key);
      }),
    );
    return next;
  }

  async readJson<T>(relativePath: string, schema: ZodTypeAny, fallback: T): Promise<T> {
    const target = this.absolute(relativePath);
    const result = await readJsonResilient<T>(
      target,
      (raw) => {
        const validated = validateWithSchema<T>(schema, raw);
        if (!validated.ok) throw new Error(validated.error);
        return validated.value;
      },
      () => fallback,
      (message) => this.recordWarning(message, relativePath),
    );
    return result.value;
  }

  async writeJson(relativePath: string, value: unknown, options: WriteOptions = {}): Promise<void> {
    const target = this.absolute(relativePath);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await this.trackWrite(() => this.serialize(target, () => writeFileAtomic(target, text, options)));
  }

  async readText(relativePath: string): Promise<string | null> {
    const target = this.absolute(relativePath);
    try {
      return await fs.readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeText(relativePath: string, content: string, options: WriteOptions = {}): Promise<void> {
    const target = this.absolute(relativePath);
    await this.trackWrite(() => this.serialize(target, () => writeFileAtomic(target, content, options)));
  }

  async appendJsonLine(relativePath: string, value: unknown): Promise<void> {
    const target = this.absolute(relativePath);
    const line = `${JSON.stringify(value)}\n`;
    await this.trackWrite(() =>
      this.serialize(target, async () => {
        await ensureDir(path.dirname(target));
        await fs.appendFile(target, line, 'utf8');
      }),
    );
  }

  async readJsonLines<T>(relativePath: string, schema: ZodTypeAny): Promise<T[]> {
    const target = this.absolute(relativePath);
    let text: string;
    try {
      text = await fs.readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const values: T[] = [];
    let invalid = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = schema.safeParse(JSON.parse(line) as unknown);
        if (parsed.success) values.push(parsed.data as T);
        else invalid += 1;
      } catch {
        invalid += 1;
      }
    }
    if (invalid > 0) {
      this.recordWarning(
        `Skipped ${invalid} unreadable line${invalid === 1 ? '' : 's'} in ${relativePath}. The file was left untouched.`,
        relativePath,
      );
    }
    return values;
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.stat(this.absolute(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async ensureDir(relativePath: string): Promise<void> {
    await ensureDir(this.absolute(relativePath));
  }

  async listDir(relativePath: string): Promise<string[]> {
    try {
      return await fs.readdir(this.absolute(relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async remove(relativePath: string, recursive = false): Promise<void> {
    const target = this.absolute(relativePath);
    await this.trackWrite(async () =>
      this.serialize(target, async () => {
        await fs.rm(target, { recursive, force: true });
      }),
    );
  }

  async rename(fromRelativePath: string, toRelativePath: string): Promise<void> {
    const from = this.absolute(fromRelativePath);
    const to = this.absolute(toRelativePath);
    await this.trackWrite(async () => {
      await ensureDir(path.dirname(to));
      await fs.rename(from, to);
    });
  }

  async copy(fromRelativePath: string, toRelativePath: string): Promise<void> {
    const from = this.absolute(fromRelativePath);
    const to = this.absolute(toRelativePath);
    await this.trackWrite(async () => {
      await ensureDir(path.dirname(to));
      await fs.copyFile(from, to);
    });
  }

  async modifiedAgeSeconds(relativePath: string): Promise<number | null> {
    try {
      const stat = await fs.stat(this.absolute(relativePath));
      return (Date.now() - stat.mtimeMs) / 1000;
    } catch {
      return null;
    }
  }

  async sizeBytes(): Promise<number> {
    return directorySize(this.rootPath);
  }

  /** Direct read without validation, used by migrations backfills. */
  async readJsonUnknown(relativePath: string): Promise<unknown | null> {
    return readJsonRaw(this.absolute(relativePath));
  }
}
