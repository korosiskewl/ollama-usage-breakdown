import type { ReactNode } from 'react';

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <p className="state-title">{title}</p>
      {children && <div className="state-body">{children}</div>}
      {action && <div className="state-action">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <p className="state-title">That didn’t load.</p>
      <div className="state-body">{message}</div>
      {onRetry && (
        <div className="state-action">
          <button className="btn btn-sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state-loading" role="status">
      <span className="spinner" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** Placeholder rows shaped like posts. */
export function PostSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="post post-skel" key={i}>
          <div className="skeleton" style={{ width: 40, height: 40, borderRadius: '50%' }} />
          <div style={{ display: 'grid', gap: 10, flex: 1 }}>
            <div className="skeleton" style={{ width: '38%', height: 12 }} />
            <div className="skeleton" style={{ width: '92%', height: 14 }} />
            <div className="skeleton" style={{ width: '70%', height: 14 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
