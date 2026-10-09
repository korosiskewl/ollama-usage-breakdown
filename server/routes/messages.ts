import { Hono } from 'hono';
import { z } from 'zod';
import type { ConversationSummary, Message, Page } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { type D1Like, isoReq, newId, placeholders } from '../db';
import type { AppEnv, UserRow } from '../env';
import { ApiError, badRequest, body, cleanText, decodeCursor, encodeCursor, isString, isTimeKey, notFound, requireUser, validate } from '../http';
import { rateLimit } from '../ratelimit';
import { USER_COLS, getSettings, getUserByHandle, isBlockedEitherWay, toSummary } from '../social';

export const messageRoutes = new Hono<AppEnv>();

const AFTER_MAX = 100;

const pairKey = (a: string, b: string) => [a, b].sort().join(':');

const dmNotAllowed = (message: string) => new ApiError(403, 'dm_not_allowed', message);

const messageBodySchema = z.object({
  body: z
    .string({ error: 'Write a message.' })
    .max(LIMITS.message.max * 8, 'That message is too long.')
    .transform(cleanText)
    .refine((s) => charCount(s) >= 1, 'Write a message.')
    .refine((s) => charCount(s) <= LIMITS.message.max, `Messages are at most ${LIMITS.message.max} characters.`),
});

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: number;
}

const toMessage = (m: MessageRow): Message => ({
  id: m.id,
  conversationId: m.conversation_id,
  senderId: m.sender_id,
  body: m.body,
  createdAt: isoReq(m.created_at),
});

/**
 * Why `senderId` may not message `recipient` (in conversation `convId`, if one exists), or null when allowed.
 * The SQL in canSendSql() mirrors these rules for list views; keep the two in sync.
 */
async function dmDenial(db: D1Like, senderId: string, recipient: UserRow, convId: string | null): Promise<string | null> {
  if (recipient.status !== 'active') return 'This account can’t receive messages.';
  if (await isBlockedEitherWay(db, senderId, recipient.id)) return 'You can’t message this account.';
  const { dmPolicy } = await getSettings(db, recipient.id);
  if (dmPolicy === 'nobody') return `@${recipient.handle} isn’t accepting direct messages.`;
  if (dmPolicy === 'following') {
    const follows = await db
      .prepare("SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ? AND state = 'active'")
      .bind(recipient.id, senderId)
      .first();
    if (follows) return null;
    // Replies are allowed once the recipient has written in this conversation themselves.
    if (convId) {
      const wrote = await db
        .prepare('SELECT 1 AS x FROM messages WHERE conversation_id = ? AND sender_id = ? LIMIT 1')
        .bind(convId, recipient.id)
        .first();
      if (wrote) return null;
    }
    return `@${recipient.handle} only accepts messages from people they follow.`;
  }
  return null;
}

/** SQL twin of dmDenial(): 1 when the viewer (?) may send to `o` in conversation `c`. Params: [viewer, viewer, viewer]. */
const canSendSql = `CASE WHEN o.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = o.id) OR (b.blocker_id = o.id AND b.blocked_id = ?))
  AND COALESCE(s.dm_policy, 'following') != 'nobody'
  AND (COALESCE(s.dm_policy, 'following') = 'everyone'
       OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = o.id AND f.followee_id = ? AND f.state = 'active')
       OR EXISTS (SELECT 1 FROM messages mx WHERE mx.conversation_id = c.id AND mx.sender_id = o.id))
  THEN 1 ELSE 0 END`;

interface SummaryRow {
  id: string;
  updated_at: number;
  o_id: string;
  o_handle: string;
  o_display_name: string;
  o_avatar_key: string | null;
  o_is_private: number;
  o_role: UserRow['role'];
  o_status: UserRow['status'];
  unread: number;
  can_send: number;
}

