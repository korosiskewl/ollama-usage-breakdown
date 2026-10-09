import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

type Env = ReturnType<typeof setup>['env'];

async function rows<T = any>(env: Env, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...params).all<T>()).results;
}

describe('posts', () => {
  it('creates and reads posts, validating length in graphemes', async () => {
    const { user, client } = setup();
    const alice = await user('alice');
    const p = await alice.post('/api/posts', { body: '  Hello\r\n\n\n\nworld  ' });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ body: 'Hello\n\nworld', deleted: false, replyToId: null, viewer: { isAuthor: true } });
    expect(p.body.rootId).toBe(p.body.id);
    expect((await client().get(`/api/posts/${p.body.id}`)).body.body).toBe('Hello\n\nworld');

    for (const body of ['', '   \n  ', 'x'.repeat(501)]) {
      const r = await alice.post('/api/posts', { body });
      expect(r.status).toBe(422);
      expect(r.body.error.fields.body).toBeTruthy();
    }
    expect((await alice.post('/api/posts', {})).status).toBe(422);
    expect((await alice.post('/api/posts', { body: 'x'.repeat(500) })).status).toBe(201);
    expect((await alice.post('/api/posts', { body: '👩‍👩‍👧‍👦'.repeat(500) })).status).toBe(201); // 500 graphemes
    expect((await client().post('/api/posts', { body: 'hi' })).status).toBe(401);
    expect((await client().get('/api/posts/NOPE')).status).toBe(404);
  });

  it('only the author can edit; moderators can delete others’ posts', async () => {
    const { user, env } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const mod = await user('mallory');
    await env.DB.prepare("UPDATE users SET role = 'moderator' WHERE id = ?").bind(mod.id).run();
    const p = (await alice.post('/api/posts', { body: 'original' })).body;

    expect((await bob.patch(`/api/posts/${p.id}`, { body: 'hacked' })).status).toBe(403);
    expect((await bob.del(`/api/posts/${p.id}`)).status).toBe(403);
    expect((await mod.patch(`/api/posts/${p.id}`, { body: 'mod edit' })).status).toBe(403);

    const e = await alice.patch(`/api/posts/${p.id}`, { body: 'edited' });
    expect(e.status).toBe(200);
    expect(e.body.body).toBe('edited');
    expect(e.body.editedAt).toBeTruthy();
    expect((await alice.patch(`/api/posts/${p.id}`, { body: '' })).status).toBe(422);

    expect((await mod.del(`/api/posts/${p.id}`)).body).toEqual({ ok: true });
    const after = await bob.get(`/api/posts/${p.id}`);
    expect(after.body).toMatchObject({ deleted: true, removed: true, body: '' });
    const actions = await rows(env, 'SELECT * FROM moderation_actions');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ moderator_id: mod.id, target_user_id: alice.id, target_post_id: p.id, action: 'remove_post' });
    expect((await alice.patch(`/api/posts/${p.id}`, { body: 'back' })).status).toBe(404);

    const own = (await bob.post('/api/posts', { body: 'mine' })).body;
    expect((await bob.del(`/api/posts/${own.id}`)).body).toEqual({ ok: true });
    expect((await bob.get(`/api/posts/${own.id}`)).body).toMatchObject({ deleted: true, removed: false });
    expect(await rows(env, 'SELECT * FROM moderation_actions')).toHaveLength(1);
  });

  it('deleting keeps a placeholder in the thread with replies intact', async () => {
    const { user } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const carol = await user('carol');
    const root = (await alice.post('/api/posts', { body: 'root' })).body;
    const r1 = (await bob.post('/api/posts', { body: 'reply one', replyToId: root.id })).body;
    const r2 = (await carol.post('/api/posts', { body: 'reply two', replyToId: r1.id })).body;
    const lone = (await carol.post('/api/posts', { body: 'lonely', replyToId: root.id })).body;
    expect(r2.rootId).toBe(root.id);
    expect(r2.replyTo).toMatchObject({ id: r1.id, deleted: false, author: { handle: 'bob' } });

    await bob.del(`/api/posts/${r1.id}`);
    await carol.del(`/api/posts/${lone.id}`);
    expect((await carol.post('/api/posts', { body: 'too late', replyToId: r1.id })).status).toBe(404);

    const t = await alice.get(`/api/posts/${root.id}/thread`);
    expect(t.status).toBe(200);
    expect(t.body.ancestors).toEqual([]);
    expect(t.body.replies.items.map((p: any) => p.id)).toEqual([r1.id]); // the childless deleted reply is omitted
    expect(t.body.replies.items[0]).toMatchObject({ deleted: true, body: '', counts: { replies: 1 } });

    const t2 = await alice.get(`/api/posts/${r2.id}/thread`);
    expect(t2.body.ancestors.map((p: any) => [p.id, p.deleted])).toEqual([[root.id, false], [r1.id, true]]);
    expect(t2.body.post.body).toBe('reply two');
    expect((await alice.get(`/api/posts/${r1.id}`)).body.deleted).toBe(true);
  });

  it('creates mention rows and notifications, skipping blocked users and double notifies', async () => {
    const { user, env } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const carol = await user('carol');
    const dave = await user('dave');
    await dave.post('/api/users/alice/block');

    const p = (await alice.post('/api/posts', { body: 'hi @bob, @Carol, @dave and @ghost_user' })).body;
    expect(p.mentions.sort()).toEqual(['bob', 'carol']);
    const m = await rows<{ user_id: string }>(env, 'SELECT user_id FROM mentions WHERE post_id = ?', p.id);
    expect(m.map((r) => r.user_id).sort()).toEqual([bob.id, carol.id].sort());
    const n = await rows<{ user_id: string; type: string }>(env, 'SELECT user_id, type FROM notifications WHERE post_id = ?', p.id);
    expect(n.map((r) => `${r.user_id}:${r.type}`).sort()).toEqual([`${bob.id}:mention`, `${carol.id}:mention`].sort());
    expect(await rows(env, 'SELECT * FROM notifications WHERE user_id = ?', dave.id)).toEqual([]);

    // Replying to alice while mentioning her: one 'reply' notification, no 'mention'.
    const r = (await bob.post('/api/posts', { body: '@alice thanks!', replyToId: p.id })).body;
    const rn = await rows<{ user_id: string; type: string }>(env, 'SELECT user_id, type FROM notifications WHERE post_id = ?', r.id);
    expect(rn).toEqual([{ user_id: alice.id, type: 'reply' }]);

    // Editing re-parses mentions without notifying.
    await alice.patch(`/api/posts/${p.id}`, { body: 'now just @dave and @bob' });
    const m2 = await rows<{ user_id: string }>(env, 'SELECT user_id FROM mentions WHERE post_id = ?', p.id);
    expect(m2.map((x) => x.user_id)).toEqual([bob.id]);
    expect(await rows(env, 'SELECT * FROM notifications WHERE post_id = ?', p.id)).toHaveLength(2);
  });

  it('likes and reposts are idempotent and counted', async () => {
    const { user, env } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const p = (await alice.post('/api/posts', { body: 'like me' })).body;
    expect((await bob.post(`/api/posts/${p.id}/like`)).body).toEqual({ liked: true, likes: 1 });
    expect((await bob.post(`/api/posts/${p.id}/like`)).body).toEqual({ liked: true, likes: 1 });
    expect((await alice.post(`/api/posts/${p.id}/like`)).body).toEqual({ liked: true, likes: 2 });
    expect(await rows(env, "SELECT * FROM notifications WHERE type = 'like'")).toHaveLength(1);
    expect((await bob.get(`/api/posts/${p.id}`)).body).toMatchObject({ counts: { likes: 2 }, viewer: { liked: true } });
    expect((await bob.get(`/api/posts/${p.id}/likes`)).body.items.map((u: any) => u.handle).sort()).toEqual(['alice', 'bob']);
    expect((await bob.del(`/api/posts/${p.id}/like`)).body).toEqual({ liked: false, likes: 1 });
    expect((await bob.del(`/api/posts/${p.id}/like`)).body).toEqual({ liked: false, likes: 1 });

    expect((await bob.post(`/api/posts/${p.id}/repost`)).body).toEqual({ reposted: true, reposts: 1 });
    expect((await bob.post(`/api/posts/${p.id}/repost`)).body).toEqual({ reposted: true, reposts: 1 });
    expect(await rows(env, "SELECT * FROM notifications WHERE type = 'repost'")).toHaveLength(1);
    expect((await bob.del(`/api/posts/${p.id}/repost`)).body).toEqual({ reposted: false, reposts: 0 });

    await alice.del(`/api/posts/${p.id}`);
    expect((await bob.post(`/api/posts/${p.id}/like`)).status).toBe(404);
    expect((await bob.post(`/api/posts/${p.id}/repost`)).status).toBe(404);
  });

  it('cannot interact with invisible posts or repost private accounts', async () => {
    const { user } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const carol = await user('carol');
    await alice.patch('/api/me/profile', { isPrivate: true });
    await bob.post('/api/users/alice/follow');
    await alice.post(`/api/me/follow-requests/${bob.id}/accept`);
    const p = (await alice.post('/api/posts', { body: 'private thoughts' })).body;

    expect((await carol.post(`/api/posts/${p.id}/like`)).status).toBe(404);
    expect((await carol.post('/api/posts', { body: 'hm', replyToId: p.id })).status).toBe(404);
    expect((await carol.get(`/api/posts/${p.id}/thread`)).status).toBe(404);
    expect((await bob.post(`/api/posts/${p.id}/like`)).body.liked).toBe(true);
    expect((await bob.post(`/api/posts/${p.id}/repost`)).status).toBe(403);
    expect((await alice.post(`/api/posts/${p.id}/repost`)).status).toBe(403);
    expect((await carol.patch(`/api/posts/${p.id}`, { body: 'x' })).status).toBe(404);

    // A follower's reply to the private post is visible to them but shows the parent as unavailable to others.
    const reply = (await bob.post('/api/posts', { body: 'nice', replyToId: p.id })).body;
    const t = await carol.get(`/api/posts/${reply.id}/thread`);
    expect(t.status).toBe(200);
    expect(t.body.ancestors[0]).toMatchObject({ id: p.id, unavailable: true, body: '' });
  });

  it('paginates thread replies oldest-first and hides muted authors', async () => {
    const { user } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const troll = await user('troll');
    const root = (await alice.post('/api/posts', { body: 'root' })).body;
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push((await bob.post('/api/posts', { body: `reply ${i}`, replyToId: root.id })).body.id);
      if (i % 4 === 0) await troll.post('/api/posts', { body: 'noise', replyToId: root.id });
    }
    await alice.post('/api/users/troll/mute');
    const got: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: any = await alice.get(`/api/posts/${root.id}/thread?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      got.push(...r.body.replies.items.map((p: any) => p.id));
      cursor = r.body.replies.nextCursor;
      pages++;
    } while (cursor);
    expect(got).toEqual(ids);
    expect(pages).toBe(3);
    // Not muted for others.
    expect((await bob.get(`/api/posts/${root.id}/thread`)).body.replies.items).toHaveLength(15);
  });

  it('builds the reader view from the root author’s earliest self-reply chain', async () => {
    const { user } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const root = (await alice.post('/api/posts', { body: '1/ a thread' })).body;
    const a1 = (await alice.post('/api/posts', { body: '2/', replyToId: root.id })).body;
    await alice.post('/api/posts', { body: 'aside', replyToId: root.id }); // later sibling: not part of the chain
    const b1 = (await bob.post('/api/posts', { body: 'great', replyToId: a1.id })).body;
    await bob.post('/api/posts', { body: 'more', replyToId: b1.id });
    const a2 = (await alice.post('/api/posts', { body: '3/', replyToId: a1.id })).body;
    const gone = (await alice.post('/api/posts', { body: 'oops', replyToId: a2.id })).body;
    await alice.del(`/api/posts/${gone.id}`);
    const a3 = (await alice.post('/api/posts', { body: '4/', replyToId: a2.id })).body;
    await alice.post('/api/posts', { body: 'reply to bob', replyToId: b1.id });

    const r = await bob.get(`/api/posts/${a2.id}/reader`);
    expect(r.status).toBe(200);
    expect(r.body.author.handle).toBe('alice');
    expect(r.body.posts.map((p: any) => p.id)).toEqual([root.id, a1.id, a2.id, a3.id]);
    expect(r.body.otherReplies).toBe(2);
    expect((await bob.get('/api/posts/NOPE/reader')).status).toBe(404);
  });
});
