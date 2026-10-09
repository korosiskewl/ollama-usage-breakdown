import { Hono } from 'hono';
import type { NotificationGroup, NotificationType, Page } from '../../shared/types';
import { LIMITS } from '../../shared/limits';
import { isoReq } from '../db';
import type { AppEnv, UserRow } from '../env';
import { decodeCursor, encodeCursor, isString, requireUser } from '../http';
import { hydratePosts, toSummary, visibleAuthorSql } from '../social';

export const notificationRoutes = new Hono<AppEnv>();

/** Raw rows fetched per page before grouping. */
const RAW_PAGE = 60;
const MAX_ACTORS = 5;

interface NotificationRow {
  id: string;
  type: NotificationType;
  post_id: string | null;
  created_at: number;
  read_at: number | null;
  a_id: string;
  a_handle: string;
  a_display_name: string;
  a_avatar_key: string | null;
  a_is_private: number;
  a_role: UserRow['role'];
  a_status: UserRow['status'];
}

interface Group {
  key: string | null;
  rows: NotificationRow[];
}

/** like/repost on the same post and follows group together when adjacent; everything else stands alone. */
function groupKey(r: NotificationRow): string | null {
  if ((r.type === 'like' || r.type === 'repost') && r.post_id) return `${r.type}:${r.post_id}`;
  if (r.type === 'follow') return 'follow';
  return null;
}

notificationRoutes.get('/notifications', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const before = decodeCursor(c.req.query('cursor'), isString);
  const vis = visibleAuthorSql('pu', me.id);
  // Skip: actors who are not active, blocked either way, or muted; posts that are gone or not visible to the viewer.
  const rows = (
    await db
      .prepare(
        `SELECT n.id, n.type, n.post_id, n.created_at, n.read_at,
                a.id AS a_id, a.handle AS a_handle, a.display_name AS a_display_name, a.avatar_key AS a_avatar_key,
                a.is_private AS a_is_private, a.role AS a_role, a.status AS a_status
         FROM notifications n
         JOIN users a ON a.id = n.actor_id
         LEFT JOIN posts p ON p.id = n.post_id
         LEFT JOIN users pu ON pu.id = p.author_id
         WHERE n.user_id = ? ${before ? 'AND n.id < ?' : ''}
           AND a.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = a.id) OR (b.blocker_id = a.id AND b.blocked_id = ?))
           AND NOT EXISTS (SELECT 1 FROM mutes m WHERE m.muter_id = ? AND m.muted_id = a.id)
           AND (n.post_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL AND ${vis.sql}))
         ORDER BY n.id DESC LIMIT ?`,
      )
      .bind(me.id, ...(before ? [before] : []), me.id, me.id, me.id, ...vis.params, RAW_PAGE + 1)
      .all<NotificationRow>()
  ).results;

  const hasMoreRaw = rows.length > RAW_PAGE;
  const raw = rows.slice(0, RAW_PAGE);

  const groups: Group[] = [];
  for (const r of raw) {
    const key = groupKey(r);
    const last = groups[groups.length - 1];
    if (key && last && last.key === key) last.rows.push(r);
    else groups.push({ key, rows: [r] });
  }

  const size = LIMITS.pageSize;
  const taken = groups.slice(0, size);
  let nextCursor: string | null = null;
  if (groups.length > size || hasMoreRaw) {
    const lastGroup = taken[taken.length - 1];
    nextCursor = encodeCursor(lastGroup.rows[lastGroup.rows.length - 1].id);
  }

  const posts = await hydratePosts(
    db,
    me.id,
    taken.map((g) => g.rows[0].post_id).filter((x): x is string => !!x),
  );

  const items: NotificationGroup[] = taken.map((g) => {
    const head = g.rows[0];
    const seen = new Set<string>();
    const actors = [];
    for (const r of g.rows) {
      if (seen.has(r.a_id)) continue;
      seen.add(r.a_id);
      actors.push(r);
    }
    return {
      id: head.id,
      type: head.type,
      actors: actors.slice(0, MAX_ACTORS).map((r) =>
        toSummary({
          id: r.a_id,
          handle: r.a_handle,
          display_name: r.a_display_name,
          avatar_key: r.a_avatar_key,
          is_private: r.a_is_private,
          role: r.a_role,
          status: r.a_status,
        }),
      ),
      actorCount: actors.length,
      post: head.post_id ? (posts.get(head.post_id) ?? null) : null,
      createdAt: isoReq(head.created_at),
      read: g.rows.every((r) => r.read_at != null),
    };
  });

  const out: Page<NotificationGroup> = { items, nextCursor };
  return c.json(out);
});

notificationRoutes.post('/notifications/read', async (c) => {
  const me = requireUser(c);
  await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .bind(Date.now(), me.id)
    .run();
  return c.json({ ok: true });
});
