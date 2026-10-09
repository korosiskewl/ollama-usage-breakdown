import { useEffect, useRef, type ReactNode } from 'react';
import { navigate, useLocation } from '../lib/router';
import { Icon } from './Icon';

// Rough count of in-app history entries, so "Back" never leaves Relay for whatever page came before it.
let depth = 0;
let popped = false;
let replaced = false;
if (typeof window !== 'undefined') window.addEventListener('popstate', () => (popped = true));

/** Called once by the shell: keeps the in-app history depth up to date. */
export function useHistoryDepth() {
  const { path } = useLocation();
  const last = useRef<string | null>(null);
  useEffect(() => {
    // Idempotent: StrictMode re-runs effects, and only real path changes count.
    if (last.current === null || last.current === path) {
      last.current = path;
      return;
    }
    last.current = path;
    if (popped) depth = Math.max(0, depth - 1);
    else if (!replaced) depth++;
    popped = false;
    replaced = false;
  }, [path]);
}

/** Go back within the app when there is in-app history, otherwise to a sensible parent. */
export function goBack(fallback = '/') {
  if (depth > 0) history.back();
  else {
    replaced = true;
    navigate(fallback, { replace: true });
  }
}

/**
 * Sticky page header for the centre column.
 * - Top-level pages: a serif title (shown at every size).
 * - `back` pages: a compact back + title bar; hidden on phones where the shell's top bar does the same job.
 */
export function PageHead({
  title,
  sub,
  back,
  actions,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  /** Fallback path for the back button; enables the compact variant. */
  back?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className={'page-head' + (back ? ' page-head-compact' : '')}>
      <div className="page-head-row">
        {back && (
          <button className="icon-btn page-head-back" onClick={() => goBack(back)} aria-label="Back">
            <Icon name="back" />
          </button>
        )}
        <div className="page-head-titles">
          <h1 className={back ? 'page-head-title-sm' : 'page-title'}>{title}</h1>
          {sub && <p className="meta page-head-sub">{sub}</p>}
        </div>
        {actions && <div className="page-head-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
