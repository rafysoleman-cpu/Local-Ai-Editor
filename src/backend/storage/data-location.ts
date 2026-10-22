/**
 * Controls where application data lives and how it is relocated.
 *
 * The active location is stored in a small pointer file inside Electron's
 * userData directory, so the data itself can live anywhere (including a
 * different drive) without changing the installed application.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { storageManifestSchema } from '@shared/validation';
import type {
  BackupInfo,
  DataStorageInfo,
  RelocationResult,
  StorageManifest,
} from '@shared/app-types';
import type { Logger } from '../logging/logger';
import { copyDirectory, directorySize, pathExists, readJsonRaw, writeFileAtomic } from './atomic-write';
import type { BackupService } from './backup-service';
import type { FileStorage } from './file-storage';
import { STORAGE_PATHS } from './paths';

interface PointerFile {
  dataDirectory: string;
  updatedAt: string;
  previousDirectory?: string;
}

export interface TargetValidation {
  ok: boolean;
  reason: string | null;
  freeBytes: number | null;
}

const MOVE_FILTER = (relativePath: string): boolean => {
  const top = relativePath.split(/[\\/]/)[0];
  return top !== 'cache';
};

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function freeBytesFor(directory: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export class DataLocationManager {
  private readonly pointerPath: string;
  private activeDirectory: string;

  constructor(
    private readonly userDataDirectory: string,
    private readonly defaultDirectory: string,
    private readonly storage: FileStorage,
    private readonly backups: BackupService,
    private readonly logger: Logger,
    private readonly appVersion: string,
    /** Optional explicit data directory (portable installs / automated tests). */
    private readonly overrideDirectory: string | null = null,
  ) {
    this.pointerPath = path.join(userDataDirectory, 'storage-location.json');
    this.activeDirectory = defaultDirectory;
  }

  get pointerFilePath(): string {
    return this.pointerPath;
  }

  get active(): string {
    return this.activeDirectory;
  }

  /**
   * Resolve and prepare the active data directory. Invalid pointers are never
   * silently discarded: they are preserved with a `.invalid-<timestamp>` suffix.
   */
  async resolve(): Promise<{ dataDirectory: string; warning: string | null }> {
    let warning: string | null = null;
    let chosen = this.defaultDirectory;

    if (this.overrideDirectory) {
      const override = path.resolve(this.overrideDirectory);
      await fs.mkdir(override, { recursive: true });
      this.activeDirectory = override;
      this.storage.setRoot(override);
      await this.storage.init();
      this.logger.info('storage', 'Using explicit data directory from environment', {
        dataDirectory: override,
      });
      return { dataDirectory: override, warning: null };
    }

    const raw = await readJsonRaw(this.pointerPath).catch(() => null);
    if (raw && typeof raw === 'object' && typeof (raw as { dataDirectory?: unknown }).dataDirectory === 'string') {
      const candidate = path.resolve((raw as PointerFile).dataDirectory);
      if (await pathExists(candidate)) {
        chosen = candidate;
      } else {
        warning = `The configured data directory no longer exists: ${candidate}. Using the default location instead. Your old data was not deleted.`;
        this.logger.warn('storage', warning);
      }
    } else if (raw !== null) {
      const invalidPath = `${this.pointerPath}.invalid-${Date.now()}`;
      await fs.rename(this.pointerPath, invalidPath).catch(() => undefined);
      warning = `The storage location file was unreadable. A copy was kept at ${invalidPath} and the default location is being used.`;
      this.logger.warn('storage', warning);
    }

    this.activeDirectory = path.resolve(chosen);
    await fs.mkdir(this.activeDirectory, { recursive: true });
    this.storage.setRoot(this.activeDirectory);
    await this.storage.init();
    await this.writePointer(this.activeDirectory);
    return { dataDirectory: this.activeDirectory, warning };
  }

  private async writePointer(directory: string, previousDirectory?: string): Promise<void> {
    await fs.mkdir(this.userDataDirectory, { recursive: true });
    const pointer: PointerFile = {
      dataDirectory: directory,
      updatedAt: new Date().toISOString(),
      ...(previousDirectory ? { previousDirectory } : {}),
    };
    await writeFileAtomic(this.pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, { backup: true });
  }

  async readManifest(): Promise<StorageManifest | null> {
    try {
      const raw = await readJsonRaw(this.storage.absolute(STORAGE_PATHS.manifest));
      if (!raw) return null;
      const parsed = storageManifestSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async writeManifest(manifest: StorageManifest): Promise<void> {
    await this.storage.writeJson(STORAGE_PATHS.manifest, manifest);
  }

  async info(): Promise<DataStorageInfo> {
    const root = this.storage.root;
    const latestBackup: BackupInfo | null = await this.backups.latest().catch(() => null);
    const allBackups = await this.backups.list().catch(() => [] as BackupInfo[]);
    const manifest = await this.readManifest();
    let writable = true;
    try {
      const probe = path.join(root, `.write-probe-${Date.now()}`);
      await fs.writeFile(probe, 'ok', 'utf8');
      await fs.rm(probe, { force: true });
    } catch {
      writable = false;
    }
    return {
      dataDirectory: root,
      sizeBytes: await directorySize(root).catch(() => 0),
      freeBytes: await freeBytesFor(root),
      backupCount: allBackups.length,
      latestBackup,
      manifest,
      writable,
    };
  }

  async validateTarget(targetDirectory: string): Promise<TargetValidation> {
    const current = path.resolve(this.storage.root);
    if (!targetDirectory || !targetDirectory.trim()) {
      return { ok: false, reason: 'Choose a destination folder.', freeBytes: null };
    }
    if (!path.isAbsolute(targetDirectory)) {
      return { ok: false, reason: 'The destination must be an absolute path.', freeBytes: null };
    }
    const target = path.resolve(targetDirectory.trim());
    if (target === current) {
      return { ok: false, reason: 'The destination is the current data directory.', freeBytes: null };
    }
    if (isInside(target, current)) {
      return {
        ok: false,
        reason: 'The destination cannot be inside the current data directory (this would recursively copy the data).',
        freeBytes: null,
      };
    }
    if (isInside(current, target)) {
      return {
        ok: false,
        reason: 'The destination cannot be a parent of the current data directory.',
        freeBytes: null,
      };
    }
    if (path.parse(target).root === target) {
      return { ok: false, reason: 'Choose a subfolder rather than a drive root.', freeBytes: null };
    }

    const existing = await fs.stat(target).catch(() => null);
    if (existing) {
      if (!existing.isDirectory()) {
        return { ok: false, reason: 'The destination exists but is not a folder.', freeBytes: null };
      }
      const entries = await fs.readdir(target);
      if (entries.length > 0) {
        return {
          ok: false,
          reason: 'The destination folder is not empty. Choose an empty folder so existing files cannot be overwritten.',
          freeBytes: await freeBytesFor(target),
        };
      }
    } else {
      const parent = path.dirname(target);
      const parentStat = await fs.stat(parent).catch(() => null);
      if (!parentStat || !parentStat.isDirectory()) {
        return { ok: false, reason: 'The parent folder of the destination does not exist.', freeBytes: null };
      }
      try {
        await fs.mkdir(target, { recursive: false });
      } catch (error) {
        return {
          ok: false,
          reason: `Could not create the destination folder: ${(error as Error).message}`,
          freeBytes: null,
        };
      }
    }

    try {
      const probe = path.join(target, `.laie-probe-${Date.now()}`);
      await fs.writeFile(probe, 'probe', 'utf8');
      await fs.rm(probe, { force: true });
    } catch (error) {
      return { ok: false, reason: `The destination is not writable: ${(error as Error).message}`, freeBytes: null };
    }

    return { ok: true, reason: null, freeBytes: await freeBytesFor(target) };
  }

  private async countProjectDocuments(root: string): Promise<number> {
    const projectsRoot = path.join(root, 'projects');
    let count = 0;
    let entries;
    try {
      entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await pathExists(path.join(projectsRoot, entry.name, 'project.json'))) count += 1;
    }
    return count;
  }

  private async countFiles(root: string): Promise<number> {
    let count = 0;
    async function walk(current: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) await walk(path.join(current, entry.name));
        else if (entry.isFile()) count += 1;
      }
    }
    await walk(root);
    return count;
  }

  /**
   * Move application data to a new directory.
   *
   * The original directory is never deleted. The active location only switches
   * after the copied data has been verified, and writes are paused throughout.
   */
  async moveData(targetDirectory: string): Promise<RelocationResult> {
    const validation = await this.validateTarget(targetDirectory);
    if (!validation.ok) throw new Error(validation.reason ?? 'Invalid destination.');
    const target = path.resolve(targetDirectory.trim());
    const previous = path.resolve(this.storage.root);

    const sourceBytes = await directorySize(previous).catch(() => 0);
    if (validation.freeBytes !== null && validation.freeBytes < sourceBytes * 1.05) {
      throw new Error(
        `Not enough free space at the destination: need about ${Math.ceil((sourceBytes * 1.05) / 1024 / 1024)} MB, available ${Math.floor(validation.freeBytes / 1024 / 1024)} MB.`,
      );
    }

    this.storage.pauseWrites();
    let copied = { files: 0, bytes: 0 };
    try {
      await this.storage.waitForIdle();
      copied = await copyDirectory(previous, target, { filter: MOVE_FILTER });

      // Verification: manifest, project documents and file counts must match.
      const sourceProjects = await this.countProjectDocuments(previous);
      const targetProjects = await this.countProjectDocuments(target);
      const sourceFiles = await this.countFiles(previous);
      const targetFiles = await this.countFiles(target);
      if (sourceProjects !== targetProjects) {
        throw new Error(
          `Verification failed: ${sourceProjects} project documents in the source but ${targetProjects} in the destination.`,
        );
      }
      const sourceManifest = await this.readManifest();
      if (sourceManifest) {
        const copiedManifest = await this.backups.verifyDirectory(target);
        if (!copiedManifest.manifest) {
          throw new Error('Verification failed: the copied manifest.json is missing or invalid.');
        }
      }
      if (sourceFiles > 0 && targetFiles < sourceFiles) {
        throw new Error(
          `Verification failed: copied ${targetFiles} of ${sourceFiles} files. The active location was not changed.`,
        );
      }

      await this.writePointer(target, previous);
      this.storage.setRoot(target);
      this.activeDirectory = target;
      this.storage.resumeWrites();
      await this.storage.init();
      await this.writeManifest({
        formatVersion: sourceManifest?.formatVersion ?? 1,
        appVersion: this.appVersion,
        createdAt: sourceManifest?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        generation: (sourceManifest?.generation ?? 0) + 1,
        projects: sourceManifest?.projects ?? [],
      });
      this.logger.info('storage', 'Application data moved', { previous, target, ...copied });
      return {
        previousDirectory: previous,
        newDirectory: target,
        copiedFiles: copied.files,
        copiedBytes: copied.bytes,
        verified: true,
        warnings: [
          `The original data was left intact at ${previous}. Delete it manually once you have verified the new location.`,
          'Project source folders were not moved; they stay wherever the projects point.',
        ],
      };
    } catch (error) {
      this.storage.resumeWrites();
      this.logger.error('storage', 'Data move failed', { target, error: (error as Error).message });
      throw error;
    }
  }

  async freeBytes(): Promise<number | null> {
    return freeBytesFor(this.storage.root);
  }
}
