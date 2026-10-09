import { Hono, type Context } from 'hono';
import type { FeedItem, Page, Post, UserSummary } from '../../shared/types';
import { type D1Like, isoReq, placeholders } from '../db';
import type { AppEnv } from '../env';
import { badRequest, decodeCursor, encodeCursor, forbidden, isTimeKey, notFound, pageSize, requireUser } from '../http';
import {
  canView,
  getSettings,
  getSummaries,
  getUserByHandle,
  hydratePosts,
  matchesMutedWords,
  notMutedSql,
  visibleAuthorSql,
} from '../social';

export const feedRoutes = new Hono<AppEnv>();

type TimeKey = [number, string];

/** One candidate feed entry: an original post (reposter_id NULL) or a repost. */
interface FeedRow {
  key: string;
  post_id: string;
  reposter_id: string | null;
  at: number;
}

interface ConversationItem {
  root: Post;
  replyCount: number;
  participants: UserSummary[];
  lastReplyAt: string;
}

const MAX_ROUNDS = 4;
const CONVERSATION_WINDOW_MS = 7 * 24 * 3600 * 1000;

const viewerOf = (c: Context<AppEnv>) => {
  const u = c.get('user');
  return u && u.status === 'active' ? u.id : null;
};

const cursorSql = (cursor: TimeKey | null, at: string, key: string) =>
  cursor ? { sql: `AND (${at} < ? OR (${at} = ? AND ${key} < ?))`, params: [cursor[0], cursor[0], cursor[1]] } : { sql: '', params: [] };

/**
 * Fill a page from an ordered row source whose rows may be dropped after hydration (muted words, duplicates,
 * visibility changes). Over-fetches, and the cursor always points at the last row consumed, never the last item
 * shown, so no row is skipped or repeated between pages.
 */
async function fillPage<R, T>(opts: {
  limit: number;
  cursor: TimeKey | null;
  fetch: (cursor: TimeKey | null, n: number) => Promise<R[]>;
  cursorOf: (row: R) => TimeKey;
  build: (rows: R[]) => Promise<Array<T | null>>;
  dedupeKey?: (item: T) => string;
}): Promise<Page<T>> {
  const { limit, fetch, cursorOf, build, dedupeKey } = opts;
  // hydratePosts binds one parameter per id; stay well under D1's 100-parameter limit.
  const n = Math.min(limit * 2, 80);
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor = opts.cursor;
  let more = true;
  for (let round = 0; round < MAX_ROUNDS && more && items.length < limit; round++) {
    const rows = await fetch(cursor, n);
    const built = await build(rows);
    more = rows.length === n;
    for (let i = 0; i < rows.length; i++) {
      if (items.length === limit) {
        more = true;
        break;
      }
      cursor = cursorOf(rows[i]);
      const item = built[i];
      if (!item) continue;
      const k = dedupeKey?.(item);
      if (k !== undefined) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
      items.push(item);
    }
  }
  return { items, nextCursor: more && cursor ? encodeCursor(cursor) : null };
}

/** Hydrate feed rows into items; rows whose post is gone, hidden or matches a muted word become null. */
async function buildItems(db: D1Like, viewerId: string | null, rows: FeedRow[], mutedWords: string[]): Promise<Array<FeedItem | null>> {
  const posts = await hydratePosts(db, viewerId, rows.map((r) => r.post_id));
  const reposters = await getSummaries(db, rows.map((r) => r.reposter_id).filter((x): x is string => !!x));
  return rows.map((r) => {
    const post = posts.get(r.post_id);
    if (!post || post.deleted || post.unavailable) return null;
    if (post.author.id !== viewerId && matchesMutedWords(post.body, mutedWords)) return null;
    const by = r.reposter_id ? reposters.get(r.reposter_id) : null;
    if (r.reposter_id && !by) return null;
    return { key: r.key, kind: by ? 'repost' : 'post', post, repostedBy: by ?? null, at: isoReq(r.at) };
  });
}

const feedPage = (
  db: D1Like,
  viewerId: string | null,
  limit: number,
  cursor: TimeKey | null,
  mutedWords: string[],
  fetch: (cursor: TimeKey | null, n: number) => Promise<FeedRow[]>,
) =>
  fillPage<FeedRow, FeedItem>({
    limit,
    cursor,
    fetch,
    cursorOf: (r) => [r.at, r.key],
    build: (rows) => buildItems(db, viewerId, rows, mutedWords),
    // A post that is both an original and a repost (or reposted twice) shows once per page, newest first.
    dedupeKey: (item) => item.post.id,
  });

/** Run a feed query (a trusted SQL fragment selecting key, post_id, reposter_id, at) in (at DESC, key DESC) order. */
async function runFeedSql(db: D1Like, inner: string, params: unknown[], cursor: TimeKey | null, n: number): Promise<FeedRow[]> {
  const cur = cursorSql(cursor, 'at', 'key');
  return (
    await db
      .prepare(`SELECT key, post_id, reposter_id, at FROM (${inner}) WHERE 1 ${cur.sql} ORDER BY at DESC, key DESC LIMIT ?`)
      .bind(...params, ...cur.params, n)
      .all<FeedRow>()
  ).results;
}

