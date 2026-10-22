import {
  ClipboardList,
  FolderOpen,
  GitBranch,
  Hammer,
  MessageSquarePlus,
  MessagesSquare,
  Pencil,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react';
import { useApp } from '../../state/store';
import { FileTree } from '../file-explorer/FileTree';
import { formatError } from '../../services/api';

export function Sidebar() {
  const project = useApp((state) => state.project);
  const chats = useApp((state) => state.chats);
  const chat = useApp((state) => state.chat);
  const openChat = useApp((state) => state.openChat);
  const createChat = useApp((state) => state.createChat);
  const renameChat = useApp((state) => state.renameChat);
  const deleteChat = useApp((state) => state.deleteChat);
  const refreshChats = useApp((state) => state.refreshChats);
  const refreshWorkspace = useApp((state) => state.refreshWorkspace);
  const openModal = useApp((state) => state.openModal);
  const gitStatus = useApp((state) => state.gitStatus);
  const refreshGit = useApp((state) => state.refreshGit);
  const toast = useApp((state) => state.toast);

  if (!project) return null;

  const newChat = async (): Promise<void> => {
    try {
      await createChat();
    } catch (error) {
      toast(formatError(error), 'error');
    }
  };

  const promptRename = async (chatId: string, current: string): Promise<void> => {
    const title = window.prompt('Rename chat', current);
    if (!title || title.trim() === current) return;
    try {
      await renameChat(chatId, title.trim());
    } catch (error) {
      toast(formatError(error), 'error');
    }
  };

  const promptDelete = async (chatId: string, title: string): Promise<void> => {
    if (!window.confirm(`Delete chat "${title}"?\n\nIts messages are moved to the project's chats/deleted folder.`)) {
      return;
    }
    try {
      await deleteChat(chatId);
    } catch (error) {
      toast(formatError(error), 'error');
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-project">
        <div className="sidebar-project-name" title={project.name}>
          <span>{project.name}</span>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            className="icon-btn"
            title="Project settings, instructions and memory"
            onClick={() => openModal('projectSettings')}
          >
            <Settings2 size={14} />
          </button>
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button
            className="btn ghost sm"
            type="button"
            title={project.workspacePath}
            onClick={() => void window.desktop.projects.openFolder(project.id)}
            style={{ maxWidth: '100%', justifyContent: 'flex-start', padding: '2px 6px' }}
          >
            <FolderOpen size={12} />
            <span className="truncate mono" style={{ fontSize: 11, maxWidth: 180 }}>
              {project.workspacePath}
            </span>
          </button>
          <button className="icon-btn" title="Refresh project" onClick={() => void refreshWorkspace()}>
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="section-header">
          <span>Chats</span>
          <span className="badge">{chats.length}</span>
          <span className="spacer" />
          <button className="icon-btn" title="New chat (Ctrl+N)" onClick={() => void newChat()}>
            <MessageSquarePlus size={14} />
          </button>
          <button className="icon-btn" title="Refresh chats" onClick={() => void refreshChats()}>
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="chat-list">
          {chats.length === 0 ? (
            <div className="tree-empty">No chats yet. Start one below.</div>
          ) : (
            chats.map((item) => (
              <div
                key={item.id}
                className={`chat-item ${chat?.id === item.id ? 'active' : ''}`}
                onClick={() => void openChat(item.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void openChat(item.id);
                }}
                title={item.title}
              >
                {item.mode === 'plan' ? <ClipboardList size={13} /> : <Hammer size={13} />}
                <span className="chat-item-title">{item.title}</span>
                <span className="chat-item-meta">{item.messageCount}</span>
                <button
                  className="icon-btn"
                  title="Rename chat"
                  onClick={(event) => {
                    event.stopPropagation();
                    void promptRename(item.id, item.title);
                  }}
                >
                  <Pencil size={11} />
                </button>
                <button
                  className="icon-btn"
                  title="Delete chat"
                  onClick={(event) => {
                    event.stopPropagation();
                    void promptDelete(item.id, item.title);
                  }}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <FileTree />

      <div className="section-header" style={{ borderTop: '1px solid var(--border)', gap: 8 }}>
        <GitBranch size={12} />
        <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
          {gitStatus?.isRepository
            ? `${gitStatus.branch ?? 'detached'} · ${gitStatus.entries.length} change${gitStatus.entries.length === 1 ? '' : 's'}`
            : 'Not a Git repository'}
        </span>
        <span className="spacer" />
        <button className="icon-btn" title="Refresh Git status" onClick={() => void refreshGit()}>
          <RefreshCw size={11} />
        </button>
        <button
          className="icon-btn"
          title="Open tools"
          onClick={() => openModal('tools')}
        >
          <MessagesSquare size={12} />
        </button>
      </div>
    </aside>
  );
}
