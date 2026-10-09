import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PREVIEW } from '../lib/api';
import { openComposer } from '../lib/composer';
import { usePrefs, setPrefs } from '../lib/prefs';
import { Link, NavLink, match, navigate, profilePath, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { Avatar } from './Avatar';
import { ComposerDialog } from './Composer';
import { Dial } from './Dial';
import { Icon, type IconName } from './Icon';
import { Menu, type MenuItem } from './Menu';
import { goBack, useHistoryDepth } from './PageHead';
import { Toaster } from './Toaster';

/** The Relay wordmark: Newsreader italic with a small vermilion "signal" mark. */
export function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`wordmark wordmark-${size}`} role="img" aria-label="Relay">
      <span className="wordmark-text" aria-hidden="true">
        relay
      </span>
      <SignalMark />
    </span>
  );
}

/** The signal: a vermilion full stop. Used after the wordmark, in notices and as the reader's end mark. */
export function SignalMark({ className = 'wordmark-signal' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <circle cx="5" cy="5" r="5" />
    </svg>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  exact?: boolean;
  badge?: number;
}

/** Title and back target for the phone top bar. Top-level destinations show the wordmark instead. */
function routeInfo(path: string): { title: string; back: string | null } {
  const top = ['/', '/explore', '/explore/conversations', '/search', '/notifications', '/messages', '/login', '/signup'];
  if (top.includes(path)) return { title: '', back: null };
  if (match('/post/:id/read', path)) return { title: 'Reading view', back: '/' };
  if (match('/post/:id', path)) return { title: 'Post', back: '/' };
  if (path.startsWith('/messages/')) return { title: 'Messages', back: '/messages' };
  if (path.startsWith('/collections/')) return { title: 'Collection', back: '/' };
  if (path === '/settings') return { title: 'Settings', back: '/' };
  if (path.startsWith('/settings/')) return { title: 'Settings', back: '/settings' };
  if (path.startsWith('/mod')) return { title: 'Moderation', back: '/' };
  if (path === '/rules') return { title: 'Community rules', back: '/' };
  if (path === '/about') return { title: 'About', back: '/' };
  const prof = match('/@:handle', path) ?? match('/@:handle/:tab', path);
  if (prof) return { title: '@' + prof.handle, back: '/' };
  return { title: 'Relay', back: '/' };
}

function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

const BANNER_KEY = 'relay.previewBanner';

function PreviewBanner() {
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(BANNER_KEY) === 'hidden';
    } catch {
      return false;
    }
  });
  if (!PREVIEW || hidden) return null;
  return (
    <div className="banner banner-preview" role="note">
      <SignalMark className="banner-mark" />
      <p>
        <strong>Preview build</strong> — Relay runs entirely in this browser. Data stays on this device.{' '}
        <Link to="/about">How it works</Link>
      </p>
      <button
        className="icon-btn banner-close"
        aria-label="Dismiss preview notice"
        onClick={() => {
          setHidden(true);
          try {
            sessionStorage.setItem(BANNER_KEY, 'hidden');
          } catch {
            /* storage unavailable */
          }
        }}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

function useAccountMenu(): MenuItem[] {
  const { me, signOut } = useSession();
  const prefs = usePrefs();
  if (!me) return [];
  const systemDark = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && systemDark);
  return [
    { label: 'Your profile', icon: 'user', onSelect: () => navigate(profilePath(me.handle)) },
    { label: 'Settings', icon: 'settings', onSelect: () => navigate('/settings') },
    { label: dark ? 'Use light theme' : 'Use dark theme', icon: dark ? 'sun' : 'moon', onSelect: () => setPrefs({ theme: dark ? 'light' : 'dark' }) },
    {
      label: 'Sign out',
      icon: 'logout',
      onSelect: () =>
        void signOut().then(() => {
          navigate('/');
          toast('Signed out. See you soon.');
        }),
    },
  ];
}

