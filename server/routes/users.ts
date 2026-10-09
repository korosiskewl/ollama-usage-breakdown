import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { FollowState, Profile, ProfileViewerState } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { type D1Like, isoReq, newId } from '../db';
import type { AppEnv, UserRow } from '../env';
import { ApiError, badRequest, body, cleanText, forbidden, notFound, pageSize, requireUser } from '../http';
import { rateLimit } from '../ratelimit';
import { USER_COLS, activeViewerId, canView, getUserByHandle, isBlockedEitherWay, listableUserSql, mediaUrl, notify, pageUsers, toSummary } from '../social';
import { buildMe, displayNameSchema } from './auth';

export const userRoutes = new Hono<AppEnv>();

async function findUser(db: D1Like, handle: string): Promise<UserRow> {
  const h = handle.replace(/^@/, '');
  const u = h.length <= 40 ? await getUserByHandle(db, h) : null;
  if (!u) throw notFound('No such user.');
  return u;
}

async function isBlockedBy(db: D1Like, blockerId: string, blockedId: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(blockerId, blockedId).first());
}

async function relation(db: D1Like, me: string, other: string): Promise<ProfileViewerState> {
  const r = await db
    .prepare(
      `SELECT (SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?) AS following,
              EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ? AND state = 'active') AS follows_you,
              EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?) AS blocking,
              EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?) AS blocked_by,
              EXISTS (SELECT 1 FROM mutes WHERE muter_id = ? AND muted_id = ?) AS muting`,
    )
    .bind(me, other, other, me, me, other, other, me, me, other)
    .first<{ following: FollowState | null; follows_you: number; blocking: number; blocked_by: number; muting: number }>();
  return {
    following: r?.following ?? 'none',
    followsYou: !!r?.follows_you,
    blocking: !!r?.blocking,
    blockedBy: !!r?.blocked_by,
    muting: !!r?.muting,
  };
}

// ---------------------------------------------------------------------------- profiles

