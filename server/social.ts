// Shared social-graph and post helpers. Every query that returns posts or users to a viewer
// should go through visibleAuthorSql() and hydratePosts() so privacy and block rules live in one place.
import type { Page, Post, PostRef, UserSummary, Settings, NotificationType } from '../shared/types';
import { type D1Like, iso, isoReq, newId, placeholders } from './db';
import type { UserRow } from './env';
import { decodeCursor, encodeCursor, isTimeKey } from './http';

export type UserCols = Pick<UserRow, 'id' | 'handle' | 'display_name' | 'avatar_key' | 'is_private' | 'role' | 'status'>;

export const USER_COLS = 'id, handle, display_name, bio, avatar_key, is_private, role, status, created_at';

export const mediaUrl = (key: string | null) => (key ? `/api/media/${key}` : null);

export function toSummary(u: UserCols): UserSummary {
  return {
    id: u.id,
    handle: u.handle,
    displayName: u.display_name,
    avatarUrl: mediaUrl(u.avatar_key),
    isPrivate: !!u.is_private,
    role: u.role,
    suspended: u.status === 'suspended',
  };
}

const UNAVAILABLE_USER: UserSummary = {
  id: '',
  handle: '',
  displayName: 'Unavailable',
  avatarUrl: null,
  isPrivate: false,
  role: 'user',
  suspended: false,
};

/**
 * SQL condition (and params) that is true when `alias` (a users row) is visible to `viewerId`:
 * account active, not blocked in either direction, and public or followed (or the viewer themself).
 */
export function visibleAuthorSql(alias: string, viewerId: string | null): { sql: string; params: unknown[] } {
  if (!viewerId) return { sql: `(${alias}.status = 'active' AND ${alias}.is_private = 0)`, params: [] };
  return {
    sql: `(${alias}.status = 'active'
      AND (${alias}.is_private = 0 OR ${alias}.id = ? OR EXISTS (SELECT 1 FROM follows vf WHERE vf.follower_id = ? AND vf.followee_id = ${alias}.id AND vf.state = 'active'))
      AND NOT EXISTS (SELECT 1 FROM blocks vb WHERE (vb.blocker_id = ? AND vb.blocked_id = ${alias}.id) OR (vb.blocker_id = ${alias}.id AND vb.blocked_id = ?)))`,
    params: [viewerId, viewerId, viewerId, viewerId],
  };
}

/** SQL condition excluding authors the viewer has muted. */
export function notMutedSql(alias: string, viewerId: string | null): { sql: string; params: unknown[] } {
  if (!viewerId) return { sql: '1', params: [] };
  return { sql: `NOT EXISTS (SELECT 1 FROM mutes vm WHERE vm.muter_id = ? AND vm.muted_id = ${alias}.id)`, params: [viewerId] };
}

export async function getUserByHandle(db: D1Like, handle: string): Promise<UserRow | null> {
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE handle = ? AND status != 'deleted'`).bind(handle).first<UserRow>();
}

export async function getUserById(db: D1Like, id: string): Promise<UserRow | null> {
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ? AND status != 'deleted'`).bind(id).first<UserRow>();
}

export async function isBlockedEitherWay(db: D1Like, a: string, b: string): Promise<boolean> {
  const r = await db
    .prepare('SELECT 1 AS x FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1')
    .bind(a, b, b, a)
    .first();
  return !!r;
}

export async function canView(db: D1Like, viewerId: string | null, author: UserCols): Promise<boolean> {
  const v = visibleAuthorSql('u', viewerId);
  const r = await db.prepare(`SELECT 1 AS x FROM users u WHERE u.id = ? AND ${v.sql}`).bind(author.id, ...v.params).first();
  return !!r;
}

interface PostRow {
  id: string;
  author_id: string;
  body: string;
  reply_to_id: string | null;
  root_id: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  removed_by_mod: number;
  u_id: string;
  u_handle: string;
  u_display_name: string;
  u_avatar_key: string | null;
  u_is_private: number;
  u_role: UserRow['role'];
  u_status: UserRow['status'];
  visible: number;
  replies: number;
  likes: number;
  reposts: number;
  liked: number;
  reposted: number;
}

/**
 * Load posts by id for a viewer. Returns a Map keyed by id; ids that do not exist are absent.
 * Posts the viewer may not see come back with `unavailable: true` and no content.
 */