function NavBadge({ n, label }: { n: number; label: string }) {
  if (!n) return null;
  return (
    <>
      <span className="badge nav-badge" aria-hidden="true">
        {n > 99 ? '99+' : n}
      </span>
      <span className="sr-only">
        , {n} {label}
      </span>
    </>
  );
}

function LeftRail({ nav }: { nav: NavItem[] }) {
  const { me, loading } = useSession();
  const { path } = useLocation();
  const accountItems = useAccountMenu();
  return (
    <header className="rail rail-left">
      <div className="rail-left-inner">
        <Link to="/" className="rail-brand" aria-label="Relay home">
          <Wordmark />
          <span className="rail-brand-compact" aria-hidden="true">
            r<SignalMark className="wordmark-signal" />
          </span>
        </Link>
        <nav aria-label="Primary" className="rail-nav">
          <ul>
            {nav.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} exact={n.exact} className="rail-link" title={n.label}>
                  <span className="rail-icon">
                    <Icon name={n.icon} size={21} />
                    {!!n.badge && <span className="rail-dot" aria-hidden="true" />}
                  </span>
                  <span className="rail-label">{n.label}</span>
                  <NavBadge n={n.badge ?? 0} label="unread" />
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {me ? (
          <button className="btn btn-signal rail-write" onClick={() => openComposer()} title="Write a post">
            <Icon name="pen" size={18} />
            <span className="rail-label">Write</span>
          </button>
        ) : !loading ? (
          <div className="rail-auth">
            <p className="rail-auth-lede">Join to post, follow people and reply.</p>
            <Link to="/signup" className="btn btn-signal btn-block">
              Join Relay
            </Link>
            <Link to={`/login${path !== '/' && path !== '/login' && path !== '/signup' ? `?next=${encodeURIComponent(path)}` : ''}`} className="btn btn-block">
              Sign in
            </Link>
          </div>
        ) : null}

        {me && (
          <div className="account">
            <Menu
              label={`Account menu for @${me.handle}`}
              items={accountItems}
              trigger={
                <>
                  <Avatar user={me} size={36} />
                  <span className="account-text">
                    <span className="account-name">{me.displayName}</span>
                    <span className="account-handle meta">@{me.handle}</span>
                  </span>
                  <span className="account-more">
                    <Icon name="more" size={18} />
                  </span>
                </>
              }
            />
          </div>
        )}
      </div>
    </header>
  );
}

function RightRail({ path }: { path: string }) {
  const { me } = useSession();
  return (
    <aside className="rail rail-right" aria-label="About this feed">
      <div className="rail-right-inner">
        {path === '/' && me && <Dial />}
        <section className="rail-note">
          <h2 className="kicker">Relay</h2>
          <p>
            No ads, no algorithmic ranking, no engagement bait. Feeds are chronological, so what you see is who you follow — newest
            first.
          </p>
          <p className="rail-note-links">
            <Link to="/rules">Community rules</Link>
            <span aria-hidden="true"> · </span>
            <Link to="/about">About Relay</Link>
          </p>
        </section>
        {PREVIEW && (
          <p className="rail-colophon meta">
            Preview build · runs in your browser · data stays on this device
          </p>
        )}
        {!PREVIEW && <p className="rail-colophon meta">Relay 3.0 · independent &amp; ad-free</p>}
      </div>
    </aside>
  );
}

