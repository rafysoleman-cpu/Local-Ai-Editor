/**
 * Asks the user for permission and persists project-scoped "Always Allow"
 * decisions. Timeouts and missing UI fail closed (deny).
 */
import {
  PERMISSION_POLICY_VERSION,
  type AppSettings,
  type PermissionDecision,
  type PermissionRecord,
  type PermissionRequest,
  type PermissionRisk,
} from '@shared/app-types';
import type { Logger } from '../logging/logger';
import { nowIso, storageId } from '../util/ids';
import { evaluatePolicy } from './policy-engine';
import type { PermissionStorage } from './permission-storage';

export interface AuthorizeInput {
  request: PermissionRequest;
  settings: AppSettings;
  risk: PermissionRisk;
  commandRisk?: PermissionRisk;
  isDelete?: boolean;
}

export interface PermissionOutcome {
  allowed: boolean;
  source: 'auto' | 'once' | 'project' | 'denied';
  reason: string;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

export type PermissionRequestHandler = (request: PermissionRequest) => void;
export type PermissionResolvedHandler = (
  requestId: string,
  decision: PermissionDecision,
) => void;

export class PermissionService {
  private requestHandler: PermissionRequestHandler | null = null;
  private resolvedHandler: PermissionResolvedHandler | null = null;
  private readonly pending = new Map<string, PendingPermission>();

  constructor(
    private readonly storage: PermissionStorage,
    private readonly logger: Logger,
  ) {}

  setRequestHandler(handler: PermissionRequestHandler | null): void {
    this.requestHandler = handler;
  }

  setResolvedHandler(handler: PermissionResolvedHandler | null): void {
    this.resolvedHandler = handler;
  }

  async authorize(input: AuthorizeInput): Promise<PermissionOutcome> {
    const { request, settings, risk, commandRisk, isDelete } = input;
    const keys = [request.alwaysKey ?? request.actionKey, request.actionKey].filter(
      (key): key is string => Boolean(key),
    );
    const matched = await this.storage.findMatch(request.projectId, keys);
    const policy = evaluatePolicy({
      category: request.category,
      risk,
      mutating: true,
      settings,
      matched,
      commandRisk,
      isDelete,
    });

    if (policy.decision === 'auto') {
      return {
        allowed: true,
        source: policy.source === 'project' ? 'project' : 'auto',
        reason: policy.reason,
      };
    }

    if (!this.requestHandler) {
      return {
        allowed: false,
        source: 'denied',
        reason: 'No approval interface is available, so the action was denied. Use a desktop session to approve it.',
      };
    }

    this.requestHandler(request);
    const decision = await this.waitForDecision(request, settings.permissions.permissionTimeoutMs);
    this.resolvedHandler?.(request.id, decision);

    if (decision === 'deny') {
      this.logger.info('permissions', 'Action denied by user', {
        projectId: request.projectId,
        tool: request.toolName,
        actionKey: request.actionKey,
      });
      return { allowed: false, source: 'denied', reason: 'You denied this action.' };
    }

    if (decision === 'always_allow' && request.alwaysKey) {
      const record = this.createRecord(request, risk);
      await this.storage.add(request.projectId, record);
      this.logger.info('permissions', 'Permission stored for project', {
        projectId: request.projectId,
        actionKey: record.actionKey,
      });
      return {
        allowed: true,
        source: 'project',
        reason: 'Approved. The permission is stored for this project only.',
      };
    }

    return {
      allowed: true,
      source: 'once',
      reason: 'Approved once.',
    };
  }

  private createRecord(request: PermissionRequest, risk: PermissionRisk): PermissionRecord {
    return {
      id: storageId('project').replace(/^p_/, 'perm_'),
      projectId: request.projectId,
      category: request.category,
      toolName: request.toolName,
      actionKey: request.alwaysKey ?? request.actionKey,
      label: `${request.title}${risk === 'high' ? ' (high risk)' : ''}`,
      scope: 'project',
      createdAt: nowIso(),
      expiresAt: null,
      policyVersion: PERMISSION_POLICY_VERSION,
    };
  }

  private waitForDecision(request: PermissionRequest, timeoutMs: number): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const finish = (decision: PermissionDecision): void => {
        const entry = this.pending.get(request.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(request.id);
        resolve(decision);
      };
      const timer = setTimeout(() => {
        this.logger.warn('permissions', 'Permission request timed out; failing closed', {
          requestId: request.id,
        });
        finish('deny');
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(request.id, { request, resolve: finish, timer });

      // If the request was resolved between emitting and registering, settle now.
      const existing = this.pending.get(request.id);
      if (!existing) resolve('deny');
    });
  }

  respond(requestId: string, decision: PermissionDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      throw new Error('This permission request is no longer pending.');
    }
    entry.resolve(decision);
  }

  /** Deny everything still pending for a cancelled run. */
  cancelRun(runId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.request.runId === runId) {
        entry.resolve('deny');
        this.pending.delete(id);
        this.resolvedHandler?.(id, 'deny');
      }
    }
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  async list(projectId: string): Promise<PermissionRecord[]> {
    return this.storage.load(projectId);
  }

  async revoke(projectId: string, recordId: string): Promise<boolean> {
    const revoked = await this.storage.revoke(projectId, recordId);
    if (revoked) this.logger.info('permissions', 'Permission revoked', { projectId, recordId });
    return revoked;
  }
}
