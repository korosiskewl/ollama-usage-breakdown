import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ConversationSummary, Message, Page, UserSummary } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { fullTime } from '../lib/format';
import { Link, navigate, profilePath, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { Avatar } from '../components/Avatar';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Menu } from '../components/Menu';
import { ReportDialog } from '../components/ReportDialog';
import { RichText } from '../components/RichText';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { Time } from '../components/Time';

const POLL_MS = 4000;
const LIST_POLL_MS = 20000;
const NEAR_BOTTOM = 120;
const GROUP_GAP_MS = 5 * 60_000;
const COUNTER_FROM = LIMITS.message.max - 200;

type Msg = Message & { local?: 'pending' | 'failed'; error?: string };
type Upsert = (patch: Partial<ConversationSummary> & { id: string }, full?: ConversationSummary) => void;

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byUpdated = (a: ConversationSummary, b: ConversationSummary) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

/** Merge server messages into the list: dedupe by id, keep confirmed ones in id order and local (unsent) ones last. */
function mergeIncoming(prev: Msg[], incoming: Message[], myId: string, matchPending: boolean): Msg[] {
  const confirmed = prev.filter((m) => !m.local);
  const ids = new Set(confirmed.map((m) => m.id));
  const add = incoming.filter((m) => !ids.has(m.id));
  if (!add.length) return prev;
  let locals = prev.filter((m) => m.local);
  if (matchPending) {
    // Our own message came back from polling before its POST resolved: drop the optimistic copy.
    for (const m of add) {
      if (m.senderId !== myId) continue;
      const i = locals.findIndex((l) => l.local === 'pending' && l.body === m.body);
      if (i >= 0) locals = [...locals.slice(0, i), ...locals.slice(i + 1)];
    }
  }
  return [...[...confirmed, ...add].sort(byId), ...locals];
}

