import { Menu, type BrowserWindow, app, dialog, shell } from 'electron';

export type MenuAction = 'new-chat' | 'save' | 'toggle-terminal' | 'quick-open' | 'settings';

/**
 * Application menu. Accelerators are registered here (rather than only in the
 * renderer) so they work regardless of focused DOM element. Menu actions are
 * forwarded to the renderer as `app:menu-action`.
 */
export function installMenu(window: BrowserWindow, isDev: boolean): void {
  const send = (action: MenuAction): void => {
    if (!window.isDestroyed()) window.webContents.send('app:menu-action', { action });
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+N',
          registerAccelerator: false,
          click: () => send('new-chat'),
        },
        {
          label: 'Save File',
          accelerator: 'CmdOrCtrl+S',
          registerAccelerator: false,
          click: () => send('save'),
        },
        {
          label: 'Quick Open File…',
          accelerator: 'CmdOrCtrl+P',
          registerAccelerator: false,
          click: () => send('quick-open'),
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          registerAccelerator: false,
          click: () => send('settings'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Terminal',
          accelerator: 'CmdOrCtrl+J',
          registerAccelerator: false,
          click: () => send('toggle-terminal'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        ...(isDev
          ? ([{ role: 'reload' }, { role: 'toggleDevTools' }] as Electron.MenuItemConstructorOptions[])
          : []),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Local AI Editor',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'Local AI Editor',
              message: `Local AI Editor ${app.getVersion()}`,
              detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}\n\nA local-first AI coding desktop application. Data stays on this machine.`,
              buttons: ['OK'],
            });
          },
        },
        {
          label: 'Show Data Folder',
          click: () => {
            void shell.openPath(app.getPath('userData'));
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
