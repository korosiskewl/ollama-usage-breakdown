import type { FeedItem, Page, Post, UserSummary } from '../../shared/types';
import { Avatar } from '../components/Avatar';
import { InfiniteList } from '../components/InfiniteList';
import { PageHead } from '../components/PageHead';
import { PostItem } from '../components/PostItem';
import { EmptyState, PostSkeleton } from '../components/States';
import { removeFrom, useFeedEvents } from '../components/feedEvents';
import { api } from '../lib/api';
import { fullTime, plural, shortTime } from '../lib/format';
import { Link, postPath } from '../lib/router';
import { usePaged } from '../lib/usePaged';
import { NotFoundState } from '../components/NotFoundState';

interface Conversation {
  root: Post;
  replyCount: number;
  participants: UserSummary[];
  lastReplyAt: string;
}

export default function Explore({ params }: { params: Record<string, string> }) {
  const tab = params.tab ?? 'latest';
  if (tab !== 'latest' && tab !== 'conversations') return <NotFoundState />;
  return (
    <>
      <PageHead
        title="Explore"
        sub={tab === 'latest' ? 'Public posts from everyone, newest first. No trends, no ranking.' : 'Threads with replies this week, most recently active first.'}
      >
        <nav className="tabs" aria-label="Explore views">
          <Link to="/explore" aria-current={tab === 'latest' ? 'page' : undefined}>
            Latest
          </Link>
          <Link to="/explore/conversations" aria-current={tab === 'conversations' ? 'page' : undefined}>
            Conversations
          </Link>
        </nav>
      </PageHead>
      {tab === 'latest' ? <Latest /> : <Conversations />}
    </>
  );
}

function Latest() {
  const list = usePaged<FeedItem>('explore', (cursor) => api.get<Page<FeedItem>>('/feed/explore', { cursor }));
  const { setItems } = list;
  useFeedEvents(setItems, (p) => !p.replyToId && !p.author.isPrivate);
  return (
    <section aria-label="Latest posts">
      <InfiniteList
        hasMore={list.hasMore}
        loading={list.loading}
        loaded={list.loaded}
        error={list.error}
        onMore={list.loadMore}
        skeleton={<PostSkeleton count={5} />}
        empty={
          <EmptyState title="It’s quiet in here.">
            Nobody has posted publicly yet. Be the first — write something worth reading.
          </EmptyState>
        }
      >
        {list.items.map((it) => (
          <PostItem key={it.key} post={it.post} repostedBy={it.repostedBy} onRemoved={removeFrom(setItems)} />
        ))}
      </InfiniteList>
    </section>
  );
}

function names(people: UserSummary[]): string {
  const n = people.map((p) => p.displayName);
  if (n.length === 0) return '';
  if (n.length === 1) return n[0];
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  if (n.length === 3) return `${n[0]}, ${n[1]} and ${n[2]}`;
  return `${n[0]}, ${n[1]} and ${n.length - 2} others`;
}

function active(iso: string) {
  const s = shortTime(iso);
  return s === 'now' ? 'active just now' : /\d[mhd]$/.test(s) ? `active ${s} ago` : `active ${s}`;
}

function Conversations() {
  const list = usePaged<Conversation>('explore:conversations', (cursor) => api.get<Page<Conversation>>('/feed/conversations', { cursor }));
  const { setItems } = list;
  const drop = (p: Post) =>
    setItems((prev) => prev.filter((c) => (p.deleted ? c.root.id !== p.id : c.root.author.id !== p.author.id)));
  return (
    <section aria-label="Active conversations">
      <InfiniteList
        hasMore={list.hasMore}
        loading={list.loading}
        loaded={list.loaded}
        error={list.error}
        onMore={list.loadMore}
        skeleton={<PostSkeleton count={4} />}
        empty={
          <EmptyState
            title="No conversations this week."
            action={
              <Link to="/explore" className="btn">
                See the latest posts
              </Link>
            }
          >
            When people reply to each other, the threads show up here — most recently active first.
          </EmptyState>
        }
      >
        {list.items.map((c) => (
          <div className="convo" key={c.root.id}>
            <PostItem post={c.root} onRemoved={drop} />
            <Link to={postPath(c.root.id)} className="convo-meta">
              {c.participants.length > 0 && (
                <span className="convo-faces" aria-hidden="true">
                  {c.participants.slice(0, 3).map((u) => (
                    <Avatar key={u.id} user={u} size={22} />
                  ))}
                </span>
              )}
              <span className="convo-text">
                <strong>{plural(c.replyCount, 'reply', 'replies')}</strong>
                {c.participants.length > 0 && <> · {names(c.participants)}</>} ·{' '}
                <time dateTime={c.lastReplyAt} title={fullTime(c.lastReplyAt)}>
                  {active(c.lastReplyAt)}
                </time>
              </span>
              <span className="convo-go" aria-hidden="true">
                →
              </span>
            </Link>
          </div>
        ))}
      </InfiniteList>
    </section>
  );
}
