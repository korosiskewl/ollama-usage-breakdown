# Progress & status

_Last updated: 2026-10-09 — Relay 3.0.0-alpha.1_

## Verified

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm test` (vitest, real Hono app against SQLite) | ✅ 81 / 81 tests, 10 suites |
| `npx vite build` (Worker SPA) | ✅ — and contains **no** preview runtime / WASM |
| `npm run build:pages` (GitHub Pages preview) | ✅ |
| Browser smoke test of the preview build (Playwright/Chromium) | ✅ 18 / 18 steps, 0 console errors |

The browser smoke test covered: boot and demo seed, Explore, signed-out home, thread view, reading view, sign-up,
posting with mention + link, persistence across reload, follow → home feed, optimistic like, replying, search,
notifications, a two-sided DM exchange (send as one user, sign in as the other, read and reply), settings with a
dark-mode switch, the moderation queue as admin, a collection page, and no horizontal scroll at 375px and 320px.

## Not verified

- **The Cloudflare deployment itself.** `wrangler deploy` has not been run (no account access from the build
  environment). The Worker entry, `wrangler.jsonc` and migrations are written for it, and the identical app code is
  what the tests and preview exercise, but D1/R2 behaviour in production is untested.
- **Real AI calls.** The assistant is tested against a mocked Anthropic API only.
- **Relay 2.0.** Its live site could not be reached from the build environment, so nothing in 3.0 is based on
  observing it.
- Screen-reader pass (VoiceOver/NVDA), Safari/Firefox, and load testing.

## Done (release 1)

- [x] Auth: sign-up, login, logout, sessions list/revoke, password change, account deletion
- [x] Profiles, avatars (R2 or DB fallback), bios, private accounts, follow requests
- [x] Posts, replies, threads, edit, delete with placeholders, mentions, links
- [x] Likes, reposts (optimistic + rollback)
- [x] Chronological home feed, Explore (latest + active conversations), cursor pagination
- [x] Search (people, posts) with escaping, rate limits, privacy filtering
- [x] Notifications with grouping, read state, preferences, follow-request handling
- [x] Direct messages (1:1), DM policy, read state, 4s polling, unread badges
- [x] Block, mute, muted words, reports, moderation queue, removals, suspensions, action log
- [x] The Dial (feed controls), reading view, collections
- [x] Optional AI assist (Anthropic SDK, server-side key, opt-in, never auto-posts)
- [x] Light/dark themes, reading size & font, responsive to 320px
- [x] GitHub Pages preview build, CI workflow, manual Worker deploy workflow

## Next

1. Deploy the Worker to a staging Cloudflare account and run the smoke test against it.
2. Real-time via Durable Objects + WebSockets (replace polling).
3. Interest Spaces (topic rooms) — see BRIEF.md.
4. Edit history, image attachments on posts, link previews.
5. Email verification & password reset (needs an email provider).
6. FTS5 search; denormalised counters if D1 latency requires it.
7. Accessibility audit with real assistive tech; Safari/Firefox QA.

## Log

- **2026-10-09** — Repository reset and Relay 3.0 built from scratch: schema, auth, API (81 tests), design system,
  full UI, in-browser preview runtime, workflows, docs. Fixed during integration: production bundle shipping the
  preview runtime; preview writes not being durable before a quick reload; Messages layout too narrow; demo accounts
  not reachable by DM.
