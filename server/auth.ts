import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, UserRow } from './env';
import { ApiError } from './http';

// PBKDF2-SHA256. 100k iterations is the maximum Cloudflare Workers' WebCrypto allows.
const ITERATIONS = 100_000;
const SESSION_COOKIE = 'relay_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 12 * 3600 * 1000;

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const b64url = (buf: Uint8Array) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256' || !iter || !salt || !hash) return false;
  const computed = await pbkdf2(password, unb64(salt), Number(iter));
  return timingSafeEqual(computed, unb64(hash));
}

/** A hash of a random password, used to equalise timing when the handle does not exist. */
let dummyHash: Promise<string> | null = null;
export const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomUUID()));

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = await sha256Hex(token);
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, userId, now, now, now + SESSION_TTL_MS, (c.req.header('user-agent') ?? '').slice(0, 200))
    .run();
  if (c.env.HEADER_SESSIONS === 'true') c.header('x-relay-set-session', token);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.env.COOKIE_SECURE !== 'false',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const sid = c.get('sessionId');
  if (sid) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  if (c.env.HEADER_SESSIONS === 'true') c.header('x-relay-set-session', '');
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** Loads the signed-in user (if any) into c.var.user. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  c.set('sessionId', null);
  const token = getCookie(c, SESSION_COOKIE) ?? (c.env.HEADER_SESSIONS === 'true' ? c.req.header('x-relay-session') : undefined);
  if (token && token.length <= 100) {
    const id = await sha256Hex(token);
    const now = Date.now();
    const row = await c.env.DB.prepare(
      `SELECT s.id AS sid, s.expires_at, s.last_seen_at, u.id, u.handle, u.display_name, u.bio, u.avatar_key,
              u.is_private, u.role, u.status, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
      .bind(id)
      .first<UserRow & { sid: string; expires_at: number; last_seen_at: number }>();
    if (row && row.expires_at > now && row.status !== 'deleted') {
      const { sid, expires_at: _e, last_seen_at, ...user } = row;
      c.set('user', user);
      c.set('sessionId', sid);
      if (now - last_seen_at > TOUCH_INTERVAL_MS) {
        await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
          .bind(now, now + SESSION_TTL_MS, sid)
          .run();
      }
    } else if (row) {
      await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
    }
  }
  await next();
};

/**
 * CSRF defence for state-changing requests: require a custom header (which cross-site forms cannot send
 * and cross-origin fetches cannot send without a CORS preflight we never approve) and, when the browser
 * supplies an Origin, require it to match the request's own origin.
 */
export const csrfMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    if (c.req.header('x-relay-client') !== '1') throw new ApiError(403, 'csrf', 'Missing client header.');
    const origin = c.req.header('origin');
    if (origin && origin !== 'null' && origin !== new URL(c.req.url).origin) {
      throw new ApiError(403, 'csrf', 'Cross-origin request rejected.');
    }
  }
  await next();
};
