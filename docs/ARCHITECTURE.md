# Architecture

```
┌──────────────── browser ────────────────┐        ┌──────── Cloudflare ─────────┐
│ React 19 SPA (src/)                     │  /api  │ Worker: Hono app (server/)  │
│  lib/api.ts ── fetch ───────────────────┼───────▶│  ├─ D1 (SQLite)  migrations/│
│                                         │        │  └─ R2 (avatars)            │
│  PREVIEW build only:                    │        └─────────────────────────────┘
│  lib/api.ts ─▶ preview/runtime.ts       │
│               └─ same Hono app          │
│                  + sql.js (WASM SQLite) │
│                  + IndexedDB persistence│
└─────────────────────────────────────────┘
```

**One codebase, two targets.**

- **Production (multi-user):** Cloudflare Worker serves `/api/*` (Hono) and the built SPA via Workers Static Assets.
  Data in D1, avatars in R2, sessions as HttpOnly cookies.
- **Preview (GitHub Pages):** static hosting cannot run a server, so the Pages build bundles the *same* Hono app and
  runs it in the browser against SQLite compiled to WebAssembly (sql.js), persisted in IndexedDB. Each visitor gets
  a private sandbox seeded with clearly-labelled demo accounts. It exercises every real code path (validation,
  authorization, SQL) but is single-device by nature. It is a demo, not the product's storage layer.

## Layout

| Path | What |
|---|---|
| `shared/types.ts` | API contract types used by both sides |
| `shared/limits.ts` | validation limits, grapheme counting, mention parsing |
| `migrations/*.sql` | D1 schema (applied by wrangler in prod, by the runtime in preview, by tests) |
| `server/app.ts` | Hono app factory, middleware, error handling |
| `server/auth.ts` | PBKDF2 password hashing, sessions, CSRF |
| `server/social.ts` | visibility rules, post hydration, settings, notifications — the privacy core |
| `server/routes/*.ts` | one module per feature area |
| `server/sqljs-d1.ts` | D1-compatible adapter over sql.js (tests + preview) |
| `server/worker.ts` | Cloudflare entry + scheduled cleanup |
| `src/lib/` | API client, hash router, session, prefs, toasts, composer controller, pagination hook |
| `src/components/` | shared UI (PostItem, Composer, Shell, dialogs, …) |
| `src/pages/` | one component per route |
| `src/preview/` | in-browser runtime and demo seed (preview build only; tree-shaken from production) |
| `tests/` | vitest suites that run the real app against sql.js |

## Key decisions

- **Hash routing.** Works unchanged on GitHub Pages under any repo name and on the Worker; no 404 tricks needed for
  deep links. Trade-off: `#/` in URLs.
- **Sessions:** random 256-bit token in an HttpOnly, Secure, SameSite=Lax cookie; only its SHA-256 is stored. 30-day
  sliding expiry. Password change revokes other sessions. Sessions list + revoke in Settings.
- **Passwords:** PBKDF2-SHA256, 100k iterations (Workers' WebCrypto maximum), 16-byte salt, constant-time compare,
  dummy hash on unknown handles to avoid user enumeration by timing.
- **CSRF:** every non-GET needs `X-Relay-Client: 1` and a same-origin `Origin` when present.
- **Privacy in one place:** `visibleAuthorSql()` encodes "active, not blocked either way, public or approved
  follower" and every list query uses it; `hydratePosts()` turns invisible posts into `unavailable` placeholders.
- **Deleted content:** soft delete keeps the row as a placeholder so replies keep their context; bodies are cleared.
- **IDs:** ULID-style time-sortable ids, so `ORDER BY id` is chronological and cursors are simple.
- **Counts** are computed with indexed subqueries rather than denormalised counters: always correct; revisit if
  D1 latency demands it.
- **Rate limits** are fixed windows in a D1 table — adequate for one region; move to the Workers Rate Limiting
  binding at scale.
- **Real-time:** polling (`/me/unread` every 30s, open conversation every 4s). Durable Objects + WebSockets later.
- **AI:** server-side call to Anthropic's Messages API with the key from a Worker secret; per-user opt-in;
  user content is delimited and treated as data; nothing posts automatically.
- **Dependencies:** react, react-dom, hono, zod, sql.js (preview/tests only), self-hosted fonts. No UI kit, no state
  library, no router library.
