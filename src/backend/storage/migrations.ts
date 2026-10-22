/**
 * Storage schema migrations.
 *
 * The version is stored in `app/storage-version.json`. Before any migration the
 * affected data is copied into `backups/pre-migration-*`, and every changed file
 * keeps a `.bak` sibling. Data from a newer version is never modified: the app
 * refuses to start against it instead of corrupting it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STORAGE_FORMAT_VERSION } from '@shared/app-types';
import { normalizeSettings } from '@shared/validation';
import type { Logger } from '../logging/logger';
import { copyDirectory, pathExists } from './atomic-write';
import type { FileStorage } from './file-storage';
import { STORAGE_PATHS } from './paths';

interface StorageVersionFile {
  formatVersion: number;
  appVersion: string;
  updatedAt: string;
  history: Array<{ from: number; to: number; at: string; appVersion: string }>;
}

export class StorageVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageVersionError';
  }
}

export interface MigrationResult {
  from: number;
  to: number;
  migrated: boolean;
  backupPath: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function readStorageVersion(storage: FileStorage): Promise<StorageVersionFile | null> {
  const raw = await storage.readJsonUnknown(STORAGE_PATHS.storageVersion);
  if (!isRecord(raw)) return null;
  const version = typeof raw.formatVersion === 'number' ? raw.formatVersion : Number.NaN;
  if (!Number.isFinite(version)) return null;
  return {
    formatVersion: version,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : 'unknown',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    history: Array.isArray(raw.history)
      ? (raw.history as StorageVersionFile['history']).filter(
          (entry) => isRecord(entry) && typeof entry.from === 'number' && typeof entry.to === 'number',
        )
      : [],
  };
}

export async function writeStorageVersion(
  storage: FileStorage,
  version: StorageVersionFile,
): Promise<void> {
  await storage.writeJson(STORAGE_PATHS.storageVersion, version);
}

export async function runStorageMigrations(
  storage: FileStorage,
  appVersion: string,
  logger: Logger,
): Promise<MigrationResult> {
  const existing = await readStorageVersion(storage);
  const projectDirs = await storage.listDir(STORAGE_PATHS.projects);
  const from = existing?.formatVersion ?? (projectDirs.length > 0 ? 1 : STORAGE_FORMAT_VERSION);
  const to = STORAGE_FORMAT_VERSION;

  if (from > to) {
    throw new StorageVersionError(
      `This data directory was created by a newer version of ${'Local AI Editor'} (storage format ${from}, this app supports ${to}). ` +
        'Open it with the newer version or choose a different data directory. No data was changed.',
    );
  }

  if (from === to) {
    if (!existing) {
      await writeStorageVersion(storage, {
        formatVersion: to,
        appVersion,
        updatedAt: new Date().toISOString(),
        history: [],
      });
    }
    return { from, to, migrated: false, backupPath: null };
  }

  const backupPath = await createPreMigrationBackup(storage, from);
  logger.info('storage', `Migrating storage format v${from} -> v${to}`, { backupPath });

  for (let version = from; version < to; version += 1) {
    if (version === 1) await migrateV1toV2(storage, logger);
    if (version === 2) await migrateV2toV3(storage, logger);
  }

  const history = existing?.history ?? [];
  history.push({ from, to, at: new Date().toISOString(), appVersion });
  await writeStorageVersion(storage, {
    formatVersion: to,
    appVersion,
    updatedAt: new Date().toISOString(),
    history,
  });
  logger.info('storage', 'Storage migration completed', { from, to });
  return { from, to, migrated: true, backupPath };
}

async function createPreMigrationBackup(storage: FileStorage, fromVersion: number): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const relative = `${STORAGE_PATHS.backups}/pre-migration-v${fromVersion}-${stamp}`;
  const target = storage.absolute(relative);
  await copyDirectory(storage.root, target, {
    filter: (relativePath) => {
      const top = relativePath.split(path.sep)[0];
      return top !== 'backups' && top !== 'cache';
    },
  });
  return target;
}

async function forEachProjectFile(
  storage: FileStorage,
  relativeDir: string,
  handler: (relativePath: string, raw: Record<string, unknown>) => Promise<Record<string, unknown> | null>,
  logger: Logger,
): Promise<void> {
  const entries = await storage.listDir(relativeDir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const relativePath = `${relativeDir}/${entry}`;
    const absolute = storage.absolute(relativePath);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(absolute, 'utf8')) as unknown;
    } catch {
      logger.warn('storage', `Skipping unreadable file during migration: ${relativePath}`);
      continue;
    }
    if (!isRecord(raw)) continue;
    const updated = await handler(relativePath, raw);
    if (updated) await storage.writeJson(relativePath, updated);
  }
}

async function migrateV1toV2(storage: FileStorage, logger: Logger): Promise<void> {
  const projectIds = (await storage.listDir(STORAGE_PATHS.projects))
    .filter((name) => name.startsWith('project-'))
    .map((name) => name.replace(/^project-/, ''));

  for (const projectId of projectIds) {
    const projectPath = STORAGE_PATHS.project(projectId);
    const absolute = storage.absolute(projectPath);
    if (!(await pathExists(absolute))) continue;
    try {
      const raw = JSON.parse(await fs.readFile(absolute, 'utf8')) as Record<string, unknown>;
      const planIds = Array.isArray(raw.planIds) ? raw.planIds : [];
      await storage.writeJson(projectPath, {
        ...raw,
        planIds,
        workspaceMissing: raw.workspaceMissing === true,
      });

      const chatsDir = STORAGE_PATHS.chatsDir(projectId);
      for (const chatFolder of await storage.listDir(chatsDir)) {
        const chatPath = `${chatsDir}/${chatFolder}/chat.json`;
        try {
          const chatRaw = JSON.parse(await fs.readFile(storage.absolute(chatPath), 'utf8')) as Record<
            string,
            unknown
          >;
          await storage.writeJson(chatPath, {
            ...chatRaw,
            currentPlanId: chatRaw.currentPlanId ?? null,
            model: chatRaw.model ?? null,
            status: chatRaw.status ?? 'idle',
          });
        } catch {
          logger.warn('storage', `Could not migrate chat metadata: ${chatPath}`);
        }
      }
    } catch {
      logger.warn('storage', `Could not migrate project metadata: ${projectPath}`);
    }
  }
}

async function migrateV2toV3(storage: FileStorage, logger: Logger): Promise<void> {
  const raw = await storage.readJsonUnknown(STORAGE_PATHS.settings);
  if (raw !== null) {
    const normalized = normalizeSettings(raw);
    await storage.writeJson(STORAGE_PATHS.settings, normalized);
  }

  const projectIds = (await storage.listDir(STORAGE_PATHS.projects))
    .filter((name) => name.startsWith('project-'))
    .map((name) => name.replace(/^project-/, ''));

  for (const projectId of projectIds) {
    await forEachProjectFile(
      storage,
      STORAGE_PATHS.tasksDir(projectId),
      async (_relativePath, taskRaw) => ({
        ...taskRaw,
        evidence: Array.isArray(taskRaw.evidence) ? taskRaw.evidence : [],
        acceptanceCriteria: Array.isArray(taskRaw.acceptanceCriteria) ? taskRaw.acceptanceCriteria : [],
        tests: Array.isArray(taskRaw.tests) ? taskRaw.tests : [],
        files: Array.isArray(taskRaw.files) ? taskRaw.files : [],
        risk: typeof taskRaw.risk === 'string' ? taskRaw.risk : '',
        notes: typeof taskRaw.notes === 'string' ? taskRaw.notes : '',
      }),
      logger,
    );
  }
}
