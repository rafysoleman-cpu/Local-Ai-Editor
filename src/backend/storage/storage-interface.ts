/**
 * Replaceable persistence interface.
 *
 * The UI and the agent runtime only talk to this interface, so a SQLite
 * implementation can be added later without touching feature code.
 */
import type { ZodTypeAny, z } from 'zod';

export interface StorageWarning {
  message: string;
  path: string | null;
  at: string;
}

export interface WriteOptions {
  /** Create a `.bak` copy of the previous file before replacing it. */
  backup?: boolean;
}

export interface Storage {
  /** Absolute active data root. */
  readonly root: string;
  setRoot(nextRoot: string): void;

  init(): Promise<void>;

  /** Read a JSON document relative to the data root, with recovery. */
  readJson<T>(relativePath: string, schema: ZodTypeAny, fallback: T): Promise<T>;
  writeJson(relativePath: string, value: unknown, options?: WriteOptions): Promise<void>;
  readText(relativePath: string): Promise<string | null>;
  writeText(relativePath: string, content: string, options?: WriteOptions): Promise<void>;

  appendJsonLine(relativePath: string, value: unknown): Promise<void>;
  readJsonLines<T>(relativePath: string, schema: ZodTypeAny): Promise<T[]>;

  exists(relativePath: string): Promise<boolean>;
  ensureDir(relativePath: string): Promise<void>;
  listDir(relativePath: string): Promise<string[]>;
  remove(relativePath: string, recursive?: boolean): Promise<void>;
  rename(fromRelativePath: string, toRelativePath: string): Promise<void>;
  copy(fromRelativePath: string, toRelativePath: string): Promise<void>;
  absolute(relativePath: string): string;

  /** Seconds since the last modification of a file, or null when missing. */
  modifiedAgeSeconds(relativePath: string): Promise<number | null>;

  /** Block new writes (used while relocating data), then allow them again. */
  pauseWrites(): void;
  resumeWrites(): void;
  waitForIdle(): Promise<void>;

  getWarnings(): StorageWarning[];
  onWarning(listener: (warning: StorageWarning) => void): () => void;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateWithSchema<T>(schema: ZodTypeAny, raw: unknown): ValidationResult<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') };
  }
  return { ok: true, value: parsed.data as T };
}

export type InferSchema<T extends ZodTypeAny> = z.infer<T>;
