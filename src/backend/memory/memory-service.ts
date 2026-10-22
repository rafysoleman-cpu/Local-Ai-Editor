/**
 * Project memory: a concise, human-readable Markdown file per project.
 * Previous versions are archived before every change so memory is never
 * silently lost.
 */
import { promises as fs } from 'node:fs';
import type { ProjectMemory } from '@shared/app-types';
import type { Logger } from '../logging/logger';
import type { FileStorage } from '../storage/file-storage';
import { STORAGE_PATHS } from '../storage/paths';
import { AppError } from '../util/errors';
import { nowIso } from '../util/ids';
import type { ProjectService } from '../projects/project-service';
import { validateMemoryContent } from './memory-validation';

export class MemoryService {
  private readonly listeners = new Set<(projectId: string) => void>();

  constructor(
    private readonly storage: FileStorage,
    private readonly projects: ProjectService,
    private readonly logger: Logger,
  ) {}

  onChange(listener: (projectId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(projectId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(projectId);
      } catch {
        /* ignore */
      }
    }
  }

  async get(projectId: string): Promise<ProjectMemory> {
    await this.projects.require(projectId);
    const content = (await this.storage.readText(STORAGE_PATHS.memory(projectId))) ?? '';
    const age = await this.storage.modifiedAgeSeconds(STORAGE_PATHS.memory(projectId));
    return {
      content,
      updatedAt: age === null ? null : new Date(Date.now() - age * 1000).toISOString(),
    };
  }

  async save(projectId: string, content: string): Promise<ProjectMemory> {
    await this.projects.require(projectId);
    const validated = validateMemoryContent(content);
    const current = await this.storage.readText(STORAGE_PATHS.memory(projectId));
    if (current !== null && current.trim() === validated.content.trim()) {
      const age = await this.storage.modifiedAgeSeconds(STORAGE_PATHS.memory(projectId));
      return {
        content: current,
        updatedAt: age === null ? null : new Date(Date.now() - age * 1000).toISOString(),
      };
    }
    if (current && current.trim().length > 0) {
      const stamp = nowIso().replace(/[:.]/g, '-');
      try {
        await this.storage.writeText(STORAGE_PATHS.memoryHistory(projectId, stamp), current, {
          backup: false,
        });
      } catch (error) {
        this.logger.warn('memory', 'Could not archive previous memory version', {
          projectId,
          error: (error as Error).message,
        });
      }
    }
    await this.storage.writeText(STORAGE_PATHS.memory(projectId), validated.content);
    this.emit(projectId);
    this.logger.info('memory', 'Project memory updated', {
      projectId,
      chars: validated.content.length,
      warnings: validated.warnings,
    });
    return { content: validated.content, updatedAt: nowIso() };
  }

  async appendSection(projectId: string, section: string, heading?: string): Promise<ProjectMemory> {
    const current = await this.get(projectId);
    const addition = heading ? `\n## ${heading}\n\n${section.trim()}\n` : `\n${section.trim()}\n`;
    return this.save(projectId, `${current.content.trimEnd()}\n${addition}`);
  }

  async listHistory(projectId: string): Promise<Array<{ name: string; size: number; modifiedAt: string }>> {
    await this.projects.require(projectId);
    const folder = STORAGE_PATHS.memoryHistoryDir(projectId);
    const names = await this.storage.listDir(folder);
    const result: Array<{ name: string; size: number; modifiedAt: string }> = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      try {
        const absolute = this.storage.absolute(`${folder}/${name}`);
        const stat = await fs.stat(absolute);
        result.push({ name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
      } catch {
        /* ignore */
      }
    }
    return result.sort((a, b) => b.name.localeCompare(a.name));
  }

  async readHistoryVersion(projectId: string, name: string): Promise<string> {
    await this.projects.require(projectId);
    if (!/^memory-[A-Za-z0-9._-]+\.md$/.test(name)) {
      throw new AppError('Invalid memory history file name.', 'INVALID');
    }
    const content = await this.storage.readText(`${STORAGE_PATHS.memoryHistoryDir(projectId)}/${name}`);
    if (content === null) throw new AppError('Memory version not found.', 'NOT_FOUND');
    return content;
  }
}
