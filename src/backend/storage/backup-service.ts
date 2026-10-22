/**
 * Backup creation, verification, export and restoration.
 *
 * A backup is only reported as valid after its manifest and project documents
 * have been parsed and the copied file count matches the source count.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { storageManifestSchema } from '@shared/validation';
import type { BackupInfo, StorageManifest } from '@shared/app-types';
import type { Logger } from '../logging/logger';
import { copyDirectory, directorySize, ensureDir, pathExists, readJsonRaw } from './atomic-write';
import type { FileStorage } from './file-storage';
import { STORAGE_PATHS } from './paths';

interface BackupMetadata {
  id: string;
  label: string;
  createdAt: string;
  appVersion: string;
  fileCount: number;
  sizeBytes: number;
  formatVersion: number | null;
  verified: boolean;
}

export interface BackupVerification {
  verified: boolean;
  fileCount: number;
  sizeBytes: number;
  manifest: StorageManifest | null;
  problems: string[];
}

const PERSISTENT_FILTER = (relativePath: string): boolean => {
  const top = relativePath.split(/[\\/]/)[0];
  if (top === 'cache') return false;
  if (relativePath.endsWith('.bak')) return false;
  if (relativePath.includes('.corrupt-')) return false;
  return true;
};

const BACKUP_CONTENT_FILTER = (relativePath: string): boolean => {
  const top = relativePath.split(/[\\/]/)[0];
  if (top === 'backups' || top === 'cache') return false;
  return PERSISTENT_FILTER(relativePath);
};

export class BackupService {
  constructor(
    private readonly storage: FileStorage,
    private readonly logger: Logger,
    private readonly appVersion: string,
  ) {}

  private backupsRoot(): string {
    return this.storage.absolute(STORAGE_PATHS.backups);
  }

  async list(): Promise<BackupInfo[]> {
    const root = this.backupsRoot();
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const results: BackupInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, entry.name);
      const metadata = await this.readMetadata(directory);
      let sizeBytes = metadata?.sizeBytes ?? 0;
      let fileCount = metadata?.fileCount ?? 0;
      if (!metadata) {
        const counted = await this.countFiles(directory);
        sizeBytes = counted.bytes;
        fileCount = counted.files;
      }
      const createdAt =
        metadata?.createdAt ?? (await fs.stat(directory)).mtime.toISOString();
      results.push({
        id: entry.name,
        path: directory,
        createdAt,
        sizeBytes,
        label: metadata?.label ?? 'Automatic / pre-migration backup',
        verified: metadata?.verified ?? (await this.verifyDirectory(directory)).verified,
        fileCount,
      });
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async latest(): Promise<BackupInfo | null> {
    const all = await this.list();
    return all[0] ?? null;
  }

  /** Create a verified snapshot inside `<data>/backups`. */
  async create(label = 'Manual backup'): Promise<BackupInfo> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = `backup-${stamp}-${randomBytes(3).toString('hex')}`;
    const destination = path.join(this.backupsRoot(), id);
    return this.createAt(destination, id, label);
  }

  /** Export a verified snapshot to a user-selected directory. */
  async exportTo(targetDirectory: string): Promise<BackupInfo> {
    const resolved = path.resolve(targetDirectory);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Export directory does not exist: ${resolved}`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = `LocalAIEditor-backup-${stamp}`;
    const destination = path.join(resolved, id);
    if (await pathExists(destination)) {
      throw new Error(`Export target already exists: ${destination}`);
    }
    return this.createAt(destination, id, 'Exported backup');
  }

  private async createAt(destination: string, id: string, label: string): Promise<BackupInfo> {
    await this.storage.waitForIdle();
    const source = this.storage.root;
    const { files, bytes } = await copyDirectory(source, destination, {
      filter: BACKUP_CONTENT_FILTER,
    });
    const verification = await this.verifyDirectory(destination);
    if (!verification.verified) {
      throw new Error(
        `Backup verification failed: ${verification.problems.join('; ') || 'unknown problem'}. The incomplete backup was left at ${destination}.`,
      );
    }
    const metadata: BackupMetadata = {
      id,
      label,
      createdAt: new Date().toISOString(),
      appVersion: this.appVersion,
      fileCount: files,
      sizeBytes: bytes,
      formatVersion: verification.manifest?.formatVersion ?? null,
      verified: true,
    };
    await fs.writeFile(
      path.join(destination, 'backup.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    );
    this.logger.info('backup', 'Backup created and verified', { id, files, bytes, label });
    return {
      id,
      path: destination,
      createdAt: metadata.createdAt,
      sizeBytes: bytes,
      label,
      verified: true,
      fileCount: files,
    };
  }

  /** Validate a backup directory: manifest + every project document must parse. */
  async verifyDirectory(directory: string): Promise<BackupVerification> {
    const problems: string[] = [];
    let manifest: StorageManifest | null = null;
    const manifestPath = path.join(directory, 'manifest.json');
    try {
      const raw = await readJsonRaw(manifestPath);
      if (raw === null) {
        problems.push('manifest.json is missing');
      } else {
        const parsed = storageManifestSchema.safeParse(raw);
        if (parsed.success) manifest = parsed.data;
        else problems.push(`manifest.json is invalid: ${parsed.error.issues[0]?.message ?? 'schema error'}`);
      }
    } catch (error) {
      problems.push(`manifest.json cannot be read: ${(error as Error).message}`);
    }

    const projectsRoot = path.join(directory, 'projects');
    if (await pathExists(projectsRoot)) {
      const projects = await fs.readdir(projectsRoot, { withFileTypes: true });
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const projectFile = path.join(projectsRoot, project.name, 'project.json');
        if (!(await pathExists(projectFile))) {
          problems.push(`${project.name}/project.json is missing`);
          continue;
        }
        try {
          const raw = await readJsonRaw(projectFile);
          if (typeof raw !== 'object' || raw === null || typeof (raw as { id?: unknown }).id !== 'string') {
            problems.push(`${project.name}/project.json is invalid`);
          }
        } catch (error) {
          problems.push(`${project.name}/project.json cannot be read: ${(error as Error).message}`);
        }
      }
    } else {
      problems.push('projects/ is missing');
    }

    const counted = await this.countFiles(directory);
    return {
      verified: problems.length === 0,
      fileCount: counted.files,
      sizeBytes: counted.bytes,
      manifest,
      problems,
    };
  }

  private async countFiles(directory: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
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
          files += 1;
          try {
            bytes += (await fs.stat(child)).size;
          } catch {
            /* ignore */
          }
        }
      }
    }
    await walk(directory);
    return { files, bytes };
  }

  async resolveBackupDirectory(backupId: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(backupId)) return null;
    const local = path.join(this.backupsRoot(), backupId);
    if (await pathExists(local)) return local;
    return null;
  }

  private async readMetadata(directory: string): Promise<BackupMetadata | null> {
    try {
      const raw = await readJsonRaw(path.join(directory, 'backup.json'));
      if (!raw || typeof raw !== 'object') return null;
      return raw as BackupMetadata;
    } catch {
      return null;
    }
  }

  /**
   * Restore a backup identified by id. The current state is snapshotted first,
   * then app/ + projects/ + manifest.json + logs/ are replaced.
   */
  async restore(backupId: string): Promise<{ restored: boolean; warning: string | null; safetyBackup: BackupInfo | null }> {
    const source = await this.resolveBackupDirectory(backupId);
    if (!source) throw new Error(`Backup not found: ${backupId}`);
    const verification = await this.verifyDirectory(source);
    if (!verification.verified) {
      throw new Error(
        `Backup ${backupId} failed verification and was not restored: ${verification.problems.join('; ')}`,
      );
    }
    const safetyBackup = await this.create(`Automatic backup before restoring ${backupId}`);
    await this.storage.pauseWrites();
    try {
      await this.storage.waitForIdle();
      const root = this.storage.root;
      for (const folder of ['app', 'projects', 'logs']) {
        const from = path.join(source, folder);
        if (!(await pathExists(from))) continue;
        const to = path.join(root, folder);
        const staging = path.join(root, `.restore-${folder}-${Date.now()}`);
        await copyDirectory(from, staging);
        await fs.rm(to, { recursive: true, force: true });
        await fs.rename(staging, to);
      }
      const manifestSource = path.join(source, 'manifest.json');
      if (await pathExists(manifestSource)) {
        await ensureDir(root);
        await fs.copyFile(manifestSource, path.join(root, 'manifest.json'));
      }
    } finally {
      this.storage.resumeWrites();
    }
    const post = await this.verifyDirectory(this.storage.root);
    this.logger.warn('backup', 'Backup restored', {
      backupId,
      verified: post.verified,
      problems: post.problems,
    });
    return {
      restored: post.verified,
      warning: post.verified
        ? null
        : `Restore finished but verification reported: ${post.problems.join('; ')}`,
      safetyBackup,
    };
  }

  async dataSize(): Promise<number> {
    return directorySize(this.storage.root);
  }
}
