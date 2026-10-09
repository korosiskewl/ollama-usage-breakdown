import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '../../shared/types';
import { errorMessage } from './api';

/**
 * Cursor pagination state for a list. `key` identifies the list; changing it resets and reloads.
 * Pass key = null to skip loading.
 */
export function usePaged<T>(key: string | null, fetchPage: (cursor: string | null) => Promise<Page<T>>) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const gen = useRef(0);

  const load = useCallback(async (reset: boolean, from: string | null) => {
    const g = reset ? ++gen.current : gen.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchRef.current(from);
      if (g !== gen.current) return;
      setItems((prev) => (reset ? page.items : [...prev, ...page.items]));
      setCursor(page.nextCursor);
      setHasMore(!!page.nextCursor);
      setLoaded(true);
    } catch (e) {
      if (g !== gen.current) return;
      setError(errorMessage(e));
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setHasMore(true);
    setLoaded(false);
    if (key !== null) void load(true, null);
  }, [key, load]);

  return {
    items,
    setItems,
    loading,
    loaded,
    error,
    hasMore,
    loadMore: () => {
      if (!loading && hasMore) void load(false, cursor);
    },
    reload: () => load(true, null),
  };
}
