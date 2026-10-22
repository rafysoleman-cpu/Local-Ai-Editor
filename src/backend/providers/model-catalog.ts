import type { ModelInfo } from '@shared/app-types';

export interface ModelSelection {
  model: ModelInfo | null;
  /** Explanation shown to the user when the selection had to change. */
  note: string | null;
  error: string | null;
}

/**
 * Resolve which installed model to use. A previously selected model is never
 * silently replaced by a different one: if it is missing, the caller gets an
 * explicit error so the user can pick again.
 */
export function selectModel(
  preferred: string | null,
  fallbackPreference: string | null,
  models: ModelInfo[],
): ModelSelection {
  if (models.length === 0) {
    return {
      model: null,
      note: null,
      error: 'No local models were found. Start Ollama and pull a model, then refresh the model list.',
    };
  }
  const wanted = preferred?.trim() || fallbackPreference?.trim() || null;
  if (wanted) {
    const exact = models.find((model) => model.id === wanted || model.name === wanted);
    if (exact) return { model: exact, note: null, error: null };
    return {
      model: null,
      note: null,
      error: `The selected model "${wanted}" is not installed in Ollama. Choose another model or pull it first.`,
    };
  }
  const toolCapable = models.find((model) => model.supportsTools);
  if (toolCapable) {
    return {
      model: toolCapable,
      note: null,
      error: null,
    };
  }
  return {
    model: models[0],
    note: `"${models[0].name}" does not report tool support. The agent can chat, but tool execution may not work reliably. Treat any tool-call output with suspicion and verify capability first.`,
    error: null,
  };
}

export function describeModel(model: ModelInfo): string {
  const parts = [model.id];
  if (model.parameterSize) parts.push(model.parameterSize);
  if (model.quantization) parts.push(model.quantization);
  if (model.contextLength) parts.push(`${model.contextLength} ctx`);
  return parts.join(' · ');
}

export function modelSupportsTools(model: ModelInfo | null): boolean {
  return Boolean(model?.supportsTools);
}
