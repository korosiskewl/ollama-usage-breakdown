import { useEffect, useRef, useState } from 'react';
import type { FollowState, Profile, UserSummary } from '../../shared/types';
import { api, errorMessage } from '../lib/api';
import { navigate, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { ConfirmDialog } from './Dialog';

/**
 * Follow / Requested / Following button with optimistic updates and rollback.
 * Renders nothing for your own account. Signed-out visitors are sent to sign in.
 */
export function FollowButton({
  handle,
  initial,
  isPrivate,
  onChange,
  small,
}: {
  handle: string;
  initial: FollowState;
  isPrivate: boolean;
  onChange?: (s: FollowState) => void;
  small?: boolean;
}) {
  const { me } = useSession();
  const loc = useLocation();
  const [state, setState] = useState<FollowState>(initial);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setState(initial);
  }
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  if (me && me.handle.toLowerCase() === handle.toLowerCase()) return null;

  const set = (s: FollowState) => {
    setState(s);
    onChange?.(s);
  };

  async function follow() {
    const prev = state;
    set(isPrivate ? 'pending' : 'active');
    setBusy(true);
    try {
      const r = await api.post<{ state: FollowState }>(`/users/${handle}/follow`);
      set(r.state);
      if (r.state === 'pending') toast(`Request sent. @${handle} will need to approve it.`);
    } catch (e) {
      set(prev);
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function unfollow() {
    const prev = state;
    set('none');
    setBusy(true);
    setConfirm(false);
    try {
      await api.del(`/users/${handle}/follow`);
      if (prev === 'pending') toast('Follow request cancelled.');
    } catch (e) {
      set(prev);
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const cls = 'btn follow-btn' + (small ? ' btn-sm' : '');

  if (!me) {
    const next = loc.path + (loc.query.toString() ? `?${loc.query}` : '');
    return (
      <button className={cls + ' btn-primary'} onClick={() => navigate(`/login?next=${encodeURIComponent(next)}`)}>
        Follow
      </button>
    );
  }

  if (state === 'none') {
    return (
      <button className={cls + ' btn-primary'} onClick={() => void follow()} disabled={busy} aria-label={`Follow @${handle}`}>
        Follow
      </button>
    );
  }

  return (
    <>
      <button
        className={cls + ' follow-on'}
        data-state={state}
        onClick={() => (state === 'active' && isPrivate ? setConfirm(true) : void unfollow())}
        disabled={busy}
        aria-label={state === 'active' ? `Following @${handle}. Unfollow` : `Requested to follow @${handle}. Cancel request`}
      >
        <span className="follow-idle" aria-hidden="true">
          {state === 'active' ? 'Following' : 'Requested'}
        </span>
        <span className="follow-hover" aria-hidden="true">
          {state === 'active' ? 'Unfollow' : 'Cancel'}
        </span>
      </button>
      {confirm && (
        <ConfirmDialog
          title={`Unfollow @${handle}?`}
          body="This account is private. To see their posts again you’ll need to send a new request and wait for approval."
          confirmLabel="Unfollow"
          danger
          onConfirm={() => void unfollow()}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  );
}

// Profiles fetched for list rows, so scrolling back and forth doesn't refetch.
const stateCache = new Map<string, Promise<FollowState | null>>();

/**
 * Follow button for list rows where the viewer's follow state isn't known up front (UserSummary lists).
 * Resolves the state lazily when the row scrolls into view. Pass `known` when the state is already known.
 */
export function UserFollowButton({ user, known }: { user: UserSummary; known?: FollowState }) {
  const { me } = useSession();
  const [state, setState] = useState<FollowState | null>(known ?? null);
  const ref = useRef<HTMLSpanElement>(null);
  const self = !!me && me.id === user.id;

  useEffect(() => {
    if (known || !me || self || state) return;
    const el = ref.current;
    if (!el) return;
    let live = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        io.disconnect();
        const key = `${me.id}:${user.handle.toLowerCase()}`;
        let p = stateCache.get(key);
        if (!p) {
          p = api.get<Profile>(`/users/${user.handle}`).then(
            (pr) => pr.viewer?.following ?? null,
            () => null,
          );
          stateCache.set(key, p);
        }
        void p.then((s) => {
          if (!live) return;
          if (s === null) stateCache.delete(key);
          setState(s ?? 'none');
        });
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [known, me, self, state, user.handle]);

  if (self || user.suspended) return null;
  if (!me) return <FollowButton handle={user.handle} initial="none" isPrivate={user.isPrivate} small />;
  return (
    <span ref={ref} className="follow-slot">
      {state ? (
        <FollowButton
          handle={user.handle}
          initial={state}
          isPrivate={user.isPrivate}
          small
          onChange={(s) => stateCache.set(`${me.id}:${user.handle.toLowerCase()}`, Promise.resolve(s))}
        />
      ) : (
        <span className="btn btn-sm follow-btn follow-pending-skel" aria-hidden="true">
          Follow
        </span>
      )}
    </span>
  );
}
