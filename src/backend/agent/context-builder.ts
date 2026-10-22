/**
 * Context construction.
 *
 * Rebuilds the model context from the system prompt, project instructions,
 * concise memory, a partial file tree, recent messages from *this chat only* and
 * the current request. A five-minute cache holds the instruction/memory/tree
 * block; fingerprints invalidate it when any dependency changes.
 */
import type {
  AgentMode,
  AppSettings,
  Chat,
  ChatMessage,
  ChatTurn,
  ContextReport,
  Plan,
  Project,
  Task,
} from '@shared/app-types';
import { fileTreeFingerprint, projectContextFingerprint } from '../cache/cache-invalidation';
import type { ContextCache } from '../cache/context-cache';
import type { Logger } from '../logging/logger';
import type { MemoryService } from '../memory/memory-service';
import type { ProjectService } from '../projects/project-service';
import type { WorkspaceService } from '../projects/workspace-service';
import { buildSystemPrompt } from './prompt-builder';

const INSTRUCTION_CAP = 16000;
const MEMORY_CAP = 24000;
const TREE_CAP = 6000;

interface ContextBlock {
  instructions: string;
  memory: string;
  tree: string;
}

export interface BuildContextInput {
  project: Project;
  chat: Chat;
  mode: AgentMode;
  userPrompt: string;
  settings: AppSettings;
  modelId: string;
  history: ChatMessage[];
  plan: Plan | null;
  tasks: Task[];
  toolList: string;
}

export interface BuiltContext {
  messages: ChatTurn[];
  systemPrompt: string;
  report: ContextReport;
}

export class ContextBuilder {
  constructor(
    private readonly cache: ContextCache,
    private readonly projects: ProjectService,
    private readonly memory: MemoryService,
    private readonly workspace: WorkspaceService,
    private readonly logger: Logger,
    private readonly shell: string,
  ) {}

  async build(input: BuildContextInput): Promise<BuiltContext> {
    const { project, mode, settings, userPrompt } = input;
    const notes: string[] = [];

    const instructionsContent = (await this.projects.getInstructions(project.id)).content;
    const memoryContent = settings.context.includeMemory
      ? (await this.memory.get(project.id)).content
      : '';
    if (!settings.context.includeMemory) notes.push('Project memory was excluded by settings.');

    let treeHit = false;
    let tree = '';
    if (settings.context.includeFileTree) {
      const treeFingerprint = await fileTreeFingerprint(project.workspacePath);
      const cachedTree = this.cache.get<string>(`tree:${project.id}`, treeFingerprint, project.id);
      if (cachedTree !== null) {
        tree = cachedTree;
        treeHit = true;
      } else {
        tree = await this.workspace.fileTreeSummary(project.workspacePath, 120);
        this.cache.set(`tree:${project.id}`, tree, treeFingerprint, project.id);
      }
    }

    const blockFingerprint = projectContextFingerprint({
      instructions: instructionsContent,
      memory: memoryContent,
      contextMaxChars: settings.context.maxChars,
      includeMemory: settings.context.includeMemory,
      includeFileTree: settings.context.includeFileTree,
      mode,
    });
    const cacheKey = `block:${project.id}:${mode}`;
    let block = this.cache.get<ContextBlock>(cacheKey, blockFingerprint, project.id);
    const blockHit = block !== null;
    if (!block) {
      block = {
        instructions: instructionsContent.slice(0, INSTRUCTION_CAP),
        memory: memoryContent.slice(0, MEMORY_CAP),
        tree: tree.slice(0, TREE_CAP),
      };
      this.cache.set(cacheKey, block, blockFingerprint, project.id);
    }
    const contextBlock: ContextBlock = block;

    const compose = (scale: number): string =>
      buildSystemPrompt({
        mode,
        projectName: project.name,
        projectId: project.id,
        workspacePath: project.workspacePath,
        platform: `${process.platform} (${process.arch})`,
        shell: this.shell,
        modelId: input.modelId,
        instructions: contextBlock.instructions.slice(0, Math.max(200, Math.floor(INSTRUCTION_CAP * scale))),
        memory: contextBlock.memory.slice(0, Math.max(200, Math.floor(MEMORY_CAP * scale))),
        fileTree: contextBlock.tree.slice(0, Math.max(120, Math.floor(TREE_CAP * scale))),
        toolList: input.toolList,
        plan: input.plan,
        tasks: input.tasks,
        now: new Date().toISOString(),
      });

    const budget = settings.context.maxChars;
    const maxSystemChars = Math.max(2000, budget - userPrompt.length - 400);
    let scaled = false;
    let systemPrompt = compose(1);
    let scale = 1;
    while (systemPrompt.length > maxSystemChars && scale > 0.1) {
      scale *= 0.6;
      scaled = true;
      systemPrompt = compose(scale);
    }
    let truncated = scaled;
    if (systemPrompt.length > maxSystemChars) {
      systemPrompt = `${systemPrompt.slice(0, maxSystemChars)}\n\n[context truncated to fit the configured budget]`;
      truncated = true;
    }
    if (scaled) {
      notes.push('Project instructions/memory/tree were reduced to fit the context budget.');
    }
    if (userPrompt.length > budget) {
      notes.push('The current request alone exceeds the context budget; it was kept intact and older context was dropped.');
    }

    const historyTurns: ChatTurn[] = [];
    let usedChars = systemPrompt.length + userPrompt.length;
    let messagesDropped = 0;
    const candidates = input.history.slice(-settings.context.maxMessages);
    messagesDropped += Math.max(0, input.history.length - candidates.length);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const message = candidates[index];
      const turn = messageToTurn(message);
      if (!turn) continue;
      const size = turn.content.length;
      if (usedChars + size > budget) {
        messagesDropped += index + 1;
        break;
      }
      historyTurns.unshift(turn);
      usedChars += size;
    }

    const messages: ChatTurn[] = [
      { role: 'system', content: systemPrompt },
      ...historyTurns,
      { role: 'user', content: userPrompt },
    ];

    const cacheState: ContextReport['cache'] =
      blockHit && treeHit ? 'hit' : blockHit || treeHit ? 'partial' : 'miss';
    if (cacheState === 'miss') {
      this.logger.debug('context', 'Context block rebuilt', { projectId: project.id, mode });
    }

    const report: ContextReport = {
      budgetChars: budget,
      usedChars,
      estimatedTokens: Math.ceil(usedChars / 4),
      messagesIncluded: historyTurns.length,
      messagesDropped,
      memoryIncluded: Boolean(settings.context.includeMemory && contextBlock.memory.trim()),
      instructionsIncluded: Boolean(contextBlock.instructions.trim()),
      fileTreeIncluded: Boolean(settings.context.includeFileTree && contextBlock.tree.trim()),
      truncated,
      cache: cacheState,
      notes,
    };

    return { messages, systemPrompt, report };
  }
}

function messageToTurn(message: ChatMessage): ChatTurn | null {
  if (message.role === 'user') {
    if (!message.content.trim()) return null;
    return { role: 'user', content: message.content };
  }
  const toolSummary =
    message.toolCalls.length > 0
      ? `\n[tool activity: ${message.toolCalls
          .map((call) => `${call.name} (${call.status})`)
          .join(', ')}]`
      : '';
  if (!message.content.trim() && !toolSummary) return null;
  return {
    role: 'assistant',
    content: `${message.content}${toolSummary}`.trim(),
  };
}
