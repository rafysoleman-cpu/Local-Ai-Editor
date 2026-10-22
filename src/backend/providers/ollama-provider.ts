/**
 * Ollama provider.
 *
 * Uses the real local HTTP API: /api/version, /api/tags, /api/chat (NDJSON
 * streaming with tool calls) and /api/pull (progress stream). Model
 * capabilities are read from the provider; tool support is never assumed.
 */
import type {
  GenerationResult,
  ModelInfo,
  ModelTestResult,
  ProviderStatus,
  ProviderToolCall,
  PullProgress,
} from '@shared/app-types';
import type { Logger } from '../logging/logger';
import type { ChatRequest, GenerationOptions, Provider } from './provider-interface';
import { ProviderError } from './provider-interface';

const CHAT_TIMEOUT_MS = 10 * 60 * 1000;
const PULL_TIMEOUT_MS = 60 * 60 * 1000;
const TEST_TIMEOUT_MS = 120 * 1000;

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    modified_at?: string;
    size?: number;
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
      context_length?: number;
    };
    capabilities?: string[];
  }>;
}

interface OllamaChatChunk {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: unknown };
    }>;
  };
  done?: boolean;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaPullChunk {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      return parsed.error ?? text.slice(0, 500);
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

async function* readNdjson(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new ProviderError('The provider returned an empty response body.', 'BAD_RESPONSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            yield JSON.parse(line) as unknown;
          } catch {
            throw new ProviderError(`The provider sent malformed JSON: ${line.slice(0, 200)}`, 'BAD_RESPONSE');
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer.trim()) as unknown;
      } catch {
        throw new ProviderError('The provider sent a truncated JSON response.', 'BAD_RESPONSE');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class OllamaProvider implements Provider {
  readonly name = 'ollama' as const;

  constructor(
    private readonly baseUrl: () => string,
    private readonly logger: Logger,
  ) {}

  get url(): string {
    return normalizeBaseUrl(this.baseUrl());
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const outerSignal = init.signal;
    const onAbort = (): void => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await fetch(`${this.url}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        if (outerSignal?.aborted) {
          throw new ProviderError('The request was cancelled.', 'CANCELLED');
        }
        throw new ProviderError(
          `Ollama did not respond within ${Math.round(timeoutMs / 1000)} seconds.`,
          'TIMEOUT',
        );
      }
      this.logger.warn('provider', 'Ollama request failed', {
        path,
        error: (error as Error).message,
      });
      throw new ProviderError(
        `Cannot reach Ollama at ${this.url}. Is "ollama serve" running? (${(error as Error).message})`,
        'UNAVAILABLE',
      );
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onAbort);
    }
  }

  async ping(): Promise<{ connected: boolean; version: string | null; error: string | null }> {
    try {
      const response = await this.request('/api/version', { method: 'GET' }, 8000);
      if (!response.ok) {
        return { connected: false, version: null, error: await readErrorBody(response) };
      }
      const body = (await response.json()) as { version?: string };
      return { connected: true, version: body.version ?? null, error: null };
    } catch (error) {
      return { connected: false, version: null, error: (error as Error).message };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await this.request('/api/tags', { method: 'GET' }, 15000);
    if (!response.ok) throw new ProviderError(`Ollama returned an error: ${await readErrorBody(response)}`);
    const body = (await response.json()) as OllamaTagsResponse;
    const models = Array.isArray(body.models) ? body.models : [];
    return models
      .map((model) => {
        const id = model.model ?? model.name ?? '';
        if (!id) return null;
        const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
        return {
          id,
          name: model.name ?? id,
          sizeBytes: typeof model.size === 'number' ? model.size : null,
          family: model.details?.family ?? null,
          parameterSize: model.details?.parameter_size ?? null,
          quantization: model.details?.quantization_level ?? null,
          contextLength: typeof model.details?.context_length === 'number' ? model.details.context_length : null,
          capabilities,
          supportsTools: capabilities.includes('tools'),
          modifiedAt: model.modified_at ?? null,
        } satisfies ModelInfo;
      })
      .filter((model): model is ModelInfo => model !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async status(): Promise<ProviderStatus> {
    const ping = await this.ping();
    let models: ModelInfo[] = [];
    if (ping.connected) {
      try {
        models = await this.listModels();
      } catch {
        models = [];
      }
    }
    return {
      provider: 'ollama',
      baseUrl: this.url,
      connected: ping.connected,
      version: ping.version,
      error: ping.error,
      models,
      checkedAt: new Date().toISOString(),
    };
  }

  async chat(request: ChatRequest): Promise<GenerationResult> {
    const body = {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.tool_name ? { tool_name: message.tool_name } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      })),
      tools: request.tools.length > 0 ? request.tools : undefined,
      stream: true,
      options: {
        temperature: request.options.temperature,
        top_p: request.options.topP,
        num_ctx: request.options.numCtx,
      },
    };
    const response = await this.request(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
      },
      CHAT_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new ProviderError(`Ollama chat failed: ${await readErrorBody(response)}`, 'BAD_RESPONSE');
    }

    let content = '';
    const toolCalls: ProviderToolCall[] = [];
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let model = request.model;

    for await (const raw of readNdjson(response)) {
      const chunk = raw as OllamaChatChunk;
      if (chunk.error) throw new ProviderError(`Ollama error: ${chunk.error}`, 'BAD_RESPONSE');
      if (chunk.model) model = chunk.model;
      const delta = chunk.message?.content ?? '';
      if (delta) {
        content += delta;
        request.onToken?.(delta);
      }
      if (Array.isArray(chunk.message?.tool_calls)) {
        for (let index = 0; index < chunk.message.tool_calls.length; index += 1) {
          const call = chunk.message.tool_calls[index];
          const name = call.function?.name;
          if (!name) continue;
          let args: unknown = call.function?.arguments ?? {};
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args) as unknown;
            } catch {
              args = {};
            }
          }
          const id = call.id ?? `call_${toolCalls.length}_${index}`;
          if (!toolCalls.some((existing) => existing.id === id && existing.name === name)) {
            toolCalls.push({ id, name, arguments: args });
          }
        }
      }
      if (typeof chunk.prompt_eval_count === 'number') promptTokens = chunk.prompt_eval_count;
      if (typeof chunk.eval_count === 'number') completionTokens = chunk.eval_count;
      if (chunk.done) break;
    }

    return { content, toolCalls, promptTokens, completionTokens, model };
  }

  async pull(
    model: string,
    onProgress: (progress: PullProgress) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.request(
      '/api/pull',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        signal,
      },
      PULL_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new ProviderError(`Could not pull model: ${await readErrorBody(response)}`, 'NOT_FOUND');
    }
    for await (const raw of readNdjson(response)) {
      const chunk = raw as OllamaPullChunk;
      if (chunk.error) {
        onProgress({
          model,
          status: chunk.error,
          completed: 0,
          total: 0,
          percent: null,
          done: true,
          error: chunk.error,
        });
        throw new ProviderError(chunk.error, 'BAD_RESPONSE');
      }
      const completed = chunk.completed ?? 0;
      const total = chunk.total ?? 0;
      onProgress({
        model,
        status: chunk.status ?? 'pulling',
        completed,
        total,
        percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : null,
        done: chunk.status === 'success',
        error: null,
      });
    }
  }

  async test(model: string): Promise<ModelTestResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const result = await this.chat({
        model,
        messages: [
          { role: 'system', content: 'You are a connectivity test. Answer briefly.' },
          { role: 'user', content: 'Reply with exactly the word: pong' },
        ],
        tools: [],
        options: { temperature: 0, topP: 1, numCtx: 2048 },
        signal: controller.signal,
      });
      return {
        ok: true,
        model: result.model,
        response: result.content.trim() || '(empty response)',
        durationMs: Date.now() - started,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        model,
        response: '',
        durationMs: Date.now() - started,
        error: (error as Error).message,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function defaultGenerationOptions(): GenerationOptions {
  return { temperature: 0.2, topP: 0.9, numCtx: 16384 };
}
