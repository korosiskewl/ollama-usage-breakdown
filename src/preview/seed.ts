// Sample content for the in-browser preview only. Never runs against a real deployment.
// Demo accounts are labelled in their bios and share the password below so testers can sign in as them.
import { extractMentions } from '../../shared/limits';
import { newId } from '../../server/db';
import type { SqlJsD1 } from '../../server/sqljs-d1';

export const DEMO_PASSWORD = 'relay-preview-demo';

const USERS = [
  { handle: 'mara_writes', displayName: 'Mara Okafor', bio: 'Essays on slow media, attention and the small web. Demo account · preview only.' },
  { handle: 'juno_reads', displayName: 'Juno Park', bio: 'Librarian. I collect good threads the way other people collect stamps. Demo account · preview only.' },
  { handle: 'kwame_codes', displayName: 'Kwame Mensah', bio: 'Edge computing, SQLite, and tools that respect your time. Demo account · preview only.' },
  { handle: 'ines_grows', displayName: 'Inês Duarte', bio: 'Balcony gardener in Lisbon. Tomatoes, mostly. Demo account · preview only.' },
  { handle: 'tobias_lind', displayName: 'Tobias Lind', bio: 'I build keyboards and fix old radios. Demo account · preview only.' },
  { handle: 'relaynotes', displayName: 'Relay Notes', bio: 'Release notes and changelog for Relay. Demo account · preview only.' },
] as const;

type Handle = (typeof USERS)[number]['handle'];

