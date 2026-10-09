import type { Context } from 'hono';
import type { AppEnv } from './env';
import { ApiError } from './http';

/**
 * Fixed-window rate limit backed by D1. Good enough to blunt abuse on a single-region D1;
 * swap for Cloudflare's Rate Limiting binding when scaling out.
 */
export async function rateLimit(c: Context<AppEnv>, bucket: string, subject: string, limit: number, windowSec: number) {
  if (c.env.DISABLE_RATE_LIMITS === 'true') return;
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const windowStart = now - (now % windowMs);
  const key = `${bucket}:${subject}`;
  const row = await c.env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  if (row && row.count > limit) {
    const retry = Math.ceil((windowStart + windowMs - now) / 1000);
    c.header('Retry-After', String(retry));
    throw new ApiError(429, 'rate_limited', `Too many requests. Try again in ${retry < 90 ? `${retry}s` : `${Math.ceil(retry / 60)} min`}.`);
  }
}

export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';
}

/** Rate-limit subject for the current request: user id when signed in, otherwise IP. */
export function subjectOf(c: Context<AppEnv>): string {
  return c.get('user')?.id ?? `ip:${clientIp(c)}`;
}
