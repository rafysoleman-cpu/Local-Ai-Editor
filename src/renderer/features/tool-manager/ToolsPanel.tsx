import { useEffect, useMemo, useState } from 'react';
import { Plus, ShieldCheck, Trash2, Wrench, X } from 'lucide-react';
import type { CustomToolDefinition, ToolExecutionLogEntry } from '@shared/app-types';
import { Modal, Spinner } from '../../components/ui';
import { useApp } from '../../state/store';
import { formatError } from '../../services/api';

type Tab = 'tools' | 'history' | 'permissions' | 'custom';

function parseParameters(raw: string): Array<{ name: string; description: string; required: boolean }> {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const required = !entry.endsWith('?');
      const name = required ? entry : entry.slice(0, -1);
      return { name, description: `Value for ${name}`, required };
    });
}

export function ToolsPanel() {
  const tools = useApp((state) => state.tools);
  const permissions = useApp((state) => state.permissions);
  const project = useApp((state) => state.project);
  const toggleTool = useApp((state) => state.toggleTool);
  const refreshPermissions = useApp((state) => state.refreshPermissions);
  const revokePermission = useApp((state) => state.revokePermission);
  const refreshTools = useApp((state) => state.refreshTools);
  const closeModal = useApp((state) => state.closeModal);
  const toast = useApp((state) => state.toast);

  const [tab, setTab] = useState<Tab>('tools');
  const [history, setHistory] = useState<ToolExecutionLogEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [customTools, setCustomTools] = useState<CustomToolDefinition[]>([]);
  const [customName, setCustomName] = useState('');
  const [customDescription, setCustomDescription] = useState('');
  const [customCommand, setCustomCommand] = useState('');
  const [customParameters, setCustomParameters] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);

  const loadCustom = async (): Promise<void> => {
    try {
      setCustomTools(await window.desktop.tools.custom.list());
    } catch (error) {
      toast(formatError(error), 'error');
    }
  };

  useEffect(() => {
    void loadCustom();
    void refreshTools();
    void refreshPermissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab !== 'history' || !project) return;
    setHistoryLoading(true);
    window.desktop.tools
      .history(project.id, 100)
      .then(setHistory)
      .catch((error) => toast(formatError(error), 'error'))
      .finally(() => setHistoryLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, project?.id]);

  const counts = useMemo(() => {
    return {
      total: tools.length,
      mutating: tools.filter((tool) => tool.mutating).length,
      custom: customTools.length,
      permissions: permissions.length,
    };
  }, [tools, customTools, permissions]);

  const addCustom = async (): Promise<void> => {
    setCustomError(null);
    try {
      const parameters = parseParameters(customParameters);
      await window.desktop.tools.custom.add({
        name: customName.trim(),
        description: customDescription.trim(),
        command: customCommand,
        parameters,
      });
      setCustomName('');
      setCustomDescription('');
      setCustomCommand('');
      setCustomParameters('');
      await loadCustom();
      toast('Custom tool added. Approve it to make it available to the agent.', 'success');
    } catch (error) {
      setCustomError(formatError(error));
    }
  };

  return (
    <Modal
      title="Tools & permissions"
      subtitle={`${counts.total} tools · ${counts.mutating} mutating · ${counts.custom} custom · ${counts.permissions} stored permissions`}
      onClose={() => closeModal('tools')}
      className="wide"
      footer={
        <>
          <span className="faint small">
            Permissions are scoped to this project. A stored permission never bypasses path checks.
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => closeModal('tools')}>
            Close
          </button>
        </>
      }
    >
      <div className="tabs" style={{ margin: '-16px -16px 10px' }}>
        {(
          [
            ['tools', 'Tools'],
            ['history', 'Execution history'],
            ['permissions', 'Permissions'],
            ['custom', 'Custom tools'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            className={`tab-btn ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'tools' ? (
        <div>
          {tools.length === 0 ? (
            <div className="tree-empty">Open a project to list its tools.</div>
          ) : (
            tools.map((tool) => (
              <div className="tool-row" key={tool.name}>
                <div className="tool-row-main">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="tool-row-name">{tool.name}</span>
                    {tool.source === 'custom' ? <span className="badge purple">custom</span> : null}
                    <span className={`badge ${tool.mutating ? 'warning' : 'success'}`}>
                      {tool.mutating ? 'mutating' : 'read-only'}
                    </span>
                    <span className="badge">{tool.category}</span>
                    <span className={`badge ${tool.risk === 'high' ? 'danger' : tool.risk === 'medium' ? 'warning' : ''}`}>
                      {tool.risk}
                    </span>
                    <span className="badge">{tool.modes.join('+')}</span>
                  </div>
                  <div className="tool-row-desc" title={tool.description}>
                    {tool.description}
                  </div>
                  <div className="faint small mono">{tool.inputSummary}</div>
                </div>
                <label className="switch" title={tool.enabled ? 'Disable tool' : 'Enable tool'}>
                  <input
                    type="checkbox"
                    checked={tool.enabled}
                    onChange={(event) => void toggleTool(tool.name, event.target.checked)}
                  />
                  <span />
                </label>
              </div>
            ))
          )}
        </div>
      ) : null}

      {tab === 'history' ? (
        <div>
          {historyLoading ? <Spinner label="Loading tool history…" /> : null}
          {!historyLoading && history.length === 0 ? (
            <div className="tree-empty">No tool executions recorded for this project yet.</div>
          ) : null}
          {history.map((entry) => (
            <details className="history-row" key={entry.id}>
              <summary>
                <span className={`status-dot ${entry.status === 'success' ? 'success' : entry.status === 'denied' ? 'warning' : 'error'}`} />
                <span className="mono" style={{ fontSize: 11.5 }}>{entry.toolName}</span>
                <span className="faint small">{entry.status}</span>
                <span className="spacer" style={{ flex: 1 }} />
                <span className="faint small">{entry.durationMs ?? 0} ms</span>
                <span className="faint small">{new Date(entry.startedAt).toLocaleTimeString()}</span>
              </summary>
              <div className="faint small" style={{ marginTop: 4 }}>
                permission: {entry.permission ?? 'unknown'} · run: {entry.runId ?? 'n/a'}
              </div>
              <pre>{JSON.stringify(entry.args, null, 2)}</pre>
              {entry.error ? <pre style={{ color: 'var(--danger)' }}>{entry.error}</pre> : null}
              {entry.resultPreview ? <pre>{entry.resultPreview}</pre> : null}
            </details>
          ))}
        </div>
      ) : null}

      {tab === 'permissions' ? (
        <div>
          {permissions.length === 0 ? (
            <div className="tree-empty">
              No stored permissions. "Always Allow" decisions appear here and can be revoked.
            </div>
          ) : (
            permissions.map((record) => (
              <div className="tool-row" key={record.id}>
                <ShieldCheck size={15} color="var(--success)" />
                <div className="tool-row-main">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="mono small">{record.toolName}</span>
                    <span className="badge">{record.category}</span>
                  </div>
                  <div className="faint small">{record.label}</div>
                  <div className="faint small mono">{record.actionKey}</div>
                </div>
                <span className="faint small">{new Date(record.createdAt).toLocaleDateString()}</span>
                <button className="btn sm danger" onClick={() => void revokePermission(record.id)}>
                  <X size={12} /> Revoke
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}

      {tab === 'custom' ? (
        <div>
          <div className="data-card">
            <h4>Add a custom tool</h4>
            <p className="faint small" style={{ marginTop: 0 }}>
              A custom tool is a declarative command template with named string parameters. Arbitrary
              JavaScript is never executed. Arguments are restricted, the command always runs in the
              workspace, and every invocation asks for approval.
            </p>
            <div className="field">
              <label>Name (lowercase, underscores)</label>
              <input
                className="input mono"
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder="format_check"
              />
            </div>
            <div className="field">
              <label>Description</label>
              <input
                className="input"
                value={customDescription}
                onChange={(event) => setCustomDescription(event.target.value)}
                placeholder="Checks formatting for a given path"
              />
            </div>
            <div className="field">
              <label>Command template</label>
              <input
                className="input mono"
                value={customCommand}
                onChange={(event) => setCustomCommand(event.target.value)}
                placeholder='npm run format -- "{path}"'
              />
              <span className="hint">Use {'{parameter}'} placeholders matching the parameters below.</span>
            </div>
            <div className="field">
              <label>Parameters</label>
              <input
                className="input mono"
                value={customParameters}
                onChange={(event) => setCustomParameters(event.target.value)}
                placeholder="path, check?"
              />
              <span className="hint">Comma separated. Add ? for optional.</span>
            </div>
            {customError ? <div className="message-error">{customError}</div> : null}
            <button
              className="btn"
              onClick={() => void addCustom()}
              disabled={!customName.trim() || customDescription.trim().length < 10 || !customCommand.trim()}
            >
              <Plus size={13} /> Add tool
            </button>
          </div>

          <div className="section-label" style={{ margin: '12px 0 6px' }}>
            Defined tools
          </div>
          {customTools.length === 0 ? (
            <div className="tree-empty">No custom tools defined.</div>
          ) : (
            customTools.map((tool) => (
              <div className="tool-row" key={tool.name}>
                <Wrench size={14} />
                <div className="tool-row-main">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="tool-row-name">{tool.name}</span>
                    {tool.approved ? (
                      <span className="badge success">approved</span>
                    ) : (
                      <span className="badge warning">pending approval</span>
                    )}
                  </div>
                  <div className="tool-row-desc">{tool.description}</div>
                  <div className="faint small mono">
                    {tool.command} · params: {tool.parameters.map((p) => (p.required ? p.name : `${p.name}?`)).join(', ') || 'none'}
                  </div>
                </div>
                {!tool.approved ? (
                  <button
                    className="btn sm"
                    onClick={async () => {
                      try {
                        await window.desktop.tools.custom.approve(tool.name);
                        await loadCustom();
                        await refreshTools();
                        toast('Custom tool approved.', 'success');
                      } catch (error) {
                        toast(formatError(error), 'error');
                      }
                    }}
                  >
                    Approve
                  </button>
                ) : null}
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    if (!window.confirm(`Remove custom tool "${tool.name}"?`)) return;
                    try {
                      await window.desktop.tools.custom.remove(tool.name);
                      await loadCustom();
                      await refreshTools();
                    } catch (error) {
                      toast(formatError(error), 'error');
                    }
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
    </Modal>
  );
}
