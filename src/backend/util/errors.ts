export class AppError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_FOUND'
      | 'INVALID'
      | 'CONFLICT'
      | 'PERMISSION'
      | 'ISOLATION'
      | 'PROVIDER'
      | 'LIMIT'
      | 'CANCELLED'
      | 'STORAGE'
      | 'GENERAL' = 'GENERAL',
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unexpected error occurred.';
}
