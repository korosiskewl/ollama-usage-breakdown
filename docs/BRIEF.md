# Relay 3.0 — product brief

**Relay is an independent, ad-free, text-first social platform.** 3.0 is a ground-up rebuild that keeps 2.0's
identity (posts, threads, DMs, optional AI, no ads) and adds the things that make a small network worth staying on.

## What we could verify about Relay 2.0

The 2.0 site (`relay.wolfroastz.workers.dev`) could **not** be inspected from the build environment: the host was
blocked by the sandbox's network policy. The original source is unavailable (`relay-cloud` is an empty repository).
Everything about 2.0 below comes from the founder's description, not observation:

- Stack: React 19, Cloudflare Workers, Hono, D1, R2.
- Text-first, no advertisements; posts, threads, direct messages, optional AI assistance.

## Principles

1. No ads, no engagement-optimised ranking, no dark patterns. Feeds are chronological and finishable.
2. The reader is in control: feed dial, muted words, hidden counts, reading size and font.
3. AI is opt-in per account, clearly labelled, never posts on its own, and keys never reach the browser.
4. Privacy and safety by default: private accounts, blocks that actually block, DM policies, reports with a real
   moderation queue, rate limits.
5. Small, maintainable codebase: one TypeScript project, few dependencies, the same server code everywhere.

## Release 1 scope (this build)

Auth & sessions · profiles & avatars · private accounts & follow requests · posts, replies, threads, edit, delete
with placeholders · likes & reposts · mentions & links · chronological home feed with pagination · Explore (latest +
active conversations) · search · notifications with grouping & preferences · 1:1 direct messages with read state ·
block, mute, report, moderation queue & suspension · settings · optional AI assist · light/dark themes.

## Distinctive features — what we chose and why

| Idea | Chosen? | Why |
|---|---|---|
| **The Dial** — personal feed controls (replies/reposts toggles, muted words, hide counts) | ✅ | Cheap to build, immediately useful, and the clearest expression of "your feed, your rules". |
| **Reading view** — a long self-thread rendered as one continuous piece | ✅ | Text-first platforms live or die on long-form threads; this makes them pleasant to read and share. Low cost: one endpoint + one page. |
| **Collections** — public or private shelves of posts with a margin note per item | ✅ | "Preserve and revisit useful discussions." Turns bookmarks into something curated and shareable, without algorithms. |
| **Active conversations** in Explore, ordered by recent replies (not likes) | ✅ | Discovery without engagement ranking. |
| **Reading personalisation** — text size, serif/sans, theme | ✅ | Accessibility win for very little code. |
| Interest **Spaces** (topic rooms) | ⏭ later | Valuable but needs membership, moderation scoping and its own feed — too big to do well in release 1. |
| Edit history, scheduled posts, polls | ⏭ later | Nice, not core. |
| Real-time WebSockets | ⏭ later | Needs Durable Objects; polling is reliable today. |

## Not doing

Ads, trending/virality ranking, follower-count leaderboards, streaks, AI-generated posts, infinite autoplay media.
