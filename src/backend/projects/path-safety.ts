/**
 * Workspace path safety.
 *
 * Agent tools and renderer IPC both go through these helpers. Paths are rejected
 * when they are absolute, escape the workspace lexically, or resolve through a
 * symlink to a location outside the workspace.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class WorkspaceAccessError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_PATH'
      | 'OUTSIDE_WORKSPACE'
      | 'MISSING'
      | 'NOT_A_DIRECTORY'
      | 'NOT_A_FILE'
      | 'CONFLICT'
      | 'TOO_LARGE'
      | 'BINARY',
  ) {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

export function isPathInsideWorkspace(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Normalize a user/agent supplied relative path. Throws on absolute or escaping input. */
export function normalizeRelativePath(relativePath: string): string {
  if (typeof relativePath !== 'string') {
    throw new WorkspaceAccessError('Path must be a string.', 'INVALID_PATH');
  }
  const trimmed = relativePath.trim();
  if (trimmed.includes('\0')) {
    throw new WorkspaceAccessError('Path contains a null byte.', 'INVALID_PATH');
  }
  if (!trimmed || trimmed === '.' || trimmed === './') return '';
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('\\\\')) {
    throw new WorkspaceAccessError(
      `Absolute paths are not allowed: ${trimmed}`,
      'INVALID_PATH',
    );
  }
  const normalized = path.normalize(trimmed).replace(/^([/\\])+/, '');
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw new WorkspaceAccessError(
      `Path escapes the workspace: ${trimmed}`,
      'OUTSIDE_WORKSPACE',
    );
  }
  return normalized;
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
  return current;
}

/**
 * Resolve a path inside a workspace, following the real path of existing
 * ancestors/symlinks and rejecting anything that lands outside.
 */
export async function resolveWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
  options: { mustExist?: boolean } = {},
): Promise<{ absolutePath: string; relativePath: string }> {
  const rootResolved = path.resolve(workspaceRoot);
  const rootStat = await fs.stat(rootResolved).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new WorkspaceAccessError(
      `Workspace folder does not exist: ${rootResolved}`,
      'MISSING',
    );
  }
  const realRoot = await fs.realpath(rootResolved);
  const normalized = normalizeRelativePath(relativePath);
  const absolute = normalized ? path.resolve(realRoot, normalized) : realRoot;
  if (!isPathInsideWorkspace(realRoot, absolute)) {
    throw new WorkspaceAccessError('Path escapes the workspace.', 'OUTSIDE_WORKSPACE');
  }

  const ancestor = await nearestExistingAncestor(absolute);
  const realAncestor = await fs.realpath(ancestor);
  if (!isPathInsideWorkspace(realRoot, realAncestor)) {
    throw new WorkspaceAccessError(
      'Path resolves outside the workspace through a symbolic link.',
      'OUTSIDE_WORKSPACE',
    );
  }

  if (options.mustExist !== false) {
    const exists = await fs.stat(absolute).catch(() => null);
    if (!exists) {
      throw new WorkspaceAccessError(`Path does not exist: ${normalized || '.'}`, 'MISSING');
    }
  }
  return { absolutePath: absolute, relativePath: normalized };
}
