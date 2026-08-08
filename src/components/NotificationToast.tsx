/**
 * Non-intrusive notifications.
 *
 * In-app rather than OS-level: these can carry the name of a session and the
 * state of someone's work, and an in-app toast cannot surface on a locked
 * screen or in a screen share of another app. The text is written to be safe
 * either way — no conversation content — so moving to the OS notification
 * plugin later is a delivery change, not a content one.
 */

import type { Toast } from '../types/agent';

const ICON: Record<Toast['kind'], string> = {
  context: '◐',
  usage: '◆',
  auth: '⊘',
  errors: '⚠',
  updates: '↑',
};

interface Props {
  toasts: Toast[];
  onAction: (toast: Toast) => void;
  onDismiss: (id: string) => void;
}

export function NotificationToasts({ toasts, onAction, onDismiss }: Props) {
  if (!toasts.length) return null;

  return (
    <div className="k-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={'k-toast is-' + toast.kind}>
          <span className="k-toast-icon">{ICON[toast.kind]}</span>
          <span className="k-toast-text">{toast.text}</span>
          {toast.action ? (
            <button type="button" className="k-toast-action" onClick={() => onAction(toast)}>
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="k-toast-close"
            title="Dismiss"
            onClick={() => onDismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
