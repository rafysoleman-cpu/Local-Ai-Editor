/**
 * Permission policy.
 *
 * Rules, in order:
 *   1. A stored, unexpired project permission for the action -> allow.
 *   2. Read-only inspection -> allow when the project policy opts in.
 *   3. Memory updates -> allow (the previous version is always archived).
 *   4. File writes/creates -> allow when the project policy opts in and the
 *      action is not high risk.
 *   5. Everything else (commands, deletes, custom tools) -> ask the user.
 *
 * A stored permission never overrides path validation or a hard-blocked command.
 */
import type { AppSettings, PermissionCategory, PermissionRecord, PermissionRisk } from '@shared/app-types';

export interface PolicyInput {
  category: PermissionCategory;
  risk: PermissionRisk;
  mutating: boolean;
  settings: AppSettings;
  matched: PermissionRecord | null;
  /** Risk derived from analyzing the actual command, when applicable. */
  commandRisk?: PermissionRisk;
  isDelete?: boolean;
}

export interface PolicyDecision {
  decision: 'auto' | 'ask' | 'deny';
  reason: string;
  source: 'auto' | 'project' | null;
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { category, risk, settings, matched, commandRisk, isDelete } = input;
  if (matched) {
    return {
      decision: 'auto',
      source: 'project',
      reason: 'A stored permission for this project covers this action.',
    };
  }

  if (commandRisk === 'low' && settings.permissions.autoApproveReadOnly) {
    return {
      decision: 'auto',
      source: 'auto',
      reason: 'Read-only command, approved automatically by the project policy.',
    };
  }

  if (category === 'read' || category === 'git') {
    return settings.permissions.autoApproveReadOnly
      ? { decision: 'auto', source: 'auto', reason: 'Read-only operation.' }
      : { decision: 'ask', source: null, reason: 'Read access requires approval under the current policy.' };
  }

  if (category === 'memory') {
    return {
      decision: 'auto',
      source: 'auto',
      reason: 'Project memory updates are recorded and the previous version is archived.',
    };
  }

  if (category === 'write' && !isDelete) {
    if (settings.permissions.autoApproveFileWrites && risk !== 'high') {
      return {
        decision: 'auto',
        source: 'auto',
        reason: 'File edits inside the workspace are auto-approved by the project policy.',
      };
    }
    return { decision: 'ask', source: null, reason: 'File changes require approval.' };
  }

  return { decision: 'ask', source: null, reason: 'This action requires your approval.' };
}

export function isPermissionExpired(record: PermissionRecord): boolean {
  if (!record.expiresAt) return false;
  const expires = new Date(record.expiresAt).getTime();
  return Number.isFinite(expires) && expires < Date.now();
}
