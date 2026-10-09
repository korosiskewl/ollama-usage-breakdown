import type { D1Like } from './db';

/** Subset of an R2 bucket binding used for media. */
export interface MediaBucket {
  put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
}

export interface Env {
  DB: D1Like;
  MEDIA?: MediaBucket;
  /** Comma-separated handles that are granted the admin role at signup / login. */
  ADMIN_HANDLES?: string;
  /** "true" makes the first signup an admin when no admin exists (used by the local preview). */
  FIRST_USER_ADMIN?: string;
  ANTHROPIC_API_KEY?: string;
  AI_MODEL?: string;
  /** "false" drops the Secure cookie attribute (plain-http local dev only). */
  COOKIE_SECURE?: string;
  /**
   * "true" lets the session token travel in x-relay-session / x-relay-set-session headers instead of cookies.
   * Only the in-browser preview sets this: JS-constructed Requests/Responses cannot carry Cookie headers.
   * Never enable it on a real deployment.
   */
  HEADER_SESSIONS?: string;
  /** "true" disables rate limiting (tests and the single-user local preview only). */
  DISABLE_RATE_LIMITS?: string;
}

export interface UserRow {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_key: string | null;
  is_private: number;
  role: 'user' | 'moderator' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
  created_at: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: UserRow | null; sessionId: string | null };
};
