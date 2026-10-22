/**
 * Runtime validation for persisted data and IPC payloads.
 *
 * Persisted JSON is parsed with these schemas. A parse failure never silently
 * discards the file: the storage layer quarantines the damaged file and reports
 * a warning while attempting recovery from a backup.
 */
import { z } from 'zod';
import {
  type AppSettings,
  STORAGE_FORMAT_VERSION,
  type CustomToolDefinition,
} from './app-types';

const isoDate = z.string().min(1).max(64);
const safeId = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[A-Za-z0-9_-]+$/, 'Identifier may only contain letters, digits, "-" and "_"');

const nullableString = z.string().max(4096).nullable();

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const generationSettingsSchema = z.object({
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  numCtx: z.number().int().min(1024).max(1048576),
});

export const contextSettingsSchema = z.object({
  maxChars: z.number().int().min(4000).max(2000000),
  maxMessages: z.number().int().min(2).max(500),
  includeMemory: z.boolean(),
  includeFileTree: z.boolean(),
});

export const executionLimitsSchema = z.object({
  maxToolCallsPerTurn: z.number().int().min(1).max(200),
  maxModelIterations: z.number().int().min(1).max(100),
  maxRepeatedFailures: z.number().int().min(1).max(20),
  maxCommandMs: z.number().int().min(1000).max(3600000),
  maxOutputChars: z.number().int().min(1000).max(5000000),
  maxRunMs: z.number().int().min(10000).max(7200000),
  maxModelRetries: z.number().int().min(0).max(10),
});

export const permissionSettingsSchema = z.object({
  autoApproveReadOnly: z.boolean(),
  autoApproveFileWrites: z.boolean(),
  permissionTimeoutMs: z.number().int().min(5000).max(3600000),
});

export const layoutSettingsSchema = z.object({
  sidebarWidth: z.number().int().min(160).max(600),
  chatWidth: z.number().int().min(280).max(900),
  terminalHeight: z.number().int().min(120).max(900),
  terminalOpen: z.boolean(),
});

export const appSettingsSchema = z.object({
  formatVersion: z.number().int().min(1),
  theme: z.enum(['dark', 'light']),
  ollamaBaseUrl: z.string().url().max(2048),
  defaultModel: nullableString,
  generation: generationSettingsSchema,
  context: contextSettingsSchema,
  limits: executionLimitsSchema,
  permissions: permissionSettingsSchema,
  layout: layoutSettingsSchema,
  disabledTools: z.array(z.string().max(120)).max(500),
  recentProjectIds: z.array(safeId).max(100),
  lastProjectId: safeId.nullable(),
  lastChatByProject: z.record(z.string(), z.string()),
  showCacheDiagnostics: z.boolean(),
});

export type ValidatedAppSettings = z.infer<typeof appSettingsSchema>;

export function createDefaultSettings(): AppSettings {
  return {
    formatVersion: STORAGE_FORMAT_VERSION,
    theme: 'dark',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    defaultModel: null,
    generation: { temperature: 0.2, topP: 0.9, numCtx: 16384 },
    context: { maxChars: 60000, maxMessages: 24, includeMemory: true, includeFileTree: true },
    limits: {
      maxToolCallsPerTurn: 16,
      maxModelIterations: 8,
      maxRepeatedFailures: 3,
      maxCommandMs: 180000,
      maxOutputChars: 60000,
      maxRunMs: 900000,
      maxModelRetries: 2,
    },
    permissions: {
      autoApproveReadOnly: true,
      autoApproveFileWrites: true,
      permissionTimeoutMs: 300000,
    },
    layout: { sidebarWidth: 260, chatWidth: 420, terminalHeight: 240, terminalOpen: false },
    disabledTools: [],
    recentProjectIds: [],
    lastProjectId: null,
    lastChatByProject: {},
    showCacheDiagnostics: false,
  };
}

