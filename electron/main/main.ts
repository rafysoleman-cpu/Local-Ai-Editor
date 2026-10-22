/**
 * Electron main entry point.
 *
 * Boots the backend (storage, services, agent runtime), registers validated IPC,
 * creates the hardened window and handles shutdown.
 */
import { app, dialog } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Backend, type BackendEmitters } from '../../src/backend/application/backend';
import { resolveAppPaths, type AppPaths } from './app-paths';
import { registerIpcHandlers } from './ipc-handlers';
import { installMenu } from './menu';
import { WindowManager } from './window-manager';

app.setName('Local AI Editor');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.localaieditor.app');
}
// Portable installs and automated tests may pin the Electron profile directory.
if (process.env.LAIE_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.LAIE_USER_DATA_DIR));
}
// Some virtualized/remote GPU setups crash the compositor; tests can opt out.
if (process.env.LAIE_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

let backend: Backend | null = null;
let windows: WindowManager | null = null;
let shuttingDown = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => windows?.focus());
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[main] Fatal startup error:', error);
      dialog.showErrorBox(
        'Local AI Editor could not start',
        `${message}\n\nIf the problem is storage-related, check that the data folder is writable. The app never deletes data automatically.`,
      );
      app.quit();
    });
}

async function start(): Promise<void> {
  const paths: AppPaths = resolveAppPaths();
  const iconPath = path.join(app.getAppPath(), 'build', 'icon.png');
  windows = new WindowManager(paths, existsSync(iconPath) ? iconPath : undefined);

  const emitters: BackendEmitters = {
    agentEvent: (event) => windows?.send('agent:event', event),
    terminalChunk: (chunk) => windows?.send('terminal:chunk', chunk),
    terminalExit: (exit) => windows?.send('terminal:exit', exit),
    pullProgress: (progress) => windows?.send('provider:pull-progress', progress),
    storageWarning: (message) => windows?.send('app:storage-warning', { message }),
    permissionRequest: (request) => windows?.send('permission:request', request),
    permissionResolved: (requestId, decision) =>
      windows?.send('permission:resolved', { requestId, decision }),
  };

  backend = await Backend.create({
    userDataDirectory: paths.userData,
    documentsDirectory: paths.documents,
    dataDirectoryOverride: process.env.LAIE_DATA_DIR ?? null,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome ?? 'unknown',
    isDev: paths.isDev,
    emitters,
  });

  registerIpcHandlers({ backend, windows });
  createWindow(paths);
  if (process.env.LAIE_SMOKE === '1') {
    const window = windows.current;
    if (window) {
      window.webContents.once('did-finish-load', () => {
        console.log('[smoke] renderer loaded');
        setTimeout(() => {
          console.log('[smoke] ok');
          app.quit();
        }, 700);
      });
      window.webContents.once('did-fail-load', (_event, code, description, url) => {
        console.error('[smoke] failed to load renderer', { code, description, url });
        app.exit(1);
      });
    }
  }

  app.on('window-all-closed', () => {
    console.log('[main] All windows closed');
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!windows?.current && paths) createWindow(paths);
  });
  app.on('child-process-gone', (_event, details) => {
    console.error('[main] Child process gone:', details);
  });
  app.on('before-quit', (event) => {
    console.log('[main] before-quit');
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    void (async () => {
      try {
        await backend?.shutdown();
      } catch (error) {
        console.error('[main] Shutdown error:', error);
      } finally {
        app.exit(0);
      }
    })();
  });

  process.on('uncaughtException', (error) => {
    console.error('[main] Uncaught exception:', error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[main] Unhandled rejection:', reason);
  });

  console.log(
    `[main] Local AI Editor ${app.getVersion()} ready · Electron ${process.versions.electron} · data: ${backend.storage.root}`,
  );
}

function createWindow(paths: AppPaths): void {
  const window = windows!.create();
  installMenu(window, paths.isDev);
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[main] Renderer failed to load', { code, description, url });
  });
}
