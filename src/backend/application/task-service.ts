/**
 * Plans and tasks.
 *
 * Plans are persistent records: approving one never deletes it. Task status
 * transitions are enforced here, and a task can only be completed when the
 * executor supplied evidence (a command result, file check or similar).
 */
import type { Plan, Project, Task, TaskStatus } from '@shared/app-types';
import { planSchema, taskSchema } from '@shared/validation';
import type { Logger } from '../logging/logger';
import type { FileStorage } from '../storage/file-storage';
import { STORAGE_PATHS } from '../storage/paths';
import { AppError } from '../util/errors';
import { nowIso, storageId } from '../util/ids';
import type { ProjectService } from '../projects/project-service';
import type { ChatService } from './chat-service';

export interface PlanTaskDraft {
  title: string;
  description?: string;
  files?: string[];
  acceptanceCriteria?: string[];
  tests?: string[];
  risk?: string;
}

export interface CreatePlanInput {
  projectId: string;
  chatId: string;
  title: string;
  summary?: string;
  approach?: string;
  requirements?: string[];
  risks?: string[];
  tasks: PlanTaskDraft[];
  /** Build Mode may create a small internal plan that is already approved. */
  approve?: boolean;
}

export interface PlanWithTasks {
  plan: Plan;
  tasks: Task[];
}

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['completed', 'failed', 'blocked', 'cancelled'],
  blocked: ['pending', 'in_progress', 'failed', 'cancelled'],
  failed: ['in_progress', 'blocked', 'cancelled'],
  completed: [],
  cancelled: [],
};

const PLAN_TRANSITIONS: Record<Plan['status'], Plan['status'][]> = {
  draft: ['approved', 'rejected', 'cancelled'],
  approved: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  rejected: ['draft'],
  completed: [],
  cancelled: [],
};

