/**
 * Canonical relative paths inside the application data directory.
 * Keeping them in one module prevents divergent layouts.
 */

export const STORAGE_PATHS = {
  manifest: 'manifest.json',
  settings: 'app/settings.json',
  storageVersion: 'app/storage-version.json',
  customTools: 'app/custom-tools.json',
  appLog: 'logs/app.log',
  backups: 'backups',
  cache: 'cache',
  projects: 'projects',

  projectDir: (projectId: string) => `projects/project-${projectId}`,
  project: (projectId: string) => `projects/project-${projectId}/project.json`,
  instructions: (projectId: string) => `projects/project-${projectId}/instructions.md`,
  memory: (projectId: string) => `projects/project-${projectId}/memory.md`,
  memoryHistoryDir: (projectId: string) => `projects/project-${projectId}/memory-history`,
  memoryHistory: (projectId: string, stamp: string) =>
    `projects/project-${projectId}/memory-history/memory-${stamp}.md`,
  permissions: (projectId: string) => `projects/project-${projectId}/permissions.json`,
  executionsLog: (projectId: string) => `projects/project-${projectId}/logs/executions.jsonl`,
  projectLogsDir: (projectId: string) => `projects/project-${projectId}/logs`,

  chatsDir: (projectId: string) => `projects/project-${projectId}/chats`,
  chatDir: (projectId: string, chatId: string) =>
    `projects/project-${projectId}/chats/chat-${chatId}`,
  chat: (projectId: string, chatId: string) =>
    `projects/project-${projectId}/chats/chat-${chatId}/chat.json`,
  messages: (projectId: string, chatId: string) =>
    `projects/project-${projectId}/chats/chat-${chatId}/messages.jsonl`,
  session: (projectId: string, chatId: string) =>
    `projects/project-${projectId}/chats/chat-${chatId}/session.json`,

  tasksDir: (projectId: string) => `projects/project-${projectId}/tasks`,
  task: (projectId: string, taskId: string) =>
    `projects/project-${projectId}/tasks/task-${taskId}.json`,
  plansDir: (projectId: string) => `projects/project-${projectId}/plans`,
  plan: (projectId: string, planId: string) =>
    `projects/project-${projectId}/plans/plan-${planId}.json`,
} as const;
