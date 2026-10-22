/**
 * Execution limits for one agent run. Every limit is checked before starting new
 * work; when one is reached the run stops safely and reports why.
 */
import type { ExecutionLimits as LimitsSettings } from '@shared/app-types';

export class ExecutionLimits {
  private startedAt = Date.now();
  private toolCalls = 0;
  private iterations = 0;
  private readonly failures = new Map<string, number>();
  private limitReason: string | null = null;

  constructor(
    private readonly settings: LimitsSettings,
    private readonly runTimeoutMs: number,
  ) {}

  start(): void {
    this.startedAt = Date.now();
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get toolCallCount(): number {
    return this.toolCalls;
  }

  get iterationCount(): number {
    return this.iterations;
  }

  get stoppedReason(): string | null {
    return this.limitReason;
  }

  check(): string | null {
    if (this.limitReason) return this.limitReason;
    if (this.elapsedMs > this.runTimeoutMs) {
      this.limitReason = `The run exceeded its maximum duration of ${Math.round(this.runTimeoutMs / 1000)} seconds.`;
      return this.limitReason;
    }
    if (this.iterations >= this.settings.maxModelIterations) {
      this.limitReason = `The run reached the model-iteration limit (${this.settings.maxModelIterations}).`;
      return this.limitReason;
    }
    if (this.toolCalls >= this.settings.maxToolCallsPerTurn) {
      this.limitReason = `The run reached the tool-call limit (${this.settings.maxToolCallsPerTurn}).`;
      return this.limitReason;
    }
    return null;
  }

  beginIteration(): boolean {
    if (this.check()) return false;
    this.iterations += 1;
    return true;
  }

  beforeToolCall(): boolean {
    return this.check() === null;
  }

  recordToolCall(): void {
    this.toolCalls += 1;
  }

  recordSuccess(toolName: string): void {
    for (const key of [...this.failures.keys()]) {
      if (key.startsWith(`${toolName}:`)) this.failures.delete(key);
    }
  }

  recordFailure(toolName: string, error: string): string | null {
    const signature = `${toolName}:${error.slice(0, 120)}`;
    const count = (this.failures.get(signature) ?? 0) + 1;
    this.failures.set(signature, count);
    if (count >= this.settings.maxRepeatedFailures) {
      this.limitReason = `The same "${toolName}" failure happened ${count} times. Stopped to avoid repeating it.`;
      return this.limitReason;
    }
    return null;
  }

  summary(): string {
    return `${this.iterations} model turn${this.iterations === 1 ? '' : 's'}, ${this.toolCalls} tool call${this.toolCalls === 1 ? '' : 's'}, ${Math.round(this.elapsedMs / 1000)}s`;
  }
}
