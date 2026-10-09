import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Me, SessionInfo, Unread } from '../../shared/types';
import { LIMITS } from '../../shared/limits';
import { type D1Like, isoReq, newId } from '../db';
import type { AppEnv, UserRow } from '../env';
import { ApiError, body, requireUser, cleanText } from '../http';
import { createSession, destroySession, getDummyHash, hashPassword, verifyPassword } from '../auth';
import { clientIp, rateLimit } from '../ratelimit';
import { USER_COLS, getSettings, toSummary } from '../social';

export const authRoutes = new Hono<AppEnv>();

export const handleSchema = z
  .string()
  .trim()
  .min(LIMITS.handle.min, `Handles are at least ${LIMITS.handle.min} characters.`)
  .max(LIMITS.handle.max, `Handles are at most ${LIMITS.handle.max} characters.`)
  .regex(LIMITS.handle.pattern, 'Use letters, numbers and underscores only.');

const passwordSchema = z
  .string()
  .min(LIMITS.password.min, `Use at least ${LIMITS.password.min} characters.`)
  .max(LIMITS.password.max, 'That password is too long.');

export const displayNameSchema = z
  .string()
  .transform(cleanText)
  .pipe(z.string().min(1, 'Display name is required.').max(LIMITS.displayName.max, `At most ${LIMITS.displayName.max} characters.`));

const RESERVED = new Set(['admin', 'administrator', 'root', 'relay', 'support', 'help', 'api', 'settings', 'explore', 'notifications', 'messages', 'search', 'login', 'signup', 'mod', 'moderator', 'system', 'null', 'undefined', 'me']);

export async function unreadCounts(db: D1Like, userId: string): Promise<Unread> {
  const [n, m, f] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(userId),
    db.prepare(
      `SELECT COUNT(*) AS n FROM messages msg
       JOIN conversation_members cm ON cm.conversation_id = msg.conversation_id AND cm.user_id = ?
       WHERE msg.sender_id != ? AND msg.created_at > cm.last_read_at`,
    ).bind(userId, userId),
    db.prepare("SELECT COUNT(*) AS n FROM follows WHERE followee_id = ? AND state = 'pending'").bind(userId),
  ]);
  const num = (r: { results: unknown[] }) => Number((r.results[0] as { n: number } | undefined)?.n ?? 0);
  return { notifications: num(n), messages: num(m), followRequests: num(f) };
}

export async function buildMe(db: D1Like, u: UserRow): Promise<Me> {
  return {
    ...toSummary(u),
    bio: u.bio,
    createdAt: isoReq(u.created_at),
    settings: await getSettings(db, u.id),
    unread: await unreadCounts(db, u.id),
  };
}

function adminHandles(c: Context<AppEnv>): Set<string> {
  return new Set((c.env.ADMIN_HANDLES ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
}

authRoutes.post('/auth/signup', async (c) => {
  await rateLimit(c, 'signup', clientIp(c), 5, 3600);
  const input = await body(c, z.object({ handle: handleSchema, displayName: displayNameSchema, password: passwordSchema }));
  if (RESERVED.has(input.handle.toLowerCase())) {
    throw new ApiError(409, 'handle_taken', 'That handle is not available.', { handle: 'That handle is not available.' });
  }
  const taken = await c.env.DB.prepare('SELECT 1 AS x FROM users WHERE handle = ?').bind(input.handle).first();
  if (taken) throw new ApiError(409, 'handle_taken', 'That handle is already taken.', { handle: 'That handle is already taken.' });

  let role: UserRow['role'] = adminHandles(c).has(input.handle.toLowerCase()) ? 'admin' : 'user';
  if (role === 'user' && c.env.FIRST_USER_ADMIN === 'true') {
    const anyAdmin = await c.env.DB.prepare("SELECT 1 AS x FROM users WHERE role = 'admin' LIMIT 1").first();
    if (!anyAdmin) role = 'admin';
  }
  const id = newId();
  const hash = await hashPassword(input.password);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO users (id, handle, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(id, input.handle, input.displayName, role, hash, Date.now()),
      c.env.DB.prepare('INSERT INTO user_settings (user_id) VALUES (?)').bind(id),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new ApiError(409, 'handle_taken', 'That handle is already taken.', { handle: 'That handle is already taken.' });
    throw e;
  }
  await createSession(c, id);
  const u = (await c.env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first<UserRow>())!;
  return c.json({ user: await buildMe(c.env.DB, u) }, 201);
});

authRoutes.post('/auth/login', async (c) => {
  const input = await body(c, z.object({ handle: z.string().trim().min(1).max(40), password: z.string().min(1).max(LIMITS.password.max) }));
  await rateLimit(c, 'login-ip', clientIp(c), 20, 900);
  await rateLimit(c, 'login-handle', input.handle.toLowerCase(), 10, 900);
  const row = await c.env.DB.prepare(`SELECT ${USER_COLS}, password_hash FROM users WHERE handle = ? AND status != 'deleted'`)
    .bind(input.handle.replace(/^@/, ''))
    .first<UserRow & { password_hash: string }>();
  const ok = await verifyPassword(input.password, row?.password_hash ?? (await getDummyHash()));
  if (!row || !ok) throw new ApiError(401, 'invalid_credentials', 'That handle and password don’t match.');
  if (row.status === 'suspended') throw new ApiError(403, 'suspended', 'This account is suspended for violating the community rules.');
  const { password_hash: _ph, ...u } = row;
  if (u.role === 'user' && adminHandles(c).has(u.handle.toLowerCase())) {
    await c.env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(u.id).run();
    u.role = 'admin';
  }
  await createSession(c, u.id);
  return c.json({ user: await buildMe(c.env.DB, u) });
});

authRoutes.post('/auth/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

authRoutes.get('/auth/me', async (c) => {
  const u = c.get('user');
  if (!u) return c.json({ user: null });
  return c.json({ user: await buildMe(c.env.DB, u) });
});

authRoutes.get('/me/unread', async (c) => {
  const u = requireUser(c);
  return c.json(await unreadCounts(c.env.DB, u.id));
});

authRoutes.post('/auth/password', async (c) => {
  const u = requireUser(c);
  await rateLimit(c, 'password', u.id, 5, 900);
  const input = await body(c, z.object({ currentPassword: z.string().min(1).max(LIMITS.password.max), newPassword: passwordSchema }));
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(u.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(input.currentPassword, row.password_hash))) {
    throw new ApiError(422, 'validation_failed', 'Current password is incorrect.', { currentPassword: 'Current password is incorrect.' });
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(input.newPassword), u.id),
    // Sign out every other session.
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(u.id, c.get('sessionId')),
  ]);
  return c.json({ ok: true });
});

