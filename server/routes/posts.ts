import { Hono } from 'hono';
import { z } from 'zod';
import type { Post, ReaderView, Thread } from '../../shared/types';
import { LIMITS, charCount, extractMentions } from '../../shared/limits';
import { type D1Like, newId, placeholders } from '../db';
import type { AppEnv } from '../env';
import { body, cleanText, decodeCursor, encodeCursor, forbidden, isString, notFound, pageSize, requireUser } from '../http';
import { rateLimit } from '../ratelimit';
import {
  type UserCols,
  activeViewerId,
  canView,
  hydrateList,
  hydratePosts,
  listableUserSql,
  notMutedSql,
  notify,
  pageUsers,
  toSummary,
  visibleAuthorSql,
} from '../social';

export const postRoutes = new Hono<AppEnv>();

const MAX_ANCESTORS = 50;
const MAX_READER_POSTS = 100;

/** Post body: cleaned, then 1..LIMITS.post.max graphemes. The raw cap stops huge combining-mark payloads. */
export const postBodySchema = z
  .string()
  .max(LIMITS.post.max * 16, `Posts are at most ${LIMITS.post.max} characters.`)
  .transform(cleanText)
  .refine((s) => charCount(s) > 0, 'Write something first.')
  .refine((s) => charCount(s) <= LIMITS.post.max, `Posts are at most ${LIMITS.post.max} characters.`);

interface LoadedPost {
  id: string;
  authorId: string;
  rootId: string;
  deleted: boolean;
  author: UserCols;
}

async function loadPost(db: D1Like, id: string | undefined): Promise<LoadedPost | null> {
  if (!id || id.length > 64) return null;
  const r = await db
    .prepare(
      `SELECT p.id, p.author_id, p.root_id, p.deleted_at, u.handle, u.display_name, u.avatar_key, u.is_private, u.role, u.status
       FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
    )
    .bind(id)
    .first<{ id: string; author_id: string; root_id: string; deleted_at: number | null } & Omit<UserCols, 'id'>>();
  if (!r) return null;
  return {
    id: r.id,
    authorId: r.author_id,
    rootId: r.root_id,
    deleted: r.deleted_at != null,
    author: { id: r.author_id, handle: r.handle, display_name: r.display_name, avatar_key: r.avatar_key, is_private: r.is_private, role: r.role, status: r.status },
  };
}

/** Load a post the viewer may see (deleted placeholders included), or 404. */
async function loadVisible(db: D1Like, viewerId: string | null, id: string): Promise<LoadedPost> {
  const p = await loadPost(db, id);
  if (!p || !(await canView(db, viewerId, p.author))) throw notFound('Post not found.');
  return p;
}

/** 404 when the viewer can't see the post at all, 403 when they can but aren't allowed to change it. */
async function denyChange(db: D1Like, viewerId: string, p: LoadedPost, message: string): Promise<never> {
  throw (await canView(db, viewerId, p.author)) ? forbidden(message) : notFound('Post not found.');
}

/** Ids of mentioned users who are active and not blocked either way with the author. */
async function resolveMentions(db: D1Like, authorId: string, text: string): Promise<string[]> {
  const handles = extractMentions(text).slice(0, 50);
  if (!handles.length) return [];
  const rows = (
    await db
      .prepare(
        `SELECT u.id FROM users u
         WHERE u.handle IN (${placeholders(handles.length)}) AND u.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?))`,
      )
      .bind(...handles, authorId, authorId)
      .all<{ id: string }>()
  ).results;
  return rows.map((r) => r.id);
}

/** hydrateList in chunks so a single query stays well under D1's bound-parameter limit. */
async function hydrateMany(db: D1Like, viewerId: string | null, ids: string[]): Promise<Post[]> {
  const out: Post[] = [];
  for (let i = 0; i < ids.length; i += 50) out.push(...(await hydrateList(db, viewerId, ids.slice(i, i + 50))));
  return out;
}

async function hydrateOne(db: D1Like, viewerId: string | null, id: string): Promise<Post | undefined> {
  return (await hydratePosts(db, viewerId, [id])).get(id);
}

const countOf = async (db: D1Like, table: 'likes' | 'reposts', postId: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE post_id = ?`).bind(postId).first<{ n: number }>())?.n ?? 0;

// ---------------------------------------------------------------------------- create / read / edit / delete

