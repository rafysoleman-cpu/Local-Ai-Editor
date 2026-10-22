/**
 * Small in-memory context cache with explicit fingerprints.
 *
 * This cache only avoids repeated file scanning / prompt-block assembly. It is
 * not conversation memory and it does not reduce the tokens the model processes.
 * Default TTL is five minutes; entries are also invalidated immediately when
 * project data changes.
 */
import type { CacheStats } from '@shared/app-types';

export interface CacheEntry<T> {
  key: string;
  projectId: string;
  chatId: string | null;
  createdAt: number;
  expiresAt: number;
  fingerprint: string;
  value: T;
}

export class ContextCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private hits = 0;
  private misses = 0;
  private expiries = 0;
  private invalidations = 0;
  private lastInvalidationReason: string | null = null;

  constructor(private readonly ttlMs = 5 * 60 * 1000) {}

  get<T>(
    key: string,
    fingerprint: string,
    projectId: string,
    chatId: string | null = null,
  ): T | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (entry.projectId !== projectId || entry.chatId !== chatId) {
      this.misses += 1;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.expiries += 1;
      this.misses += 1;
      return null;
    }
    if (entry.fingerprint !== fingerprint) {
      // Dependencies changed before the TTL expired: rebuild.
      this.entries.delete(key);
      this.invalidations += 1;
      this.lastInvalidationReason = 'dependency-fingerprint-changed';
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return entry.value as T;
  }

  set<T>(
    key: string,
    value: T,
    fingerprint: string,
    projectId: string,
    chatId: string | null = null,
  ): void {
    const now = Date.now();
    this.entries.set(key, {
      key,
      projectId,
      chatId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      fingerprint,
      value,
    });
    if (this.entries.size > 200) {
      const oldest = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.entries.delete(oldest.key);
    }
  }

  invalidateProject(projectId: string, reason: string): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.projectId === projectId) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.invalidations += removed;
      this.lastInvalidationReason = reason;
    }
    return removed;
  }

  invalidateChat(projectId: string, chatId: string, reason: string): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.projectId === projectId && (entry.chatId === chatId || entry.chatId === null)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.invalidations += removed;
      this.lastInvalidationReason = reason;
    }
    return removed;
  }

  invalidateAll(reason: string): void {
    const size = this.entries.size;
    this.entries.clear();
    if (size > 0) {
      this.invalidations += size;
      this.lastInvalidationReason = reason;
    }
  }

  stats(): CacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      expiries: this.expiries,
      invalidations: this.invalidations,
      lastInvalidationReason: this.lastInvalidationReason,
    };
  }
}