userRoutes.get('/users/:handle', async (c) => {
  const db = c.env.DB;
  const me = activeViewerId(c.get('user'));
  const u = await findUser(db, c.req.param('handle'));
  const viewer = me && me !== u.id ? await relation(db, me, u.id) : null;
  if (viewer?.blockedBy) throw notFound('No such user.');
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM follows WHERE followee_id = ? AND state = 'active') AS followers,
              (SELECT COUNT(*) FROM follows WHERE follower_id = ? AND state = 'active') AS following,
              (SELECT COUNT(*) FROM posts WHERE author_id = ? AND deleted_at IS NULL) AS posts`,
    )
    .bind(u.id, u.id, u.id)
    .first<{ followers: number; following: number; posts: number }>();
  const profile: Profile = {
    ...toSummary(u),
    bio: u.bio,
    createdAt: isoReq(u.created_at),
    counts: { followers: counts?.followers ?? 0, following: counts?.following ?? 0, posts: counts?.posts ?? 0 },
    canViewPosts: u.status === 'active' && (await canView(db, me, u)),
    viewer,
  };
  return c.json(profile);
});

const bioSchema = z
  .string()
  .max(LIMITS.bio.max * 16, `At most ${LIMITS.bio.max} characters.`)
  .transform(cleanText)
  .refine((s) => charCount(s) <= LIMITS.bio.max, `At most ${LIMITS.bio.max} characters.`);

userRoutes.patch('/me/profile', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const input = await body(c, z.object({ displayName: displayNameSchema.optional(), bio: bioSchema.optional(), isPrivate: z.boolean().optional() }));
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.displayName !== undefined) { sets.push('display_name = ?'); params.push(input.displayName); }
  if (input.bio !== undefined) { sets.push('bio = ?'); params.push(input.bio); }
  if (input.isPrivate !== undefined) { sets.push('is_private = ?'); params.push(input.isPrivate ? 1 : 0); }
  if (sets.length) {
    await db.batch([
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...params, me.id),
      // Going public auto-accepts everyone who was waiting.
      ...(input.isPrivate === false
        ? [db.prepare("UPDATE follows SET state = 'active' WHERE followee_id = ? AND state = 'pending'").bind(me.id)]
        : []),
    ]);
  }
  const fresh = (await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(me.id).first<UserRow>())!;
  return c.json({ user: await buildMe(db, fresh) });
});

// ---------------------------------------------------------------------------- avatars & media

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MEDIA_KEY_RE = /^avatars\/[0-9A-HJKMNP-TV-Z]{26}\/[0-9A-HJKMNP-TV-Z]{26}$/;
const tooLarge = () => new ApiError(413, 'too_large', 'Images must be 1 MB or smaller.');
const badType = (message = 'Upload a PNG, JPEG, WebP or GIF image.') => new ApiError(415, 'unsupported_media_type', message);

/** Detect the image type from its magic bytes. */
function sniffImage(b: Uint8Array): string | null {
  const at = (offset: number, ...bytes: number[]) => bytes.every((x, i) => b[offset + i] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** Read the raw request body, aborting as soon as it exceeds `max` bytes (Content-Length can be absent or wrong). */
async function readBody(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(req.headers.get('content-length')) > max) throw tooLarge();
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const ch of chunks) {
    out.set(ch, offset);
    offset += ch.byteLength;
  }
  return out;
}

async function removeMedia(c: Context<AppEnv>, key: string, ownerId: string) {
  await c.env.DB.prepare('DELETE FROM media WHERE key = ? AND owner_id = ?').bind(key, ownerId).run();
  if (c.env.MEDIA) await c.env.MEDIA.delete(key);
}

userRoutes.post('/me/avatar', async (c) => {
  const me = requireUser(c);
  await rateLimit(c, 'avatar', me.id, 20, 3600);
  const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) throw badType();
  const bytes = await readBody(c.req.raw, LIMITS.avatarBytes);
  if (!bytes.byteLength) throw badRequest('The upload was empty.');
  if (sniffImage(bytes) !== type) throw badType('That file is not a valid image of the declared type.');

  const db = c.env.DB;
  const key = `avatars/${me.id}/${newId()}`;
  if (c.env.MEDIA) await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
  const prev = await db.prepare('SELECT avatar_key FROM users WHERE id = ?').bind(me.id).first<{ avatar_key: string | null }>();
  await db.batch([
    db.prepare('INSERT INTO media (key, owner_id, content_type, data, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(key, me.id, type, c.env.MEDIA ? null : bytes.buffer, Date.now()),
    db.prepare('UPDATE users SET avatar_key = ? WHERE id = ?').bind(key, me.id),
  ]);
  if (prev?.avatar_key) await removeMedia(c, prev.avatar_key, me.id);
  return c.json({ avatarUrl: mediaUrl(key) });
});

userRoutes.delete('/me/avatar', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const prev = await db.prepare('SELECT avatar_key FROM users WHERE id = ?').bind(me.id).first<{ avatar_key: string | null }>();
  if (prev?.avatar_key) {
    await db.prepare('UPDATE users SET avatar_key = NULL WHERE id = ?').bind(me.id).run();
    await removeMedia(c, prev.avatar_key, me.id);
  }
  return c.json({ ok: true });
});

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  return null;
}

userRoutes.get('/media/:key{.+}', async (c) => {
  const key = c.req.param('key');
  if (!MEDIA_KEY_RE.test(key)) throw notFound();
  const row = await c.env.DB.prepare('SELECT content_type, data FROM media WHERE key = ?')
    .bind(key)
    .first<{ content_type: string; data: unknown }>();
  if (!row || !IMAGE_TYPES.has(row.content_type)) throw notFound();
  const headers = {
    'Content-Type': row.content_type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  };
  if (row.data == null) {
    const obj = c.env.MEDIA ? await c.env.MEDIA.get(key) : null;
    if (!obj) throw notFound();
    return c.body(obj.body, 200, headers);
  }
  const bytes = toBytes(row.data);
  if (!bytes) throw notFound();
  return c.body(new Uint8Array(bytes), 200, headers);
});

// ---------------------------------------------------------------------------- follow graph

async function graphList(c: Context<AppEnv>, handle: string, dir: 'followers' | 'following') {
  const db = c.env.DB;
  const me = activeViewerId(c.get('user'));
  const u = await findUser(db, handle);
  if (me !== u.id) {
    if (me && (await isBlockedBy(db, u.id, me))) throw notFound('No such user.');
    if (!(u.status === 'active' && (await canView(db, me, u)))) throw forbidden('This account’s connections are private.');
  }
  const l = listableUserSql('u', me);
  const [join, where] = dir === 'followers' ? ['f.follower_id', 'f.followee_id'] : ['f.followee_id', 'f.follower_id'];
  return pageUsers(db, {
    from: `FROM follows f JOIN users u ON u.id = ${join} WHERE ${where} = ? AND f.state = 'active' AND ${l.sql}`,
    params: [u.id, ...l.params],
    timeCol: 'f.created_at',
    cursor: c.req.query('cursor'),
    limit: pageSize(c),
  });
}

userRoutes.get('/users/:handle/followers', async (c) => c.json(await graphList(c, c.req.param('handle'), 'followers')));
userRoutes.get('/users/:handle/following', async (c) => c.json(await graphList(c, c.req.param('handle'), 'following')));

userRoutes.post('/users/:handle/follow', async (c) => {
  const me = requireUser(c);
  await rateLimit(c, 'follow', me.id, 200, 3600);
  const db = c.env.DB;
  const u = await findUser(db, c.req.param('handle'));
  if (u.id === me.id) throw badRequest('You can’t follow yourself.');
  if (u.status !== 'active' || (await isBlockedEitherWay(db, me.id, u.id))) throw forbidden('You can’t follow this account.');
  const existing = await db
    .prepare('SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?')
    .bind(me.id, u.id)
    .first<{ state: FollowState }>();
  if (existing) return c.json({ state: existing.state });
  const state: FollowState = u.is_private ? 'pending' : 'active';
  await db
    .prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, state, created_at) VALUES (?, ?, ?, ?)')
    .bind(me.id, u.id, state, Date.now())
    .run();
  await notify(db, u.id, me.id, state === 'pending' ? 'follow_request' : 'follow');
  return c.json({ state });
});

userRoutes.delete('/users/:handle/follow', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const u = await findUser(db, c.req.param('handle'));
  await db.batch([
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').bind(me.id, u.id),
    // A cancelled request should not linger in their notifications.
    db.prepare("DELETE FROM notifications WHERE user_id = ? AND actor_id = ? AND type = 'follow_request'").bind(u.id, me.id),
  ]);
  return c.json({ state: 'none' });
});

userRoutes.get('/me/follow-requests', async (c) => {
  const me = requireUser(c);
  return c.json(
    await pageUsers(c.env.DB, {
      from: "FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ? AND f.state = 'pending' AND u.status = 'active'",
      params: [me.id],
      timeCol: 'f.created_at',
      cursor: c.req.query('cursor'),
      limit: pageSize(c),
    }),
  );
});

userRoutes.post('/me/follow-requests/:userId/accept', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const uid = c.req.param('userId');
  const row = await db
    .prepare('SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?')
    .bind(uid, me.id)
    .first<{ state: FollowState }>();
  if (!row) throw notFound('No such follow request.');
  if (row.state === 'pending') {
    await db.prepare("UPDATE follows SET state = 'active' WHERE follower_id = ? AND followee_id = ?").bind(uid, me.id).run();
    await notify(db, uid, me.id, 'follow_accept');
  }
  return c.json({ ok: true });
});

userRoutes.post('/me/follow-requests/:userId/decline', async (c) => {
  const me = requireUser(c);
  await c.env.DB.prepare("DELETE FROM follows WHERE follower_id = ? AND followee_id = ? AND state = 'pending'")
    .bind(c.req.param('userId'), me.id)
    .run();
  return c.json({ ok: true });
});

userRoutes.delete('/me/followers/:userId', async (c) => {
  const me = requireUser(c);
  await c.env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').bind(c.req.param('userId'), me.id).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------- blocks & mutes

userRoutes.post('/users/:handle/block', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const u = await findUser(db, c.req.param('handle'));
  if (u.id === me.id) throw badRequest('You can’t block yourself.');
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').bind(me.id, u.id, Date.now()),
    // Removes follows (active or pending) in both directions.
    db.prepare('DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)').bind(me.id, u.id, u.id, me.id),
  ]);
  return c.json({ blocking: true });
});

userRoutes.delete('/users/:handle/block', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const u = await findUser(db, c.req.param('handle'));
  await db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(me.id, u.id).run();
  return c.json({ blocking: false });
});

userRoutes.post('/users/:handle/mute', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const u = await findUser(db, c.req.param('handle'));
  if (u.id === me.id) throw badRequest('You can’t mute yourself.');
  await db.prepare('INSERT OR IGNORE INTO mutes (muter_id, muted_id, created_at) VALUES (?, ?, ?)').bind(me.id, u.id, Date.now()).run();
  return c.json({ muting: true });
});

userRoutes.delete('/users/:handle/mute', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const u = await findUser(db, c.req.param('handle'));
  await db.prepare('DELETE FROM mutes WHERE muter_id = ? AND muted_id = ?').bind(me.id, u.id).run();
  return c.json({ muting: false });
});

userRoutes.get('/me/blocks', async (c) => {
  const me = requireUser(c);
  return c.json(
    await pageUsers(c.env.DB, {
      from: "FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? AND u.status != 'deleted'",
      params: [me.id],
      timeCol: 'b.created_at',
      cursor: c.req.query('cursor'),
      limit: pageSize(c),
    }),
  );
});

userRoutes.get('/me/mutes', async (c) => {
  const me = requireUser(c);
  return c.json(
    await pageUsers(c.env.DB, {
      from: "FROM mutes m JOIN users u ON u.id = m.muted_id WHERE m.muter_id = ? AND u.status != 'deleted'",
      params: [me.id],
      timeCol: 'm.created_at',
      cursor: c.req.query('cursor'),
      limit: pageSize(c),
    }),
  );
});
