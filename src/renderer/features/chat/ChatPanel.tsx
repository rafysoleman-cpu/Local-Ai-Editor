import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Ban,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  ClipboardList,
  Clock,
  FileDiff,
  Loader2,
  MessageSquarePlus,
  Play,
  Send,
  ShieldQuestion,
  Square,
  User,
  Wrench,
  XCircle,
} from 'lucide-react';
import type {
  AgentStatusPhase,
  ChatMessage,
  Plan,
  Task,
  ToolCallRecord,
} from '@shared/app-types';
import { useApp, type RunView } from '../../state/store';

const PHASE_LABEL: Record<AgentStatusPhase, string> = {
  thinking: 'Thinking',
  inspecting: 'Inspecting files',
  awaiting_permission: 'Waiting for approval',
  running_command: 'Running command',
  editing_files: 'Editing files',
  running_tests: 'Running checks',
  verifying: 'Verifying',
  writing: 'Writing response',
  cancelled: 'Cancelled',
  completed: 'Completed',
  failed: 'Failed',
};

function toolStatusIcon(status: ToolCallRecord['status']) {
  switch (status) {
    case 'success':
      return <CheckCircle2 size={14} color="var(--success)" />;
    case 'error':
      return <XCircle size={14} color="var(--danger)" />;
    case 'denied':
      return <Ban size={14} color="var(--warning)" />;
    case 'cancelled':
      return <CircleSlash size={14} color="var(--text-faint)" />;
    case 'running':
      return <Loader2 size={14} className="spin" color="var(--accent)" />;
    case 'awaiting_permission':
      return <ShieldQuestion size={14} color="var(--warning)" />;
    default:
      return <Clock size={14} color="var(--text-faint)" />;
  }
}

function formatArgs(args: unknown): string {
  try {
    const text = JSON.stringify(args);
    return text && text !== '{}' ? text : '';
  } catch {
    return '';
  }
}

