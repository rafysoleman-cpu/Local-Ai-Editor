/**
 * Chat sessions.
 *
 * A chat belongs to exactly one project. Every read verifies both the project
 * index entry and the chat's own `projectId`, so a chat id from another project
 * can never be loaded through this service.
 */
import type { Chat, ChatMessage, ChatSummary, AgentMode } from '@shared/app-types';
import { z } from 'zod';
import { chatMessageSchema, chatSchema } from '@shared/validation';
import type { Logger } from '../logging/logger';
import type { FileStorage } from '../storage/file-storage';
import { STORAGE_PATHS } from '../storage/paths';
import { AppError } from '../util/errors';
import { nowIso, storageId } from '../util/ids';
import type { ProjectService } from '../projects/project-service';

const DEFAULT_TITLE = 'New chat';

const chatSessionSchema = z.object({
  chatId: z.string().min(3).max(120),
  projectId: z.string().min(3).max(120),
  lastModel: z.string().max(300).nullable(),
  lastMode: z.enum(['plan', 'build']),
  updatedAt: z.string().min(1),
});

export interface ChatSession {
  chatId: string;
  projectId: string;
  lastModel: string | null;
  lastMode: AgentMode;
  updatedAt: string;
}

export class ChatService {
  private readonly listeners = new Set<(projectId: string, chatId: string, reason: string) => void>();

  constructor(
    private readonly storage: FileStorage,
    private readonly projects: ProjectService,
    private readonly logger: Logger,
  ) {}

