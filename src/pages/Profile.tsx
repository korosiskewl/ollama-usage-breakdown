import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import type { FeedItem, FollowState, Me, Page, Profile as ProfileT, UserSummary } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { Avatar } from '../components/Avatar';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { FollowButton, UserFollowButton } from '../components/FollowButton';
import { Icon } from '../components/Icon';
import { InfiniteList } from '../components/InfiniteList';
import { Menu, type MenuItem } from '../components/Menu';
import { NotFoundState } from '../components/NotFoundState';
import { PageHead } from '../components/PageHead';
import { PostItem } from '../components/PostItem';
import { ProfileCollections } from '../components/ProfileCollections';
import { ReportDialog } from '../components/ReportDialog';
import { RichText } from '../components/RichText';
import { EmptyState, ErrorState, PostSkeleton } from '../components/States';
import { UserRow } from '../components/UserRow';
import { removeFrom, useFeedEvents } from '../components/feedEvents';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { openComposer } from '../lib/composer';
import { compactCount } from '../lib/format';
import { Link, href, navigate, profilePath } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { usePaged } from '../lib/usePaged';

const TABS = ['posts', 'replies', 'collections', 'followers', 'following'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { posts: 'Posts', replies: 'Replies', collections: 'Collections', followers: 'Followers', following: 'Following' };

// Last-seen profiles, so switching tabs (which remounts the page) doesn't flash the header.
const cache = new Map<string, ProfileT>();
const joinedFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

export default function Profile({ params }: { params: Record<string, string> }) {
  const handle = params.handle ?? '';
  const tab = (params.tab ?? 'posts') as Tab;
  const { me } = useSession();
  const key = handle.toLowerCase();
  const [profile, setProfileState] = useState<ProfileT | null>(() => cache.get(key) ?? null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<null | 'edit' | 'block' | 'report'>(null);
  const [busy, setBusy] = useState(false);

  const setProfile = (p: ProfileT) => {
    cache.set(key, p);
    setProfileState(p);
  };

  const meId = me?.id ?? null;
  useEffect(() => {
    let live = true;
    setError(null);
    api.get<ProfileT>(`/users/${encodeURIComponent(handle)}`).then(
      (p) => {
        if (!live) return;
        cache.set(key, p);
        setProfileState(p);
      },
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [handle, key, attempt, meId]);

  const reloadProfile = () => setAttempt((a) => a + 1);

  if (!TABS.includes(tab)) return <NotFoundState heading="h1" />;

  if (error && !profile) {
    const status = error instanceof ApiRequestError ? error.status : 0;
    return (
      <>
        <PageHead title={`@${handle}`} back="/" />
        {status === 404 ? (
          <NotFoundState title="This account doesn’t exist.">
            <p>
              There’s no one on Relay called <strong>@{handle}</strong> — or they’ve deleted their account. Check the spelling, or look
              for them in Search.
            </p>
          </NotFoundState>
        ) : (
          <ErrorState message={errorMessage(error)} onRetry={reloadProfile} />
        )}
      </>
    );
  }

  if (!profile)
    return (
      <>
        <PageHead title={`@${handle}`} back="/" />
        <ProfileSkeleton />
      </>
    );

  const isSelf = !!me && me.id === profile.id;
  const viewer = profile.viewer;
  const canonical = profile.handle;

  async function setRelation(kind: 'mute' | 'block', on: boolean) {
    if (!profile) return;
    setBusy(true);
    try {
      const path = `/users/${canonical}/${kind}`;
      if (on) await api.post(path);
      else await api.del(path);
      if (kind === 'mute') {
        setProfile({ ...profile, viewer: viewer && { ...viewer, muting: on } });
        toast(on ? `Muted @${canonical}. Their posts won’t appear in your feeds or notifications.` : `Unmuted @${canonical}.`);
      } else {
        toast(on ? `Blocked @${canonical}.` : `Unblocked @${canonical}.`);
        reloadProfile();
      }
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(false);
      setDialog(null);
    }
  }

  const onFollowChange = (s: FollowState) => {
    if (!profile.viewer) return;
    const prev = profile.viewer.following;
    const delta = (s === 'active' ? 1 : 0) - (prev === 'active' ? 1 : 0);
    setProfile({
      ...profile,
      viewer: { ...profile.viewer, following: s },
      counts: { ...profile.counts, followers: Math.max(0, profile.counts.followers + delta) },
    });
    // Access to a private account's posts changes with the follow; refetch to get canViewPosts right.
    if (profile.isPrivate && (s === 'active' || prev === 'active')) window.setTimeout(reloadProfile, 400);
  };

  const menu: MenuItem[] = [
    {
      label: 'Copy link to profile',
      icon: 'link',
      onSelect: () => {
        const url = location.origin + location.pathname + href(profilePath(canonical));
        navigator.clipboard?.writeText(url).then(() => toast('Link copied.'), () => toast(url));
      },
    },
  ];
  if (me && !isSelf && viewer) {
    menu.push(
      viewer.muting
        ? { label: `Unmute @${canonical}`, icon: 'mute', onSelect: () => void setRelation('mute', false) }
        : { label: `Mute @${canonical}`, icon: 'mute', onSelect: () => void setRelation('mute', true) },
      viewer.blocking
        ? { label: `Unblock @${canonical}`, icon: 'block', onSelect: () => void setRelation('block', false) }
        : { label: `Block @${canonical}`, icon: 'block', danger: true, onSelect: () => setDialog('block') },
      { label: `Report @${canonical}`, icon: 'flag', danger: true, onSelect: () => setDialog('report') },
    );
  }
  if (isSelf) menu.push({ label: 'Settings', icon: 'settings', onSelect: () => navigate('/settings') });

  const locked = !isSelf && !profile.canViewPosts;

  return (
    <>
      <PageHead title={profile.displayName} sub={`@${canonical}`} back="/" />
      <header className="profile-head">
        <div className="profile-top">
          <Avatar user={profile} size={80} />
          <div className="profile-actions">
            {isSelf ? (
              <button className="btn" onClick={() => setDialog('edit')}>
                <Icon name="edit" size={16} />
                Edit profile
              </button>
            ) : (
              !profile.suspended &&
              !viewer?.blocking && (
                <>
                  {me && (
                    <button
                      className="btn btn-icon-text"
                      onClick={() => navigate(`/messages?to=${encodeURIComponent(canonical)}`)}
                      aria-label={`Message @${canonical}`}
                    >
                      <Icon name="mail" size={16} />
                      <span className="hide-xs">Message</span>
                    </button>
                  )}
                  <FollowButton handle={canonical} initial={viewer?.following ?? 'none'} isPrivate={profile.isPrivate} onChange={onFollowChange} />
                </>
              )
            )}
            <Menu items={menu} label="More profile options" />
          </div>
        </div>

        <div className="profile-id">
          <h2 className="profile-name">
            {profile.displayName}
            {profile.isPrivate && (
              <span className="profile-lock" title="Private account">
                <Icon name="lock" size={16} />
                <span className="sr-only">Private account</span>
              </span>
            )}
          </h2>
          <p className="profile-handle">
            <span className="meta">@{canonical}</span>
            {profile.role !== 'user' && <span className="tag tag-moss">{profile.role === 'admin' ? 'admin' : 'moderator'}</span>}
            {viewer?.followsYou && <span className="tag">follows you</span>}
            {viewer?.muting && <span className="tag tag-amber">muted</span>}
          </p>
        </div>

        {profile.suspended ? (
          <div className="notice notice-amber profile-notice" role="note">
            <strong>This account is suspended</strong> for breaking the <Link to="/rules">community rules</Link>. Its posts are hidden.
          </div>
        ) : (
          <>
            {profile.bio && (
              <div className="profile-bio">
                <RichText text={profile.bio} />
              </div>
            )}
            <p className="profile-meta meta">
              Joined {joinedFmt.format(new Date(profile.createdAt))}
              {viewer?.following === 'pending' && <> · follow request pending</>}
            </p>
            <p className="profile-counts">
              <Link to={`${profilePath(canonical)}/following`}>
                <strong>{compactCount(profile.counts.following)}</strong> following
              </Link>
              <Link to={`${profilePath(canonical)}/followers`}>
                <strong>{compactCount(profile.counts.followers)}</strong> {profile.counts.followers === 1 ? 'follower' : 'followers'}
              </Link>
              <span className="profile-count-posts">
                <strong>{compactCount(profile.counts.posts)}</strong> {profile.counts.posts === 1 ? 'post' : 'posts'}
              </span>
            </p>
          </>
        )}
      </header>

      {profile.suspended ? null : viewer?.blocking ? (
        <div className="profile-state">
          <Icon name="block" size={28} />
          <h2>You’ve blocked @{canonical}</h2>
          <p>You won’t see each other’s posts, and neither of you can follow, reply to or message the other.</p>
          <button className="btn" onClick={() => void setRelation('block', false)} disabled={busy}>
            {busy && <span className="spinner" />}
            Unblock
          </button>
        </div>
      ) : (
        <>
          <nav className="tabs profile-tabs" aria-label="Profile sections">
            {TABS.map((t) => (
              <Link key={t} to={t === 'posts' ? profilePath(canonical) : `${profilePath(canonical)}/${t}`} aria-current={tab === t ? 'page' : undefined}>
                {TAB_LABEL[t]}
              </Link>
            ))}
          </nav>
          {locked && tab !== 'collections' ? (
            <div className="profile-state">
              <Icon name="lock" size={28} />
              <h2>@{canonical}’s posts are private</h2>
              <p>
                They approve who can follow them. Once they accept your request, their posts, followers and following will appear here.
                Their name, photo and bio are always visible.
              </p>
              {viewer?.following === 'pending' ? (
                <p className="meta">Request sent — waiting for approval.</p>
              ) : (
                <FollowButton handle={canonical} initial={viewer?.following ?? 'none'} isPrivate onChange={onFollowChange} />
              )}
            </div>
          ) : tab === 'posts' || tab === 'replies' ? (
            <ProfilePosts key={tab} handle={canonical} tab={tab} isSelf={isSelf} />
          ) : tab === 'collections' ? (
            <ProfileCollections handle={canonical} isOwner={isSelf} />
          ) : (
            <ProfilePeople key={tab} handle={canonical} dir={tab} isSelf={isSelf} />
          )}
        </>
      )}

      {dialog === 'edit' && me && isSelf && (
        <EditProfileDialog
          me={me}
          onClose={() => setDialog(null)}
          onSaved={(u) => {
            setProfile({ ...profile, displayName: u.displayName, bio: u.bio, isPrivate: u.isPrivate, avatarUrl: u.avatarUrl });
            setDialog(null);
          }}
        />
      )}
      {dialog === 'block' && (
        <ConfirmDialog
          title={`Block @${canonical}?`}
          body="They won’t be able to see your posts, follow you, reply to you or message you, and you won’t see theirs. Follows between you are removed. They aren’t notified."
          confirmLabel="Block"
          danger
          busy={busy}
          onConfirm={() => void setRelation('block', true)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'report' && <ReportDialog target={{ type: 'user', id: profile.id, label: `@${canonical}` }} onClose={() => setDialog(null)} />}
    </>
  );
}

function ProfileSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="profile-head">
        <div className="skeleton" style={{ width: 80, height: 80, borderRadius: '50%' }} />
        <div className="skeleton" style={{ width: '45%', height: 22, marginTop: 16 }} />
        <div className="skeleton" style={{ width: '25%', height: 12, marginTop: 10 }} />
        <div className="skeleton" style={{ width: '80%', height: 14, marginTop: 18 }} />
      </div>
      <PostSkeleton count={2} />
    </div>
  );
}

function ProfilePosts({ handle, tab, isSelf }: { handle: string; tab: 'posts' | 'replies'; isSelf: boolean }) {
  const list = usePaged<FeedItem>(`${handle}:${tab}`, (cursor) => api.get<Page<FeedItem>>(`/users/${handle}/posts`, { cursor, tab }));
  const { setItems } = list;
  useFeedEvents(setItems, (p) => isSelf && (tab === 'replies' ? !!p.replyToId : !p.replyToId));
  return (
    <section aria-label={tab === 'posts' ? 'Posts' : 'Replies'}>
      <InfiniteList
        hasMore={list.hasMore}
        loading={list.loading}
        loaded={list.loaded}
        error={list.error}
        onMore={list.loadMore}
        skeleton={<PostSkeleton count={4} />}
        empty={
          isSelf ? (
            <EmptyState
              title={tab === 'posts' ? 'You haven’t posted yet.' : 'No replies yet.'}
              action={
                tab === 'posts' ? (
                  <button className="btn btn-signal" onClick={() => openComposer()}>
                    Write your first post
                  </button>
                ) : (
                  <Link to="/explore/conversations" className="btn">
                    Find a conversation
                  </Link>
                )
              }
            >
              {tab === 'posts' ? 'Your posts and reposts will live here, newest first.' : 'When you reply to someone, it shows up here.'}
            </EmptyState>
          ) : (
            <EmptyState title={tab === 'posts' ? `@${handle} hasn’t posted yet.` : `@${handle} hasn’t replied to anyone yet.`} />
          )
        }
      >
        {list.items.map((it) => (
          <PostItem key={it.key} post={it.post} repostedBy={it.repostedBy} onRemoved={removeFrom(setItems)} />
        ))}
      </InfiniteList>
    </section>
  );
}

function ProfilePeople({ handle, dir, isSelf }: { handle: string; dir: 'followers' | 'following'; isSelf: boolean }) {
  const list = usePaged<UserSummary>(`${handle}:${dir}`, (cursor) => api.get<Page<UserSummary>>(`/users/${handle}/${dir}`, { cursor }));
  const [removing, setRemoving] = useState<UserSummary | null>(null);
  const [busy, setBusy] = useState(false);

  async function removeFollower(u: UserSummary) {
    setBusy(true);
    try {
      await api.del(`/me/followers/${u.id}`);
      list.setItems((prev) => prev.filter((x) => x.id !== u.id));
      toast(`Removed @${u.handle} from your followers.`);
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  }

  const forbidden = list.error && /private/i.test(list.error);
  return (
    <section aria-label={dir === 'followers' ? 'Followers' : 'Following'}>
      {forbidden ? (
        <EmptyState title="These connections are private.">Only approved followers can see who this account follows and who follows it.</EmptyState>
      ) : (
        <InfiniteList
          hasMore={list.hasMore}
          loading={list.loading}
          loaded={list.loaded}
          error={list.error}
          onMore={list.loadMore}
          empty={
            <EmptyState title={dir === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}>
              {isSelf
                ? dir === 'followers'
                  ? 'When people follow you, they’ll be listed here.'
                  : 'Find people worth reading on Explore, then follow them to fill your home feed.'
                : null}
            </EmptyState>
          }
        >
          {list.items.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              action={
                <>
                  <UserFollowButton user={u} known={isSelf && dir === 'following' ? 'active' : undefined} />
                  {isSelf && dir === 'followers' && (
                    <Menu label={`Options for @${u.handle}`} items={[{ label: 'Remove follower', icon: 'close', danger: true, onSelect: () => setRemoving(u) }]} />
                  )}
                </>
              }
            />
          ))}
        </InfiniteList>
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove @${removing.handle}?`}
          body="They’ll stop following you and won’t be told. If your account is private, they’ll need to request again to see your posts."
          confirmLabel="Remove"
          danger
          busy={busy}
          onConfirm={() => void removeFollower(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------- edit profile

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function EditProfileDialog({ me, onClose, onSaved }: { me: Me; onClose: () => void; onSaved: (u: Me) => void }) {
  const { setMe, refresh } = useSession();
  const [name, setName] = useState(me.displayName);
  const [bio, setBio] = useState(me.bio);
  const [isPrivate, setIsPrivate] = useState(me.isPrivate);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const uid = useId();

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const nameLen = charCount(name.trim());
  const bioLen = charCount(bio);
  const nameErr = errors.displayName ?? (nameLen === 0 ? 'Display name is required.' : nameLen > LIMITS.displayName.max ? `At most ${LIMITS.displayName.max} characters.` : null);
  const bioErr = errors.bio ?? (bioLen > LIMITS.bio.max ? `At most ${LIMITS.bio.max} characters.` : null);
  const invalid = nameLen === 0 || nameLen > LIMITS.displayName.max || bioLen > LIMITS.bio.max;

  function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const { avatar: _a, ...rest } = errors;
    if (!IMAGE_TYPES.includes(f.type)) {
      setErrors({ ...rest, avatar: 'Choose a PNG, JPEG, WebP or GIF image.' });
      return;
    }
    if (f.size > LIMITS.avatarBytes) {
      setErrors({ ...rest, avatar: `That image is ${(f.size / 1_000_000).toFixed(1)} MB. Choose one that’s 1 MB or smaller.` });
      return;
    }
    setErrors(rest);
    setFile(f);
    setRemoveAvatar(false);
  }

  async function save() {
    if (invalid) return;
    setBusy(true);
    setErrors({});
    let avatarChanged = false;
    try {
      if (file) {
        await api.upload<{ avatarUrl: string }>('/me/avatar', file);
        avatarChanged = true;
      } else if (removeAvatar && me.avatarUrl) {
        await api.del('/me/avatar');
        avatarChanged = true;
      }
      const patch: Record<string, unknown> = {};
      if (name.trim() !== me.displayName) patch.displayName = name;
      if (bio !== me.bio) patch.bio = bio;
      if (isPrivate !== me.isPrivate) patch.isPrivate = isPrivate;
      const { user } = await api.patch<{ user: Me }>('/me/profile', patch);
      setMe(user);
      onSaved(user);
      toast('Profile saved.', { kind: 'success' });
    } catch (e) {
      if (e instanceof ApiRequestError) {
        const f = { ...e.fields };
        if (e.status === 413 || e.status === 415) f.avatar = e.message;
        if (!Object.keys(f).length) f._ = e.message;
        setErrors(f);
      } else setErrors({ _: errorMessage(e) });
      if (avatarChanged) void refresh();
    } finally {
      setBusy(false);
    }
  }

  const showAvatar = preview ? 'file' : removeAvatar || !me.avatarUrl ? 'none' : 'current';
  const ids = { name: uid + 'n', bio: uid + 'b', nameHint: uid + 'nh', bioHint: uid + 'bh', av: uid + 'a' };

  return (
    <Dialog
      title="Edit profile"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy || invalid}>
            {busy && <span className="spinner" />}
            Save
          </button>
        </>
      }
    >
      <form
        className="edit-profile"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        noValidate
      >
        {errors._ && (
          <p className="notice notice-danger" role="alert">
            {errors._}
          </p>
        )}
        <div className="edit-avatar">
          {showAvatar === 'file' && preview ? (
            <span className="avatar" style={{ width: 72, height: 72 }}>
              <img src={preview} alt="" width={72} height={72} />
            </span>
          ) : (
            <Avatar user={{ ...me, avatarUrl: showAvatar === 'current' ? me.avatarUrl : null }} size={72} />
          )}
          <div className="edit-avatar-actions">
            <div className="edit-avatar-buttons">
              <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()} aria-describedby={ids.av}>
                {showAvatar === 'none' ? 'Upload photo' : 'Change photo'}
              </button>
              {showAvatar !== 'none' && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setFile(null);
                    setRemoveAvatar(true);
                  }}
                >
                  Remove
                </button>
              )}
              {(file || removeAvatar) && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setFile(null);
                    setRemoveAvatar(false);
                  }}
                >
                  Undo
                </button>
              )}
            </div>
            <p className={errors.avatar ? 'field-error' : 'hint'} id={ids.av} role={errors.avatar ? 'alert' : undefined}>
              {errors.avatar ?? 'PNG, JPEG, WebP or GIF, up to 1 MB. Saved when you press Save.'}
            </p>
            <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} onChange={pickFile} hidden tabIndex={-1} aria-hidden="true" />
          </div>
        </div>

        <div className="field">
          <label htmlFor={ids.name}>Display name</label>
          <input
            id={ids.name}
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.displayName) setErrors(({ displayName: _d, ...r }) => r);
            }}
            autoComplete="name"
            aria-invalid={!!nameErr || undefined}
            aria-describedby={ids.nameHint}
          />
          <div className="field-foot" id={ids.nameHint}>
            <span className={nameErr ? 'field-error' : 'hint'}>{nameErr ?? 'Shown above your @handle.'}</span>
            <span className={'meta field-count' + (nameLen > LIMITS.displayName.max ? ' is-over' : '')}>
              {nameLen}/{LIMITS.displayName.max}
            </span>
          </div>
        </div>

        <div className="field">
          <label htmlFor={ids.bio}>Bio</label>
          <textarea
            id={ids.bio}
            className="textarea"
            rows={4}
            value={bio}
            onChange={(e) => {
              setBio(e.target.value);
              if (errors.bio) setErrors(({ bio: _b, ...r }) => r);
            }}
            aria-invalid={!!bioErr || undefined}
            aria-describedby={ids.bioHint}
          />
          <div className="field-foot" id={ids.bioHint}>
            <span className={bioErr ? 'field-error' : 'hint'}>{bioErr ?? 'A line or two about you. Links and @mentions work.'}</span>
            <span
              className={'meta field-count' + (bioLen > LIMITS.bio.max ? ' is-over' : LIMITS.bio.max - bioLen <= 30 ? ' is-near' : '')}
            >
              {bioLen}/{LIMITS.bio.max}
            </span>
          </div>
        </div>

        <label className="switch edit-private">
          <span>
            <span className="label">Private account</span>
            <span className="hint edit-private-hint">
              Only people you approve can follow you and see your posts, followers and following. Your name, photo and bio stay visible.
              {me.isPrivate && !isPrivate && ' Switching to public approves everyone who is waiting.'}
            </span>
          </span>
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
        </label>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
