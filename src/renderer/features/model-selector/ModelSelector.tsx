import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  Download,
  RefreshCw,
  Server,
  X,
} from 'lucide-react';
import { Modal, formatBytes, Spinner } from '../../components/ui';
import { useApp } from '../../state/store';
import { formatError } from '../../services/api';

export function ModelSelector() {
  const providerStatus = useApp((state) => state.providerStatus);
  const settings = useApp((state) => state.settings);
  const project = useApp((state) => state.project);
  const refreshProvider = useApp((state) => state.refreshProvider);
  const updateSettings = useApp((state) => state.updateSettings);
  const updateProject = useApp((state) => state.updateProject);
  const closeModal = useApp((state) => state.closeModal);
  const pull = useApp((state) => state.pull);
  const toast = useApp((state) => state.toast);

  const [refreshing, setRefreshing] = useState(false);
  const [pullName, setPullName] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; response: string; error: string | null; durationMs: number; model: string } | null>(null);
  const [generation, setGeneration] = useState(
    settings?.generation ?? { temperature: 0.2, topP: 0.9, numCtx: 16384 },
  );

  useEffect(() => {
    setRefreshing(true);
    void refreshProvider(true).finally(() => setRefreshing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (settings) setGeneration(settings.generation);
  }, [settings]);

  const selectedModel = useMemo(
    () =>
      providerStatus?.models.find(
        (model) => model.id === (project?.defaultModel ?? settings?.defaultModel),
      ) ?? null,
    [providerStatus, project?.defaultModel, settings?.defaultModel],
  );

  const choose = async (modelId: string, scope: 'app' | 'project'): Promise<void> => {
    try {
      if (scope === 'project' && project) {
        await updateProject({ projectId: project.id, defaultModel: modelId });
      } else {
        await updateSettings({ defaultModel: modelId });
      }
    } catch (error) {
      toast(formatError(error), 'error');
    }
  };

  const runTest = async (): Promise<void> => {
    if (!selectedModel) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.desktop.provider.test(selectedModel.id);
      setTestResult(result);
      if (!result.ok) toast(result.error ?? 'Model test failed.', 'error');
    } catch (error) {
      toast(formatError(error), 'error');
    } finally {
      setTesting(false);
    }
  };

  const startPull = async (): Promise<void> => {
    const name = pullName.trim();
    if (!name) return;
    try {
      await window.desktop.provider.pull(name);
      toast(`Downloading "${name}"…`, 'info');
    } catch (error) {
      toast(formatError(error), 'error');
    }
  };

  const cancelPull = async (): Promise<void> => {
    try {
      await window.desktop.provider.cancelPull();
    } catch (error) {
      toast(formatError(error), 'error');
    }
  };

  return (
    <Modal
      title="Local models"
      subtitle={providerStatus ? `${providerStatus.baseUrl}${providerStatus.version ? ` · Ollama ${providerStatus.version}` : ''}` : 'Checking Ollama…'}
      onClose={() => closeModal('models')}
      className="wide"
      footer={
        <>
          <span className={`status-dot ${providerStatus?.connected ? 'success' : 'error'}`} />
          <span className="faint small">
            {providerStatus?.connected
              ? `${providerStatus.models.length} installed model${providerStatus.models.length === 1 ? '' : 's'}`
              : providerStatus?.error ?? 'Not connected'}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => closeModal('models')}>
            Close
          </button>
        </>
      }
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="badge info">
          <Server size={10} /> Ollama
        </span>
        <span className={`badge ${providerStatus?.connected ? 'success' : 'danger'}`}>
          {providerStatus?.connected ? 'connected' : 'offline'}
        </span>
        <span className="spacer" />
        <button
          className="btn sm"
          onClick={() => {
            setRefreshing(true);
            void refreshProvider(true).finally(() => setRefreshing(false));
          }}
          disabled={refreshing}
        >
          {refreshing ? <Spinner /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>

      {providerStatus && !providerStatus.connected ? (
        <div className="message-error" style={{ marginBottom: 12 }}>
          {providerStatus.error ?? 'Cannot connect to Ollama.'}
          <br />
          Start it with <span className="inline-code">ollama serve</span>, then refresh. The app never
          downloads models without your action.
        </div>
      ) : null}

      <div className="section-label" style={{ marginBottom: 4 }}>
        Installed models
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: 14, overflow: 'hidden' }}>
        {providerStatus && providerStatus.models.length > 0 ? (
          providerStatus.models.map((model) => {
            const isAppDefault = settings?.defaultModel === model.id;
            const isProjectDefault = project?.defaultModel === model.id;
            const selected = selectedModel?.id === model.id;
            return (
              <div key={model.id} className={`model-row ${selected ? 'selected' : ''}`}>
                <button
                  className="icon-btn"
                  title="Use as application default"
                  onClick={() => void choose(model.id, 'app')}
                >
                  {isAppDefault ? <Check size={14} color="var(--accent)" /> : <span className="status-dot" />}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="model-name">{model.id}</span>
                    {isAppDefault ? <span className="badge info">app default</span> : null}
                    {isProjectDefault ? <span className="badge success">project</span> : null}
                  </div>
                  <div className="model-meta">
                    {[model.parameterSize, model.quantization, model.contextLength ? `${model.contextLength} ctx` : null, model.sizeBytes ? formatBytes(model.sizeBytes) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <div className="cap-chips" style={{ marginTop: 4 }}>
                    {model.capabilities.length > 0 ? (
                      model.capabilities.map((capability) => (
                        <span key={capability} className={`badge ${capability === 'tools' ? 'success' : ''}`}>
                          {capability}
                        </span>
                      ))
                    ) : (
                      <span className="badge warning">
                        <AlertTriangle size={9} /> capabilities unknown
                      </span>
                    )}
                    {!model.supportsTools ? (
                      <span className="badge warning" title="Tool calling was not reported by the provider">
                        no tool support reported
                      </span>
                    ) : null}
                  </div>
                </div>
                {project ? (
                  <button
                    className="btn sm ghost"
                    title="Use for this project"
                    onClick={() => void choose(model.id, 'project')}
                    disabled={isProjectDefault}
                  >
                    {isProjectDefault ? 'Project default' : 'Use for project'}
                  </button>
                ) : null}
                <button
                  className="btn sm"
                  onClick={async () => {
                    setTesting(true);
                    setTestResult(null);
                    try {
                      setTestResult(await window.desktop.provider.test(model.id));
                    } catch (error) {
                      toast(formatError(error), 'error');
                    } finally {
                      setTesting(false);
                    }
                  }}
                  disabled={testing}
                >
                  Test
                </button>
              </div>
            );
          })
        ) : (
          <div className="tree-empty" style={{ padding: 18 }}>
            {providerStatus?.connected
              ? 'No models installed. Pull one below.'
              : 'Connect to Ollama to see installed models.'}
          </div>
        )}
      </div>

      <div className="section-label" style={{ marginBottom: 4 }}>
        Download a model
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          className="input mono"
          placeholder="e.g. qwen3:8b, llama3.2:3b, gemma3:4b"
          value={pullName}
          onChange={(event) => setPullName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void startPull();
          }}
        />
        <button className="btn" onClick={() => void startPull()} disabled={!pullName.trim() || Boolean(pull && !pull.done)}>
          <Download size={13} /> Pull
        </button>
      </div>
      {pull ? (
        <div style={{ marginBottom: 12 }}>
          <div className="row small" style={{ marginBottom: 4 }}>
            <span className="mono">{pull.model}</span>
            <span className="faint">{pull.status}</span>
            <span className="spacer" />
            <span className="faint">{pull.percent !== null ? `${pull.percent}%` : ''}</span>
            {!pull.done ? (
              <button className="btn sm ghost" onClick={() => void cancelPull()}>
                <X size={12} /> Cancel
              </button>
            ) : null}
          </div>
          <div className="progress">
            <div style={{ width: `${pull.percent ?? 8}%` }} />
          </div>
          {pull.total > 0 ? (
            <div className="faint small" style={{ marginTop: 3 }}>
              {formatBytes(pull.completed)} / {formatBytes(pull.total)}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="divider" />
      <div className="section-label" style={{ marginBottom: 8 }}>
        Generation settings
      </div>
      <div className="field-row">
        <div className="field">
          <label>Temperature ({generation.temperature})</label>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={generation.temperature}
            onChange={(event) =>
              setGeneration({ ...generation, temperature: Number(event.target.value) })
            }
          />
        </div>
        <div className="field">
          <label>Top P ({generation.topP})</label>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={generation.topP}
            onChange={(event) => setGeneration({ ...generation, topP: Number(event.target.value) })}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="num-ctx">Context length (num_ctx)</label>
        <input
          id="num-ctx"
          className="input"
          type="number"
          min={1024}
          step={1024}
          value={generation.numCtx}
          onChange={(event) => setGeneration({ ...generation, numCtx: Number(event.target.value) })}
        />
        <span className="hint">
          Larger context uses more memory. The provider may cap this to the model's maximum.
        </span>
      </div>
      <div className="row">
        <button
          className="btn"
          onClick={() => void updateSettings({ generation })}
        >
          Save generation settings
        </button>
        {project?.defaultModel ? (
          <button
            className="btn ghost"
            onClick={() => void updateProject({ projectId: project.id, defaultModel: null })}
          >
            Clear project override
          </button>
        ) : null}
        <span className="spacer" />
        <button className="btn" onClick={() => void runTest()} disabled={!selectedModel || testing}>
          {testing ? <Spinner /> : <Bot size={13} />} Test selected model
        </button>
      </div>

      {testResult ? (
        <div className="data-card" style={{ marginTop: 12 }}>
          <div className="row">
            <span className={`badge ${testResult.ok ? 'success' : 'danger'}`}>
              {testResult.ok ? 'response received' : 'failed'}
            </span>
            <span className="faint small">
              {testResult.model} · {testResult.durationMs} ms
            </span>
          </div>
          <pre className="tool-result" style={{ marginTop: 8 }}>
            {testResult.ok ? testResult.response : testResult.error}
          </pre>
        </div>
      ) : null}
    </Modal>
  );
}