export async function seed(fetchApp: (req: Request) => Response | Promise<Response>, db: SqlJsD1): Promise<void> {
  const ids = {} as Record<Handle, string>;
  for (const u of USERS) {
    const res = await fetchApp(
      new Request('https://preview.relay.local/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-relay-client': '1' },
        body: JSON.stringify({ handle: u.handle, displayName: u.displayName, password: DEMO_PASSWORD }),
      }),
    );
    const data = (await res.json()) as { user: { id: string } };
    ids[u.handle] = data.user.id;
  }
  const raw = db.raw;
  // Demo accounts are ordinary users; the visitor's first own account becomes admin.
  raw.run("UPDATE users SET role = 'user'");
  for (const u of USERS) raw.run('UPDATE users SET bio = ? WHERE id = ?', [u.bio, ids[u.handle]]);
  raw.run('DELETE FROM sessions');

  const now = Date.now();
  const H = 3600_000;
  const at = (hoursAgo: number) => Math.round(now - hoursAgo * H);

  const roots = new Map<string, string>();
  function post(author: Handle, hoursAgo: number, body: string, replyTo?: string): string {
    const ts = at(hoursAgo);
    const id = newId(ts);
    const root = replyTo ? roots.get(replyTo)! : id;
    roots.set(id, root);
    raw.run('INSERT INTO posts (id, author_id, body, reply_to_id, root_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id, ids[author], body, replyTo ?? null, root, ts,
    ]);
    for (const h of extractMentions(body)) {
      const target = (Object.keys(ids) as Handle[]).find((k) => k.toLowerCase() === h);
      if (target) raw.run('INSERT OR IGNORE INTO mentions (post_id, user_id) VALUES (?, ?)', [id, ids[target]]);
    }
    return id;
  }
  const follow = (a: Handle, b: Handle, hoursAgo = 200) =>
    raw.run('INSERT OR IGNORE INTO follows (follower_id, followee_id, state, created_at) VALUES (?, ?, ?, ?)', [ids[a], ids[b], 'active', at(hoursAgo)]);
  const like = (u: Handle, p: string, hoursAgo: number) =>
    raw.run('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)', [ids[u], p, at(hoursAgo)]);
  const repost = (u: Handle, p: string, hoursAgo: number) =>
    raw.run('INSERT OR IGNORE INTO reposts (user_id, post_id, created_at) VALUES (?, ?, ?)', [ids[u], p, at(hoursAgo)]);

  for (const a of Object.keys(ids) as Handle[]) for (const b of Object.keys(ids) as Handle[]) if (a !== b && (a === 'juno_reads' || b === 'mara_writes' || b === 'relaynotes' || (a.length + b.length) % 3 !== 0)) follow(a, b);

  // Welcome note.
  const welcome = post(
    'relaynotes',
    0.5,
    'Welcome to the Relay 3.0 preview.\n\nEverything here runs in your browser — the same server code that powers Relay, on SQLite compiled to WebAssembly. Nothing leaves this device.\n\nMake an account, follow a few people, try the reading view on a long thread, and save the good stuff to a collection.',
  );

  // A long self-thread for the reading view.
  const m1 = post('mara_writes', 30, 'A thread on why I think social feeds should be boring again — in the best way. 🧵');
  const m2 = post('mara_writes', 29.9, 'When a feed is chronological, you can finish it. That sounds small. It isn’t. “Caught up” is a feeling most apps are engineered to make impossible.', m1);
  const m3 = post('mara_writes', 29.8, 'Ranking decides what you see by predicting what keeps you scrolling. Chronology decides by asking who you chose to hear from. One of those treats you as an adult.', m2);
  const m4 = post('mara_writes', 29.7, 'The usual objection: “but you’ll miss things.” Yes. You will miss things. You were always going to miss things. The question is whether you or a model gets to choose which.', m3);
  const m5 = post('mara_writes', 29.6, 'What I want instead: a feed I can tune myself. Hide replies when I’m skimming. Mute words during a sports final. Turn off the numbers when they start to matter too much.', m4);
  const m6 = post('mara_writes', 29.5, 'And a way to keep the good conversations — not as bookmarks that rot, but as small shelves other people can browse. Libraries, not landfills.\n\n(Yes, @juno_reads, this one’s for you.)', m5);
  const r1 = post('juno_reads', 28, 'Saving this whole thread to my “On attention” shelf. The libraries-not-landfills line is going on a sticky note.', m6);
  const r2 = post('kwame_codes', 27.5, 'The “you can finish it” point is underrated. I close the app more often on chronological feeds, and I’m happier for it.', m2);
  post('mara_writes', 27, '@kwame_codes exactly. Finishing is a feature.', r2);
  post('tobias_lind', 26, 'Counterpoint: I like discovering strangers. But I’d rather do it on purpose, in a separate place, than have it mixed into the people I follow.', m4);
  post('mara_writes', 25, 'That’s fair, and it’s why I like having Explore as its own room. Discovery when you ask for it.', r1);

  // Everyday posts.
  const k1 = post('kwame_codes', 20, 'Moved a side project from Postgres to SQLite at the edge. Cold starts went from “noticeable” to “what cold start”. Read replicas are doing a lot of quiet work.');
  post('ines_grows', 19, 'First tomato of the season on the balcony. It is the size of a marble and I am unreasonably proud of it. 🍅');
  const t1 = post('tobias_lind', 16, 'Restored a 1962 Grundig radio this weekend. The trick with old capacitors: don’t just power it on. Bring it up slowly on a variac or you will meet the magic smoke.');
  const i2 = post('ines_grows', 12, 'Question for the gardeners: what’s your fix for aphids that doesn’t involve spraying anything? I’ve tried soapy water and patience. Patience is losing.');
  const i2a = post('juno_reads', 11.5, 'Ladybird larvae! A garden centre near me sells them. They look like tiny alligators and eat everything.', i2);
  post('tobias_lind', 11, 'Nasturtiums as a trap crop worked for my mum. The aphids go for those first.', i2);
  post('ines_grows', 10.5, '@juno_reads tiny alligators is selling me on this immediately.', i2a);
  const j1 = post('juno_reads', 8, 'Reading list for the week: a history of card catalogues, an essay on marginalia, and a novel set entirely in a lighthouse. Suggestions welcome — long, quiet, strange.');
  post('kwame_codes', 6, 'Reminder that you can probably delete half your dependencies. I removed an icon library and a date library today and the bundle shrank by a third. Intl.RelativeTimeFormat is right there.');
  post('mara_writes', 4, 'Drafting a piece about “quiet features” — the things software does well that nobody notices. Undo. Drafts that survive a crash. A back button that goes back. What are yours?');
  post('tobias_lind', 2, 'Hot take: every app should have a “reading size” setting. My eyes are 41 years old and they would like a word.');
  const n2 = post('relaynotes', 1, 'New in 3.0: collections. Save posts to shelves, add a margin note on why each one matters, and share the shelf — or keep it private.');

  // Reposts and likes.
  repost('juno_reads', m1, 27);
  repost('kwame_codes', m1, 26);
  repost('ines_grows', t1, 14);
  repost('mara_writes', n2, 0.8);
  repost('tobias_lind', welcome, 0.3);
  for (const [u, p, h] of [
    ['juno_reads', m6, 28], ['kwame_codes', m3, 27], ['tobias_lind', m3, 26], ['ines_grows', m6, 25], ['mara_writes', r2, 26],
    ['mara_writes', k1, 19], ['juno_reads', k1, 18], ['tobias_lind', i2, 11], ['mara_writes', t1, 15], ['kwame_codes', j1, 7],
    ['ines_grows', j1, 7], ['mara_writes', j1, 6], ['juno_reads', welcome, 0.4], ['kwame_codes', welcome, 0.2],
  ] as [Handle, string, number][]) like(u, p, h);

  // Notifications that would have been produced for the demo accounts.
  const notif = (to: Handle, actor: Handle, type: string, postId: string | null, h: number, read = true) =>
    raw.run('INSERT INTO notifications (id, user_id, actor_id, type, post_id, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      newId(at(h)), ids[to], ids[actor], type, postId, at(h), read ? at(h - 0.1) : null,
    ]);
  notif('mara_writes', 'juno_reads', 'mention', m6, 29.5);
  notif('mara_writes', 'juno_reads', 'reply', r1, 28, false);
  notif('mara_writes', 'kwame_codes', 'reply', r2, 27.5, false);
  notif('mara_writes', 'kwame_codes', 'like', m3, 27, false);
  notif('mara_writes', 'tobias_lind', 'like', m3, 26, false);
  notif('ines_grows', 'juno_reads', 'reply', i2a, 11.5, false);

  // A collection.
  const cid = newId(at(27));
  raw.run('INSERT INTO collections (id, owner_id, title, description, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', [
    cid, ids.juno_reads, 'On attention', 'Threads about how we spend our attention online, and how we might spend it better.', at(27), at(7),
  ]);
  const item = (p: string, note: string, h: number) =>
    raw.run('INSERT INTO collection_items (collection_id, post_id, note, added_at) VALUES (?, ?, ?, ?)', [cid, p, note, at(h)]);
  item(m1, 'The clearest case for chronological feeds I’ve read. Start here, then open the reading view.', 27);
  item(r2, 'A practitioner’s confirmation of the “you can finish it” idea.', 26);
  item(k1, 'Not strictly about attention — but fast software is respectful software.', 7);

  // A direct conversation between two demo accounts.
  const conv = newId(at(9));
  const [a, b] = [ids.mara_writes, ids.juno_reads].sort();
  raw.run('INSERT INTO conversations (id, pair_key, created_at, updated_at) VALUES (?, ?, ?, ?)', [conv, `${a}:${b}`, at(9), at(8.5)]);
  raw.run('INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?, ?, ?), (?, ?, ?)', [
    conv, ids.mara_writes, at(8.6), conv, ids.juno_reads, at(8.5),
  ]);
  const msg = (from: Handle, body: string, h: number) =>
    raw.run('INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)', [newId(at(h)), conv, ids[from], body, at(h)]);
  msg('juno_reads', 'Loved the thread. Would you mind if I used it in a workshop on information literacy next month?', 9);
  msg('mara_writes', 'Not at all — I’d be honoured. Send me the slides after?', 8.7);
  msg('juno_reads', 'Deal. I’ll put the collection link on the last slide too.', 8.5);
}
