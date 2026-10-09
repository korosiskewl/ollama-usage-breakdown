// Tiny hash router. Hash URLs keep the app working on static hosts (GitHub Pages) under any base path.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export interface Location {
  path: string;
  query: URLSearchParams;
}

function read(): Location {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path: decodeURI(path) || '/', query: new URLSearchParams(qs) };
}

let current = read();
const listeners = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = read();
  listeners.forEach((l) => l());
});

export function useLocation(): Location {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export function href(to: string): string {
  return '#' + (to.startsWith('/') ? to : '/' + to);
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const h = href(to);
  if (opts.replace) history.replaceState(history.state, '', h);
  else history.pushState(history.state, '', h);
  current = read();
  listeners.forEach((l) => l());
  if (!opts.replace) window.scrollTo({ top: 0 });
}

/** Match "/@:handle/followers" style patterns. Returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    if (seg.startsWith(':')) params[seg.slice(1)] = s[i];
    else if (seg.startsWith('@:')) {
      if (!s[i].startsWith('@')) return null;
      params[seg.slice(2)] = s[i].slice(1);
    } else if (seg !== s[i]) return null;
  }
  return params;
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      {...rest}
      href={href(to)}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

export function NavLink({ to, exact, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; exact?: boolean }) {
  const { path } = useLocation();
  const active = exact ? path === to : path === to || path.startsWith(to + '/');
  return <Link to={to} aria-current={active ? 'page' : undefined} {...rest} />;
}

export const profilePath = (handle: string) => `/@${handle}`;
export const postPath = (id: string) => `/post/${id}`;
