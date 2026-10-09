import { dismissToast, useToasts } from '../lib/toast';
import { Icon } from './Icon';

/** Renders transient toasts. The container is always mounted so screen readers pick up new messages. */
export function Toaster() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions" role="region" aria-label="Status messages">
      {toasts.map((t) => (
        <div key={t.id} className={'toast' + (t.kind === 'error' ? ' toast-error' : t.kind === 'success' ? ' toast-success' : '')} role={t.kind === 'error' ? 'alert' : 'status'}>
          <p>{t.message}</p>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
