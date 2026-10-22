/**
 * Shared application types used by the Electron main process, the backend
 * services, the preload bridge and the React renderer.
 *
 * These types are the single source of truth for persisted data and for IPC.
 * Runtime validation lives in ./validation.ts.
 */

export const APP_NAME = 'Local AI Editor';
export const APP_DATA_DIR_NAME = 'LocalAIEditorData';
export const STORAGE_FORMAT_VERSION = 3;
export const PERMISSION_POLICY_VERSION = 1;

export type AppTheme = 'dark' | 'light';
export type AgentMode = 'plan' | 'build';

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface GenerationSettings {
  temperature: number;
  topP: number;
  numCtx: number;
}

export interface ContextSettings {
  /** Character budget for the project/chat context sent to the model. */
  maxChars: number;
  /** Maximum number of recent chat messages included verbatim. */
  maxMessages: number;
  includeMemory: boolean;
  includeFileTree: boolean;
}

export interface ExecutionLimits {
  maxToolCallsPerTurn: number;
  maxModelIterations: number;
  maxRepeatedFailures: number;
  maxCommandMs: number;
  maxOutputChars: number;
  maxRunMs: number;
  maxModelRetries: number;
}

export interface PermissionSettings {
  autoApproveReadOnly: boolean;
  autoApproveFileWrites: boolean;
  /** How long a permission prompt waits for a user answer before denying. */
  permissionTimeoutMs: number;
}

export interface LayoutSettings {
  sidebarWidth: number;
  chatWidth: number;
  terminalHeight: number;
  terminalOpen: boolean;
}

