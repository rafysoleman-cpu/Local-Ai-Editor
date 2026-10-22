import { useEffect, useState } from 'react';
import {
  Archive,
  Database,
  FolderOpen,
  HardDriveDownload,
  HardDriveUpload,
  RefreshCw,
} from 'lucide-react';
import type { BackupInfo } from '@shared/app-types';
import { Modal, ConfirmDialog, Spinner, formatBytes } from '../../components/ui';
import { useApp } from '../../state/store';
import { formatError } from '../../services/api';

type Tab = 'general' | 'agent' | 'data';

export function SettingsModal() {
  const settings = useApp((state) => state.settings);
  const bootstrap = useApp((state) => state.bootstrap);
  const dataInfo = useApp((state) => state.dataInfo);
  const refreshDataInfo = useApp((state) => state.refreshDataInfo);
  const updateSettings = useApp((state) => state.updateSettings);
  const closeModal = useApp((state) => state.closeModal);
  const openModal = useApp((state) => state.openModal);
  const toast = useApp((state) => state.toast);
  const refreshProjects = useApp((state) => state.refreshProjects);
  const refreshProvider = useApp((state) => state.refreshProvider);

  const [tab, setTab] = useState<Tab>('general');
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [cacheStats, setCacheStats] = useState<Awaited<ReturnType<typeof window.desktop.dev.cacheStats>> | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label: string; action: () => Promise<void> }>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [general, setGeneral] = useState({
    theme: settings?.theme ?? 'dark',
    maxChars: settings?.context.maxChars ?? 60000,
    maxMessages: settings?.context.maxMessages ?? 24,
    includeMemory: settings?.context.includeMemory ?? true,
    includeFileTree: settings?.context.includeFileTree ?? true,
  });
  const [agent, setAgent] = useState({
    autoApproveReadOnly: settings?.permissions.autoApproveReadOnly ?? true,
    autoApproveFileWrites: settings?.permissions.autoApproveFileWrites ?? true,
    permissionTimeoutMinutes: Math.round((settings?.permissions.permissionTimeoutMs ?? 300000) / 60000),
    maxToolCallsPerTurn: settings?.limits.maxToolCallsPerTurn ?? 16,
    maxModelIterations: settings?.limits.maxModelIterations ?? 8,
    maxRunMinutes: Math.round((settings?.limits.maxRunMs ?? 900000) / 60000),
    maxCommandSeconds: Math.round((settings?.limits.maxCommandMs ?? 180000) / 1000),
    showCacheDiagnostics: settings?.showCacheDiagnostics ?? false,
  });

  const loadBackups = async (): Promise<void> => {
    try {
      setBackups(await window.desktop.storage.listBackups());
    } catch (error) {
      toast(formatError(error), 'error');
    }
  };

  useEffect(() => {
    void refreshDataInfo();
    void loadBackups();
    void window.desktop.dev.cacheStats().then(setCacheStats).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveGeneral = async (): Promise<void> => {
    await updateSettings({
      theme: general.theme,
      context: {
        maxChars: general.maxChars,
        maxMessages: general.maxMessages,
        includeMemory: general.includeMemory,
        includeFileTree: general.includeFileTree,
      },
    });
    toast('General settings saved.', 'success');
  };

  const saveAgent = async (): Promise<void> => {
    await updateSettings({
      permissions: {
        autoApproveReadOnly: agent.autoApproveReadOnly,
        autoApproveFileWrites: agent.autoApproveFileWrites,
        permissionTimeoutMs: Math.max(5, agent.permissionTimeoutMinutes) * 60000,
      },
      limits: {
        maxToolCallsPerTurn: Math.max(1, agent.maxToolCallsPerTurn),
        maxModelIterations: Math.max(1, agent.maxModelIterations),
        maxRunMs: Math.max(10, agent.maxRunMinutes) * 60000,
        maxCommandMs: Math.max(10, agent.maxCommandSeconds) * 1000,
      },
      showCacheDiagnostics: agent.showCacheDiagnostics,
    });
    toast('Agent settings saved.', 'success');
  };

  const createBackup = async (): Promise<void> => {
    setBusy('backup');
    try {
      const backup = await window.desktop.storage.createBackup();
      toast(`Backup verified: ${backup.fileCount} files, ${formatBytes(backup.sizeBytes)}.`, 'success');
      await loadBackups();
      await refreshDataInfo();
    } catch (error) {
      toast(formatError(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const exportBackup = async (): Promise<void> => {
    const target = await window.desktop.app.pickDirectory('Choose a folder for the exported backup');
    if (!target) return;
    setBusy('export');
    try {
      const backup = await window.desktop.storage.exportBackup(target);
      toast(`Backup exported and verified at ${backup.path}`, 'success');
    } catch (error) {
      toast(formatError(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const chooseMoveTarget = async (): Promise<void> => {
    const target = await window.desktop.app.pickDirectory('Choose an empty folder for application data');
    if (!target) return;
    try {
      const validation = await window.desktop.storage.validateTarget(target);
      if (!validation.ok) {
        toast(validation.reason ?? 'Invalid destination.', 'error');
        return;
      }
      setMoveTarget(target);
    } catch (error) {
      toast(formatError(error), 'error');
    }
  };

  const performMove = async (): Promise<void> => {
    if (!moveTarget) return;
    setBusy('move');
    setConfirm(null);
    try {
      const result = await window.desktop.storage.moveData(moveTarget);
      const fresh = await window.desktop.app.bootstrap();
      useApp.setState({ bootstrap: fresh, settings: fresh.settings });
      await refreshProjects();
      await refreshDataInfo();
      await loadBackups();
      setMoveTarget(null);
      toast(
        `Data moved and verified at ${result.newDirectory}. The original was kept at ${result.previousDirectory}.`,
        'success',
      );
    } catch (error) {
      toast(formatError(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const restoreBackup = async (backup: BackupInfo): Promise<void> => {
    setConfirm({
      title: `Restore "${backup.label}"?`,
      message: `This replaces the current settings, projects and chats with the contents of this backup. A safety backup is created first.\n\nBackup: ${backup.path}\nCreated: ${new Date(backup.createdAt).toLocaleString()}`,
      label: 'Restore backup',
      action: async () => {
        setBusy('restore');
        setConfirm(null);
        try {
          const result = await window.desktop.storage.restoreBackup(backup.id);
          if (!result.restored) {
            toast(result.warning ?? 'Restore verification failed.', 'error');
          } else {
            toast('Backup restored and verified.', 'success');
          }
          const fresh = await window.desktop.app.bootstrap();
          useApp.setState({ bootstrap: fresh, settings: fresh.settings });
          await refreshProjects();
          await refreshDataInfo();
          await loadBackups();
          await refreshProvider(true);
          const current = useApp.getState().project;
          if (current) {
            const exists = (await window.desktop.projects.list()).some((entry) => entry.id === current.id);
            if (exists) await useApp.getState().openProject(current.id);
            else await useApp.getState().closeProject();
          }
        } catch (error) {
          toast(formatError(error), 'error');
        } finally {
          setBusy(null);
        }
      },
    });
  };

  const deleteBackupNote = (
    <p className="faint small" style={{ marginBottom: 0 }}>
      Backups contain application settings, projects, chats, plans and permissions. They do not
      include local model files, your project source folders, or installed tools.
    </p>
  );

  return (
    <Modal
      title="Settings"
      subtitle={
        bootstrap
          ? `Local AI Editor ${bootstrap.appVersion} · Electron ${bootstrap.electronVersion} · Node ${bootstrap.nodeVersion}`
          : undefined
      }
      onClose={() => closeModal('settings')}
      className="xwide"
      footer={
        <>
          <span className="faint small">Application data never leaves this machine.</span>
          <span className="spacer" />
          <button className="btn" onClick={() => closeModal('settings')}>
            Close
          </button>
        </>
      }
    >
      <div className="settings-layout" style={{ margin: '-16px' }}>
        <nav className="settings-nav">
          <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>
            General
          </button>
          <button className={tab === 'agent' ? 'active' : ''} onClick={() => setTab('agent')}>
            Agent &amp; permissions
          </button>
          <button className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')}>
            Data &amp; storage
          </button>
        </nav>

        <div className="settings-content">
          {tab === 'general' ? (
            <>
              <h3>General</h3>
              <p className="section-desc">Theme, context budget and model selection.</p>
              <div className="field">
                <label htmlFor="theme-select">Theme</label>
                <select
                  id="theme-select"
                  className="select"
                  value={general.theme}
                  onChange={(event) => setGeneral({ ...general, theme: event.target.value as 'dark' | 'light' })}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </div>
              <div className="field">
                <label>Default model</label>
                <div className="row">
                  <span className="inline-code">{settings?.defaultModel ?? '(none selected)'}</span>
                  <button
                    className="btn sm"
                    onClick={() => {
                      closeModal('settings');
                      openModal('models');
                    }}
                  >
                    Change model
                  </button>
                </div>
              </div>
              <div className="divider" />
              <div className="field-row">
                <div className="field">
                  <label htmlFor="max-chars">Context budget (characters)</label>
                  <input
                    id="max-chars"
                    className="input"
                    type="number"
                    min={4000}
                    step={2000}
                    value={general.maxChars}
                    onChange={(event) => setGeneral({ ...general, maxChars: Number(event.target.value) })}
                  />
                  <span className="hint">Roughly 4 characters per token. Older messages are dropped first.</span>
                </div>
                <div className="field">
                  <label htmlFor="max-messages">Recent messages to include</label>
                  <input
                    id="max-messages"
                    className="input"
                    type="number"
                    min={2}
                    max={500}
                    value={general.maxMessages}
                    onChange={(event) => setGeneral({ ...general, maxMessages: Number(event.target.value) })}
                  />
                </div>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={general.includeMemory}
                  onChange={(event) => setGeneral({ ...general, includeMemory: event.target.checked })}
                />
                <span><strong>Include project memory</strong><br />Concise stable facts maintained per project.</span>
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={general.includeFileTree}
                  onChange={(event) => setGeneral({ ...general, includeFileTree: event.target.checked })}
                />
                <span><strong>Include a partial file tree</strong><br />Generated folders are omitted; cached for five minutes.</span>
              </label>
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn primary" onClick={() => void saveGeneral()}>
                  Save general settings
                </button>
              </div>
            </>
          ) : null}

          {tab === 'agent' ? (
            <>
              <h3>Agent &amp; permissions</h3>
              <p className="section-desc">
                Control when the agent may act without asking. Deletes and shell commands always ask
                unless you explicitly stored a permission for that exact action.
              </p>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={agent.autoApproveReadOnly}
                  onChange={(event) => setAgent({ ...agent, autoApproveReadOnly: event.target.checked })}
                />
                <span>
                  <strong>Auto-approve read-only operations</strong>
                  <br />
                  Listing files, reading files, git status/diff and safe inspection commands.
                </span>
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={agent.autoApproveFileWrites}
                  onChange={(event) => setAgent({ ...agent, autoApproveFileWrites: event.target.checked })}
                />
                <span>
                  <strong>Auto-approve file edits inside the workspace</strong>
                  <br />
                  Creates, writes and edits. Deletes never use this setting.
                </span>
              </label>
              <div className="field-row" style={{ marginTop: 10 }}>
                <div className="field">
                  <label htmlFor="permission-timeout">Approval timeout (minutes)</label>
                  <input
                    id="permission-timeout"
                    className="input"
                    type="number"
                    min={1}
                    value={agent.permissionTimeoutMinutes}
                    onChange={(event) =>
                      setAgent({ ...agent, permissionTimeoutMinutes: Number(event.target.value) })
                    }
                  />
                  <span className="hint">Unanswered requests fail closed (denied).</span>
                </div>
                <div className="field">
                  <label htmlFor="cache-toggle">Cache diagnostics</label>
                  <select
                    id="cache-toggle"
                    className="select"
                    value={agent.showCacheDiagnostics ? 'on' : 'off'}
                    onChange={(event) =>
                      setAgent({ ...agent, showCacheDiagnostics: event.target.value === 'on' })
                    }
                  >
                    <option value="off">Hidden</option>
                    <option value="on">Show in status</option>
                  </select>
                </div>
              </div>
              <div className="divider" />
              <div className="section-label" style={{ marginBottom: 8 }}>Execution limits</div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="limit-tools">Max tool calls per run</label>
                  <input
                    id="limit-tools"
                    className="input"
                    type="number"
                    min={1}
                    value={agent.maxToolCallsPerTurn}
                    onChange={(event) => setAgent({ ...agent, maxToolCallsPerTurn: Number(event.target.value) })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="limit-iterations">Max model iterations</label>
                  <input
                    id="limit-iterations"
                    className="input"
                    type="number"
                    min={1}
                    value={agent.maxModelIterations}
                    onChange={(event) => setAgent({ ...agent, maxModelIterations: Number(event.target.value) })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="limit-run">Max run duration (minutes)</label>
                  <input
                    id="limit-run"
                    className="input"
                    type="number"
                    min={1}
                    value={agent.maxRunMinutes}
                    onChange={(event) => setAgent({ ...agent, maxRunMinutes: Number(event.target.value) })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="limit-command">Max command duration (seconds)</label>
                  <input
                    id="limit-command"
                    className="input"
                    type="number"
                    min={1}
                    value={agent.maxCommandSeconds}
                    onChange={(event) => setAgent({ ...agent, maxCommandSeconds: Number(event.target.value) })}
                  />
                </div>
              </div>
              <div className="row">
                <button className="btn primary" onClick={() => void saveAgent()}>
                  Save agent settings
                </button>
              </div>
              <div className="divider" />
              <div className="section-label" style={{ marginBottom: 6 }}>Context cache</div>
              <div className="row">
                <button
                  className="btn sm"
                  onClick={() => {
                    void window.desktop.dev.cacheStats().then(setCacheStats);
                  }}
                >
                  <RefreshCw size={12} /> Refresh stats
                </button>
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    void window.desktop.dev.clearCache();
                    void window.desktop.dev.cacheStats().then(setCacheStats);
                    toast('Context cache cleared.', 'info');
                  }}
                >
                  Clear cache
                </button>
              </div>
              <pre className="tool-result" style={{ marginTop: 8 }}>
                {cacheStats ? JSON.stringify(cacheStats, null, 2) : 'No cache statistics yet.'}
              </pre>
            </>
          ) : null}

          {tab === 'data' ? (
            <>
              <h3>Data &amp; storage</h3>
              <p className="section-desc">
                Application data lives in one dedicated folder, separate from your source code.
                Moving it copies and verifies everything before switching.
              </p>
              <div className="data-card">
                <h4>Current location</h4>
                <div className="data-path">{dataInfo?.dataDirectory ?? bootstrap?.dataDirectory ?? '—'}</div>
                <div className="stat-grid" style={{ marginTop: 10 }}>
                  <div className="stat">
                    <div className="stat-label">Storage size</div>
                    <div className="stat-value">{formatBytes(dataInfo?.sizeBytes ?? 0)}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Free disk</div>
                    <div className="stat-value">{formatBytes(dataInfo?.freeBytes ?? null)}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Projects</div>
                    <div className="stat-value">{dataInfo?.manifest?.projects.length ?? 0}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Backups</div>
                    <div className="stat-value">{dataInfo?.backupCount ?? 0}</div>
                  </div>
                </div>
                {dataInfo && !dataInfo.writable ? (
                  <div className="message-error" style={{ marginTop: 10 }}>
                    The data folder is not writable. Changes cannot be saved.
                  </div>
                ) : null}
                <div className="row wrap" style={{ marginTop: 10 }}>
                  <button className="btn sm" onClick={() => void window.desktop.app.openDataDir()}>
                    <FolderOpen size={12} /> Open data folder
                  </button>
                  <button className="btn sm" onClick={() => void refreshDataInfo()}>
                    <RefreshCw size={12} /> Refresh
                  </button>
                </div>
              </div>

              <div className="data-card">
                <h4>Backups</h4>
                <div className="row wrap">
                  <button className="btn sm" onClick={() => void createBackup()} disabled={busy === 'backup'}>
                    {busy === 'backup' ? <Spinner /> : <Archive size={12} />} Create verified backup
                  </button>
                  <button className="btn sm" onClick={() => void exportBackup()} disabled={busy === 'export'}>
                    {busy === 'export' ? <Spinner /> : <HardDriveDownload size={12} />} Export to folder…
                  </button>
                  <button className="btn sm" onClick={() => void loadBackups()}>
                    <RefreshCw size={12} /> Reload list
                  </button>
                </div>
                <div style={{ marginTop: 8 }}>
                  {backups.length === 0 ? (
                    <div className="faint small">No backups yet.</div>
                  ) : (
                    backups.slice(0, 12).map((backup) => (
                      <div className="backup-row" key={backup.id}>
                        <span className={`status-dot ${backup.verified ? 'success' : 'warning'}`} />
                        <span className="backup-name" title={backup.path}>
                          {backup.label} · {new Date(backup.createdAt).toLocaleString()}
                        </span>
                        <span className="faint small">
                          {backup.fileCount} files · {formatBytes(backup.sizeBytes)}
                        </span>
                        <button
                          className="btn sm ghost"
                          onClick={() => void restoreBackup(backup)}
                          disabled={busy === 'restore' || !backup.verified}
                          title={backup.verified ? 'Restore this backup' : 'Backup failed verification'}
                        >
                          <HardDriveUpload size={12} /> Restore
                        </button>
                      </div>
                    ))
                  )}
                </div>
                {deleteBackupNote}
              </div>

              <div className="data-card">
                <h4>Move application data</h4>
                <p className="faint small" style={{ marginTop: 0 }}>
                  Copies everything to an empty folder, verifies the copy, then switches the active
                  location. The original folder is kept intact; delete it manually after checking.
                </p>
                <div className="row">
                  <button className="btn" onClick={() => void chooseMoveTarget()} disabled={Boolean(busy)}>
                    <Database size={13} /> Choose destination…
                  </button>
                  {moveTarget ? <span className="inline-code">{moveTarget}</span> : null}
                </div>
                {moveTarget ? (
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn primary" onClick={() => void performMove()} disabled={busy === 'move'}>
                      {busy === 'move' ? <Spinner /> : <Database size={13} />} Move data here
                    </button>
                    <button className="btn ghost" onClick={() => setMoveTarget(null)} disabled={busy === 'move'}>
                      Cancel
                    </button>
                  </div>
                ) : null}
                <p className="faint small" style={{ marginBottom: 0 }}>
                  Project source folders are not moved. If a workspace path is missing after moving
                  machines, use Project Settings to locate it again.
                </p>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {confirm ? (
        <ConfirmDialog
          title={confirm.title}
          message={<div style={{ whiteSpace: 'pre-wrap' }}>{confirm.message}</div>}
          confirmLabel={confirm.label}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirm.action()}
        />
      ) : null}
    </Modal>
  );
}
