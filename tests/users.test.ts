import { describe, expect, it } from 'vitest';
import { setup, type Client } from './helpers';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

type Env = ReturnType<typeof setup>['env'];

async function notifications(env: Env, userId: string, type?: string) {
  const sql = type ? 'SELECT * FROM notifications WHERE user_id = ? AND type = ?' : 'SELECT * FROM notifications WHERE user_id = ?';
  return (await env.DB.prepare(sql).bind(...(type ? [userId, type] : [userId])).all<{ actor_id: string; type: string }>()).results;
}

describe('profiles & follows', () => {
  it('shows a profile with counts and viewer state, and follows/unfollows', async () => {
    const { client, user, env } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    await alice.post('/api/posts', { body: 'one' });
    const p2 = await alice.post('/api/posts', { body: 'two' });
    await alice.del(`/api/posts/${p2.body.id}`);

    const f = await bob.post('/api/users/alice/follow');
    expect(f.body).toEqual({ state: 'active' });
    expect((await bob.post('/api/users/alice/follow')).body).toEqual({ state: 'active' }); // idempotent
    expect(await notifications(env, alice.id, 'follow')).toHaveLength(1);

    const prof = await bob.get('/api/users/alice');
    expect(prof.status).toBe(200);
    expect(prof.body.counts).toEqual({ followers: 1, following: 0, posts: 1 });
    expect(prof.body.canViewPosts).toBe(true);
    expect(prof.body.viewer).toEqual({ following: 'active', followsYou: false, blocking: false, blockedBy: false, muting: false });
    expect((await alice.get('/api/users/bob')).body.viewer.followsYou).toBe(true);
    expect((await alice.get('/api/users/alice')).body.viewer).toBeNull();
    expect((await client().get('/api/users/alice')).body.viewer).toBeNull();

    const followers = await client().get('/api/users/alice/followers');
    expect(followers.body.items.map((u: any) => u.handle)).toEqual(['bob']);
    expect((await client().get('/api/users/bob/following')).body.items.map((u: any) => u.handle)).toEqual(['alice']);

    expect((await bob.del('/api/users/alice/follow')).body).toEqual({ state: 'none' });
    expect((await bob.get('/api/users/alice')).body.counts.followers).toBe(0);
    expect((await bob.post('/api/users/bob/follow')).status).toBe(400);
    expect((await bob.post('/api/users/nobody_here/follow')).status).toBe(404);
    expect((await bob.get('/api/users/nobody_here')).status).toBe(404);
    expect((await client().post('/api/users/alice/follow')).status).toBe(401);
  });

  it('handles private accounts: pending requests, accept, decline and going public', async () => {
    const { client, user, env } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const carol = await user('carol');
    const dave = await user('dave');
    const priv = await alice.patch('/api/me/profile', { isPrivate: true });
    expect(priv.body.user.isPrivate).toBe(true);
    const post = (await alice.post('/api/posts', { body: 'members only' })).body;

    expect((await bob.post('/api/users/alice/follow')).body).toEqual({ state: 'pending' });
    expect(await notifications(env, alice.id, 'follow_request')).toHaveLength(1);
    expect((await bob.get('/api/users/alice')).body).toMatchObject({ canViewPosts: false, viewer: { following: 'pending' } });
    expect((await bob.get('/api/users/alice/posts')).status).toBe(403);
    expect((await bob.get(`/api/posts/${post.id}`)).status).toBe(404);
    expect((await bob.get('/api/users/alice/followers')).status).toBe(403);
    expect((await client().get('/api/users/alice/posts')).status).toBe(403);
    expect((await alice.get('/api/me/unread')).body.followRequests).toBe(1);

    const reqs = await alice.get('/api/me/follow-requests');
    expect(reqs.body.items.map((u: any) => u.handle)).toEqual(['bob']);
    expect((await alice.post(`/api/me/follow-requests/${bob.id}/accept`)).body).toEqual({ ok: true });
    expect(await notifications(env, bob.id, 'follow_accept')).toHaveLength(1);
    expect((await alice.post(`/api/me/follow-requests/${carol.id}/accept`)).status).toBe(404);

    expect((await bob.get('/api/users/alice')).body).toMatchObject({ canViewPosts: true, counts: { followers: 1 } });
    expect((await bob.get('/api/users/alice/posts')).body.items.map((i: any) => i.post.id)).toEqual([post.id]);
    expect((await bob.get(`/api/posts/${post.id}`)).status).toBe(200);

    // Decline removes the request.
    await dave.post('/api/users/alice/follow');
    await alice.post(`/api/me/follow-requests/${dave.id}/decline`);
    expect((await dave.get('/api/users/alice')).body.viewer.following).toBe('none');

    // Switching to public auto-accepts pending requests.
    expect((await carol.post('/api/users/alice/follow')).body.state).toBe('pending');
    await alice.patch('/api/me/profile', { isPrivate: false });
    expect((await carol.get('/api/users/alice')).body.viewer.following).toBe('active');
    expect((await alice.get('/api/me/follow-requests')).body.items).toEqual([]);

    // Removing a follower.
    expect((await alice.del(`/api/me/followers/${bob.id}`)).body).toEqual({ ok: true });
    expect((await bob.get('/api/users/alice')).body.viewer.following).toBe('none');
  });

  it('blocking hides content both ways, removes follows and prevents interaction', async () => {
    const { user, env } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    await alice.post('/api/users/bob/follow');
    await bob.post('/api/users/alice/follow');
    const ap = (await alice.post('/api/posts', { body: 'from alice' })).body;
    const bp = (await bob.post('/api/posts', { body: 'from bob' })).body;

    expect((await alice.post('/api/users/bob/block')).body).toEqual({ blocking: true });
    const follows = await env.DB.prepare('SELECT COUNT(*) AS n FROM follows').first<{ n: number }>();
    expect(follows!.n).toBe(0);

    expect((await bob.get('/api/users/alice')).status).toBe(404);
    expect((await bob.get('/api/users/alice/posts')).status).toBe(404);
    const seen = await alice.get('/api/users/bob');
    expect(seen.body).toMatchObject({ canViewPosts: false, viewer: { blocking: true } });
    expect((await alice.get('/api/users/bob/posts')).status).toBe(403);
    expect((await bob.get(`/api/posts/${ap.id}`)).status).toBe(404);
    expect((await alice.get(`/api/posts/${bp.id}`)).status).toBe(404);
    expect((await bob.post('/api/posts', { body: 'reply', replyToId: ap.id })).status).toBe(404);
    expect((await bob.post(`/api/posts/${ap.id}/like`)).status).toBe(404);
    expect((await bob.post('/api/users/alice/follow')).status).toBe(403);
    expect((await alice.post('/api/users/bob/follow')).status).toBe(403);
    expect((await alice.get('/api/me/blocks')).body.items.map((u: any) => u.handle)).toEqual(['bob']);

    expect((await alice.del('/api/users/bob/block')).body).toEqual({ blocking: false });
    expect((await bob.get(`/api/posts/${ap.id}`)).status).toBe(200);
    expect((await bob.post('/api/users/alice/follow')).body.state).toBe('active');
  });

  it('blocking deletes the blocked user’s pending follow request', async () => {
    const { user, env } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    await alice.patch('/api/me/profile', { isPrivate: true });
    await bob.post('/api/users/alice/follow');
    await alice.post('/api/users/bob/block');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM follows').first<{ n: number }>())!.n).toBe(0);
    expect((await alice.get('/api/me/follow-requests')).body.items).toEqual([]);
  });

  it('mutes and lists mutes', async () => {
    const { user } = setup();
    const alice = await user('alice');
    await user('bob');
    expect((await alice.post('/api/users/bob/mute')).body).toEqual({ muting: true });
    expect((await alice.get('/api/users/bob')).body.viewer.muting).toBe(true);
    expect((await alice.get('/api/me/mutes')).body.items.map((u: any) => u.handle)).toEqual(['bob']);
    expect((await alice.post('/api/users/alice/mute')).status).toBe(400);
    expect((await alice.del('/api/users/bob/mute')).body).toEqual({ muting: false });
    expect((await alice.get('/api/me/mutes')).body.items).toEqual([]);
  });

  it('paginates follower lists', async () => {
    const { user, client } = setup();
    const alice = await user('alice');
    for (let i = 0; i < 7; i++) await (await user(`fan${i}`)).post('/api/users/alice/follow');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await client().get(`/api/users/alice/followers?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.body.items.map((u: any) => u.handle));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(['fan0', 'fan1', 'fan2', 'fan3', 'fan4', 'fan5', 'fan6']);
    expect((await alice.get('/api/users/alice/followers?cursor=garbage')).status).toBe(400);
  });

  it('validates profile updates', async () => {
    const { user } = setup();
    const alice = await user('alice');
    const ok = await alice.patch('/api/me/profile', { displayName: '  Alice A.  ', bio: 'Hello\n\n\n\nworld' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ displayName: 'Alice A.', bio: 'Hello\n\nworld' });
    const bad = await alice.patch('/api/me/profile', { displayName: '', bio: 'x'.repeat(301) });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error.fields)).toEqual(expect.arrayContaining(['displayName', 'bio']));
  });

  it('shows suspended profiles without posts', async () => {
    const { user, env } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    await alice.post('/api/posts', { body: 'hello' });
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(alice.id).run();
    const prof = await bob.get('/api/users/alice');
    expect(prof.status).toBe(200);
    expect(prof.body).toMatchObject({ suspended: true, canViewPosts: false });
    expect((await bob.get('/api/users/alice/posts')).body.items).toEqual([]);
  });
});

describe('avatars', () => {
  async function upload(s: ReturnType<typeof setup>, c: Client, type: string, bytes: Uint8Array) {
    const res = await s.app.request(
      'http://relay.test/api/me/avatar',
      { method: 'POST', headers: { 'x-relay-client': '1', cookie: c.cookie, 'content-type': type }, body: bytes },
      s.env,
    );
    return { status: res.status, body: (await res.json()) as any };
  }

  it('rejects bad uploads, stores a valid PNG and serves it safely', async () => {
    const s = setup();
    const alice = await s.user('alice');
    expect((await upload(s, alice, 'image/png', new TextEncoder().encode('<svg onload=alert(1)>'))).status).toBe(415);
    expect((await upload(s, alice, 'image/svg+xml', PNG_1x1)).status).toBe(415);
    expect((await upload(s, alice, 'image/jpeg', PNG_1x1)).status).toBe(415); // declared type must match the bytes
    const big = new Uint8Array(1_000_001);
    big.set(PNG_1x1);
    expect((await upload(s, alice, 'image/png', big)).status).toBe(413);

    const ok = await upload(s, alice, 'image/png', PNG_1x1);
    expect(ok.status).toBe(200);
    expect(ok.body.avatarUrl).toMatch(/^\/api\/media\/avatars\/[0-9A-Z]{26}\/[0-9A-Z]{26}$/);
    expect((await alice.get('/api/users/alice')).body.avatarUrl).toBe(ok.body.avatarUrl);

    const res = await s.app.request(`http://relay.test${ok.body.avatarUrl}`, {}, s.env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_1x1)).toBe(true);

    // Replacing deletes the previous file.
    const second = await upload(s, alice, 'image/png', PNG_1x1);
    expect((await s.client().get(ok.body.avatarUrl)).status).toBe(404);
    expect((await s.client().get(second.body.avatarUrl)).status).toBe(200);
    expect((await s.env.DB.prepare('SELECT COUNT(*) AS n FROM media').first<{ n: number }>())!.n).toBe(1);

    expect((await s.client().get('/api/media/avatars/../../etc/passwd')).status).toBe(404);
    expect((await s.client().get('/api/media/other/thing')).status).toBe(404);

    expect((await alice.del('/api/me/avatar')).body).toEqual({ ok: true });
    expect((await alice.get('/api/users/alice')).body.avatarUrl).toBeNull();
    expect((await s.client().get(second.body.avatarUrl)).status).toBe(404);
  });

  it('uses the R2 bucket when bound', async () => {
    const store = new Map<string, { bytes: Uint8Array; type?: string }>();
    const MEDIA = {
      async put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
        store.set(key, { bytes: new Uint8Array(value), type: opts?.httpMetadata?.contentType });
      },
      async get(key: string) {
        const o = store.get(key);
        return o ? { body: new Blob([o.bytes]).stream(), httpMetadata: { contentType: o.type } } : null;
      },
      async delete(key: string) {
        store.delete(key);
      },
    };
    const s = setup({ MEDIA });
    const alice = await s.user('alice');
    const ok = await upload(s, alice, 'image/png', PNG_1x1);
    expect(ok.status).toBe(200);
    expect(store.size).toBe(1);
    const row = await s.env.DB.prepare('SELECT data FROM media').first<{ data: unknown }>();
    expect(row!.data).toBeNull();
    const res = await s.app.request(`http://relay.test${ok.body.avatarUrl}`, {}, s.env);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_1x1)).toBe(true);
    await upload(s, alice, 'image/png', PNG_1x1);
    expect(store.size).toBe(1);
  });
});

