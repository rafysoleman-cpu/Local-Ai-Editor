/**
 * Project-scoped permission persistence (`permissions.json`).
 */
import { PERMISSION_POLICY_VERSION, type PermissionRecord } from '@shared/app-types';
import { permissionFileSchema } from '@shared/validation';
import type { Logger } from '../logging/logger';
import type { FileStorage } from '../storage/file-storage';
import { STORAGE_PATHS } from '../storage/paths';
import type { ProjectService } from '../projects/project-service';
import { isPermissionExpired } from './policy-engine';

export class PermissionStorage {
  constructor(
    private readonly storage: FileStorage,
    private readonly projects: ProjectService,
    private readonly logger: Logger,
  ) {}

  async load(projectId: string): Promise<PermissionRecord[]> {
    const project = await this.projects.require(projectId);
    const file = await this.storage.readJson<{
      projectId: string;
      policyVersion: number;
      records: PermissionRecord[];
    }>(STORAGE_PATHS.permissions(projectId), permissionFileSchema, {
      projectId,
      policyVersion: PERMISSION_POLICY_VERSION,
      records: [],
    });
    if (file.projectId !== project.id) {
      this.logger.warn('permissions', 'Ignoring permissions file with a mismatched project id', {
        projectId,
      });
      return [];
    }
    const valid = file.records.filter(
      (record) => record.projectId === projectId && !isPermissionExpired(record),
    );
    return valid;
  }

  async save(projectId: string, records: PermissionRecord[]): Promise<void> {
    const project = await this.projects.require(projectId);
    const payload = { projectId: project.id, policyVersion: PERMISSION_POLICY_VERSION, records };
    permissionFileSchema.parse(payload);
    await this.storage.writeJson(STORAGE_PATHS.permissions(projectId), payload);
  }

  async add(projectId: string, record: PermissionRecord): Promise<void> {
    const records = await this.load(projectId);
    const filtered = records.filter((existing) => existing.actionKey !== record.actionKey);
    filtered.push(record);
    await this.save(projectId, filtered);
  }

  async findMatch(projectId: string, keys: string[]): Promise<PermissionRecord | null> {
    const records = await this.load(projectId);
    return records.find((record) => keys.includes(record.actionKey)) ?? null;
  }

  async revoke(projectId: string, recordId: string): Promise<boolean> {
    const records = await this.load(projectId);
    const next = records.filter((record) => record.id !== recordId);
    if (next.length === records.length) return false;
    await this.save(projectId, next);
    return true;
  }
}
