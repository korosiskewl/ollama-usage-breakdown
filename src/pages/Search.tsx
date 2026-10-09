import { useEffect, useRef, useState } from 'react';
import type { Page, Post, UserSummary } from '../../shared/types';
import { LIMITS } from '../../shared/limits';
import { ApiRequestError, api } from '../lib/api';
import { navigate, useLocation } from '../lib/router';
import { usePaged } from '../lib/usePaged';
import { Icon } from '../components/Icon';
import { InfiniteList } from '../components/InfiniteList';
import { PageHead } from '../components/PageHead';
import { PostItem } from '../components/PostItem';
import { EmptyState, PostSkeleton } from '../components/States';
import { UserRow } from '../components/UserRow';

type SearchType = 'users' | 'posts';

const searchUrl = (q: string, type: SearchType) => {
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  qs.set('type', type);
  return `/search?${qs.toString()}`;
};

/** Friendlier wording for the errors search can actually produce. */
async function searchPage<T>(q: string, type: SearchType, cursor: string | null): Promise<Page<T>> {
  try {
    return await api.get<Page<T>>('/search', { q, type, cursor });
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 429) {
      throw new ApiRequestError(429, e.code, 'You’re searching faster than Relay allows. Wait a few seconds, then try again.');
    }
    throw e;
  }
}

export default function Search(_props: { params: Record<string, string> }) {
  const { query } = useLocation();
  const urlQ = query.get('q') ?? '';
  const type: SearchType = query.get('type') === 'posts' ? 'posts' : 'users';
  const [text, setText] = useState(urlQ);
  const inputRef = useRef<HTMLInputElement>(null);
  const typeRef = useRef(type);
  typeRef.current = type;

  // Keep the box in sync when the URL changes from elsewhere (back/forward, a link).
  const [prevUrlQ, setPrevUrlQ] = useState(urlQ);
  if (urlQ !== prevUrlQ) {
    setPrevUrlQ(urlQ);
    if (urlQ.trim() !== text.trim()) setText(urlQ);
  }

  // Debounce typing into the URL; the URL is the source of truth for results.
  useEffect(() => {
    if (text.trim() === urlQ.trim()) return;
    const t = window.setTimeout(() => navigate(searchUrl(text.trim(), typeRef.current), { replace: true }), 300);
    return () => window.clearTimeout(t);
  }, [text, urlQ]);

  useEffect(() => {
    // Focus the box on arrival when there's nothing searched yet (first mount only).
    if (!urlQ) inputRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const q = urlQ.trim();
  const ready = q.length >= LIMITS.search.min && (q.startsWith('@') ? q.length > 1 : true);

  return (
    <div className="search-page">
      <PageHead title="Search">
        <form
          role="search"
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(searchUrl(text.trim(), type), { replace: true });
          }}
        >
          <label htmlFor="search-input" className="sr-only">
            Search Relay
          </label>
          <span className="search-field">
            <Icon name="search" size={18} />
            <input
              ref={inputRef}
              id="search-input"
              className="input search-input"
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              maxLength={LIMITS.search.max}
              placeholder={type === 'users' ? 'Search people by name or @handle' : 'Search posts by the words in them'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {text && (
              <button
                type="button"
                className="icon-btn search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setText('');
                  navigate(searchUrl('', type), { replace: true });
                  inputRef.current?.focus();
                }}
              >
                <Icon name="close" size={16} />
              </button>
            )}
          </span>
        </form>
        <div className="tabs" role="tablist" aria-label="What to search">
          {(['users', 'posts'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={type === t}
              aria-controls="search-results"
              onClick={() => navigate(searchUrl(text.trim(), t), { replace: true })}
            >
              {t === 'users' ? 'People' : 'Posts'}
            </button>
          ))}
        </div>
      </PageHead>

      <div id="search-results" role="tabpanel" aria-label={type === 'users' ? 'People' : 'Posts'}>
        {!q ? (
          <SearchIntro type={type} />
        ) : !ready ? (
          <EmptyState title="Keep typing…">
            Type at least {LIMITS.search.min} characters{q.startsWith('@') ? ' after the @' : ''} to search.
          </EmptyState>
        ) : type === 'users' ? (
          <UserResults q={q} />
        ) : (
          <PostResults q={q} />
        )}
      </div>
    </div>
  );
}

function SearchIntro({ type }: { type: SearchType }) {
  return (
    <div className="search-intro">
      <p className="search-intro-lede read">
        {type === 'users' ? 'Find people by their name or handle.' : 'Find posts by the words in them, newest first.'}
      </p>
      <ul className="search-tips">
        <li>
          <span className="meta">@ada</span> searches handles only.
        </li>
        <li>Matches are literal — no ranking, no suggestions, no trending terms.</li>
        <li>Muted words and accounts you’ve muted or blocked are left out of results.</li>
      </ul>
    </div>
  );
}

function UserResults({ q }: { q: string }) {
  const list = usePaged<UserSummary>(`users:${q}`, (cursor) => searchPage<UserSummary>(q, 'users', cursor));
  return (
    <InfiniteList
      hasMore={list.hasMore}
      loading={list.loading}
      loaded={list.loaded}
      error={list.error}
      onMore={list.loadMore}
      empty={
        <EmptyState title={`No one matches “${q}”.`}>
          Check the spelling, try part of their name, or start with @ to match handles. Accounts that block you won’t appear.
        </EmptyState>
      }
    >
      {list.items.map((u) => (
        <UserRow key={u.id} user={u} />
      ))}
    </InfiniteList>
  );
}

function PostResults({ q }: { q: string }) {
  const list = usePaged<Post>(`posts:${q}`, (cursor) => searchPage<Post>(q, 'posts', cursor));
  return (
    <InfiniteList
      hasMore={list.hasMore}
      loading={list.loading}
      loaded={list.loaded}
      error={list.error}
      onMore={list.loadMore}
      skeleton={<PostSkeleton count={4} />}
      empty={
        <EmptyState title={`No posts contain “${q}”.`}>
          Search looks for the exact words in public posts. Try fewer or different words.
        </EmptyState>
      }
    >
      {list.items.map((p) => (
        <PostItem key={p.id} post={p} onRemoved={(r) => list.setItems((items) => items.filter((x) => x.id !== r.id || r.deleted))} />
      ))}
    </InfiniteList>
  );
}