describe('settings', () => {
  it('reads defaults, deep-merges notify and normalises muted words', async () => {
    const { user, client } = setup();
    const alice = await user('alice');
    const def = await alice.get('/api/me/settings');
    expect(def.body).toMatchObject({ dmPolicy: 'following', mutedWords: [], feedReplies: true, notify: { likes: true } });
    const r = await alice.patch('/api/me/settings', { notify: { likes: false }, mutedWords: [' Spoiler ', 'spoiler', 'Big  Game', ''] });
    expect(r.status).toBe(200);
    expect(r.body.notify).toEqual({ likes: false, reposts: true, follows: true, mentions: true, replies: true });
    expect(r.body.mutedWords).toEqual(['spoiler', 'big game']);
    const again = await alice.patch('/api/me/settings', { dmPolicy: 'nobody' });
    expect(again.body).toMatchObject({ dmPolicy: 'nobody', notify: { likes: false }, mutedWords: ['spoiler', 'big game'] });
    expect((await alice.get('/api/me/settings')).body).toEqual(again.body);

    expect((await alice.patch('/api/me/settings', { mutedWords: ['x'.repeat(41)] })).status).toBe(422);
    expect((await alice.patch('/api/me/settings', { mutedWords: Array.from({ length: 51 }, (_, i) => `w${i}`) })).status).toBe(422);
    expect((await alice.patch('/api/me/settings', { dmPolicy: 'sometimes' })).status).toBe(422);
    expect((await client().get('/api/me/settings')).status).toBe(401);
  });
});
