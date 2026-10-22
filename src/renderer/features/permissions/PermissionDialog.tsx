import { ShieldAlert } from 'lucide-react';
import { useApp } from '../../state/store';
import { Modal } from '../../components/ui';

export function PermissionDialog() {
  const request = useApp((state) => state.permissionQueue[0] ?? null);
  const respond = useApp((state) => state.respondPermission);
  if (!request) return null;

  const riskLabel =
    request.risk === 'high' ? 'High risk' : request.risk === 'medium' ? 'Medium risk' : 'Low risk';

  return (
    <Modal
      title={
        <span className="row" style={{ gap: 8 }}>
          <ShieldAlert size={17} color={request.risk === 'high' ? 'var(--danger)' : 'var(--warning)'} />
          Permission required
        </span>
      }
      subtitle="The agent is waiting. The action has not been executed."
      onClose={() => void respond('deny')}
      closeOnBackdrop={false}
      footer={
        <>
          <button className="btn danger" onClick={() => void respond('deny')}>
            Deny
          </button>
          <span className="spacer" />
          {request.alwaysKey ? (
            <button className="btn" onClick={() => void respond('always_allow')}>
              {request.allowAlwaysLabel ?? 'Always allow in this project'}
            </button>
          ) : null}
          <button className="btn primary" onClick={() => void respond('allow_once')}>
            Allow once
          </button>
        </>
      }
    >
      <div className={`permission-card ${request.risk === 'high' ? 'high' : ''}`}>
        <div className="row" style={{ gap: 8 }}>
          <span className={`badge ${request.risk === 'high' ? 'danger' : 'warning'}`}>{riskLabel}</span>
          <span className="badge">{request.category}</span>
          <span className="badge info">{request.toolName}</span>
        </div>
        <div className="permission-title">{request.title}</div>
        <div className="permission-desc">{request.description}</div>
        {Object.keys(request.details).length > 0 ? (
          <dl className="permission-details">
            {Object.entries(request.details).map(([key, value]) => (
              <div key={key} style={{ display: 'contents' }}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className={`risk-note ${request.risk === 'high' ? 'high' : ''}`}>
          {request.risk === 'high'
            ? 'This action is destructive or can run arbitrary code. Review it carefully before allowing.'
            : 'Only allow this if you understand what the action will do.'}
        </div>
        <div className="faint small">
          "Always allow" is stored for this project only and can be revoked in Tools &amp; Permissions.
        </div>
      </div>
    </Modal>
  );
}
