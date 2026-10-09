import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import type { Env } from '../server/env';

// Direct-DB fixtures so these tests don't depend on the users/settings routes.
function fixtures(env: Env) {
  const db = env.DB;
  return {
    follow: (a: string, b: string) =>
      db.prepare("INSERT INTO follows (follower_id, followee_id, state, created_at) VALUES (?, ?, 'active', ?)").bind(a, b, Date.now()).run(),
    block: (a: string, b: string) => db.prepare('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').bind(a, b, Date.now()).run(),
    dmPolicy: (id: string, policy: 'everyone' | 'following' | 'nobody') =>
      db.prepare('UPDATE user_settings SET dm_policy = ? WHERE user_id = ?').bind(policy, id).run(),
    suspend: (id: string) => db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(id).run(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 3));

async function world(overrides = {}) {
  const s = setup(overrides);
  const alice = await s.user('alice');
  const bob = await s.user('bob');
  const f = fixtures(s.env);
  return { ...s, alice, bob, f };
}

describe('direct messages', () => {
  it('requires sign-in', async () => {
    const { client } = setup();
    const anon = client();
    expect((await anon.get('/api/conversations')).status).toBe(401);
    expect((await anon.post('/api/conversations', { handle: 'x' })).status).toBe(401);
  });

  it('enforces dmPolicy "following" and finds-or-creates one conversation per pair', async () => {
    const { alice, bob, f } = await world();
    // Default policy is "following": bob doesn't follow alice.
    const denied = await alice.post('/api/conversations', { handle: 'bob' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('dm_not_allowed');
    expect(denied.body.error.message).toMatch(/follow/);

    await f.follow(bob.id, alice.id);
    const c1 = await alice.post('/api/conversations', { handle: '@bob' });
    expect(c1.status).toBe(200);
    expect(c1.body.other.handle).toBe('bob');
    expect(c1.body.canSend).toBe(true);
    expect(c1.body.lastMessage).toBeNull();

    const again = await alice.post('/api/conversations', { handle: 'BOB' });
    expect(again.body.id).toBe(c1.body.id);
  });

  it('allows replying once the recipient has written, even without a follow', async () => {
    const { alice, bob, f } = await world();
    await f.dmPolicy(bob.id, 'everyone'); // anyone may message bob; alice keeps "following"
    const conv = (await alice.post('/api/conversations', { handle: 'bob' })).body;

    // Bob can't write first: alice doesn't follow him and hasn't written yet.
    const early = await bob.post(`/api/conversations/${conv.id}/messages`, { body: 'hey?' });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('dm_not_allowed');
    expect((await bob.get(`/api/conversations/${conv.id}`)).body.canSend).toBe(false);

    expect((await alice.post(`/api/conversations/${conv.id}/messages`, { body: 'Hi Bob!' })).status).toBe(201);
    const reply = await bob.post(`/api/conversations/${conv.id}/messages`, { body: 'Hi Alice' });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ conversationId: conv.id, senderId: bob.id, body: 'Hi Alice' });
    expect((await bob.get(`/api/conversations/${conv.id}`)).body.canSend).toBe(true);
    // Bob can also "open" the existing conversation now.
    expect((await bob.post('/api/conversations', { handle: 'alice' })).body.id).toBe(conv.id);
  });

  it('enforces dmPolicy "nobody", blocks (either way), suspension and self-messaging', async () => {
    const { alice, bob, user, f } = await world();
    const carol = await user('carol');
    await f.dmPolicy(carol.id, 'nobody');
    const r = await alice.post('/api/conversations', { handle: 'carol' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('dm_not_allowed');

    await f.dmPolicy(bob.id, 'everyone');
    await f.dmPolicy(alice.id, 'everyone');
    const conv = (await alice.post('/api/conversations', { handle: 'bob' })).body;
    expect((await alice.post(`/api/conversations/${conv.id}/messages`, { body: 'before block' })).status).toBe(201);

    await f.block(bob.id, alice.id);
    for (const [from, to] of [[alice, 'bob'], [bob, 'alice']] as const) {
      const blocked = await from.post('/api/conversations', { handle: to });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('dm_not_allowed');
      const send = await from.post(`/api/conversations/${conv.id}/messages`, { body: 'hello?' });
      expect(send.status).toBe(403);
      expect((await from.get(`/api/conversations/${conv.id}`)).body.canSend).toBe(false);
    }
    // History stays readable to members.
    expect((await alice.get(`/api/conversations/${conv.id}/messages`)).body.items).toHaveLength(1);

    const dan = await user('dan');
    await f.dmPolicy(dan.id, 'everyone');
    const dconv = (await alice.post('/api/conversations', { handle: 'dan' })).body;
    await f.suspend(dan.id);
    expect((await alice.post('/api/conversations', { handle: 'dan' })).status).toBe(403);
    expect((await alice.post(`/api/conversations/${dconv.id}/messages`, { body: 'x' })).status).toBe(403);
    expect((await alice.get('/api/conversations')).body.items.find((c: any) => c.id === dconv.id).canSend).toBe(false);

    expect((await alice.post('/api/conversations', { handle: 'alice' })).status).toBe(400);
    expect((await alice.post('/api/conversations', { handle: 'nobody_here' })).status).toBe(404);
  });

  it('returns 404 (never 403) to non-members on every conversation endpoint', async () => {
    const { alice, bob, user, f } = await world();
    const mallory = await user('mallory');
    await f.dmPolicy(bob.id, 'everyone');
    const conv = (await alice.post('/api/conversations', { handle: 'bob' })).body;
    const msg = (await alice.post(`/api/conversations/${conv.id}/messages`, { body: 'private words' })).body;

    for (const id of [conv.id, 'does-not-exist']) {
      expect((await mallory.get(`/api/conversations/${id}`)).status).toBe(404);
      expect((await mallory.get(`/api/conversations/${id}/messages`)).status).toBe(404);
      expect((await mallory.get(`/api/conversations/${id}/messages?after=${msg.id}`)).status).toBe(404);
      expect((await mallory.post(`/api/conversations/${id}/messages`, { body: 'let me in' })).status).toBe(404);
      expect((await mallory.post(`/api/conversations/${id}/read`)).status).toBe(404);
    }
    expect((await mallory.get('/api/conversations')).body.items).toEqual([]);
    const count = await mallory.get('/api/me/unread');
    expect(count.body.messages).toBe(0);
  });

  it('tracks unread counts and read markers', async () => {
    const { alice, bob, f } = await world();
    await f.dmPolicy(bob.id, 'everyone');
    const conv = (await alice.post('/api/conversations', { handle: 'bob' })).body;
    await alice.post(`/api/conversations/${conv.id}/messages`, { body: 'one' });
    await alice.post(`/api/conversations/${conv.id}/messages`, { body: 'two' });

    const bobList = await bob.get('/api/conversations');
    expect(bobList.body.items).toHaveLength(1);
    expect(bobList.body.items[0]).toMatchObject({ id: conv.id, unread: 2, other: { handle: 'alice' } });
    expect(bobList.body.items[0].lastMessage.body).toBe('two');
    expect((await bob.get('/api/me/unread')).body.messages).toBe(2);
    // The sender's own messages never count as unread.
    expect((await alice.get(`/api/conversations/${conv.id}`)).body.unread).toBe(0);

    expect((await bob.post(`/api/conversations/${conv.id}/read`)).body).toEqual({ ok: true });
    expect((await bob.get(`/api/conversations/${conv.id}`)).body.unread).toBe(0);
    expect((await bob.get('/api/me/unread')).body.messages).toBe(0);

    await tick();
    await alice.post(`/api/conversations/${conv.id}/messages`, { body: 'three' });
    expect((await bob.get(`/api/conversations/${conv.id}`)).body.unread).toBe(1);
    // Replying marks the conversation read for the sender.
    await tick();
    await bob.post(`/api/conversations/${conv.id}/messages`, { body: 'got it' });
    expect((await bob.get(`/api/conversations/${conv.id}`)).body.unread).toBe(0);
    expect((await alice.get(`/api/conversations/${conv.id}`)).body.unread).toBe(1);
  });

  it('polls with ?after= (oldest first) and pages back with ?cursor (newest first)', async () => {
    const { alice, bob, f } = await world();
    await f.dmPolicy(bob.id, 'everyone');
    const conv = (await alice.post('/api/conversations', { handle: 'bob' })).body;
    const sent: any[] = [];
    for (let i = 0; i < 30; i++) sent.push((await alice.post(`/api/conversations/${conv.id}/messages`, { body: `m${i}` })).body);

    const p1 = await bob.get(`/api/conversations/${conv.id}/messages`);
    expect(p1.body.items.map((m: any) => m.body)).toEqual(sent.slice(5).reverse().map((m) => m.body));
    const p2 = await bob.get(`/api/conversations/${conv.id}/messages?cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((m: any) => m.body)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0']);
    expect(p2.body.nextCursor).toBeNull();

    const polled = await bob.get(`/api/conversations/${conv.id}/messages?after=${sent[26].id}`);
    expect(polled.body.items.map((m: any) => m.body)).toEqual(['m27', 'm28', 'm29']);
    const none = await bob.get(`/api/conversations/${conv.id}/messages?after=${sent[29].id}`);
    expect(none.body.items).toEqual([]);
  });

  it('validates message bodies (1–2000 graphemes after cleanup)', async () => {
    const { alice, bob, f } = await world();
    await f.dmPolicy(bob.id, 'everyone');
    const conv = (await alice.post('/api/conversations', { handle: 'bob' })).body;
    const url = `/api/conversations/${conv.id}/messages`;
    expect((await alice.post(url, { body: '   \n  ' })).status).toBe(422);
    expect((await alice.post(url, {})).status).toBe(422);
    expect((await alice.post(url, { body: 'x'.repeat(2001) })).status).toBe(422);
    expect((await alice.post(url, { body: '😀'.repeat(2000) })).status).toBe(201);
    const cleaned = await alice.post(url, { body: '  hi\u0000 there\n\n\n\nbye  ' });
    expect(cleaned.body.body).toBe('hi there\n\nbye');
  });

  it('orders the inbox by most recent activity', async () => {
    const { alice, bob, user, f } = await world();
    const carol = await user('carol');
    await f.dmPolicy(bob.id, 'everyone');
    await f.dmPolicy(carol.id, 'everyone');
    const cb = (await alice.post('/api/conversations', { handle: 'bob' })).body;
    const cc = (await alice.post('/api/conversations', { handle: 'carol' })).body;
    await tick();
    await alice.post(`/api/conversations/${cc.id}/messages`, { body: 'to carol' });
    await tick();
    await alice.post(`/api/conversations/${cb.id}/messages`, { body: 'to bob' });
    const list = await alice.get('/api/conversations');
    expect(list.body.items.map((c: any) => c.other.handle)).toEqual(['bob', 'carol']);
    expect(list.body.nextCursor).toBeNull();
  });

  it('rate-limits sending to 60 messages per 10 minutes', async () => {
    const { alice, bob, f } = await world({ DISABLE_RATE_LIMITS: 'false' });
    await f.dmPolicy(bob.id, 'everyone');
    const conv = (await alice.post('/api/conversations', { handle: 'bob' })).body;
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await alice.post(`/api/conversations/${conv.id}/messages`, { body: `n${i}` })).status;
    expect(last).toBe(429);
  });
});
