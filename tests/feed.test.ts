import { describe, expect, it } from 'vitest';
import { setup, type Client } from './helpers';

/** Follow every page of a feed and return all items. */
async function allPages(c: Client, path: string, limit: number) {
  const items: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const r: any = await c.get(`${path}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeLessThanOrEqual(limit);
    items.push(...r.body.items);
    cursor = r.body.nextCursor;
    if (++pages > 50) throw new Error('runaway pagination');
  } while (cursor);
  return { items, pages };
}

const bodies = (items: any[]) => items.map((i) => i.post.body);

describe('home feed', () => {
  it('shows own and followed posts newest first, plus reposts, deduplicated', async () => {
    const { user } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const carol = await user('carol');
    const dave = await user('dave');
    await alice.post('/api/users/bob/follow');
    await alice.post('/api/users/dave/follow');

    await bob.post('/api/posts', { body: 'bob 1' });
    const c1 = (await carol.post('/api/posts', { body: 'carol 1' })).body;
    await alice.post('/api/posts', { body: 'alice 1' });
    await bob.post('/api/posts', { body: 'bob 2' });

    let home = await alice.get('/api/feed/home');
    expect(home.status).toBe(200);
    expect(bodies(home.body.items)).toEqual(['bob 2', 'alice 1', 'bob 1']);
    expect(home.body.items[0]).toMatchObject({ kind: 'post', repostedBy: null, key: `p:${home.body.items[0].post.id}` });
    expect(home.body.nextCursor).toBeNull();

    await bob.post(`/api/posts/${c1.id}/repost`);
    home = await alice.get('/api/feed/home');
    expect(home.body.items[0]).toMatchObject({ kind: 'repost', repostedBy: { handle: 'bob' }, key: `r:${bob.id}:${c1.id}` });
    expect(bodies(home.body.items)).toEqual(['carol 1', 'bob 2', 'alice 1', 'bob 1']);
    expect(bodies((await alice.get('/api/feed/home?reposts=0')).body.items)).toEqual(['bob 2', 'alice 1', 'bob 1']);

    // Followed as an original and reposted by two followees: shown once, newest occurrence.
    await alice.post('/api/users/carol/follow');
    await dave.post(`/api/posts/${c1.id}/repost`);
    home = await alice.get('/api/feed/home');
    expect(bodies(home.body.items)).toEqual(['carol 1', 'bob 2', 'alice 1', 'bob 1']);
    expect(home.body.items[0].repostedBy.handle).toBe('dave');

    // Deleted posts disappear, including their reposts.
    await carol.del(`/api/posts/${c1.id}`);
    expect(bodies((await alice.get('/api/feed/home')).body.items)).toEqual(['bob 2', 'alice 1', 'bob 1']);
  });

  it('includes replies only to the viewer or followed users, and respects the toggle and settings', async () => {
    const { user } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const carol = await user('carol');
    await alice.post('/api/users/bob/follow');
    const a = (await alice.post('/api/posts', { body: 'alice post' })).body;
    const c = (await carol.post('/api/posts', { body: 'carol post' })).body;
    const b = (await bob.post('/api/posts', { body: 'bob post' })).body;
    await bob.post('/api/posts', { body: 'bob to carol', replyToId: c.id });
    await bob.post('/api/posts', { body: 'bob to alice', replyToId: a.id });
    await bob.post('/api/posts', { body: 'bob to bob', replyToId: b.id });

    expect(bodies((await alice.get('/api/feed/home?replies=1')).body.items)).toEqual(['bob to bob', 'bob to alice', 'bob post', 'alice post']);
    expect(bodies((await alice.get('/api/feed/home?replies=0')).body.items)).toEqual(['bob post', 'alice post']);
    expect((await alice.get('/api/feed/home')).body.items).toHaveLength(4);
    await alice.patch('/api/me/settings', { feedReplies: false });
    expect(bodies((await alice.get('/api/feed/home')).body.items)).toEqual(['bob post', 'alice post']);
  });

  it('paginates across pages with no duplicates or gaps', async () => {
    const { user } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const carol = await user('carol');
    await alice.post('/api/users/bob/follow');
    const expected: string[] = [];
    for (let i = 0; i < 30; i++) {
      const author = i % 3 === 0 ? carol : bob;
      const p = (await author.post('/api/posts', { body: `post ${i}` })).body;
      if (author === bob) expected.push(p.body);
      // Bob reposts some of carol's posts right away.
      if (author === carol && i % 2 === 0) {
        await bob.post(`/api/posts/${p.id}/repost`);
        expected.push(p.body);
      }
    }
    expected.reverse();

    const big = await allPages(alice, '/api/feed/home', 25);
    expect(big.pages).toBe(1);
    expect(bodies(big.items)).toEqual(expected);

    for (const limit of [7, 4, 1]) {
      const { items, pages } = await allPages(alice, '/api/feed/home', limit);
      expect(bodies(items)).toEqual(expected);
      expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
      expect(pages).toBeGreaterThanOrEqual(Math.ceil(expected.length / limit));
    }
    expect((await alice.get('/api/feed/home?cursor=not-a-cursor')).status).toBe(400);
  });

  it('filters muted users and muted words, keeping cursors correct', async () => {
    const { user } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const carol = await user('carol');
    await alice.post('/api/users/bob/follow');
    await alice.post('/api/users/carol/follow');
    const keep: string[] = [];
    for (let i = 0; i < 30; i++) {
      const body = i % 2 ? `post ${i} with a SPOILER inside` : `post ${i}`;
      await bob.post('/api/posts', { body });
      if (!(i % 2)) keep.push(body);
    }
    keep.reverse();
    const own = (await alice.post('/api/posts', { body: 'my own spoiler' })).body;
    await alice.patch('/api/me/settings', { mutedWords: ['spoiler'] });

    const { items } = await allPages(alice, '/api/feed/home', 4);
    expect(bodies(items)).toEqual([own.body, ...keep]);

    // A long run of filtered rows still pages through correctly (pages may come back short).
    for (let i = 0; i < 20; i++) await bob.post('/api/posts', { body: `spoiler number ${i}` });
    const after = await bob.post('/api/posts', { body: 'after the spoilers' });
    const clustered = await allPages(alice, '/api/feed/home', 2);
    expect(bodies(clustered.items)).toEqual([after.body.body, own.body, ...keep]);

    // Muting a user removes their posts and their reposts.
    const c = (await carol.post('/api/posts', { body: 'carol says hi' })).body;
    await bob.post(`/api/posts/${c.id}/repost`);
    await alice.post('/api/users/bob/mute');
    expect(bodies((await alice.get('/api/feed/home')).body.items)).toEqual(['carol says hi', own.body]);
    await alice.post('/api/users/carol/mute');
    await alice.del('/api/users/bob/mute');
    const home = (await alice.get('/api/feed/home')).body.items;
    expect(home.some((i: any) => i.post.id === c.id)).toBe(false);
  });

  it('requires sign-in and hides blocked users', async () => {
    const { user, client } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    expect((await client().get('/api/feed/home')).status).toBe(401);
    await alice.post('/api/users/bob/follow');
    await bob.post('/api/posts', { body: 'hello' });
    expect((await alice.get('/api/feed/home')).body.items).toHaveLength(1);
    await bob.post('/api/users/alice/block');
    expect((await alice.get('/api/feed/home')).body.items).toHaveLength(0);
  });
});

describe('explore & conversations', () => {
  it('explore lists recent public top-level posts minus blocked, muted and muted words', async () => {
    const { user, client } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const carol = await user('carol');
    const dave = await user('dave');
    await dave.patch('/api/me/profile', { isPrivate: true });
    const b = (await bob.post('/api/posts', { body: 'bob public' })).body;
    await carol.post('/api/posts', { body: 'carol public' });
    await dave.post('/api/posts', { body: 'dave private' });
    await alice.post('/api/posts', { body: 'a reply', replyToId: b.id });
    await alice.post('/api/posts', { body: 'alice talks about cheese' });

    expect(bodies((await client().get('/api/feed/explore')).body.items)).toEqual(['alice talks about cheese', 'carol public', 'bob public']);
    await bob.post('/api/users/carol/block');
    await bob.patch('/api/me/settings', { mutedWords: ['cheese'] });
    expect(bodies((await bob.get('/api/feed/explore')).body.items)).toEqual(['bob public']);
    await alice.post('/api/users/bob/mute');
    expect(bodies((await alice.get('/api/feed/explore')).body.items)).toEqual(['alice talks about cheese', 'carol public']);
  });

  it('conversations lists roots with recent replies, newest reply first', async () => {
    const { user, client, env } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const carol = await user('carol');
    const r1 = (await alice.post('/api/posts', { body: 'first root' })).body;
    const r2 = (await bob.post('/api/posts', { body: 'second root' })).body;
    await alice.post('/api/posts', { body: 'quiet root' });
    const old = (await alice.post('/api/posts', { body: 'old root' })).body;
    const oldReply = (await bob.post('/api/posts', { body: 'old reply', replyToId: old.id })).body;
    await env.DB.prepare('UPDATE posts SET created_at = ? WHERE id = ?').bind(Date.now() - 8 * 86400_000, oldReply.id).run();

    const x = (await bob.post('/api/posts', { body: 'reply a', replyToId: r1.id })).body;
    await carol.post('/api/posts', { body: 'reply b', replyToId: x.id });
    await alice.post('/api/posts', { body: 'reply c', replyToId: r2.id });
    await carol.post('/api/posts', { body: 'reply d', replyToId: r1.id });

    const res = await client().get('/api/feed/conversations');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.root.id)).toEqual([r1.id, r2.id]);
    const first = res.body.items[0];
    expect(first.replyCount).toBe(3);
    expect(first.participants.map((u: any) => u.handle)).toEqual(['alice', 'carol', 'bob']);
    expect(typeof first.lastReplyAt).toBe('string');
    expect(res.body.items[1]).toMatchObject({ replyCount: 1 });

    const paged = await allPages(client(), '/api/feed/conversations', 1);
    expect(paged.items.map((i: any) => i.root.id)).toEqual([r1.id, r2.id]);
  });
});

describe('profile posts', () => {
  it('lists top-level posts and reposts, or replies only, and enforces privacy', async () => {
    const { user, client } = setup();
    const alice = await user('alice');
    const bob = await user('bob');
    const b = (await bob.post('/api/posts', { body: 'bob post' })).body;
    const a = (await alice.post('/api/posts', { body: 'alice post' })).body;
    await alice.post('/api/posts', { body: 'alice reply', replyToId: b.id });
    await alice.post(`/api/posts/${b.id}/repost`);

    const posts = await client().get('/api/users/alice/posts');
    expect(posts.body.items.map((i: any) => [i.kind, i.post.body])).toEqual([['repost', 'bob post'], ['post', 'alice post']]);
    const replies = await client().get('/api/users/alice/posts?tab=replies');
    expect(bodies(replies.body.items)).toEqual(['alice reply']);
    expect((await client().get('/api/users/alice/posts?tab=bogus')).status).toBe(400);
    expect((await client().get('/api/users/nobody_here/posts')).status).toBe(404);

    await alice.patch('/api/me/profile', { isPrivate: true });
    expect((await client().get('/api/users/alice/posts')).status).toBe(403);
    expect((await bob.get('/api/users/alice/posts')).status).toBe(403);
    expect((await alice.get('/api/users/alice/posts')).body.items.map((i: any) => i.post.id)).toContain(a.id);
  });
});