/** Merge validated partial settings over defaults (forward compatible). */
export function normalizeSettings(raw: unknown): AppSettings {
  const defaults = createDefaultSettings();
  const parsed = appSettingsSchema.partial().safeParse(raw);
  if (!parsed.success) return defaults;
  const value = parsed.data;
  return appSettingsSchema.parse({
    ...defaults,
    ...value,
    generation: { ...defaults.generation, ...(value.generation ?? {}) },
    context: { ...defaults.context, ...(value.context ?? {}) },
    limits: { ...defaults.limits, ...(value.limits ?? {}) },
    permissions: { ...defaults.permissions, ...(value.permissions ?? {}) },
    layout: { ...defaults.layout, ...(value.layout ?? {}) },
    formatVersion: STORAGE_FORMAT_VERSION,
  });
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export const projectSchema = z.object({
  id: safeId,
  name: z.string().min(1).max(200),
  workspacePath: z.string().min(1).max(4096),
  workspaceMissing: z.boolean().optional().default(false),
  createdAt: isoDate,
  updatedAt: isoDate,
  defaultModel: nullableString,
  chatIds: z.array(safeId).max(10000),
  taskIds: z.array(safeId).max(100000),
  planIds: z.array(safeId).max(10000),
  formatVersion: z.number().int().min(1),
});

export const storageManifestSchema = z.object({
  formatVersion: z.number().int().min(1),
  appVersion: z.string().min(1).max(64),
  createdAt: isoDate,
  updatedAt: isoDate,
  generation: z.number().int().min(1),
  projects: z.array(
    z.object({
      id: safeId,
      name: z.string().min(1).max(200),
      chatCount: z.number().int().min(0),
      updatedAt: isoDate,
    }),
  ),
});

/* ------------------------------------------------------------------ */
/* Chats                                                               */
/* ------------------------------------------------------------------ */

export const chatSchema = z.object({
  id: safeId,
  projectId: safeId,
  title: z.string().min(1).max(300),
  createdAt: isoDate,
  updatedAt: isoDate,
  mode: z.enum(['plan', 'build']),
  messageCount: z.number().int().min(0),
  status: z.enum(['idle', 'running', 'cancelled', 'error']),
  model: nullableString,
  currentPlanId: safeId.nullable(),
  formatVersion: z.number().int().min(1),
});

export const fileDiffSchema = z.object({
  path: z.string().max(4096),
  before: z.string().max(2000000),
  after: z.string().max(2000000),
  changeType: z.enum(['created', 'modified', 'deleted']),
});

export const toolCallRecordSchema = z.object({
  id: safeId,
  name: z.string().min(1).max(120),
  args: z.unknown(),
  status: z.enum([
    'pending',
    'awaiting_permission',
    'running',
    'success',
    'error',
    'denied',
    'cancelled',
  ]),
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
  durationMs: z.number().min(0).nullable(),
  result: z.string().max(2000000).nullable(),
  error: z.string().max(200000).nullable(),
  permission: z.enum(['auto', 'once', 'project', 'denied']).nullable(),
  risk: z.enum(['low', 'medium', 'high']),
  summary: z.string().max(4000),
  details: z.record(z.string(), z.string()),
  diff: fileDiffSchema.nullable(),
});

export const contextReportSchema = z.object({
  budgetChars: z.number().int(),
  usedChars: z.number().int(),
  estimatedTokens: z.number().int(),
  messagesIncluded: z.number().int(),
  messagesDropped: z.number().int(),
  memoryIncluded: z.boolean(),
  instructionsIncluded: z.boolean(),
  fileTreeIncluded: z.boolean(),
  truncated: z.boolean(),
  cache: z.enum(['hit', 'miss', 'partial']),
  notes: z.array(z.string()),
});

export const chatMessageSchema = z.object({
  id: safeId,
  chatId: safeId,
  projectId: safeId,
  role: z.enum(['user', 'assistant']),
  content: z.string().max(4000000),
  createdAt: isoDate,
  mode: z.enum(['plan', 'build']),
  model: nullableString,
  toolCalls: z.array(toolCallRecordSchema).max(500).default([]),
  contextReport: contextReportSchema.nullable().default(null),
  error: z.string().max(200000).nullable().default(null),
  interrupted: z.boolean().default(false),
});

/* ------------------------------------------------------------------ */
/* Plans and tasks                                                     */
/* ------------------------------------------------------------------ */

export const taskSchema = z.object({
  id: safeId,
  projectId: safeId,
  chatId: safeId,
  planId: safeId,
  index: z.number().int().min(0).max(1000),
  title: z.string().min(1).max(400),
  description: z.string().max(20000),
  files: z.array(z.string().max(4096)).max(200),
  acceptanceCriteria: z.array(z.string().max(4000)).max(50),
  tests: z.array(z.string().max(4000)).max(50),
  risk: z.string().max(4000),
  status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']),
  notes: z.string().max(20000),
  evidence: z.array(z.string().max(20000)).max(100),
  createdAt: isoDate,
  updatedAt: isoDate,
  startedAt: isoDate.nullable(),
  completedAt: isoDate.nullable(),
});

export const planSchema = z.object({
  id: safeId,
  projectId: safeId,
  chatId: safeId,
  title: z.string().min(1).max(400),
  summary: z.string().max(20000),
  approach: z.string().max(60000),
  requirements: z.array(z.string().max(4000)).max(50),
  risks: z.array(z.string().max(4000)).max(50),
  taskIds: z.array(safeId).max(1000),
  status: z.enum(['draft', 'approved', 'rejected', 'in_progress', 'completed', 'cancelled']),
  createdAt: isoDate,
  updatedAt: isoDate,
  approvedAt: isoDate.nullable(),
});

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

export const permissionRecordSchema = z.object({
  id: safeId,
  projectId: safeId,
  category: z.enum(['read', 'write', 'delete', 'execute', 'git', 'memory', 'custom']),
  toolName: z.string().min(1).max(120),
  actionKey: z.string().min(1).max(4000),
  label: z.string().max(400),
  scope: z.literal('project'),
  createdAt: isoDate,
  expiresAt: isoDate.nullable(),
  policyVersion: z.number().int().min(1),
});

export const permissionFileSchema = z.object({
  projectId: safeId,
  policyVersion: z.number().int().min(1),
  records: z.array(permissionRecordSchema).max(2000),
});

/* ------------------------------------------------------------------ */
/* Custom tools                                                        */
/* ------------------------------------------------------------------ */

export const customToolSchema = z.object({
  name: z
    .string()
    .min(3)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, digits and underscores'),
  description: z.string().min(10).max(1000),
  command: z.string().min(1).max(4000),
  category: z.literal('execute'),
  parameters: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
        description: z.string().min(1).max(400),
        required: z.boolean(),
      }),
    )
    .max(20),
  createdAt: isoDate,
  approvedAt: isoDate.nullable(),
  approved: z.boolean(),
});

