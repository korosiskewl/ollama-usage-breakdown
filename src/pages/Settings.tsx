import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Me, Page, SessionInfo, Settings as AccountSettings, UserSummary } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { fullTime, plural, relativeTime } from '../lib/format';
import { setPrefs, usePrefs, type Prefs } from '../lib/prefs';
import { Link, navigate, profilePath } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { usePaged } from '../lib/usePaged';
import { useAiStatus } from '../components/AiAssist';
import { Avatar } from '../components/Avatar';
import { Dialog } from '../components/Dialog';
import { Icon, type IconName } from '../components/Icon';
import { PageHead } from '../components/PageHead';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { UserRow } from '../components/UserRow';

type SectionId = 'profile' | 'account' | 'privacy' | 'muting' | 'notifications' | 'appearance' | 'ai';

const SECTIONS: { id: SectionId; label: string; icon: IconName; blurb: string }[] = [
  { id: 'profile', label: 'Profile', icon: 'user', blurb: 'Your name, bio and avatar' },
  { id: 'account', label: 'Account', icon: 'lock', blurb: 'Password, signed-in devices, delete account' },
  { id: 'privacy', label: 'Privacy & safety', icon: 'shield', blurb: 'Private account, messages, blocks and mutes' },
  { id: 'muting', label: 'Muted words', icon: 'mute', blurb: 'Hide posts that contain certain words' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', blurb: 'Choose what you’re notified about' },
  { id: 'appearance', label: 'Appearance', icon: 'sun', blurb: 'Theme, text size and reading font' },
  { id: 'ai', label: 'AI assist', icon: 'sparkle', blurb: 'Optional writing assistant — off by default' },
];

// ---------------------------------------------------------------------------- shared helpers

function useSaved() {
  const [on, setOn] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    setOn(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), 2200);
  }, []);
  return { on, flash };
}

function SavedNote({ on }: { on: boolean }) {
  return (
    <span className="saved" data-on={on || undefined} role="status" aria-live="polite">
      {on && (
        <>
          <Icon name="check" size={14} /> Saved
        </>
      )}
    </span>
  );
}

function SectionHead({ title, desc, saved }: { title: string; desc?: ReactNode; saved?: boolean }) {
  return (
    <header className="set-head">
      <div>
        <h2 className="set-title">{title}</h2>
        {desc && <p className="set-desc">{desc}</p>}
      </div>
      {saved !== undefined && <SavedNote on={saved} />}
    </header>
  );
}

