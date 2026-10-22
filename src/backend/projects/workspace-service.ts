/**
 * Real workspace operations: listing, reading, writing, searching and
 * metadata. Every entry point resolves paths through the workspace safety
 * layer, and large/binary files are never silently loaded into the editor.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  FileContent,
  FileEntry,
  FileInfo,
  FileSearchResult,
  GrepResult,
  SearchMatch,
  WorkspaceInfo,
} from '@shared/app-types';
import type { Logger } from '../logging/logger';
import { WorkspaceAccessError, resolveWorkspacePath } from '../projects/path-safety';

export const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'out',
  'release',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'target',
  '.gradle',
  '.idea',
  'bower_components',
  '.mypy_cache',
  '.pytest_cache',
]);

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.avif',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi', '.mkv', '.flac',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.bz2', '.xz', '.zst',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.pak', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.sqlite', '.db', '.pyc', '.class', '.jar', '.o', '.obj', '.a', '.lib',
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.json': 'json', '.jsonc': 'json', '.json5': 'json',
  '.md': 'markdown', '.mdx': 'markdown', '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.html': 'html', '.htm': 'html', '.xml': 'xml', '.svg': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'ini', '.ini': 'ini', '.env': 'ini', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.ps1': 'powershell', '.psm1': 'powershell', '.bat': 'bat', '.cmd': 'bat',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.php': 'php', '.swift': 'swift', '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
  '.dockerfile': 'dockerfile', '.vue': 'html', '.svelte': 'html', '.txt': 'plaintext',
};

const MAX_TEXT_BYTES = 2_000_000;
const MAX_WRITE_BYTES = 4_000_000;
const MAX_WALK_FILES = 20_000;
const MAX_GREP_FILES = 4_000;
const MAX_GREP_FILE_BYTES = 1_000_000;

export function detectLanguage(relativePath: string): string {
  const base = path.basename(relativePath).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  if (base.startsWith('.env')) return 'ini';
  return LANGUAGE_BY_EXTENSION[path.extname(base)] ?? 'plaintext';
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function hasBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function canWalk(directory: string, includeIgnored: boolean): boolean {
  if (includeIgnored) return true;
  return !IGNORED_DIRECTORIES.has(directory.toLowerCase());
}

export class WorkspaceService {
  constructor(private readonly logger: Logger) {}

  async list(
    workspacePath: string,
    relativePath: string,
    includeIgnored = false,
    maxEntries = 5000,
  ): Promise<FileEntry[]> {
    const resolved = await resolveWorkspacePath(workspacePath, relativePath, { mustExist: true });
    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isDirectory()) {
      throw new WorkspaceAccessError('Not a directory.', 'NOT_A_DIRECTORY');
    }
    const entries = await fs.readdir(resolved.absolutePath, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (result.length >= maxEntries) break;
      if (!includeIgnored) {
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        if (IGNORED_FILES.has(entry.name)) continue;
      }
      const childRelative = resolved.relativePath
        ? `${resolved.relativePath}/${entry.name}`
        : entry.name;
      let size: number | null = null;
      let modifiedAt: string | null = null;
      try {
        const childStat = await fs.stat(path.join(resolved.absolutePath, entry.name));
        modifiedAt = childStat.mtime.toISOString();
        size = entry.isDirectory() ? null : childStat.size;
      } catch {
        /* unreadable entry: still list the name */
      }
      result.push({
        name: entry.name,
        relativePath: toPosixPath(childRelative),
        type: entry.isDirectory() ? 'directory' : 'file',
        size,
        modifiedAt,
      });
    }
    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  async readFile(workspacePath: string, relativePath: string): Promise<FileContent> {
    const resolved = await resolveWorkspacePath(workspacePath, relativePath, { mustExist: true });
    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isFile()) throw new WorkspaceAccessError('Not a file.', 'NOT_A_FILE');
    const language = detectLanguage(resolved.relativePath);
    if (hasBinaryExtension(resolved.relativePath)) {
      return {
        relativePath: resolved.relativePath,
        content: '',
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        isBinary: true,
        truncated: false,
        language,
      };
    }
    const handle = await fs.open(resolved.absolutePath, 'r');
    try {
      const length = Math.min(stat.size, MAX_TEXT_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      if (isProbablyBinary(buffer)) {
        return {
          relativePath: resolved.relativePath,
          content: '',
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          isBinary: true,
          truncated: false,
          language,
        };
      }
      return {
        relativePath: resolved.relativePath,
        content: buffer.toString('utf8'),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        isBinary: false,
        truncated: stat.size > MAX_TEXT_BYTES,
        language,
      };
    } finally {
      await handle.close();
    }
  }

  async writeFile(
    workspacePath: string,
    relativePath: string,
    content: string,
    options: { expectedModifiedAt?: string; createDirectories?: boolean } = {},
  ): Promise<FileInfo> {
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
      throw new WorkspaceAccessError(
        `Refusing to write ${Buffer.byteLength(content, 'utf8')} bytes; the limit is ${MAX_WRITE_BYTES}.`,
        'TOO_LARGE',
      );
    }
    const resolved = await resolveWorkspacePath(workspacePath, relativePath, { mustExist: false });
    const parent = path.dirname(resolved.absolutePath);
    if (options.createDirectories) {
      await fs.mkdir(parent, { recursive: true });
    } else {
      const parentStat = await fs.stat(parent).catch(() => null);
      if (!parentStat || !parentStat.isDirectory()) {
        throw new WorkspaceAccessError(`Parent directory does not exist: ${toPosixPath(path.dirname(resolved.relativePath))}`, 'MISSING');
      }
    }
    if (options.expectedModifiedAt) {
      const existing = await fs.stat(resolved.absolutePath).catch(() => null);
      if (existing) {
        if (Math.abs(existing.mtimeMs - new Date(options.expectedModifiedAt).getTime()) > 1500) {
          throw new WorkspaceAccessError(
            'The file changed on disk since it was opened. Reopen it before saving to avoid overwriting newer content.',
            'CONFLICT',
          );
        }
      }
    }
    await fs.writeFile(resolved.absolutePath, content, 'utf8');
    this.logger.debug('workspace', 'File written', {
      relativePath: resolved.relativePath,
      bytes: Buffer.byteLength(content, 'utf8'),
    });
    return this.info(workspacePath, relativePath);
  }

  async createEntry(
    workspacePath: string,
    relativePath: string,
    type: 'file' | 'directory',
  ): Promise<FileEntry> {
    const resolved = await resolveWorkspacePath(workspacePath, relativePath, { mustExist: false });
    if (await fs.stat(resolved.absolutePath).catch(() => null)) {
      throw new WorkspaceAccessError('An entry with that name already exists.', 'CONFLICT');
    }
    const parent = path.dirname(resolved.absolutePath);
    const parentStat = await fs.stat(parent).catch(() => null);
    if (!parentStat || !parentStat.isDirectory()) {
      throw new WorkspaceAccessError('Parent directory does not exist.', 'MISSING');
    }
    if (type === 'directory') await fs.mkdir(resolved.absolutePath);
    else await fs.writeFile(resolved.absolutePath, '', { flag: 'wx' });
    const stat = await fs.stat(resolved.absolutePath);
    return {
      name: path.basename(resolved.absolutePath),
      relativePath: toPosixPath(resolved.relativePath),
      type,
      size: type === 'file' ? stat.size : null,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  async rename(
    workspacePath: string,
    fromRelativePath: string,
    toRelativePath: string,
  ): Promise<FileEntry> {
    const from = await resolveWorkspacePath(workspacePath, fromRelativePath, { mustExist: true });
    const to = await resolveWorkspacePath(workspacePath, toRelativePath, { mustExist: false });
    if (await fs.stat(to.absolutePath).catch(() => null)) {
      throw new WorkspaceAccessError('The destination already exists.', 'CONFLICT');
    }
    const parentStat = await fs.stat(path.dirname(to.absolutePath)).catch(() => null);
    if (!parentStat || !parentStat.isDirectory()) {
      throw new WorkspaceAccessError('The destination folder does not exist.', 'MISSING');
    }
    await fs.rename(from.absolutePath, to.absolutePath);
    const stat = await fs.stat(to.absolutePath);
    return {
      name: path.basename(to.absolutePath),
      relativePath: toPosixPath(to.relativePath),
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.isFile() ? stat.size : null,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  async delete(workspacePath: string, relativePath: string, recursive = false): Promise<void> {
    const resolved = await resolveWorkspacePath(workspacePath, relativePath, { mustExist: true });
    if (resolved.relativePath === '') {
      throw new WorkspaceAccessError('Refusing to delete the workspace root.', 'INVALID_PATH');
    }
    const stat = await fs.stat(resolved.absolutePath);
    if (stat.isDirectory() && !recursive) {
      const entries = await fs.readdir(resolved.absolutePath);
      if (entries.length > 0) {
        throw new WorkspaceAccessError(
          'The folder is not empty. Confirmed recursive deletion is required.',
          'CONFLICT',
        );
      }
    }
    await fs.rm(resolved.absolutePath, { recursive, force: false });
    this.logger.warn('workspace', 'Entry deleted', { relativePath: resolved.relativePath, recursive });
  }

  async info(workspacePath: string, relativePath: string): Promise<FileInfo> {
    const resolved = await resolveWorkspacePath(workspacePath, relativePath, { mustExist: true });
    const lstat = await fs.lstat(resolved.absolutePath);
    const stat = await fs.stat(resolved.absolutePath);
    let isBinary = hasBinaryExtension(resolved.relativePath);
    if (!isBinary && stat.isFile() && stat.size > 0) {
      const handle = await fs.open(resolved.absolutePath, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, 8192));
        await handle.read(buffer, 0, buffer.length, 0);
        isBinary = isProbablyBinary(buffer);
      } finally {
        await handle.close();
      }
    }
    return {
      relativePath: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      name: path.basename(resolved.absolutePath),
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymlink: lstat.isSymbolicLink(),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      isBinary,
      truncated: stat.isFile() && stat.size > MAX_TEXT_BYTES,
    };
  }

  /** Walk the workspace honoring ignore rules; returns relative POSIX paths. */
  private async walk(
    root: string,
    options: { includeIgnored?: boolean; maxFiles?: number; startRelative?: string },
  ): Promise<string[]> {
    const files: string[] = [];
    const maxFiles = options.maxFiles ?? MAX_WALK_FILES;
    const start = await resolveWorkspacePath(root, options.startRelative ?? '', { mustExist: true });
    const stack: Array<{ absolute: string; relative: string; depth: number }> = [
      { absolute: start.absolutePath, relative: start.relativePath, depth: 0 },
    ];
    while (stack.length > 0 && files.length < maxFiles) {
      const current = stack.pop()!;
      if (current.depth > 24) continue;
      let entries;
      try {
        entries = await fs.readdir(current.absolute, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        if (!options.includeIgnored) {
          if (entry.isDirectory() && !canWalk(entry.name, false)) continue;
          if (IGNORED_FILES.has(entry.name)) continue;
        }
        const childAbsolute = path.join(current.absolute, entry.name);
        const childRelative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          stack.push({ absolute: childAbsolute, relative: childRelative, depth: current.depth + 1 });
        } else if (entry.isFile()) {
          files.push(childRelative);
        }
      }
    }
    return files;
  }

  async searchFiles(root: string, query: string, maxResults = 50): Promise<FileSearchResult[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const files = await this.walk(root, { maxFiles: 12000 });
    const scored = files.map((relativePath) => {
      const name = relativePath.split('/').pop() ?? relativePath;
      const lower = name.toLowerCase();
      const full = relativePath.toLowerCase();
      let score = 0;
      if (lower === needle) score = 100;
      else if (lower.startsWith(needle)) score = 70;
      else if (lower.includes(needle)) score = 50;
      else if (full.includes(needle)) score = 30;
      return { relativePath, name, score };
    });
    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      .slice(0, maxResults)
      .map((entry) => ({ relativePath: entry.relativePath, name: entry.name, type: 'file' as const }));
  }

  async grep(
    root: string,
    query: string,
    options: { relativePath?: string; isRegex?: boolean; caseSensitive?: boolean; maxResults?: number } = {},
  ): Promise<GrepResult> {
    const maxResults = options.maxResults ?? 100;
    const needle = query;
    let matcher: RegExp;
    try {
      const source = options.isRegex ? needle : needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matcher = new RegExp(source, options.caseSensitive ? 'g' : 'gi');
    } catch (error) {
      throw new WorkspaceAccessError(`Invalid search pattern: ${(error as Error).message}`, 'INVALID_PATH');
    }
    const files = await this.walk(root, {
      maxFiles: MAX_GREP_FILES,
      startRelative: options.relativePath ?? '',
    });
    const matches: SearchMatch[] = [];
    let scannedFiles = 0;
    let truncated = false;
    for (const relativePath of files) {
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      if (hasBinaryExtension(relativePath)) continue;
      const absolute = path.join(root, relativePath);
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_GREP_FILE_BYTES) continue;
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(absolute);
      } catch {
        continue;
      }
      if (isProbablyBinary(buffer)) continue;
      scannedFiles += 1;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        matcher.lastIndex = 0;
        const match = matcher.exec(line);
        if (!match) continue;
        matches.push({
          relativePath,
          line: index + 1,
          column: match.index + 1,
          text: line.length > 400 ? `${line.slice(0, 400)}…` : line,
        });
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
      }
    }
    return { matches, truncated, scannedFiles, engine: 'builtin' };
  }

  async workspaceInfo(workspacePath: string): Promise<WorkspaceInfo> {
    const root = path.resolve(workspacePath);
    const stat = await fs.stat(root).catch(() => null);
    const missing = !stat || !stat.isDirectory();
    const info: WorkspaceInfo = {
      workspacePath: root,
      missing,
      isGitRepository: false,
      gitBranch: null,
      packageManager: null,
      scripts: {},
      languages: [],
    };
    if (missing) return info;

    try {
      const gitDir = path.join(root, '.git');
      const gitStat = await fs.stat(gitDir).catch(() => null);
      info.isGitRepository = Boolean(gitStat);
      if (gitStat?.isDirectory()) {
        const head = await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => '');
        const match = head.match(/ref:\s+refs\/heads\/(.+)/);
        info.gitBranch = match ? match[1].trim() : head.trim() || null;
      } else if (gitStat?.isFile()) {
        const pointer = await fs.readFile(gitDir, 'utf8').catch(() => '');
        const match = pointer.match(/gitdir:\s*(.+)/);
        if (match) {
          const head = await fs
            .readFile(path.join(root, match[1].trim(), 'HEAD'), 'utf8')
            .catch(() => '');
          const branch = head.match(/ref:\s+refs\/heads\/(.+)/);
          info.gitBranch = branch ? branch[1].trim() : null;
        }
      }
    } catch {
      /* git metadata is best effort */
    }

    const lockfiles: Array<[string, 'npm' | 'pnpm' | 'yarn']> = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
    ];
    for (const [lockfile, manager] of lockfiles) {
      if (await fs.stat(path.join(root, lockfile)).catch(() => null)) {
        info.packageManager = manager;
        break;
      }
    }

    try {
      const packageRaw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
      const parsed = JSON.parse(packageRaw) as { scripts?: Record<string, string> };
      if (parsed.scripts && typeof parsed.scripts === 'object') {
        info.scripts = parsed.scripts;
      }
      info.packageManager = info.packageManager ?? 'npm';
    } catch {
      /* no package.json */
    }

    try {
      const files = await this.walk(root, { maxFiles: 800 });
      const counts = new Map<string, number>();
      for (const file of files) {
        const extension = path.extname(file).toLowerCase();
        if (!extension) continue;
        counts.set(extension, (counts.get(extension) ?? 0) + 1);
      }
      info.languages = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([extension, count]) => `${extension} (${count})`);
    } catch {
      /* best effort */
    }
    return info;
  }

  /** Compact directory tree used in the model context (never the whole tree). */
  async fileTreeSummary(workspacePath: string, maxEntries = 120): Promise<string> {
    const root = path.resolve(workspacePath);
    const lines: string[] = [];
    const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
      if (lines.length >= maxEntries || depth > 2) return;
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      const filtered = entries
        .filter((entry) => {
          if (entry.isDirectory()) return canWalk(entry.name, false);
          return !IGNORED_FILES.has(entry.name);
        })
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 40);
      for (const entry of filtered) {
        if (lines.length >= maxEntries) return;
        lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory()) {
          await walk(path.join(directory, entry.name), `${prefix}${entry.name}/`, depth + 1);
        }
      }
    };
    await walk(root, '', 0);
    if (lines.length >= maxEntries) lines.push('… (tree truncated)');
    return lines.join('\n');
  }

  /** Read a text file outside the safety layer is never allowed; helper for tools. */
  async readTextFile(workspacePath: string, relativePath: string): Promise<string> {
    const file = await this.readFile(workspacePath, relativePath);
    if (file.isBinary) {
      throw new WorkspaceAccessError(`Cannot read binary file as text: ${relativePath}`, 'BINARY');
    }
    return file.content;
  }
}
