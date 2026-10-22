import path from 'node:path';
import { app } from 'electron';

export interface AppPaths {
  userData: string;
  documents: string;
  /** Whether this is a development build (renderer served by Vite). */
  isDev: boolean;
  rendererUrl: string | null;
  preload: string;
  rendererIndex: string;
}

export function resolveAppPaths(): AppPaths {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? null;
  const appRoot = app.getAppPath();
  return {
    userData: app.getPath('userData'),
    documents: app.getPath('documents'),
    isDev: Boolean(rendererUrl),
    rendererUrl,
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    rendererIndex: path.join(appRoot, 'dist', 'renderer', 'index.html'),
  };
}