function Group({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  const id = useId();
  return (
    <section className="set-group" aria-labelledby={id}>
      <h3 className="kicker set-group-title" id={id}>
        {title}
      </h3>
      {note && <p className="set-group-note">{note}</p>}
      {children}
    </section>
  );
}

/** Live session `me` plus a ref that always holds the newest value (for optimistic updates that overlap). */
function useMeRef() {
  const { me, setMe } = useSession();
  const ref = useRef(me);
  ref.current = me;
  const put = useCallback(
    (m: Me) => {
      ref.current = m;
      setMe(m);
    },
    [setMe],
  );
  return { ref, put };
}

/** Optimistic PATCH /me/settings: applies locally, keeps the server's normalised value, rolls back on failure. */
function useSettingsPatch(onSaved: () => void) {
  const { ref, put } = useMeRef();
  const { refresh } = useSession();
  return useCallback(
    async (patch: Partial<AccountSettings>): Promise<boolean> => {
      const cur = ref.current;
      if (!cur) return false;
      const prev = cur.settings;
      const merge = (base: AccountSettings, src: Partial<AccountSettings>): AccountSettings => {
        const out = { ...base } as AccountSettings;
        for (const k of Object.keys(patch) as (keyof AccountSettings)[]) {
          if (k === 'notify') {
            const keys = Object.keys(patch.notify ?? {}) as (keyof AccountSettings['notify'])[];
            const n = { ...base.notify };
            for (const nk of keys) n[nk] = (src.notify ?? prev.notify)[nk];
            out.notify = n;
          } else {
            (out as unknown as Record<string, unknown>)[k] = src[k];
          }
        }
        return out;
      };
      put({ ...cur, settings: merge(cur.settings, patch) });
      try {
        const s = await api.patch<AccountSettings>('/me/settings', patch);
        const now = ref.current;
        if (now) put({ ...now, settings: merge(now.settings, s) });
        onSaved();
        return true;
      } catch (e) {
        const now = ref.current;
        if (now) put({ ...now, settings: merge(now.settings, prev) });
        toast(errorMessage(e), { kind: 'error' });
        void refresh();
        return false;
      }
    },
    [ref, put, refresh, onSaved],
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="switch set-switch">
      <span className="set-switch-text">
        <span className="set-switch-label">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => value !== o.value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------- page

export default function Settings({ params }: { params: Record<string, string> }) {
  const { me, loading } = useSession();
  const requested = params.section as SectionId | undefined;
  const known = SECTIONS.some((s) => s.id === requested);

  if (loading) return <Loading />;

  if (!me) {
    return (
      <div className="settings">
        <PageHead title="Settings" />
        <div className="notice set-signed-out">
          <Link to="/login">Sign in</Link> to manage your account, privacy and notifications. Appearance settings below apply to this
          device whether or not you’re signed in.
        </div>
        <div className="set-solo">
          <AppearanceSection />
        </div>
      </div>
    );
  }

  if (requested && !known) {
    return (
      <div className="settings">
        <PageHead title="Settings" />
        <EmptyState
          title="There’s no such settings page."
          action={
            <Link to="/settings" className="btn">
              All settings
            </Link>
          }
        />
      </div>
    );
  }

  const active: SectionId = requested ?? 'profile';
  const current = SECTIONS.find((s) => s.id === active)!;

  return (
    <div className="settings">
      <PageHead title="Settings" />
      <div className="set-layout" data-has-section={requested ? '' : undefined}>
        <nav className="set-nav" aria-label="Settings sections">
          <ul role="list">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <Link
                  to={`/settings/${s.id}`}
                  className="set-nav-link"
                  aria-current={s.id === active && (requested || undefined) ? 'page' : s.id === active ? 'true' : undefined}
                  onClick={(e) => {
                    // Keep the history stack shallow when hopping between sections.
                    if (requested && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
                      e.preventDefault();
                      navigate(`/settings/${s.id}`, { replace: true });
                    }
                  }}
                >
                  <Icon name={s.icon} size={18} />
                  <span className="set-nav-text">
                    <span className="set-nav-label">{s.label}</span>
                    <span className="set-nav-blurb">{s.blurb}</span>
                  </span>
                  <span className="set-nav-chev" aria-hidden="true">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="set-content" aria-label={current.label} role="region">
          <Link to="/settings" className="set-back meta">
            ← All settings
          </Link>
          {active === 'profile' && <ProfileSection me={me} />}
          {active === 'account' && <AccountSection me={me} />}
          {active === 'privacy' && <PrivacySection me={me} />}
          {active === 'muting' && <MutingSection me={me} />}
          {active === 'notifications' && <NotificationsSection me={me} />}
          {active === 'appearance' && <AppearanceSection />}
          {active === 'ai' && <AiSection me={me} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- profile

function ProfileSection({ me }: { me: Me }) {
  return (
    <>
      <SectionHead title="Profile" desc="How you appear to other people on Relay." />
      <div className="set-profile">
        <Avatar user={me} size={64} />
        <div className="set-profile-text">
          <p className="set-profile-name">{me.displayName}</p>
          <p className="meta">@{me.handle}</p>
          {me.bio ? <p className="set-profile-bio read">{me.bio}</p> : <p className="hint">No bio yet.</p>}
          <p className="meta set-profile-since">Member since {new Date(me.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
        </div>
      </div>
      <div className="set-actions">
        <Link to={profilePath(me.handle)} className="btn btn-primary">
          <Icon name="edit" size={16} />
          Edit on your profile
        </Link>
        <span className="hint">Your name, bio and avatar are edited right on your profile page, so you can see the result as you go.</span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------- account

function describeAgent(ua: string): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? (ua.length > 48 ? ua.slice(0, 48) + '…' : ua);
}

function AccountSection({ me }: { me: Me }) {
  const { signOut } = useSession();
  const [sessionsKey, setSessionsKey] = useState(0);
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <SectionHead title="Account" desc={`Signed in as @${me.handle}.`} />
      <Group title="Change password" note="Changing your password signs you out on every other device.">
        <PasswordForm onChanged={() => setSessionsKey((k) => k + 1)} />
      </Group>
      <Group title="Where you’re signed in">
        <Sessions key={sessionsKey} />
      </Group>
      <Group title="Sign out">
        <div className="set-row">
          <p className="hint">Sign out of Relay on this device.</p>
          <button
            className="btn"
            onClick={() =>
              void signOut().then(() => {
                navigate('/');
                toast('Signed out. See you soon.');
              })
            }
          >
            <Icon name="logout" size={16} />
            Sign out
          </button>
        </div>
      </Group>
      <Group title="Delete account">
        <div className="set-danger">
          <p>
            Deleting your account removes your profile, posts, messages and collections, and frees your handle after a while. This can’t be
            undone.
          </p>
          <button className="btn btn-danger" onClick={() => setDeleting(true)}>
            <Icon name="trash" size={16} />
            Delete account…
          </button>
        </div>
      </Group>
      {deleting && <DeleteAccountDialog me={me} onClose={() => setDeleting(false)} />}
    </>
  );
}

function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const uid = useId();

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!current) e.currentPassword = 'Enter your current password.';
    if (next.length < LIMITS.password.min) e.newPassword = `Use at least ${LIMITS.password.min} characters.`;
    else if (next.length > LIMITS.password.max) e.newPassword = `Use at most ${LIMITS.password.max} characters.`;
    else if (next === current) e.newPassword = 'Choose a password you haven’t been using.';
    if (!e.newPassword && confirm !== next) e.confirm = 'The two new passwords don’t match.';
    return e;
  }

  async function submit() {
    const e = validate();
    setErrors(e);
    setFormError(null);
    setDone(false);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api.post('/auth/password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      onChanged();
    } catch (err) {
      if (err instanceof ApiRequestError && Object.keys(err.fields).length) setErrors(err.fields);
      else setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const field = (key: string, label: string, value: string, set: (v: string) => void, autoComplete: string, hint?: string) => (
    <div className="field">
      <label htmlFor={`${uid}-${key}`}>{label}</label>
      <input
        id={`${uid}-${key}`}
        className="input"
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => set(e.target.value)}
        aria-invalid={!!errors[key] || undefined}
        aria-describedby={errors[key] || hint ? `${uid}-${key}-d` : undefined}
      />
      {errors[key] ? (
        <p className="field-error" id={`${uid}-${key}-d`}>
          {errors[key]}
        </p>
      ) : (
        hint && (
          <p className="hint" id={`${uid}-${key}-d`}>
            {hint}
          </p>
        )
      )}
    </div>
  );

  return (
    <form
      className="stack-form set-password"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {field('currentPassword', 'Current password', current, setCurrent, 'current-password')}
      {field('newPassword', 'New password', next, setNext, 'new-password', `At least ${LIMITS.password.min} characters. A short sentence works well.`)}
      {field('confirm', 'Confirm new password', confirm, setConfirm, 'new-password')}
      {formError && (
        <p className="field-error" role="alert">
          {formError}
        </p>
      )}
      <div className="set-form-foot">
        <button className="btn btn-primary" type="submit" disabled={busy || !current || !next || !confirm}>
          {busy && <span className="spinner" />}
          Change password
        </button>
        <span role="status" aria-live="polite" className="set-ok">
          {done && (
            <>
              <Icon name="check" size={14} /> Password changed. Other devices were signed out.
            </>
          )}
        </span>
      </div>
    </form>
  );
}

function Sessions() {
  const [items, setItems] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = () => {
    setError(null);
    api.get<{ items: SessionInfo[] }>('/auth/sessions').then(
      (r) => setItems(r.items),
      (e) => setError(errorMessage(e)),
    );
  };
  useEffect(load, []);

  async function revoke(targets: SessionInfo[]) {
    if (!items || !targets.length) return;
    const before = items;
    const ids = new Set(targets.map((t) => t.id));
    setBusy((b) => new Set([...b, ...ids]));
    setItems((list) => list?.filter((s) => !ids.has(s.id)) ?? list);
    const results = await Promise.allSettled(targets.map((t) => api.del(`/auth/sessions/${t.id}`)));
    const failed = targets.filter((_, i) => results[i].status === 'rejected');
    if (failed.length) {
      const failedIds = new Set(failed.map((f) => f.id));
      setItems((list) => {
        const keep = new Set((list ?? []).map((s) => s.id));
        return before.filter((s) => keep.has(s.id) || failedIds.has(s.id));
      });
      const r = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
      toast(errorMessage(r.reason), { kind: 'error' });
    } else {
      toast(targets.length === 1 ? 'Signed out that device.' : `Signed out ${plural(targets.length, 'other device')}.`);
    }
    setBusy(new Set());
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <Loading label="Loading sessions" />;

  const sorted = [...items].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt));
  const others = sorted.filter((s) => !s.current);

  return (
    <>
      <ul className="set-sessions" role="list">
        {sorted.map((s) => (
          <li key={s.id} className="set-session">
            <div className="set-session-text">
              <p className="set-session-name">
                {describeAgent(s.userAgent)}
                {s.current && <span className="tag tag-moss">this device</span>}
              </p>
              <p className="meta">
                <span title={fullTime(s.lastSeenAt)}>active {relativeTime(s.lastSeenAt)}</span> ·{' '}
                <span title={fullTime(s.createdAt)}>signed in {new Date(s.createdAt).toLocaleDateString()}</span>
              </p>
            </div>
            {!s.current && (
              <button className="btn btn-sm" onClick={() => void revoke([s])} disabled={busy.has(s.id)} aria-label={`Sign out ${describeAgent(s.userAgent)}`}>
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
      {others.length > 1 && (
        <button className="btn btn-sm btn-ghost set-sessions-all" onClick={() => void revoke(others)} disabled={busy.size > 0}>
          Sign out all other devices
        </button>
      )}
    </>
  );
}

function DeleteAccountDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const { setMe } = useSession();
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const matches = typed.trim().replace(/^@/, '').toLowerCase() === me.handle.toLowerCase();

  async function submit() {
    if (!matches || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/delete-account', { password });
      setMe(null);
      navigate('/', { replace: true });
      toast('Your account has been deleted. Thank you for being part of Relay.');
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Delete your account?"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Keep my account
          </button>
          <button className="btn btn-signal" type="submit" form={`${uid}-form`} disabled={!matches || !password || busy}>
            {busy && <span className="spinner" />}
            Delete permanently
          </button>
        </>
      }
    >
      <form
        id={`${uid}-form`}
        className="stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="notice notice-danger">
          Your profile, posts, messages, collections and follows will be removed. Replies other people wrote stay, but point to a deleted
          post. This can’t be undone.
        </p>
        <div className="field">
          <label htmlFor={`${uid}-pw`}>Your password</label>
          <input id={`${uid}-pw`} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-handle`}>
            Type <span className="meta set-mono-ink">{me.handle}</span> to confirm
          </label>
          <input
            id={`${uid}-handle`}
            className="input"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- privacy

function PrivacySection({ me }: { me: Me }) {
  const saved = useSaved();
  const patch = useSettingsPatch(saved.flash);
  const { ref, put } = useMeRef();
  const { refreshUnread } = useSession();
  const [privBusy, setPrivBusy] = useState(false);

  async function setPrivate(isPrivate: boolean) {
    const cur = ref.current;
    if (!cur || privBusy) return;
    setPrivBusy(true);
    put({ ...cur, isPrivate });
    try {
      const r = await api.patch<{ user: Me }>('/me/profile', { isPrivate });
      const now = ref.current;
      if (now) put({ ...now, isPrivate: r.user.isPrivate });
      saved.flash();
      if (!isPrivate) void refreshUnread();
    } catch (e) {
      const now = ref.current;
      if (now) put({ ...now, isPrivate: !isPrivate });
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setPrivBusy(false);
    }
  }

  return (
    <>
      <SectionHead title="Privacy & safety" desc="Decide who can see your posts and reach you." saved={saved.on} />
      <Group title="Audience">
        <Toggle
          label="Private account"
          checked={me.isPrivate}
          disabled={privBusy}
          onChange={(v) => void setPrivate(v)}
          hint={
            me.isPrivate
              ? 'Only followers you approve can see your posts. Your posts can’t be reposted. Switching back to public approves anyone still waiting.'
              : 'Anyone can see and repost your posts. Turn this on to approve each new follower yourself.'
          }
        />
        <div className="set-row set-row-link">
          <div>
            <p className="set-switch-label">Follow requests</p>
            <p className="hint">
              {me.unread.followRequests ? `${plural(me.unread.followRequests, 'person', 'people')} waiting for approval.` : 'No one waiting right now.'}
            </p>
          </div>
          <Link to="/notifications?view=requests" className="btn btn-sm">
            Review
            {me.unread.followRequests > 0 && <span className="badge">{me.unread.followRequests}</span>}
          </Link>
        </div>
      </Group>
      <Group title="Direct messages" note="Who can start a new conversation with you. People you’ve already written to can still reply.">
        <Segmented
          label="Who can message you"
          value={me.settings.dmPolicy}
          onChange={(v) => void patch({ dmPolicy: v })}
          options={[
            { value: 'everyone', label: 'Everyone' },
            { value: 'following', label: 'People I follow' },
            { value: 'nobody', label: 'No one' },
          ]}
        />
      </Group>
      <Group title="Blocked accounts" note="Blocked accounts can’t see your posts, follow you, reply or message you — and you won’t see theirs.">
        <RelationList kind="block" />
      </Group>
      <Group title="Muted accounts" note="Muted accounts disappear from your feeds, search and notifications. They aren’t told.">
        <RelationList kind="mute" />
      </Group>
    </>
  );
}

function RelationList({ kind }: { kind: 'block' | 'mute' }) {
  const list = usePaged<UserSummary>(kind, (cursor) => api.get<Page<UserSummary>>(kind === 'block' ? '/me/blocks' : '/me/mutes', { cursor }));
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const verb = kind === 'block' ? 'Unblock' : 'Unmute';

  async function undo(u: UserSummary) {
    const index = list.items.findIndex((x) => x.id === u.id);
    setBusy((b) => new Set(b).add(u.id));
    list.setItems((items) => items.filter((x) => x.id !== u.id));
    try {
      await api.del(`/users/${u.handle}/${kind}`);
      toast(kind === 'block' ? `Unblocked @${u.handle}.` : `Unmuted @${u.handle}.`);
    } catch (e) {
      list.setItems((items) => (items.some((x) => x.id === u.id) ? items : [...items.slice(0, index), u, ...items.slice(index)]));
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(u.id);
        return n;
      });
    }
  }

  if (list.error && !list.items.length) return <ErrorState message={list.error} onRetry={() => void list.reload()} />;
  if (!list.loaded) return <Loading label={kind === 'block' ? 'Loading blocked accounts' : 'Loading muted accounts'} />;
  if (!list.items.length) return <p className="set-empty">{kind === 'block' ? 'You haven’t blocked anyone.' : 'You haven’t muted anyone.'}</p>;
  return (
    <ul className="set-people" role="list">
      {list.items.map((u) => (
        <li key={u.id}>
          <UserRow
            user={u}
            action={
              <button className="btn btn-sm" onClick={() => void undo(u)} disabled={busy.has(u.id)} aria-label={`${verb} @${u.handle}`}>
                {verb}
              </button>
            }
          />
        </li>
      ))}
      {list.hasMore && (
        <li className="list-more">
          <button className="btn btn-sm btn-ghost" onClick={list.loadMore} disabled={list.loading}>
            {list.loading && <span className="spinner" />}
            Show more
          </button>
        </li>
      )}
    </ul>
  );
}

// ---------------------------------------------------------------------------- muted words

function MutingSection({ me }: { me: Me }) {
  const saved = useSaved();
  const patch = useSettingsPatch(saved.flash);
  const [word, setWord] = useState('');
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const words = me.settings.mutedWords;
  const full = words.length >= LIMITS.mutedWord.count;

  async function add() {
    const w = word.trim().toLowerCase().replace(/\s+/g, ' ');
    setError(null);
    if (!w) return;
    if (charCount(w) > LIMITS.mutedWord.max) return setError(`Keep each muted word or phrase to ${LIMITS.mutedWord.max} characters.`);
    if (words.includes(w)) return setError(`“${w}” is already muted.`);
    if (full) return setError(`You can mute up to ${LIMITS.mutedWord.count} words. Remove one to add another.`);
    setWord('');
    const ok = await patch({ mutedWords: [...words, w] });
    if (!ok) setWord(w);
  }

  return (
    <>
      <SectionHead
        title="Muted words"
        saved={saved.on}
        desc="Posts containing these words or phrases are left out of your Home feed, Explore and search. They still appear in threads you open and on people’s profiles, so nothing is hidden from you silently."
      />
      <form
        className="mute-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label htmlFor={`${uid}-w`} className="label">
          Add a word or phrase
        </label>
        <div className="mute-add-row">
          <input
            id={`${uid}-w`}
            className="input"
            value={word}
            onChange={(e) => {
              setWord(e.target.value);
              setError(null);
            }}
            placeholder="e.g. spoilers"
            disabled={full}
            aria-invalid={!!error || undefined}
            aria-describedby={`${uid}-hint`}
            autoComplete="off"
          />
          <button className="btn btn-primary" type="submit" disabled={!word.trim() || full}>
            <Icon name="plus" size={16} />
            Mute
          </button>
        </div>
        <p id={`${uid}-hint`} className={error ? 'field-error' : 'hint'} role={error ? 'alert' : undefined}>
          {error ?? `Matching ignores capitals. Up to ${LIMITS.mutedWord.max} characters each.`}
        </p>
      </form>
      <div className="mute-list-head">
        <span className="kicker">Muted</span>
        <span className="meta">
          {words.length} / {LIMITS.mutedWord.count}
        </span>
      </div>
      {words.length === 0 ? (
        <p className="set-empty">Nothing muted. Mute a topic before a big game, a finale or a news cycle you’d rather skip.</p>
      ) : (
        <ul className="chips" role="list">
          {words.map((w) => (
            <li key={w} className="chip">
              <span>{w}</span>
              <button
                type="button"
                className="chip-x"
                aria-label={`Unmute “${w}”`}
                onClick={() => void patch({ mutedWords: words.filter((x) => x !== w) })}
              >
                <Icon name="close" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------- notifications

const NOTIFY: { key: keyof AccountSettings['notify']; label: string; hint: string }[] = [
  { key: 'replies', label: 'Replies', hint: 'When someone replies to one of your posts.' },
  { key: 'mentions', label: 'Mentions', hint: 'When someone mentions your @handle.' },
  { key: 'follows', label: 'New followers', hint: 'When someone follows you or asks to.' },
  { key: 'likes', label: 'Likes', hint: 'When someone likes one of your posts.' },
  { key: 'reposts', label: 'Reposts', hint: 'When someone reposts one of your posts.' },
];

function NotificationsSection({ me }: { me: Me }) {
  const saved = useSaved();
  const patch = useSettingsPatch(saved.flash);
  return (
    <>
      <SectionHead
        title="Notifications"
        saved={saved.on}
        desc="Choose what shows up in your Notifications tab. Relay never sends nudges about things you “might have missed”."
      />
      <div className="set-toggles">
        {NOTIFY.map((n) => (
          <Toggle
            key={n.key}
            label={n.label}
            hint={n.hint}
            checked={me.settings.notify[n.key]}
            onChange={(v) => void patch({ notify: { [n.key]: v } as AccountSettings['notify'] })}
          />
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------- appearance

function AppearanceSection() {
  const { me } = useSession();
  const prefs = usePrefs();
  const saved = useSaved();
  const patch = useSettingsPatch(saved.flash);
  const set = (p: Partial<Prefs>) => {
    setPrefs(p);
    saved.flash();
  };

  return (
    <>
      <SectionHead title="Appearance" desc="Theme, text size and reading font are saved on this device only." saved={saved.on} />
      <div className="set-appear">
        <div className="set-appear-row">
          <span className="set-switch-label" id="ap-theme">
            Theme
          </span>
          <Segmented
            label="Theme"
            value={prefs.theme}
            onChange={(theme) => set({ theme })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
        <div className="set-appear-row">
          <span className="set-switch-label">Text size</span>
          <Segmented
            label="Text size"
            value={prefs.text}
            onChange={(text) => set({ text })}
            options={[
              { value: 's', label: 'S' },
              { value: 'm', label: 'M' },
              { value: 'l', label: 'L' },
              { value: 'xl', label: 'XL' },
            ]}
          />
        </div>
        <div className="set-appear-row">
          <span className="set-switch-label">Reading font</span>
          <Segmented
            label="Reading font"
            value={prefs.readFont}
            onChange={(readFont) => set({ readFont })}
            options={[
              { value: 'serif', label: 'Serif' },
              { value: 'sans', label: 'Sans' },
            ]}
          />
        </div>
      </div>
      <figure className="set-specimen" aria-label="Preview">
        <figcaption className="kicker">Preview</figcaption>
        <div className="read">
          <p>
            The best conversations online used to feel like letters: considered, a little slow, written for someone in particular. Relay
            keeps posts in a reading column, sets them like a page, and leaves the pace to you.
          </p>
        </div>
        <p className="meta">@relay · 2m · reply · repost · like</p>
      </figure>
      {me && (
        <Group title="Counts">
          <Toggle
            label="Hide counts"
            hint="Hide like, repost and reply numbers everywhere — yours and everyone else’s. Saved to your account, so it follows you across devices."
            checked={me.settings.hideCounts}
            onChange={(v) => void patch({ hideCounts: v })}
          />
        </Group>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------- AI

function AiSection({ me }: { me: Me }) {
  const saved = useSaved();
  const patch = useSettingsPatch(saved.flash);
  const status = useAiStatus();
  const on = me.settings.aiEnabled;

  return (
    <>
      <SectionHead title="AI assist" desc="An optional writing assistant. It’s off unless you turn it on." saved={saved.on} />
      <div className="ai-status-line" aria-live="polite">
        {status === undefined ? (
          <span className="meta">Checking this server…</span>
        ) : status?.available ? (
          <>
            <span className="tag tag-moss">available</span>
            <span className="meta">Provider configured{status.model ? ` · ${status.model}` : ''}</span>
          </>
        ) : status === null ? (
          <span className="meta">Couldn’t check whether this server has an assistant configured.</span>
        ) : (
          <>
            <span className="tag">not configured</span>
            <span className="meta">Not configured on this server — the assistant won’t appear even if you turn it on.</span>
          </>
        )}
      </div>
      <div className="set-toggles">
        <Toggle
          label="Turn on AI assist"
          checked={on}
          onChange={(v) => void patch({ aiEnabled: v })}
          hint={on ? 'AI buttons appear in the composer and on threads.' : 'No AI buttons are shown and nothing is sent anywhere.'}
        />
      </div>
      <dl className="ai-explain">
        <div>
          <dt>What it does</dt>
          <dd>Suggests an improved, shorter or clearer version of a draft, or summarises a long thread you’re reading.</dd>
        </div>
        <div>
          <dt>When it runs</dt>
          <dd>
            Only when you press one of its buttons (<span className="meta">✦ improve · shorten · clarify</span>). At that moment your draft —
            or the posts in that thread you’re allowed to see — is sent to the AI provider this server is configured with. Nothing is sent
            in the background.
          </dd>
        </div>
        <div>
          <dt>What it never does</dt>
          <dd>Post, reply or edit anything by itself. Every suggestion appears in a labelled panel for you to use or discard.</dd>
        </div>
        <div>
          <dt>Limits</dt>
          <dd>Up to 20 requests an hour. Summaries can miss nuance — read the thread before relying on one.</dd>
        </div>
      </dl>
    </>
  );
}
