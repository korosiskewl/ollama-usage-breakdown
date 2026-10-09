import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Post, ReaderView, Thread } from '../../shared/types';
import { InlineComposer } from '../components/Composer';
import { Icon } from '../components/Icon';
import { NotFoundState } from '../components/NotFoundState';
import { PageHead } from '../components/PageHead';
import { PostItem } from '../components/PostItem';
import { ErrorState, PostSkeleton } from '../components/States';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { onPostEvent } from '../lib/composer';
import { plural } from '../lib/format';
import { Link, useLocation } from '../lib/router';
import { useSession } from '../lib/session';

export default function PostThread({ params }: { params: Record<string, string> }) {
  const id = params.id;
  const { me } = useSession();
  const { query } = useLocation();
  const wantReply = query.get('reply') === '1';

  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [replies, setReplies] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [readerParts, setReaderParts] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const focusRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  useEffect(() => {
    let live = true;
    setError(null);
    api.get<Thread>(`/posts/${id}/thread`).then(
      (t) => {
        if (!live) return;
        setThread(t);
        setReplies(t.replies.items);
        setCursor(t.replies.nextCursor);
      },
      (e) => live && setError(e),
    );
    api.get<ReaderView>(`/posts/${id}/reader`).then(
      (r) => live && setReaderParts(r.posts.filter((p) => !p.deleted && !p.unavailable).length),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [id, attempt]);

  // Bring the focused post into view when there is context above it.
  useLayoutEffect(() => {
    if (!thread || scrolled.current) return;
    scrolled.current = true;
    if (thread.ancestors.length > 0 && !wantReply) focusRef.current?.scrollIntoView({ block: 'start' });
  }, [thread, wantReply]);

  // Keep the thread in sync with replies written or edited from anywhere.
  const threadRef = useRef(thread);
  threadRef.current = thread;
  useEffect(
    () =>
      onPostEvent((e) => {
        const p = e.post;
        if (e.type === 'created') {
          const focusId = threadRef.current?.post.id;
          if (!focusId) return;
          if (p.replyToId === focusId) {
            setReplies((rs) => (rs.some((r) => r.id === p.id) ? rs : [...rs, p]));
            setThread((t) => t && { ...t, post: { ...t.post, counts: { ...t.post.counts, replies: t.post.counts.replies + 1 } } });
          } else {
            setReplies((rs) => rs.map((r) => (r.id === p.replyToId ? { ...r, counts: { ...r.counts, replies: r.counts.replies + 1 } } : r)));
          }
        } else {
          setThread((t) =>
            t && {
              ...t,
              post: t.post.id === p.id ? p : t.post,
              ancestors: t.ancestors.map((a) => (a.id === p.id ? p : a)),
            },
          );
          setReplies((rs) => rs.map((r) => (r.id === p.id ? p : r)));
        }
      }),
    [],
  );

  async function loadMore() {
    if (!cursor || more.busy) return;
    setMore({ busy: true, error: null });
    try {
      const t = await api.get<Thread>(`/posts/${id}/thread`, { cursor });
      setReplies((rs) => {
        const seen = new Set(rs.map((r) => r.id));
        return [...rs, ...t.replies.items.filter((r) => !seen.has(r.id))];
      });
      setCursor(t.replies.nextCursor);
      setMore({ busy: false, error: null });
    } catch (e) {
      setMore({ busy: false, error: errorMessage(e) });
    }
  }

  const head = <PageHead title="Post" back="/" />;

  if (error) {
    const status = error instanceof ApiRequestError ? error.status : 0;
    if (status === 404)
      return (
        <>
          {head}
          <NotFoundState title="This post isn’t here.">
            <p>It may have been deleted by its author, or the link is wrong.</p>
          </NotFoundState>
        </>
      );
    if (status === 403)
      return (
        <>
          {head}
          <NotFoundState title="This post is unavailable." code="—">
            <p>It’s from a private account you don’t follow, or from someone who has blocked you or whom you’ve blocked.</p>
          </NotFoundState>
        </>
      );
    return (
      <>
        {head}
        <ErrorState message={errorMessage(error)} onRetry={() => setAttempt((a) => a + 1)} />
      </>
    );
  }

  if (!thread)
    return (
      <>
        {head}
        <PostSkeleton count={3} />
      </>
    );

  const post = thread.post;
  const gone = post.deleted || post.unavailable;
  const canReply = !!me && !gone;

  return (
    <>
      {head}
      {thread.ancestors.length > 0 && (
        <div className="thread-ancestors" aria-label="Earlier in this conversation" role="group">
          {thread.ancestors.map((a) => (
            <PostItem key={a.id} post={a} variant="ancestor" />
          ))}
        </div>
      )}
      <div ref={focusRef} className="thread-focus">
        <PostItem
          post={post}
          variant="focus"
          showReplyContext={thread.ancestors.length === 0}
          onChange={(p) => setThread((t) => t && { ...t, post: p })}
        />
      </div>
      {readerParts >= 3 && (
        <Link to={`/post/${post.rootId}/read`} className="reader-cta">
          <Icon name="book" size={18} />
          <span>
            <strong>Read as one piece</strong>
            <span className="meta"> · {readerParts}-part thread</span>
          </span>
          <span className="reader-cta-go" aria-hidden="true">
            →
          </span>
        </Link>
      )}
      {canReply && (
        <div className="thread-reply">
          <InlineComposer replyTo={post} autoFocus={wantReply} placeholder={`Reply to @${post.author.handle}…`} />
        </div>
      )}
      {!me && !gone && (
        <p className="thread-signin">
          <Link to={`/login?next=${encodeURIComponent(`/post/${post.id}`)}`}>Sign in</Link> or{' '}
          <Link to="/signup">join Relay</Link> to reply.
        </p>
      )}
      <section aria-label="Replies" className="thread-replies">
        <h2 className="sr-only">Replies</h2>
        {replies.length === 0 && !cursor ? (
          <p className="thread-empty">{gone ? 'No replies.' : me ? 'No replies yet. Start the conversation.' : 'No replies yet.'}</p>
        ) : (
          replies.map((r) => (
            <PostItem
              key={r.id}
              post={r}
              variant="reply"
              showReplyContext={false}
              onRemoved={(p) => setReplies((rs) => (p.deleted ? rs : rs.filter((x) => x.author.id !== p.author.id)))}
            />
          ))
        )}
        {cursor && (
          <div className="list-more">
            {more.error && (
              <p className="field-error" role="alert">
                {more.error}
              </p>
            )}
            <button className="btn btn-sm" onClick={() => void loadMore()} disabled={more.busy}>
              {more.busy && <span className="spinner" />}
              Show more replies
            </button>
          </div>
        )}
        {replies.length > 0 && !cursor && <p className="list-end meta">{plural(replies.length, 'reply', 'replies')} · end of thread</p>}
      </section>
    </>
  );
}
