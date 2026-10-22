import {
  AlertTriangle,
  Bot,
  LayoutGrid,
  Moon,
  Settings,
  Sun,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { useApp } from '../../state/store';

export function TitleBar() {
  const project = useApp((state) => state.project);
  const settings = useApp((state) => state.settings);
  const providerStatus = useApp((state) => state.providerStatus);
  const closeProject = useApp((state) => state.closeProject);
  const openModal = useApp((state) => state.openModal);
  const setTerminalOpen = useApp((state) => state.setTerminalOpen);
  const updateSettings = useApp((state) => state.updateSettings);

  const selectedModel =
    project?.defaultModel ?? settings?.defaultModel ?? providerStatus?.models[0]?.id ?? null;
  const connected = Boolean(providerStatus?.connected);

  return (
    <header className="titlebar">
      <div className="brand">
        <span className="brand-mark">LA</span>
        <span>Local AI Editor</span>
      </div>
      <div className="titlebar-sep" />
      {project ? (
        <>
          <button
            className="icon-btn"
            title="Back to projects"
            onClick={() => void closeProject()}
            type="button"
          >
            <LayoutGrid size={15} />
          </button>
          <div className="titlebar-project">
            <strong title={project.name}>{project.name}</strong>
            {project.workspaceMissing ? (
              <span className="badge warning">
                <AlertTriangle size={10} /> folder missing
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <span className="faint small">Project-based local coding agent</span>
      )}
      <div className="titlebar-spacer" />
      <div className="titlebar-actions">
        <button
          className="btn ghost sm"
          type="button"
          onClick={() => openModal('models')}
          title="Select local model"
        >
          <span className={`status-dot ${connected ? 'success' : 'error'}`} style={{ marginRight: 2 }} />
          <Bot size={14} />
          <span className="truncate" style={{ maxWidth: 180 }}>
            {selectedModel ?? 'Choose model'}
          </span>
        </button>
        {settings ? (
          <button
            className="icon-btn"
            type="button"
            title={settings.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() =>
              void updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
            }
          >
            {settings.theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        ) : null}
        <button
          className="icon-btn"
          type="button"
          title="Tools & permissions"
          onClick={() => openModal('tools')}
          disabled={!project}
        >
          <Wrench size={15} />
        </button>
        <button
          className="icon-btn"
          type="button"
          title="Toggle terminal (Ctrl+J)"
          onClick={() => setTerminalOpen(!(settings?.layout.terminalOpen ?? false))}
          disabled={!project}
        >
          <TerminalSquare size={15} />
        </button>
        <button className="icon-btn" type="button" title="Settings" onClick={() => openModal('settings')}>
          <Settings size={15} />
        </button>
      </div>
    </header>
  );
}