export async function hydratePosts(db: D1Like, viewerId: string | null, ids: string[]): Promise<Map<string, Post>> {
  const out = new Map<string, Post>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return out;
  const v = visibleAuthorSql('u', viewerId);
  const rows = (
    await db
      .prepare(
        `SELECT p.*, u.id AS u_id, u.handle AS u_handle, u.display_name AS u_display_name, u.avatar_key AS u_avatar_key,
                u.is_private AS u_is_private, u.role AS u_role, u.status AS u_status,
                CASE WHEN ${v.sql} THEN 1 ELSE 0 END AS visible,
                (SELECT COUNT(*) FROM posts r WHERE r.reply_to_id = p.id AND r.deleted_at IS NULL) AS replies,
                (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
                (SELECT COUNT(*) FROM reposts rp WHERE rp.post_id = p.id) AS reposts,
                ${viewerId ? '(SELECT COUNT(*) FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?)' : '0'} AS liked,
                ${viewerId ? '(SELECT COUNT(*) FROM reposts r2 WHERE r2.post_id = p.id AND r2.user_id = ?)' : '0'} AS reposted
         FROM posts p JOIN users u ON u.id = p.author_id
         WHERE p.id IN (${placeholders(unique.length)})`,
      )
      .bind(...v.params, ...(viewerId ? [viewerId, viewerId] : []), ...unique)
      .all<PostRow>()
  ).results;

  // Parent refs and mentions in two extra queries.
  const parentIds = [...new Set(rows.map((r) => r.reply_to_id).filter((x): x is string => !!x))];
  const parents = new Map<string, PostRef>();
  if (parentIds.length) {
    const pr = (
      await db
        .prepare(
          `SELECT p.id, p.deleted_at, u.id AS u_id, u.handle AS u_handle, u.display_name AS u_display_name, u.avatar_key AS u_avatar_key,
                  u.is_private AS u_is_private, u.role AS u_role, u.status AS u_status, CASE WHEN ${v.sql} THEN 1 ELSE 0 END AS visible
           FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id IN (${placeholders(parentIds.length)})`,
        )
        .bind(...v.params, ...parentIds)
        .all<PostRow>()
    ).results;
    for (const r of pr) {
      parents.set(r.id, {
        id: r.id,
        deleted: !!r.deleted_at || !r.visible,
        author: r.visible ? toSummary(rowUser(r)) : null,
      });
    }
  }
  const mentionRows = (
    await db
      .prepare(
        `SELECT m.post_id, u.handle FROM mentions m JOIN users u ON u.id = m.user_id
         WHERE m.post_id IN (${placeholders(unique.length)}) AND u.status = 'active'`,
      )
      .bind(...unique)
      .all<{ post_id: string; handle: string }>()
  ).results;
  const mentions = new Map<string, string[]>();
  for (const m of mentionRows) mentions.set(m.post_id, [...(mentions.get(m.post_id) ?? []), m.handle]);

  for (const r of rows) {
    const deleted = !!r.deleted_at;
    const unavailable = !r.visible;
    const hidden = deleted || unavailable;
    out.set(r.id, {
      id: r.id,
      author: unavailable ? UNAVAILABLE_USER : toSummary(rowUser(r)),
      body: hidden ? '' : r.body,
      createdAt: isoReq(r.created_at),
      editedAt: hidden ? null : iso(r.edited_at),
      deleted,
      removed: deleted && !!r.removed_by_mod,
      unavailable,
      replyToId: r.reply_to_id,
      rootId: r.root_id,
      replyTo: r.reply_to_id ? (parents.get(r.reply_to_id) ?? { id: r.reply_to_id, author: null, deleted: true }) : null,
      mentions: hidden ? [] : (mentions.get(r.id) ?? []),
      counts: { replies: r.replies, likes: hidden ? 0 : r.likes, reposts: hidden ? 0 : r.reposts },
      viewer: viewerId
        ? { liked: !!r.liked, reposted: !!r.reposted, isAuthor: r.author_id === viewerId }
        : null,
    });
  }
  return out;
}

function rowUser(r: PostRow): UserCols {
  return {
    id: r.u_id,
    handle: r.u_handle,
    display_name: r.u_display_name,
    avatar_key: r.u_avatar_key,
    is_private: r.u_is_private,
    role: r.u_role,
    status: r.u_status,
  };
}

/** Hydrate and return in the same order as ids, dropping missing ids. */
export async function hydrateList(db: D1Like, viewerId: string | null, ids: string[]): Promise<Post[]> {
  const map = await hydratePosts(db, viewerId, ids);
  return ids.map((id) => map.get(id)).filter((p): p is Post => !!p);
}

// ---------------------------------------------------------------------------- settings

interface SettingsRow {
  notify_likes: number;
  notify_reposts: number;
  notify_follows: number;
  notify_mentions: number;
  notify_replies: number;
  dm_policy: Settings['dmPolicy'];
  muted_words: string;
  hide_counts: number;
  feed_replies: number;
  feed_reposts: number;
  ai_enabled: number;
}

export async function getSettings(db: D1Like, userId: string): Promise<Settings> {
  const r = await db.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(userId).first<SettingsRow>();
  const row: SettingsRow = r ?? {
    notify_likes: 1, notify_reposts: 1, notify_follows: 1, notify_mentions: 1, notify_replies: 1,
    dm_policy: 'following', muted_words: '[]', hide_counts: 0, feed_replies: 1, feed_reposts: 1, ai_enabled: 0,
  };
  let muted: string[] = [];
  try {
    const parsed = JSON.parse(row.muted_words);
    if (Array.isArray(parsed)) muted = parsed.filter((x) => typeof x === 'string');
  } catch {
    /* ignore corrupt value */
  }
  return {
    notify: {
      likes: !!row.notify_likes,
      reposts: !!row.notify_reposts,
      follows: !!row.notify_follows,
      mentions: !!row.notify_mentions,
      replies: !!row.notify_replies,
    },
    dmPolicy: row.dm_policy,
    mutedWords: muted,
    hideCounts: !!row.hide_counts,
    feedReplies: !!row.feed_replies,
    feedReposts: !!row.feed_reposts,
    aiEnabled: !!row.ai_enabled,
  };
}

