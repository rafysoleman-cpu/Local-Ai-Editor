import type { ToolResult } from './tool-registry';

export const MAX_TOOL_RESULT_CHARS = 60_000;
const MAX_STORED_RESULT_CHARS = 20_000;
const MAX_DIFF_SIDE = 120_000;

export interface NormalizedToolResult {
  content: string;
  /** Content safe to persist with the chat message (smaller cap). */
  storedContent: string;
  summary: string;
  diff: ToolResult['diff'] | null;
  details: Record<string, string>;
}

export function normalizeToolResult(result: ToolResult): NormalizedToolResult {
  const rawContent = typeof result.content === 'string' ? result.content : String(result.content ?? '');
  const content =
    rawContent.length > MAX_TOOL_RESULT_CHARS
      ? `${rawContent.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[tool result truncated at ${MAX_TOOL_RESULT_CHARS} characters]`
      : rawContent;
  const storedContent =
    rawContent.length > MAX_STORED_RESULT_CHARS
      ? `${rawContent.slice(0, MAX_STORED_RESULT_CHARS)}\n\n[stored result truncated]`
      : rawContent;
  const details: Record<string, string> = {};
  for (const [key, value] of Object.entries(result.details ?? {})) {
    details[key] = String(value).slice(0, 4000);
  }
  const diff = result.diff
    ? {
        path: result.diff.path,
        changeType: result.diff.changeType,
        before: result.diff.before.slice(0, MAX_DIFF_SIDE),
        after: result.diff.after.slice(0, MAX_DIFF_SIDE),
      }
    : null;
  return {
    content,
    storedContent,
    summary: (result.summary || 'Tool completed').slice(0, 1000),
    diff,
    details,
  };
}

export function summarizeArgs(args: unknown): string {
  try {
    const text = JSON.stringify(args);
    if (!text) return '(no arguments)';
    return text.length > 900 ? `${text.slice(0, 900)}…` : text;
  } catch {
    return '(unserializable arguments)';
  }
}
