/**
 * Workspace-level execution lock. Prevents two Build Mode runs from changing
 * the same workspace at the same time.
 */
export interface LockHolder {
  runId: string;
  chatId: string;
  startedAt: string;
}

export class WorkspaceLock {
  private readonly locks = new Map<string, LockHolder>();

  acquire(projectId: string, holder: LockHolder): { ok: true } | { ok: false; holder: LockHolder } {
    const existing = this.locks.get(projectId);
    if (existing) return { ok: false, holder: existing };
    this.locks.set(projectId, holder);
    return { ok: true };
  }

  release(projectId: string, runId: string): void {
    const existing = this.locks.get(projectId);
    if (existing && existing.runId === runId) this.locks.delete(projectId);
  }

  holder(projectId: string): LockHolder | null {
    return this.locks.get(projectId) ?? null;
  }

  list(): Array<{ projectId: string } & LockHolder> {
    return [...this.locks.entries()].map(([projectId, holder]) => ({ projectId, ...holder }));
  }
}
