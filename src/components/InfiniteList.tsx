import { useEffect, useRef, type ReactNode } from 'react';
import { ErrorState, Loading } from './States';

/** Renders children followed by an auto-loading sentinel and a manual "Load more" fallback. */
export function InfiniteList({
  children,
  hasMore,
  loading,
  error,
  onMore,
  empty,
  loaded,
  skeleton,
}: {
  children: ReactNode;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  onMore: () => void;
  empty?: ReactNode;
  skeleton?: ReactNode;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const moreRef = useRef(onMore);
  moreRef.current = onMore;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || error) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && moreRef.current(), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, error, loaded]);

  const isEmpty = loaded && !hasMore && !loading && !error && Array.isArray(children) && children.length === 0;
  if (!loaded && loading && skeleton) return <>{skeleton}</>;
  return (
    <div>
      {children}
      {isEmpty && empty}
      {error ? (
        <ErrorState message={error} onRetry={onMore} />
      ) : loading ? (
        <Loading />
      ) : hasMore ? (
        <div ref={sentinel} className="list-more">
          <button className="btn btn-sm btn-ghost" onClick={onMore}>
            Load more
          </button>
        </div>
      ) : loaded && !isEmpty ? (
        <p className="list-end meta">— end —</p>
      ) : null}
    </div>
  );
}
