/**
 * Project lifecycle and metadata.
 *
 * Every project has a stable id, a workspace path that stays where the user
 * chose it, its own instructions, and indexes for chats, tasks and plans.
 * Application data never lives inside a project workspace.
 */
import { promises as fs } from 'node:fs';
import {
  APP_NAME,
  type Project,
  type ProjectInstructions,
  type ProjectSummary,
  type StorageManifest,
  type WorkspaceInfo,
  STORAGE_FORMAT_VERSION,
} from '@shared/app-types';
import { permissionFileSchema, projectSchema, storageManifestSchema } from '@shared/validation';
import type { Logger } from '../logging/logger';
import { STORAGE_PATHS } from '../storage/paths';
import type { FileStorage } from '../storage/file-storage';
import { AppError } from '../util/errors';
import { nowIso, storageId } from '../util/ids';
import { WorkspaceService } from './workspace-service';
import {
  sameWorkspacePath,
  validateProjectName,
  validateWorkspacePath,
} from './project-validation';

export const DEFAULT_INSTRUCTIONS = `# Project instructions

Describe how the agent should work in this project: architecture, conventions,
commands to verify changes, and anything it must not touch.

- Main technologies:
- Verification commands:
- Conventions:
`;

export const DEFAULT_MEMORY = `# Project memory

<!--
The agent maintains this file through the \`update_project_memory\` tool.
Keep it concise and stable: purpose, stack, architecture, conventions,
important decisions, known issues and useful commands. Do not paste whole chats.
-->
`;

export interface CreateProjectInput {
  name: string;
  workspacePath: string;
  createWorkspace: boolean;
  initializeGit: boolean;
}

export type ProjectChangeListener = (projectId: string, reason: string) => void;

export class ProjectService {
  private readonly listeners = new Set<ProjectChangeListener>();

  constructor(
    private readonly storage: FileStorage,
    private readonly logger: Logger,
    private readonly appVersion: string,
    private readonly workspace: WorkspaceService,
    private readonly dataDirectory: () => string,
    private readonly initializeGit?: (directory: string) => Promise<void>,
  ) {}

