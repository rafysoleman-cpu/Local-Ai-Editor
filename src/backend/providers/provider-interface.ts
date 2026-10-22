/**
 * Local model provider abstraction. Ollama is the first implementation; another
 * local provider can be added by implementing this interface.
 */
import type {
  ChatTurn,
  GenerationResult,
  ModelInfo,
  ModelTestResult,
  PullProgress,
  ProviderStatus,
} from '@shared/app-types';
import type { OllamaToolDefinition } from '../agent/tool-registry';

export interface GenerationOptions {
  temperature: number;
  topP: number;
  numCtx: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatTurn[];
  tools: OllamaToolDefinition[];
  options: GenerationOptions;
  signal: AbortSignal;
  onToken?: (text: string) => void;
}

export interface Provider {
  readonly name: 'ollama';
  ping(): Promise<{ connected: boolean; version: string | null; error: string | null }>;
  listModels(): Promise<ModelInfo[]>;
  status(): Promise<ProviderStatus>;
  chat(request: ChatRequest): Promise<GenerationResult>;
  pull(model: string, onProgress: (progress: PullProgress) => void, signal: AbortSignal): Promise<void>;
  test(model: string): Promise<ModelTestResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'UNAVAILABLE' | 'CANCELLED' | 'BAD_RESPONSE' | 'TIMEOUT' | 'NOT_FOUND' = 'UNAVAILABLE',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
