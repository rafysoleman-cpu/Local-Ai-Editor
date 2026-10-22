import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectWithWorkspace, createTestBackend, type TestBackend } from '../helpers/backend';

let active: TestBackend | null = null;

afterEach(async () => {
  if (active) await active.cleanup();
  active = null;
});

describe('backups and data relocation', () => {
  it('creates a verified backup, exports it and restores it', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'backup-project');
    const chat = await backend.chats.create(project.id, 'build', 'Backup chat');
    await backend.memory.save(project.id, '# Memory\n\nVersion one.');
    await backend.projects.saveInstructions(project.id, '# Instructions\n\nOriginal instructions.');

    const backup = await backend.createBackup('Test snapshot');
    expect(backup.verified).toBe(true);
    expect(backup.fileCount).toBeGreaterThan(0);
    const list = await backend.backups.list();
    expect(list.some((entry) => entry.id === backup.id)).toBe(true);
    expect(list[0].verified).toBe(true);

    const exportDir = path.join(root, 'exported');
    await fs.mkdir(exportDir, { recursive: true });
    const exported = await backend.exportBackup(exportDir);
    await expect(fs.stat(path.join(exported.path, 'manifest.json'))).resolves.toBeTruthy();
    expect(exported.verified).toBe(true);

    await backend.memory.save(project.id, '# Memory\n\nVersion two (should be replaced).');
    await backend.projects.saveInstructions(project.id, '# Instructions\n\nChanged instructions.');

    const restored = await backend.restoreBackup(backup.id);
    expect(restored.restored).toBe(true);
    expect(restored.warning).toBeNull();
    expect((await backend.memory.get(project.id)).content).toContain('Version one.');
    expect((await backend.projects.getInstructions(project.id)).content).toContain('Original instructions.');
    expect((await backend.chats.messages(project.id, chat.id)).length).toBe(0);
  });

  it('refuses to restore a backup that fails verification', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'bad-backup');
    await backend.memory.save(project.id, '# Memory\n\nKeep me.');
    const backup = await backend.createBackup('Corrupt me');
    await fs.writeFile(path.join(backup.path, 'manifest.json'), '{broken', 'utf8');
    await expect(backend.restoreBackup(backup.id)).rejects.toThrow(/failed verification/i);
    expect((await backend.memory.get(project.id)).content).toContain('Keep me.');
  });

  it('moves application data, verifies it, switches the active root and keeps the original', async () => {
    active = await createTestBackend();
    const { backend, root, dataDirectory } = active;
    const project = await createProjectWithWorkspace(backend, root, 'moved-project');
    const chat = await backend.chats.create(project.id, 'build', 'Moved chat');
    await backend.memory.save(project.id, '# Memory\n\nStill here after the move.');

    const target = path.join(root, 'moved-data');
    const validation = await backend.validateDataTarget(target);
    expect(validation.ok).toBe(true);

    const result = await backend.moveData(target);
    expect(result.verified).toBe(true);
    expect(result.newDirectory).toBe(path.resolve(target));
    expect(result.previousDirectory).toBe(path.resolve(dataDirectory));
    expect(backend.storage.root).toBe(path.resolve(target));

    expect(await backend.projects.list()).toHaveLength(1);
    expect(await backend.chats.messages(project.id, chat.id)).toHaveLength(0);
    expect((await backend.memory.get(project.id)).content).toContain('Still here');

    // The original directory and its manifest remain untouched.
    const originalManifest = path.join(dataDirectory, 'manifest.json');
    await expect(fs.stat(originalManifest)).resolves.toBeTruthy();
    const movedManifest = path.join(target, 'manifest.json');
    await expect(fs.stat(movedManifest)).resolves.toBeTruthy();
  });

  it('rejects unsafe relocation destinations', async () => {
    active = await createTestBackend();
    const { backend, root, dataDirectory } = active;
    await createProjectWithWorkspace(backend, root, 'target-validation');

    const inside = await backend.validateDataTarget(path.join(dataDirectory, 'nested'));
    expect(inside.ok).toBe(false);
    expect(inside.reason).toMatch(/inside the current data directory/i);

    const nonEmpty = path.join(root, 'non-empty');
    await fs.mkdir(nonEmpty, { recursive: true });
    await fs.writeFile(path.join(nonEmpty, 'file.txt'), 'x', 'utf8');
    const nonEmptyResult = await backend.validateDataTarget(nonEmpty);
    expect(nonEmptyResult.ok).toBe(false);
    expect(nonEmptyResult.reason).toMatch(/not empty/i);

    await expect(backend.moveData(nonEmpty)).rejects.toThrow(/not empty/i);
    expect(backend.storage.root).toBe(path.resolve(dataDirectory));
  });

  it('records the storage format and manifest for backups', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    await createProjectWithWorkspace(backend, root, 'manifest-project');
    const backup = await backend.createBackup('Manifest check');
    const manifest = JSON.parse(await fs.readFile(path.join(backup.path, 'manifest.json'), 'utf8')) as {
      projects: Array<{ name: string }>;
      formatVersion: number;
    };
    expect(manifest.formatVersion).toBeGreaterThan(0);
    expect(manifest.projects.some((project) => project.name === 'manifest-project')).toBe(true);
  });
});
