import { Hono } from 'hono';
import { z } from 'zod';
import type { Page, Post, UserSummary } from '../../shared/types';
import { LIMITS } from '../../shared/limits';
import type { AppEnv, UserRow } from '../env';
import { ApiError, decodeCursor, encodeCursor, isString, validate } from '../http';
import { rateLimit, subjectOf } from '../ratelimit';
import { getSettings, hydrateList, matchesMutedWords, notMutedSql, toSummary, visibleAuthorSql } from '../social';

export const searchRoutes = new Hono<AppEnv>();

/** Escape LIKE wildcards so user input is matched literally (used with ESCAPE '\'). */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const querySchema = z.object({
  q: z
    .string()
    .trim()
    .min(LIMITS.search.min, `Search for at least ${LIMITS.search.min} characters.`)
    .max(LIMITS.search.max, `Search for at most ${LIMITS.search.max} characters.`),
  type: z.enum(['users', 'posts']).default('posts'),
});

const SCAN_BATCH = 100;
const MAX_SCAN_ROUNDS = 4;

searchRoutes.get('/search', async (c) => {
  const viewer = c.get('user');
  if (viewer?.status === 'suspended') throw new ApiError(403, 'suspended', 'This account is suspended.');
  await rateLimit(c, 'search', subjectOf(c), 60, 60);
  const input = validate(querySchema, { q: c.req.query('q') ?? '', type: c.req.query('type') || undefined });
  const db = c.env.DB;
  const viewerId = viewer?.id ?? null;
  const size = LIMITS.pageSize;

  if (input.type === 'users') {
    const handleOnly = input.q.startsWith('@');
    const term = (handleOnly ? input.q.slice(1) : input.q).trim();
    if (!term) throw new ApiError(422, 'validation_failed', 'Type a handle after @.', { q: 'Type a handle after @.' });
    const after = decodeCursor(c.req.query('cursor'), isString);
    const esc = likeEscape(term);
    const muted = notMutedSql('u', viewerId);
    const where: string[] = ["u.status = 'active'"];
    const params: unknown[] = [];
    if (handleOnly) {
      where.push("u.handle LIKE ? ESCAPE '\\'");
      params.push(`${esc}%`);
    } else {
      where.push("(u.handle LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')");
      params.push(`${esc}%`, `%${esc}%`);
    }
    if (viewerId) {
      where.push(
        'NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?))',
        muted.sql,
      );
      params.push(viewerId, viewerId, ...muted.params);
    }
    if (after) {
      // handle is COLLATE NOCASE, so this comparison and the ORDER BY share one ordering.
      where.push('u.handle > ?');
      params.push(after);
    }
    const rows = (
      await db
        .prepare(
          `SELECT u.id, u.handle, u.display_name, u.avatar_key, u.is_private, u.role, u.status FROM users u
           WHERE ${where.join(' AND ')} ORDER BY u.handle LIMIT ?`,
        )
        .bind(...params, size + 1)
        .all<UserRow>()
    ).results;
    const page = rows.slice(0, size);
    const out: Page<UserSummary> = {
      items: page.map(toSummary),
      nextCursor: rows.length > size ? encodeCursor(page[page.length - 1].handle) : null,
    };
    return c.json(out);
  }

  // Posts: public-only by policy. Private accounts' posts never appear in search, even to approved followers.
  const startCursor = decodeCursor(c.req.query('cursor'), isString);
  const vis = visibleAuthorSql('u', viewerId);
  const muted = notMutedSql('u', viewerId);
  const mutedWords = viewerId ? (await getSettings(db, viewerId)).mutedWords : [];
  const pattern = `%${likeEscape(input.q)}%`;

  const ids: string[] = [];
  let next: string | null = null;
  let before = startCursor;
  scan: for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
    const rows = (
      await db
        .prepare(
          `SELECT p.id, p.body FROM posts p JOIN users u ON u.id = p.author_id
           WHERE p.deleted_at IS NULL AND u.is_private = 0 AND ${vis.sql} AND ${muted.sql}
             AND p.body LIKE ? ESCAPE '\\' ${before ? 'AND p.id < ?' : ''}
           ORDER BY p.id DESC LIMIT ?`,
        )
        .bind(...vis.params, ...muted.params, pattern, ...(before ? [before] : []), SCAN_BATCH)
        .all<{ id: string; body: string }>()
    ).results;
    for (const r of rows) {
      if (matchesMutedWords(r.body, mutedWords)) continue;
      ids.push(r.id);
      if (ids.length === size) {
        next = r.id;
        break scan;
      }
    }
    if (rows.length < SCAN_BATCH) {
      next = null;
      break;
    }
    before = rows[rows.length - 1].id;
    next = before; // resume from here if we run out of scan rounds
  }
  const posts = (await hydrateList(db, viewerId, ids)).filter((p) => !p.unavailable && !p.deleted);
  const out: Page<Post> = { items: posts, nextCursor: next ? encodeCursor(next) : null };
  return c.json(out);
});
