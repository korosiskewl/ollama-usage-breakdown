import { useState, type MouseEvent } from 'react';
import type { Post, UserSummary } from '../../shared/types';
import { api, errorMessage } from '../lib/api';
import { emitPostEvent, openComposer } from '../lib/composer';
import { compactCount } from '../lib/format';
import { Link, href, navigate, postPath, profilePath } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { Avatar } from './Avatar';
import { ConfirmDialog } from './Dialog';
import { Icon } from './Icon';
import { Menu, type MenuItem } from './Menu';
import { ReportDialog } from './ReportDialog';
import { RichText } from './RichText';
import { SaveToCollectionDialog } from './SaveToCollection';
import { Time } from './Time';

export type PostVariant = 'feed' | 'focus' | 'ancestor' | 'reply';

export function PostItem({
  post: initial,
  repostedBy,
  variant = 'feed',
  onChange,
  onRemoved,
  showReplyContext = true,
}: {
  post: Post;
  repostedBy?: UserSummary | null;
  variant?: PostVariant;
  onChange?: (post: Post) => void;
  onRemoved?: (post: Post) => void;
  showReplyContext?: boolean;
}) {
  const { me } = useSession();
  const [post, setPostState] = useState(initial);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setPostState(initial);
  }
  const [dialog, setDialog] = useState<null | 'delete' | 'save' | 'report' | 'block'>(null);
  const [busy, setBusy] = useState(false);

  const setPost = (p: Post) => {
    setPostState(p);
    onChange?.(p);
  };

  const hideCounts = me?.settings.hideCounts ?? false;
  const isMod = me?.role === 'moderator' || me?.role === 'admin';
  const isAuthor = !!post.viewer?.isAuthor;
  const gone = post.deleted || post.unavailable;

  const requireSignIn = () => {
    if (!me) {
      navigate('/login');
      return true;
    }
    return false;
  };

  async function toggle(kind: 'like' | 'repost') {
    if (requireSignIn() || !post.viewer) return;
    const on = kind === 'like' ? post.viewer.liked : post.viewer.reposted;
    const key = kind === 'like' ? 'likes' : 'reposts';
    const prev = post;
    const optimistic: Post = {
      ...post,
      viewer: { ...post.viewer, [kind === 'like' ? 'liked' : 'reposted']: !on },
      counts: { ...post.counts, [key]: Math.max(0, post.counts[key] + (on ? -1 : 1)) },
    };
    setPost(optimistic);
    try {
      const path = `/posts/${post.id}/${kind}`;
      if (on) await api.del(path);
      else await api.post(path);
    } catch (e) {
      setPost(prev);
      toast(errorMessage(e), { kind: 'error' });
    }
  }

  async function doDelete() {
    setBusy(true);
    try {
      await api.del(`/posts/${post.id}`);
      const deleted: Post = { ...post, deleted: true, body: '', removed: !isAuthor };
      setPost(deleted);
      emitPostEvent({ type: 'deleted', post: deleted });
      onRemoved?.(deleted);
      toast(isAuthor ? 'Post deleted.' : 'Post removed.');
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(false);
      setDialog(null);
    }
  }

  async function relation(kind: 'mute' | 'block') {
    try {
      await api.post(`/users/${post.author.handle}/${kind}`);
      toast(kind === 'mute' ? `Muted @${post.author.handle}. You won’t see their posts in feeds.` : `Blocked @${post.author.handle}.`, {
        action: { label: 'Undo', run: () => void api.del(`/users/${post.author.handle}/${kind}`).then(() => toast('Undone.')) },
      });
      onRemoved?.(post);
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setDialog(null);
    }
  }

  const menu: MenuItem[] = [];
  if (!gone) {
    menu.push({
      label: 'Copy link',
      icon: 'link',
      onSelect: () => {
        const url = location.origin + location.pathname + href(postPath(post.id));
        navigator.clipboard?.writeText(url).then(() => toast('Link copied.'), () => toast(url));
      },
    });
    menu.push({ label: 'Open reading view', icon: 'book', onSelect: () => navigate(`/post/${post.id}/read`) });
    if (me) menu.push({ label: 'Save to collection', icon: 'bookmark', onSelect: () => setDialog('save') });
    if (isAuthor) {
      menu.push({
        label: 'Edit',
        icon: 'edit',
        onSelect: () => openComposer({ edit: post, onDone: (p) => setPost(p) }),
      });
    }
    if (isAuthor || isMod) menu.push({ label: isAuthor ? 'Delete' : 'Remove (moderator)', icon: 'trash', danger: true, onSelect: () => setDialog('delete') });
    if (me && !isAuthor) {
      menu.push({ label: `Mute @${post.author.handle}`, icon: 'mute', onSelect: () => void relation('mute') });
      menu.push({ label: `Block @${post.author.handle}`, icon: 'block', danger: true, onSelect: () => setDialog('block') });
      menu.push({ label: 'Report post', icon: 'flag', danger: true, onSelect: () => setDialog('report') });
    }
  }

  const openThread = (e: MouseEvent) => {
    if (variant === 'focus' || gone) return;
    const t = e.target as HTMLElement;
    if (t.closest('a,button,[role="menu"],dialog')) return;
    if (window.getSelection()?.toString()) return;
    navigate(postPath(post.id));
  };

  const className = ['post', `post-${variant}`, gone ? 'post-gone' : ''].filter(Boolean).join(' ');

  return (
    <article className={className} onClick={openThread} aria-labelledby={`p-${post.id}-a`}>
      {repostedBy && (
        <div className="post-context">
          <Icon name="repost" size={14} />
          <Link to={profilePath(repostedBy.handle)}>{repostedBy.displayName}</Link> reposted
        </div>
      )}
      <div className="post-gutter">
        {gone ? (
          <span className="avatar avatar-gone" style={{ width: 40, height: 40 }} aria-hidden="true" />
        ) : (
          <Link to={profilePath(post.author.handle)} tabIndex={-1} aria-hidden="true">
            <Avatar user={post.author} size={variant === 'focus' ? 48 : 40} />
          </Link>
        )}
        {variant === 'ancestor' && <span className="post-thread-line" aria-hidden="true" />}
      </div>
      <div className="post-main">
        {gone ? (
          <p className="post-gone-text" id={`p-${post.id}-a`}>
            {post.unavailable
              ? 'This post is unavailable.'
              : post.removed
                ? 'This post was removed for breaking the community rules.'
                : 'This post was deleted by its author.'}
          </p>
        ) : (
          <>
            <header className="post-head">
              <Link to={profilePath(post.author.handle)} className="post-author" id={`p-${post.id}-a`}>
                <span className="post-name">{post.author.displayName}</span>
                {post.author.isPrivate && <Icon name="lock" size={13} title="Private account" />}
                {post.author.role !== 'user' && <span className="tag tag-moss">{post.author.role === 'admin' ? 'admin' : 'mod'}</span>}
                <span className="post-handle meta">@{post.author.handle}</span>
              </Link>
              <span className="meta" aria-hidden="true">
                ·
              </span>
              <Link to={postPath(post.id)} className="post-time">
                <Time iso={post.createdAt} />
              </Link>
              {post.editedAt && (
                <span className="meta" title={`Edited ${new Date(post.editedAt).toLocaleString()}`}>
                  · edited
                </span>
              )}
              {menu.length > 0 && (
                <span className="post-menu">
                  <Menu items={menu} label="Post options" />
                </span>
              )}
            </header>
            {showReplyContext && post.replyTo && variant !== 'ancestor' && (
              <div className="post-replyto meta">
                ↳ replying to{' '}
                {post.replyTo.author && !post.replyTo.deleted ? (
                  <Link to={postPath(post.replyTo.id)}>@{post.replyTo.author.handle}</Link>
                ) : (
                  <Link to={postPath(post.replyTo.id)}>a deleted post</Link>
                )}
              </div>
            )}
            <div className={variant === 'focus' ? 'post-body read read-focus' : 'post-body read'}>
              <RichText text={post.body} mentions={post.mentions} />
            </div>
            {variant === 'focus' && (
              <p className="meta post-fulltime">
                {new Date(post.createdAt).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })}
              </p>
            )}
            <footer className="post-actions">
              <button
                className="act"
                onClick={() => !requireSignIn() && openComposer({ replyTo: post })}
                aria-label={`Reply${hideCounts ? '' : `, ${post.counts.replies} replies`}`}
              >
                <Icon name="reply" />
                <span>reply</span>
                {!hideCounts && post.counts.replies > 0 && <span className="act-n">{compactCount(post.counts.replies)}</span>}
              </button>
              <button
                className="act"
                aria-pressed={!!post.viewer?.reposted}
                onClick={() => void toggle('repost')}
                disabled={post.author.isPrivate && !isAuthor}
                title={post.author.isPrivate ? 'Posts from private accounts can’t be reposted' : undefined}
                aria-label={`Repost${hideCounts ? '' : `, ${post.counts.reposts} reposts`}`}
              >
                <Icon name="repost" />
                <span>{post.viewer?.reposted ? 'reposted' : 'repost'}</span>
                {!hideCounts && post.counts.reposts > 0 && <span className="act-n">{compactCount(post.counts.reposts)}</span>}
              </button>
              <button
                className="act act-like"
                aria-pressed={!!post.viewer?.liked}
                onClick={() => void toggle('like')}
                aria-label={`Like${hideCounts ? '' : `, ${post.counts.likes} likes`}`}
              >
                <Icon name="heart" filled={!!post.viewer?.liked} />
                <span>{post.viewer?.liked ? 'liked' : 'like'}</span>
                {!hideCounts && post.counts.likes > 0 && <span className="act-n">{compactCount(post.counts.likes)}</span>}
              </button>
              {me && (
                <button className="act act-save" onClick={() => setDialog('save')} aria-label="Save to a collection">
                  <Icon name="bookmark" />
                  <span>save</span>
                </button>
              )}
            </footer>
          </>
        )}
      </div>

      {dialog === 'delete' && (
        <ConfirmDialog
          title={isAuthor ? 'Delete this post?' : 'Remove this post?'}
          body={
            isAuthor
              ? 'It will be replaced with a “deleted” note so replies keep their context. This can’t be undone.'
              : 'The post will be removed for breaking the community rules and the action will be logged.'
          }
          confirmLabel={isAuthor ? 'Delete' : 'Remove'}
          danger
          busy={busy}
          onConfirm={() => void doDelete()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'block' && (
        <ConfirmDialog
          title={`Block @${post.author.handle}?`}
          body="They won’t be able to see your posts, follow you, reply or message you, and you won’t see theirs. Follows between you are removed."
          confirmLabel="Block"
          danger
          onConfirm={() => void relation('block')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'save' && <SaveToCollectionDialog post={post} onClose={() => setDialog(null)} />}
      {dialog === 'report' && (
        <ReportDialog target={{ type: 'post', id: post.id, label: `post by @${post.author.handle}` }} onClose={() => setDialog(null)} />
      )}
    </article>
  );
}
