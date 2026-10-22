/**
 * Low-level durable file primitives.
 *
 * - Writes go to a temporary file in the same directory and are then renamed
 *   over the target, so a crash can never leave a half-written JSON document.
 * - Before a critical file is replaced, its previous version is copied to a
 *   `.bak` sibling. Readers recover from that sibling when the primary file is
 *   corrupt, and the corrupt file is quarantined instead of deleted.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface AtomicWriteOptions {
  /** Keep a `.bak` copy of the previous file (default true). */
  backup?: boolean;
}

export async function ensureDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

function temporaryName(target: string): string {
  const suffix = randomBytes(6).toString('hex');
  return path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.tmp`);
}

export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await ensureDir(path.dirname(target));
  if (options.backup !== false) {
    await backupExisting(target);
  }
  const temp = temporaryName(target);
  try {
    await fs.writeFile(temp, data, 'utf8');
    // Flush to disk before the rename so the replacement is crash-safe.
    const handle = await fs.open(temp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function backupExisting(target: string): Promise<void> {
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return;
    await fs.copyFile(target, `${target}.bak`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function copyFileAtomic(source: string, target: string): Promise<void> {
  const data = await fs.readFile(source);
  await writeFileAtomic(target, data, { backup: false });
}

export interface JsonReadResult<T> {
  value: T;
  /** 'primary' when the main file parsed, 'backup' when recovered from .bak. */
  source: 'primary' | 'backup';
  corruptFilePath: string | null;
}

export class JsonParseError extends Error {
  constructor(
    readonly filePath: string,
    message: string,
  ) {
    super(message);
    this.name = 'JsonParseError';
  }
}

/** Read and JSON.parse a file, returning null when it does not exist. */
export async function readJsonRaw(filePath: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (text.trim().length === 0) {
    throw new JsonParseError(filePath, 'File is empty');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new JsonParseError(filePath, `Invalid JSON: ${(error as Error).message}`);
  }
}

/**
 * Read JSON with recovery:
 *   primary -> quarantine if corrupt -> try `.bak` -> quarantine if corrupt -> fallback
 */
export async function readJsonResilient<T>(
  filePath: string,
  parse: (raw: unknown) => T,
  fallback: () => T,
  onWarning?: (message: string) => void,
): Promise<JsonReadResult<T>> {
  let corruptFilePath: string | null = null;
  const primary = await tryRead(filePath, parse);
  if (primary.ok) {
    return { value: primary.value, source: 'primary', corruptFilePath: null };
  }
  if (primary.missing) {
    return { value: fallback(), source: 'primary', corruptFilePath: null };
  }
  corruptFilePath = await quarantine(filePath, primary.reason);
  onWarning?.(`Could not read ${path.basename(filePath)}: ${primary.reason}. Kept a copy at ${corruptFilePath}.`);

  const backup = await tryRead(`${filePath}.bak`, parse);
  if (backup.ok) {
    onWarning?.(`Recovered ${path.basename(filePath)} from its backup copy.`);
    return { value: backup.value, source: 'backup', corruptFilePath };
  }
  if (!backup.missing) {
    await quarantine(`${filePath}.bak`, backup.reason);
  }
  return { value: fallback(), source: 'primary', corruptFilePath };
}

type TryReadResult<T> =
  | { ok: true; value: T; missing?: undefined; reason?: undefined }
  | { ok: false; missing: boolean; reason: string };

async function tryRead<T>(filePath: string, parse: (raw: unknown) => T): Promise<TryReadResult<T>> {
  try {
    const raw = await readJsonRaw(filePath);
    if (raw === null) return { ok: false, missing: true, reason: 'File does not exist' };
    return { ok: true, value: parse(raw) };
  } catch (error) {
    return { ok: false, missing: false, reason: (error as Error).message };
  }
}

/** Rename a damaged file out of the way instead of deleting it. */
export async function quarantine(filePath: string, reason: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${filePath}.corrupt-${stamp}`;
  try {
    await fs.rename(filePath, target);
    await fs.writeFile(`${target}.reason.txt`, `${new Date().toISOString()}\n${reason}\n`, 'utf8');
    return target;
  } catch {
    return filePath;
  }
}

/** Recursively copy a directory tree (used for backups and relocation). */
export async function copyDirectory(
  source: string,
  target: string,
  options: { filter?: (relativePath: string) => boolean; onFile?: (relativePath: string, bytes: number) => void } = {},
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  async function walk(from: string, to: string, relative: string): Promise<void> {
    await ensureDir(to);
    const entries = await fs.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (options.filter && !options.filter(childRelative)) continue;
      const childFrom = path.join(from, entry.name);
      const childTo = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await walk(childFrom, childTo, childRelative);
      } else if (entry.isFile()) {
        const stat = await fs.stat(childFrom);
        await ensureDir(path.dirname(childTo));
        await fs.copyFile(childFrom, childTo);
        files += 1;
        bytes += stat.size;
        options.onFile?.(childRelative, stat.size);
      }
    }
  }
  await walk(source, target, '');
  return { files, bytes };
}

/** Sum file sizes below a directory. */
export async function directorySize(directory: string): Promise<number> {
  let total = 0;
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        try {
          total += (await fs.stat(child)).size;
        } catch {
          /* ignore vanished files */
        }
      }
    }
  }
  await walk(directory);
  return total;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}
