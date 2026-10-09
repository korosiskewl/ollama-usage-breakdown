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
    role: (id: string, role: string) => db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run(),
    setPrivate: (id: string) => db.prepare('UPDATE users SET is_private = 1 WHERE id = ?').bind(id).run(),
    block: (a: string, b: string) => db.prepare('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').bind(a, b, Date.now()).run(),
  };
}

async function world() {
  const s = setup({ ADMIN_HANDLES: 'boss' });
  const boss = await s.user('boss');
  const mod = await s.user('mod_mary');
  const alice = await s.user('alice');
  const bob = await s.user('bob');
  const f = fixtures(s.env);
  await f.role(mod.id, 'moderator');
  return { ...s, boss, mod, alice, bob, f };
}

describe('moderation', () => {
  it('accepts reports, treats duplicates as no-ops and rejects bad targets', async () => {
    const { env, alice, bob, client, f } = await world();
    const post = await f.post(bob.id, 'spammy spam');
    const first = await alice.post('/api/reports', { targetType: 'post', targetId: post, reason: 'spam', details: 'buy now links' });
    expect(first.status).toBe(201);
    const dup = await alice.post('/api/reports', { targetType: 'post', targetId: post, reason: 'harassment' });
    expect(dup.status).toBe(200);
    expect(dup.body).toEqual({ ok: true });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports').first<{ n: number }>();
    expect(n!.n).toBe(1);

    expect((await alice.post('/api/reports', { targetType: 'user', targetId: alice.id, reason: 'spam' })).status).toBe(400);
    const own = await f.post(alice.id, 'mine');
    expect((await alice.post('/api/reports', { targetType: 'post', targetId: own, reason: 'spam' })).status).toBe(400);
    expect((await alice.post('/api/reports', { targetType: 'post', targetId: 'nope', reason: 'spam' })).status).toBe(404);
    expect((await alice.post('/api/reports', { targetType: 'user', targetId: 'nope', reason: 'spam' })).status).toBe(404);
    expect((await alice.post('/api/reports', { targetType: 'user', targetId: bob.id, reason: 'rude' })).status).toBe(422);
    expect((await alice.post('/api/reports', { targetType: 'user', targetId: bob.id, reason: 'other', details: 'x'.repeat(1001) })).status).toBe(422);
    expect((await client().post('/api/reports', { targetType: 'user', targetId: bob.id, reason: 'spam' })).status).toBe(401);
  });

  it('restricts every /mod endpoint to moderators and admins', async () => {
    const { alice, bob, client } = await world();
    const anon = client();
    expect((await anon.get('/api/mod/reports')).status).toBe(401);
    for (const c of [alice]) {
      expect((await c.get('/api/mod/reports')).status).toBe(403);
      expect((await c.get('/api/mod/actions')).status).toBe(403);
      expect((await c.post('/api/mod/reports/whatever/resolve', { action: 'dismiss' })).status).toBe(403);
      expect((await c.post(`/api/mod/users/${bob.id}/suspend`, {})).status).toBe(403);
      expect((await c.post(`/api/mod/users/${bob.id}/unsuspend`, {})).status).toBe(403);
      expect((await c.post(`/api/mod/users/${bob.id}/role`, { role: 'admin' })).status).toBe(403);
    }
  });

  it('shows moderators reported content even from private accounts that blocked them', async () => {
    const { alice, bob, mod, f } = await world();
    await f.setPrivate(bob.id);
    await f.block(bob.id, mod.id);
    const post = await f.post(bob.id, 'hidden nastiness');
    await f.block(bob.id, alice.id);
    expect((await alice.post('/api/reports', { targetType: 'post', targetId: post, reason: 'harassment', details: 'see this' })).status).toBe(201);
    const r = await mod.get('/api/mod/reports');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    const rep = r.body.items[0];
    expect(rep).toMatchObject({ targetType: 'post', targetId: post, reason: 'harassment', details: 'see this', status: 'open', resolution: null });
    expect(rep.reporter.handle).toBe('alice');
    expect(rep.targetPost.body).toBe('hidden nastiness');
    expect(rep.targetPost.unavailable).toBe(false);
    expect(rep.targetPost.author.handle).toBe('bob');
    expect(rep.targetUser.handle).toBe('bob');
  });

  it('remove_post soft-deletes, resolves every open report on the post and logs the action', async () => {
    const { env, alice, bob, user, mod, f } = await world();
    const carol = await user('carol');
    const post = await f.post(bob.id, 'bad post');
    await alice.post('/api/reports', { targetType: 'post', targetId: post, reason: 'hate' });
    await carol.post('/api/reports', { targetType: 'post', targetId: post, reason: 'spam' });
    const open = (await mod.get('/api/mod/reports?status=open')).body.items;
    expect(open).toHaveLength(2);

    const res = await mod.post(`/api/mod/reports/${open[0].id}/resolve`, { action: 'remove_post', note: 'hate speech' });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT body, deleted_at, removed_by_mod FROM posts WHERE id = ?').bind(post).first<any>();
    expect(row).toMatchObject({ body: '', removed_by_mod: 1 });
    expect(row.deleted_at).toBeGreaterThan(0);

    expect((await mod.get('/api/mod/reports?status=open')).body.items).toEqual([]);
    const actioned = (await mod.get('/api/mod/reports?status=actioned')).body.items;
    expect(actioned).toHaveLength(2);
    for (const r of actioned) {
      expect(r.resolution).toBe('remove_post: hate speech');
      expect(r.targetPost).toMatchObject({ id: post, deleted: true, removed: true, body: '' });
    }
    const resolvedBy = await env.DB.prepare('SELECT DISTINCT resolved_by FROM reports').all<{ resolved_by: string }>();
    expect(resolvedBy.results.map((r) => r.resolved_by)).toEqual([mod.id]);

    const actions = await mod.get('/api/mod/actions');
    expect(actions.body.items).toHaveLength(1);
    expect(actions.body.items[0]).toMatchObject({ action: 'remove_post', note: 'hate speech', targetPostId: post });
    expect(actions.body.items[0].moderator.handle).toBe('mod_mary');
    expect(actions.body.items[0].targetUser.handle).toBe('bob');

    expect((await mod.post(`/api/mod/reports/${open[0].id}/resolve`, { action: 'dismiss' })).status).toBe(409);
  });

  it('suspend_user ends the user’s sessions and blocks login; unsuspend restores access', async () => {
    const { env, alice, bob, mod, client } = await world();
    await alice.post('/api/reports', { targetType: 'user', targetId: bob.id, reason: 'impersonation' });
    const [rep] = (await mod.get('/api/mod/reports')).body.items;
    expect(rep.targetUser.handle).toBe('bob');
    expect(rep.targetPost).toBeNull();

    expect((await mod.post(`/api/mod/reports/${rep.id}/resolve`, { action: 'remove_post' })).status).toBe(400);
    expect((await mod.post(`/api/mod/reports/${rep.id}/resolve`, { action: 'suspend_user' })).status).toBe(200);
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(bob.id).first<{ n: number }>();
    expect(sessions!.n).toBe(0);
    expect((await bob.get('/api/auth/me')).body.user).toBeNull();
    const login = await client().post('/api/auth/login', { handle: 'bob', password: 'correct horse battery' });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('suspended');
    expect((await mod.get('/api/mod/reports?status=actioned')).body.items[0].resolution).toBe('suspend_user');

    expect((await mod.post(`/api/mod/users/${bob.id}/unsuspend`)).status).toBe(200);
    expect((await client().post('/api/auth/login', { handle: 'bob', password: 'correct horse battery' })).status).toBe(200);
    const actions = (await mod.get('/api/mod/actions')).body.items.map((a: any) => a.action);
    expect(actions).toEqual(['unsuspend_user', 'suspend_user']);
  });

  it('dismiss marks reports dismissed without touching the target', async () => {
    const { env, alice, bob, mod, f } = await world();
    const post = await f.post(bob.id, 'fine actually');
    await alice.post('/api/reports', { targetType: 'post', targetId: post, reason: 'other' });
    const [rep] = (await mod.get('/api/mod/reports')).body.items;
    expect((await mod.post(`/api/mod/reports/${rep.id}/resolve`, { action: 'dismiss' })).status).toBe(200);
    const [d] = (await mod.get('/api/mod/reports?status=dismissed')).body.items;
    expect(d.status).toBe('dismissed');
    const row = await env.DB.prepare('SELECT deleted_at FROM posts WHERE id = ?').bind(post).first<any>();
    expect(row.deleted_at).toBeNull();
    // A fresh report can be filed after the earlier one was resolved.
    expect((await alice.post('/api/reports', { targetType: 'post', targetId: post, reason: 'other' })).status).toBe(201);
  });

  it('enforces the suspension hierarchy', async () => {
    const { boss, mod, alice, user, f } = await world();
    const mod2 = await user('mod_two');
    await f.role(mod2.id, 'moderator');
    expect((await mod.post(`/api/mod/users/${boss.id}/suspend`, {})).status).toBe(403);
    expect((await mod.post(`/api/mod/users/${mod2.id}/suspend`, {})).status).toBe(403);
    expect((await mod.post(`/api/mod/users/${mod.id}/suspend`, {})).status).toBe(403);
    expect((await boss.post(`/api/mod/users/${boss.id}/suspend`, {})).status).toBe(403);
    expect((await mod.post(`/api/mod/users/nope/suspend`, {})).status).toBe(404);
    expect((await boss.post(`/api/mod/users/${mod2.id}/suspend`, { note: 'abuse of tools' })).status).toBe(200);
    expect((await mod2.get('/api/auth/me')).body.user).toBeNull();
    expect((await mod.post(`/api/mod/users/${alice.id}/suspend`)).status).toBe(200);
    expect((await alice.get('/api/auth/me')).body.user).toBeNull();
  });

  it('lets only admins change roles, never their own', async () => {
    const { boss, mod, alice } = await world();
    expect((await mod.post(`/api/mod/users/${alice.id}/role`, { role: 'moderator' })).status).toBe(403);
    expect((await boss.post(`/api/mod/users/${boss.id}/role`, { role: 'user' })).status).toBe(403);
    expect((await boss.post(`/api/mod/users/${alice.id}/role`, { role: 'superuser' })).status).toBe(422);
    expect((await alice.get('/api/mod/reports')).status).toBe(403);
    expect((await boss.post(`/api/mod/users/${alice.id}/role`, { role: 'moderator' })).status).toBe(200);
    expect((await alice.get('/api/mod/reports')).status).toBe(200);
    const [act] = (await boss.get('/api/mod/actions')).body.items;
    expect(act).toMatchObject({ action: 'set_role' });
    expect(act.targetUser.handle).toBe('alice');
    expect((await boss.post(`/api/mod/users/${mod.id}/role`, { role: 'user' })).status).toBe(200);
    expect((await mod.get('/api/mod/reports')).status).toBe(403);
  });
});
