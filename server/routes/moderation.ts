import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Page, Post, Report, ReportReason, Role, UserSummary } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { type D1Like, type D1Stmt, iso, isoReq, newId, placeholders } from '../db';
import type { AppEnv, UserRow } from '../env';
import {
  ApiError,
  badRequest,
  body,
  cleanText,
  decodeCursor,
  encodeCursor,
  forbidden,
  isString,
  notFound,
  requireModerator,
  requireUser,
  validate,
} from '../http';
import { rateLimit } from '../ratelimit';
import { USER_COLS, getUserById, hydratePosts, toSummary } from '../social';

export const moderationRoutes = new Hono<AppEnv>();

const REASONS = ['spam', 'harassment', 'hate', 'violence', 'sexual', 'self_harm', 'impersonation', 'other'] as const satisfies readonly ReportReason[];
const ROLES = ['user', 'moderator', 'admin'] as const satisfies readonly Role[];

const noteSchema = z
  .string()
  .max(4000)
  .transform(cleanText)
  .refine((s) => charCount(s) <= LIMITS.reportDetails.max, `Notes are at most ${LIMITS.reportDetails.max} characters.`)
  .optional();

/** Parse an optional JSON body: an empty body counts as {}. */
async function optionalBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const text = await c.req.text();
  if (!text.trim()) return validate(schema, {});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
  return validate(schema, raw);
}

// ---------------------------------------------------------------------------- reports

moderationRoutes.post('/reports', async (c) => {
  const me = requireUser(c);
  await rateLimit(c, 'report', me.id, 20, 3600);
  const input = await body(
    c,
    z.object({
      targetType: z.enum(['post', 'user']),
      targetId: z.string().trim().min(1).max(64),
      reason: z.enum(REASONS),
      details: z
        .string()
        .max(LIMITS.reportDetails.max * 4)
        .transform(cleanText)
        .refine((s) => charCount(s) <= LIMITS.reportDetails.max, `Details are at most ${LIMITS.reportDetails.max} characters.`)
        .optional(),
    }),
  );
  const db = c.env.DB;
  if (input.targetType === 'post') {
    const post = await db
      .prepare('SELECT author_id FROM posts WHERE id = ? AND deleted_at IS NULL')
      .bind(input.targetId)
      .first<{ author_id: string }>();
    if (!post) throw notFound('Post not found.');
    if (post.author_id === me.id) throw badRequest('You can’t report your own post.');
  } else {
    const target = await getUserById(db, input.targetId);
    if (!target) throw notFound('User not found.');
    if (target.id === me.id) throw badRequest('You can’t report yourself.');
  }
  // reports_once (partial unique index on open reports) makes a repeat report a no-op, even under races.
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO reports (id, reporter_id, target_type, target_id, reason, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId(), me.id, input.targetType, input.targetId, input.reason, input.details ?? '', Date.now())
    .run();
  return c.json({ ok: true }, r.meta.changes > 0 ? 201 : 200);
});

interface ReportRow {
  id: string;
  reporter_id: string;
  target_type: 'post' | 'user';
  target_id: string;
  reason: ReportReason;
  details: string;
  status: Report['status'];
  created_at: number;
  resolution: string | null;
}

