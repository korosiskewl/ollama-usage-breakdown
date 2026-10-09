import { useState } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import { PageHead } from '../components/PageHead';
import { PREVIEW, errorMessage } from '../lib/api';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';

const PRINCIPLES: [string, string][] = [
  [
    'No ads. Not now, not later.',
    'Relay doesn’t sell attention, so it has no reason to keep you scrolling. There are no promoted posts, no sponsored accounts and no tracking pixels.',
  ],
  [
    'Chronological, always.',
    'Your home feed is the people you follow, newest first. Explore is everyone’s public posts, newest first. Nothing is ranked by engagement, and nothing is inserted.',
  ],
  [
    'Text first.',
    'Posts are up to 500 characters and set in a reading typeface. Long threads by one author open in a quiet reading view, so writing that deserves attention gets it.',
  ],
  [
    'Your feed, your rules.',
    'Turn replies and reposts on or off, mute words, hide like and repost counts, choose who can message you. Private accounts approve every follower.',
  ],
  [
    'AI is optional — and off until you turn it on.',
    'If the server has an assistant configured, you can opt in to help tightening a draft or summarising a long thread. It never posts for you, and it only sees what you can see.',
  ],
  [
    'Privacy by default.',
    'Sessions use a secure, HttpOnly cookie. We store what’s needed to run the service and nothing more. You can sign out other sessions or delete your account from Settings.',
  ],
];

export default function About(_props: { params: Record<string, string> }) {
  const { me } = useSession();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    try {
      if (import.meta.env.VITE_RELAY_MODE !== 'preview') return;
      const { resetPreview } = await import('../preview/runtime');
      await resetPreview();
    } catch (e) {
      setBusy(false);
      setConfirm(false);
      toast(errorMessage(e), { kind: 'error' });
    }
  }

  return (
    <>
      <PageHead title="About Relay" back="/" />
      <article className="prose">
        <header className="prose-head">
          <p className="kicker">Relay 3.0</p>
          <h2 className="prose-title">An independent, ad-free, text-first social network.</h2>
          <p className="prose-lede">
            Relay is for people who like to read what their friends write, in the order they wrote it. It’s small on purpose: posts,
            replies, follows, direct messages, collections — and a few honest tools for shaping your own experience.
          </p>
        </header>

        <section className="prose-section" aria-labelledby="principles">
          <h2 id="principles">Principles</h2>
          <ol className="principles">
            {PRINCIPLES.map(([t, b]) => (
              <li key={t}>
                <h3>{t}</h3>
                <p>{b}</p>
              </li>
            ))}
          </ol>
        </section>

        {PREVIEW && (
          <section className="prose-section preview-explainer" aria-labelledby="preview">
            <h2 id="preview">About this preview build</h2>
            <p>
              You’re using a preview of Relay that runs <strong>entirely in your browser</strong>. The real server code runs here too, against
              a SQLite database compiled to WebAssembly and saved in this browser’s storage (IndexedDB). Nothing you write leaves this
              device, and nobody else can see it.
            </p>
            <ul className="prose-list">
              <li>
                <strong>Demo accounts are sample content.</strong> The people and posts you see were generated to show how Relay works —
                they aren’t real users.
              </li>
              <li>
                <strong>Try both sides.</strong> Sample accounts say “Demo account” in their bio, and every one of them uses the password{' '}
                <code>relay-preview-demo</code>. Sign in as one in another browser profile (or sign out and back in) to test direct messages,
                follow requests and notifications from the other end.
              </li>
              <li>
                <strong>You can moderate.</strong> The first account you create becomes an admin, so the moderation queue and tools are
                yours to try.
              </li>
              <li>
                <strong>It’s yours to wipe.</strong> Clearing your browser data removes everything — or reset it below to start over with
                fresh sample content.
              </li>
            </ul>
            <div className="preview-reset">
              <button className="btn btn-danger" onClick={() => setConfirm(true)}>
                Reset preview data
              </button>
              <p className="hint">Deletes every account, post and message stored in this browser{me ? ', and signs you out' : ''}.</p>
            </div>
          </section>
        )}

        <section className="prose-section" aria-labelledby="community">
          <h2 id="community">Community</h2>
          <p>
            Relay has a short set of <Link to="/rules">community rules</Link>, enforced by human moderators whose actions are logged.
            Blocks, mutes and muted words are there so you don’t need a moderator for everything.
          </p>
        </section>

        <footer className="prose-foot meta">Relay 3.0 · independent &amp; ad-free</footer>
      </article>

      {confirm && (
        <ConfirmDialog
          title="Reset preview data?"
          body="Everything stored by this preview in this browser — your accounts, posts, messages and settings — will be deleted and replaced with fresh sample content. This can’t be undone."
          confirmLabel="Reset everything"
          danger
          busy={busy}
          onConfirm={() => void reset()}
          onClose={() => !busy && setConfirm(false)}
        />
      )}
    </>
  );
}
