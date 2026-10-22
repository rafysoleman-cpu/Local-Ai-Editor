import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildToolContext,
  createProjectWithWorkspace,
  createTestBackend,
  type TestBackend,
} from '../helpers/backend';
import type { PermissionDecision, PermissionRequest } from '@shared/app-types';

let active: TestBackend | null = null;

afterEach(async () => {
  if (active) await active.cleanup();
  active = null;
});

function permissionRequest(projectId: string, actionKey: string): PermissionRequest {
  return {
    id: `permreq_${Math.random().toString(16).slice(2, 10)}`,
    runId: 'run_test',
    projectId,
    chatId: null,
    toolName: 'run_command',
    category: 'execute',
    actionKey,
    alwaysKey: actionKey,
    title: `Run ${actionKey}`,
    description: 'Test permission',
    risk: 'medium',
    details: {},
    allowAlwaysLabel: 'Always allow this command',
    createdAt: new Date().toISOString(),
  };
}

describe('permission enforcement', () => {
  it('treats Allow Once as a single-use decision', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'permissions-once');
    let prompts = 0;
    backend.permissions.setRequestHandler((request) => {
      prompts += 1;
      setTimeout(() => backend.permissions.respond(request.id, 'allow_once'), 0);
    });
    const request = permissionRequest(project.id, 'run_command:echo once');

    const first = await backend.permissions.authorize({
      request,
      settings: backend.settings.get(),
      risk: 'medium',
    });
    expect(first.allowed).toBe(true);
    expect(first.source).toBe('once');
    expect(await backend.permissions.list(project.id)).toHaveLength(0);

    const second = await backend.permissions.authorize({
      request: { ...request, id: 'permreq_second' },
      settings: backend.settings.get(),
      risk: 'medium',
    });
    expect(second.allowed).toBe(true);
    expect(prompts).toBe(2);
  });

  it('persists Always Allow only for the exact action and project', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const projectA = await createProjectWithWorkspace(backend, root, 'permissions-a');
    const projectB = await createProjectWithWorkspace(backend, root, 'permissions-b');
    let decision: PermissionDecision = 'always_allow';
    let prompts = 0;
    backend.permissions.setRequestHandler((request) => {
      prompts += 1;
      setTimeout(() => backend.permissions.respond(request.id, decision), 0);
    });

    const key = 'run_command:echo scoped';
    const granted = await backend.permissions.authorize({
      request: permissionRequest(projectA.id, key),
      settings: backend.settings.get(),
      risk: 'medium',
    });
    expect(granted.source).toBe('project');
    const records = await backend.permissions.list(projectA.id);
    expect(records).toHaveLength(1);
    expect(records[0].actionKey).toBe(key);

    // Same project + same action: no new prompt.
    const again = await backend.permissions.authorize({
      request: { ...permissionRequest(projectA.id, key), id: 'permreq_again' },
      settings: backend.settings.get(),
      risk: 'medium',
    });
    expect(again.source).toBe('project');
    expect(prompts).toBe(1);

    // Different action: asks again.
    await backend.permissions.authorize({
      request: { ...permissionRequest(projectA.id, 'run_command:echo other'), id: 'permreq_other' },
      settings: backend.settings.get(),
      risk: 'medium',
    });
    expect(prompts).toBe(2);

    // Other project must not inherit the permission.
    decision = 'deny';
    const otherProject = await backend.permissions.authorize({
      request: { ...permissionRequest(projectB.id, key), id: 'permreq_b' },
      settings: backend.settings.get(),
      risk: 'medium',
    });
    expect(otherProject.allowed).toBe(false);
    expect(prompts).toBe(3);
    expect(await backend.permissions.list(projectB.id)).toHaveLength(0);
  });

  it('fails closed when a permission request is not answered', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'permissions-timeout');
    backend.permissions.setRequestHandler(() => undefined);
    const settings = backend.settings.get();
    const outcome = await backend.permissions.authorize({
      request: permissionRequest(project.id, 'run_command:echo timeout'),
      settings: { ...settings, permissions: { ...settings.permissions, permissionTimeoutMs: 30 } },
      risk: 'medium',
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.source).toBe('denied');
  });

  it('revokes stored permissions', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'permissions-revoke');
    backend.permissions.setRequestHandler((request) => {
      setTimeout(() => backend.permissions.respond(request.id, 'always_allow'), 0);
    });
    await backend.permissions.authorize({
      request: permissionRequest(project.id, 'run_command:echo revoke'),
      settings: backend.settings.get(),
      risk: 'medium',
    });
    const [record] = await backend.permissions.list(project.id);
    expect(record).toBeTruthy();
    expect(await backend.permissions.revoke(project.id, record.id)).toBe(true);
    expect(await backend.permissions.list(project.id)).toHaveLength(0);
  });
});

