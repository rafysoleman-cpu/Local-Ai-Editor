import { randomBytes } from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function storageId(kind: 'project' | 'chat' | 'task' | 'plan'): string {
  const prefix = { project: 'p', chat: 'c', task: 't', plan: 'pl' }[kind];
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function shortRandom(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}