/** Build summaries for conversations the viewer belongs to (non-member ids are silently absent). */
async function summaries(db: D1Like, viewerId: string, ids: string[]): Promise<Map<string, ConversationSummary>> {
  const out = new Map<string, ConversationSummary>();
  if (!ids.length) return out;
  const rows = (
    await db
      .prepare(
        `SELECT c.id, c.updated_at,
                o.id AS o_id, o.handle AS o_handle, o.display_name AS o_display_name, o.avatar_key AS o_avatar_key,
                o.is_private AS o_is_private, o.role AS o_role, o.status AS o_status,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != ? AND m.created_at > me.last_read_at) AS unread,
                ${canSendSql} AS can_send
         FROM conversations c
         JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = ?
         JOIN conversation_members om ON om.conversation_id = c.id AND om.user_id != ?
         JOIN users o ON o.id = om.user_id
         LEFT JOIN user_settings s ON s.user_id = o.id
         WHERE c.id IN (${placeholders(ids.length)})`,
      )
      .bind(viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, ...ids)
      .all<SummaryRow>()
  ).results;
  const last = (
    await db
      .prepare(
        `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at FROM messages m
         WHERE m.id IN (SELECT (SELECT x.id FROM messages x WHERE x.conversation_id = c.id ORDER BY x.id DESC LIMIT 1)
                        FROM conversations c WHERE c.id IN (${placeholders(ids.length)}))`,
      )
      .bind(...ids)
      .all<MessageRow>()
  ).results;
  const lastBy = new Map(last.map((m) => [m.conversation_id, m]));
  for (const r of rows) {
    const lm = lastBy.get(r.id);
    out.set(r.id, {
      id: r.id,
      other: toSummary({
        id: r.o_id,
        handle: r.o_handle,
        display_name: r.o_display_name,
        avatar_key: r.o_avatar_key,
        is_private: r.o_is_private,
        role: r.o_role,
        status: r.o_status,
      }),
      lastMessage: lm ? toMessage(lm) : null,
      unread: Number(r.unread),
      updatedAt: isoReq(r.updated_at),
      canSend: !!r.can_send,
    });
  }
  return out;
}

async function summaryOr404(db: D1Like, viewerId: string, id: string): Promise<ConversationSummary> {
  const s = (await summaries(db, viewerId, [id])).get(id);
  if (!s) throw notFound('Conversation not found.');
  return s;
}

