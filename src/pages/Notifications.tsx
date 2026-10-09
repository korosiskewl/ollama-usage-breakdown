import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { NotificationGroup, Page, UserSummary } from '../../shared/types';
import { api, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { Link, postPath, profilePath, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { usePaged } from '../lib/usePaged';
import { Avatar } from '../components/Avatar';
import { Icon, type IconName } from '../components/Icon';
import { InfiniteList } from '../components/InfiniteList';
import { PageHead } from '../components/PageHead';
import { PostItem } from '../components/PostItem';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { Time } from '../components/Time';
import { UserRow } from '../components/UserRow';

type Filter = 'all' | 'mentions';

const VERB: Record<NotificationGroup['type'], string> = {
  like: 'liked your post',
  repost: 'reposted your post',
  follow: 'followed you',
  follow_request: 'asked to follow you',
  follow_accept: 'accepted your follow request',
  reply: 'replied to you',
  mention: 'mentioned you',
};

const ICON: Record<NotificationGroup['type'], { icon: IconName | '@'; tone: 'signal' | 'ink'; filled?: boolean }> = {
  like: { icon: 'heart', tone: 'signal', filled: true },
  repost: { icon: 'repost', tone: 'ink' },
  follow: { icon: 'user', tone: 'ink' },
  follow_request: { icon: 'lock', tone: 'ink' },
  follow_accept: { icon: 'check', tone: 'ink' },
  reply: { icon: 'reply', tone: 'signal' },
  mention: { icon: '@', tone: 'signal' },
};

export default function Notifications(_props: { params: Record<string, string> }) {
  const { me, loading } = useSession();
  if (loading) return <Loading />;
  if (!me) {
    return (
      <>
        <PageHead title="Notifications" />
        <EmptyState
          title="Sign in to see your notifications."
          action={
            <Link to="/login" className="btn btn-primary">
              Sign in
            </Link>
          }
        >
          Replies, mentions, new followers and likes on your posts collect here.
        </EmptyState>
      </>
    );
  }
  return <NotificationsInner />;
}

function NotificationsInner() {
  const { me, refreshUnread } = useSession();
  const { query } = useLocation();
  const [filter, setFilter] = useState<Filter>('all');
  const marked = useRef(false);
  const list = usePaged<NotificationGroup>('notifications', (cursor) => api.get<Page<NotificationGroup>>('/notifications', { cursor }));

  // Once the first page is on screen, mark everything read (rows keep their unread styling for this visit).
  useEffect(() => {
    if (!list.loaded || marked.current) return;
    marked.current = true;
    api.post('/notifications/read').then(
      () => void refreshUnread(),
      () => {
        /* the badge simply stays until next time */
      },
    );
  }, [list.loaded, refreshUnread]);

  const showRequests = (me?.unread.followRequests ?? 0) > 0 || query.get('view') === 'requests';
  const visible = filter === 'all' ? list.items : list.items.filter((g) => g.type === 'reply' || g.type === 'mention');

  return (
    <div className="notif-page">
      <PageHead title="Notifications">
        <div className="tabs" role="tablist" aria-label="Filter notifications">
          <button role="tab" aria-selected={filter === 'all'} aria-controls="notif-list" onClick={() => setFilter('all')}>
            All
          </button>
          <button role="tab" aria-selected={filter === 'mentions'} aria-controls="notif-list" onClick={() => setFilter('mentions')}>
            Mentions &amp; replies
          </button>
        </div>
      </PageHead>

      {showRequests && <FollowRequests focus={query.get('view') === 'requests'} />}

      <div id="notif-list" role="tabpanel" aria-label={filter === 'all' ? 'All notifications' : 'Mentions and replies'}>
        <InfiniteList
          hasMore={list.hasMore}
          loading={list.loading}
          loaded={list.loaded}
          error={list.error}
          onMore={list.loadMore}
          skeleton={<NotifSkeleton />}
          empty={
            filter === 'all' ? (
              <EmptyState title="Nothing new — and that’s fine.">
                When people reply to you, mention you, follow you or like your posts, it shows up here. Relay never sends “you might
                have missed” nudges.
              </EmptyState>
            ) : (
              <EmptyState title="No mentions or replies yet.">
                When someone replies to one of your posts or mentions your @handle, you’ll find it here.
              </EmptyState>
            )
          }
        >
          {visible.map((g) => (
            <NotificationRow key={g.id} group={g} />
          ))}
        </InfiniteList>
      </div>
    </div>
  );
}

function NotifSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div className="notif" key={i}>
          <div className="notif-icon">
            <span className="skeleton" style={{ width: 18, height: 18, borderRadius: '50%' }} />
          </div>
          <div className="notif-main" style={{ display: 'grid', gap: 10 }}>
            <span className="skeleton" style={{ width: 28, height: 28, borderRadius: '50%' }} />
            <span className="skeleton" style={{ width: '55%', height: 12 }} />
            <span className="skeleton" style={{ width: '85%', height: 14 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Name({ user }: { user: UserSummary }) {
  return (
    <Link to={profilePath(user.handle)} className="notif-name">
      {user.displayName}
    </Link>
  );
}

function actorsText(g: NotificationGroup): ReactNode {
  const [first, second] = g.actors;
  if (!first) return 'Someone';
  const others = g.actorCount - 1;
  if (others <= 0) return <Name user={first} />;
  if (others === 1 && second) {
    return (
      <>
        <Name user={first} /> and <Name user={second} />
      </>
    );
  }
  return (
    <>
      <Name user={first} /> and {plural(others, 'other')}
    </>
  );
}

function TypeIcon({ type }: { type: NotificationGroup['type'] }) {
  const spec = ICON[type];
  return (
    <span className={`notif-icon notif-tone-${spec.tone}`} aria-hidden="true">
      {spec.icon === '@' ? <span className="notif-at">@</span> : <Icon name={spec.icon} size={18} filled={spec.filled} />}
    </span>
  );
}

function NotificationRow({ group: g }: { group: NotificationGroup }) {
  const unread = !g.read;
  const cls = 'notif' + (unread ? ' notif-unread' : '');

  if ((g.type === 'reply' || g.type === 'mention') && g.post) {
    return (
      <div className={cls + ' notif-post'}>
        <p className="notif-context">
          <TypeIcon type={g.type} />
          <span>
            {g.actors[0] ? <Name user={g.actors[0]} /> : 'Someone'} {VERB[g.type]}
          </span>
          {unread && <span className="sr-only">(unread)</span>}
        </p>
        <PostItem post={g.post} />
      </div>
    );
  }

  const sentence = (
    <>
      {actorsText(g)} {VERB[g.type]}
    </>
  );

  return (
    <div className={cls}>
      <TypeIcon type={g.type} />
      <div className="notif-main">
        <div className="notif-top">
          <span className="notif-avatars">
            {g.actors.slice(0, 5).map((a) => (
              <Link key={a.id} to={profilePath(a.handle)} className="notif-avatar" title={`${a.displayName} (@${a.handle})`}>
                <Avatar user={a} size={30} />
                <span className="sr-only">{a.displayName}</span>
              </Link>
            ))}
          </span>
          <Time iso={g.createdAt} />
        </div>
        <p className="notif-text">
          {sentence}
          {unread && <span className="sr-only"> (unread)</span>}
        </p>
        {g.post && (g.type === 'like' || g.type === 'repost') && (
          <Link to={postPath(g.post.id)} className="notif-excerpt read">
            {g.post.body}
          </Link>
        )}
        {g.type === 'follow_request' && (
          <Link to="/notifications?view=requests" className="notif-cta">
            Review follow requests →
          </Link>
        )}
      </div>
    </div>
  );
}

/** Pending follow requests with optimistic Accept / Decline. */
function FollowRequests({ focus }: { focus: boolean }) {
  const { me, setMe } = useSession();
  const meRef = useRef(me);
  meRef.current = me;
  const ref = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const list = usePaged<UserSummary>('follow-requests', (cursor) => api.get<Page<UserSummary>>('/me/follow-requests', { cursor }));

  useEffect(() => {
    if (!focus || !list.loaded) return;
    ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    ref.current?.focus({ preventScroll: true });
  }, [focus, list.loaded]);

  const bump = (delta: number) => {
    const m = meRef.current;
    if (m) setMe({ ...m, unread: { ...m.unread, followRequests: Math.max(0, m.unread.followRequests + delta) } });
  };

  async function respond(user: UserSummary, accept: boolean) {
    if (busy.has(user.id)) return;
    const index = list.items.findIndex((u) => u.id === user.id);
    setBusy((s) => new Set(s).add(user.id));
    list.setItems((items) => items.filter((u) => u.id !== user.id));
    bump(-1);
    try {
      await api.post(`/me/follow-requests/${user.id}/${accept ? 'accept' : 'decline'}`);
      toast(accept ? `@${user.handle} can now see your posts.` : `Declined @${user.handle}’s request.`);
    } catch (e) {
      list.setItems((items) => (items.some((u) => u.id === user.id) ? items : [...items.slice(0, index), user, ...items.slice(index)]));
      bump(1);
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(user.id);
        return n;
      });
    }
  }

  if (list.loaded && list.items.length === 0 && !list.hasMore && !focus) return null;

  return (
    <section ref={ref} className="requests" aria-labelledby="requests-title" tabIndex={-1}>
      <header className="requests-head">
        <h2 id="requests-title" className="kicker">
          Follow requests
        </h2>
        {list.items.length > 0 && <span className="badge">{list.items.length}</span>}
      </header>
      {list.error ? (
        <ErrorState message={list.error} onRetry={() => void list.reload()} />
      ) : !list.loaded ? (
        <Loading label="Loading follow requests" />
      ) : list.items.length === 0 ? (
        <p className="requests-empty">
          No pending requests.
          {me?.isPrivate
            ? ' Your account is private, so new followers will wait here for your approval.'
            : ' Your account is public, so people can follow you without asking.'}
        </p>
      ) : (
        <ul className="requests-list" role="list">
          {list.items.map((u) => (
            <li key={u.id}>
              <UserRow
                user={u}
                action={
                  <span className="requests-actions">
                    <button className="btn btn-sm" onClick={() => void respond(u, false)} disabled={busy.has(u.id)} aria-label={`Decline @${u.handle}`}>
                      Decline
                    </button>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => void respond(u, true)}
                      disabled={busy.has(u.id)}
                      aria-label={`Accept @${u.handle}`}
                    >
                      Accept
                    </button>
                  </span>
                }
              />
            </li>
          ))}
          {list.hasMore && (
            <li className="list-more">
              <button className="btn btn-sm btn-ghost" onClick={list.loadMore} disabled={list.loading}>
                {list.loading && <span className="spinner" />}
                More requests
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
