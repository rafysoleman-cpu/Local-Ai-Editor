import { useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Modal } from '../../components/ui';
import { useApp } from '../../state/store';
import { formatError } from '../../services/api';

export function NewProjectDialog({
  mode,
  onClose,
}: {
  mode: 'new' | 'existing';
  onClose: () => void;
}) {
  const createProject = useApp((state) => state.createProject);
  const [name, setName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [createWorkspace, setCreateWorkspace] = useState(mode === 'new');
  const [initializeGit, setInitializeGit] = useState(mode === 'new');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const title = mode === 'new' ? 'New project' : 'Add existing folder';
  const canSubmit = useMemo(
    () => name.trim().length > 0 && workspacePath.trim().length > 0 && !busy,
    [name, workspacePath, busy],
  );

  const browse = async (): Promise<void> => {
    try {
      const selected = await window.desktop.projects.pickFolder(mode === 'new' ? 'create' : 'open');
      if (!selected) return;
      setWorkspacePath(selected);
      if (!name.trim()) {
        const base = selected.split(/[\\/]/).filter(Boolean).pop() ?? '';
        setName(base);
      }
    } catch (browseError) {
      setError(formatError(browseError));
    }
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await createProject({
        name: name.trim(),
        workspacePath: workspacePath.trim(),
        createWorkspace,
        initializeGit,
      });
      onClose();
    } catch (submitError) {
      setError(formatError(submitError));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? 'Creating…' : mode === 'new' ? 'Create project' : 'Add project'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="project-name">Project name</label>
        <input
          id="project-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My web app"
          autoFocus
        />
      </div>

      <div className="field">
        <label htmlFor="project-path">Project folder</label>
        <div className="row">
          <input
            id="project-path"
            className="input mono"
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
            placeholder="C:\dev\my-app"
          />
          <button className="btn" type="button" onClick={() => void browse()}>
            <FolderOpen size={14} /> Browse
          </button>
        </div>
        <span className="hint">
          This folder is the workspace the agent and editor operate in. It is never copied into
          application storage.
        </span>
      </div>

      {mode === 'new' ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={createWorkspace}
            onChange={(event) => setCreateWorkspace(event.target.checked)}
          />
          <span>
            <strong>Create the folder if it does not exist</strong>
            <br />
            The folder must be new or empty.
          </span>
        </label>
      ) : null}

      <label className="checkbox">
        <input
          type="checkbox"
          checked={initializeGit}
          onChange={(event) => setInitializeGit(event.target.checked)}
        />
        <span>
          <strong>Initialize a Git repository</strong>
          <br />
          Runs <span className="inline-code">git init</span> in the folder when Git is available.
        </span>
      </label>

      {error ? (
        <div className="message-error" style={{ marginTop: 12 }}>
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
