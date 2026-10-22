/**
 * Filesystem tools. All paths are workspace-relative and validated by
 * WorkspaceService; diffs are captured for every mutation so the UI can show a
 * real before/after comparison.
 */
import { z } from 'zod';
import type { FileDiff } from '@shared/app-types';
import {
  type AnyToolDefinition,
  type ToolContext,
  ToolError,
  arrayParam,
  booleanParam,
  defineTool,
  deletePermission,
  numberParam,
  objectSchema,
  readOnlyPermission,
  stringParam,
  writePermission,
  type ToolRegistry,
} from '../../agent/tool-registry';

const MAX_MODEL_CONTENT = 120_000;
const MAX_DIFF_CHARS = 80_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function buildDiff(
  relativePath: string,
  before: string,
  after: string,
  changeType: FileDiff['changeType'],
): FileDiff {
  return {
    path: relativePath,
    before: before.slice(0, MAX_DIFF_CHARS),
    after: after.slice(0, MAX_DIFF_CHARS),
    changeType,
  };
}

async function readOrEmpty(ctx: ToolContext, relativePath: string): Promise<string> {
  try {
    const file = await ctx.services.workspace.readFile(ctx.project.workspacePath, relativePath);
    return file.isBinary ? '' : file.content;
  } catch {
    return '';
  }
}