const parseFlag = (v: string | undefined, def: boolean) => (v === '1' ? true : v === '0' ? false : def);

// ---------------------------------------------------------------------------- home

feedRoutes.get('/feed/home', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const settings = await getSettings(db, me.id);
  const replies = parseFlag(c.req.query('replies'), settings.feedReplies);
  const reposts = parseFlag(c.req.query('reposts'), settings.feedReposts);
  const cursor = decodeCursor(c.req.query('cursor'), isTimeKey);

  const follows = (col: string) => `EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = ${col} AND f.state = 'active')`;
  const va = visibleAuthorSql('a', me.id);
  const ma = notMutedSql('a', me.id);
  let inner = `SELECT 'p:' || p.id AS key, p.id AS post_id, NULL AS reposter_id, p.created_at AS at
    FROM posts p JOIN users a ON a.id = p.author_id
    WHERE p.deleted_at IS NULL AND (p.author_id = ? OR ${follows('p.author_id')}) AND ${va.sql} AND ${ma.sql}`;
  const params: unknown[] = [me.id, me.id, ...va.params, ...ma.params];
  if (replies) {
    // Replies only when the parent's author is the viewer or someone they follow.
    inner += ` AND (p.reply_to_id IS NULL OR EXISTS (SELECT 1 FROM posts pp WHERE pp.id = p.reply_to_id AND (pp.author_id = ? OR ${follows('pp.author_id')})))`;
    params.push(me.id, me.id);
  } else {
    inner += ' AND p.reply_to_id IS NULL';
  }
  if (reposts) {
    const vr = visibleAuthorSql('ru', me.id);
    const mr = notMutedSql('ru', me.id);
    inner += `
    UNION ALL
    SELECT 'r:' || r.user_id || ':' || r.post_id, r.post_id, r.user_id, r.created_at
    FROM reposts r JOIN users ru ON ru.id = r.user_id JOIN posts p ON p.id = r.post_id JOIN users a ON a.id = p.author_id
    WHERE (r.user_id = ? OR ${follows('r.user_id')}) AND p.deleted_at IS NULL
      AND ${va.sql} AND ${ma.sql} AND ${vr.sql} AND ${mr.sql}`;
    params.push(me.id, me.id, ...va.params, ...ma.params, ...vr.params, ...mr.params);
  }

  return c.json(
    await feedPage(db, me.id, pageSize(c), cursor, settings.mutedWords, (cur, n) => runFeedSql(db, inner, params, cur, n)),
  );
});

// ---------------------------------------------------------------------------- explore

feedRoutes.get('/feed/explore', async (c) => {
  const viewer = viewerOf(c);
  const db = c.env.DB;
  const muted = viewer ? (await getSettings(db, viewer)).mutedWords : [];
  const cursor = decodeCursor(c.req.query('cursor'), isTimeKey);
  const va = visibleAuthorSql('a', viewer);
  const ma = notMutedSql('a', viewer);
  const inner = `SELECT 'p:' || p.id AS key, p.id AS post_id, NULL AS reposter_id, p.created_at AS at
    FROM posts p JOIN users a ON a.id = p.author_id
    WHERE p.deleted_at IS NULL AND p.reply_to_id IS NULL AND a.is_private = 0 AND ${va.sql} AND ${ma.sql}`;
  return c.json(
    await feedPage(db, viewer, pageSize(c), cursor, muted, (cur, n) => runFeedSql(db, inner, [...va.params, ...ma.params], cur, n)),
  );
});

// ---------------------------------------------------------------------------- conversations

