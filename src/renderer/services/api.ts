import type { DesktopApi } from '@shared/ipc-contracts';

export const api: DesktopApi = window.desktop;

/** Strip Electron's IPC error prefix so the UI shows the real message. */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '');
    return message || 'An unexpected error occurred.';
  }
  if (typeof error === 'string') return error;
  return 'An unexpected error occurred.';
}
