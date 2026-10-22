import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FileStorage, PathEscapeError, StoragePausedError } from '../../src/backend/storage/file-storage';
import { runStorageMigrations, readStorageVersion } from '../../src/backend/storage/migrations';
import { Logger } from '../../src/backend/logging/logger';
import { STORAGE_PATHS } from '../../src/backend/storage/paths';
import { STORAGE_FORMAT_VERSION } from '@shared/app-types';

const temps: string[] = [];

async function makeStorage(): Promise<{ storage: FileStorage; root: string }> {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp', 'storage-test-'));
  temps.push(root);
  const storage = new FileStorage(root);
  await storage.init();
  return { storage, root };
}

afterEach(async () => {
  for (const directory of temps.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

const documentSchema = z.object({ value: z.number(), name: z.string() });

describe('FileStorage', () => {
  it('writes and reads validated JSON atomically without temp files', async () => {
    const { storage, root } = await makeStorage();
    await storage.writeJson('app/test.json', { value: 1, name: 'one' });
    await expect(storage.readJson('app/test.json', documentSchema, { value: 0, name: 'x' })).resolves.toEqual({
      value: 1,
      name: 'one',
    });
    const files = await fs.readdir(path.join(root, 'app'));
    expect(files.filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    const raw = JSON.parse(await fs.readFile(path.join(root, 'app/test.json'), 'utf8'));
    expect(raw).toEqual({ value: 1, name: 'one' });
  });

  it('recovers a corrupt document from its .bak copy and quarantines the bad file', async () => {
    const { storage, root } = await makeStorage();
    await storage.writeJson('app/test.json', { value: 1, name: 'one' });
    await storage.writeJson('app/test.json', { value: 2, name: 'two' });
    await fs.writeFile(path.join(root, 'app/test.json'), '{ this is not json', 'utf8');

    const warnings: string[] = [];
    storage.onWarning((warning) => warnings.push(warning.message));
    const value = await storage.readJson('app/test.json', documentSchema, { value: 0, name: 'fallback' });

    expect(value).toEqual({ value: 1, name: 'one' });
    const files = await fs.readdir(path.join(root, 'app'));
    expect(files.some((file) => file.includes('.corrupt-'))).toBe(true);
    expect(warnings.some((message) => message.includes('Recovered'))).toBe(true);
  });

  it('keeps the damaged file when no backup is available and uses the fallback', async () => {
    const { storage, root } = await makeStorage();
    await fs.writeFile(path.join(root, 'app/test.json'), '{oops', 'utf8');
    const value = await storage.readJson('app/test.json', documentSchema, { value: 9, name: 'fallback' });
    expect(value).toEqual({ value: 9, name: 'fallback' });
    const files = await fs.readdir(path.join(root, 'app'));
    expect(files.some((file) => file.includes('test.json.corrupt-'))).toBe(true);
  });

  it('skips malformed JSONL lines without discarding valid entries', async () => {
    const { storage, root } = await makeStorage();
    await storage.appendJsonLine('logs/test.jsonl', { value: 1, name: 'one' });
    await storage.appendJsonLine('logs/test.jsonl', { value: 2, name: 'two' });
    await fs.appendFile(path.join(root, 'logs/test.jsonl'), 'not-json\n', 'utf8');
    const warnings: string[] = [];
    storage.onWarning((warning) => warnings.push(warning.message));
    const lines = await storage.readJsonLines('logs/test.jsonl', documentSchema);
    expect(lines).toHaveLength(2);
    expect(warnings[0]).toContain('Skipped 1 unreadable line');
  });

  it('rejects path traversal and absolute paths', async () => {
    const { storage } = await makeStorage();
    expect(() => storage.absolute('../outside.json')).toThrow(PathEscapeError);
    expect(() => storage.absolute('C:\\Windows\\evil.txt')).toThrow(PathEscapeError);
    expect(() => storage.absolute('app/../../escape.json')).toThrow(PathEscapeError);
  });

  it('blocks writes while paused (used during data relocation)', async () => {
    const { storage } = await makeStorage();
    storage.pauseWrites();
    await expect(storage.writeJson('app/x.json', { ok: true })).rejects.toBeInstanceOf(StoragePausedError);
    storage.resumeWrites();
    await expect(storage.writeJson('app/x.json', { ok: true })).resolves.toBeUndefined();
  });
});

describe('storage migrations', () => {
  it('migrates legacy v1 project metadata to the current format with a backup', async () => {
    const { storage, root } = await makeStorage();
    await fs.writeFile(
      path.join(root, 'app', 'storage-version.json'),
      JSON.stringify({ formatVersion: 1, appVersion: '0.0.1', updatedAt: new Date().toISOString(), history: [] }),
      'utf8',
    );
    await fs.mkdir(path.join(root, 'projects', 'project-p_legacy', 'chats', 'chat-c_legacy'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, 'projects', 'project-p_legacy', 'project.json'),
      JSON.stringify({
        id: 'p_legacy',
        name: 'Legacy',
        workspacePath: 'C:\\dev\\legacy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        defaultModel: null,
        chatIds: ['c_legacy'],
        taskIds: [],
        formatVersion: 1,
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'projects', 'project-p_legacy', 'chats', 'chat-c_legacy', 'chat.json'),
      JSON.stringify({
        id: 'c_legacy',
        projectId: 'p_legacy',
        title: 'Old chat',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        mode: 'build',
        messageCount: 0,
        formatVersion: 1,
      }),
      'utf8',
    );

    const logger = new Logger('error', false);
    const result = await runStorageMigrations(storage, '0.1.0', logger);
    expect(result.migrated).toBe(true);
    expect(result.backupPath).toBeTruthy();

    const version = await readStorageVersion(storage);
    expect(version?.formatVersion).toBe(STORAGE_FORMAT_VERSION);
    const project = await storage.readJson<Record<string, unknown>>(
      STORAGE_PATHS.project('p_legacy'),
      z.record(z.string(), z.unknown()),
      {},
    );
    expect(project.planIds).toEqual([]);
    expect(project.workspaceMissing).toBe(false);
    const chat = await storage.readJson<Record<string, unknown>>(
      STORAGE_PATHS.chat('p_legacy', 'c_legacy'),
      z.record(z.string(), z.unknown()),
      {},
    );
    expect(chat.currentPlanId).toBeNull();
    expect(chat.status).toBe('idle');
  });

  it('refuses to open data created by a newer format without modifying it', async () => {
    const { storage, root } = await makeStorage();
    await fs.writeFile(
      path.join(root, 'app', 'storage-version.json'),
      JSON.stringify({
        formatVersion: STORAGE_FORMAT_VERSION + 5,
        appVersion: '9.0.0',
        updatedAt: new Date().toISOString(),
        history: [],
      }),
      'utf8',
    );
    const logger = new Logger('error', false);
    await expect(runStorageMigrations(storage, '0.1.0', logger)).rejects.toThrow(/newer version/);
    const raw = JSON.parse(await fs.readFile(path.join(root, 'app', 'storage-version.json'), 'utf8'));
    expect(raw.formatVersion).toBe(STORAGE_FORMAT_VERSION + 5);
  });
});