postRoutes.post('/posts', async (c) => {
  const me = requireUser(c);
  await rateLimit(c, 'post', me.id, 30, 600);
  const input = await body(c, z.object({ body: postBodySchema, replyToId: z.string().max(64).nullish() }));
  const db = c.env.DB;
  const parent = input.replyToId ? await loadPost(db, input.replyToId) : null;
  if (input.replyToId && (!parent || parent.deleted || !(await canView(db, me.id, parent.author)))) {
    throw notFound('That post is no longer available.');
  }
  const now = Date.now();
  const id = newId(now);
  const mentioned = await resolveMentions(db, me.id, input.body);
  await db.batch([
    db.prepare('INSERT INTO posts (id, author_id, body, reply_to_id, root_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, me.id, input.body, parent?.id ?? null, parent?.rootId ?? id, now),
    ...mentioned.map((uid) => db.prepare('INSERT OR IGNORE INTO mentions (post_id, user_id) VALUES (?, ?)').bind(id, uid)),
  ]);
  // Notify only people who can actually read the post; the parent author gets 'reply' instead of 'mention'.
  if (parent && (await canView(db, parent.authorId, me))) await notify(db, parent.authorId, me.id, 'reply', id);
  for (const uid of mentioned) {
    if (uid !== parent?.authorId && (await canView(db, uid, me))) await notify(db, uid, me.id, 'mention', id);
  }
  return c.json((await hydrateOne(db, me.id, id))!, 201);
});

postRoutes.get('/posts/:id', async (c) => {
  const post = await hydrateOne(c.env.DB, activeViewerId(c.get('user')), c.req.param('id'));
  if (!post || post.unavailable) throw notFound('Post not found.');
  return c.json(post);
});

postRoutes.patch('/posts/:id', async (c) => {
  const me = requireUser(c);
  await rateLimit(c, 'edit', me.id, 60, 600);
  const db = c.env.DB;
  const p = await loadPost(db, c.req.param('id'));
  if (!p) throw notFound('Post not found.');
  if (p.authorId !== me.id) await denyChange(db, me.id, p, 'You can only edit your own posts.');
  if (p.deleted) throw notFound('Post not found.');
  const input = await body(c, z.object({ body: postBodySchema }));
  const mentioned = await resolveMentions(db, me.id, input.body);
  await db.batch([
    db.prepare('UPDATE posts SET body = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL').bind(input.body, Date.now(), p.id),
    db.prepare('DELETE FROM mentions WHERE post_id = ?').bind(p.id),
    ...mentioned.map((uid) => db.prepare('INSERT OR IGNORE INTO mentions (post_id, user_id) VALUES (?, ?)').bind(p.id, uid)),
  ]);
  return c.json((await hydrateOne(db, me.id, p.id))!);
});

postRoutes.delete('/posts/:id', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const p = await loadPost(db, c.req.param('id'));
  if (!p) throw notFound('Post not found.');
  const isAuthor = p.authorId === me.id;
  const isMod = me.role === 'moderator' || me.role === 'admin';
  if (!isAuthor && !isMod) await denyChange(db, me.id, p, 'You can only delete your own posts.');
  if (p.deleted) return c.json({ ok: true });
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE posts SET body = '', deleted_at = ?, removed_by_mod = ? WHERE id = ? AND deleted_at IS NULL").bind(now, isAuthor ? 0 : 1, p.id),
    db.prepare('DELETE FROM mentions WHERE post_id = ?').bind(p.id),
    ...(isAuthor
      ? []
      : [
          db.prepare(
            "INSERT INTO moderation_actions (id, moderator_id, target_user_id, target_post_id, action, note, created_at) VALUES (?, ?, ?, ?, 'remove_post', '', ?)",
          ).bind(newId(now), me.id, p.authorId, p.id, now),
        ]),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------- likes & reposts

postRoutes.post('/posts/:id/like', async (c) => {
  const me = requireUser(c);
  await rateLimit(c, 'like', me.id, 600, 3600);
  const db = c.env.DB;
  const p = await loadVisible(db, me.id, c.req.param('id'));
  if (p.deleted) throw notFound('Post not found.');
  const r = await db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(me.id, p.id, Date.now()).run();
  if (r.meta.changes) await notify(db, p.authorId, me.id, 'like', p.id);
  return c.json({ liked: true, likes: await countOf(db, 'likes', p.id) });
});

postRoutes.delete('/posts/:id/like', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const p = await loadVisible(db, me.id, c.req.param('id'));
  await db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').bind(me.id, p.id).run();
  return c.json({ liked: false, likes: await countOf(db, 'likes', p.id) });
});

postRoutes.post('/posts/:id/repost', async (c) => {
  const me = requireUser(c);
  await rateLimit(c, 'repost', me.id, 300, 3600);
  const db = c.env.DB;
  const p = await loadVisible(db, me.id, c.req.param('id'));
  if (p.deleted) throw notFound('Post not found.');
  if (p.author.is_private) throw forbidden('Posts from private accounts can’t be reposted.');
  const r = await db.prepare('INSERT OR IGNORE INTO reposts (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(me.id, p.id, Date.now()).run();
  if (r.meta.changes) await notify(db, p.authorId, me.id, 'repost', p.id);
  return c.json({ reposted: true, reposts: await countOf(db, 'reposts', p.id) });
});

postRoutes.delete('/posts/:id/repost', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const p = await loadVisible(db, me.id, c.req.param('id'));
  await db.prepare('DELETE FROM reposts WHERE user_id = ? AND post_id = ?').bind(me.id, p.id).run();
  return c.json({ reposted: false, reposts: await countOf(db, 'reposts', p.id) });
});

postRoutes.get('/posts/:id/likes', async (c) => {
  const viewer = activeViewerId(c.get('user'));
  const db = c.env.DB;
  const p = await loadVisible(db, viewer, c.req.param('id'));
  if (p.deleted) return c.json({ items: [], nextCursor: null });
  const l = listableUserSql('u', viewer);
  return c.json(
    await pageUsers(db, {
      from: `FROM likes lk JOIN users u ON u.id = lk.user_id WHERE lk.post_id = ? AND ${l.sql}`,
      params: [p.id, ...l.params],
      timeCol: 'lk.created_at',
      cursor: c.req.query('cursor'),
      limit: pageSize(c),
    }),
  );
});

// ---------------------------------------------------------------------------- threads

postRoutes.get('/posts/:id/thread', async (c) => {
  const viewer = activeViewerId(c.get('user'));
  const db = c.env.DB;
  const id = c.req.param('id');
  const post = await hydrateOne(db, viewer, id);
  if (!post || post.unavailable) throw notFound('Post not found.');

  const ancestorIds = (
    await db
      .prepare(
        `WITH RECURSIVE anc(id, reply_to_id, depth) AS (
           SELECT id, reply_to_id, 0 FROM posts WHERE id = ?
           UNION ALL
           SELECT p.id, p.reply_to_id, anc.depth + 1 FROM posts p JOIN anc ON p.id = anc.reply_to_id WHERE anc.depth < ?
         )
         SELECT id FROM anc WHERE depth > 0 ORDER BY depth DESC`,
      )
      .bind(id, MAX_ANCESTORS)
      .all<{ id: string }>()
  ).results.map((r) => r.id);

  // Direct replies the viewer can see (minus muted authors). Deleted replies stay as placeholders only when
  // something hangs off them, so the conversation below them remains reachable.
  const limit = pageSize(c);
  const cursor = decodeCursor(c.req.query('cursor'), isString);
  const v = visibleAuthorSql('u', viewer);
  const m = notMutedSql('u', viewer);
  const rows = (
    await db
      .prepare(
        `SELECT p.id FROM posts p JOIN users u ON u.id = p.author_id
         WHERE p.reply_to_id = ? AND ${m.sql}
           AND ((p.deleted_at IS NULL AND ${v.sql}) OR (p.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM posts ch WHERE ch.reply_to_id = p.id)))
           ${cursor ? 'AND p.id > ?' : ''}
         ORDER BY p.id ASC LIMIT ?`,
      )
      .bind(id, ...m.params, ...v.params, ...(cursor ? [cursor] : []), limit + 1)
      .all<{ id: string }>()
  ).results.map((r) => r.id);
  const pageIds = rows.slice(0, limit);

  const thread: Thread = {
    ancestors: await hydrateList(db, viewer, ancestorIds),
    post,
    replies: {
      items: await hydrateList(db, viewer, pageIds),
      nextCursor: rows.length > limit ? encodeCursor(pageIds[pageIds.length - 1]) : null,
    },
  };
  return c.json(thread);
});

postRoutes.get('/posts/:id/reader', async (c) => {
  const viewer = activeViewerId(c.get('user'));
  const db = c.env.DB;
  const start = await loadVisible(db, viewer, c.req.param('id'));
  const root = start.rootId === start.id ? start : await loadVisible(db, viewer, start.rootId);

  // Each step takes the earliest live reply by the root author to the previous post in the chain.
  const ids = (
    await db
      .prepare(
        `WITH RECURSIVE chain(id, depth) AS (
           SELECT ?, 0
           UNION ALL
           SELECT (SELECT n.id FROM posts n WHERE n.reply_to_id = chain.id AND n.author_id = ? AND n.deleted_at IS NULL ORDER BY n.id LIMIT 1),
                  chain.depth + 1
           FROM chain WHERE chain.id IS NOT NULL AND chain.depth < ?
         )
         SELECT id FROM chain WHERE id IS NOT NULL ORDER BY depth`,
      )
      .bind(root.id, root.authorId, MAX_READER_POSTS - 1)
      .all<{ id: string }>()
  ).results.map((r) => r.id);

  const others = await db
    .prepare('SELECT COUNT(*) AS n FROM posts WHERE root_id = ? AND author_id != ? AND deleted_at IS NULL')
    .bind(root.id, root.authorId)
    .first<{ n: number }>();
  const view: ReaderView = {
    author: toSummary(root.author),
    posts: await hydrateMany(db, viewer, ids),
    otherReplies: others?.n ?? 0,
  };
  return c.json(view);
});