function ToolCallCard({ call }: { call: ToolCallRecord }) {
  const openModal = useApp((state) => state.openModal);
  const [open, setOpen] = useState(false);
  const argPreview = formatArgs(call.args);
  return (
    <div className="tool-card">
      <div
        className="tool-card-head"
        onClick={() => setOpen((value) => !value)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter') setOpen((value) => !value);
        }}
      >
        <span className="tool-status-icon">{toolStatusIcon(call.status)}</span>
        <span className="tool-name">{call.name}</span>
        <span className="tool-summary">{call.summary || argPreview}</span>
        {call.diff ? (
          <button
            className="btn sm ghost"
            title="Inspect diff"
            onClick={(event) => {
              event.stopPropagation();
              openModal('diff', call.diff);
            }}
          >
            <FileDiff size={12} /> diff
          </button>
        ) : null}
        <span className="tool-status-text faint small">{call.status.replace('_', ' ')}</span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </div>
      {open ? (
        <div className="tool-card-body">
          {Object.keys(call.details).length > 0 ? (
            <dl className="tool-details">
              {Object.entries(call.details).map(([key, value]) => (
                <div key={key} style={{ display: 'contents' }}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {call.error ? <pre className="tool-result" style={{ color: 'var(--danger)' }}>{call.error}</pre> : null}
          {call.result ? <pre className="tool-result">{call.result}</pre> : null}
          {!call.result && !call.error ? <div className="faint small">No output captured.</div> : null}
          <div className="row" style={{ gap: 12 }}>
            {call.durationMs !== null ? (
              <span className="faint small">{call.durationMs} ms</span>
            ) : null}
            {call.permission ? (
              <span className="faint small">permission: {call.permission}</span>
            ) : null}
            <span className="faint small">risk: {call.risk}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href && /^https?:/i.test(href)) void window.desktop.app.openExternal(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function MessageItem({ message }: { message: ChatMessage }) {
  const context = message.contextReport;
  return (
    <div className={`message ${message.role}`}>
      <div className={`message-role ${message.role}`}>
        {message.role === 'user' ? <User size={12} /> : <Bot size={12} />}
        {message.role === 'user' ? 'You' : 'Agent'}
        <span className="faint" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          {new Date(message.createdAt).toLocaleTimeString()}
        </span>
        {message.interrupted ? <span className="badge warning">interrupted</span> : null}
      </div>
      <div className="message-bubble">
        {message.role === 'assistant' ? (
          <Markdown content={message.content} />
        ) : (
          <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
        )}
      </div>
      {message.error ? <div className="message-error">{message.error}</div> : null}
      {message.toolCalls.length > 0 ? (
        <div className="tool-calls">
          {message.toolCalls.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
        </div>
      ) : null}
      <div className="message-footer">
        {message.model ? <span>{message.model}</span> : null}
        {message.mode ? <span>{message.mode} mode</span> : null}
        {context ? (
          <span title={context.notes.join('\n') || 'Context report'}>
            ≈{context.estimatedTokens} tokens · cache {context.cache}
            {context.truncated ? ' · truncated' : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span>{Math.max(0, Math.round((now - startedAt) / 1000))}s</span>;
}

function LiveRun({ run }: { run: RunView }) {
  return (
    <div className="message assistant">
      <div className="message-role">
        <Bot size={12} />
        Agent
        <span className="badge info">{PHASE_LABEL[run.phase] ?? run.phase}</span>
        <span className="faint" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          <Elapsed startedAt={run.startedAt} />
        </span>
      </div>
      <div className="message-bubble">
        {run.text ? (
          <Markdown content={run.text} />
        ) : (
          <div className="row muted" style={{ gap: 8 }}>
            <span className="spinner" /> {PHASE_LABEL[run.phase] ?? 'Working'}…
          </div>
        )}
      </div>
      {run.toolCalls.length > 0 ? (
        <div className="tool-calls">
          {run.toolCalls.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <div className="task-row">
      <span className={`status-dot ${task.status === 'completed' ? 'success' : task.status === 'failed' ? 'error' : task.status === 'in_progress' ? 'running' : task.status === 'blocked' ? 'warning' : ''}`} />
      <div className="task-title">
        {task.index + 1}. {task.title}
        {task.files.length ? <small>{task.files.join(' · ')}</small> : null}
        {task.evidence.length ? <small>{task.evidence.length} evidence entr{task.evidence.length === 1 ? 'y' : 'ies'}</small> : null}
      </div>
      <span className={`task-status ${task.status}`}>{task.status.replace('_', ' ')}</span>
    </div>
  );
}

function PlanPanel({ plan, tasks }: { plan: Plan; tasks: Task[] }) {
  const [open, setOpen] = useState(true);
  const approvePlan = useApp((state) => state.approvePlan);
  const rejectPlan = useApp((state) => state.rejectPlan);
  const setMode = useApp((state) => state.setMode);
  const chat = useApp((state) => state.chat);
  const run = useApp((state) => state.run);
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const busy = run?.status === 'running';

  useEffect(() => {
    setOpen(true);
  }, [plan.id]);

  return (
    <div className="plan-panel">
      <div className="plan-panel-head" onClick={() => setOpen((value) => !value)} role="button" tabIndex={0}>
        <ClipboardList size={14} />
        <strong style={{ fontSize: 12.5 }} className="truncate">
          {plan.title}
        </strong>
        <span className={`badge ${plan.status === 'approved' || plan.status === 'in_progress' ? 'success' : plan.status === 'rejected' ? 'danger' : plan.status === 'completed' ? 'info' : 'warning'}`}>
          {plan.status}
        </span>
        <span className="faint small">
          {completed}/{tasks.length}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>
      {open ? (
        <div className="plan-panel-body">
          {plan.summary ? <div className="plan-summary">{plan.summary}</div> : null}
          {plan.requirements.length ? (
            <div className="small muted">
              <strong>Requirements:</strong> {plan.requirements.join(' · ')}
            </div>
          ) : null}
          {plan.risks.length ? (
            <div className="small" style={{ color: 'var(--warning)' }}>
              <strong>Risks:</strong> {plan.risks.join(' · ')}
            </div>
          ) : null}
          <div className="task-list">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
          {plan.status === 'draft' ? (
            <div className="row wrap" style={{ marginTop: 2 }}>
              <button className="btn primary sm" disabled={busy} onClick={() => void approvePlan()}>
                <CheckCircle2 size={13} /> Approve plan
              </button>
              <button
                className="btn sm"
                disabled={busy}
                onClick={async () => {
                  await approvePlan();
                  await setMode('build');
                }}
              >
                <Play size={13} /> Approve &amp; switch to Build
              </button>
              <button className="btn ghost sm" disabled={busy} onClick={() => void rejectPlan()}>
                Reject
              </button>
            </div>
          ) : null}
          {plan.status === 'approved' && chat?.mode === 'plan' ? (
            <div className="row">
              <button className="btn sm" onClick={() => void setMode('build')}>
                <Play size={13} /> Switch to Build mode
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChatEmpty({ onSuggestion }: { onSuggestion: (text: string) => void }) {
  const chat = useApp((state) => state.chat);
  const mode = chat?.mode ?? 'build';
  const suggestions =
    mode === 'plan'
      ? [
          'Inspect this project and propose an implementation plan for its next feature.',
          'Review the codebase and list the main risks and missing tests.',
        ]
      : [
          "Explain this project's structure and how to run it.",
          'Run the existing tests and fix any failures.',
          'Add a small improvement and verify it with the build or tests.',
        ];
  return (
    <div className="chat-empty">
      <Bot size={26} strokeWidth={1.3} />
      <h3>{mode === 'plan' ? 'Plan with the agent' : 'Build with the agent'}</h3>
      <p>
        {mode === 'plan'
          ? 'The agent inspects read-only files, then saves a structured plan for your approval. Nothing is modified in Plan Mode.'
          : 'The agent edits files, runs commands and verifies results using real tools. Tool actions require your permission.'}
      </p>
      <div className="row-list" style={{ width: '100%' }}>
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            className="btn ghost sm"
            style={{ justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal' }}
            onClick={() => onSuggestion(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChatPanel() {
  const project = useApp((state) => state.project);
  const chat = useApp((state) => state.chat);
  const messages = useApp((state) => state.messages);
  const plan = useApp((state) => state.plan);
  const tasks = useApp((state) => state.tasks);
  const run = useApp((state) => state.run);
  const settings = useApp((state) => state.settings);
  const providerStatus = useApp((state) => state.providerStatus);
  const sendMessage = useApp((state) => state.sendMessage);
  const cancelRun = useApp((state) => state.cancelRun);
  const setMode = useApp((state) => state.setMode);
  const createChat = useApp((state) => state.createChat);
  const renameChat = useApp((state) => state.renameChat);
  const openModal = useApp((state) => state.openModal);
  const sending = useApp((state) => state.sending);

  const [draft, setDraft] = useState('');
  const [showPlan, setShowPlan] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const mode = chat?.mode ?? 'build';
  const activeRun = run && run.status === 'running' ? run : null;
  const busy = Boolean(activeRun) || sending;

  useEffect(() => {
    setDraft('');
    setError(null);
  }, [chat?.id]);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages.length, run?.text, run?.toolCalls.length, chat?.id]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(200, Math.max(60, textarea.scrollHeight))}px`;
  }, [draft]);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || busy) return;
    setError(null);
    try {
      await sendMessage(text);
      setDraft('');
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    }
  };

  const modelLabel =
    chat?.model ?? project?.defaultModel ?? settings?.defaultModel ?? providerStatus?.models[0]?.id ?? 'No model';

  return (
    <section className="chat-pane">
      <div className="chat-header">
        <div
          className="chat-title"
          title={`${chat?.title ?? 'New chat'} — double-click to rename`}
          onDoubleClick={async () => {
            if (!chat) return;
            const title = window.prompt('Rename chat', chat.title);
            if (title && title.trim() && title !== chat.title) {
              await renameChat(chat.id, title.trim());
            }
          }}
        >
          {chat?.title ?? 'New chat'}
        </div>
        <div className="mode-toggle" title={activeRun ? 'Stop the run to change mode' : 'Agent mode'}>
          <button
            className={mode === 'plan' ? 'active' : ''}
            disabled={Boolean(activeRun)}
            onClick={() => void setMode('plan')}
          >
            Plan
          </button>
          <button
            className={mode === 'build' ? 'active' : ''}
            disabled={Boolean(activeRun)}
            onClick={() => void setMode('build')}
          >
            Build
          </button>
        </div>
        <button className="btn ghost sm" type="button" onClick={() => openModal('models')} title="Model settings">
          <Bot size={13} />
          <span className="truncate" style={{ maxWidth: 92 }}>
            {modelLabel}
          </span>
        </button>
        {plan ? (
          <button
            className={`icon-btn ${showPlan ? 'active' : ''}`}
            title="Toggle plan"
            onClick={() => setShowPlan((value) => !value)}
          >
            <ClipboardList size={14} />
          </button>
        ) : null}
        <button
          className="icon-btn"
          title="New chat (Ctrl+N)"
          onClick={() => void createChat(mode)}
        >
          <MessageSquarePlus size={15} />
        </button>
      </div>

      {plan && showPlan ? <PlanPanel plan={plan} tasks={tasks} /> : null}

      <div className="chat-body">
        <div className="messages" ref={listRef}>
          {messages.length === 0 && !activeRun ? (
            <ChatEmpty onSuggestion={(text) => setDraft(text)} />
          ) : null}
          {messages.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
          {activeRun && activeRun.chatId === chat?.id ? <LiveRun run={activeRun} /> : null}
        </div>

        <div className="status-strip">
          {activeRun ? (
            <>
              <span className="spinner" />
              <span>{PHASE_LABEL[activeRun.phase] ?? 'Working'}</span>
              <span className="truncate faint" style={{ maxWidth: 220 }} title={activeRun.detail}>
                {activeRun.detail}
              </span>
              {activeRun.contextReport ? (
                <span className="faint" title={activeRun.contextReport.notes.join('\n')}>
                  ≈{activeRun.contextReport.estimatedTokens} tok · {activeRun.contextReport.cache}
                </span>
              ) : null}
              <span className="spacer" />
              <button className="btn sm danger" onClick={() => void cancelRun()}>
                <Square size={11} /> Stop
              </button>
            </>
          ) : (
            <>
              <span className={`status-dot ${providerStatus?.connected ? 'success' : 'error'}`} />
              <span>
                {providerStatus?.connected
                  ? `Ollama ${providerStatus.version ?? ''} · ${providerStatus.models.length} model${providerStatus.models.length === 1 ? '' : 's'}`
                  : 'Ollama not connected'}
              </span>
              <span className="spacer" />
              <span className="faint">
                {mode === 'plan' ? 'Plan Mode is read-only' : 'Build Mode uses real tools'}
              </span>
            </>
          )}
        </div>

        <div className="composer">
          <div className="composer-box">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                chat
                  ? mode === 'plan'
                    ? 'Describe what to plan… (Enter to send, Shift+Enter for newline)'
                    : 'Describe what to build or ask about the project…'
                  : 'Describe what to build or plan…'
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
              disabled={sending}
            />
            <div className="composer-actions">
              <button className="btn ghost sm" type="button" onClick={() => openModal('tools')}>
                <Wrench size={12} /> Tools
              </button>
              <span className="composer-hint">
                {mode === 'plan' ? 'Plan' : 'Build'} · {modelLabel}
              </span>
              <span className="spacer" />
              {activeRun ? (
                <button className="btn sm danger" type="button" onClick={() => void cancelRun()}>
                  <Square size={11} /> Stop
                </button>
              ) : (
                <button
                  className="btn primary sm"
                  type="button"
                  disabled={!draft.trim() || sending}
                  onClick={() => void submit()}
                >
                  <Send size={12} /> Send
                </button>
              )}
            </div>
          </div>
          {error ? <div className="composer-error">{error}</div> : null}
          <div className="faint small">
            Tool actions ask for permission. Only real backend results are reported.
          </div>
        </div>
      </div>
    </section>
  );
}