/** The conversation's other member, or 404 when the viewer is not a member. */
async function otherMember(db: D1Like, convId: string, viewerId: string): Promise<UserRow> {
  const isMember = await db
    .prepare('SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .bind(convId, viewerId)
    .first();
  if (!isMember) throw notFound('Conversation not found.');
  const other = await db
    .prepare(
      `SELECT ${USER_COLS} FROM users WHERE id = (SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ? LIMIT 1)`,
    )
    .bind(convId, viewerId)
    .first<UserRow>();
  if (!other) throw notFound('Conversation not found.');
  return other;
}

messageRoutes.get('/conversations', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const cur = decodeCursor(c.req.query('cursor'), isTimeKey);
  const size = LIMITS.pageSize;
  const rows = (
    await db
      .prepare(
        `SELECT c.id, c.updated_at FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.user_id = ? ${cur ? 'AND (c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))' : ''}
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .bind(me.id, ...(cur ? [cur[0], cur[0], cur[1]] : []), size + 1)
      .all<{ id: string; updated_at: number }>()
  ).results;
  const page = rows.slice(0, size);
  const map = await summaries(db, me.id, page.map((r) => r.id));
  const tail = page[page.length - 1];
  const out: Page<ConversationSummary> = {
    items: page.map((r) => map.get(r.id)).filter((s): s is ConversationSummary => !!s),
    nextCursor: rows.length > size ? encodeCursor([tail.updated_at, tail.id]) : null,
  };
  return c.json(out);
});

messageRoutes.post('/conversations', async (c) => {
  const me = requireUser(c);
  await rateLimit(c, 'dm-start', me.id, 30, 600);
  const input = await body(c, z.object({ handle: z.string().trim().min(1, 'Choose someone to message.').max(41) }));
  const db = c.env.DB;
  const other = await getUserByHandle(db, input.handle.replace(/^@/, ''));
  if (!other) throw notFound('User not found.');
  if (other.id === me.id) throw badRequest('You can’t message yourself.');

  const key = pairKey(me.id, other.id);
  const existing = await db.prepare('SELECT id FROM conversations WHERE pair_key = ?').bind(key).first<{ id: string }>();
  const denial = await dmDenial(db, me.id, other, existing?.id ?? null);
  if (denial) throw dmNotAllowed(denial);

  let convId = existing?.id;
  if (!convId) {
    const now = Date.now();
    // INSERT OR IGNORE + lookup by pair_key keeps concurrent "start conversation" calls from creating duplicates.
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO conversations (id, pair_key, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(newId(now), key, now, now),
      db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, last_read_at) SELECT id, ?, 0 FROM conversations WHERE pair_key = ?').bind(me.id, key),
      db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, last_read_at) SELECT id, ?, 0 FROM conversations WHERE pair_key = ?').bind(other.id, key),
    ]);
    convId = (await db.prepare('SELECT id FROM conversations WHERE pair_key = ?').bind(key).first<{ id: string }>())!.id;
  }
  return c.json(await summaryOr404(db, me.id, convId));
});

messageRoutes.get('/conversations/:id', async (c) => {
  const me = requireUser(c);
  return c.json(await summaryOr404(c.env.DB, me.id, c.req.param('id')));
});

messageRoutes.get('/conversations/:id/messages', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const convId = c.req.param('id');
  await otherMember(db, convId, me.id);

  const afterRaw = c.req.query('after');
  if (afterRaw !== undefined) {
    const after = validate(z.string().min(1).max(64), afterRaw);
    const rows = (
      await db
        .prepare('SELECT id, conversation_id, sender_id, body, created_at FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
        .bind(convId, after, AFTER_MAX)
        .all<MessageRow>()
    ).results;
    const out: Page<Message> = { items: rows.map(toMessage), nextCursor: null };
    return c.json(out);
  }

  const before = decodeCursor(c.req.query('cursor'), isString);
  const size = LIMITS.pageSize;
  const rows = (
    await db
      .prepare(
        `SELECT id, conversation_id, sender_id, body, created_at FROM messages
         WHERE conversation_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
      )
      .bind(convId, ...(before ? [before] : []), size + 1)
      .all<MessageRow>()
  ).results;
  const page = rows.slice(0, size);
  const out: Page<Message> = {
    items: page.map(toMessage),
    nextCursor: rows.length > size ? encodeCursor(page[page.length - 1].id) : null,
  };
  return c.json(out);
});

messageRoutes.post('/conversations/:id/messages', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const convId = c.req.param('id');
  const other = await otherMember(db, convId, me.id);
  await rateLimit(c, 'dm', me.id, 60, 600);
  const input = await body(c, messageBodySchema);
  const denial = await dmDenial(db, me.id, other, convId);
  if (denial) throw dmNotAllowed(denial);

  const now = Date.now();
  const msg: MessageRow = { id: newId(now), conversation_id: convId, sender_id: me.id, body: input.body, created_at: now };
  await db.batch([
    db.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(msg.id, msg.conversation_id, msg.sender_id, msg.body, msg.created_at),
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, convId),
    db.prepare('UPDATE conversation_members SET last_read_at = MAX(last_read_at, ?) WHERE conversation_id = ? AND user_id = ?').bind(now, convId, me.id),
  ]);
  return c.json(toMessage(msg), 201);
});

messageRoutes.post('/conversations/:id/read', async (c) => {
  const me = requireUser(c);
  const db = c.env.DB;
  const convId = c.req.param('id');
  await otherMember(db, convId, me.id);
  // Never move the marker backwards, and cover messages stamped in this same millisecond.
  await db
    .prepare(
      `UPDATE conversation_members
       SET last_read_at = MAX(last_read_at, ?, COALESCE((SELECT MAX(created_at) FROM messages WHERE conversation_id = ?), 0))
       WHERE conversation_id = ? AND user_id = ?`,
    )
    .bind(Date.now(), convId, convId, me.id)
    .run();
  return c.json({ ok: true });
});
