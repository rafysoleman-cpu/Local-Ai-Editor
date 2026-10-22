import path from 'node:path';
import { BrowserWindow, shell } from 'electron';
import type { AppPaths } from './app-paths';

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:']);
const CSP_DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:5199 http://127.0.0.1:5199",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export class WindowManager {
  private window: BrowserWindow | null = null;

  constructor(
    private readonly paths: AppPaths,
    private readonly iconPath?: string,
  ) {}

  get current(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  create(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1480,
      height: 940,
      minWidth: 1040,
      minHeight: 660,
      show: false,
      backgroundColor: '#0e1116',
      title: 'Local AI Editor',
      autoHideMenuBar: false,
      ...(this.iconPath ? { icon: this.iconPath } : {}),
      webPreferences: {
        preload: this.paths.preload,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        devTools: this.paths.isDev,
      },
    });

    this.window = window;
    this.installSecurity(window);
    this.installSessionPolicy(window);

    window.once('ready-to-show', () => window.show());
    window.on('close', () => console.log('[window] close event'));
    window.webContents.on('destroyed', () => console.log('[window] webContents destroyed'));
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('[window] Renderer process gone:', details);
    });
    window.on('closed', () => {
      if (this.window === window) this.window = null;
    });

    if (this.paths.isDev && this.paths.rendererUrl) {
      void window.loadURL(this.paths.rendererUrl);
    } else {
      void window.loadFile(this.paths.rendererIndex);
    }
    return window;
  }

  private installSecurity(window: BrowserWindow): void {
    const devOrigin = this.paths.rendererUrl ? new URL(this.paths.rendererUrl).origin : null;

    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) void shell.openExternal(url);
      } catch {
        /* ignore malformed urls */
      }
      return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, targetUrl) => {
      const allowed =
        (devOrigin && targetUrl.startsWith(devOrigin)) ||
        (!this.paths.isDev && targetUrl.startsWith('file://'));
      if (!allowed) {
        event.preventDefault();
        try {
          const parsed = new URL(targetUrl);
          if (ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) void shell.openExternal(targetUrl);
        } catch {
          /* ignore */
        }
      }
    });

    window.webContents.on('will-attach-webview', (event) => event.preventDefault());

    // Extra defense in depth: inject CSP for in-memory/document loads.
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      const csp = this.paths.isDev ? CSP_DEV : CSP_PROD;
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      });
    });
  }

  private installSessionPolicy(window: BrowserWindow): void {
    const appSession = window.webContents.session;
    appSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      // The app needs no camera, microphone, geolocation, notifications or
      // clipboard-write permissions, so deny everything by default.
      console.warn(`[security] Denied renderer permission request: ${permission}`);
      callback(false);
    });
    appSession.setPermissionCheckHandler(() => false);
    appSession.on('will-download', (event, item) => {
      // Model downloads go through the backend HTTP client, not the renderer.
      event.preventDefault();
      console.warn('[security] Blocked renderer download:', item.getURL());
    });
  }

  send(channel: string, payload: unknown): void {
    const window = this.current;
    if (!window) return;
    try {
      window.webContents.send(channel, payload);
    } catch (error) {
      console.warn('[window] Failed to send IPC event', channel, (error as Error).message);
    }
  }

  focus(): void {
    const window = this.current;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  }

  isKnownSender(url: string): boolean {
    if (this.paths.isDev && this.paths.rendererUrl) {
      return url.startsWith(new URL(this.paths.rendererUrl).origin);
    }
    return url.startsWith('file://');
  }

  static iconPathFor(appRoot: string): string | undefined {
    const candidate = path.join(appRoot, 'build', 'icon.png');
    return candidate;
  }
}