export interface AppSettings {
  formatVersion: number;
  theme: AppTheme;
  ollamaBaseUrl: string;
  defaultModel: string | null;
  generation: GenerationSettings;
  context: ContextSettings;
  limits: ExecutionLimits;
  permissions: PermissionSettings;
  layout: LayoutSettings;
  disabledTools: string[];
  recentProjectIds: string[];
  lastProjectId: string | null;
  lastChatByProject: Record<string, string>;
  showCacheDiagnostics: boolean;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export interface StorageManifest {
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  updatedAt: string;
  generation: number;
  projects: ManifestProject[];
}

export interface ManifestProject {
  id: string;
  name: string;
  chatCount: number;
  updatedAt: string;
}

export interface DataStorageInfo {
  dataDirectory: string;
  sizeBytes: number;
  freeBytes: number | null;
  backupCount: number;
  latestBackup: BackupInfo | null;
  manifest: StorageManifest | null;
  writable: boolean;
}

export interface BackupInfo {
  id: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  label: string;
  verified: boolean;
  fileCount: number;
}

export interface RelocationResult {
  previousDirectory: string;
  newDirectory: string;
  copiedFiles: number;
  copiedBytes: number;
  verified: boolean;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export interface Project {
  id: string;
  name: string;
  workspacePath: string;
  workspaceMissing: boolean;
  createdAt: string;
  updatedAt: string;
  defaultModel: string | null;
  chatIds: string[];
  taskIds: string[];
  planIds: string[];
  formatVersion: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  workspacePath: string;
  workspaceMissing: boolean;
  chatCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface ProjectInstructions {
  content: string;
  updatedAt: string | null;
}

export interface ProjectMemory {
  content: string;
  updatedAt: string | null;
}

export interface WorkspaceInfo {
  workspacePath: string;
  missing: boolean;
  isGitRepository: boolean;
  gitBranch: string | null;
  packageManager: 'npm' | 'pnpm' | 'yarn' | null;
  scripts: Record<string, string>;
  languages: string[];
}

/* ------------------------------------------------------------------ */
/* Chats and messages                                                  */
/* ------------------------------------------------------------------ */

export type ChatStatus = 'idle' | 'running' | 'cancelled' | 'error';

export interface Chat {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  mode: AgentMode;
  messageCount: number;
  status: ChatStatus;
  model: string | null;
  currentPlanId: string | null;
  formatVersion: number;
}

export interface ChatSummary {
  id: string;
  projectId: string;
  title: string;
  mode: AgentMode;
  messageCount: number;
  updatedAt: string;
  status: ChatStatus;
}

export type ChatRole = 'user' | 'assistant';

export type ToolCallStatus =
  | 'pending'
  | 'awaiting_permission'
  | 'running'
  | 'success'
  | 'error'
  | 'denied'
  | 'cancelled';

export interface ToolCallRecord {
  id: string;
  name: string;
  args: unknown;
  status: ToolCallStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  result: string | null;
  error: string | null;
  permission: 'auto' | 'once' | 'project' | 'denied' | null;
  risk: PermissionRisk;
  summary: string;
  details: Record<string, string>;
  diff: FileDiff | null;
}

export interface FileDiff {
  path: string;
  before: string;
  after: string;
  changeType: 'created' | 'modified' | 'deleted';
}

export interface ChatMessage {
  id: string;
  chatId: string;
  projectId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  mode: AgentMode;
  model: string | null;
  toolCalls: ToolCallRecord[];
  contextReport: ContextReport | null;
  error: string | null;
  interrupted: boolean;
}

export interface ContextReport {
  budgetChars: number;
  usedChars: number;
  estimatedTokens: number;
  messagesIncluded: number;
  messagesDropped: number;
  memoryIncluded: boolean;
  instructionsIncluded: boolean;
  fileTreeIncluded: boolean;
  truncated: boolean;
  cache: 'hit' | 'miss' | 'partial';
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Plans and tasks                                                     */
/* ------------------------------------------------------------------ */

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Task {
  id: string;
  projectId: string;
  chatId: string;
  planId: string;
  index: number;
  title: string;
  description: string;
  files: string[];
  acceptanceCriteria: string[];
  tests: string[];
  risk: string;
  status: TaskStatus;
  notes: string;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type PlanStatus = 'draft' | 'approved' | 'rejected' | 'in_progress' | 'completed' | 'cancelled';

export interface Plan {
  id: string;
  projectId: string;
  chatId: string;
  title: string;
  summary: string;
  approach: string;
  requirements: string[];
  risks: string[];
  taskIds: string[];
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

export type PermissionCategory =
  | 'read'
  | 'write'
  | 'delete'
  | 'execute'
  | 'git'
  | 'memory'
  | 'custom';

export type PermissionRisk = 'low' | 'medium' | 'high';

export interface PermissionRecord {
  id: string;
  projectId: string;
  category: PermissionCategory;
  toolName: string;
  actionKey: string;
  label: string;
  scope: 'project';
  createdAt: string;
  expiresAt: string | null;
  policyVersion: number;
}

export interface PermissionRequest {
  id: string;
  runId: string;
  projectId: string;
  chatId: string | null;
  toolName: string;
  category: PermissionCategory;
  actionKey: string;
  /** Key persisted when the user chooses "Always Allow"; null means it is not offered. */
  alwaysKey: string | null;
  title: string;
  description: string;
  risk: PermissionRisk;
  details: Record<string, string>;
  allowAlwaysLabel: string | null;
  createdAt: string;
}

export type PermissionDecision = 'allow_once' | 'always_allow' | 'deny';

/* ------------------------------------------------------------------ */
/* Providers and models                                                */
/* ------------------------------------------------------------------ */

export interface ModelInfo {
  id: string;
  name: string;
  sizeBytes: number | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  contextLength: number | null;
  capabilities: string[];
  supportsTools: boolean;
  modifiedAt: string | null;
}

export interface ProviderStatus {
  provider: 'ollama';
  baseUrl: string;
  connected: boolean;
  version: string | null;
  error: string | null;
  models: ModelInfo[];
  checkedAt: string;
}

export interface ModelTestResult {
  ok: boolean;
  model: string;
  response: string;
  durationMs: number;
  error: string | null;
}

export interface PullProgress {
  model: string;
  status: string;
  completed: number;
  total: number;
  percent: number | null;
  done: boolean;
  error: string | null;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  images?: string[];
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface GenerationResult {
  content: string;
  toolCalls: ProviderToolCall[];
  promptTokens: number | null;
  completionTokens: number | null;
  model: string;
}

/* ------------------------------------------------------------------ */
/* Tools and agents                                                    */
/* ------------------------------------------------------------------ */

export interface ToolDescriptor {
  name: string;
  description: string;
  category: PermissionCategory;
  mutating: boolean;
  risk: PermissionRisk;
  source: 'builtin' | 'custom';
  enabled: boolean;
  modes: AgentMode[];
  inputSummary: string;
  timeoutMs: number;
}

export type CustomToolDefinition = {
  name: string;
  description: string;
  command: string;
  category: 'execute';
  parameters: Array<{
    name: string;
    description: string;
    required: boolean;
  }>;
  createdAt: string;
  approvedAt: string | null;
  approved: boolean;
};

export interface ToolExecutionLogEntry {
  id: string;
  toolCallId: string;
  projectId: string;
  chatId: string | null;
  runId: string | null;
  toolName: string;
  args: unknown;
  status: ToolCallStatus;
  permission: string | null;
  resultPreview: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export type AgentRunStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'error' | 'limit';

export interface AgentRunState {
  runId: string;
  projectId: string;
  chatId: string;
  mode: AgentMode;
  status: AgentRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  toolCallCount: number;
}

export type AgentStatusPhase =
  | 'thinking'
  | 'inspecting'
  | 'awaiting_permission'
  | 'running_command'
  | 'editing_files'
  | 'running_tests'
  | 'verifying'
  | 'writing'
  | 'cancelled'
  | 'completed'
  | 'failed';

export type AgentEvent =
  | {
      type: 'run_started';
      runId: string;
      projectId: string;
      chatId: string;
      mode: AgentMode;
      model: string;
      userMessage: ChatMessage;
    }
  | { type: 'status'; runId: string; phase: AgentStatusPhase; detail: string }
  | { type: 'assistant_delta'; runId: string; text: string }
  | { type: 'assistant_reset'; runId: string; text: string }
  | { type: 'tool_call_started'; runId: string; call: ToolCallRecord }
  | { type: 'tool_call_updated'; runId: string; call: ToolCallRecord }
  | { type: 'permission_request'; runId: string; request: PermissionRequest }
  | {
      type: 'permission_resolved';
      runId: string;
      requestId: string;
      decision: PermissionDecision;
    }
  | { type: 'message_saved'; runId: string; message: ChatMessage }
  | { type: 'plan_updated'; runId: string; plan: Plan | null; tasks: Task[] }
  | { type: 'task_updated'; runId: string; task: Task }
  | { type: 'context_report'; runId: string; report: ContextReport }
  | {
      type: 'run_finished';
      runId: string;
      status: Exclude<AgentRunStatus, 'running' | 'idle'>;
      error: string | null;
    }
  | {
      type: 'log';
      runId: string | null;
      level: 'debug' | 'info' | 'warn' | 'error';
      text: string;
    };

/* ------------------------------------------------------------------ */
/* Workspace and files                                                 */
/* ------------------------------------------------------------------ */

export interface FileEntry {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  size: number | null;
  modifiedAt: string | null;
}

export interface FileInfo {
  relativePath: string;
  absolutePath: string;
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: string;
  isBinary: boolean;
  truncated: boolean;
}

export interface FileContent {
  relativePath: string;
  content: string;
  size: number;
  modifiedAt: string;
  isBinary: boolean;
  truncated: boolean;
  language: string;
}

export interface SearchMatch {
  relativePath: string;
  line: number;
  column: number;
  text: string;
}

export interface FileSearchResult {
  relativePath: string;
  name: string;
  type: 'file' | 'directory';
}

export interface GrepResult {
  matches: SearchMatch[];
  truncated: boolean;
  scannedFiles: number;
  engine: 'builtin';
}

export interface GitStatusEntry {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitStatus {
  isRepository: boolean;
  branch: string | null;
  entries: GitStatusEntry[];
  error: string | null;
}

export interface GitLogEntry {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitDiffResult {
  patch: string;
  truncated: boolean;
  error: string | null;
}

export interface GitBranchInfo {
  branches: string[];
  current: string | null;
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* Terminal                                                           */
/* ------------------------------------------------------------------ */

export interface TerminalSession {
  id: string;
  projectId: string;
  cwd: string;
  shell: string;
  platform: string;
  createdAt: string;
}

export interface TerminalChunk {
  sessionId: string;
  data: string;
  stream: 'stdout' | 'stderr' | 'system';
}

export interface TerminalExit {
  sessionId: string;
  code: number | null;
  signal: string | null;
  durationMs: number;
  cancelled: boolean;
  timedOut: boolean;
}

export interface CommandResult {
  commandId: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  output: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

/* ------------------------------------------------------------------ */
/* IPC envelopes                                                       */
/* ------------------------------------------------------------------ */

export interface AppBootstrap {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: string;
  arch: string;
  isDev: boolean;
  dataDirectory: string;
  settings: AppSettings;
  storageWarning: string | null;
}

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  expiries: number;
  invalidations: number;
  lastInvalidationReason: string | null;
}

export interface DiagnosticsInfo {
  cache: CacheStats;
  storage: { dataDirectory: string; formatVersion: number };
  provider: ProviderStatus;
  activeRuns: AgentRunState[];
  app: { version: string; electron: string; node: string; platform: string };
}
