import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Collection, CollectionItem, Page } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { type D1Like, isoReq, newId } from '../db';
import type { AppEnv, UserRow } from '../env';
import { ApiError, body, cleanText, decodeCursor, encodeCursor, forbidden, isTimeKey, notFound, requireUser } from '../http';
import { canView, getUserByHandle, hydrateList, hydratePosts, toSummary } from '../social';

export const collectionRoutes = new Hono<AppEnv>();

const MAX_COLLECTIONS = 100;
const MAX_ITEMS = 500;

const text = (max: number, label: string, min = 0) =>
  z
    .string()
    .max(max * 8, `${label} is too long.`)
    .transform(cleanText)
    .refine((s) => charCount(s) >= min, `${label} is required.`)
    .refine((s) => charCount(s) <= max, `${label} must be at most ${max} characters.`);

const titleSchema = text(LIMITS.collectionTitle.max, 'Title', 1);
const descriptionSchema = text(LIMITS.collectionDescription.max, 'Description');
const noteSchema = text(LIMITS.collectionNote.max, 'Note');

interface CollectionRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  is_public: number;
  created_at: number;
  updated_at: number;
  item_count: number;
  contains_post?: number;
  u_handle: string;
  u_display_name: string;
  u_avatar_key: string | null;
  u_is_private: number;
  u_role: UserRow['role'];
  u_status: UserRow['status'];
}

const SELECT_COLLECTION = `SELECT c.*, u.handle AS u_handle, u.display_name AS u_display_name, u.avatar_key AS u_avatar_key,
       u.is_private AS u_is_private, u.role AS u_role, u.status AS u_status,
       (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count`;

