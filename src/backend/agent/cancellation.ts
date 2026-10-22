/**
 * Per-run cancellation state. One AbortController is shared by the provider
 * request, running tools and child processes.
 */
export class RunCancellation {
  readonly controller = new AbortController();
  reason: string | null = null;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  cancel(reason = 'Cancelled by the user'): void {
    if (this.aborted) return;
    this.reason = reason;
    this.controller.abort();
  }
}
