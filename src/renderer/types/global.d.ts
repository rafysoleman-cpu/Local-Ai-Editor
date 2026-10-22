import type { DesktopApi } from '../../../electron/shared/ipc-contracts';

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

export {};
