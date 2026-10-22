import Editor from '@monaco-editor/react';
import { FileCode2, Save, X } from 'lucide-react';
import { useApp } from '../../state/store';
import './monaco-setup';

export function EditorPane() {
  const tabs = useApp((state) => state.tabs);
  const activeTab = useApp((state) => state.activeTab);
  const settings = useApp((state) => state.settings);
  const project = useApp((state) => state.project);
  const updateTabContent = useApp((state) => state.updateTabContent);
  const saveTab = useApp((state) => state.saveTab);
  const closeTab = useApp((state) => state.closeTab);
  const reloadTab = useApp((state) => state.reloadTab);
  const openModal = useApp((state) => state.openModal);

  const tab = tabs.find((entry) => entry.relativePath === activeTab) ?? null;
  const theme = settings?.theme === 'light' ? 'laie-light' : 'laie-dark';

  const requestClose = (relativePath: string, dirty: boolean): void => {
    if (dirty && !window.confirm(`"${relativePath}" has unsaved changes. Close it anyway?`)) return;
    void closeTab(relativePath);
  };

  return (
    <section className="editor-pane">
      <div className="editor-tabs">
        {tabs.map((entry) => (
          <div
            key={entry.relativePath}
            className={`tab ${entry.relativePath === activeTab ? 'active' : ''}`}
            onClick={() => {
              useApp.setState({ activeTab: entry.relativePath });
            }}
            title={entry.relativePath}
          >
            {entry.dirty ? <span className="tab-dirty-dot" /> : null}
            <span className="tab-label">{entry.relativePath.split('/').pop()}</span>
            <button
              className="tab-close"
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                requestClose(entry.relativePath, entry.dirty);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        {tab?.dirty ? (
          <button
            className="icon-btn"
            title="Save (Ctrl+S)"
            style={{ margin: '0 4px', alignSelf: 'center' }}
            onClick={() => void saveTab(tab.relativePath)}
          >
            <Save size={14} />
          </button>
        ) : null}
      </div>

      {tab?.readOnly || tab?.externalChange ? (
        <div className="editor-banner">
          {tab.externalChange
            ? 'This file changed on disk while it was open.'
            : `Opened read-only${tab.truncated ? ' because it is larger than 2 MB' : ''}.`}
          {tab.externalChange ? (
            <>
              <span className="spacer" style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => void reloadTab(tab.relativePath)}>
                Reload from disk
              </button>
              <button
                className="btn sm ghost"
                onClick={() =>
                  useApp.setState((state) => ({
                    tabs: state.tabs.map((entry) =>
                      entry.relativePath === tab.relativePath
                        ? { ...entry, externalChange: false }
                        : entry,
                    ),
                  }))
                }
              >
                Keep my version
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="editor-surface">
        {tab ? (
          <Editor
            key={tab.relativePath}
            path={tab.relativePath}
            language={tab.language}
            value={tab.content}
            theme={theme}
            onChange={(value) => updateTabContent(tab.relativePath, value ?? '')}
            loading={<div className="tree-empty">Loading editor…</div>}
            options={{
              readOnly: tab.readOnly,
              automaticLayout: true,
              fontSize: 13,
              fontFamily: "Cascadia Mono, JetBrains Mono, Consolas, monospace",
              minimap: { enabled: true, maxColumn: 80 },
              scrollBeyondLastLine: false,
              renderWhitespace: 'selection',
              tabSize: 2,
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              padding: { top: 10 },
              bracketPairColorization: { enabled: true },
              wordWrap: 'off',
              fixedOverflowWidgets: true,
            }}
          />
        ) : (
          <div className="editor-welcome">
            <FileCode2 size={34} strokeWidth={1.2} />
            <h2>{project?.name ?? 'No project'}</h2>
            <p style={{ margin: 0, maxWidth: 430, lineHeight: 1.6 }}>
              Open a file from the explorer, or press{' '}
              <span className="kbd">Ctrl</span> + <span className="kbd">P</span> to search files.
              The agent can also edit files; changes appear here after each run.
            </p>
            <div className="kbd-row">
              <span className="kbd">Ctrl</span>+<span className="kbd">J</span>
              <span className="faint">terminal</span>
              <span style={{ width: 12 }} />
              <span className="kbd">Ctrl</span>+<span className="kbd">S</span>
              <span className="faint">save</span>
            </div>
            <div className="recent-files">
              <button className="btn sm" onClick={() => openModal('quickOpen')}>
                Quick open file…
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
