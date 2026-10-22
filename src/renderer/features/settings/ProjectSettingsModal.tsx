import { useEffect, useState } from 'react';
import { AlertTriangle, Archive, FolderOpen, Trash2 } from 'lucide-react';
import { Modal, ConfirmDialog, Spinner } from '../../components/ui';
import { useApp } from '../../state/store';
import { formatError } from '../../services/api';

type Tab = 'project' | 'instructions' | 'memory' | 'danger';

export function ProjectSettingsModal() {
  const project = useApp((state) => state.project);
  const providerStatus = useApp((state) => state.providerStatus);
  const settings = useApp((state) => state.settings);
  const updateProject = useApp((state) => state.updateProject);
  const removeProject = useApp((state) => state.removeProject);
  const refreshWorkspace = useApp((state) => state.refreshWorkspace);
  const closeModal = useApp((state) => state.closeModal);
  const toast = useApp((state) => state.toast);

  const [tab, setTab] = useState<Tab>('project');
  const [name, setName] = useState(project?.name ?? '');
  const [instructions, setInstructions] = useState('');
  const [memory, setMemory] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | {
    title: string;
    message: string;
    label: string;
    danger: boolean;
    action: () => Promise<void>;
  }>(null);

  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setLoaded(false);
    Promise.all([
      window.desktop.projects.getInstructions(project.id),
      window.desktop.projects.getMemory(project.id),
    ])
      .then(([instructionsData, memoryData]) => {
        setInstructions(instructionsData.content);
        setMemory(memoryData.content);
        setLoaded(true);
      })
      .catch((loadError) => {
        setError(formatError(loadError));
        setLoaded(true);
      });
  }, [project?.id]);

  if (!project) return null;

  const relocate = async (): Promise<void> => {
    try {
      const selected = await window.desktop.projects.pickFolder('open');
      if (!selected) return;
      await window.desktop.projects.relocateWorkspace(project.id, selected);
      await refreshWorkspace();
      toast('Workspace folder updated.', 'success');
    } catch (relocateError) {
      toast(formatError(relocateError), 'error');
    }
  };

  const saveName = async (): Promise<void> => {
    setBusy('name');
    try {
      await updateProject({ projectId: project.id, name: name.trim() });
    } catch (saveError) {
      toast(formatError(saveError), 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveInstructions = async (): Promise<void> => {
    setBusy('instructions');
    try {
      await window.desktop.projects.saveInstructions(project.id, instructions);
      toast('Project instructions saved.', 'success');
    } catch (saveError) {
      toast(formatError(saveError), 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveMemory = async (): Promise<void> => {
    setBusy('memory');
    try {
      const saved = await window.desktop.projects.saveMemory(project.id, memory);
      setMemory(saved.content);
      toast('Project memory saved. The previous version was archived.', 'success');
    } catch (saveError) {
      toast(formatError(saveError), 'error');
    } finally {
      setBusy(null);
    }
  };

  const models = providerStatus?.models ?? [];

  return (
    <Modal
      title={`Project: ${project.name}`}
      subtitle={project.workspacePath}
      onClose={() => closeModal('projectSettings')}
      className="wide"
      footer={
        <>
          <span className="faint small">Instructions and memory are included in the agent context.</span>
          <span className="spacer" />
          <button className="btn" onClick={() => closeModal('projectSettings')}>
            Close
          </button>
        </>
      }
    >
      <div className="tabs" style={{ margin: '-16px -16px 10px' }}>
        {(
          [
            ['project', 'Project'],
            ['instructions', 'Instructions'],
            ['memory', 'Memory'],
            ['danger', 'Danger zone'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab-btn ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? <div className="message-error" style={{ marginBottom: 10 }}>{error}</div> : null}

      {tab === 'project' ? (
        <>
          <div className="field">
            <label htmlFor="project-name-edit">Name</label>
            <div className="row">
              <input
                id="project-name-edit"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <button
                className="btn"
                onClick={() => void saveName()}
                disabled={!name.trim() || busy === 'name' || name.trim() === project.name}
              >
                {busy === 'name' ? <Spinner /> : 'Save'}
              </button>
            </div>
          </div>

          <div className="field">
            <label>Workspace folder</label>
            <div className="data-path">{project.workspacePath}</div>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn sm" onClick={() => void window.desktop.projects.openFolder(project.id)}>
                <FolderOpen size={12} /> Open folder
              </button>
              <button className="btn sm" onClick={() => void relocate()}>
                Locate again…
              </button>
            </div>
            {project.workspaceMissing ? (
              <div className="message-error" style={{ marginTop: 8 }}>
                <AlertTriangle size={13} /> This workspace folder is missing. Relocate it before
                running the agent.
              </div>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="project-model">Model override for this project</label>
            <select
              id="project-model"
              className="select"
              value={project.defaultModel ?? ''}
              onChange={(event) =>
                void updateProject({
                  projectId: project.id,
                  defaultModel: event.target.value || null,
                })
              }
            >
              <option value="">Use application default ({settings?.defaultModel ?? 'none'})</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                  {model.supportsTools ? ' · tools' : ''}
                </option>
              ))}
            </select>
            <span className="hint">
              A project override only affects chats in this project.
            </span>
          </div>

          <div className="stat-grid">
            <div className="stat">
              <div className="stat-label">Project ID</div>
              <div className="stat-value mono" style={{ fontSize: 11 }}>{project.id}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Created</div>
              <div className="stat-value" style={{ fontSize: 12 }}>
                {new Date(project.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Chats</div>
              <div className="stat-value">{project.chatIds.length}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Plans</div>
              <div className="stat-value">{project.planIds.length}</div>
            </div>
          </div>
        </>
      ) : null}

      {tab === 'instructions' ? (
        <>
          <p className="section-desc">
            Project instructions are sent to the model with every chat in this project. Describe
            conventions, architecture and verification commands. Instructions are stored in the
            application data folder, not in your source tree.
          </p>
          <textarea
            className="textarea"
            style={{ minHeight: 260 }}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Describe how the agent should work in this project…"
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={() => void saveInstructions()} disabled={busy === 'instructions'}>
              {busy === 'instructions' ? <Spinner /> : 'Save instructions'}
            </button>
            <span className="faint small">{instructions.length} characters</span>
          </div>
        </>
      ) : null}

      {tab === 'memory' ? (
        <>
          <p className="section-desc">
            Concise, stable facts only: purpose, stack, architecture, conventions, decisions, known
            issues and verification commands. The agent can update this file with{' '}
            <span className="inline-code">update_project_memory</span>. Every save archives the
            previous version under <span className="inline-code">memory-history/</span>.
          </p>
          {loaded ? (
            <textarea
              className="textarea"
              style={{ minHeight: 260 }}
              value={memory}
              onChange={(event) => setMemory(event.target.value)}
              placeholder="Project memory…"
            />
          ) : (
            <Spinner label="Loading memory…" />
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={() => void saveMemory()} disabled={busy === 'memory' || !loaded}>
              {busy === 'memory' ? <Spinner /> : <Archive size={13} />} Save memory
            </button>
            <span className="faint small">{memory.length} characters</span>
          </div>
        </>
      ) : null}

      {tab === 'danger' ? (
        <>
          <div className="data-card">
            <h4>Remove from dashboard</h4>
            <p className="faint small">
              Moves this project's chats, plans, memory and permissions into{' '}
              <span className="inline-code">backups/removed-project-*</span>. Source files are never
              touched. This can be reversed manually from the data folder.
            </p>
            <button
              className="btn"
              onClick={() =>
                setConfirm({
                  title: `Remove "${project.name}" from the dashboard?`,
                  message:
                    'The project is hidden from the dashboard and its application data is archived under backups/. Your source files stay untouched.',
                  label: 'Remove from dashboard',
                  danger: false,
                  action: async () => {
                    setConfirm(null);
                    await removeProject(project.id, false);
                    closeModal('projectSettings');
                  },
                })
              }
            >
              <Archive size={13} /> Remove from dashboard
            </button>
          </div>

          <div className="data-card" style={{ borderColor: 'rgba(255,107,107,0.35)' }}>
            <h4 style={{ color: 'var(--danger)' }}>Delete application data permanently</h4>
            <p className="faint small">
              Deletes chats, plans, memory, instructions and stored permissions for this project from
              the application data folder. The project's source folder is not deleted. This cannot
              be undone unless you have a backup.
            </p>
            <button
              className="btn danger"
              onClick={() =>
                setConfirm({
                  title: 'Delete application data permanently?',
                  message:
                    'This deletes the project’s chats, plans, memory and permissions from the data folder. Source files remain. Create a backup first if you may need this data.',
                  label: 'Delete data',
                  danger: true,
                  action: async () => {
                    const typed = window.prompt(`Type "${project.name}" to confirm permanent deletion:`);
                    if (typed !== project.name) {
                      toast('Deletion cancelled: name did not match.', 'warning');
                      setConfirm(null);
                      return;
                    }
                    setConfirm(null);
                    await removeProject(project.id, true);
                    closeModal('projectSettings');
                  },
                })
              }
            >
              <Trash2 size={13} /> Delete application data
            </button>
          </div>
        </>
      ) : null}

      {confirm ? (
        <ConfirmDialog
          title={confirm.title}
          message={<div style={{ whiteSpace: 'pre-wrap' }}>{confirm.message}</div>}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirm.action()}
        />
      ) : null}
    </Modal>
  );
}
