import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { Shell } from './components/Shell';
import { Loading } from './components/States';
import { match, useLocation } from './lib/router';
import { SessionProvider } from './lib/session';

type Params = Record<string, string>;
type Page = ComponentType<{ params: Params }>;

const page = (load: () => Promise<{ default: Page }>) => lazy(load);

// Order matters: first match wins.
const ROUTES: [string, Page, string][] = [
  ['/', page(() => import('./pages/Home')), 'Home'],
  ['/explore', page(() => import('./pages/Explore')), 'Explore'],
  ['/explore/:tab', page(() => import('./pages/Explore')), 'Explore'],
  ['/search', page(() => import('./pages/Search')), 'Search'],
  ['/notifications', page(() => import('./pages/Notifications')), 'Notifications'],
  ['/messages', page(() => import('./pages/Messages')), 'Messages'],
  ['/messages/:id', page(() => import('./pages/Messages')), 'Messages'],
  ['/post/:id', page(() => import('./pages/PostThread')), 'Post'],
  ['/post/:id/read', page(() => import('./pages/Reader')), 'Reading view'],
  ['/collections/:id', page(() => import('./pages/CollectionPage')), 'Collection'],
  ['/settings', page(() => import('./pages/Settings')), 'Settings'],
  ['/settings/:section', page(() => import('./pages/Settings')), 'Settings'],
  ['/mod', page(() => import('./pages/Moderation')), 'Moderation'],
  ['/mod/:tab', page(() => import('./pages/Moderation')), 'Moderation'],
  ['/login', page(() => import('./pages/Login')), 'Sign in'],
  ['/signup', page(() => import('./pages/Signup')), 'Join Relay'],
  ['/rules', page(() => import('./pages/Rules')), 'Community rules'],
  ['/about', page(() => import('./pages/About')), 'About'],
  ['/@:handle', page(() => import('./pages/Profile')), 'Profile'],
  ['/@:handle/:tab', page(() => import('./pages/Profile')), 'Profile'],
];

const NotFound = page(() => import('./pages/NotFound'));

function Router() {
  const { path } = useLocation();
  let found: { Page: Page; params: Params; title: string } | null = null;
  for (const [pattern, P, title] of ROUTES) {
    const params = match(pattern, path);
    if (params) {
      found = { Page: P, params, title };
      break;
    }
  }
  useEffect(() => {
    document.title = found ? `${found.title} · Relay` : 'Not found · Relay';
  }, [found?.title]);
  const Page = found?.Page ?? NotFound;
  return (
    <Suspense fallback={<Loading />}>
      <Page key={path} params={found?.params ?? {}} />
    </Suspense>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Shell>
        <Router />
      </Shell>
    </SessionProvider>
  );
}
