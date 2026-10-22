import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RotateCcw, Square, Trash2, X } from 'lucide-react';
import type { TerminalChunk, TerminalExit } from '@shared/app-types';
import '@xterm/xterm/css/xterm.css';
import { useApp } from '../../state/store';
import { formatError } from '../../services/api';

export function TerminalPanel() {
  const project = useApp((state) => state.project);
  const setTerminalOpen = useApp((state) => state.setTerminalOpen);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const bufferRef = useRef('');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const busyRef = useRef(false);
  const pendingChunksRef = useRef<TerminalChunk[]>([]);

  const [status, setStatus] = useState<'connecting' | 'ready' | 'busy' | 'error'>('connecting');
  const [lastExit, setLastExit] = useState<TerminalExit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState(0);

  useEffect(() => {
    if (!project || !hostRef.current) return;
    let disposed = false;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: "Cascadia Mono, JetBrains Mono, Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 6000,
      convertEol: true,
      theme: {
        background: '#080b10',
        foreground: '#cfe0f5',
        cursor: '#7aa2ff',
        selectionBackground: '#26406e',
        black: '#0b1017',
        brightBlack: '#5c6f86',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    term.focus();

    const write = (data: string): void => {
      term.write(data);
    };

    const onChunk = window.desktop.events.onTerminalChunk((chunk: TerminalChunk) => {
      const sessionId = sessionRef.current;
      if (!sessionId) {
        pendingChunksRef.current.push(chunk);
        return;
      }
      if (chunk.sessionId !== sessionId) return;
      term.write(chunk.data);
    });

    const onExit = window.desktop.events.onTerminalExit((exit: TerminalExit) => {
      if (exit.sessionId !== sessionRef.current) return;
      busyRef.current = false;
      setStatus('ready');
      setLastExit(exit);
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* host may be hidden */
      }
    });
    resizeObserver.observe(hostRef.current);

    const sendLine = (line: string): void => {
      const sessionId = sessionRef.current;
      if (!sessionId) return;
      busyRef.current = true;
      setStatus('busy');
      void window.desktop.terminal.input(sessionId, line).catch((inputError) => {
        setError(formatError(inputError));
        busyRef.current = false;
        setStatus('ready');
      });
    };

    const clearCurrentLine = (): void => {
      const length = bufferRef.current.length;
      if (length > 0) write(`\b \b`.repeat(length));
      bufferRef.current = '';
    };

    const replaceLine = (line: string): void => {
      clearCurrentLine();
      bufferRef.current = line;
      write(line);
    };

    const handleKey = (data: string): void => {
      if (data === '\u0003') {
        write('^C');
        bufferRef.current = '';
        if (busyRef.current && sessionRef.current) {
          void window.desktop.terminal.stop(sessionRef.current);
        }
        return;
      }
      if (busyRef.current) return;

      if (data === '\r') {
        write('\r\n');
        const line = bufferRef.current;
        bufferRef.current = '';
        historyIndexRef.current = -1;
        if (line.trim()) {
          historyRef.current.push(line);
          if (historyRef.current.length > 100) historyRef.current.shift();
        }
        sendLine(line);
        return;
      }
      if (data === '\u007f') {
        if (bufferRef.current.length > 0) {
          bufferRef.current = bufferRef.current.slice(0, -1);
          write('\b \b');
        }
        return;
      }
      if (data === '\u000c') {
        sendLine('clear');
        return;
      }
      if (data === '\u001b[A' || data === '\u001b[B') {
        const history = historyRef.current;
        if (history.length === 0) return;
        let index = historyIndexRef.current;
        if (data === '\u001b[A') {
          index = index < 0 ? history.length - 1 : Math.max(0, index - 1);
        } else {
          index = index < 0 ? 0 : Math.min(history.length - 1, index + 1);
        }
        historyIndexRef.current = index;
        replaceLine(history[index] ?? '');
        return;
      }
      if (data === '\t') {
        write('  ');
        bufferRef.current += '  ';
        return;
      }
      if (data.length === 1 && data >= ' ') {
        bufferRef.current += data;
        write(data);
        return;
      }
      if (data.length > 1) {
        // Paste (or multi-character input): echo printable characters only.
        for (const char of data) {
          if (char === '\r' || char === '\n') {
            handleKey('\r');
          } else if (char >= ' ') {
            bufferRef.current += char;
            write(char);
          }
        }
      }
    };

    const disposable = term.onData(handleKey);

    window.desktop.terminal
      .create(project.id)
      .then((session) => {
        if (disposed) {
          void window.desktop.terminal.kill(session.id);
          return;
        }
        sessionRef.current = session.id;
        setStatus('ready');
        for (const chunk of pendingChunksRef.current) {
          if (chunk.sessionId === session.id) term.write(chunk.data);
        }
        pendingChunksRef.current = [];
        term.focus();
      })
      .catch((createError) => {
        setStatus('error');
        setError(formatError(createError));
      });

    return () => {
      disposed = true;
      disposable.dispose();
      resizeObserver.disconnect();
      onChunk();
      onExit();
      const sessionId = sessionRef.current;
      sessionRef.current = null;
      if (sessionId) void window.desktop.terminal.kill(sessionId);
      term.dispose();
    };
  }, [project?.id, sessionKey]);

  if (!project) return null;

  return (
    <>
      <div className="terminal-dock">
        <div className="terminal-toolbar">
          <span style={{ fontWeight: 600 }}>Terminal</span>
          <span className="mono" style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {project.workspacePath}
          </span>
          {status === 'busy' ? <span className="badge warning">running</span> : null}
          {lastExit ? (
            <span className="faint">
              exit {lastExit.code ?? 'n/a'} · {lastExit.durationMs}ms
              {lastExit.cancelled ? ' · cancelled' : ''}
              {lastExit.timedOut ? ' · timed out' : ''}
            </span>
          ) : null}
          <span className="spacer" style={{ flex: 1 }} />
          {status === 'busy' ? (
            <button
              className="icon-btn"
              title="Stop the running command"
              onClick={() => {
                if (sessionRef.current) void window.desktop.terminal.stop(sessionRef.current);
              }}
            >
              <Square size={12} />
            </button>
          ) : null}
          <button
            className="icon-btn"
            title="Clear"
            onClick={() => {
              if (sessionRef.current) void window.desktop.terminal.input(sessionRef.current, 'clear');
            }}
          >
            <Trash2 size={12} />
          </button>
          <button
            className="icon-btn"
            title="Restart terminal"
            onClick={() => {
              setStatus('connecting');
              setLastExit(null);
              setError(null);
              setSessionKey((value) => value + 1);
            }}
          >
            <RotateCcw size={12} />
          </button>
          <button className="icon-btn" title="Close terminal" onClick={() => setTerminalOpen(false)}>
            <X size={13} />
          </button>
        </div>
        <div
          className="terminal-host"
          ref={hostRef}
          onClick={() => termRef.current?.focus()}
          onKeyDown={() => termRef.current?.focus()}
        />
        {error ? (
          <div className="faint small" style={{ padding: '0 10px 6px', color: 'var(--danger)' }}>
            {error}
          </div>
        ) : null}
      </div>
    </>
  );
}