async function usersById(db: D1Like, ids: string[]): Promise<Map<string, UserRow>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const out = new Map<string, UserRow>();
  if (!unique.length) return out;
  const rows = (
    await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id IN (${placeholders(unique.length)})`).bind(...unique).all<UserRow>()
  ).results;
  for (const r of rows) out.set(r.id, r);
  return out;
}

/**
 * Posts as a moderator needs to see them: hydrated for the moderator, but with the real author and body even when
 * the author is private, suspended or has blocked the moderator. Deleted posts stay empty placeholders.
 */
async function moderatorPostSnapshots(db: D1Like, modId: string, ids: string[]): Promise<Map<string, Post>> {
  const map = await hydratePosts(db, modId, ids);
  const unique = [...map.keys()];
  if (!unique.length) return map;
  const raw = (
    await db
      .prepare(
        `SELECT p.id, p.body, p.edited_at, p.deleted_at, u.id AS u_id, u.handle, u.display_name, u.avatar_key, u.is_private, u.role, u.status
         FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id IN (${placeholders(unique.length)})`,
      )
      .bind(...unique)
      .all<{ id: string; body: string; edited_at: number | null; deleted_at: number | null; u_id: string } & Omit<UserRow, 'id'>>()
  ).results;
  for (const r of raw) {
    const p = map.get(r.id);
    if (!p) continue;
    p.author = toSummary({ ...r, id: r.u_id });
    p.unavailable = false;
    if (!r.deleted_at) {
      p.body = r.body;
      p.editedAt = iso(r.edited_at);
    }
  }
  return map;
}

moderationRoutes.get('/mod/reports', async (c) => {
  const mod = requireModerator(c);
  const db = c.env.DB;
  const status = validate(z.enum(['open', 'actioned', 'dismissed']).default('open'), c.req.query('status') || undefined);
  const before = decodeCursor(c.req.query('cursor'), isString);
  const size = LIMITS.pageSize;
  const rows = (
    await db
      .prepare(
        `SELECT id, reporter_id, target_type, target_id, reason, details, status, created_at, resolution FROM reports
         WHERE status = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
      )
      .bind(status, ...(before ? [before] : []), size + 1)
      .all<ReportRow>()
  ).results;
  const page = rows.slice(0, size);

  const postIds = page.filter((r) => r.target_type === 'post').map((r) => r.target_id);
  const posts = await moderatorPostSnapshots(db, mod.id, postIds);
  const postAuthors = new Map<string, string>();
  if (postIds.length) {
    const pa = (
      await db
        .prepare(`SELECT id, author_id FROM posts WHERE id IN (${placeholders(postIds.length)})`)
        .bind(...postIds)
        .all<{ id: string; author_id: string }>()
    ).results;
    for (const r of pa) postAuthors.set(r.id, r.author_id);
  }
  const users = await usersById(db, [
    ...page.map((r) => r.reporter_id),
    ...page.filter((r) => r.target_type === 'user').map((r) => r.target_id),
    ...postAuthors.values(),
  ]);

  const items: Report[] = [];
  for (const r of page) {
    const reporter = users.get(r.reporter_id);
    if (!reporter) continue;
    // For post reports, targetUser is the post's author so moderators can see who a suspension would affect.
    const targetUserId = r.target_type === 'user' ? r.target_id : postAuthors.get(r.target_id);
    const targetUser = targetUserId ? users.get(targetUserId) : undefined;
    items.push({
      id: r.id,
      reporter: toSummary(reporter),
      targetType: r.target_type,
      targetId: r.target_id,
      targetPost: r.target_type === 'post' ? (posts.get(r.target_id) ?? null) : null,
      targetUser: targetUser ? toSummary(targetUser) : null,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: isoReq(r.created_at),
      resolution: r.resolution,
    });
  }
  const out: Page<Report> = { items, nextCursor: rows.length > size ? encodeCursor(page[page.length - 1].id) : null };
  return c.json(out);
});

// ---------------------------------------------------------------------------- actions

/** Moderators may act on regular users only; admins on anyone but themselves. */
function assertCanSanction(mod: UserRow, target: UserRow) {
  if (target.id === mod.id) throw forbidden('You can’t do that to your own account.');
  if (mod.role !== 'admin' && target.role !== 'user') throw forbidden('Only admins can act on moderators and admins.');
}