  onChange(listener: ProjectChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(projectId: string, reason: string): void {
    for (const listener of this.listeners) {
      try {
        listener(projectId, reason);
      } catch {
        /* listeners must not break project operations */
      }
    }
  }

  async list(): Promise<ProjectSummary[]> {
    const folders = await this.storage.listDir(STORAGE_PATHS.projects);
    const summaries: ProjectSummary[] = [];
    for (const folder of folders) {
      if (!folder.startsWith('project-')) continue;
      const projectId = folder.slice('project-'.length);
      try {
        const project = await this.readProject(projectId);
        if (!project) continue;
        const missing = !(await this.pathExists(project.workspacePath));
        summaries.push({
          id: project.id,
          name: project.name,
          workspacePath: project.workspacePath,
          workspaceMissing: missing,
          chatCount: project.chatIds.length,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        });
      } catch (error) {
        this.logger.warn('project', `Skipping unreadable project ${projectId}`, {
          error: (error as Error).message,
        });
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      const stat = await fs.stat(target);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async readProject(projectId: string): Promise<Project | null> {
    const exists = await this.storage.exists(STORAGE_PATHS.project(projectId));
    if (!exists) return null;
    const project = await this.storage.readJson<Project>(
      STORAGE_PATHS.project(projectId),
      projectSchema,
      {
        id: projectId,
        name: 'Unreadable project',
        workspacePath: '',
        workspaceMissing: true,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        defaultModel: null,
        chatIds: [],
        taskIds: [],
        planIds: [],
        formatVersion: STORAGE_FORMAT_VERSION,
      },
    );
    if (project.id !== projectId) {
      throw new AppError(
        `Project data mismatch: folder ${projectId} contains project ${project.id}. The project was not loaded.`,
        'ISOLATION',
      );
    }
    if (!project.workspacePath) {
      this.logger.warn('project', `Project ${projectId} has no readable workspace path; skipping it.`);
      return null;
    }
    return project;
  }

  async get(projectId: string): Promise<Project | null> {
    const project = await this.readProject(projectId);
    if (!project) return null;
    return { ...project, workspaceMissing: !(await this.pathExists(project.workspacePath)) };
  }

  async require(projectId: string): Promise<Project> {
    const project = await this.get(projectId);
    if (!project) throw new AppError(`Project not found: ${projectId}`, 'NOT_FOUND');
    return project;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const name = validateProjectName(input.name);
    const workspacePath = await validateWorkspacePath(input.workspacePath, {
      dataDirectory: this.dataDirectory(),
      create: input.createWorkspace,
    });

    const existing = await this.list();
    const duplicate = existing.find((project) => sameWorkspacePath(project.workspacePath, workspacePath));
    if (duplicate) {
      throw new AppError(
        `This folder is already used by the project "${duplicate.name}".`,
        'CONFLICT',
      );
    }

    if (input.initializeGit && this.initializeGit) {
      try {
        await this.initializeGit(workspacePath);
      } catch (error) {
        this.logger.warn('project', 'git init failed', { error: (error as Error).message });
      }
    }

    const id = storageId('project');
    const at = nowIso();
    const project: Project = {
      id,
      name,
      workspacePath,
      workspaceMissing: false,
      createdAt: at,
      updatedAt: at,
      defaultModel: null,
      chatIds: [],
      taskIds: [],
      planIds: [],
      formatVersion: STORAGE_FORMAT_VERSION,
    };

    for (const directory of [
      STORAGE_PATHS.projectDir(id),
      STORAGE_PATHS.chatsDir(id),
      STORAGE_PATHS.tasksDir(id),
      STORAGE_PATHS.plansDir(id),
      STORAGE_PATHS.projectLogsDir(id),
      STORAGE_PATHS.memoryHistoryDir(id),
    ]) {
      await this.storage.ensureDir(directory);
    }
    await this.storage.writeJson(STORAGE_PATHS.project(id), project);
    await this.storage.writeText(STORAGE_PATHS.instructions(id), DEFAULT_INSTRUCTIONS, { backup: false });
    await this.storage.writeText(STORAGE_PATHS.memory(id), DEFAULT_MEMORY, { backup: false });
    await this.storage.writeJson(STORAGE_PATHS.permissions(id), {
      projectId: id,
      policyVersion: 1,
      records: [],
    });
    await this.refreshManifest();
    this.emitChange(id, 'created');
    this.logger.info('project', 'Project created', { id, name, workspacePath });
    return project;
  }

  async update(input: {
    projectId: string;
    name?: string;
    workspacePath?: string;
    defaultModel?: string | null;
  }): Promise<Project> {
    const project = await this.require(input.projectId);
    if (input.name !== undefined) project.name = validateProjectName(input.name);
    if (input.defaultModel !== undefined) {
      project.defaultModel = input.defaultModel && input.defaultModel.trim() ? input.defaultModel.trim() : null;
    }
    if (input.workspacePath !== undefined) {
      const nextPath = await validateWorkspacePath(input.workspacePath, {
        dataDirectory: this.dataDirectory(),
      });
      const existing = await this.list();
      const duplicate = existing.find(
        (other) => other.id !== project.id && sameWorkspacePath(other.workspacePath, nextPath),
      );
      if (duplicate) {
        throw new AppError(`That folder already belongs to "${duplicate.name}".`, 'CONFLICT');
      }
      project.workspacePath = nextPath;
      project.workspaceMissing = false;
    }
    project.updatedAt = nowIso();
    await this.storage.writeJson(STORAGE_PATHS.project(project.id), project);
    await this.refreshManifest();
    this.emitChange(project.id, 'updated');
    return project;
  }

  /**
   * Remove a project from the dashboard by moving its application data into
   * `backups/removed-project-*`. Source files and chat history are kept.
   */
  async remove(projectId: string): Promise<void> {
    const project = await this.require(projectId);
    const stamp = nowIso().replace(/[:.]/g, '-');
    const destination = `${STORAGE_PATHS.backups}/removed-project-${project.id}-${stamp}`;
    await this.storage.ensureDir(STORAGE_PATHS.backups);
    await this.storage.rename(STORAGE_PATHS.projectDir(project.id), destination);
    await this.refreshManifest();
    this.emitChange(project.id, 'removed');
    this.logger.warn('project', 'Project removed from dashboard (data archived)', {
      id: project.id,
      destination,
    });
  }

  /** Explicit permanent deletion of application data. Never touches the workspace. */
  async deletePermanently(projectId: string): Promise<void> {
    const project = await this.require(projectId);
    await this.storage.remove(STORAGE_PATHS.projectDir(project.id), true);
    await this.refreshManifest();
    this.emitChange(project.id, 'deleted');
    this.logger.warn('project', 'Project application data permanently deleted', {
      id: project.id,
      workspacePath: project.workspacePath,
    });
  }

  async getInstructions(projectId: string): Promise<ProjectInstructions> {
    await this.require(projectId);
    const content = (await this.storage.readText(STORAGE_PATHS.instructions(projectId))) ?? '';
    const age = await this.storage.modifiedAgeSeconds(STORAGE_PATHS.instructions(projectId));
    const updatedAt =
      age === null ? null : new Date(Date.now() - age * 1000).toISOString();
    return { content, updatedAt };
  }

  async saveInstructions(projectId: string, content: string): Promise<ProjectInstructions> {
    await this.require(projectId);
    if (content.length > 200000) throw new AppError('Instructions are too long.', 'LIMIT');
    await this.storage.writeText(STORAGE_PATHS.instructions(projectId), content);
    const at = nowIso();
    this.emitChange(projectId, 'instructions');
    return { content, updatedAt: at };
  }

  async getWorkspaceInfo(projectId: string): Promise<WorkspaceInfo> {
    const project = await this.require(projectId);
    return this.workspace.workspaceInfo(project.workspacePath);
  }

  async updateIndexes(
    projectId: string,
    mutate: (project: Project) => void,
  ): Promise<Project> {
    const project = await this.require(projectId);
    mutate(project);
    project.updatedAt = nowIso();
    await this.storage.writeJson(STORAGE_PATHS.project(project.id), project);
    return project;
  }

  async refreshManifest(): Promise<StorageManifest> {
    const existing = await this.storage
      .readJson<StorageManifest | null>(STORAGE_PATHS.manifest, storageManifestSchema, null)
      .catch(() => null);
    const projects = await this.list();
    const manifest: StorageManifest = {
      formatVersion: STORAGE_FORMAT_VERSION,
      appVersion: this.appVersion,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      generation: (existing?.generation ?? 0) + 1,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        chatCount: project.chatCount,
        updatedAt: project.updatedAt,
      })),
    };
    await this.storage.writeJson(STORAGE_PATHS.manifest, manifest);
    return manifest;
  }

  /** Verify a permissions file belongs to the project before writing it. */
  async writePermissions(projectId: string, records: Array<Record<string, unknown>>): Promise<void> {
    const project = await this.require(projectId);
    const payload = { projectId: project.id, policyVersion: 1, records };
    permissionFileSchema.parse(payload);
    await this.storage.writeJson(STORAGE_PATHS.permissions(project.id), payload);
  }

  appTitle(): string {
    return APP_NAME;
  }
}