function toCollection(r: CollectionRow): Collection {
  const out: Collection = {
    id: r.id,
    owner: toSummary({
      id: r.owner_id,
      handle: r.u_handle,
      display_name: r.u_display_name,
      avatar_key: r.u_avatar_key,
      is_private: r.u_is_private,
      role: r.u_role,
      status: r.u_status,
    }),
    title: r.title,
    description: r.description,
    isPublic: !!r.is_public,
    itemCount: Number(r.item_count),
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
  if (r.contains_post !== undefined) out.containsPost = !!r.contains_post;
  return out;
}

async function loadCollection(db: D1Like, id: string): Promise<CollectionRow | null> {
  return db
    .prepare(`${SELECT_COLLECTION} FROM collections c JOIN users u ON u.id = c.owner_id WHERE c.id = ?`)
    .bind(id)
    .first<CollectionRow>();
}

const ownerCols = (r: CollectionRow) => ({
  id: r.owner_id,
  handle: r.u_handle,
  display_name: r.u_display_name,
  avatar_key: r.u_avatar_key,
  is_private: r.u_is_private,
  role: r.u_role,
  status: r.u_status,
});

/** A collection the viewer may read: public and owned by someone they can see, or their own. Otherwise 404. */
async function readable(c: Context<AppEnv>, id: string): Promise<CollectionRow> {
  const viewer = c.get('user');
  const row = await loadCollection(c.env.DB, id);
  if (!row) throw notFound('Collection not found.');
  if (viewer && row.owner_id === viewer.id) return row;
  if (!row.is_public || !(await canView(c.env.DB, viewer?.id ?? null, ownerCols(row)))) throw notFound('Collection not found.');
  return row;
}

/** A collection the signed-in user owns. Others get 404 for private collections and 403 for public ones. */
async function owned(c: Context<AppEnv>, me: UserRow, id: string): Promise<CollectionRow> {
  const row = await loadCollection(c.env.DB, id);
  if (!row) throw notFound('Collection not found.');
  if (row.owner_id !== me.id) {
    if (!row.is_public) throw notFound('Collection not found.');
    throw forbidden('Only the owner can change this collection.');
  }
  return row;
}

function optionalViewer(c: Context<AppEnv>): UserRow | null {
  const u = c.get('user');
  if (u?.status === 'suspended') throw new ApiError(403, 'suspended', 'This account is suspended.');
  return u;
}

collectionRoutes.get('/users/:handle/collections', async (c) => {
  const viewer = optionalViewer(c);
  const db = c.env.DB;
  const owner = await getUserByHandle(db, c.req.param('handle').replace(/^@/, ''));
  if (!owner) throw notFound('User not found.');
  const isOwner = viewer?.id === owner.id;
  // Private, blocked or suspended owners' collections are not listed to people who can't see their posts.
  if (!isOwner && !(await canView(db, viewer?.id ?? null, owner))) return c.json({ items: [] });
  const rows = (
    await db
      .prepare(
        `${SELECT_COLLECTION} FROM collections c JOIN users u ON u.id = c.owner_id
         WHERE c.owner_id = ? ${isOwner ? '' : 'AND c.is_public = 1'} ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .bind(owner.id, MAX_COLLECTIONS)
      .all<CollectionRow>()
  ).results;
  return c.json({ items: rows.map(toCollection) });
});

collectionRoutes.get('/me/collections', async (c) => {
  const me = requireUser(c);
  const postId = c.req.query('postId');
  if (postId !== undefined && (!postId || postId.length > 64)) throw new ApiError(400, 'bad_request', 'Invalid post id.');
  const rows = (
    await c.env.DB.prepare(
      `${SELECT_COLLECTION}
       ${postId ? ', EXISTS (SELECT 1 FROM collection_items cp WHERE cp.collection_id = c.id AND cp.post_id = ?) AS contains_post' : ''}
       FROM collections c JOIN users u ON u.id = c.owner_id
       WHERE c.owner_id = ? ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
    )
      .bind(...(postId ? [postId] : []), me.id, MAX_COLLECTIONS)
      .all<CollectionRow>()
  ).results;
  return c.json({ items: rows.map(toCollection) });
});

collectionRoutes.post('/collections', async (c) => {
  const me = requireUser(c);
  const input = await body(
    c,
    z.object({ title: titleSchema, description: descriptionSchema.optional(), isPublic: z.boolean().optional() }),
  );
  const db = c.env.DB;
  const id = newId();
  const now = Date.now();
  // The count guard lives in the INSERT so concurrent requests can't exceed the cap.
  const r = await db
    .prepare(
      `INSERT INTO collections (id, owner_id, title, description, is_public, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM collections WHERE owner_id = ?) < ?`,
    )
    .bind(id, me.id, input.title, input.description ?? '', input.isPublic === false ? 0 : 1, now, now, me.id, MAX_COLLECTIONS)
    .run();
  if (!r.meta.changes) throw new ApiError(409, 'limit_reached', `You can have at most ${MAX_COLLECTIONS} collections.`);
  return c.json(toCollection((await loadCollection(db, id))!), 201);
});

collectionRoutes.get('/collections/:id', async (c) => {
  optionalViewer(c);
  const viewerId = c.get('user')?.id ?? null;
  const db = c.env.DB;
  const row = await readable(c, c.req.param('id'));
  const cur = decodeCursor(c.req.query('cursor'), isTimeKey);
  const size = LIMITS.pageSize;
  const rows = (
    await db
      .prepare(
        `SELECT post_id, note, added_at FROM collection_items
         WHERE collection_id = ? ${cur ? 'AND (added_at < ? OR (added_at = ? AND post_id < ?))' : ''}
         ORDER BY added_at DESC, post_id DESC LIMIT ?`,
      )
      .bind(row.id, ...(cur ? [cur[0], cur[0], cur[1]] : []), size + 1)
      .all<{ post_id: string; note: string; added_at: number }>()
  ).results;
  const page = rows.slice(0, size);
  const posts = await hydratePosts(db, viewerId, page.map((r) => r.post_id));
  const items: CollectionItem[] = [];
  for (const r of page) {
    const post = posts.get(r.post_id);
    // Unavailable posts (private author, blocks, suspended) are omitted; deleted ones stay as placeholders.
    if (!post || post.unavailable) continue;
    items.push({ post, note: r.note, addedAt: isoReq(r.added_at) });
  }
  const tail = page[page.length - 1];
  const itemsPage: Page<CollectionItem> = {
    items,
    nextCursor: rows.length > size ? encodeCursor([tail.added_at, tail.post_id]) : null,
  };
  return c.json({ collection: toCollection(row), items: itemsPage });
});

collectionRoutes.patch('/collections/:id', async (c) => {
  const me = requireUser(c);
  const row = await owned(c, me, c.req.param('id'));
  const input = await body(
    c,
    z.object({ title: titleSchema.optional(), description: descriptionSchema.optional(), isPublic: z.boolean().optional() }),
  );
  const db = c.env.DB;
  await db
    .prepare('UPDATE collections SET title = ?, description = ?, is_public = ?, updated_at = ? WHERE id = ?')
    .bind(
      input.title ?? row.title,
      input.description ?? row.description,
      input.isPublic === undefined ? row.is_public : input.isPublic ? 1 : 0,
      Date.now(),
      row.id,
    )
    .run();
  return c.json(toCollection((await loadCollection(db, row.id))!));
});

collectionRoutes.delete('/collections/:id', async (c) => {
  const me = requireUser(c);
  const row = await owned(c, me, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(row.id).run();
  return c.json({ ok: true });
});

collectionRoutes.post('/collections/:id/items', async (c) => {
  const me = requireUser(c);
  const row = await owned(c, me, c.req.param('id'));
  const input = await body(c, z.object({ postId: z.string().trim().min(1).max(64), note: noteSchema.optional() }));
  const db = c.env.DB;
  const [post] = await hydrateList(db, me.id, [input.postId]);
  if (!post || post.unavailable || post.deleted) throw notFound('Post not found.');
  const now = Date.now();
  const ins = await db
    .prepare(
      `INSERT INTO collection_items (collection_id, post_id, note, added_at)
       SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM collection_items WHERE collection_id = ?) < ?
       ON CONFLICT(collection_id, post_id) DO NOTHING`,
    )
    .bind(row.id, post.id, input.note ?? '', now, row.id, MAX_ITEMS)
    .run();
  if (ins.meta.changes) {
    await db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').bind(now, row.id).run();
    return c.json({ ok: true });
  }
  const exists = await db
    .prepare('SELECT 1 AS x FROM collection_items WHERE collection_id = ? AND post_id = ?')
    .bind(row.id, post.id)
    .first();
  if (!exists) throw new ApiError(409, 'limit_reached', `A collection can hold at most ${MAX_ITEMS} posts.`);
  if (input.note !== undefined) {
    await db
      .prepare('UPDATE collection_items SET note = ? WHERE collection_id = ? AND post_id = ?')
      .bind(input.note, row.id, post.id)
      .run();
  }
  return c.json({ ok: true });
});

collectionRoutes.patch('/collections/:id/items/:postId', async (c) => {
  const me = requireUser(c);
  const row = await owned(c, me, c.req.param('id'));
  const input = await body(c, z.object({ note: noteSchema }));
  const db = c.env.DB;
  const r = await db
    .prepare('UPDATE collection_items SET note = ? WHERE collection_id = ? AND post_id = ?')
    .bind(input.note, row.id, c.req.param('postId'))
    .run();
  if (!r.meta.changes) throw notFound('That post is not in this collection.');
  await db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  return c.json({ ok: true });
});

collectionRoutes.delete('/collections/:id/items/:postId', async (c) => {
  const me = requireUser(c);
  const row = await owned(c, me, c.req.param('id'));
  const db = c.env.DB;
  const r = await db
    .prepare('DELETE FROM collection_items WHERE collection_id = ? AND post_id = ?')
    .bind(row.id, c.req.param('postId'))
    .run();
  if (r.meta.changes) await db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  return c.json({ ok: true });
});
