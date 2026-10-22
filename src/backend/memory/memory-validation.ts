import { AppError } from '../util/errors';

export const MAX_MEMORY_CHARS = 200_000;

export interface MemoryValidationResult {
  content: string;
  warnings: string[];
}

/**
 * Project memory must stay a concise summary, not a chat transcript.
 * The check is heuristic and deliberately conservative.
 */
export function validateMemoryContent(raw: string): MemoryValidationResult {
  if (typeof raw !== 'string') throw new AppError('Memory content must be text.', 'INVALID');
  const content = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (content.length > MAX_MEMORY_CHARS) {
    throw new AppError(
      `Project memory is ${content.length} characters; the limit is ${MAX_MEMORY_CHARS}. Summarize instead of pasting.`,
      'LIMIT',
    );
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)) {
    throw new AppError('Project memory contains unsupported control characters.', 'INVALID');
  }

  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const transcriptLines = lines.filter((line) => /^\s*(user|assistant|human|ai)\s*:/i.test(line));
  const warnings: string[] = [];
  if (lines.length >= 8 && transcriptLines.length / lines.length > 0.5) {
    throw new AppError(
      'This looks like a chat transcript rather than project memory. Keep memory as a concise summary of stable facts.',
      'INVALID',
    );
  }
  if (content.length > 40_000) {
    warnings.push('Project memory is large; consider summarizing older details to keep the model context small.');
  }
  return { content: content.endsWith('\n') ? content : `${content}\n`, warnings };
}
