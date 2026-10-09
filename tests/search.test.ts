import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { newId } from '../server/db';
import type { Env } from '../server/env';

// Direct-DB fixtures so these tests don't depend on the posts/users routes.
function fixtures(env: Env) {
  const db = env.DB;
  return {
    async post(authorId: string, body: string) {
      const id = newId();
      await db.prepare('INSERT INTO posts (id, author_id, body, reply_to_id, root_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
        .bind(id, authorId, body, id, Date.now()).run();
      return id;
    },
    async user(handle: string, displayName = handle) {
      const id = newId();
      await db.prepare("INSERT INTO users (id, handle, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)")
        .bind(id, handle, displayName, Date.now()).run();
      await db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').bind(id).run();
      return id;
    },
    follow: (a: string, b: string) =>
      db.prepare("INSERT INTO follows (follower_id, followee_id, state, created_at) VALUES (?, ?, 'active', ?)").bind(a, b, Date.now()).run(),
    block: (a: string, b: string) => db.prepare('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').bind(a, b, Date.now()).run(),
    mute: (a: string, b: string) => db.prepare('INSERT INTO mutes (muter_id, muted_id, created_at) VALUES (?, ?, ?)').bind(a, b, Date.now()).run(),
    setPrivate: (id: string) => db.prepare('UPDATE users SET is_private = 1 WHERE id = ?').bind(id).run(),
    suspend: (id: string) => db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(id).run(),
    mutedWords: (id: string, words: string[]) =>
      db.prepare('UPDATE user_settings SET muted_words = ? WHERE user_id = ?').bind(JSON.stringify(words), id).run(),
  };
}

const q = (s: string) => encodeURIComponent(s);

describe('search', () => {
  it('validates q length (422) and type', async () => {
    const { user } = setup();
    const a = await user('alice');
    expect((await a.get('/api/search?q=a&type=posts')).status).toBe(422);
    expect((await a.get('/api/search?type=users')).status).toBe(422);
    expect((await a.get(`/api/search?q=${'x'.repeat(65)}&type=posts`)).status).toBe(422);
    const r = await a.get('/api/search?q=   a  &type=users');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('validation_failed');
    expect((await a.get('/api/search?q=hello&type=bogus')).status).toBe(422);
  });

  it('escapes LIKE wildcards so % and _ match literally', async () => {
    const { env, user } = setup();
    const a = await user('alice');
    const f = fixtures(env);
    const pct = await f.post(a.id, 'I am 100% sure about this');
    await f.post(a.id, 'plain text here');
    const under = await f.post(a.id, 'snake a_b case');
    await f.post(a.id, 'snake axb case');

    const all = await a.get(`/api/search?q=${q('%%')}&type=posts`);
    expect(all.status).toBe(200);
    expect(all.body.items).toEqual([]);

    const p = await a.get(`/api/search?q=${q('0%')}&type=posts`);
    expect(p.body.items.map((x: any) => x.id)).toEqual([pct]);

    const u = await a.get(`/api/search?q=${q('a_b')}&type=posts`);
    expect(u.body.items.map((x: any) => x.id)).toEqual([under]);

    const users = await a.get(`/api/search?q=${q('__')}&type=users`);
    expect(users.body.items).toEqual([]);
  });

  it('never returns private-account posts, even to approved followers', async () => {
    const { env, user } = setup();
    const a = await user('alice');
    const f = fixtures(env);
    const priv = await f.user('privy');
    await f.setPrivate(priv);
    await f.follow(a.id, priv);
    await f.post(priv, 'secret pineapple recipe');
    const pub = await f.post(a.id, 'pineapple on pizza is fine');
    const r = await a.get('/api/search?q=pineapple&type=posts');
    expect(r.body.items.map((x: any) => x.id)).toEqual([pub]);
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });

  it('excludes blocked users (either direction), muted users, suspended users and deleted posts', async () => {
    const { env, user } = setup();
    const a = await user('alice');
    const f = fixtures(env);
    const blocker = await f.user('zed_blocker', 'Zed Blocker');
    const blocked = await f.user('zed_blocked', 'Zed Blocked');
    const muted = await f.user('zed_muted', 'Zed Muted');
    const susp = await f.user('zed_susp', 'Zed Suspended');
    const ok = await f.user('zed_ok', 'Zed Ok');
    await f.block(blocker, a.id);
    await f.block(a.id, blocked);
    await f.mute(a.id, muted);
    await f.suspend(susp);
    for (const id of [blocker, blocked, muted, susp, ok]) await f.post(id, 'zebra crossing');
    const del = await f.post(ok, 'zebra deleted');
    await env.DB.prepare("UPDATE posts SET body = '', deleted_at = ? WHERE id = ?").bind(Date.now(), del).run();

    const users = await a.get('/api/search?q=zed&type=users');
    expect(users.body.items.map((u: any) => u.handle)).toEqual(['zed_ok']);

    const posts = await a.get('/api/search?q=zebra&type=posts');
    expect(posts.body.items.map((p: any) => p.author.handle)).toEqual(['zed_ok']);
    expect(posts.body.items[0].body).toBe('zebra crossing');
  });

  it('filters muted words from post results', async () => {
    const { env, user } = setup();
    const a = await user('alice');
    const f = fixtures(env);
    await f.post(a.id, 'weather today: spoilers ahead');
    const keep = await f.post(a.id, 'weather today is sunny');
    await f.mutedWords(a.id, ['spoilers']);
    const r = await a.get('/api/search?q=weather&type=posts');
    expect(r.body.items.map((p: any) => p.id)).toEqual([keep]);
  });

  it('matches handle prefix or display-name substring; leading @ searches handles only', async () => {
    const { env, user } = setup();
    const a = await user('alice');
    const f = fixtures(env);
    await f.user('marco', 'Marco Polo');
    await f.user('explorer', 'Not Marco');
    await f.user('amarcord', 'Film');
    const both = await a.get('/api/search?q=marco&type=users');
    expect(both.body.items.map((u: any) => u.handle).sort()).toEqual(['explorer', 'marco']);
    const handles = await a.get(`/api/search?q=${q('@marco')}&type=users`);
    expect(handles.body.items.map((u: any) => u.handle)).toEqual(['marco']);
  });

  it('paginates users by handle and posts newest first without duplicates', async () => {
    const { env, user, client } = setup();
    const a = await user('alice');
    const f = fixtures(env);
    for (let i = 0; i < 30; i++) await f.user(`kiwi${String(i).padStart(2, '0')}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await a.get(`/api/search?q=kiwi&type=users${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((u: any) => u.handle));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(30);
    expect(seen).toEqual([...seen].sort());

    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await f.post(a.id, `mango number ${i}`));
    // Signed-out search works too (public posts only).
    const anon = client();
    const p1 = await anon.get('/api/search?q=mango&type=posts');
    expect(p1.body.items).toHaveLength(25);
    expect(p1.body.items[0].id).toBe(ids[29]);
    const p2 = await anon.get(`/api/search?q=mango&type=posts&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((p: any) => p.id)).toEqual(ids.slice(0, 5).reverse());
    expect(p2.body.nextCursor).toBeNull();
    expect((await anon.get('/api/search?q=mango&type=posts&cursor=%%%')).status).toBe(400);
  });

  it('rate-limits to 60 searches per minute', async () => {
    const { user } = setup({ DISABLE_RATE_LIMITS: 'false' });
    const a = await user('alice');
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await a.get('/api/search?q=hello&type=posts')).status;
    expect(last).toBe(429);
  });
});
