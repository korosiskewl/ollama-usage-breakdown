import { useEffect, useLayoutEffect, useRef } from 'react';
import { dismissToast, useToasts } from '../lib/toast';
import { Icon } from './Icon';

const canPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

/**
 * Renders transient toasts. The container is always mounted so screen readers pick up new messages.
 * It lives in the browser's top layer (popover) so toasts stay visible above open modal dialogs.
 */
export function Toaster() {
  const toasts = useToasts();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !canPopover) return;
    try {
      el.showPopover();
    } catch {
      /* already open */
    }
  }, []);

  // A dialog opened after the toaster sits above it in the top layer; re-raise when a toast arrives.
  const latest = toasts[toasts.length - 1]?.id;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !canPopover || latest === undefined || !document.querySelector('dialog[open]')) return;
    try {
      el.hidePopover();
      el.showPopover();
    } catch {
      /* ignore */
    }
  }, [latest]);

  return (
    <div
      ref={ref}
      className="toasts"
      popover={canPopover ? 'manual' : undefined}
      aria-live="polite"
      aria-relevant="additions"
      role="region"
      aria-label="Status messages"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={'toast' + (t.kind === 'error' ? ' toast-error' : t.kind === 'success' ? ' toast-success' : '')}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
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
