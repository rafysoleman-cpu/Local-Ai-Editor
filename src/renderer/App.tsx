import { useCallback, useEffect, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useApp } from './state/store';
import { TitleBar } from './features/layout/TitleBar';
import { Dashboard } from './features/dashboard/Dashboard';
import { Sidebar } from './features/sidebar/Sidebar';
import { EditorPane } from './features/editor/EditorPane';
import { DiffModal } from './features/editor/DiffModal';
import { ChatPanel } from './features/chat/ChatPanel';
import { TerminalPanel } from './features/terminal/TerminalPanel';
import { ModelSelector } from './features/model-selector/ModelSelector';
import { ToolsPanel } from './features/tool-manager/ToolsPanel';
import { SettingsModal } from './features/settings/SettingsModal';
import { ProjectSettingsModal } from './features/settings/ProjectSettingsModal';
import { PermissionDialog } from './features/permissions/PermissionDialog';
import { QuickOpen } from './features/quick-open/QuickOpen';
import { NewProjectDialog } from './features/projects/NewProjectDialog';
import { Toasts } from './components/ui';
import { api, formatError } from './services/api';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function App() {
  const bootstrapped = useApp((state) => state.bootstrapped);
  const fatalError = useApp((state) => state.fatalError);
  const project = useApp((state) => state.project);
  const settings = useApp((state) => state.settings);
  const modals = useApp((state) => state.modals);
  const layout = settings?.layout;

  useEffect(() => {
    void useApp.getState().init();
  }, []);

  useEffect(() => {
    const unsubs = [
      api.events.onAgentEvent((event) => useApp.getState().handleAgentEvent(event)),
      api.events.onPermissionRequest((request) => useApp.getState().handlePermissionRequest(request)),
      api.events.onPermissionResolved(({ requestId }) => useApp.getState().handlePermissionResolved(requestId)),
      api.events.onPullProgress((progress) => useApp.getState().handlePullProgress(progress)),
      api.events.onStorageWarning(({ message }) => useApp.getState().toast(message, 'warning')),
      api.events.onMenuAction(({ action }) => {
        const state = useApp.getState();
        if (action === 'save') {
          const active = state.activeTab;
          if (active) void state.saveTab(active);
        } else if (action === 'toggle-terminal') {
          const current = useApp.getState().settings?.layout.terminalOpen ?? false;
          state.setTerminalOpen(!current);
        } else if (action === 'new-chat') {
          if (state.project) void state.createChat(state.chat?.mode ?? state.draftMode).catch((error) => state.toast(formatError(error), 'error'));
        } else if (action === 'quick-open') {
          if (state.project) state.openModal('quickOpen');
        } else if (action === 'settings') {
          state.openModal('settings');
        }
      }),
    ];
    return () => {
      for (const unsubscribe of unsubs) unsubscribe();
    };
  }, []);

  const handleSave = useCallback((): void => {
    const state = useApp.getState();
    if (state.activeTab) void state.saveTab(state.activeTab);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = useApp.getState();
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape') {
        if (state.closeTopModal()) event.preventDefault();
        return;
      }
      if (!mod || event.altKey) return;
      switch (event.key.toLowerCase()) {
        case 's':
          event.preventDefault();
          handleSave();
          break;
        case 'j':
          event.preventDefault();
          state.setTerminalOpen(!(state.settings?.layout.terminalOpen ?? false));
          break;
        case 'n':
          event.preventDefault();
          // Do not create a chat while the user is typing in a field or a dialog
          // is open; Monaco is the exception because Ctrl+N is a global action.
          {
            const target = event.target as HTMLElement | null;
            const typing =
              target &&
              (target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable);
            if (document.querySelector('.modal') || (typing && !target.closest('.monaco-editor'))) {
              break;
            }
          }
          if (state.project) {
            void state
              .createChat(state.chat?.mode ?? state.draftMode)
              .catch((error) => state.toast(formatError(error), 'error'));
          } else {
            state.openModal('newProject', 'new');
          }
          break;
        case 'p':
          event.preventDefault();
          if (state.project) state.openModal('quickOpen');
          break;
        case ',':
          event.preventDefault();
          state.openModal('settings');
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSave]);

  const startSidebarResize = (event: ReactPointerEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = useApp.getState().settings?.layout.sidebarWidth ?? 264;
    const onMove = (moveEvent: PointerEvent): void => {
      useApp.getState().setLayout({ sidebarWidth: clamp(startWidth + (moveEvent.clientX - startX), 190, 560) });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      useApp.getState().setLayout({}, true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startChatResize = (event: ReactPointerEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = useApp.getState().settings?.layout.chatWidth ?? 440;
    const onMove = (moveEvent: PointerEvent): void => {
      useApp.getState().setLayout({ chatWidth: clamp(startWidth - (moveEvent.clientX - startX), 320, 820) });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      useApp.getState().setLayout({}, true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startTerminalResize = (event: ReactPointerEvent): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = useApp.getState().settings?.layout.terminalHeight ?? 240;
    const onMove = (moveEvent: PointerEvent): void => {
      useApp.getState().setLayout({ terminalHeight: clamp(startHeight + (startY - moveEvent.clientY), 120, 640) });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      useApp.getState().setLayout({}, true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (fatalError) {
    return (
      <div className="fatal">
        <div className="fatal-card">
          <h1>Local AI Editor could not start</h1>
          <p className="muted">The backend reported the following error:</p>
          <pre>{fatalError}</pre>
          <div className="row">
            <button className="btn primary" onClick={() => window.location.reload()}>
              Try again
            </button>
            <button className="btn" onClick={() => void api.app.openDataDir()}>
              Open data folder
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!bootstrapped || !settings) {
    return (
      <div className="loading-screen">
        <span className="spinner" />
        <div>Starting Local AI Editor…</div>
        <div className="faint small">Loading local data and checking the model provider</div>
      </div>
    );
  }

  const style = {
    '--sidebar-w': `${layout?.sidebarWidth ?? 264}px`,
    '--chat-w': `${layout?.chatWidth ?? 440}px`,
    '--terminal-h': `${layout?.terminalHeight ?? 240}px`,
  } as CSSProperties;

  return (
    <div className="app" style={style}>
      <TitleBar />
      <div className="main">
        {project ? (
          <>
            <div className="workspace">
              <Sidebar />
              <div
                className="resizer-v"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startSidebarResize}
              />
              <EditorPane />
              <div
                className="resizer-v"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startChatResize}
              />
              <ChatPanel />
            </div>
            {layout?.terminalOpen ? (
              <>
                <div
                  className="resizer-h"
                  role="separator"
                  aria-orientation="horizontal"
                  onPointerDown={startTerminalResize}
                />
                <TerminalPanel key={project.id} />
              </>
            ) : null}
          </>
        ) : (
          <Dashboard />
        )}
      </div>

      {modals.settings ? <SettingsModal /> : null}
      {modals.models ? <ModelSelector /> : null}
      {modals.tools ? <ToolsPanel /> : null}
      {modals.projectSettings && project ? <ProjectSettingsModal /> : null}
      {modals.newProject ? (
        <NewProjectDialog
          mode={modals.newProject}
          onClose={() => useApp.getState().closeModal('newProject')}
        />
      ) : null}
      {modals.quickOpen ? <QuickOpen /> : null}
      {modals.diff ? <DiffModal /> : null}
      <PermissionDialog />
      <Toasts />
    </div>
  );
}