function mergeConversations(prev: ConversationSummary[] | null, fresh: ConversationSummary[]): ConversationSummary[] {
  const map = new Map((prev ?? []).map((c) => [c.id, c]));
  for (const c of fresh) map.set(c.id, c);
  return [...map.values()].sort(byUpdated);
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const dayYearFmt = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const clockFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function dayLabel(d: Date): string {
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.getFullYear() === today.getFullYear() ? dayFmt.format(d) : dayYearFmt.format(d);
}

type Row = { kind: 'day'; key: string; label: string } | { kind: 'group'; key: string; mine: boolean; msgs: Msg[] };

function buildRows(msgs: Msg[], myId: string): Row[] {
  const rows: Row[] = [];
  let lastDay = '';
  let group: Extract<Row, { kind: 'group' }> | null = null;
  for (const m of msgs) {
    const d = new Date(m.createdAt);
    const day = d.toDateString();
    if (day !== lastDay) {
      rows.push({ kind: 'day', key: 'day-' + day, label: dayLabel(d) });
      lastDay = day;
      group = null;
    }
    const mine = m.senderId === myId;
    const prev = group?.msgs[group.msgs.length - 1];
    if (group && prev && group.mine === mine && d.getTime() - new Date(prev.createdAt).getTime() < GROUP_GAP_MS) group.msgs.push(m);
    else {
      group = { kind: 'group', key: 'g-' + m.id, mine, msgs: [m] };
      rows.push(group);
    }
  }
  return rows;
}

// Survives remounts (the router remounts pages on every path change) so switching conversations doesn't flash an empty list.
let listCache: { items: ConversationSummary[]; cursor: string | null } | null = null;

export default function Messages({ params }: { params: Record<string, string> }) {
  const { me, loading } = useSession();
  if (loading) return <Loading />;
  if (!me) {
    return (
      <EmptyState
        title="Sign in to read your messages."
        action={
          <Link to="/login" className="btn btn-primary">
            Sign in
          </Link>
        }
      >
        Direct messages are one-to-one conversations with people on Relay.
      </EmptyState>
    );
  }
  return <MessagesInner id={params.id} />;
}

function MessagesInner({ id }: { id?: string }) {
  const { me } = useSession();
  const { query } = useLocation();
  const to = id ? null : query.get('to');
  const [convs, setConvs] = useState<ConversationSummary[] | null>(listCache?.items ?? null);
  const [cursor, setCursor] = useState<string | null>(listCache?.cursor ?? null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [composing, setComposing] = useState(false);
  // Whether page one of the list has been fetched (from the network, or earlier in this session via the cache).
  const firstPageDone = useRef(listCache !== null);

  useEffect(() => {
    if (convs) listCache = { items: convs, cursor };
  }, [convs, cursor]);

  const refreshList = useCallback(async () => {
    try {
      const page = await api.get<Page<ConversationSummary>>('/conversations');
      setConvs((prev) => mergeConversations(prev, page.items));
      if (!firstPageDone.current) {
        firstPageDone.current = true;
        setCursor(page.nextCursor);
      }
      setListError(null);
    } catch (e) {
      if (!firstPageDone.current) setListError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refreshList();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void refreshList(), LIST_POLL_MS);
    return () => window.clearInterval(t);
  }, [refreshList]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.get<Page<ConversationSummary>>('/conversations', { cursor });
      setConvs((prev) => mergeConversations(prev, page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setLoadingMore(false);
    }
  }

  const upsert: Upsert = useCallback((patch, full) => {
    setConvs((prev) => {
      const list = prev ?? [];
      const i = list.findIndex((c) => c.id === patch.id);
      if (i < 0) return full ? [{ ...full, ...patch }, ...list].sort(byUpdated) : prev;
      const next = [...list];
      next[i] = { ...next[i], ...patch };
      return next.sort(byUpdated);
    });
  }, []);

  return (
    <div className="dm-root">
      <div className="dm" data-view={id || to ? 'thread' : 'list'}>
        <section className="dm-list" aria-labelledby="dm-list-title">
          <header className="dm-list-head">
            <h1 className="page-title" id="dm-list-title">
              Messages
            </h1>
            <button className="btn btn-sm btn-primary dm-new-btn" onClick={() => setComposing(true)} title="New message">
              <Icon name="pen" size={15} />
              <span className="dm-new-label">New message</span>
            </button>
          </header>
          <div className="dm-list-scroll">
            {listError ? (
              <ErrorState message={listError} onRetry={() => void refreshList()} />
            ) : !convs ? (
              <ListSkeleton />
            ) : convs.length === 0 ? (
              <EmptyState
                title="No conversations yet."
                action={
                  <button className="btn" onClick={() => setComposing(true)}>
                    Start one
                  </button>
                }
              >
                Message someone directly — one to one. People can choose who’s allowed to message them.
              </EmptyState>
            ) : (
              <ul className="dm-items" role="list">
                {convs.map((c) => (
                  <li key={c.id}>
                    <ConversationLink conv={c} active={c.id === id} myId={me!.id} />
                  </li>
                ))}
                {cursor && (
                  <li className="list-more">
                    <button className="btn btn-sm btn-ghost" onClick={() => void loadMore()} disabled={loadingMore}>
                      {loadingMore && <span className="spinner" />}
                      Older conversations
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
          <p className="dm-privacy">
            <Icon name="lock" size={13} />
            <span>Private to the people in each conversation, but not end-to-end encrypted.</span>
          </p>
        </section>

        <section className="dm-pane" aria-label="Conversation">
          {id ? (
            <Conversation key={id} id={id} upsert={upsert} />
          ) : to ? (
            <StartConversation handle={to} upsert={upsert} />
          ) : (
            <div className="dm-placeholder">
              <p className="dm-placeholder-title">Pick a conversation</p>
              <p>Or start a new one. Messages arrive within a few seconds while a conversation is open.</p>
              <button className="btn" onClick={() => setComposing(true)}>
                <Icon name="pen" size={15} />
                New message
              </button>
            </div>
          )}
        </section>

        {composing && <NewMessageDialog onClose={() => setComposing(false)} />}
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="dm-item">
          <span className="skeleton" style={{ width: 44, height: 44, borderRadius: '50%', flex: 'none' }} />
          <span style={{ display: 'grid', gap: 8, flex: 1 }}>
            <span className="skeleton" style={{ width: '45%', height: 12 }} />
            <span className="skeleton" style={{ width: '80%', height: 12 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function ConversationLink({ conv: c, active, myId }: { conv: ConversationSummary; active: boolean; myId: string }) {
  const last = c.lastMessage;
  const unread = c.unread > 0 && !active;
  return (
    <Link
      to={`/messages/${c.id}`}
      className={'dm-item' + (unread ? ' dm-item-unread' : '')}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        // Hopping between conversations shouldn't pile up history entries.
        if (location.hash.startsWith('#/messages/') && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          navigate(`/messages/${c.id}`, { replace: true });
        }
      }}
    >
      <Avatar user={c.other} size={44} />
      <span className="dm-item-text">
        <span className="dm-item-top">
          <span className="dm-item-name">{c.other.displayName}</span>
          <span className="meta dm-item-handle">@{c.other.handle}</span>
          {last && <Time iso={last.createdAt} className="meta dm-item-time" />}
        </span>
        <span className="dm-item-last">
          {last ? (
            <>
              {last.senderId === myId && <span className="dm-item-you">You: </span>}
              {last.body}
            </>
          ) : (
            <span className="dm-item-none">No messages yet</span>
          )}
        </span>
      </span>
      {unread && (
        <span className="badge" aria-label={`${c.unread} unread`}>
          {c.unread > 99 ? '99+' : c.unread}
        </span>
      )}
    </Link>
  );
}

/** /messages?to=<handle>: find or create the conversation, then replace the URL with it. */
function StartConversation({ handle, upsert }: { handle: string; upsert: Upsert }) {
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const clean = handle.replace(/^@/, '');
  useEffect(() => {
    let live = true;
    api.post<ConversationSummary>('/conversations', { handle: clean }).then(
      (c) => {
        if (!live) return;
        upsert({ id: c.id }, c);
        navigate(`/messages/${c.id}`, { replace: true });
      },
      (e) => {
        if (!live) return;
        if (e instanceof ApiRequestError && e.code === 'dm_not_allowed') setError({ title: `You can’t message @${clean}`, message: e.message });
        else if (e instanceof ApiRequestError && e.status === 404) setError({ title: 'No such account', message: `There’s no one on Relay called @${clean}.` });
        else setError({ title: 'Couldn’t open the conversation', message: errorMessage(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [clean, upsert]);

  if (!error) return <Loading label={`Opening your conversation with @${clean}`} />;
  return (
    <div className="dm-placeholder" role="alert">
      <p className="dm-placeholder-title">{error.title}</p>
      <p>{error.message}</p>
      <div className="dm-placeholder-actions">
        <Link to={profilePath(clean)} className="btn">
          View @{clean}
        </Link>
        <Link to="/messages" className="btn btn-ghost">
          All messages
        </Link>
      </div>
    </div>
  );
}

function Conversation({ id, upsert }: { id: string; upsert: Upsert }) {
  const { me, refreshUnread } = useSession();
  const myId = me!.id;
  const [summary, setSummary] = useState<ConversationSummary | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const [announce, setAnnounce] = useState('');
  const [denied, setDenied] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'block' | 'report'>(null);
  const [attempt, setAttempt] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  const lastIdRef = useRef('0'); // newest message id confirmed by polling/initial load (never advanced by our own POSTs)
  const anchor = useRef<{ type: 'bottom' } | { type: 'preserve'; height: number; top: number } | null>(null);
  const upsertRef = useRef(upsert);
  upsertRef.current = upsert;

  const markRead = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    api.post(`/conversations/${id}/read`).then(
      () => {
        upsertRef.current({ id, unread: 0 });
        void refreshUnread();
      },
      () => {
        /* retried with the next incoming message */
      },
    );
  }, [id, refreshUnread]);

  // Initial load: summary + newest page of messages.
  useEffect(() => {
    let live = true;
    setLoadError(null);
    Promise.all([api.get<ConversationSummary>(`/conversations/${id}`), api.get<Page<Message>>(`/conversations/${id}/messages`)]).then(
      ([s, page]) => {
        if (!live) return;
        const chronological = [...page.items].sort(byId);
        setSummary(s);
        upsertRef.current({ id: s.id, other: s.other, canSend: s.canSend }, s);
        anchor.current = { type: 'bottom' };
        setMsgs(chronological);
        setOlder(page.nextCursor);
        if (chronological.length) lastIdRef.current = chronological[chronological.length - 1].id;
        setLoaded(true);
        markRead();
      },
      (e) => {
        if (!live) return;
        if (e instanceof ApiRequestError && e.status === 404) setNotFound(true);
        else setLoadError(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
  }, [id, markRead, attempt]);

  const isNearBottom = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
  };

  // Poll for new messages every few seconds while the tab is visible.
  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    let inflight = false;
    const tick = async () => {
      if (inflight || document.visibilityState !== 'visible') return;
      inflight = true;
      try {
        const page = await api.get<Page<Message>>(`/conversations/${id}/messages`, { after: lastIdRef.current });
        if (stopped || !page.items.length) return;
        const items = [...page.items].sort(byId);
        lastIdRef.current = items[items.length - 1].id > lastIdRef.current ? items[items.length - 1].id : lastIdRef.current;
        const known = new Set(msgsRef.current.filter((m) => !m.local).map((m) => m.id));
        const fresh = items.filter((m) => !known.has(m.id));
        if (!fresh.length) return;
        const near = isNearBottom();
        if (near) anchor.current = { type: 'bottom' };
        setMsgs((prev) => mergeIncoming(prev, fresh, myId, true));
        const last = fresh[fresh.length - 1];
        upsertRef.current({ id, lastMessage: last, updatedAt: last.createdAt });
        const theirs = fresh.filter((m) => m.senderId !== myId);
        if (theirs.length) {
          if (!near) setNewBelow((n) => n + theirs.length);
          const latest = theirs[theirs.length - 1];
          setAnnounce(`New message: ${latest.body.slice(0, 140)}`);
          markRead();
        }
      } catch {
        /* transient — the next tick retries */
      } finally {
        inflight = false;
      }
    };
    const t = window.setInterval(() => void tick(), POLL_MS);
    const onVis = () => document.visibilityState === 'visible' && void tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [loaded, id, myId, markRead]);

  // Keep the reader's place: stick to the bottom for new messages, preserve offset when older ones are prepended.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    anchor.current = null;
    if (!el || !a) return;
    if (a.type === 'bottom') el.scrollTop = el.scrollHeight;
    else el.scrollTop = el.scrollHeight - a.height + a.top;
  }, [msgs]);

  const loadOlder = useCallback(async () => {
    if (!older || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.get<Page<Message>>(`/conversations/${id}/messages`, { cursor: older });
      const el = scrollRef.current;
      anchor.current = el ? { type: 'preserve', height: el.scrollHeight, top: el.scrollTop } : null;
      setMsgs((prev) => mergeIncoming(prev, page.items, myId, false));
      setOlder(page.nextCursor);
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setLoadingOlder(false);
    }
  }, [older, loadingOlder, id, myId]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < 160 && older && !loadingOlder) void loadOlder();
    if (newBelow && isNearBottom()) setNewBelow(0);
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setNewBelow(0);
  }

  async function send(body: string, retryId?: string) {
    const tempId = retryId ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: Msg = { id: tempId, conversationId: id, senderId: myId, body, createdAt: new Date().toISOString(), local: 'pending' };
    anchor.current = { type: 'bottom' };
    setMsgs((prev) => (retryId ? [...prev.filter((m) => m.id !== retryId), optimistic] : [...prev, optimistic]));
    setNewBelow(0);
    try {
      const real = await api.post<Message>(`/conversations/${id}/messages`, { body });
      setMsgs((prev) => mergeIncoming(prev.filter((m) => m.id !== tempId), [real], myId, false));
      upsertRef.current({ id, lastMessage: real, updatedAt: real.createdAt, unread: 0 });
    } catch (e) {
      let msg = errorMessage(e);
      if (e instanceof ApiRequestError) {
        if (e.status === 429) msg = 'You’re sending messages quickly. Wait a moment, then retry.';
        if (e.code === 'dm_not_allowed') {
          setDenied(e.message);
          setSummary((s) => (s ? { ...s, canSend: false } : s));
        }
      }
      setMsgs((prev) => prev.map((m) => (m.id === tempId ? { ...m, local: 'failed', error: msg } : m)));
    }
  }

  async function block() {
    if (!summary) return;
    try {
      await api.post(`/users/${summary.other.handle}/block`);
      setSummary({ ...summary, canSend: false });
      upsertRef.current({ id, canSend: false });
      setDenied(`You blocked @${summary.other.handle}. Unblock them from Settings → Privacy to message again.`);
      toast(`Blocked @${summary.other.handle}.`);
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setDialog(null);
    }
  }

  if (notFound) {
    return (
      <div className="dm-placeholder">
        <p className="dm-placeholder-title">Conversation not found</p>
        <p>It may have been removed, or the link is wrong.</p>
        <Link to="/messages" className="btn">
          All messages
        </Link>
      </div>
    );
  }
  if (loadError) {
    return (
      <ErrorState
        message={loadError}
        onRetry={() => {
          setLoadError(null);
          setAttempt((a) => a + 1);
        }}
      />
    );
  }
  if (!summary || !loaded) return <Loading label="Loading conversation" />;

  const other = summary.other;
  const rows = buildRows(msgs, myId);

  return (
    <div className="dm-convo">
      <header className="dm-head">
        <Link to="/messages" className="icon-btn dm-back" aria-label="All conversations">
          <Icon name="back" />
        </Link>
        <Link to={profilePath(other.handle)} className="dm-head-who">
          <Avatar user={other} size={36} />
          <span className="dm-head-text">
            <span className="dm-head-name">
              {other.displayName}
              {other.isPrivate && <Icon name="lock" size={13} title="Private account" />}
            </span>
            <span className="meta">@{other.handle}</span>
          </span>
        </Link>
        <Menu
          label="Conversation options"
          items={[
            { label: `View @${other.handle}`, icon: 'user', onSelect: () => navigate(profilePath(other.handle)) },
            { label: `Block @${other.handle}`, icon: 'block', danger: true, onSelect: () => setDialog('block') },
            { label: `Report @${other.handle}`, icon: 'flag', danger: true, onSelect: () => setDialog('report') },
          ]}
        />
      </header>

      <div className="dm-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0} aria-label={`Messages with ${other.displayName}`}>
        {older ? (
          <div className="dm-older">
            <button className="btn btn-sm btn-ghost" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder && <span className="spinner" />}
              Earlier messages
            </button>
          </div>
        ) : (
          <div className="dm-start">
            <Avatar user={other} size={56} />
            <p className="dm-start-name">{other.displayName}</p>
            <p className="meta">@{other.handle}</p>
            <p className="dm-start-note">
              <Icon name="lock" size={13} />
              Messages here are private to you and @{other.handle}, but they aren’t end-to-end encrypted — they’re stored on Relay’s server.
            </p>
          </div>
        )}
        {msgs.length === 0 && <p className="dm-empty">No messages yet. Say hello.</p>}
        <ol className="dm-rows" role="list">
          {rows.map((r) =>
            r.kind === 'day' ? (
              <li key={r.key} className="dm-day">
                <span>{r.label}</span>
              </li>
            ) : (
              <li key={r.key} className={'dm-group ' + (r.mine ? 'dm-mine' : 'dm-theirs')}>
                <span className="sr-only">{r.mine ? 'You' : other.displayName}:</span>
                {!r.mine && (
                  <span className="dm-group-avatar">
                    <Avatar user={other} size={28} />
                  </span>
                )}
                <div className="dm-bubbles">
                  {r.msgs.map((m) => (
                    <div key={m.id} className="dm-msg" data-state={m.local}>
                      <div className="dm-bubble" title={m.local ? undefined : fullTime(m.createdAt)}>
                        <RichText text={m.body} />
                      </div>
                      {m.local === 'failed' && (
                        <p className="dm-failed" role="alert">
                          <span>Not sent{m.error ? ` — ${m.error}` : '.'}</span>
                          <button type="button" className="act" onClick={() => void send(m.body, m.id)} disabled={!!denied}>
                            retry
                          </button>
                          <button type="button" className="act" onClick={() => setMsgs((prev) => prev.filter((x) => x.id !== m.id))}>
                            delete
                          </button>
                        </p>
                      )}
                    </div>
                  ))}
                  <GroupMeta msgs={r.msgs} />
                </div>
              </li>
            ),
          )}
        </ol>
      </div>

      {newBelow > 0 && (
        <button className="dm-newbelow" onClick={jumpToBottom}>
          {newBelow === 1 ? '1 new message' : `${newBelow} new messages`} ↓
        </button>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      {summary.canSend && !denied ? (
        <Composer onSend={(body) => void send(body)} handle={other.handle} />
      ) : (
        <div className="dm-cant">
          <Icon name="lock" size={16} />
          <p>
            {denied ??
              `You can’t send messages in this conversation right now. @${other.handle} may only accept messages from people they follow, or one of you has blocked the other.`}
          </p>
        </div>
      )}

      {dialog === 'block' && (
        <ConfirmDialog
          title={`Block @${other.handle}?`}
          body="They won’t be able to message you, see your posts, follow you or reply to you, and you won’t see theirs. Follows between you are removed."
          confirmLabel="Block"
          danger
          onConfirm={() => void block()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'report' && <ReportDialog target={{ type: 'user', id: other.id, label: `@${other.handle}` }} onClose={() => setDialog(null)} />}
    </div>
  );
}

function GroupMeta({ msgs }: { msgs: Msg[] }) {
  const last = msgs[msgs.length - 1];
  if (last.local === 'failed') return null;
  return (
    <span className="dm-group-meta meta">
      {last.local === 'pending' ? 'Sending…' : <time dateTime={last.createdAt} title={fullTime(last.createdAt)}>{clockFmt.format(new Date(last.createdAt))}</time>}
    </span>
  );
}

function Composer({ onSend, handle }: { onSend: (body: string) => void; handle: string }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const uid = useId();
  const len = charCount(text);
  const over = len > LIMITS.message.max;
  const empty = !text.trim();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 168) + 'px';
  }, [text]);

  useEffect(() => {
    // Desktop: focus the composer on open; phones keep the keyboard closed until asked.
    if (matchMedia('(hover: hover)').matches) ref.current?.focus({ preventScroll: true });
  }, []);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (empty || over) return;
    onSend(text.trim());
    setText('');
    ref.current?.focus();
  }

  return (
    <form className="dm-compose" onSubmit={submit}>
      <label htmlFor={`${uid}-m`} className="sr-only">
        Message @{handle}
      </label>
      <textarea
        ref={ref}
        id={`${uid}-m`}
        className="dm-input"
        rows={1}
        value={text}
        placeholder={`Message @${handle}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
        }}
        aria-invalid={over || undefined}
        aria-describedby={`${uid}-h`}
      />
      <span id={`${uid}-h`} className="sr-only">
        Enter to send, Shift+Enter for a new line.
      </span>
      {len >= COUNTER_FROM && (
        <span className={'dm-count meta' + (over ? ' sc-over' : '')} aria-live="polite">
          {over ? `${len - LIMITS.message.max} over` : LIMITS.message.max - len}
        </span>
      )}
      <button className="dm-send" type="submit" disabled={empty || over} aria-label="Send message">
        <Icon name="send" size={18} />
      </button>
    </form>
  );
}

/** Search people and start (or reopen) a conversation. */
function NewMessageDialog({ onClose }: { onClose: () => void }) {
  const { me } = useSession();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ handle: string; message: string } | null>(null);
  const uid = useId();
  const term = q.trim();

  useEffect(() => {
    setError(null);
    if (term.replace(/^@/, '').length < LIMITS.search.min) {
      setResults(null);
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const t = window.setTimeout(() => {
      api.get<Page<UserSummary>>('/search', { q: term, type: 'users' }, ctrl.signal).then(
        (r) => {
          setResults(r.items.filter((u) => u.id !== me?.id && !u.suspended));
          setSearching(false);
        },
        (e) => {
          if ((e as Error).name === 'AbortError') return;
          setError(e instanceof ApiRequestError && e.status === 429 ? 'Searching too quickly — wait a moment.' : errorMessage(e));
          setSearching(false);
        },
      );
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [term, me?.id]);

  async function start(u: UserSummary) {
    setStarting(u.handle);
    setRowError(null);
    try {
      const c = await api.post<ConversationSummary>('/conversations', { handle: u.handle });
      onClose();
      navigate(`/messages/${c.id}`);
    } catch (e) {
      setRowError({ handle: u.handle, message: errorMessage(e) });
    } finally {
      setStarting(null);
    }
  }

  return (
    <Dialog title="New message" onClose={onClose}>
      <div className="dm-new">
        <label htmlFor={`${uid}-q`} className="label">
          To
        </label>
        <div className="sc-search-field">
          <Icon name="search" size={18} />
          <input
            id={`${uid}-q`}
            className="input sc-search-input"
            type="search"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="Name or @handle"
            value={q}
            maxLength={LIMITS.search.max}
            onChange={(e) => setQ(e.target.value)}
            aria-describedby={`${uid}-hint`}
          />
        </div>
        <p className="hint" id={`${uid}-hint`}>
          Some people only accept messages from accounts they follow.
        </p>
        <div className="dm-new-results" aria-live="polite" aria-busy={searching}>
          {error ? (
            <p className="field-error">{error}</p>
          ) : searching && !results ? (
            <Loading label="Searching" />
          ) : results === null ? null : results.length === 0 ? (
            <p className="hint dm-new-empty">No one matches “{term}”.</p>
          ) : (
            <ul role="list">
              {results.map((u) => (
                <li key={u.id}>
                  <button className="dm-new-row" onClick={() => void start(u)} disabled={!!starting}>
                    <Avatar user={u} size={36} />
                    <span className="dm-new-text">
                      <span className="dm-new-name">{u.displayName}</span>
                      <span className="meta">@{u.handle}</span>
                    </span>
                    {starting === u.handle ? <span className="spinner" /> : <Icon name="send" size={16} />}
                  </button>
                  {rowError?.handle === u.handle && (
                    <p className="field-error dm-new-err" role="alert">
                      {rowError.message}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}
