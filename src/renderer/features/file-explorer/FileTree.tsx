import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { FileEntry } from '@shared/app-types';
import { useApp } from '../../state/store';
import { formatError } from '../../services/api';

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentOf(relativePath: string): string {
  const index = relativePath.lastIndexOf('/');
  return index >= 0 ? relativePath.slice(0, index) : '';
}

export function FileTree() {
  const project = useApp((state) => state.project);
  const treeVersion = useApp((state) => state.treeVersion);
  const bumpTree = useApp((state) => state.bumpTree);
  const openFile = useApp((state) => state.openFile);
  const activeTab = useApp((state) => state.activeTab);
  const createEntry = useApp((state) => state.createEntry);
  const renameEntry = useApp((state) => state.renameEntry);
  const deleteEntry = useApp((state) => state.deleteEntry);
  const toast = useApp((state) => state.toast);

  const [entries, setEntries] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(
    async (relativePath: string): Promise<void> => {
      if (!project) return;
      setLoading((current) => new Set(current).add(relativePath));
      try {
        const list = await window.desktop.fs.list(project.id, relativePath, false);
        setEntries((current) => ({ ...current, [relativePath]: list }));
        setError(null);
      } catch (loadError) {
        setError(formatError(loadError));
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(relativePath);
          return next;
        });
      }
    },
    [project],
  );

  useEffect(() => {
    if (!project) return;
    void loadDir('');
    for (const directory of expanded) {
      if (directory) void loadDir(directory);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, treeVersion, loadDir]);

  const toggle = (relativePath: string): void => {
    if (expanded.has(relativePath)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(relativePath);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(relativePath));
    void loadDir(relativePath);
  };

  const promptNew = async (directory: string, type: 'file' | 'directory'): Promise<void> => {
    const label = type === 'file' ? 'File name' : 'Folder name';
    const value = window.prompt(`${label} in ${directory || 'project root'}:`, type === 'file' ? 'new-file.ts' : 'new-folder');
    if (!value) return;
    const trimmed = value.trim().replace(/^[/\\]+/, '');
    if (!trimmed) return;
    await createEntry(joinPath(directory, trimmed), type);
  };

  const promptRename = async (entry: FileEntry): Promise<void> => {
    const next = window.prompt(`Rename "${entry.name}" to:`, entry.name);
    if (!next || next.trim() === entry.name || !next.trim()) return;
    await renameEntry(entry.relativePath, joinPath(parentOf(entry.relativePath), next.trim()));
  };

  const promptDelete = async (entry: FileEntry): Promise<void> => {
    const confirmed = window.confirm(
      `Delete ${entry.type === 'directory' ? 'folder' : 'file'} "${entry.relativePath}"?\n\nThis deletes it from disk and cannot be undone from the app.`,
    );
    if (!confirmed) return;
    await deleteEntry(entry.relativePath);
  };

  const renderEntries = (directory: string, depth: number): ReactNode => {
    const list = entries[directory];
    if (!list) {
      return loading.has(directory) ? <div className="tree-empty">Loading…</div> : null;
    }
    if (list.length === 0) {
      return depth === 0 ? <div className="tree-empty">Empty folder</div> : null;
    }
    return list.map((entry) => (
      <div key={entry.relativePath}>
        <div
          className={`tree-row ${entry.type === 'file' && activeTab === entry.relativePath ? 'active' : ''}`}
          style={{ paddingLeft: 6 }}
          onClick={() => {
            if (entry.type === 'directory') toggle(entry.relativePath);
            else void openFile(entry.relativePath);
          }}
          title={entry.relativePath}
        >
          <span className="tree-icon">
            {entry.type === 'directory' ? (
              expanded.has(entry.relativePath) ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )
            ) : (
              <span style={{ width: 13 }} />
            )}
          </span>
          <span className="tree-icon">
            {entry.type === 'directory' ? (
              expanded.has(entry.relativePath) ? (
                <FolderOpen size={13} />
              ) : (
                <Folder size={13} />
              )
            ) : (
              <File size={13} />
            )}
          </span>
          <span className="tree-label">{entry.name}</span>
          <span className="tree-actions">
            {entry.type === 'directory' ? (
              <>
                <button
                  className="icon-btn"
                  style={{ width: 19, height: 19 }}
                  title="New file here"
                  onClick={(event) => {
                    event.stopPropagation();
                    void promptNew(entry.relativePath, 'file');
                  }}
                >
                  <FilePlus2 size={11} />
                </button>
                <button
                  className="icon-btn"
                  style={{ width: 19, height: 19 }}
                  title="New folder here"
                  onClick={(event) => {
                    event.stopPropagation();
                    void promptNew(entry.relativePath, 'directory');
                  }}
                >
                  <FolderPlus size={11} />
                </button>
              </>
            ) : null}
            <button
              className="icon-btn"
              style={{ width: 19, height: 19 }}
              title="Rename"
              onClick={(event) => {
                event.stopPropagation();
                void promptRename(entry);
              }}
            >
              <Pencil size={11} />
            </button>
            <button
              className="icon-btn"
              style={{ width: 19, height: 19 }}
              title="Delete"
              onClick={(event) => {
                event.stopPropagation();
                void promptDelete(entry);
              }}
            >
              <Trash2 size={11} />
            </button>
          </span>
        </div>
        {entry.type === 'directory' && expanded.has(entry.relativePath) ? (
          <div className="tree-children">{renderEntries(entry.relativePath, depth + 1)}</div>
        ) : null}
      </div>
    ));
  };

  if (!project) return null;

  return (
    <div className="sidebar-section grow">
      <div className="section-header">
        <span>Files</span>
        <span className="spacer" />
        <button className="icon-btn" title="New file" onClick={() => void promptNew('', 'file')}>
          <FilePlus2 size={13} />
        </button>
        <button className="icon-btn" title="New folder" onClick={() => void promptNew('', 'directory')}>
          <FolderPlus size={13} />
        </button>
        <button
          className="icon-btn"
          title="Refresh tree"
          onClick={() => {
            bumpTree();
            toast('File tree refreshed.', 'info');
          }}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="file-tree">
        {error ? (
          <div className="tree-empty" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        ) : null}
        {renderEntries('', 0)}
      </div>
    </div>
  );
}