export function registerFilesystemTools(registry: ToolRegistry): void {
  const listFiles = defineTool({
    name: 'list_files',
    description:
      'List files and folders inside the project workspace. Use this to inspect the project structure. Large generated folders (node_modules, .git, dist) are hidden unless includeIgnored is true.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 20000,
    inputSummary: 'relativePath?, includeIgnored?, maxEntries?',
    parameters: objectSchema(
      {
        relativePath: stringParam('Workspace-relative folder path. Omit or use "." for the project root.'),
        includeIgnored: booleanParam('Include normally ignored folders such as node_modules and .git.'),
        maxEntries: numberParam('Maximum entries to return (default 300).'),
      },
      [],
    ),
    inputSchema: z.object({
      relativePath: z.string().max(4096).optional(),
      includeIgnored: z.boolean().optional(),
      maxEntries: z.number().int().min(1).max(2000).optional(),
    }),
    summarize: (input) => ({
      summary: `List ${input.relativePath || 'the project root'}`,
      details: { relativePath: input.relativePath || '.' },
    }),
    permission: (input) => readOnlyPermission(`read:list:${input.relativePath ?? ''}`),
    async execute(input, ctx) {
      const entries = await ctx.services.workspace.list(
        ctx.project.workspacePath,
        input.relativePath ?? '',
        input.includeIgnored ?? false,
        input.maxEntries ?? 300,
      );
      if (entries.length === 0) {
        return {
          content: `Folder "${input.relativePath || '.'}" is empty or contains only ignored entries.`,
          summary: 'Folder is empty',
        };
      }
      const lines = entries.map((entry) =>
        entry.type === 'directory'
          ? `${entry.relativePath}/`
          : `${entry.relativePath}  (${formatBytes(entry.size ?? 0)})`,
      );
      return {
        content: `Contents of ${input.relativePath || '.'} (${entries.length} entries):\n${lines.join('\n')}`,
        summary: `Listed ${entries.length} entries in ${input.relativePath || '.'}`,
        meta: { entries: entries.length },
      };
    },
  });

  const readFile = defineTool({
    name: 'read_file',
    description:
      'Read a text file from the workspace. Returns the file content (optionally a 1-based line range). Binary files and files larger than 2 MB are reported instead of being inlined.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 20000,
    inputSummary: 'relativePath, startLine?, endLine?',
    parameters: objectSchema(
      {
        relativePath: stringParam('Workspace-relative file path.'),
        startLine: numberParam('Optional 1-based first line.', { minimum: 1 }),
        endLine: numberParam('Optional 1-based last line (inclusive).'),
      },
      ['relativePath'],
    ),
    inputSchema: z.object({
      relativePath: z.string().min(1).max(4096),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }),
    summarize: (input) => ({
      summary: `Read ${input.relativePath}`,
      details: { path: input.relativePath },
    }),
    permission: (input) => readOnlyPermission(`read:file:${input.relativePath}`, { path: input.relativePath }),
    async execute(input, ctx) {
      const file = await ctx.services.workspace.readFile(ctx.project.workspacePath, input.relativePath);
      if (file.isBinary) {
        throw new ToolError(`"${file.relativePath}" is a binary file (${formatBytes(file.size)}) and cannot be read as text.`);
      }
      let content = file.content;
      let note = '';
      if (input.startLine || input.endLine) {
        const lines = content.split(/\r?\n/);
        const start = Math.max(1, input.startLine ?? 1);
        const end = Math.min(lines.length, input.endLine ?? lines.length);
        if (start > end) throw new ToolError('startLine must be less than or equal to endLine.');
        content = lines.slice(start - 1, end).join('\n');
        note = `\n\n(lines ${start}-${end} of ${lines.length})`;
      }
      if (content.length > MAX_MODEL_CONTENT) {
        content = `${content.slice(0, MAX_MODEL_CONTENT)}\n\n[truncated at ${MAX_MODEL_CONTENT} characters; use startLine/endLine to read other parts]`;
      }
      if (file.truncated) {
        note += `\n\n(file is ${formatBytes(file.size)}; only the first 2 MB were loaded)`;
      }
      return {
        content: `File: ${file.relativePath} (${formatBytes(file.size)}, ${file.language})${note}\n\n${content}`,
        summary: `Read ${file.relativePath}`,
        details: { path: file.relativePath, language: file.language },
      };
    },
  });

  const readMultipleFiles = defineTool({
    name: 'read_multiple_files',
    description:
      'Read several workspace text files in one call. Prefer this over many separate read_file calls when inspecting related files.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 30000,
    inputSummary: 'paths (1-10)',
    parameters: objectSchema({ paths: arrayParam('Workspace-relative file paths.', { type: 'string' }) }, ['paths']),
    inputSchema: z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(10) }),
    summarize: (input) => ({ summary: `Read ${input.paths.length} files`, details: { paths: input.paths.join(', ') } }),
    permission: (input) =>
      readOnlyPermission(`read:multiple:${input.paths.join('|').slice(0, 500)}`, { files: String(input.paths.length) }),
    async execute(input, ctx) {
      const sections: string[] = [];
      let total = 0;
      for (const relativePath of input.paths) {
        if (total > MAX_MODEL_CONTENT) {
          sections.push(`--- ${relativePath}: skipped (combined content limit reached) ---`);
          continue;
        }
        try {
          const file = await ctx.services.workspace.readFile(ctx.project.workspacePath, relativePath);
          if (file.isBinary) {
            sections.push(`--- ${relativePath}: binary file (${formatBytes(file.size)}) ---`);
            continue;
          }
          const content = file.content.slice(0, Math.min(50000, MAX_MODEL_CONTENT - total));
          total += content.length;
          sections.push(`--- ${relativePath} (${formatBytes(file.size)}) ---\n${content}`);
        } catch (error) {
          sections.push(`--- ${relativePath}: ERROR ${(error as Error).message} ---`);
        }
      }
      return {
        content: sections.join('\n\n'),
        summary: `Read ${input.paths.length} files`,
        meta: { files: input.paths.length },
      };
    },
  });

  const createFile = defineTool({
    name: 'create_file',
    description:
      'Create a new text file in the workspace with the given content. Fails if the file already exists (use write_file to replace an existing file).',
    category: 'write',
    mutating: true,
    risk: 'low',
    modes: ['build'],
    timeoutMs: 20000,
    inputSummary: 'relativePath, content, createDirectories?',
    parameters: objectSchema(
      {
        relativePath: stringParam('Workspace-relative path of the new file.'),
        content: stringParam('Full file content.'),
        createDirectories: booleanParam('Create missing parent folders (default true).'),
      },
      ['relativePath', 'content'],
    ),
    inputSchema: z.object({
      relativePath: z.string().min(1).max(4096),
      content: z.string().max(2_000_000),
      createDirectories: z.boolean().optional(),
    }),
    summarize: (input) => ({
      summary: `Create ${input.relativePath}`,
      details: { path: input.relativePath, bytes: String(Buffer.byteLength(input.content, 'utf8')) },
    }),
    permission: (input) => writePermission('create_file', input.relativePath, 'Create a new file'),
    async execute(input, ctx) {
      const exists = await ctx.services.workspace
        .info(ctx.project.workspacePath, input.relativePath)
        .catch(() => null);
      if (exists) {
        throw new ToolError(`"${input.relativePath}" already exists. Use write_file or edit_file instead.`);
      }
      await ctx.services.workspace.writeFile(ctx.project.workspacePath, input.relativePath, input.content, {
        createDirectories: input.createDirectories ?? true,
      });
      ctx.invalidateContext('file-created');
      return {
        content: `Created ${input.relativePath} (${formatBytes(Buffer.byteLength(input.content, 'utf8'))}, ${input.content.split(/\r?\n/).length} lines).`,
        summary: `Created ${input.relativePath}`,
        diff: buildDiff(input.relativePath, '', input.content, 'created'),
        details: { path: input.relativePath },
      };
    },
  });

  const writeFile = defineTool({
    name: 'write_file',
    description:
      'Write (create or fully replace) a text file in the workspace. Prefer edit_file for small changes to existing files. Returns a diff.',
    category: 'write',
    mutating: true,
    risk: 'medium',
    modes: ['build'],
    timeoutMs: 20000,
    inputSummary: 'relativePath, content',
    parameters: objectSchema(
      {
        relativePath: stringParam('Workspace-relative file path.'),
        content: stringParam('Full new file content.'),
      },
      ['relativePath', 'content'],
    ),
    inputSchema: z.object({
      relativePath: z.string().min(1).max(4096),
      content: z.string().max(2_000_000),
    }),
    summarize: (input) => ({
      summary: `Write ${input.relativePath}`,
      details: { path: input.relativePath, bytes: String(Buffer.byteLength(input.content, 'utf8')) },
    }),
    permission: (input) => writePermission('write_file', input.relativePath, 'Write a file', {}, 'medium'),
    async execute(input, ctx) {
      const before = await readOrEmpty(ctx, input.relativePath);
      await ctx.services.workspace.writeFile(ctx.project.workspacePath, input.relativePath, input.content, {
        createDirectories: true,
      });
      ctx.invalidateContext('file-written');
      const changed = before !== input.content;
      return {
        content: `Wrote ${input.relativePath} (${formatBytes(Buffer.byteLength(input.content, 'utf8'))}, ${input.content.split(/\r?\n/).length} lines). ${changed ? 'Content changed.' : 'Content was identical.'}`,
        summary: `Wrote ${input.relativePath}`,
        diff: buildDiff(input.relativePath, before, input.content, before ? 'modified' : 'created'),
        details: { path: input.relativePath },
      };
    },
  });

  const editFile = defineTool({
    name: 'edit_file',
    description:
      'Edit an existing text file by replacing an exact snippet. oldText must match the file exactly (including indentation). By default it must occur exactly once. Use replaceAll to replace every occurrence.',
    category: 'write',
    mutating: true,
    risk: 'medium',
    modes: ['build'],
    timeoutMs: 20000,
    inputSummary: 'relativePath, oldText, newText, replaceAll?',
    parameters: objectSchema(
      {
        relativePath: stringParam('Workspace-relative file path.'),
        oldText: stringParam('Exact text to replace. Include enough context to be unique.'),
        newText: stringParam('Replacement text.'),
        replaceAll: booleanParam('Replace every occurrence (default false).'),
      },
      ['relativePath', 'oldText', 'newText'],
    ),
    inputSchema: z.object({
      relativePath: z.string().min(1).max(4096),
      oldText: z.string().min(1).max(500000),
      newText: z.string().max(500000),
      replaceAll: z.boolean().optional(),
    }),
    summarize: (input) => ({
      summary: `Edit ${input.relativePath}`,
      details: { path: input.relativePath },
    }),
    permission: (input) => writePermission('edit_file', input.relativePath, 'Edit a file', {}, 'medium'),
    async execute(input, ctx) {
      const file = await ctx.services.workspace.readFile(ctx.project.workspacePath, input.relativePath);
      if (file.isBinary) throw new ToolError(`"${input.relativePath}" is binary and cannot be edited as text.`);
      if (file.truncated) throw new ToolError(`"${input.relativePath}" is too large to edit safely in one call.`);
      const occurrences = file.content.split(input.oldText).length - 1;
      if (occurrences === 0) {
        throw new ToolError(
          'oldText was not found in the file. Read the file again and copy the exact snippet, including whitespace.',
        );
      }
      if (occurrences > 1 && !input.replaceAll) {
        throw new ToolError(
          `oldText occurs ${occurrences} times. Add more surrounding context to make it unique, or set replaceAll.`,
        );
      }
      const after = input.replaceAll
        ? file.content.split(input.oldText).join(input.newText)
        : file.content.replace(input.oldText, () => input.newText);
      await ctx.services.workspace.writeFile(ctx.project.workspacePath, input.relativePath, after, {
        expectedModifiedAt: file.modifiedAt,
      });
      ctx.invalidateContext('file-edited');
      return {
        content: `Edited ${input.relativePath}: replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} (${formatBytes(Buffer.byteLength(after, 'utf8'))} now).`,
        summary: `Edited ${input.relativePath}`,
        diff: buildDiff(input.relativePath, file.content, after, 'modified'),
        details: { path: input.relativePath },
      };
    },
  });

  const renameFile = defineTool({
    name: 'rename_file',
    description: 'Rename or move a file or folder inside the workspace. Fails if the destination already exists.',
    category: 'write',
    mutating: true,
    risk: 'medium',
    modes: ['build'],
    timeoutMs: 20000,
    inputSummary: 'fromRelativePath, toRelativePath',
    parameters: objectSchema(
      {
        fromRelativePath: stringParam('Current workspace-relative path.'),
        toRelativePath: stringParam('New workspace-relative path.'),
      },
      ['fromRelativePath', 'toRelativePath'],
    ),
    inputSchema: z.object({
      fromRelativePath: z.string().min(1).max(4096),
      toRelativePath: z.string().min(1).max(4096),
    }),
    summarize: (input) => ({
      summary: `Rename ${input.fromRelativePath} → ${input.toRelativePath}`,
      details: { from: input.fromRelativePath, to: input.toRelativePath },
    }),
    permission: (input) => ({
      ...writePermission('rename_file', input.toRelativePath, 'Rename or move', { from: input.fromRelativePath }, 'medium'),
      actionKey: `rename:${input.fromRelativePath}:${input.toRelativePath}`,
      alwaysKey: null,
      allowAlwaysLabel: null,
    }),
    async execute(input, ctx) {
      await ctx.services.workspace.rename(ctx.project.workspacePath, input.fromRelativePath, input.toRelativePath);
      ctx.invalidateContext('file-renamed');
      return {
        content: `Renamed ${input.fromRelativePath} to ${input.toRelativePath}.`,
        summary: `Renamed to ${input.toRelativePath}`,
        details: { from: input.fromRelativePath, to: input.toRelativePath },
      };
    },
  });

  const deleteFile = defineTool({
    name: 'delete_file',
    description:
      'Delete a file or folder. Deleting a non-empty folder requires recursive=true. This is destructive and always asks for confirmation; it cannot be undone from the app.',
    category: 'delete',
    mutating: true,
    risk: 'high',
    modes: ['build'],
    timeoutMs: 20000,
    inputSummary: 'relativePath, recursive?',
    parameters: objectSchema(
      {
        relativePath: stringParam('Workspace-relative path to delete.'),
        recursive: booleanParam('Required to delete a non-empty folder.'),
      },
      ['relativePath'],
    ),
    inputSchema: z.object({
      relativePath: z.string().min(1).max(4096),
      recursive: z.boolean().optional(),
    }),
    summarize: (input) => ({
      summary: `Delete ${input.relativePath}`,
      details: { path: input.relativePath, recursive: String(Boolean(input.recursive)) },
    }),
    permission: (input) =>
      deletePermission(input.relativePath, 'Delete from the workspace', Boolean(input.recursive)),
    async execute(input, ctx) {
      const info = await ctx.services.workspace.info(ctx.project.workspacePath, input.relativePath);
      const before = info.isFile ? await readOrEmpty(ctx, input.relativePath) : '';
      await ctx.services.workspace.delete(
        ctx.project.workspacePath,
        input.relativePath,
        input.recursive ?? false,
      );
      ctx.invalidateContext('file-deleted');
      return {
        content: `Deleted ${input.relativePath}${info.isDirectory ? ' (folder)' : ''}.`,
        summary: `Deleted ${input.relativePath}`,
        diff: info.isFile ? buildDiff(input.relativePath, before, '', 'deleted') : undefined,
        details: { path: input.relativePath },
      };
    },
  });

  const createDirectory = defineTool({
    name: 'create_directory',
    description: 'Create a new folder inside the workspace. Fails if it already exists.',
    category: 'write',
    mutating: true,
    risk: 'low',
    modes: ['build'],
    timeoutMs: 15000,
    inputSummary: 'relativePath',
    parameters: objectSchema({ relativePath: stringParam('Workspace-relative folder path.') }, ['relativePath']),
    inputSchema: z.object({ relativePath: z.string().min(1).max(4096) }),
    summarize: (input) => ({ summary: `Create folder ${input.relativePath}`, details: { path: input.relativePath } }),
    permission: (input) => writePermission('create_directory', input.relativePath, 'Create a folder'),
    async execute(input, ctx) {
      await ctx.services.workspace.createEntry(ctx.project.workspacePath, input.relativePath, 'directory');
      ctx.invalidateContext('directory-created');
      return { content: `Created folder ${input.relativePath}.`, summary: `Created folder ${input.relativePath}` };
    },
  });

  const searchFiles = defineTool({
    name: 'search_files',
    description: 'Find files by name (case-insensitive substring) inside the workspace.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 30000,
    inputSummary: 'query, maxResults?',
    parameters: objectSchema(
      {
        query: stringParam('Part of a file or folder name.'),
        maxResults: numberParam('Maximum matches (default 50).'),
      },
      ['query'],
    ),
    inputSchema: z.object({
      query: z.string().min(1).max(300),
      maxResults: z.number().int().min(1).max(200).optional(),
    }),
    summarize: (input) => ({ summary: `Find files named "${input.query}"`, details: { query: input.query } }),
    permission: (input) => readOnlyPermission(`search:files:${input.query}`),
    async execute(input, ctx) {
      const results = await ctx.services.workspace.searchFiles(
        ctx.project.workspacePath,
        input.query,
        input.maxResults ?? 50,
      );
      if (results.length === 0) {
        return { content: `No files matched "${input.query}".`, summary: 'No file matches' };
      }
      return {
        content: results.map((entry) => entry.relativePath).join('\n'),
        summary: `${results.length} matching files`,
        meta: { matches: results.length },
      };
    },
  });

  const getFileInfo = defineTool({
    name: 'get_file_info',
    description:
      'Get metadata for a workspace path: type, size, modification time, symlink and binary status.',
    category: 'read',
    mutating: false,
    risk: 'low',
    modes: ['plan', 'build'],
    timeoutMs: 15000,
    inputSummary: 'relativePath',
    parameters: objectSchema({ relativePath: stringParam('Workspace-relative path.') }, ['relativePath']),
    inputSchema: z.object({ relativePath: z.string().min(1).max(4096) }),
    summarize: (input) => ({ summary: `Info for ${input.relativePath}`, details: { path: input.relativePath } }),
    permission: (input) => readOnlyPermission(`read:info:${input.relativePath}`),
    async execute(input, ctx) {
      const info = await ctx.services.workspace.info(ctx.project.workspacePath, input.relativePath);
      const lines = [
        `path: ${info.relativePath}`,
        `type: ${info.isDirectory ? 'directory' : info.isFile ? 'file' : 'other'}`,
        `size: ${formatBytes(info.size)} (${info.size} bytes)`,
        `modified: ${info.modifiedAt}`,
        `symlink: ${info.isSymlink}`,
        `binary: ${info.isBinary}`,
      ];
      return {
        content: lines.join('\n'),
        summary: `${info.name}: ${info.isDirectory ? 'folder' : formatBytes(info.size)}`,
        details: { path: info.relativePath },
      };
    },
  });

  const tools: AnyToolDefinition[] = [
    listFiles,
    readFile,
    readMultipleFiles,
    createFile,
    writeFile,
    editFile,
    renameFile,
    deleteFile,
    createDirectory,
    searchFiles,
    getFileInfo,
  ];
  for (const tool of tools) registry.register(tool);
}