authRoutes.get('/auth/sessions', async (c) => {
  const u = requireUser(c);
  const rows = (
    await c.env.DB.prepare('SELECT id, created_at, last_seen_at, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC')
      .bind(u.id, Date.now())
      .all<{ id: string; created_at: number; last_seen_at: number; user_agent: string }>()
  ).results;
  const items: SessionInfo[] = rows.map((r) => ({
    // Expose only a prefix of the hashed id; enough to revoke, useless as a credential.
    id: r.id.slice(0, 16),
    current: r.id === c.get('sessionId'),
    createdAt: isoReq(r.created_at),
    lastSeenAt: isoReq(r.last_seen_at),
    userAgent: r.user_agent,
  }));
  return c.json({ items });
});

authRoutes.delete('/auth/sessions/:id', async (c) => {
  const u = requireUser(c);
  const prefix = c.req.param('id');
  if (!/^[0-9a-f]{16}$/.test(prefix)) throw new ApiError(400, 'bad_request', 'Invalid session id.');
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?").bind(u.id, prefix).run();
  return c.json({ ok: true });
});

/** Permanently delete the account and its content. Requires the password. */
authRoutes.post('/auth/delete-account', async (c) => {
  const u = requireUser(c);
  await rateLimit(c, 'delete-account', u.id, 5, 900);
  const input = await body(c, z.object({ password: z.string().min(1).max(LIMITS.password.max) }));
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(u.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(input.password, row.password_hash))) {
    throw new ApiError(422, 'validation_failed', 'Password is incorrect.', { password: 'Password is incorrect.' });
  }
  const db = c.env.DB;
  const now = Date.now();
  // Posts become deleted placeholders so other people's replies keep their context; everything else cascades.
  await db.batch([
    db.prepare("UPDATE posts SET body = '', deleted_at = ? WHERE author_id = ? AND deleted_at IS NULL").bind(now, u.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM follows WHERE follower_id = ? OR followee_id = ?').bind(u.id, u.id),
    db.prepare('DELETE FROM likes WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM reposts WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM notifications WHERE user_id = ? OR actor_id = ?').bind(u.id, u.id),
    db.prepare('DELETE FROM collections WHERE owner_id = ?').bind(u.id),
    db.prepare('DELETE FROM messages WHERE sender_id = ?').bind(u.id),
    db.prepare('DELETE FROM media WHERE owner_id = ?').bind(u.id),
    db.prepare(
      "UPDATE users SET status = 'deleted', handle = ?, display_name = 'Deleted account', bio = '', avatar_key = NULL, password_hash = '' WHERE id = ?",
    ).bind(`deleted_${u.id}`, u.id),
  ]);
  await destroySession(c);
  return c.json({ ok: true });
});
