/**
 * Fingerprints used to decide whether cached context is still valid.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

export interface ProjectContextFingerprintInput {
  instructions: string;
  memory: string;
  contextMaxChars: number;
  includeMemory: boolean;
  includeFileTree: boolean;
  mode: string;
}

export function projectContextFingerprint(input: ProjectContextFingerprintInput): string {
  return hashText(
    [
      input.instructions.length,
      hashText(input.instructions),
      input.memory.length,
      hashText(input.memory),
      input.contextMaxChars,
      input.includeMemory,
      input.includeFileTree,
      input.mode,
    ].join('|'),
  );
}

/**
 * Cheap file-tree fingerprint: root plus depth-2 directory mtimes. Mutations
 * made through the app invalidate the cache directly; this catches external
 * changes without walking the whole tree.
 */
export async function fileTreeFingerprint(workspacePath: string): Promise<string> {
  const parts: string[] = [];
  let rootStat;
  try {
    rootStat = await fs.stat(workspacePath);
  } catch {
    return 'missing-workspace';
  }
  parts.push(`root:${rootStat.mtimeMs}`);
  const depthOne = await readDirSafe(workspacePath);
  for (const entry of depthOne.slice(0, 80)) {
    if (!entry.isDirectory()) continue;
    const full = path.join(workspacePath, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    parts.push(`1:${entry.name}:${stat.mtimeMs}`);
    const depthTwo = await readDirSafe(full);
    for (const child of depthTwo.slice(0, 40)) {
      if (!child.isDirectory()) continue;
      const childFull = path.join(full, child.name);
      const childStat = await fs.stat(childFull).catch(() => null);
      if (!childStat) continue;
      parts.push(`2:${entry.name}/${child.name}:${childStat.mtimeMs}`);
    }
  }
  return hashText(parts.join('|'));
}

async function readDirSafe(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}
