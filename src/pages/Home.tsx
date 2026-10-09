import { useEffect, useRef, useState } from 'react';
import type { FeedItem, Page } from '../../shared/types';
import { InlineComposer } from '../components/Composer';
import { Dial } from '../components/Dial';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { InfiniteList } from '../components/InfiniteList';
import { PageHead } from '../components/PageHead';
import { PostItem } from '../components/PostItem';
import { EmptyState, PostSkeleton } from '../components/States';
import { removeFrom, useFeedEvents } from '../components/feedEvents';
import { api } from '../lib/api';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { usePaged } from '../lib/usePaged';

export default function Home(_props: { params: Record<string, string> }) {
  const { me, loading } = useSession();
  if (loading)
    return (
      <>
        <PageHead title="Home" />
        <PostSkeleton count={4} />
      </>
    );
  if (!me) return <Welcome />;
  return <HomeFeed />;
}

const POLL_MS = 60_000;

function HomeFeed() {
  const { me } = useSession();
  const replies = !!me?.settings.feedReplies;
  const reposts = !!me?.settings.feedReposts;
  const query = { replies: replies ? 1 : 0, reposts: reposts ? 1 : 0 };
  const list = usePaged<FeedItem>(me ? `home:${me.id}:${query.replies}${query.reposts}` : null, (cursor) =>
    api.get<Page<FeedItem>>('/feed/home', { cursor, ...query }),
  );
  const { setItems, items, loaded, reload } = list;
  const [fresh, setFresh] = useState(false);
  const [dialOpen, setDialOpen] = useState(false);
  const known = useRef(new Set<string>());
  known.current = new Set(items.map((i) => i.key));

  useFeedEvents(setItems, (p) => !p.replyToId);

  // Look for newer posts once a minute while the tab is visible; never auto-insert them under the reader.
  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      try {
        const page = await api.get<Page<FeedItem>>('/feed/home', { replies: query.replies, reposts: query.reposts });
        const top = page.items[0]?.key;
        if (!stopped && top && !known.current.has(top)) setFresh(true);
      } catch {
        /* try again next tick */
      }
    };
    const id = window.setInterval(check, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [loaded, query.replies, query.reposts]);

  useEffect(() => setFresh(false), [replies, reposts]);

  const showNew = () => {
    setFresh(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    void reload();
  };

  return (
    <>
      <PageHead
        title="Home"
        sub={`Following · newest first${replies ? '' : ' · replies off'}${reposts ? '' : ' · reposts off'}`}
        actions={
          <button className="btn btn-sm only-narrow" onClick={() => setDialOpen(true)} aria-haspopup="dialog">
            <Icon name="dial" size={16} />
            Dial
          </button>
        }
      />
      <InlineComposer />
      <div className="new-pill-wrap" aria-live="polite">
        {fresh && (
          <button className="new-pill" onClick={showNew}>
            <span aria-hidden="true">↑</span> New posts
          </button>
        )}
      </div>
      <section aria-label="Home feed">
        <InfiniteList
          hasMore={list.hasMore}
          loading={list.loading}
          loaded={loaded}
          error={list.error}
          onMore={list.loadMore}
          skeleton={<PostSkeleton count={5} />}
          empty={
            <EmptyState
              title="Nothing here yet."
              action={
                <Link to="/explore" className="btn btn-primary">
                  Find people on Explore
                </Link>
              }
            >
              Follow a few people from Explore and their posts will show up here, newest first. Anything you write appears here too.
            </EmptyState>
          }
        >
          {items.map((it) => (
            <PostItem key={it.key} post={it.post} repostedBy={it.repostedBy} onRemoved={removeFrom(setItems)} />
          ))}
        </InfiniteList>
      </section>
      {dialOpen && (
        <Dialog title="The Dial" onClose={() => setDialOpen(false)}>
          <p className="dial-lede dial-lede-dialog">Your home feed is chronological. You decide what goes in it.</p>
          <Dial compact />
        </Dialog>
      )}
    </>
  );
}

const PRINCIPLES: [string, string][] = [
  ['No ads, ever.', 'Nothing here is for sale, including your attention. There’s no reason to keep you scrolling, so we don’t try.'],
  ['Chronological.', 'Your home feed is the people you follow, newest first. No engagement ranking, no “suggested for you”.'],
  ['Text first.', 'Posts up to 500 characters, set for reading. Long threads open in a quiet, single-column reading view.'],
  ['Your feed, your rules.', 'Turn replies and reposts on or off, mute words, hide counts. Blocks and mutes do exactly what they say.'],
];

function Welcome() {
  return (
    <div className="welcome">
      <header className="welcome-head">
        <p className="kicker">Relay 3.0 · independent &amp; ad-free</p>
        <h1 className="welcome-title">
          A social network for <em>reading</em>, not scrolling.
        </h1>
        <p className="welcome-lede">
          Relay is a text-first place to write, follow people and talk. What you see is who you follow, in the order they wrote it —
          nothing ranked, nothing sold, nothing slipped in.
        </p>
        <div className="welcome-cta">
          <Link to="/signup" className="btn btn-signal">
            Join Relay
          </Link>
          <Link to="/login" className="btn">
            Sign in
          </Link>
          <Link to="/explore" className="welcome-explore">
            Browse Explore <span aria-hidden="true">→</span>
          </Link>
        </div>
      </header>
      <ol className="welcome-principles">
        {PRINCIPLES.map(([title, body], i) => (
          <li key={title}>
            <span className="welcome-num meta" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <h2>{title}</h2>
            <p>{body}</p>
          </li>
        ))}
      </ol>
      <p className="welcome-foot">
        Before you join, read the <Link to="/rules">community rules</Link> — they’re short. Curious how it works?{' '}
        <Link to="/about">About Relay</Link>.
      </p>
    </div>
  );
}
