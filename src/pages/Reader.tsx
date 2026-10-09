import { useEffect, useRef, useState } from 'react';
import type { ReaderView } from '../../shared/types';
import { Avatar } from '../components/Avatar';
import { NotFoundState } from '../components/NotFoundState';
import { PageHead } from '../components/PageHead';
import { RichText } from '../components/RichText';
import { SignalMark } from '../components/Shell';
import { ErrorState, Loading } from '../components/States';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { setPrefs, usePrefs, type Prefs } from '../lib/prefs';
import { Link, postPath, profilePath } from '../lib/router';

const longDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });
const WPM = 230;

function words(s: string) {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Thin signal-coloured bar showing how far through the piece you are. */
function Progress() {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = bar.current;
      if (!el) return;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 1;
      el.style.transform = `scaleX(${p})`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <div className="reader-progress" aria-hidden="true">
      <div ref={bar} />
    </div>
  );
}

const SIZES: { v: Prefs['text']; label: string }[] = [
  { v: 's', label: 'Small' },
  { v: 'm', label: 'Medium' },
  { v: 'l', label: 'Large' },
  { v: 'xl', label: 'Extra large' },
];

function TextSize() {
  const prefs = usePrefs();
  return (
    <div className="segmented reader-size" role="group" aria-label="Text size">
      {SIZES.map((s, i) => (
        <button key={s.v} aria-pressed={prefs.text === s.v} aria-label={`${s.label} text`} onClick={() => setPrefs({ text: s.v })}>
          <span aria-hidden="true" style={{ fontSize: 11 + i * 2.5 }}>
            A
          </span>
        </button>
      ))}
    </div>
  );
}

export default function Reader({ params }: { params: Record<string, string> }) {
  const id = params.id;
  const [data, setData] = useState<ReaderView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    api.get<ReaderView>(`/posts/${id}/reader`).then(
      (r) => live && setData(r),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [id, attempt]);

  if (error) {
    const status = error instanceof ApiRequestError ? error.status : 0;
    return (
      <>
        <PageHead title="Reading view" back={`/post/${id}`} />
        {status === 404 ? (
          <NotFoundState title="There’s nothing to read here.">
            <p>The post may have been deleted, or the link is wrong.</p>
          </NotFoundState>
        ) : status === 403 ? (
          <NotFoundState title="This piece is unavailable." code="—">
            <p>It’s from a private account you don’t follow, or from someone you can’t see.</p>
          </NotFoundState>
        ) : (
          <ErrorState message={errorMessage(error)} onRetry={() => setAttempt((a) => a + 1)} />
        )}
      </>
    );
  }

  if (!data)
    return (
      <>
        <PageHead title="Reading view" back={`/post/${id}`} />
        <Loading label="Loading the reading view" />
      </>
    );

  const { author, posts, otherReplies } = data;
  const root = posts[0];
  const n = posts.length;
  const minutes = Math.max(1, Math.round(posts.reduce((s, p) => s + words(p.body), 0) / WPM));
  const edited = posts.some((p) => p.editedAt);
  const lastAt = posts[n - 1]?.createdAt ?? root?.createdAt;
  const spanDays = root && lastAt ? Math.round((new Date(lastAt).getTime() - new Date(root.createdAt).getTime()) / 86_400_000) : 0;

  return (
    <article className="reader" aria-labelledby="reader-title">
      <Progress />
      <div className="reader-top">
        <Link to={root ? postPath(root.id) : '/'} className="reader-back">
          <span aria-hidden="true">←</span> Conversation
        </Link>
        <TextSize />
      </div>

      <header className="reader-head">
        <p className="kicker">{n > 1 ? `A thread in ${n} parts` : 'A post'}</p>
        <h1 id="reader-title" className="reader-title">
          {author.displayName}
        </h1>
        <div className="reader-byline">
          <Link to={profilePath(author.handle)} tabIndex={-1} aria-hidden="true">
            <Avatar user={author} size={40} />
          </Link>
          <p className="reader-byline-text">
            <Link to={profilePath(author.handle)} className="reader-handle">
              @{author.handle}
            </Link>
            {root && (
              <>
                <span aria-hidden="true"> · </span>
                <time dateTime={root.createdAt}>{longDate.format(new Date(root.createdAt))}</time>
              </>
            )}
            <span aria-hidden="true"> · </span>
            <span>{minutes} min read</span>
          </p>
        </div>
      </header>

      <div className="reader-body">
        {posts.map((p, i) => (
          <section key={p.id} id={`part-${i + 1}`} className="reader-part" aria-label={n > 1 ? `Part ${i + 1} of ${n}` : undefined}>
            {n > 1 && (
              <Link to={postPath(p.id)} className="reader-marker" title="Open this part in its conversation">
                <span className="sr-only">Part </span>
                {i + 1}
                <span className="reader-marker-of">/{n}</span>
              </Link>
            )}
            <div className="reader-text read">
              {p.deleted || p.unavailable ? (
                <p className="reader-gone">{p.unavailable ? 'This part is unavailable.' : p.removed ? 'This part was removed.' : 'This part was deleted by its author.'}</p>
              ) : (
                <RichText text={p.body} mentions={p.mentions} />
              )}
            </div>
          </section>
        ))}
      </div>

      <footer className="reader-foot">
        <span className="reader-end" aria-hidden="true">
          <SignalMark className="reader-end-mark" />
        </span>
        <p className="reader-colophon meta">
          {n > 1 && spanDays > 0 ? `Written over ${plural(spanDays + 1, 'day')}` : 'Published on Relay'}
          {edited ? ' · some parts edited' : ''}
        </p>
        {root && (
          <p className="reader-conversation">
            {otherReplies > 0 ? (
              <>
                {plural(otherReplies, 'other reply', 'other replies')} —{' '}
                <Link to={postPath(root.id)}>view the conversation →</Link>
              </>
            ) : (
              <>
                No replies from others yet — <Link to={`${postPath(root.id)}?reply=1`}>start the conversation →</Link>
              </>
            )}
          </p>
        )}
      </footer>
    </article>
  );
}
