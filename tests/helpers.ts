import initSqlJs from 'sql.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { SqlJsD1 } from '../server/sqljs-d1';
import type { Env } from '../server/env';

const SQL = await initSqlJs();
const migrationsDir = join(import.meta.dirname, '..', 'migrations');

export function freshEnv(overrides: Partial<Env> = {}): Env & { DB: SqlJsD1 } {
  const db = new SqlJsD1(new SQL.Database());
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
  }
  return { COOKIE_SECURE: 'false', DISABLE_RATE_LIMITS: 'true', ...overrides, DB: db };
}

export interface Res<T = any> {
  status: number;
  body: T;
}

/** A test client with its own cookie jar (one per simulated user). */
export class Client {
  cookie = '';
  constructor(private app: ReturnType<typeof createApp>, private env: Env) {}

  async req<T = any>(method: string, path: string, json?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const h: Record<string, string> = { 'x-relay-client': '1', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (json !== undefined) h['content-type'] = 'application/json';
    const res = await this.app.request(`http://relay.test${path}`, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined }, this.env);
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = set.match(/relay_session=([^;]*)/);
      if (m) this.cookie = m[1] ? `relay_session=${m[1]}` : '';
    }
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body };
  }

  get<T = any>(p: string) { return this.req<T>('GET', p); }
  post<T = any>(p: string, j: unknown = {}) { return this.req<T>('POST', p, j); }
  patch<T = any>(p: string, j: unknown = {}) { return this.req<T>('PATCH', p, j); }
  del<T = any>(p: string) { return this.req<T>('DELETE', p); }
}

export function setup(overrides: Partial<Env> = {}) {
  const env = freshEnv(overrides);
  const app = createApp();
  const client = () => new Client(app, env);
  async function user(handle: string, password = 'correct horse battery') {
    const c = client();
    const r = await c.post('/api/auth/signup', { handle, displayName: handle[0].toUpperCase() + handle.slice(1), password });
    if (r.status !== 201) throw new Error(`signup ${handle} failed: ${JSON.stringify(r.body)}`);
    return Object.assign(c, { id: r.body.user.id as string, handle });
  }
  return { env, app, client, user };
}