/* ------------------------------------------------------------------ */
/* IPC input schemas                                                   */
/* ------------------------------------------------------------------ */

export const projectIdInput = z.object({ projectId: safeId });
export const projectChatInput = z.object({ projectId: safeId, chatId: safeId });

export const createProjectInput = z.object({
  name: z.string().trim().min(1).max(200),
  workspacePath: z.string().min(1).max(4096),
  createWorkspace: z.boolean().default(false),
  initializeGit: z.boolean().default(false),
});

export const updateProjectInput = z.object({
  projectId: safeId,
  name: z.string().trim().min(1).max(200).optional(),
  workspacePath: z.string().min(1).max(4096).optional(),
  defaultModel: z.string().max(300).nullable().optional(),
});

export const listDirectoryInput = z.object({
  projectId: safeId,
  relativePath: z.string().max(4096).default(''),
  includeIgnored: z.boolean().default(false),
});

export const readFileInput = z.object({
  projectId: safeId,
  relativePath: z.string().min(1).max(4096),
});

export const writeFileInput = z.object({
  projectId: safeId,
  relativePath: z.string().min(1).max(4096),
  content: z.string().max(4000000),
  expectedModifiedAt: z.string().max(64).optional(),
  createDirectories: z.boolean().default(false),
});

export const createEntryInput = z.object({
  projectId: safeId,
  relativePath: z.string().min(1).max(4096),
  type: z.enum(['file', 'directory']),
});

