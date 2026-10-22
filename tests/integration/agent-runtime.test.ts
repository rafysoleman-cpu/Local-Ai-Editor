import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAgentRuntime,
  createEventCollector,
  createProjectWithWorkspace,
  createTestBackend,
  MockProvider,
  type EventCollector,
  type TestBackend,
} from '../helpers/backend';
import type { Backend } from '../../src/backend/application/backend';
import type { AgentRuntime } from '../../src/backend/agent/agent-runtime';
import type { Chat, Project } from '@shared/app-types';

let active: TestBackend | null = null;

afterEach(async () => {
  if (active) await active.cleanup();
  active = null;
});

interface Setup {
  backend: Backend;
  project: Project;
  chat: Chat;
  provider: MockProvider;
  collector: EventCollector;
  runtime: AgentRuntime;
}

async function setup(options: { mode?: 'plan' | 'build'; workspace?: string } = {}): Promise<Setup> {
  active = await createTestBackend();
  const backend = active.backend;
  const project = await createProjectWithWorkspace(backend, active.root, options.workspace ?? 'agent');
  await backend.settings.update({ defaultModel: 'mock-model' });
  const chat = await backend.chats.create(project.id, options.mode ?? 'build');
  const provider = new MockProvider();
  const collector = createEventCollector();
  const runtime = buildAgentRuntime(backend, provider, collector);
  return { backend, project, chat, provider, collector, runtime };
}

async function run(
  setupData: Setup,
  prompt: string,
  mode: 'plan' | 'build',
): Promise<Awaited<ReturnType<EventCollector['waitForRun']>>> {
  const { runId } = await setupData.runtime.start({
    projectId: setupData.project.id,
    chatId: setupData.chat.id,
    prompt,
    mode,
  });
  return setupData.collector.waitForRun(runId, 20000);
}

