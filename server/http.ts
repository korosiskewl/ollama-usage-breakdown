import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv, UserRow } from './env';

export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) => new ApiError(400, 'bad_request', message, fields);
export const notFound = (what = 'Not found') => new ApiError(404, 'not_found', what);
export const forbidden = (message = 'You do not have permission to do that.') => new ApiError(403, 'forbidden', message);
export const unauthorized = () => new ApiError(401, 'unauthorized', 'Sign in to continue.');

/** Parse and validate a JSON body. Field errors are returned as { fields: { name: message } }. */
export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
  return validate(schema, raw);
}

export function validate<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const issue of r.error.issues) {
      const k = issue.path.join('.') || '_';
      if (!fields[k]) fields[k] = issue.message;
    }
    throw new ApiError(422, 'validation_failed', Object.values(fields)[0] ?? 'Invalid input.', fields);
  }
  return r.data;
}

/** Current user or throw 401. Suspended accounts are rejected for every authenticated action. */
export function requireUser(c: Context<AppEnv>): UserRow {
  const u = c.get('user');
  if (!u) throw unauthorized();
  if (u.status === 'suspended') throw new ApiError(403, 'suspended', 'This account is suspended.');
  return u;
}

export function requireModerator(c: Context<AppEnv>): UserRow {
  const u = requireUser(c);
  if (u.role !== 'moderator' && u.role !== 'admin') throw forbidden();
  return u;
}

export const authed: MiddlewareHandler<AppEnv> = async (c, next) => {
  requireUser(c);
  await next();
};

// Opaque cursors: base64url(JSON). Never trust their contents beyond type checks.
export function encodeCursor(v: unknown): string {
  return btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor<T>(raw: string | undefined, check: (v: unknown) => v is T): T | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
    if (check(v)) return v;
  } catch {
    /* fall through */
  }
  throw badRequest('Invalid cursor.');
}

export const isString = (v: unknown): v is string => typeof v === 'string' && v.length < 200;
export const isTimeKey = (v: unknown): v is [number, string] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'string' && v[1].length < 200;

/** Read a positive page size from ?limit=, capped. */
export function pageSize(c: Context, def = 25, max = 50): number {
  const n = Number(c.req.query('limit'));
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}

/** Collapse runs of whitespace that would break layout and trim; keeps single newlines and paragraph breaks. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    // strip control chars except \n and \t
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