function logAction(db: D1Like, modId: string, action: string, targetUserId: string | null, targetPostId: string | null, note: string): D1Stmt {
  return db
    .prepare('INSERT INTO moderation_actions (id, moderator_id, target_user_id, target_post_id, action, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), modId, targetUserId, targetPostId, action, note, Date.now());
}

function suspendStmts(db: D1Like, userId: string): D1Stmt[] {
  return [
    db.prepare("UPDATE users SET status = 'suspended' WHERE id = ? AND status = 'active'").bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
  ];
}

function resolveStmt(db: D1Like, targetType: 'post' | 'user', targetId: string, status: 'actioned' | 'dismissed', modId: string, resolution: string): D1Stmt {
  return db
    .prepare(
      `UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, resolution = ?
       WHERE target_type = ? AND target_id = ? AND status = 'open'`,
    )
    .bind(status, modId, Date.now(), resolution, targetType, targetId);
}

moderationRoutes.post('/mod/reports/:id/resolve', async (c) => {
  const mod = requireModerator(c);
  const db = c.env.DB;
  const input = await body(c, z.object({ action: z.enum(['dismiss', 'remove_post', 'suspend_user']), note: noteSchema }));
  const note = input.note ?? '';
  const report = await db
    .prepare('SELECT id, target_type, target_id, status FROM reports WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; target_type: 'post' | 'user'; target_id: string; status: Report['status'] }>();
  if (!report) throw notFound('Report not found.');
  if (report.status !== 'open') throw new ApiError(409, 'already_resolved', 'This report has already been resolved.');

  let postId: string | null = null;
  let target: UserRow | null = null;
  if (report.target_type === 'post') {
    const post = await db.prepare('SELECT id, author_id FROM posts WHERE id = ?').bind(report.target_id).first<{ id: string; author_id: string }>();
    postId = post?.id ?? null;
    if (post) target = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(post.author_id).first<UserRow>();
  } else {
    target = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(report.target_id).first<UserRow>();
  }

  const resolution = note ? `${input.action}: ${note}` : input.action;
  const stmts: D1Stmt[] = [];
  if (input.action === 'remove_post') {
    if (report.target_type !== 'post') throw badRequest('Only post reports can remove a post.');
    if (!postId) throw notFound('Post not found.');
    stmts.push(
      db.prepare("UPDATE posts SET body = '', deleted_at = COALESCE(deleted_at, ?), removed_by_mod = 1 WHERE id = ?").bind(Date.now(), postId),
      logAction(db, mod.id, 'remove_post', target?.id ?? null, postId, note),
      resolveStmt(db, 'post', report.target_id, 'actioned', mod.id, resolution),
    );
  } else if (input.action === 'suspend_user') {
    if (!target || target.status === 'deleted') throw notFound('User not found.');
    assertCanSanction(mod, target);
    stmts.push(
      ...suspendStmts(db, target.id),
      logAction(db, mod.id, 'suspend_user', target.id, postId, note),
      resolveStmt(db, report.target_type, report.target_id, 'actioned', mod.id, resolution),
    );
    // Open reports about the suspended account itself are settled by the same action.
    if (report.target_type === 'post') stmts.push(resolveStmt(db, 'user', target.id, 'actioned', mod.id, resolution));
  } else {
    stmts.push(
      logAction(db, mod.id, 'dismiss_report', target?.id ?? null, postId, note),
      resolveStmt(db, report.target_type, report.target_id, 'dismissed', mod.id, resolution),
    );
  }
  await db.batch(stmts);
  return c.json({ ok: true });
});

async function sanctionTarget(c: Context<AppEnv>, mod: UserRow): Promise<UserRow> {
  const target = await getUserById(c.env.DB, c.req.param('id') ?? '');
  if (!target) throw notFound('User not found.');
  assertCanSanction(mod, target);
  return target;
}

moderationRoutes.post('/mod/users/:id/suspend', async (c) => {
  const mod = requireModerator(c);
  const { note } = await optionalBody(c, z.object({ note: noteSchema }));
  const target = await sanctionTarget(c, mod);
  const db = c.env.DB;
  await db.batch([...suspendStmts(db, target.id), logAction(db, mod.id, 'suspend_user', target.id, null, note ?? '')]);
  return c.json({ ok: true });
});

moderationRoutes.post('/mod/users/:id/unsuspend', async (c) => {
  const mod = requireModerator(c);
  const { note } = await optionalBody(c, z.object({ note: noteSchema }));
  const target = await sanctionTarget(c, mod);
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'suspended'").bind(target.id),
    logAction(db, mod.id, 'unsuspend_user', target.id, null, note ?? ''),
  ]);
  return c.json({ ok: true });
});

moderationRoutes.post('/mod/users/:id/role', async (c) => {
  const mod = requireModerator(c);
  if (mod.role !== 'admin') throw forbidden('Only admins can change roles.');
  const input = await body(c, z.object({ role: z.enum(ROLES), note: noteSchema }));
  const db = c.env.DB;
  const target = await getUserById(db, c.req.param('id'));
  if (!target) throw notFound('User not found.');
  if (target.id === mod.id) throw forbidden('You can’t change your own role.');
  const note = input.note ? `role ${target.role} → ${input.role}: ${input.note}` : `role ${target.role} → ${input.role}`;
  await db.batch([
    db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(input.role, target.id),
    logAction(db, mod.id, 'set_role', target.id, null, note),
  ]);
  return c.json({ ok: true });
});

interface ActionRow {
  id: string;
  moderator_id: string;
  target_user_id: string | null;
  target_post_id: string | null;
  action: string;
  note: string;
  created_at: number;
}

moderationRoutes.get('/mod/actions', async (c) => {
  requireModerator(c);
  const db = c.env.DB;
  const before = decodeCursor(c.req.query('cursor'), isString);
  const size = LIMITS.pageSize;
  const rows = (
    await db
      .prepare(`SELECT * FROM moderation_actions ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`)
      .bind(...(before ? [before] : []), size + 1)
      .all<ActionRow>()
  ).results;
  const page = rows.slice(0, size);
  const users = await usersById(db, page.flatMap((r) => [r.moderator_id, r.target_user_id ?? '']));
  const items: {
    id: string;
    moderator: UserSummary;
    action: string;
    note: string;
    targetUser: UserSummary | null;
    targetPostId: string | null;
    createdAt: string;
  }[] = [];
  for (const r of page) {
    const m = users.get(r.moderator_id);
    if (!m) continue;
    const t = r.target_user_id ? users.get(r.target_user_id) : undefined;
    items.push({
      id: r.id,
      moderator: toSummary(m),
      action: r.action,
      note: r.note,
      targetUser: t ? toSummary(t) : null,
      targetPostId: r.target_post_id,
      createdAt: isoReq(r.created_at),
    });
  }
  return c.json({ items, nextCursor: rows.length > size ? encodeCursor(page[page.length - 1].id) : null });
});
