import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Me, Unread } from '../../shared/types';
import { api } from './api';

interface SessionValue {
  me: Me | null;
  loading: boolean;
  setMe: (me: Me | null) => void;
  refresh: () => Promise<void>;
  refreshUnread: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: Me | null }>('/auth/me');
      setMe(r.user);
    } catch {
      /* keep previous state when offline */
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshUnread = useCallback(async () => {
    try {
      const unread = await api.get<Unread>('/me/unread');
      setMe((m) => (m ? { ...m, unread } : m));
    } catch {
      /* ignore */
    }
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll unread counts while signed in and the tab is visible.
  const signedIn = !!me;
  useEffect(() => {
    if (!signedIn) return;
    const tick = () => document.visibilityState === 'visible' && void refreshUnread();
    const id = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [signedIn, refreshUnread]);

  return <Ctx.Provider value={{ me, loading, setMe, refresh, refreshUnread, signOut }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
