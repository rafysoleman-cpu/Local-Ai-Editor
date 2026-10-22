import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useApp } from '../state/store';

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  className = '',
  closeOnBackdrop = true,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  closeOnBackdrop?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Dialog'}>
        <div className="modal-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{title}</h2>
            {subtitle ? <div className="faint small" style={{ marginTop: 3 }}>{subtitle}</div> : null}
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ lineHeight: 1.6 }}>{message}</div>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useApp((state) => state.toasts);
  const dismiss = useApp((state) => state.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => {
        const Icon =
          toast.kind === 'success'
            ? CheckCircle2
            : toast.kind === 'error'
              ? XCircle
              : toast.kind === 'warning'
                ? AlertTriangle
                : Info;
        return (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <Icon size={15} style={{ flex: '0 0 auto', marginTop: 1 }} />
            <div className="toast-message">{toast.message}</div>
            <button className="icon-btn" style={{ width: 20, height: 20 }} onClick={() => dismiss(toast.id)} aria-label="Dismiss">
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className="spinner" />
      {label ? <span className="muted small">{label}</span> : null}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function StatusDot({ status }: { status: string }) {
  const kind =
    status === 'success' || status === 'completed'
      ? 'success'
      : status === 'error' || status === 'failed' || status === 'denied'
        ? 'error'
        : status === 'running' || status === 'in_progress' || status === 'awaiting_permission'
          ? 'running'
          : status === 'blocked' || status === 'cancelled' || status === 'limit'
            ? 'warning'
            : '';
  return <span className={`status-dot ${kind}`} />;
}
