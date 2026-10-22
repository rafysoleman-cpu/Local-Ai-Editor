import { useEffect, useRef, useState } from 'react';
import { FileText, Search } from 'lucide-react';
import type { FileSearchResult } from '@shared/app-types';
import { Modal } from '../../components/ui';
import { useApp } from '../../state/store';

export function QuickOpen() {
  const project = useApp((state) => state.project);
  const openFile = useApp((state) => state.openFile);
  const closeModal = useApp((state) => state.closeModal);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!project) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      window.desktop.fs
        .searchFiles(project.id, trimmed, 40)
        .then((found) => {
          if (cancelled) return;
          setResults(found);
          setActive(0);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, project?.id]);

  const choose = (entry: FileSearchResult | undefined): void => {
    if (!entry) return;
    closeModal('quickOpen');
    void openFile(entry.relativePath);
  };

  return (
    <Modal title="Quick open" onClose={() => closeModal('quickOpen')} className="quick-open">
      <div className="quick-search">
        <Search size={15} className="faint" />
        <input
          ref={inputRef}
          value={query}
          placeholder="Type a file name…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((value) => Math.min(results.length - 1, value + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((value) => Math.max(0, value - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(results[active]);
            }
          }}
        />
        <span className="faint small">{loading ? 'searching…' : `${results.length} results`}</span>
      </div>
      <div className="quick-list">
        {results.length === 0 ? (
          <div className="quick-empty">
            {query.trim() ? 'No matching files.' : 'Start typing to search project files.'}
          </div>
        ) : (
          results.map((entry, index) => {
            const slash = entry.relativePath.lastIndexOf('/');
            const directory = slash >= 0 ? entry.relativePath.slice(0, slash + 1) : '';
            const name = slash >= 0 ? entry.relativePath.slice(slash + 1) : entry.relativePath;
            return (
              <div
                key={entry.relativePath}
                className={`quick-item ${index === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(entry)}
              >
                <FileText size={13} className="faint" />
                <span className="quick-dir">{directory}</span>
                <span>{name}</span>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