/** True when the post body contains any of the muted words/phrases (case-insensitive, whole-word for single words). */
export function matchesMutedWords(body: string, muted: string[]): boolean {
  if (!muted.length || !body) return false;
  const lower = body.toLowerCase();
  return muted.some((w) => {
    if (!w) return false;
    if (/^[\p{L}\p{N}_]+$/u.test(w)) {
      return new RegExp(`(^|[^\\p{L}\\p{N}_])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}_])`, 'u').test(lower);
    }
    return lower.includes(w);
  });
}

// ---------------------------------------------------------------------------- notifications

const PREF_FOR: Record<NotificationType, keyof Settings['notify'] | null> = {
  like: 'likes',
  repost: 'reposts',
  reply: 'replies',
  mention: 'mentions',
  follow: 'follows',
  follow_request: null, // always delivered: the recipient has to act on it
  follow_accept: 'follows',
};

/**
 * Create a notification unless: actor == recipient, either side blocks the other, the recipient muted the actor,
 * or the recipient turned that type off. Duplicate like/repost/follow notifications for the same pair are collapsed.
 */
export async function notify(db: D1Like, recipientId: string, actorId: string, type: NotificationType, postId: string | null = null) {
  if (recipientId === actorId) return;
  if (await isBlockedEitherWay(db, recipientId, actorId)) return;
  const muted = await db.prepare('SELECT 1 AS x FROM mutes WHERE muter_id = ? AND muted_id = ?').bind(recipientId, actorId).first();
  if (muted) return;
  const pref = PREF_FOR[type];
  if (pref) {
    const s = await getSettings(db, recipientId);
    if (!s.notify[pref]) return;
  }
  if (type === 'like' || type === 'repost' || type === 'follow' || type === 'follow_request') {
    const existing = await db
      .prepare('SELECT 1 AS x FROM notifications WHERE user_id = ? AND actor_id = ? AND type = ? AND post_id IS ?')
      .bind(recipientId, actorId, type, postId)
      .first();
    if (existing) return;
  }
  await db
    .prepare('INSERT INTO notifications (id, user_id, actor_id, type, post_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(newId(), recipientId, actorId, type, postId, Date.now())
    .run();
}

// ---------------------------------------------------------------------------- user lists

/** Load user summaries by id. Deleted accounts are omitted. */
export async function getSummaries(db: D1Like, ids: string[]): Promise<Map<string, UserSummary>> {
  const out = new Map<string, UserSummary>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return out;
  const rows = (
    await db
      .prepare(`SELECT ${USER_COLS} FROM users WHERE id IN (${placeholders(unique.length)}) AND status != 'deleted'`)
      .bind(...unique)
      .all<UserRow>()
  ).results;
  for (const r of rows) out.set(r.id, toSummary(r));
  return out;
}

/** SQL condition for listing `alias` (a users row) to the viewer: active and not blocked in either direction. */
export function listableUserSql(alias: string, viewerId: string | null): { sql: string; params: unknown[] } {
  if (!viewerId) return { sql: `${alias}.status = 'active'`, params: [] };
  return {
    sql: `(${alias}.status = 'active' AND NOT EXISTS (SELECT 1 FROM blocks lb WHERE (lb.blocker_id = ? AND lb.blocked_id = ${alias}.id) OR (lb.blocker_id = ${alias}.id AND lb.blocked_id = ?)))`,
    params: [viewerId, viewerId],
  };
}

/**
 * Keyset-paginate users newest-first. `from` is a trusted SQL fragment starting with FROM that joins the users row
 * as `u` and ends in a WHERE clause; `timeCol` is the trusted column to order by. Cursor is [time, userId].
 */
export async function pageUsers(
  db: D1Like,
  opts: { from: string; params: unknown[]; timeCol: string; cursor: string | undefined; limit: number },
): Promise<Page<UserSummary>> {
  const { from, params, timeCol, limit } = opts;
  const cursor = decodeCursor(opts.cursor, isTimeKey);
  const rows = (
    await db
      .prepare(
        `SELECT u.id, u.handle, u.display_name, u.avatar_key, u.is_private, u.role, u.status, ${timeCol} AS at ${from}
         ${cursor ? `AND (${timeCol} < ? OR (${timeCol} = ? AND u.id < ?))` : ''}
         ORDER BY at DESC, u.id DESC LIMIT ?`,
      )
      .bind(...params, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []), limit + 1)
      .all<UserCols & { at: number }>()
  ).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(toSummary), nextCursor: rows.length > limit && last ? encodeCursor([last.at, last.id]) : null };
}
