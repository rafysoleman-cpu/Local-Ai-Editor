import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectWithWorkspace,
  createTestBackend,
  type TestBackend,
} from '../helpers/backend';
import { Backend } from '../../src/backend/application/backend';
import { noopEmitters } from '../helpers/backend';
import type { ChatMessage } from '@shared/app-types';
import { resolveWorkspacePath } from '../../src/backend/projects/path-safety';

let active: TestBackend | null = null;

afterEach(async () => {
  if (active) await active.cleanup();
  active = null;
});

function message(projectId: string, chatId: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return {
    id: `m_${role}_${Math.random().toString(16).slice(2, 10)}`,
    chatId,
    projectId,
    role,
    content,
    createdAt: new Date().toISOString(),
    mode: 'build',
    model: 'mock',
    toolCalls: [],
    contextReport: null,
    error: null,
    interrupted: false,
  };
}

describe('projects, chats and memory', () => {
  it('persists projects, chats, messages and memory across a backend restart', async () => {
    active = await createTestBackend();
    const { backend, root, dataDirectory } = active;
    const project = await createProjectWithWorkspace(backend, root, 'persisted');
    const chat = await backend.chats.create(project.id, 'plan', 'Planning chat');
    await backend.chats.appendMessage(project.id, chat.id, message(project.id, chat.id, 'user', 'hello'));
    await backend.chats.appendMessage(
      project.id,
      chat.id,
      message(project.id, chat.id, 'assistant', 'world'),
    );
    await backend.projects.saveInstructions(project.id, '# Rules\n\nBe careful.');
    await backend.memory.save(project.id, '# Memory\n\nStack: TypeScript.');

    await backend.shutdown();
    const reopened = await Backend.create({
      userDataDirectory: path.join(root, 'user-data'),
      documentsDirectory: path.join(root, 'documents'),
      dataDirectoryOverride: dataDirectory,
      appVersion: 'test',
      electronVersion: 'test',
      nodeVersion: process.version,
      chromeVersion: 'test',
      isDev: false,
      emitters: noopEmitters,
    });

    try {
      const projects = await reopened.projects.list();
      expect(projects.map((entry) => entry.id)).toContain(project.id);
      const chats = await reopened.chats.list(project.id);
      expect(chats).toHaveLength(1);
      expect(chats[0].title).toBe('Planning chat');
      expect(chats[0].mode).toBe('plan');
      const messages = await reopened.chats.messages(project.id, chat.id);
      expect(messages.map((entry) => entry.content)).toEqual(['hello', 'world']);
      const instructions = await reopened.projects.getInstructions(project.id);
      expect(instructions.content).toContain('Be careful.');
      const memory = await reopened.memory.get(project.id);
      expect(memory.content).toContain('Stack: TypeScript.');
    } finally {
      await reopened.shutdown();
    }
  });

  it('archives the previous memory version on change', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'memory');
    await backend.memory.save(project.id, '# Memory\n\nFirst version.');
    await backend.memory.save(project.id, '# Memory\n\nSecond version.');
    const history = await backend.memory.listHistory(project.id);
    expect(history.length).toBeGreaterThanOrEqual(1);
    const version = await backend.memory.readHistoryVersion(project.id, history[0].name);
    expect(version).toContain('First version.');
  });

  it('rejects chat transcripts masquerading as project memory', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'transcript');
    const transcript = Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0 ? `User: message ${index}` : `Assistant: reply ${index}`,
    ).join('\n');
    await expect(backend.memory.save(project.id, transcript)).rejects.toThrow(/chat transcript/i);
  });

  it('isolates chats, memory and messages between projects', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const projectA = await createProjectWithWorkspace(backend, root, 'project-a');
    const projectB = await createProjectWithWorkspace(backend, root, 'project-b');
    const chatA = await backend.chats.create(projectA.id, 'build', 'Chat A');
    const chatB = await backend.chats.create(projectB.id, 'build', 'Chat B');
    await backend.chats.appendMessage(projectA.id, chatA.id, message(projectA.id, chatA.id, 'user', 'secret A'));
    await backend.chats.appendMessage(projectB.id, chatB.id, message(projectB.id, chatB.id, 'user', 'secret B'));
    await backend.memory.save(projectA.id, '# A\n\nmemory A');
    await backend.memory.save(projectB.id, '# B\n\nmemory B');

    await expect(backend.chats.get(projectA.id, chatB.id)).resolves.toBeNull();
    await expect(backend.chats.messages(projectA.id, chatB.id)).rejects.toThrow(/not found/i);
    await expect(backend.chats.messages(projectB.id, chatA.id)).rejects.toThrow(/not found/i);

    const messagesA = await backend.chats.messages(projectA.id, chatA.id);
    const messagesB = await backend.chats.messages(projectB.id, chatB.id);
    expect(messagesA.map((entry) => entry.content)).toEqual(['secret A']);
    expect(messagesB.map((entry) => entry.content)).toEqual(['secret B']);
    expect((await backend.memory.get(projectA.id)).content).toContain('memory A');
    expect((await backend.memory.get(projectB.id)).content).toContain('memory B');

    await expect(
      backend.chats.appendMessage(projectA.id, chatA.id, message(projectB.id, chatA.id, 'user', 'spoof')),
    ).rejects.toThrow(/belong/i);
  });

  it('prevents path traversal and workspace/data overlap', async () => {
    active = await createTestBackend();
    const { backend, root, dataDirectory } = active;
    const projectA = await createProjectWithWorkspace(backend, root, 'paths-a');
    await createProjectWithWorkspace(backend, root, 'paths-b');
    await fs.writeFile(
      path.join(root, 'workspaces', 'paths-b', 'notes.md'),
      'PROJECT_B_SECRET',
      'utf8',
    );

    await expect(
      resolveWorkspacePath(projectA.workspacePath, '../paths-b/notes.md'),
    ).rejects.toThrow(/escapes the workspace/i);
    await expect(
      backend.workspace.readFile(projectA.workspacePath, '../paths-b/notes.md'),
    ).rejects.toThrow(/escapes the workspace/i);
    await expect(
      resolveWorkspacePath(projectA.workspacePath, path.join(root, 'workspaces', 'paths-b', 'notes.md')),
    ).rejects.toThrow(/absolute paths/i);

    await expect(
      backend.projects.create({
        name: 'Inside data',
        workspacePath: path.join(dataDirectory, 'sneaky'),
        createWorkspace: true,
        initializeGit: false,
      }),
    ).rejects.toThrow(/cannot overlap the application data directory/i);
  });

  it('removes a project from the dashboard without deleting source files or chat history', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'removable');
    const chat = await backend.chats.create(project.id, 'build', 'Keep me');
    await backend.chats.appendMessage(project.id, chat.id, message(project.id, chat.id, 'user', 'keep'));
    const sourceFile = path.join(project.workspacePath, 'source.txt');
    await fs.writeFile(sourceFile, 'source stays', 'utf8');

    await backend.projects.remove(project.id);

    expect(await backend.projects.get(project.id)).toBeNull();
    await expect(fs.stat(sourceFile)).resolves.toBeTruthy();
    const backups = await backend.backups.list();
    expect(backups.some((backup) => backup.label.includes('removed'))).toBe(false);
    const archived = await fs.readdir(path.join(active.dataDirectory, 'backups'));
    expect(archived.some((name) => name.startsWith(`removed-project-${project.id}`))).toBe(true);
  });
});
