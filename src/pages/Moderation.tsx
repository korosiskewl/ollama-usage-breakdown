import { useId, useState } from 'react';
import type { Page, Report, UserSummary } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { api, errorMessage } from '../lib/api';
import { Link, postPath, profilePath } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { usePaged } from '../lib/usePaged';
import { Avatar } from '../components/Avatar';
import { ConfirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { InfiniteList } from '../components/InfiniteList';
import { PageHead } from '../components/PageHead';
import { PostItem } from '../components/PostItem';
import { reasonLabel } from '../components/ReportDialog';
import { EmptyState, Loading } from '../components/States';
import { Time } from '../components/Time';
import { UserRow } from '../components/UserRow';

type Tab = 'reports' | 'actioned' | 'dismissed' | 'log';
type Action = 'dismiss' | 'remove_post' | 'suspend_user';

interface ModAction {
  id: string;
  moderator: UserSummary;
  action: string;
  note: string;
  targetUser: UserSummary | null;
  targetPostId: string | null;
  createdAt: string;
}

const TABS: { id: Tab; label: string; to: string }[] = [
  { id: 'reports', label: 'Open', to: '/mod' },
  { id: 'actioned', label: 'Actioned', to: '/mod/actioned' },
  { id: 'dismissed', label: 'Dismissed', to: '/mod/dismissed' },
  { id: 'log', label: 'Log', to: '/mod/log' },
];

const NOTE_MAX = LIMITS.reportDetails.max;

export default function Moderation({ params }: { params: Record<string, string> }) {
  const { me, loading } = useSession();
  const tab = (params.tab ?? 'reports') as Tab;
  const known = TABS.some((t) => t.id === tab);

  if (loading) return <Loading />;
  if (!me) {
    return (
      <>
        <PageHead title="Moderation" />
        <EmptyState
          title="Sign in to continue."
          action={
            <Link to="/login" className="btn btn-primary">
              Sign in
            </Link>
          }
        >
          The moderation queue is for Relay’s moderators.
        </EmptyState>
      </>
    );
  }
  if (me.role !== 'moderator' && me.role !== 'admin') {
    return (
      <>
        <PageHead title="Moderation" />
        <EmptyState
          title="This area is for moderators."
          action={
            <Link to="/rules" className="btn">
              Read the community rules
            </Link>
          }
        >
          If you’ve seen something that breaks the rules, use <span className="meta">Report</span> from the post or profile menu and a
          moderator will review it.
        </EmptyState>
      </>
    );
  }

  return (
    <div className="mod-page">
      <PageHead title="Moderation" sub={me.role === 'admin' ? 'admin' : 'moderator'}>
        <nav className="tabs" aria-label="Moderation views">
          {TABS.map((t) => (
            <Link key={t.id} to={t.to} aria-current={t.id === tab ? 'page' : undefined}>
              {t.label}
            </Link>
          ))}
        </nav>
      </PageHead>
      {!known ? (
        <EmptyState title="Unknown view." action={<Link to="/mod" className="btn">Open reports</Link>} />
      ) : tab === 'log' ? (
        <ActionLog />
      ) : (
        <ReportQueue status={tab === 'reports' ? 'open' : tab} />
      )}
    </div>
  );
}

function ReportQueue({ status }: { status: Report['status'] }) {
  const list = usePaged<Report>(`reports:${status}`, (cursor) => api.get<Page<Report>>('/mod/reports', { status, cursor }));
  const [pending, setPending] = useState<{ report: Report; action: Action } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const uid = useId();

  async function resolve() {
    if (!pending || busy) return;
    const { report, action } = pending;
    if (charCount(note) > NOTE_MAX) {
      toast(`Notes are at most ${NOTE_MAX} characters.`, { kind: 'error' });
      return;
    }
    setBusy(true);
    try {
      await api.post(`/mod/reports/${report.id}/resolve`, { action, note: note.trim() || undefined });
      // Resolving settles every open report on the same target.
      list.setItems((items) => items.filter((r) => !(r.targetType === report.targetType && r.targetId === report.targetId)));
      toast(action === 'dismiss' ? 'Report dismissed.' : action === 'remove_post' ? 'Post removed and logged.' : `Suspended @${report.targetUser?.handle}.`);
      setPending(null);
      setNote('');
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const open = status === 'open';

  return (
    <>
      {open && (
        <p className="mod-intro hint">
          Newest first. Resolving a report settles every open report on the same post or account, and every decision is logged with your
          name.
        </p>
      )}
      <InfiniteList
        hasMore={list.hasMore}
        loading={list.loading}
        loaded={list.loaded}
        error={list.error}
        onMore={list.loadMore}
        empty={
          <EmptyState title={open ? 'The queue is clear.' : `No ${status} reports.`}>
            {open ? 'New reports from members will appear here.' : 'Resolved reports are kept here for reference.'}
          </EmptyState>
        }
      >
        {list.items.map((r) => (
          <ReportCard key={r.id} report={r} onAction={open ? (action) => setPending({ report: r, action }) : undefined} />
        ))}
      </InfiniteList>
      {pending && (
        <ConfirmDialog
          title={
            pending.action === 'dismiss'
              ? 'Dismiss this report?'
              : pending.action === 'remove_post'
                ? 'Remove this post?'
                : `Suspend @${pending.report.targetUser?.handle ?? 'this account'}?`
          }
          confirmLabel={pending.action === 'dismiss' ? 'Dismiss' : pending.action === 'remove_post' ? 'Remove post' : 'Suspend account'}
          danger={pending.action !== 'dismiss'}
          busy={busy}
          onConfirm={() => void resolve()}
          onClose={() => {
            if (busy) return;
            setPending(null);
            setNote('');
          }}
          body={
            <div className="sc-stack">
              <p>
                {pending.action === 'dismiss'
                  ? 'No action is taken against the content. Other open reports on the same target are dismissed too.'
                  : pending.action === 'remove_post'
                    ? 'The post is replaced with a “removed for breaking the community rules” notice. Replies keep their context.'
                    : 'The account is signed out everywhere and its posts are hidden until it’s unsuspended.'}
              </p>
              <div className="field">
                <label htmlFor={`${uid}-note`}>
                  Note for the log <span className="sc-optional">(optional)</span>
                </label>
                <textarea
                  id={`${uid}-note`}
                  className="textarea"
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Which rule, and why — helps the next moderator."
                  aria-invalid={charCount(note) > NOTE_MAX || undefined}
                />
                <span className={charCount(note) > NOTE_MAX ? 'meta sc-over' : 'meta'}>
                  {charCount(note)} / {NOTE_MAX}
                </span>
              </div>
            </div>
          }
        />
      )}
    </>
  );
}

function ReportCard({ report: r, onAction }: { report: Report; onAction?: (a: Action) => void }) {
  const postGone = !r.targetPost || r.targetPost.deleted;
  const canSuspend = !!r.targetUser && !r.targetUser.suspended;
  return (
    <article className="mod-card" aria-labelledby={`rep-${r.id}`}>
      <header className="mod-card-head">
        <span className={r.status === 'open' ? 'tag tag-signal' : 'tag'}>{reasonLabel(r.reason)}</span>
        <span className="mod-card-kind meta">{r.targetType === 'post' ? 'post' : 'account'}</span>
        <Time iso={r.createdAt} />
      </header>
      <p className="mod-card-by" id={`rep-${r.id}`}>
        Reported by{' '}
        <Link to={profilePath(r.reporter.handle)} className="mod-link">
          @{r.reporter.handle}
        </Link>
      </p>
      {r.details && (
        <blockquote className="mod-details">
          <p>{r.details}</p>
        </blockquote>
      )}
      <div className="mod-target">
        <p className="kicker mod-target-label">{r.targetType === 'post' ? 'Reported post' : 'Reported account'}</p>
        {r.targetType === 'post' ? (
          r.targetPost ? (
            <PostItem post={r.targetPost} />
          ) : (
            <p className="mod-gone">This post no longer exists.</p>
          )
        ) : r.targetUser ? (
          <UserRow user={r.targetUser} />
        ) : (
          <p className="mod-gone">This account no longer exists.</p>
        )}
        {r.targetType === 'post' && r.targetUser && (
          <p className="meta mod-author">
            Author: <Link to={profilePath(r.targetUser.handle)}>@{r.targetUser.handle}</Link>
            {r.targetUser.suspended && ' · suspended'}
          </p>
        )}
      </div>
      {r.resolution && (
        <p className="mod-resolution meta">
          <Icon name="check" size={14} /> {r.resolution.replace(/_/g, ' ')}
        </p>
      )}
      {onAction && (
        <footer className="mod-actions">
          <button className="btn btn-sm" onClick={() => onAction('dismiss')}>
            Dismiss
          </button>
          {r.targetType === 'post' && (
            <button className="btn btn-sm btn-danger" onClick={() => onAction('remove_post')} disabled={postGone} title={postGone ? 'Already removed or deleted' : undefined}>
              <Icon name="trash" size={15} />
              Remove post
            </button>
          )}
          <button
            className="btn btn-sm btn-danger"
            onClick={() => onAction('suspend_user')}
            disabled={!canSuspend}
            title={!canSuspend ? 'Already suspended or unavailable' : undefined}
          >
            <Icon name="block" size={15} />
            Suspend user
          </button>
        </footer>
      )}
    </article>
  );
}

const ACTION_TEXT: Record<string, string> = {
  remove_post: 'removed a post',
  suspend_user: 'suspended',
  unsuspend_user: 'unsuspended',
  dismiss_report: 'dismissed a report',
  set_role: 'changed the role of',
};

function ActionLog() {
  const list = usePaged<ModAction>('mod-log', (cursor) => api.get<Page<ModAction>>('/mod/actions', { cursor }));
  return (
    <InfiniteList
      hasMore={list.hasMore}
      loading={list.loading}
      loaded={list.loaded}
      error={list.error}
      onMore={list.loadMore}
      empty={<EmptyState title="No actions yet.">Every moderation decision is recorded here, with who made it and why.</EmptyState>}
    >
      {list.items.map((a) => {
        const verb = ACTION_TEXT[a.action] ?? a.action.replace(/_/g, ' ');
        const userIsObject = a.action === 'suspend_user' || a.action === 'unsuspend_user' || a.action === 'set_role';
        return (
          <div key={a.id} className="mod-log">
            <Avatar user={a.moderator} size={28} />
            <div className="mod-log-main">
              <p className="mod-log-text">
                <Link to={profilePath(a.moderator.handle)} className="mod-link">
                  {a.moderator.displayName}
                </Link>{' '}
                {verb}
                {userIsObject && a.targetUser && (
                  <>
                    {' '}
                    <Link to={profilePath(a.targetUser.handle)} className="mod-link">
                      @{a.targetUser.handle}
                    </Link>
                  </>
                )}
                {!userIsObject && a.targetUser && (
                  <>
                    {' '}
                    by{' '}
                    <Link to={profilePath(a.targetUser.handle)} className="mod-link">
                      @{a.targetUser.handle}
                    </Link>
                  </>
                )}
              </p>
              {a.note && <p className="mod-log-note">“{a.note}”</p>}
              <p className="meta">
                <Time iso={a.createdAt} className="" />
                {a.targetPostId && (
                  <>
                    {' · '}
                    <Link to={postPath(a.targetPostId)} className="mod-link-quiet">
                      view post
                    </Link>
                  </>
                )}
              </p>
            </div>
          </div>
        );
      })}
    </InfiniteList>
  );
}