function cleanText(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function cleanList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export class TaskService {
  private readonly listeners = new Set<(projectId: string, planId: string) => void>();

  constructor(
    private readonly storage: FileStorage,
    private readonly projects: ProjectService,
    private readonly chats: ChatService,
    private readonly logger: Logger,
  ) {}

  onChange(listener: (projectId: string, planId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(projectId: string, planId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(projectId, planId);
      } catch {
        /* ignore */
      }
    }
  }

  async createPlan(input: CreatePlanInput): Promise<PlanWithTasks> {
    const project = await this.projects.require(input.projectId);
    const chat = await this.chats.require(input.projectId, input.chatId);
    if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
      throw new AppError('A plan needs at least one task.', 'INVALID');
    }
    if (input.tasks.length > 40) {
      throw new AppError('A plan can contain at most 40 tasks. Split the work into smaller plans.', 'LIMIT');
    }

    const at = nowIso();
    const planId = storageId('plan');
    const newTasks: Task[] = input.tasks.map((draft, index) => {
      const title = cleanText(draft.title, 300);
      if (!title) throw new AppError(`Task ${index + 1} needs a title.`, 'INVALID');
      const task: Task = {
        id: storageId('task'),
        projectId: project.id,
        chatId: chat.id,
        planId,
        index,
        title,
        description: cleanText(draft.description, 20000),
        files: cleanList(draft.files, 200, 4096),
        acceptanceCriteria: cleanList(draft.acceptanceCriteria, 50, 4000),
        tests: cleanList(draft.tests, 50, 4000),
        risk: cleanText(draft.risk, 4000),
        status: 'pending',
        notes: '',
        evidence: [],
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        completedAt: null,
      };
      taskSchema.parse(task);
      return task;
    });

    const plan: Plan = {
      id: planId,
      projectId: project.id,
      chatId: chat.id,
      title: cleanText(input.title, 300, 'Implementation plan'),
      summary: cleanText(input.summary, 20000),
      approach: cleanText(input.approach, 60000),
      requirements: cleanList(input.requirements, 50, 4000),
      risks: cleanList(input.risks, 50, 4000),
      taskIds: newTasks.map((task) => task.id),
      status: input.approve ? 'approved' : 'draft',
      createdAt: at,
      updatedAt: at,
      approvedAt: input.approve ? at : null,
    };
    planSchema.parse(plan);

    // Supersede older draft plans for this chat so the UI has a single active draft.
    const existing = await this.findPlansForChat(project, chat.id);
    for (const previous of existing) {
      if (previous.status === 'draft' || previous.status === 'rejected') {
        await this.cancelPlan(previous, 'Superseded by a newer plan');
      }
    }

    await this.storage.ensureDir(STORAGE_PATHS.plansDir(project.id));
    await this.storage.ensureDir(STORAGE_PATHS.tasksDir(project.id));
    for (const task of newTasks) {
      await this.storage.writeJson(STORAGE_PATHS.task(project.id, task.id), task, { backup: false });
    }
    await this.storage.writeJson(STORAGE_PATHS.plan(project.id, plan.id), plan, { backup: false });
    await this.projects.updateIndexes(project.id, (value: Project) => {
      if (!value.planIds.includes(plan.id)) value.planIds.push(plan.id);
      for (const task of newTasks) {
        if (!value.taskIds.includes(task.id)) value.taskIds.push(task.id);
      }
    });
    await this.chats.setCurrentPlan(project.id, chat.id, plan.id);
    this.emit(project.id, plan.id);
    this.logger.info('tasks', 'Plan created', {
      projectId: project.id,
      planId: plan.id,
      tasks: newTasks.length,
      approved: Boolean(input.approve),
    });
    return { plan, tasks: newTasks };
  }

  private async findPlansForChat(project: Project, chatId: string): Promise<Plan[]> {
    const plans: Plan[] = [];
    for (const planId of project.planIds) {
      const plan = await this.readPlan(project.id, planId);
      if (plan && plan.chatId === chatId) plans.push(plan);
    }
    return plans.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async readPlan(projectId: string, planId: string): Promise<Plan | null> {
    const project = await this.projects.require(projectId);
    if (!project.planIds.includes(planId)) return null;
    if (!(await this.storage.exists(STORAGE_PATHS.plan(projectId, planId)))) return null;
    const plan = await this.storage.readJson<Plan | null>(
      STORAGE_PATHS.plan(projectId, planId),
      planSchema,
      null,
    );
    if (!plan) return null;
    if (plan.projectId !== projectId) {
      throw new AppError('Plan belongs to a different project. Access was rejected.', 'ISOLATION');
    }
    return plan;
  }

  async getPlan(projectId: string, planId: string): Promise<PlanWithTasks> {
    const plan = await this.readPlan(projectId, planId);
    if (!plan) throw new AppError(`Plan not found: ${planId}`, 'NOT_FOUND');
    const tasks = await this.readTasks(plan);
    return { plan, tasks };
  }

  private async readTasks(plan: Plan): Promise<Task[]> {
    const tasks: Task[] = [];
    for (const taskId of plan.taskIds) {
      const task = await this.storage.readJson<Task | null>(
        STORAGE_PATHS.task(plan.projectId, taskId),
        taskSchema,
        null,
      );
      if (!task) continue;
      if (task.planId !== plan.id || task.projectId !== plan.projectId) {
        throw new AppError('Task does not belong to this plan. Access was rejected.', 'ISOLATION');
      }
      tasks.push(task);
    }
    return tasks.sort((a, b) => a.index - b.index);
  }

  async listForChat(projectId: string, chatId: string): Promise<PlanWithTasks | null> {
    const project = await this.projects.require(projectId);
    const chat = await this.chats.require(projectId, chatId);
    let planId = chat.currentPlanId;
    if (!planId) {
      const plans = await this.findPlansForChat(project, chatId);
      const latest = plans[plans.length - 1];
      planId = latest?.id ?? null;
    }
    if (!planId) return null;
    try {
      return await this.getPlan(projectId, planId);
    } catch {
      return null;
    }
  }

  async approvePlan(projectId: string, planId: string): Promise<Plan> {
    const { plan, tasks } = await this.getPlan(projectId, planId);
    if (!PLAN_TRANSITIONS[plan.status].includes('approved')) {
      throw new AppError(`A plan in status "${plan.status}" cannot be approved.`, 'INVALID');
    }
    plan.status = 'approved';
    plan.approvedAt = nowIso();
    plan.updatedAt = plan.approvedAt;
    await this.storage.writeJson(STORAGE_PATHS.plan(projectId, plan.id), plan);
    await this.chats.setCurrentPlan(projectId, plan.chatId, plan.id);
    this.emit(projectId, plan.id);
    this.logger.info('tasks', 'Plan approved', { projectId, planId, tasks: tasks.length });
    return plan;
  }

  async rejectPlan(projectId: string, planId: string): Promise<Plan> {
    const { plan } = await this.getPlan(projectId, planId);
    if (!PLAN_TRANSITIONS[plan.status].includes('rejected')) {
      throw new AppError(`A plan in status "${plan.status}" cannot be rejected.`, 'INVALID');
    }
    plan.status = 'rejected';
    plan.updatedAt = nowIso();
    await this.storage.writeJson(STORAGE_PATHS.plan(projectId, plan.id), plan);
    this.emit(projectId, plan.id);
    return plan;
  }

  private async cancelPlan(plan: Plan, note: string): Promise<void> {
    if (plan.status === 'completed' || plan.status === 'cancelled') return;
    plan.status = 'cancelled';
    plan.updatedAt = nowIso();
    await this.storage.writeJson(STORAGE_PATHS.plan(plan.projectId, plan.id), plan);
    const tasks = await this.readTasks(plan);
    for (const task of tasks) {
      if (task.status === 'completed' || task.status === 'cancelled') continue;
      task.status = 'cancelled';
      task.notes = `${task.notes}\n${note}`.trim();
      task.updatedAt = nowIso();
      await this.storage.writeJson(STORAGE_PATHS.task(plan.projectId, task.id), task);
    }
  }

  async updateTask(input: {
    projectId: string;
    taskId: string;
    status: TaskStatus;
    notes?: string;
    evidence?: string[];
  }): Promise<Task> {
    const project = await this.projects.require(input.projectId);
    if (!project.taskIds.includes(input.taskId)) {
      throw new AppError(`Task not found in this project: ${input.taskId}`, 'NOT_FOUND');
    }
    const task = await this.storage.readJson<Task | null>(
      STORAGE_PATHS.task(input.projectId, input.taskId),
      taskSchema,
      null,
    );
    if (!task) throw new AppError(`Task not found: ${input.taskId}`, 'NOT_FOUND');
    if (task.projectId !== input.projectId) {
      throw new AppError('Task belongs to a different project. Access was rejected.', 'ISOLATION');
    }

    const { plan, tasks: planTasks } = await this.getPlan(input.projectId, task.planId);
    if (task.status !== input.status && !TASK_TRANSITIONS[task.status].includes(input.status)) {
      throw new AppError(
        `Invalid task transition: ${task.status} → ${input.status}. Allowed: ${TASK_TRANSITIONS[task.status].join(', ') || 'none'}.`,
        'INVALID',
      );
    }
    if (input.evidence && input.evidence.length > 0) {
      task.evidence = [...task.evidence, ...cleanList(input.evidence, 20, 20000)];
    }
    if (input.notes !== undefined) {
      task.notes = cleanText(input.notes, 20000);
    }
    if (input.status === 'completed') {
      const evidence = task.evidence.filter((entry) => entry.trim().length > 0);
      if (evidence.length === 0) {
        throw new AppError(
          'Completing a task requires recorded evidence (for example the result of the verification command that was actually run).',
          'INVALID',
        );
      }
      const incomplete = planTasks.filter(
        (other) => other.index < task.index && other.status !== 'completed' && other.status !== 'cancelled',
      );
      if (incomplete.length > 0) {
        throw new AppError(
          `Task ${task.index + 1} cannot be completed before earlier task ${incomplete[0].index + 1} ("${incomplete[0].title}").`,
          'INVALID',
        );
      }
    }

    task.status = input.status;
    task.updatedAt = nowIso();
    if (input.status === 'in_progress' && !task.startedAt) task.startedAt = task.updatedAt;
    if (input.status === 'completed') task.completedAt = task.updatedAt;
    taskSchema.parse(task);
    await this.storage.writeJson(STORAGE_PATHS.task(input.projectId, task.id), task);

    const updatedTasks = planTasks.map((entry) => (entry.id === task.id ? task : entry));
    await this.syncPlanStatus(plan, updatedTasks);
    this.emit(input.projectId, plan.id);
    return task;
  }

  private async syncPlanStatus(plan: Plan, tasks: Task[]): Promise<void> {
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const cancelled = tasks.filter((task) => task.status === 'cancelled').length;
    const started = tasks.some((task) =>
      ['in_progress', 'completed', 'failed', 'blocked'].includes(task.status),
    );
    let next = plan.status;
    if (completed === tasks.length) next = 'completed';
    else if (cancelled === tasks.length) next = 'cancelled';
    else if (plan.status === 'approved' && started) next = 'in_progress';
    else if (plan.status === 'in_progress' && !started) next = 'approved';
    if (next !== plan.status && PLAN_TRANSITIONS[plan.status].includes(next)) {
      plan.status = next;
      plan.updatedAt = nowIso();
      await this.storage.writeJson(STORAGE_PATHS.plan(plan.projectId, plan.id), plan);
    }
  }

  /** The next task Build Mode should attempt, honoring task order. */
  async nextTask(projectId: string, planId: string): Promise<Task | null> {
    const { tasks } = await this.getPlan(projectId, planId);
    const active = tasks.find((task) => task.status === 'in_progress');
    if (active) return active;
    const failed = tasks.find((task) => task.status === 'failed' || task.status === 'blocked');
    if (failed) return failed;
    return tasks.find((task) => task.status === 'pending') ?? null;
  }

  async progress(
    projectId: string,
    planId: string,
  ): Promise<{ total: number; completed: number; cancelled: number; remaining: number }> {
    const { tasks } = await this.getPlan(projectId, planId);
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const cancelled = tasks.filter((task) => task.status === 'cancelled').length;
    return {
      total: tasks.length,
      completed,
      cancelled,
      remaining: tasks.length - completed - cancelled,
    };
  }

  async listProjectTasks(projectId: string): Promise<Task[]> {
    const project = await this.projects.require(projectId);
    const tasks: Task[] = [];
    for (const taskId of project.taskIds) {
      const task = await this.storage.readJson<Task | null>(
        STORAGE_PATHS.task(projectId, taskId),
        taskSchema,
        null,
      );
      if (task && task.projectId === projectId) tasks.push(task);
    }
    return tasks;
  }
}