function TopBar({ path }: { path: string }) {
  const { me, loading } = useSession();
  const accountItems = useAccountMenu();
  const info = routeInfo(path);
  return (
    <div className="topbar">
      <div className="topbar-start">
        {info.back ? (
          <>
            <button className="icon-btn" onClick={() => goBack(info.back!)} aria-label="Back">
              <Icon name="back" />
            </button>
            <span className="topbar-title" aria-hidden="true">
              {info.title}
            </span>
          </>
        ) : (
          <Link to="/" className="topbar-brand" aria-label="Relay home">
            <Wordmark size="sm" />
          </Link>
        )}
      </div>
      <div className="topbar-end">
        {me ? (
          <span className="topbar-account">
            <Menu label={`Account menu for @${me.handle}`} items={accountItems} trigger={<Avatar user={me} size={30} />} />
          </span>
        ) : !loading && path !== '/login' ? (
          <Link to="/login" className="btn btn-sm">
            Sign in
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function TabBar() {
  const { me, loading } = useSession();
  if (loading) return <nav className="tabbar" aria-label="Primary" />;
  const items: (NavItem | 'write')[] = me
    ? [
        { to: '/', label: 'Home', icon: 'home', exact: true },
        { to: '/explore', label: 'Explore', icon: 'explore' },
        'write',
        { to: '/notifications', label: 'Alerts', icon: 'bell', badge: me.unread.notifications },
        { to: '/messages', label: 'Messages', icon: 'mail', badge: me.unread.messages },
      ]
    : [
        { to: '/', label: 'Home', icon: 'home', exact: true },
        { to: '/explore', label: 'Explore', icon: 'explore' },
        { to: '/search', label: 'Search', icon: 'search' },
        { to: '/signup', label: 'Join', icon: 'user' },
      ];
  return (
    <nav className="tabbar" aria-label="Primary">
      <ul>
        {items.map((n) =>
          n === 'write' ? (
            <li key="write">
              <button className="tabbar-write" onClick={() => openComposer()} aria-label="Write a post">
                <Icon name="pen" size={20} />
              </button>
            </li>
          ) : (
            <li key={n.to}>
              <NavLink to={n.to} exact={n.exact} className="tabbar-link">
                <span className="tabbar-icon">
                  <Icon name={n.icon} size={22} />
                  {!!n.badge && (
                    <span className="badge tabbar-badge" aria-hidden="true">
                      {n.badge > 99 ? '99+' : n.badge}
                    </span>
                  )}
                </span>
                <span className="tabbar-label">{n.label}</span>
                {!!n.badge && <span className="sr-only">, {n.badge} unread</span>}
              </NavLink>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const { path } = useLocation();
  const online = useOnline();
  const mainRef = useRef<HTMLElement>(null);
  const firstPath = useRef(true);
  useHistoryDepth();

  // Move focus to the new page on navigation (unless the page already focused something itself).
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    const main = mainRef.current;
    if (!main) return;
    const t = window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body && main.contains(active)) return;
      if (active && active.closest('dialog')) return;
      main.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [path]);

  const isMod = me?.role === 'moderator' || me?.role === 'admin';
  const nav: NavItem[] = me
    ? [
        { to: '/', label: 'Home', icon: 'home', exact: true },
        { to: '/explore', label: 'Explore', icon: 'explore' },
        { to: '/search', label: 'Search', icon: 'search' },
        { to: '/notifications', label: 'Notifications', icon: 'bell', badge: me.unread.notifications },
        { to: '/messages', label: 'Messages', icon: 'mail', badge: me.unread.messages },
        { to: profilePath(me.handle), label: 'Profile', icon: 'user' },
        { to: '/settings', label: 'Settings', icon: 'settings' },
        ...(isMod ? [{ to: '/mod', label: 'Moderation', icon: 'shield' as const }] : []),
      ]
    : [
        { to: '/', label: 'Home', icon: 'home', exact: true },
        { to: '/explore', label: 'Explore', icon: 'explore' },
        { to: '/search', label: 'Search', icon: 'search' },
      ];

  const layout = match('/post/:id/read', path) ? 'reader' : 'default';

  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to content
      </a>
      <div className="shell" data-layout={layout}>
        <LeftRail nav={nav} />
        <div className="shell-center">
          <PreviewBanner />
          {!online && (
            <div className="banner banner-offline" role="status">
              <span className="banner-dot" aria-hidden="true" />
              <p>You’re offline. What’s already loaded still reads fine; posting and refreshing resume when you reconnect.</p>
            </div>
          )}
          <TopBar path={path} />
          <main id="main" ref={mainRef} tabIndex={-1} className="shell-main">
            {children}
          </main>
        </div>
        {layout === 'default' && <RightRail path={path} />}
      </div>
      <TabBar />
      <Toaster />
      <ComposerDialog />
    </>
  );
}