describe('tool executor safety', () => {
  it('rejects cross-workspace reads through traversal', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const projectA = await createProjectWithWorkspace(backend, root, 'tool-a');
    const projectB = await createProjectWithWorkspace(backend, root, 'tool-b');
    const chat = await backend.chats.create(projectA.id, 'build');
    await fs.writeFile(path.join(projectB.workspacePath, 'secret.md'), 'B_SECRET', 'utf8');

    const outcome = await backend.executor.execute({
      call: { id: 'call_1', name: 'read_file', arguments: { relativePath: '../tool-b/secret.md' } },
      ctx: buildToolContext(backend, projectA, chat),
      settings: backend.settings.get(),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.record.status).toBe('error');
    expect(outcome.record.error).toMatch(/escapes the workspace|outside/i);
    expect(outcome.modelContent).not.toContain('B_SECRET');
  });

  it('blocks catastrophic commands without prompting or executing', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'tool-block');
    const chat = await backend.chats.create(project.id, 'build');
    let prompts = 0;
    backend.permissions.setRequestHandler(() => {
      prompts += 1;
    });
    const outcome = await backend.executor.execute({
      call: { id: 'call_2', name: 'run_command', arguments: { command: 'format C: /q' } },
      ctx: buildToolContext(backend, project, chat),
      settings: backend.settings.get(),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.record.status).toBe('denied');
    expect(prompts).toBe(0);
  });

  it('does not execute a denied command and reports the denial to the model', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'tool-deny');
    const chat = await backend.chats.create(project.id, 'build');
    backend.permissions.setRequestHandler((request) => {
      setTimeout(() => backend.permissions.respond(request.id, 'deny'), 0);
    });
    const command = 'node -e "require(\'fs\').writeFileSync(\'denied-marker.txt\', \'x\')"';
    const outcome = await backend.executor.execute({
      call: { id: 'call_3', name: 'run_command', arguments: { command } },
      ctx: buildToolContext(backend, project, chat),
      settings: backend.settings.get(),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.record.status).toBe('denied');
    expect(outcome.modelContent).toContain('PERMISSION DENIED');
    await expect(fs.stat(path.join(project.workspacePath, 'denied-marker.txt'))).rejects.toThrow();
  });

  it('executes commands with quoted arguments correctly on Windows', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'tool-quoting');
    const chat = await backend.chats.create(project.id, 'build');
    backend.permissions.setRequestHandler((request) => {
      setTimeout(() => backend.permissions.respond(request.id, 'allow_once'), 0);
    });
    const outcome = await backend.executor.execute({
      call: {
        id: 'call_quoting',
        name: 'run_command',
        arguments: { command: 'node -e "console.log(41+1)"' },
      },
      ctx: buildToolContext(backend, project, chat),
      settings: backend.settings.get(),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.record.status).toBe('success');
    expect(outcome.record.result).toContain('42');
  });

  it('auto-approves file writes inside the workspace but never deletes', async () => {
    active = await createTestBackend();
    const { backend, root } = active;
    const project = await createProjectWithWorkspace(backend, root, 'tool-write');
    const chat = await backend.chats.create(project.id, 'build');
    backend.permissions.setRequestHandler((request) => {
      setTimeout(() => backend.permissions.respond(request.id, 'deny'), 0);
    });

    const write = await backend.executor.execute({
      call: {
        id: 'call_4',
        name: 'write_file',
        arguments: { relativePath: 'src/generated.ts', content: 'export const ok = true;\n' },
      },
      ctx: buildToolContext(backend, project, chat),
      settings: backend.settings.get(),
    });
    expect(write.ok).toBe(true);
    expect(await fs.readFile(path.join(project.workspacePath, 'src/generated.ts'), 'utf8')).toContain('ok = true');

    const remove = await backend.executor.execute({
      call: { id: 'call_5', name: 'delete_file', arguments: { relativePath: 'src/generated.ts' } },
      ctx: buildToolContext(backend, project, chat),
      settings: backend.settings.get(),
    });
    expect(remove.ok).toBe(false);
    expect(remove.record.status).toBe('denied');
    await expect(fs.stat(path.join(project.workspacePath, 'src/generated.ts'))).resolves.toBeTruthy();
  });
});