export const renameEntryInput = z.object({
  projectId: safeId,
  fromRelativePath: z.string().min(1).max(4096),
  toRelativePath: z.string().min(1).max(4096),
});

export const deleteEntryInput = z.object({
  projectId: safeId,
  relativePath: z.string().min(1).max(4096),
  recursive: z.boolean().default(false),
});

export const searchFilesInput = z.object({
  projectId: safeId,
  query: z.string().min(1).max(300),
  maxResults: z.number().int().min(1).max(200).default(50),
});

export const grepInput = z.object({
  projectId: safeId,
  query: z.string().min(1).max(500),
  relativePath: z.string().max(4096).default(''),
  isRegex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(500).default(100),
});

export const gitCommandInput = z.object({
  projectId: safeId,
  relativePath: z.string().max(4096).optional(),
});

export const createChatInput = z.object({
  projectId: safeId,
  title: z.string().trim().max(300).optional(),
  mode: z.enum(['plan', 'build']).default('build'),
});

export const updateChatInput = z.object({
  projectId: safeId,
  chatId: safeId,
  title: z.string().trim().min(1).max(300).optional(),
  mode: z.enum(['plan', 'build']).optional(),
});

export const saveMemoryInput = z.object({
  projectId: safeId,
  content: z.string().max(200000),
});

export const saveInstructionsInput = z.object({
  projectId: safeId,
  content: z.string().max(200000),
});

export const planInput = z.object({
  projectId: safeId,
  planId: safeId,
});

export const taskUpdateInput = z.object({
  projectId: safeId,
  taskId: safeId,
  status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']),
  notes: z.string().max(20000).optional(),
  evidence: z.array(z.string().max(20000)).max(100).optional(),
});

export const startAgentInput = z.object({
  projectId: safeId,
  chatId: safeId,
  prompt: z.string().min(1).max(200000),
  mode: z.enum(['plan', 'build']),
});

export const cancelRunInput = z.object({ runId: safeId });

export const permissionResponseInput = z.object({
  requestId: safeId,
  decision: z.enum(['allow_once', 'always_allow', 'deny']),
});

export const permissionRevokeInput = z.object({
  projectId: safeId,
  recordId: safeId,
});

export const saveSettingsInput = z.object({
  patch: appSettingsSchema
    .partial()
    .refine((value) => Object.keys(value).length > 0, 'Settings patch is empty'),
});

export const setToolEnabledInput = z.object({
  toolName: z.string().min(1).max(120),
  enabled: z.boolean(),
});

export const addCustomToolInput = z.object({
  name: customToolSchema.shape.name,
  description: customToolSchema.shape.description,
  command: customToolSchema.shape.command,
  parameters: customToolSchema.shape.parameters,
});

export const customToolNameInput = z.object({ name: z.string().min(1).max(120) });

export const terminalCreateInput = z.object({
  projectId: safeId,
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
});

export const terminalInput = z.object({
  sessionId: safeId,
  data: z.string().max(100000),
});

export const terminalSessionInput = z.object({ sessionId: safeId });

export const providerTestInput = z.object({
  model: z.string().min(1).max(300),
});

export const providerPullInput = z.object({
  model: z.string().min(1).max(300),
});

export const backupRestoreInput = z.object({
  backupId: safeId,
});

export const backupExportInput = z.object({
  targetDirectory: z.string().min(1).max(4096),
});

export const moveDataInput = z.object({
  targetDirectory: z.string().min(1).max(4096),
  confirm: z.literal(true),
});

export const projectIdString = safeId;

export function parseCustomToolDefinition(raw: unknown): CustomToolDefinition {
  return customToolSchema.parse(raw);
}
