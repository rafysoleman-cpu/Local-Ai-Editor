/**
 * Project, memory, plan and task tools.
 *
 * These tools are how the agent reads project instructions/memory and how Plan
 * and Build Mode persist structured plans and task evidence.
 */
import { z } from 'zod';
import {
  type AnyToolDefinition,
  arrayParam,
  booleanParam,
  defineTool,
  memoryPermission,
  objectSchema,
  readOnlyPermission,
  stringParam,
  type ToolRegistry,
} from '../../agent/tool-registry';

export function registerProjectTools(registry: ToolRegistry): void {
  const getProjectInfo = defineTool({
    name: 'get_project_info',
    description:
      'Get project metadata: name, workspace path, package manager, scripts, detected languages, chat/task counts and workspace availability.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 20000,
    inputSummary: 'none',
    parameters: objectSchema({}, []),
    inputSchema: z.object({}),
    summarize: () => ({ summary: 'Project info', details: {} }),
    permission: () => readOnlyPermission('project:info'),
    async execute(_input, ctx) {
      const info = await ctx.services.workspace.workspaceInfo(ctx.project.workspacePath);
      const chats = await ctx.services.chats.list(ctx.project.id);
      const project = await ctx.services.projects.get(ctx.project.id);
      const lines = [
        `project: ${ctx.project.name} (${ctx.project.id})`,
        `workspace: ${ctx.project.workspacePath}`,
        `workspace available: ${!info.missing}`,
        `git: ${info.isGitRepository ? `yes, branch ${info.gitBranch ?? 'detached'}` : 'no'}`,
        `package manager: ${info.packageManager ?? 'none'}`,
        `scripts: ${Object.entries(info.scripts).map(([name, command]) => `${name}="${command}"`).join(', ') || 'none'}`,
        `languages: ${info.languages.join(', ') || 'none detected'}`,
        `chats: ${chats.length}`,
        `tasks: ${project?.taskIds.length ?? 0}`,
        `plans: ${project?.planIds.length ?? 0}`,
        `default model: ${ctx.project.defaultModel ?? '(application default)'}`,
      ];
      return {
        content: lines.join('\n'),
        summary: `${ctx.project.name}: ${info.packageManager ?? 'no package manager'}`,
      };
    },
  });

  const readInstructions = defineTool({
    name: 'read_project_instructions',
    description: 'Read the project-specific instructions file that the user wrote for this project.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 10000,
    inputSummary: 'none',
    parameters: objectSchema({}, []),
    inputSchema: z.object({}),
    summarize: () => ({ summary: 'Read project instructions', details: {} }),
    permission: () => readOnlyPermission('project:instructions'),
    async execute(_input, ctx) {
      const instructions = await ctx.services.projects.getInstructions(ctx.project.id);
      return {
        content: instructions.content.trim()
          ? `Project instructions (${instructions.content.length} chars):\n\n${instructions.content}`
          : 'No project instructions have been written yet.',
        summary: 'Read project instructions',
      };
    },
  });

  const readMemory = defineTool({
    name: 'read_project_memory',
    description: 'Read the concise project memory maintained by the agent and the user.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 10000,
    inputSummary: 'none',
    parameters: objectSchema({}, []),
    inputSchema: z.object({}),
    summarize: () => ({ summary: 'Read project memory', details: {} }),
    permission: () => readOnlyPermission('project:memory:read'),
    async execute(_input, ctx) {
      const memory = await ctx.services.memory.get(ctx.project.id);
      return {
        content: memory.content.trim()
          ? `Project memory (${memory.content.length} chars):\n\n${memory.content}`
          : 'Project memory is empty.',
        summary: 'Read project memory',
      };
    },
  });

  const updateMemory = defineTool({
    name: 'update_project_memory',
    description:
      'Replace the project memory file with an updated, concise Markdown summary. Merge with the existing content, remove duplicates and keep only stable facts (purpose, stack, architecture, conventions, decisions, known issues, verification commands). Do not paste chat transcripts. The previous version is archived automatically.',
    category: 'memory',
    mutating: true,
    risk: 'low',
    modes: ['build'],
    timeoutMs: 15000,
    inputSummary: 'content, reason?',
    parameters: objectSchema(
      {
        content: stringParam('Complete new memory content in Markdown.'),
        reason: stringParam('Short reason for the update.'),
      },
      ['content'],
    ),
    inputSchema: z.object({
      content: z.string().min(1).max(200000),
      reason: z.string().max(500).optional(),
    }),
    summarize: (input) => ({
      summary: 'Update project memory',
      details: { chars: String(input.content.length), reason: input.reason ?? '' },
    }),
    permission: () => memoryPermission('memory:update'),
    async execute(input, ctx) {
      const saved = await ctx.services.memory.save(ctx.project.id, input.content);
      ctx.invalidateContext('memory-updated');
      const preview = saved.content.trim().slice(0, 1500);
      return {
        content: `Project memory updated (${saved.content.length} chars). The previous version was archived.\n\n${preview}${saved.content.length > preview.length ? '\n…' : ''}`,
        summary: `Project memory updated (${saved.content.length} chars)`,
      };
    },
  });

  const listChats = defineTool({
    name: 'list_project_chats',
    description: 'List the chats that belong to this project (titles and message counts).',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 20000,
    inputSummary: 'none',
    parameters: objectSchema({}, []),
    inputSchema: z.object({}),
    summarize: () => ({ summary: 'List project chats', details: {} }),
    permission: () => readOnlyPermission('project:chats:list'),
    async execute(_input, ctx) {
      const chats = await ctx.services.chats.list(ctx.project.id);
      if (chats.length === 0) return { content: 'This project has no chats yet.', summary: 'No chats' };
      const lines = chats.map(
        (chat) => `${chat.id}  ${chat.mode.padEnd(5)}  ${chat.messageCount} msgs  ${chat.title}`,
      );
      return { content: lines.join('\n'), summary: `${chats.length} chats in this project` };
    },
  });

  const taskDraftSchema = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(20000).optional(),
    files: z.array(z.string().max(4096)).max(100).optional(),
    acceptanceCriteria: z.array(z.string().max(2000)).max(20).optional(),
    tests: z.array(z.string().max(2000)).max(20).optional(),
    risk: z.string().max(2000).optional(),
  });

  const savePlan = defineTool({
    name: 'save_plan',
    description:
      'Persist a structured implementation plan for this chat. In Plan Mode, call this once after inspecting the project, then present the plan to the user. In Build Mode it may be used to create a small internal plan when none is approved. Each task must be independently verifiable.',
    category: 'memory',
    mutating: true,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 30000,
    inputSummary: 'title, summary, approach, tasks[], internal?',
    parameters: objectSchema(
      {
        title: stringParam('Short plan title.'),
        summary: stringParam('What will be achieved.'),
        approach: stringParam('Implementation approach and reasoning.'),
        requirements: arrayParam('Concrete requirements.', { type: 'string' }),
        risks: arrayParam('Risks, conflicts or unknowns.', { type: 'string' }),
        tasks: arrayParam('Ordered tasks. Each item: {title, description, files, acceptanceCriteria, tests, risk}.', {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            tests: { type: 'array', items: { type: 'string' } },
            risk: { type: 'string' },
          },
          required: ['title'],
        }),
        internal: booleanParam(
          'Build Mode only: request an already-approved small internal plan (max 5 tasks).',
        ),
      },
      ['title', 'tasks'],
    ),
    inputSchema: z.object({
      title: z.string().min(1).max(300),
      summary: z.string().max(20000).optional(),
      approach: z.string().max(60000).optional(),
      requirements: z.array(z.string().max(2000)).max(50).optional(),
      risks: z.array(z.string().max(2000)).max(50).optional(),
      tasks: z.array(taskDraftSchema).min(1).max(40),
      internal: z.boolean().optional(),
    }),
    summarize: (input) => ({
      summary: `Save plan: ${input.title} (${input.tasks.length} tasks)`,
      details: { tasks: String(input.tasks.length) },
    }),
    permission: () => memoryPermission('plan:save'),
    async execute(input, ctx) {
      const wantsInternal = ctx.mode === 'build' && input.internal === true;
      if (wantsInternal && input.tasks.length > 5) {
        throw new Error(
          'An internal plan can contain at most 5 tasks. Create a draft plan and ask the user to approve it instead.',
        );
      }
      const { plan, tasks } = await ctx.services.tasks.createPlan({
        projectId: ctx.project.id,
        chatId: ctx.chat.id,
        title: input.title,
        summary: input.summary,
        approach: input.approach,
        requirements: input.requirements,
        risks: input.risks,
        tasks: input.tasks,
        approve: wantsInternal,
      });
      ctx.invalidateContext('plan-saved');
      const taskLines = tasks.map(
        (task) =>
          `${task.index + 1}. [${task.id}] ${task.title}${task.files.length ? ` — files: ${task.files.join(', ')}` : ''}`,
      );
      return {
        content: [
          `Plan saved: ${plan.title} (${plan.id})`,
          `status: ${plan.status}${plan.status === 'draft' ? ' — awaiting user approval before implementation' : ''}`,
          `tasks: ${tasks.length}`,
          ...taskLines,
          '',
          plan.status === 'draft'
            ? 'Do not implement anything yet. Summarize the plan for the user and ask them to approve it.'
            : 'The plan is approved. Implement tasks in order and record evidence when completing each one.',
        ].join('\n'),
        summary: `Plan saved (${plan.status}, ${tasks.length} tasks)`,
        details: { planId: plan.id, status: plan.status, tasks: String(tasks.length) },
        meta: { planId: plan.id },
      };
    },
  });

  const updateTaskStatus = defineTool({
    name: 'update_task_status',
    description:
      'Update a plan task status. Set status "in_progress" before working on it and "completed" only with evidence (the commands you actually ran and their results). Completion is rejected without evidence and before earlier tasks are complete.',
    category: 'memory',
    mutating: true,
    risk: 'low',
    modes: ['build'],
    timeoutMs: 20000,
    inputSummary: 'taskId, status, notes?, evidence?',
    parameters: objectSchema(
      {
        taskId: stringParam('Task id from the plan.'),
        status: stringParam('One of: pending, in_progress, blocked, completed, failed, cancelled.'),
        notes: stringParam('Short note about the current state.'),
        evidence: arrayParam('Evidence for completion: command + result summary or file verification.', {
          type: 'string',
        }),
      },
      ['taskId', 'status'],
    ),
    inputSchema: z.object({
      taskId: z.string().min(3).max(120),
      status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']),
      notes: z.string().max(20000).optional(),
      evidence: z.array(z.string().max(20000)).max(20).optional(),
    }),
    summarize: (input) => ({
      summary: `Task ${input.taskId} → ${input.status}`,
      details: { taskId: input.taskId, status: input.status },
    }),
    permission: () => memoryPermission('task:update'),
    async execute(input, ctx) {
      const task = await ctx.services.tasks.updateTask({
        projectId: ctx.project.id,
        taskId: input.taskId,
        status: input.status,
        notes: input.notes,
        evidence: input.evidence,
      });
      ctx.invalidateContext('task-updated');
      return {
        content: `Task ${task.index + 1} "${task.title}" is now ${task.status}.${task.evidence.length ? ` Evidence entries: ${task.evidence.length}.` : ''}`,
        summary: `Task ${task.index + 1}: ${task.status}`,
        details: { taskId: task.id, status: task.status },
        meta: { taskId: task.id, status: task.status },
      };
    },
  });

  const getTaskStatus = defineTool({
    name: 'get_task_status',
    description: 'Show the current plan, its tasks, statuses and recorded evidence for this chat (or a single task).',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 20000,
    inputSummary: 'taskId?',
    parameters: objectSchema({ taskId: stringParam('Optional task id.') }, []),
    inputSchema: z.object({ taskId: z.string().min(3).max(120).optional() }),
    summarize: (input) => ({ summary: input.taskId ? `Task ${input.taskId}` : 'Task status', details: {} }),
    permission: (input) => readOnlyPermission(`task:read:${input.taskId ?? 'current'}`),
    async execute(input, ctx) {
      if (input.taskId) {
        const all = await ctx.services.tasks.listProjectTasks(ctx.project.id);
        const task = all.find((entry) => entry.id === input.taskId);
        if (!task) return { content: `Task ${input.taskId} was not found in this project.`, summary: 'Task not found' };
        return {
          content: [
            `task ${task.id}: ${task.title}`,
            `status: ${task.status}`,
            `files: ${task.files.join(', ') || 'none'}`,
            `acceptance: ${task.acceptanceCriteria.join('; ') || 'none'}`,
            `tests: ${task.tests.join('; ') || 'none'}`,
            `evidence: ${task.evidence.join(' | ') || 'none'}`,
            `notes: ${task.notes || 'none'}`,
          ].join('\n'),
          summary: `Task ${task.title}: ${task.status}`,
        };
      }
      const current = await ctx.services.tasks.listForChat(ctx.project.id, ctx.chat.id);
      if (!current) {
        return { content: 'No plan exists for this chat yet. Use save_plan to create one.', summary: 'No plan' };
      }
      const lines = current.tasks.map(
        (task) =>
          `${task.index + 1}. [${task.status}] ${task.title}${task.status === 'completed' && task.evidence.length ? ' (evidence recorded)' : ''}`,
      );
      return {
        content: [`plan: ${current.plan.title} (${current.plan.status})`, ...lines].join('\n'),
        summary: `Plan ${current.plan.status}: ${current.tasks.filter((task) => task.status === 'completed').length}/${current.tasks.length} complete`,
        details: { planId: current.plan.id },
      };
    },
  });

  const tools: AnyToolDefinition[] = [
    getProjectInfo,
    readInstructions,
    readMemory,
    updateMemory,
    listChats,
    savePlan,
    updateTaskStatus,
    getTaskStatus,
  ];
  for (const tool of tools) registry.register(tool);
}
