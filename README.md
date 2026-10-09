# Relay

**An independent, ad-free, text-first social network.** Chronological feeds you can finish, controls that belong to
the reader, and an AI assistant that only shows up when you ask for it.

Relay 3.0 is a ground-up rebuild: React 19 + TypeScript on the front, Hono on Cloudflare Workers with D1 and R2 on
the back, and the same server code compiled into a fully working in-browser preview for GitHub Pages.

> **Status: 3.0 alpha.** Feature-complete first release, tested at the API level, not yet battle-tested in
> production. See [docs/PROGRESS.md](docs/PROGRESS.md) for exactly what is done and verified.

## Try it

- **Preview (GitHub Pages):** **https://korosiskewl.github.io/ollama-usage-breakdown/** (becomes `…/relay/` if the repo is renamed — the build works under any name). Runs entirely in your browser
  (WebAssembly SQLite + IndexedDB). Your data never leaves your device. Demo accounts are sample content; their
  password is `relay-preview-demo`. The first account you create becomes an admin so you can try moderation.
- **Real multi-user deployment:** a Cloudflare Worker + D1. See [docs/DEPLOY.md](docs/DEPLOY.md).

## What's in 3.0

- Posts, replies, threads, edit, delete with context-preserving placeholders, mentions, links
- Likes and reposts with optimistic UI and rollback
- Chronological **home feed**, **Explore** (latest + active conversations), search for people and posts
- Profiles, avatars, follow/unfollow, **private accounts** with follow requests
- **Direct messages** (1:1) with read state and live polling, plus per-account DM policy
- **Notifications** with grouping and per-type preferences
- **Safety:** block, mute, muted words, reports, moderation queue, removals, suspensions, action log, rate limits
- **The Dial:** per-reader feed controls (replies, reposts, hidden counts, muted words)
- **Reading view:** long self-threads rendered as one continuous piece
- **Collections:** public or private shelves of posts with a margin note on each
- **Optional AI:** improve, shorten, clarify or summarise a thread. Off by default, server-side keys, never auto-posts
- Light and dark themes, adjustable reading size and font, keyboard and screen-reader friendly, works at 320px

## Develop

```bash
npm install
npm test                               # API tests against in-memory SQLite
VITE_RELAY_MODE=preview npm run dev    # full app in the browser, no Cloudflare needed
```

Docs: [Product brief](docs/BRIEF.md) · [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) ·
[Design system](docs/DESIGN.md) · [Deploy](docs/DEPLOY.md) · [Progress](docs/PROGRESS.md)

## License

MIT