feedRoutes.get('/feed/conversations', async (c) => {
  const viewer = viewerOf(c);
  const db = c.env.DB;
  const muted = viewer ? (await getSettings(db, viewer)).mutedWords : [];
  const since = Date.now() - CONVERSATION_WINDOW_MS;
  const vr = visibleAuthorSql('ra', viewer);
  const mr = notMutedSql('ra', viewer);
  const vt = visibleAuthorSql('ta', viewer);
  const mt = notMutedSql('ta', viewer);
  type ConvRow = { root_id: string; last_at: number; n: number };

  const fetch = async (cursor: TimeKey | null, n: number) => {
    const cur = cursorSql(cursor, 'last_at', 'root_id');
    return (
      await db
        .prepare(
          `SELECT root_id, last_at, n FROM (
             SELECT r.root_id AS root_id, MAX(r.created_at) AS last_at, COUNT(*) AS n
             FROM posts r JOIN users ra ON ra.id = r.author_id
             JOIN posts t ON t.id = r.root_id JOIN users ta ON ta.id = t.author_id
             WHERE r.root_id IN (SELECT q.root_id FROM posts q WHERE q.created_at > ? AND q.reply_to_id IS NOT NULL AND q.deleted_at IS NULL)
               AND r.reply_to_id IS NOT NULL AND r.deleted_at IS NULL AND ${vr.sql} AND ${mr.sql}
               AND t.deleted_at IS NULL AND ${vt.sql} AND ${mt.sql}
             GROUP BY r.root_id
           )
           WHERE last_at > ? ${cur.sql}
           ORDER BY last_at DESC, root_id DESC LIMIT ?`,
        )
        .bind(since, ...vr.params, ...mr.params, ...vt.params, ...mt.params, since, ...cur.params, n)
        .all<ConvRow>()
    ).results;
  };

  const build = async (rows: ConvRow[]): Promise<Array<ConversationItem | null>> => {
    if (!rows.length) return [];
    const rootIds = rows.map((r) => r.root_id);
    const roots = await hydratePosts(db, viewer, rootIds);
    // Up to 4 distinct visible participants per conversation: the root author first, then the most recent repliers.
    const vu = visibleAuthorSql('u', viewer);
    const mu = notMutedSql('u', viewer);
    const prow = (
      await db
        .prepare(
          `SELECT root_id, author_id FROM (
             SELECT r.root_id AS root_id, r.author_id AS author_id,
                    ROW_NUMBER() OVER (PARTITION BY r.root_id ORDER BY MAX(r.author_id = t.author_id) DESC, MAX(r.created_at) DESC) AS rn
             FROM posts r JOIN posts t ON t.id = r.root_id JOIN users u ON u.id = r.author_id
             WHERE r.root_id IN (${placeholders(rootIds.length)}) AND r.deleted_at IS NULL AND ${vu.sql} AND ${mu.sql}
             GROUP BY r.root_id, r.author_id
           ) WHERE rn <= 4 ORDER BY root_id, rn`,
        )
        .bind(...rootIds, ...vu.params, ...mu.params)
        .all<{ root_id: string; author_id: string }>()
    ).results;
    const users = await getSummaries(db, prow.map((p) => p.author_id));
    const participants = new Map<string, UserSummary[]>();
    for (const p of prow) {
      const u = users.get(p.author_id);
      if (u) participants.set(p.root_id, [...(participants.get(p.root_id) ?? []), u]);
    }
    return rows.map((r) => {
      const root = roots.get(r.root_id);
      if (!root || root.deleted || root.unavailable) return null;
      if (root.author.id !== viewer && matchesMutedWords(root.body, muted)) return null;
      return { root, replyCount: r.n, participants: participants.get(r.root_id) ?? [], lastReplyAt: isoReq(r.last_at) };
    });
  };

  return c.json(
    await fillPage<ConvRow, ConversationItem>({
      limit: pageSize(c),
      cursor: decodeCursor(c.req.query('cursor'), isTimeKey),
      fetch,
      cursorOf: (r) => [r.last_at, r.root_id],
      build,
    }),
  );
});

// ---------------------------------------------------------------------------- profile posts

feedRoutes.get('/users/:handle/posts', async (c) => {
  const viewer = viewerOf(c);
  const db = c.env.DB;
  const tab = c.req.query('tab') ?? 'posts';
  if (tab !== 'posts' && tab !== 'replies') throw badRequest('Unknown tab.');
  const handle = c.req.param('handle').replace(/^@/, '');
  const u = handle.length <= 40 ? await getUserByHandle(db, handle) : null;
  if (!u) throw notFound('No such user.');
  if (viewer && viewer !== u.id) {
    const blockedBy = await db.prepare('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(u.id, viewer).first();
    if (blockedBy) throw notFound('No such user.');
  }
  if (u.status === 'suspended') return c.json({ items: [], nextCursor: null });
  if (!(await canView(db, viewer, u))) throw forbidden('This account is private.');
  const cursor = decodeCursor(c.req.query('cursor'), isTimeKey);

  let inner: string;
  let params: unknown[];
  if (tab === 'replies') {
    inner = `SELECT 'p:' || p.id AS key, p.id AS post_id, NULL AS reposter_id, p.created_at AS at
      FROM posts p WHERE p.author_id = ? AND p.deleted_at IS NULL AND p.reply_to_id IS NOT NULL`;
    params = [u.id];
  } else {
    const va = visibleAuthorSql('a', viewer);
    const ma = notMutedSql('a', viewer);
    inner = `SELECT 'p:' || p.id AS key, p.id AS post_id, NULL AS reposter_id, p.created_at AS at
      FROM posts p WHERE p.author_id = ? AND p.deleted_at IS NULL AND p.reply_to_id IS NULL
      UNION ALL
      SELECT 'r:' || r.user_id || ':' || r.post_id, r.post_id, r.user_id, r.created_at
      FROM reposts r JOIN posts p ON p.id = r.post_id JOIN users a ON a.id = p.author_id
      WHERE r.user_id = ? AND p.deleted_at IS NULL AND ${va.sql} AND (a.id = r.user_id OR ${ma.sql})`;
    params = [u.id, u.id, ...va.params, ...ma.params];
  }
  // Muted users and words don't apply to the profile owner's own posts.
  return c.json(await feedPage(db, viewer, pageSize(c), cursor, [], (cur, n) => runFeedSql(db, inner, params, cur, n)));
});
