import { DiffEditor } from '@monaco-editor/react';
import { useApp } from '../../state/store';
import { Modal } from '../../components/ui';
import './monaco-setup';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  ps1: 'powershell',
  sql: 'sql',
  vue: 'html',
  svelte: 'html',
};

function languageFor(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext';
}

export function DiffModal() {
  const diff = useApp((state) => state.modals.diff);
  const closeModal = useApp((state) => state.closeModal);
  const settings = useApp((state) => state.settings);
  if (!diff) return null;

  return (
    <Modal
      title={`Diff: ${diff.path}`}
      subtitle={`${diff.changeType} · ${diff.before.split('\n').length} lines → ${diff.after.split('\n').length} lines`}
      onClose={() => closeModal('diff')}
      className="xwide"
      footer={
        <>
          <span className="faint small">
            Before/after content captured by the backend when the file was changed.
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => closeModal('diff')}>
            Close
          </button>
        </>
      }
    >
      <div style={{ height: '60vh', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <DiffEditor
          original={diff.before}
          modified={diff.after}
          language={languageFor(diff.path)}
          theme={settings?.theme === 'light' ? 'laie-light' : 'laie-dark'}
          options={{
            readOnly: true,
            automaticLayout: true,
            renderSideBySide: true,
            fontSize: 12,
            fontFamily: 'Cascadia Mono, Consolas, monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </Modal>
  );
}
