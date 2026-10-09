import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('auth', () => {
  it('signs up, reads /me, logs out and back in', async () => {
    const { client } = setup();
    const c = client();
    const s = await c.post('/api/auth/signup', { handle: 'ada', displayName: 'Ada', password: 'correct horse battery' });
    expect(s.status).toBe(201);
    expect(s.body.user.handle).toBe('ada');
    expect(JSON.stringify(s.body)).not.toContain('pbkdf2');
    expect((await c.get('/api/auth/me')).body.user.handle).toBe('ada');
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).body.user).toBeNull();
    const bad = await c.post('/api/auth/login', { handle: 'ada', password: 'wrong password!!' });
    expect(bad.status).toBe(401);
    const ok = await c.post('/api/auth/login', { handle: 'ADA', password: 'correct horse battery' });
    expect(ok.status).toBe(200);
  });

  it('stores only hashed passwords and hashed session ids', async () => {
    const { client, env } = setup();
    const c = client();
    await c.post('/api/auth/signup', { handle: 'bob', displayName: 'Bob', password: 'correct horse battery' });
    const u = await env.DB.prepare('SELECT password_hash FROM users').first<{ password_hash: string }>();
    expect(u!.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    const s = await env.DB.prepare('SELECT id FROM sessions').first<{ id: string }>();
    expect(c.cookie).not.toContain(s!.id);
  });

  it('validates signup input and rejects duplicate handles case-insensitively', async () => {
    const { client } = setup();
    const c = client();
    const r = await c.post('/api/auth/signup', { handle: 'a!', displayName: '', password: 'short' });
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.error.fields)).toEqual(expect.arrayContaining(['handle', 'displayName', 'password']));
    await c.post('/api/auth/signup', { handle: 'carol', displayName: 'C', password: 'correct horse battery' });
    const dup = await client().post('/api/auth/signup', { handle: 'Carol', displayName: 'C', password: 'correct horse battery' });
    expect(dup.status).toBe(409);
  });

  it('rejects state-changing requests without the client header (CSRF)', async () => {
    const { app, env } = setup();
    const res = await app.request('http://relay.test/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'eve', displayName: 'Eve', password: 'correct horse battery' }),
    }, env);
    expect(res.status).toBe(403);
    const cross = await app.request('http://relay.test/api/auth/logout', {
      method: 'POST',
      headers: { 'x-relay-client': '1', origin: 'https://evil.example' },
    }, env);
    expect(cross.status).toBe(403);
  });

  it('rate-limits login attempts per handle', async () => {
    const { client } = setup({ DISABLE_RATE_LIMITS: 'false' });
    const c = client();
    await c.post('/api/auth/signup', { handle: 'dan', displayName: 'Dan', password: 'correct horse battery' });
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await client().post('/api/auth/login', { handle: 'dan', password: 'nope nope nope' })).status;
    expect(last).toBe(429);
  });

  it('password change revokes other sessions', async () => {
    const { client, user } = setup();
    const a = await user('fay');
    const other = client();
    await other.post('/api/auth/login', { handle: 'fay', password: 'correct horse battery' });
    const r = await a.post('/api/auth/password', { currentPassword: 'correct horse battery', newPassword: 'a whole new passphrase' });
    expect(r.status).toBe(200);
    expect((await other.get('/api/auth/me')).body.user).toBeNull();
    expect((await a.get('/api/auth/me')).body.user.handle).toBe('fay');
  });

  it('first user becomes admin only when FIRST_USER_ADMIN is set', async () => {
    const a = setup({ FIRST_USER_ADMIN: 'true' });
    expect((await (await a.user('first')).get('/api/auth/me')).body.user.role).toBe('admin');
    expect((await (await a.user('second')).get('/api/auth/me')).body.user.role).toBe('user');
    const b = setup();
    expect((await (await b.user('first')).get('/api/auth/me')).body.user.role).toBe('user');
  });
});