describe('agent runtime', () => {
  it('runs Plan Mode with read-only tools and persists a structured plan', async () => {
    const data = await setup({ mode: 'plan' });
    data.provider.queueToolCalls(
      [
        {
          name: 'save_plan',
          arguments: {
            title: 'Add greeting endpoint',
            summary: 'Expose a greeting through a small module.',
            tasks: [
              {
                title: 'Create greeting module',
                files: ['src/greeting.ts'],
                acceptanceCriteria: ['exports greet()'],
                tests: ['unit test for greet'],
              },
              { title: 'Wire it into the app', files: ['src/index.ts'] },
            ],
          },
        },
      ],
      'I inspected the workspace.',
    );
    data.provider.queueText('Plan ready for approval.');

    const finished = await run(data, 'Plan the greeting feature', 'plan');
    expect(finished.type).toBe('run_finished');
    if (finished.type === 'run_finished') expect(finished.status).toBe('completed');

    const planData = await data.backend.tasks.listForChat(data.project.id, data.chat.id);
    expect(planData?.plan.status).toBe('draft');
    expect(planData?.tasks).toHaveLength(2);
    expect(data.provider.requests[0].tools.map((tool) => tool.function.name)).not.toContain('write_file');
    expect(data.provider.requests[0].tools.map((tool) => tool.function.name)).not.toContain('run_command');
    expect(data.provider.requests[0].tools.map((tool) => tool.function.name)).toContain('save_plan');

    await expect(fs.stat(path.join(data.project.workspacePath, 'src/greeting.ts'))).rejects.toThrow();
  });

  it('refuses Build Mode while a draft plan awaits approval', async () => {
    const data = await setup();
    await data.backend.tasks.createPlan({
      projectId: data.project.id,
      chatId: data.chat.id,
      title: 'Draft plan',
      tasks: [{ title: 'Do a thing' }],
    });
    await expect(
      data.runtime.start({
        projectId: data.project.id,
        chatId: data.chat.id,
        prompt: 'Implement it',
        mode: 'build',
      }),
    ).rejects.toThrow(/draft plan awaiting approval/i);
  });

  it('gates Build Mode mutations until a plan exists, then implements and records evidence', async () => {
    const data = await setup();
    data.provider.queueToolCalls([
      {
        name: 'write_file',
        arguments: { relativePath: 'src/ungated.ts', content: 'export const nope = 1;\n' },
      },
    ]);
    data.provider.queueText('I need a plan first.');

    const firstRun = await run(data, 'Write a file without a plan', 'build');
    expect(firstRun.type).toBe('run_finished');
    await expect(fs.stat(path.join(data.project.workspacePath, 'src/ungated.ts'))).rejects.toThrow();
    const messages = await data.backend.chats.messages(data.project.id, data.chat.id);
    const assistant = messages.find((message) => message.role === 'assistant');
    expect(assistant?.toolCalls[0]?.status).toBe('denied');

    const created = await data.backend.tasks.createPlan({
      projectId: data.project.id,
      chatId: data.chat.id,
      title: 'Internal plan',
      tasks: [{ title: 'Create the gated file' }],
      approve: true,
    });
    const task = created.tasks[0];
    data.provider.queueToolCalls([
      {
        name: 'update_task_status',
        arguments: { taskId: task.id, status: 'in_progress' },
      },
      {
        name: 'write_file',
        arguments: { relativePath: 'src/gated.ts', content: 'export const yes = 1;\n' },
      },
      {
        name: 'update_task_status',
        arguments: {
          taskId: task.id,
          status: 'completed',
          evidence: ['write_file created src/gated.ts (read back successfully)'],
        },
      },
    ]);
    data.provider.queueText('Implemented and verified.');

    const secondRun = await run(data, 'Implement the approved plan', 'build');
    expect(secondRun.type).toBe('run_finished');
    expect(await fs.readFile(path.join(data.project.workspacePath, 'src/gated.ts'), 'utf8')).toContain('yes = 1');
    const updated = await data.backend.tasks.getPlan(data.project.id, created.plan.id);
    expect(updated.tasks[0].status).toBe('completed');
    expect(updated.tasks[0].evidence.length).toBeGreaterThan(0);
  });

  it('cancels a running request and preserves an interrupted message', async () => {
    const data = await setup();
    data.provider.hang = true;
    const { runId } = await data.runtime.start({
      projectId: data.project.id,
      chatId: data.chat.id,
      prompt: 'This will hang',
      mode: 'build',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await data.runtime.cancel(runId);
    const finished = await data.collector.waitForRun(runId, 15000);
    expect(finished.type).toBe('run_finished');
    if (finished.type === 'run_finished') expect(finished.status).toBe('cancelled');

    const chat = await data.backend.chats.get(data.project.id, data.chat.id);
    expect(chat?.status).toBe('cancelled');
    const messages = await data.backend.chats.messages(data.project.id, data.chat.id);
    const assistant = messages.find((message) => message.role === 'assistant');
    expect(assistant?.interrupted).toBe(true);
  });

  it('enforces the tool-call limit and stops before the extra call', async () => {
    const data = await setup();
    await data.backend.tasks.createPlan({
      projectId: data.project.id,
      chatId: data.chat.id,
      title: 'Limit plan',
      tasks: [{ title: 'Write files' }],
      approve: true,
    });
    await data.backend.settings.update({
      limits: { ...data.backend.settings.get().limits, maxToolCallsPerTurn: 1 },
    });
    data.provider.queueToolCalls([
      { name: 'write_file', arguments: { relativePath: 'src/one.ts', content: 'export const one = 1;\n' } },
      { name: 'write_file', arguments: { relativePath: 'src/two.ts', content: 'export const two = 2;\n' } },
    ]);
    const finished = await run(data, 'Write two files', 'build');
    expect(finished.type).toBe('run_finished');
    if (finished.type === 'run_finished') expect(finished.status).toBe('limit');
    await expect(fs.stat(path.join(data.project.workspacePath, 'src/one.ts'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(data.project.workspacePath, 'src/two.ts'))).rejects.toThrow();
  });

  it('stops after repeated identical tool failures', async () => {
    const data = await setup();
    await data.backend.settings.update({
      limits: { ...data.backend.settings.get().limits, maxRepeatedFailures: 2 },
    });
    data.provider.queueToolCalls([{ name: 'missing_tool', arguments: {} }]);
    data.provider.queueToolCalls([{ name: 'missing_tool', arguments: {} }]);
    data.provider.queueText('unreachable');
    const finished = await run(data, 'Use a missing tool twice', 'build');
    expect(finished.type).toBe('run_finished');
    if (finished.type === 'run_finished') {
      expect(finished.status).toBe('limit');
      expect(finished.error).toMatch(/missing_tool/);
    }
  });

  it('runs a real safe command automatically and reports its output', async () => {
    const data = await setup();
    await data.backend.tasks.createPlan({
      projectId: data.project.id,
      chatId: data.chat.id,
      title: 'Command plan',
      tasks: [{ title: 'Run the command' }],
      approve: true,
    });
    data.provider.queueToolCalls([{ name: 'run_command', arguments: { command: 'echo agent_runtime_ok' } }]);
    data.provider.queueText('Command finished.');
    const finished = await run(data, 'Check the shell', 'build');
    expect(finished.type).toBe('run_finished');
    const messages = await data.backend.chats.messages(data.project.id, data.chat.id);
    const assistant = messages.find((message) => message.role === 'assistant' && message.toolCalls.length > 0);
    expect(assistant?.toolCalls[0].status).toBe('success');
    expect(assistant?.toolCalls[0].result).toContain('agent_runtime_ok');
  });

  it('reads a real file through a tool and returns its content to the model', async () => {
    const data = await setup();
    await data.backend.tasks.createPlan({
      projectId: data.project.id,
      chatId: data.chat.id,
      title: 'Read plan',
      tasks: [{ title: 'Read the readme' }],
      approve: true,
    });
    await fs.writeFile(path.join(data.project.workspacePath, 'notes.txt'), 'REAL_FILE_CONTENT_7d2', 'utf8');
    data.provider.queueToolCalls([{ name: 'read_file', arguments: { relativePath: 'notes.txt' } }]);
    data.provider.queueText('I read the file.');
    const finished = await run(data, 'Read notes.txt', 'build');
    expect(finished.type).toBe('run_finished');

    const messages = await data.backend.chats.messages(data.project.id, data.chat.id);
    const toolCall = messages.flatMap((message) => message.toolCalls).find((call) => call.name === 'read_file');
    expect(toolCall?.status).toBe('success');
    expect(toolCall?.result).toContain('REAL_FILE_CONTENT_7d2');

    const secondRequest = data.provider.requests[1];
    const toolMessage = secondRequest?.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('REAL_FILE_CONTENT_7d2');
  });

  it('rejects invalid tool arguments before execution', async () => {
    const data = await setup();
    const outcome = await data.backend.executor.execute({
      call: { id: 'call_invalid', name: 'write_file', arguments: { relativePath: 'x.ts' } },
      ctx: {
        project: data.project,
        chat: data.chat,
        mode: 'build',
        runId: 'run_test',
        settings: data.backend.settings.get(),
        signal: new AbortController().signal,
        services: {
          workspace: data.backend.workspace,
          projects: data.backend.projects,
          chats: data.backend.chats,
          tasks: data.backend.tasks,
          memory: data.backend.memory,
          commands: data.backend.commands,
          git: data.backend.git,
        },
        invalidateContext: () => undefined,
      },
      settings: data.backend.settings.get(),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.record.status).toBe('error');
    expect(outcome.modelContent).toMatch(/invalid/i);
    await expect(fs.stat(path.join(data.project.workspacePath, 'x.ts'))).rejects.toThrow();
  });

  it('rejects invalid task transitions and completion without evidence', async () => {
    const data = await setup();
    const created = await data.backend.tasks.createPlan({
      projectId: data.project.id,
      chatId: data.chat.id,
      title: 'Task validation',
      tasks: [{ title: 'First' }, { title: 'Second' }],
      approve: true,
    });
    await data.backend.tasks.updateTask({
      projectId: data.project.id,
      taskId: created.tasks[1].id,
      status: 'in_progress',
    });
    await expect(
      data.backend.tasks.updateTask({
        projectId: data.project.id,
        taskId: created.tasks[1].id,
        status: 'completed',
        evidence: ['x'],
      }),
    ).rejects.toThrow(/earlier task/i);

    await data.backend.tasks.updateTask({
      projectId: data.project.id,
      taskId: created.tasks[0].id,
      status: 'in_progress',
    });
    await expect(
      data.backend.tasks.updateTask({
        projectId: data.project.id,
        taskId: created.tasks[0].id,
        status: 'completed',
      }),
    ).rejects.toThrow(/evidence/i);

    await data.backend.tasks.updateTask({
      projectId: data.project.id,
      taskId: created.tasks[0].id,
      status: 'completed',
      evidence: ['real verification output'],
    });
    await expect(
      data.backend.tasks.updateTask({
        projectId: data.project.id,
        taskId: created.tasks[0].id,
        status: 'in_progress',
      }),
    ).rejects.toThrow(/Invalid task transition/i);
  });
});
