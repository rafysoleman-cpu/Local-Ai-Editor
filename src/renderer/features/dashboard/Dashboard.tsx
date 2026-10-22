import { useState } from 'react';
import {
  AlertTriangle,
  FolderOpen,
  FolderPlus,
  MessagesSquare,
  Pencil,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useApp } from '../../state/store';
import { ConfirmDialog } from '../../components/ui';

export function Dashboard() {
  const projects = useApp((state) => state.projects);
  const openProject = useApp((state) => state.openProject);
  const openModal = useApp((state) => state.openModal);
  const removeProject = useApp((state) => state.removeProject);
  const updateProject = useApp((state) => state.updateProject);
  const bootstrap = useApp((state) => state.bootstrap);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);

  const rename = async (id: string, current: string): Promise<void> => {
    const name = window.prompt('Rename project', current);
    if (!name || name.trim() === current) return;
    await updateProject({ projectId: id, name: name.trim() });
  };

  return (
    <div className="dashboard">
      <div className="dashboard-inner">
        <div className="dash-head">
          <div>
            <h1>Projects</h1>
            <p>
              Local-first agentic coding. Each project keeps its own instructions, memory, chats and
              permissions on this machine. Source code stays in the folder you choose.
            </p>
          </div>
          <div className="dash-actions">
            <button className="btn" type="button" onClick={() => openModal('newProject', 'existing')}>
              <FolderPlus size={15} /> Add existing folder
            </button>
            <button className="btn primary" type="button" onClick={() => openModal('newProject', 'new')}>
              <Plus size={15} /> New project
            </button>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Sparkles size={22} />
            </div>
            <h3>Start with a project</h3>
            <p>
              Create a new folder or add an existing codebase. The app stores chats, memory and
              permissions separately from your source files.
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" type="button" onClick={() => openModal('newProject', 'new')}>
                <Plus size={15} /> New project
              </button>
              <button className="btn" type="button" onClick={() => openModal('newProject', 'existing')}>
                <FolderPlus size={15} /> Add existing folder
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="section-label">All projects</span>
              <span className="badge">{projects.length}</span>
            </div>
            <div className="project-grid">
              {projects.map((project) => (
                <div
                  key={project.id}
                  className="project-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => void openProject(project.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void openProject(project.id);
                  }}
                >
                  <div className="project-card-actions">
                    <button
                      className="icon-btn"
                      title="Rename project"
                      onClick={(event) => {
                        event.stopPropagation();
                        void rename(project.id, project.name);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Open project folder"
                      onClick={(event) => {
                        event.stopPropagation();
                        void window.desktop.projects.openFolder(project.id);
                      }}
                    >
                      <FolderOpen size={13} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Remove from dashboard"
                      onClick={(event) => {
                        event.stopPropagation();
                        setRemoveTarget({ id: project.id, name: project.name });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="row">
                    <h3 className="truncate">{project.name}</h3>
                    {project.workspaceMissing ? (
                      <span className="badge warning">
                        <AlertTriangle size={10} /> missing folder
                      </span>
                    ) : null}
                  </div>
                  <div className="project-path" title={project.workspacePath}>
                    {project.workspacePath}
                  </div>
                  <div className="project-meta">
                    <span className="row" style={{ gap: 4 }}>
                      <MessagesSquare size={12} /> {project.chatCount} chats
                    </span>
                    <span>·</span>
                    <span>updated {new Date(project.updatedAt).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="divider" style={{ marginTop: 34 }} />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="faint small">
            Local AI Editor {bootstrap?.appVersion} · Electron {bootstrap?.electronVersion} · data:{' '}
            <span className="mono">{bootstrap?.dataDirectory}</span>
          </span>
          <button className="btn ghost sm" type="button" onClick={() => openModal('settings')}>
            <Settings size={13} /> Settings
          </button>
        </div>
      </div>

      {removeTarget ? (
        <ConfirmDialog
          title={`Remove "${removeTarget.name}" from the dashboard?`}
          message={
            <>
              <p>
                The project's chats, plans and memory will be moved to{' '}
                <span className="inline-code">backups/removed-project-*</span> inside the application
                data folder. Your source files are never touched.
              </p>
              <p className="muted">
                This is not permanent deletion. You can delete the project data explicitly from its
                settings later.
              </p>
            </>
          }
          confirmLabel="Remove from dashboard"
          onCancel={() => setRemoveTarget(null)}
          onConfirm={async () => {
            const target = removeTarget;
            setRemoveTarget(null);
            await removeProject(target.id, false);
          }}
        />
      ) : null}
    </div>
  );
}
