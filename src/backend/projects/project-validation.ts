import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../util/errors';

export interface WorkspaceValidationOptions {
  /** Absolute data directory that must never be used as a workspace. */
  dataDirectory?: string;
  /** Create the folder (must be new or empty) instead of requiring it. */
  create?: boolean;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function validateProjectName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new AppError('Project name is required.', 'INVALID');
  if (name.length > 200) throw new AppError('Project name must be 200 characters or fewer.', 'INVALID');
  if (/[\u0000-\u001f]/.test(name)) throw new AppError('Project name contains control characters.', 'INVALID');
  return name;
}

export async function validateWorkspacePath(
  rawPath: string,
  options: WorkspaceValidationOptions = {},
): Promise<string> {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new AppError('Choose a project folder.', 'INVALID');
  if (!path.isAbsolute(trimmed)) {
    throw new AppError('The project folder must be an absolute path.', 'INVALID');
  }
  const resolved = path.resolve(trimmed);
  if (path.parse(resolved).root === resolved) {
    throw new AppError('A drive root cannot be used as a project folder.', 'INVALID');
  }
  if (options.dataDirectory) {
    if (isInside(resolved, options.dataDirectory) || isInside(options.dataDirectory, resolved)) {
      throw new AppError(
        'The project folder cannot overlap the application data directory. Choose a separate folder.',
        'ISOLATION',
      );
    }
  }

  const existing = await fs.stat(resolved).catch(() => null);
  if (options.create) {
    if (existing) {
      if (!existing.isDirectory()) throw new AppError('That path already exists and is not a folder.', 'CONFLICT');
      const entries = await fs.readdir(resolved);
      if (entries.length > 0) {
        throw new AppError('The folder already exists and is not empty. Choose another name.', 'CONFLICT');
      }
      return resolved;
    }
    const parent = path.dirname(resolved);
    const parentStat = await fs.stat(parent).catch(() => null);
    if (!parentStat || !parentStat.isDirectory()) {
      throw new AppError('The parent folder does not exist.', 'INVALID');
    }
    try {
      await fs.mkdir(resolved);
    } catch (error) {
      throw new AppError(`Could not create the project folder: ${(error as Error).message}`, 'STORAGE');
    }
    return resolved;
  }

  if (!existing) {
    throw new AppError(`The project folder does not exist: ${resolved}`, 'NOT_FOUND');
  }
  if (!existing.isDirectory()) {
    throw new AppError('The selected path is not a folder.', 'INVALID');
  }
  return resolved;
}

export function sameWorkspacePath(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}
