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
    follow: (a: string, b: string) =>
      db.prepare("INSERT INTO follows (follower_id, followee_id, state, created_at) VALUES (?, ?, 'active', ?)").bind(a, b, Date.now()).run(),
    block: (a: string, b: string) => db.prepare('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').bind(a, b, Date.now()).run(),
    setPrivate: (id: string) => db.prepare('UPDATE users SET is_private = 1 WHERE id = ?').bind(id).run(),
    softDelete: (id: string) => db.prepare("UPDATE posts SET body = '', deleted_at = ? WHERE id = ?").bind(Date.now(), id).run(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 3));

async function world() {
  const s = setup();
  const alice = await s.user('alice');
  const bob = await s.user('bob');
  return { ...s, alice, bob, f: fixtures(s.env) };
}

describe('collections', () => {
  it('creates collections with validation and lists them per visibility', async () => {
    const { alice, bob, client } = await world();
    const pub = await alice.post('/api/collections', { title: '  Best of 2026 ', description: 'Keepers' });
    expect(pub.status).toBe(201);
    expect(pub.body).toMatchObject({ title: 'Best of 2026', description: 'Keepers', isPublic: true, itemCount: 0, owner: { handle: 'alice' } });
    const priv = await alice.post('/api/collections', { title: 'Drafts', isPublic: false });
    expect(priv.status).toBe(201);
    expect(priv.body.isPublic).toBe(false);

    const bad = await alice.post('/api/collections', { title: '   ' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields.title).toBeTruthy();
    expect((await alice.post('/api/collections', { title: 'x'.repeat(61) })).status).toBe(422);
    expect((await alice.post('/api/collections', { title: 'ok', description: 'd'.repeat(281) })).status).toBe(422);
    expect((await client().post('/api/collections', { title: 'anon' })).status).toBe(401);

    const own = await alice.get('/api/users/alice/collections');
    expect(own.body.items.map((c: any) => c.title).sort()).toEqual(['Best of 2026', 'Drafts']);
    const other = await bob.get('/api/users/alice/collections');
    expect(other.body.items.map((c: any) => c.title)).toEqual(['Best of 2026']);
    const anon = await client().get('/api/users/alice/collections');
    expect(anon.body.items.map((c: any) => c.title)).toEqual(['Best of 2026']);
    expect((await bob.get('/api/users/nobody_here/collections')).status).toBe(404);
  });

  it('hides private collections (404) and restricts mutation to the owner', async () => {
    const { alice, bob, client, f } = await world();
    const pub = (await alice.post('/api/collections', { title: 'Public' })).body;
    const priv = (await alice.post('/api/collections', { title: 'Secret', isPublic: false })).body;
    const post = await f.post(bob.id, 'a post');

    expect((await bob.get(`/api/collections/${priv.id}`)).status).toBe(404);
    expect((await client().get(`/api/collections/${priv.id}`)).status).toBe(404);
    expect((await alice.get(`/api/collections/${priv.id}`)).status).toBe(200);
    expect((await bob.get(`/api/collections/${pub.id}`)).status).toBe(200);
    expect((await client().get(`/api/collections/${pub.id}`)).status).toBe(200);
    expect((await bob.get('/api/collections/missing')).status).toBe(404);

    // Others: 403 on public collections, 404 on private ones; nothing changes.
    expect((await bob.patch(`/api/collections/${pub.id}`, { title: 'Mine now' })).status).toBe(403);
    expect((await bob.patch(`/api/collections/${priv.id}`, { title: 'Mine now' })).status).toBe(404);
    expect((await bob.post(`/api/collections/${pub.id}/items`, { postId: post })).status).toBe(403);
    expect((await bob.post(`/api/collections/${priv.id}/items`, { postId: post })).status).toBe(404);
    expect((await bob.del(`/api/collections/${pub.id}`)).status).toBe(403);
    expect((await bob.del(`/api/collections/${priv.id}`)).status).toBe(404);
    expect((await alice.post(`/api/collections/${pub.id}/items`, { postId: post })).status).toBe(200);
    expect((await bob.patch(`/api/collections/${pub.id}/items/${post}`, { note: 'hijack' })).status).toBe(403);
    expect((await bob.del(`/api/collections/${pub.id}/items/${post}`)).status).toBe(403);
    const still = await alice.get(`/api/collections/${pub.id}`);
    expect(still.body.collection.title).toBe('Public');
    expect(still.body.collection.itemCount).toBe(1);

    const renamed = await alice.patch(`/api/collections/${pub.id}`, { title: 'Renamed', isPublic: false });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ title: 'Renamed', isPublic: false, description: '' });
    expect((await bob.get(`/api/collections/${pub.id}`)).status).toBe(404);

    expect((await alice.del(`/api/collections/${pub.id}`)).body).toEqual({ ok: true });
    expect((await alice.get(`/api/collections/${pub.id}`)).status).toBe(404);
  });

  it('adds, annotates and removes items; tracks containsPost and updatedAt', async () => {
    const { alice, bob, f } = await world();
    const col = (await alice.post('/api/collections', { title: 'Reading list' })).body;
    const p1 = await f.post(bob.id, 'first');
    const p2 = await f.post(alice.id, 'second');

    await tick();
    expect((await alice.post(`/api/collections/${col.id}/items`, { postId: p1, note: 'great thread' })).status).toBe(200);
    await tick();
    expect((await alice.post(`/api/collections/${col.id}/items`, { postId: p2 })).status).toBe(200);
    // Re-adding is a no-op.
    expect((await alice.post(`/api/collections/${col.id}/items`, { postId: p2 })).status).toBe(200);
    expect((await alice.post(`/api/collections/${col.id}/items`, { postId: 'nope' })).status).toBe(404);

    const got = await bob.get(`/api/collections/${col.id}`);
    expect(got.body.collection.itemCount).toBe(2);
    expect(got.body.collection.updatedAt > col.updatedAt).toBe(true);
    expect(got.body.items.items.map((i: any) => i.post.id)).toEqual([p2, p1]);
    expect(got.body.items.items[1]).toMatchObject({ note: 'great thread', post: { body: 'first' } });
    expect(got.body.items.nextCursor).toBeNull();

    const mine = await alice.get(`/api/me/collections?postId=${p1}`);
    expect(mine.body.items[0].containsPost).toBe(true);
    expect((await alice.get('/api/me/collections')).body.items[0].containsPost).toBeUndefined();

    expect((await alice.patch(`/api/collections/${col.id}/items/${p1}`, { note: 'updated note' })).status).toBe(200);
    expect((await alice.patch(`/api/collections/${col.id}/items/missing`, { note: 'x' })).status).toBe(404);
    expect((await alice.patch(`/api/collections/${col.id}/items/${p1}`, { note: 'n'.repeat(281) })).status).toBe(422);

    expect((await alice.del(`/api/collections/${col.id}/items/${p1}`)).body).toEqual({ ok: true });
    const after = await alice.get(`/api/collections/${col.id}`);
    expect(after.body.collection.itemCount).toBe(1);
    expect((await alice.get(`/api/me/collections?postId=${p1}`)).body.items[0].containsPost).toBe(false);
  });

  it('only lets owners add posts they can see; omits unavailable items for viewers, keeps deleted placeholders', async () => {
    const { alice, bob, user, f } = await world();
    const carol = await user('carol');
    await f.setPrivate(carol.id);
    const carolPost = await f.post(carol.id, 'followers only');
    const col = (await alice.post('/api/collections', { title: 'Mixed' })).body;

    expect((await alice.post(`/api/collections/${col.id}/items`, { postId: carolPost })).status).toBe(404);
    await f.follow(alice.id, carol.id);
    expect((await alice.post(`/api/collections/${col.id}/items`, { postId: carolPost })).status).toBe(200);

    const bobPost = await f.post(bob.id, 'will be deleted');
    await alice.post(`/api/collections/${col.id}/items`, { postId: bobPost });
    await f.softDelete(bobPost);
    expect((await alice.post(`/api/collections/${col.id}/items`, { postId: bobPost })).status).toBe(404);

    const forBob = await bob.get(`/api/collections/${col.id}`);
    expect(forBob.body.collection.itemCount).toBe(2);
    expect(forBob.body.items.items).toHaveLength(1);
    expect(forBob.body.items.items[0].post).toMatchObject({ id: bobPost, deleted: true, body: '' });
    expect(JSON.stringify(forBob.body)).not.toContain('followers only');

    const forAlice = await alice.get(`/api/collections/${col.id}`);
    expect(forAlice.body.items.items.map((i: any) => i.post.id).sort()).toEqual([bobPost, carolPost].sort());

    // A blocked viewer can't see the owner's collections at all.
    await f.block(alice.id, bob.id);
    expect((await bob.get(`/api/collections/${col.id}`)).status).toBe(404);
    expect((await bob.get('/api/users/alice/collections')).body.items).toEqual([]);
  });

  it('paginates items by addedAt desc', async () => {
    const { env, alice, f } = await world();
    const col = (await alice.post('/api/collections', { title: 'Many' })).body;
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const p = await f.post(alice.id, `post ${i}`);
      ids.push(p);
      await env.DB.prepare('INSERT INTO collection_items (collection_id, post_id, note, added_at) VALUES (?, ?, ?, ?)')
        .bind(col.id, p, '', 1_000 + Math.floor(i / 2)) // pairs share a timestamp to exercise the tiebreak
        .run();
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await alice.get(`/api/collections/${col.id}${cursor ? `?cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.items.map((i: any) => i.post.id));
      cursor = r.body.items.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect(seen.slice(0, 2).sort()).toEqual(ids.slice(28).sort());
  });

  it('caps collections per user at 100', async () => {
    const { env, alice } = await world();
    for (let i = 0; i < 100; i++) {
      await env.DB.prepare('INSERT INTO collections (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(newId(), alice.id, `c${i}`, Date.now(), Date.now()).run();
    }
    const r = await alice.post('/api/collections', { title: 'one too many' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('limit_reached');
  });

  it('caps items per collection at 500', async () => {
    const { env, alice, f } = await world();
    const col = (await alice.post('/api/collections', { title: 'Full' })).body;
    const stmts = [];
    for (let i = 0; i < 500; i++) {
      const id = newId();
      stmts.push(
        env.DB.prepare('INSERT INTO posts (id, author_id, body, reply_to_id, root_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)').bind(id, alice.id, `p${i}`, id, Date.now()),
        env.DB.prepare('INSERT INTO collection_items (collection_id, post_id, added_at) VALUES (?, ?, ?)').bind(col.id, id, Date.now()),
      );
    }
    await env.DB.batch(stmts);
    const extra = await f.post(alice.id, 'one more');
    const r = await alice.post(`/api/collections/${col.id}/items`, { postId: extra });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('limit_reached');
    expect((await alice.get(`/api/collections/${col.id}`)).body.collection.itemCount).toBe(500);
  });
});
