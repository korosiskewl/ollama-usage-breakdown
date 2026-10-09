import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { newId } from '../server/db';
import type { Env } from '../server/env';
import type { NotificationType } from '../shared/types';

// Direct-DB fixtures so these tests don't depend on the posts/users routes.
function fixtures(env: Env) {
  const db = env.DB;
  let clock = Date.now() - 1_000_000;
  return {
    async post(authorId: string, body: string) {
      const id = newId();
      await db.prepare('INSERT INTO posts (id, author_id, body, reply_to_id, root_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
        .bind(id, authorId, body, id, Date.now()).run();
      return id;
    },
    async user(handle: string) {
      const id = newId();
      await db.prepare("INSERT INTO users (id, handle, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)")
        .bind(id, handle, handle, Date.now()).run();
      return id;
    },
    /** Insert a notification with a strictly increasing timestamp (so ids sort in insertion order). */
    async notif(userId: string, actorId: string, type: NotificationType, postId: string | null = null, read = false) {
      clock += 1000;
      const id = newId(clock);
      await db.prepare('INSERT INTO notifications (id, user_id, actor_id, type, post_id, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, userId, actorId, type, postId, clock, read ? clock : null).run();
      return id;
    },
    block: (a: string, b: string) => db.prepare('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').bind(a, b, Date.now()).run(),
    mute: (a: string, b: string) => db.prepare('INSERT INTO mutes (muter_id, muted_id, created_at) VALUES (?, ?, ?)').bind(a, b, Date.now()).run(),
  };
}

describe('notifications', () => {
  it('requires sign-in', async () => {
    const { client } = setup();
    expect((await client().get('/api/notifications')).status).toBe(401);
    expect((await client().post('/api/notifications/read')).status).toBe(401);
  });

  it('groups adjacent likes/reposts on the same post and adjacent follows', async () => {
    const { env, user } = setup();
    const alice = await user('alice');
    const f = fixtures(env);
    const bob = await f.user('bob');
    const carol = await f.user('carol');
    const dave = await f.user('dave');
    const p1 = await f.post(alice.id, 'first post');
    const p2 = await f.post(alice.id, 'second post');
    const reply = await f.post(bob, '@alice nice');

    await f.notif(alice.id, bob, 'like', p1, true);
    await f.notif(alice.id, carol, 'like', p1);
    const newestLike = await f.notif(alice.id, dave, 'like', p1);
    await f.notif(alice.id, bob, 'follow', null, true);
    await f.notif(alice.id, carol, 'follow', null, true);
    await f.notif(alice.id, bob, 'reply', reply);
    await f.notif(alice.id, carol, 'repost', p1);
    await f.notif(alice.id, carol, 'like', p2);

    const r = await alice.get('/api/notifications');
    expect(r.status).toBe(200);
    const items = r.body.items;
    expect(items.map((g: any) => g.type)).toEqual(['like', 'repost', 'reply', 'follow', 'like']);
    const [likeP2, repost, replyG, follows, likesP1] = items;
    expect(likeP2.post.id).toBe(p2);
    expect(repost.post.id).toBe(p1);
    expect(replyG.post.body).toBe('@alice nice');
    expect(follows.actors.map((a: any) => a.handle)).toEqual(['carol', 'bob']);
    expect(follows.actorCount).toBe(2);
    expect(follows.read).toBe(true);
    expect(follows.post).toBeNull();
    expect(likesP1.id).toBe(newestLike);
    expect(likesP1.actors.map((a: any) => a.handle)).toEqual(['dave', 'carol', 'bob']);
    expect(likesP1.actorCount).toBe(3);
    expect(likesP1.read).toBe(false); // only one of three was read
    expect(likesP1.post.body).toBe('first post');
    expect(r.body.nextCursor).toBeNull();

    expect((await alice.get('/api/me/unread')).body.notifications).toBe(5);
    expect((await alice.post('/api/notifications/read')).body).toEqual({ ok: true });
    expect((await alice.get('/api/me/unread')).body.notifications).toBe(0);
    const after = await alice.get('/api/notifications');
    expect(after.body.items.every((g: any) => g.read)).toBe(true);
  });

  it('caps actors at 5 newest while counting all of them', async () => {
    const { env, user } = setup();
    const alice = await user('alice');
    const f = fixtures(env);
    const p = await f.post(alice.id, 'popular');
    const handles: string[] = [];
    for (let i = 0; i < 7; i++) {
      const h = `fan${i}`;
      handles.push(h);
      await f.notif(alice.id, await f.user(h), 'like', p);
    }
    const r = await alice.get('/api/notifications');
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].actorCount).toBe(7);
    expect(r.body.items[0].actors.map((a: any) => a.handle)).toEqual(handles.slice(2).reverse());
  });

  it('skips muted, blocked (either way) and suspended actors, and deleted or invisible posts', async () => {
    const { env, user } = setup();
    const alice = await user('alice');
    const f = fixtures(env);
    const ok = await f.user('okay');
    const muted = await f.user('muted');
    const blocked = await f.user('blocked');
    const blocker = await f.user('blocker');
    const susp = await f.user('susp');
    const priv = await f.user('privy');
    const p = await f.post(alice.id, 'hello');
    const gone = await f.post(alice.id, 'to be deleted');
    const privPost = await f.post(priv, '@alice secret mention');
    await env.DB.prepare('UPDATE users SET is_private = 1 WHERE id = ?').bind(priv).run();
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(susp).run();
    await env.DB.prepare("UPDATE posts SET body = '', deleted_at = ? WHERE id = ?").bind(Date.now(), gone).run();
    await f.mute(alice.id, muted);
    await f.block(alice.id, blocked);
    await f.block(blocker, alice.id);

    await f.notif(alice.id, ok, 'like', p);
    await f.notif(alice.id, muted, 'like', p);
    await f.notif(alice.id, blocked, 'like', p);
    await f.notif(alice.id, blocker, 'like', p);
    await f.notif(alice.id, susp, 'like', p);
    await f.notif(alice.id, ok, 'like', gone);
    await f.notif(alice.id, priv, 'mention', privPost);
    await f.notif(alice.id, muted, 'follow');

    const r = await alice.get('/api/notifications');
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].actors.map((a: any) => a.handle)).toEqual(['okay']);
    expect(r.body.items[0].actorCount).toBe(1);
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });

  it('paginates by notification id without losing or repeating rows', async () => {
    const { env, user } = setup();
    const alice = await user('alice');
    const f = fixtures(env);
    const bob = await f.user('bob');
    const p = await f.post(bob, 'mentioning');
    const ids: string[] = [];
    for (let i = 0; i < 70; i++) ids.push(await f.notif(alice.id, bob, 'mention', p));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: any = await alice.get(`/api/notifications${cursor ? `?cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(25);
      seen.push(...r.body.items.map((g: any) => g.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual([...ids].reverse());
  });

  it('only shows the viewer their own notifications', async () => {
    const { env, user } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const f = fixtures(env);
    await f.notif(alice.id, bob.id, 'follow');
    expect((await bob.get('/api/notifications')).body.items).toEqual([]);
    await bob.post('/api/notifications/read');
    expect((await alice.get('/api/me/unread')).body.notifications).toBe(1);
  });
});