  onChange(listener: (projectId: string, chatId: string, reason: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(projectId: string, chatId: string, reason: string): void {
    for (const listener of this.listeners) {
      try {
        listener(projectId, chatId, reason);
      } catch {
        /* ignore listener failures */
      }
    }
  }

  async list(projectId: string): Promise<ChatSummary[]> {
    const project = await this.projects.require(projectId);
    const summaries: ChatSummary[] = [];
    for (const chatId of project.chatIds) {
      const chat = await this.get(projectId, chatId).catch(() => null);
      if (!chat) continue;
      summaries.push({
        id: chat.id,
        projectId: chat.projectId,
        title: chat.title,
        mode: chat.mode,
        messageCount: chat.messageCount,
        updatedAt: chat.updatedAt,
        status: chat.status,
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(projectId: string, mode: AgentMode = 'build', title?: string): Promise<Chat> {
    const project = await this.projects.require(projectId);
    const at = nowIso();
    const chat: Chat = {
      id: storageId('chat'),
      projectId: project.id,
      title: title?.trim() || DEFAULT_TITLE,
      createdAt: at,
      updatedAt: at,
      mode,
      messageCount: 0,
      status: 'idle',
      model: project.defaultModel,
      currentPlanId: null,
      formatVersion: project.formatVersion,
    };
    await this.storage.ensureDir(STORAGE_PATHS.chatDir(project.id, chat.id));
    await this.storage.writeJson(STORAGE_PATHS.chat(project.id, chat.id), chat, { backup: false });
    await this.storage.writeText(STORAGE_PATHS.messages(project.id, chat.id), '', { backup: false });
    await this.storage.writeJson(STORAGE_PATHS.session(project.id, chat.id), {
      chatId: chat.id,
      projectId: project.id,
      lastModel: chat.model,
      lastMode: mode,
      updatedAt: at,
    });
    await this.projects.updateIndexes(project.id, (value) => {
      value.chatIds.push(chat.id);
    });
    this.emitChange(project.id, chat.id, 'created');
    return chat;
  }

  async get(projectId: string, chatId: string): Promise<Chat | null> {
    const project = await this.projects.require(projectId);
    if (!project.chatIds.includes(chatId)) return null;
    const exists = await this.storage.exists(STORAGE_PATHS.chat(projectId, chatId));
    if (!exists) return null;
    const chat = await this.storage.readJson<Chat | null>(
      STORAGE_PATHS.chat(projectId, chatId),
      chatSchema,
      null,
    );
    if (!chat) return null;
    if (chat.id !== chatId || chat.projectId !== projectId) {
      throw new AppError(
        'Chat belongs to a different project. Access was rejected.',
        'ISOLATION',
      );
    }
    return chat;
  }

  async require(projectId: string, chatId: string): Promise<Chat> {
    const chat = await this.get(projectId, chatId);
    if (!chat) throw new AppError(`Chat not found in this project: ${chatId}`, 'NOT_FOUND');
    return chat;
  }

  async update(input: {
    projectId: string;
    chatId: string;
    title?: string;
    mode?: AgentMode;
  }): Promise<Chat> {
    const chat = await this.require(input.projectId, input.chatId);
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new AppError('Chat title cannot be empty.', 'INVALID');
      chat.title = title.slice(0, 300);
    }
    if (input.mode !== undefined) chat.mode = input.mode;
    chat.updatedAt = nowIso();
    await this.storage.writeJson(STORAGE_PATHS.chat(input.projectId, chat.id), chat);
    await this.projects.updateIndexes(input.projectId, () => undefined);
    this.emitChange(input.projectId, chat.id, 'updated');
    return chat;
  }

  async setStatus(projectId: string, chatId: string, status: Chat['status']): Promise<void> {
    const chat = await this.require(projectId, chatId);
    chat.status = status;
    chat.updatedAt = nowIso();
    await this.storage.writeJson(STORAGE_PATHS.chat(projectId, chatId), chat);
    this.emitChange(projectId, chatId, 'status');
  }

  async setCurrentPlan(projectId: string, chatId: string, planId: string | null): Promise<Chat> {
    const chat = await this.require(projectId, chatId);
    chat.currentPlanId = planId;
    chat.updatedAt = nowIso();
    await this.storage.writeJson(STORAGE_PATHS.chat(projectId, chatId), chat);
    this.emitChange(projectId, chatId, 'plan');
    return chat;
  }

  async messages(projectId: string, chatId: string): Promise<ChatMessage[]> {
    await this.require(projectId, chatId);
    const messages = await this.storage.readJsonLines<ChatMessage>(
      STORAGE_PATHS.messages(projectId, chatId),
      chatMessageSchema,
    );
    return messages.filter(
      (message) => message.projectId === projectId && message.chatId === chatId,
    );
  }

  async appendMessage(projectId: string, chatId: string, message: ChatMessage): Promise<ChatMessage> {
    const chat = await this.require(projectId, chatId);
    if (message.projectId !== projectId || message.chatId !== chatId) {
      throw new AppError('Message does not belong to this chat and project.', 'ISOLATION');
    }
    const validated = chatMessageSchema.parse(message);
    await this.storage.appendJsonLine(STORAGE_PATHS.messages(projectId, chatId), validated);

    chat.messageCount += 1;
    chat.updatedAt = nowIso();
    chat.status = message.role === 'assistant' ? 'idle' : chat.status;
    if (
      message.role === 'user' &&
      (chat.title === DEFAULT_TITLE || /^Chat \d+$/i.test(chat.title)) &&
      message.content.trim()
    ) {
      chat.title = message.content.trim().split(/\r?\n/)[0].slice(0, 80);
    }
    await this.storage.writeJson(STORAGE_PATHS.chat(projectId, chatId), chat);
    await this.projects.updateIndexes(projectId, () => undefined);
    this.emitChange(projectId, chatId, 'message');
    return validated;
  }

  async delete(projectId: string, chatId: string): Promise<void> {
    const chat = await this.require(projectId, chatId);
    const stamp = nowIso().replace(/[:.]/g, '-');
    const trashRelative = `${STORAGE_PATHS.chatsDir(projectId)}/deleted`;
    await this.storage.ensureDir(trashRelative);
    await this.storage.rename(
      STORAGE_PATHS.chatDir(projectId, chatId),
      `${trashRelative}/chat-${chatId}-${stamp}`,
    );
    await this.projects.updateIndexes(projectId, (project) => {
      project.chatIds = project.chatIds.filter((id) => id !== chat.id);
    });
    this.emitChange(projectId, chatId, 'deleted');
    this.logger.info('chat', 'Chat deleted (kept in chats/deleted)', { projectId, chatId });
  }

  async readSession(projectId: string, chatId: string): Promise<ChatSession | null> {
    await this.require(projectId, chatId);
    const raw = await this.storage.readJson<ChatSession | null>(
      STORAGE_PATHS.session(projectId, chatId),
      chatSessionSchema,
      null,
    );
    return raw;
  }

  async writeSession(session: ChatSession): Promise<void> {
    await this.require(session.projectId, session.chatId);
    await this.storage.writeJson(
      STORAGE_PATHS.session(session.projectId, session.chatId),
      { ...session, updatedAt: nowIso() },
      { backup: false },
    );
  }
}
