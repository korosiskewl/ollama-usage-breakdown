# Relay 3.0 HTTP API

All endpoints live under `/api`. Types referenced here are defined in `shared/types.ts`; limits in `shared/limits.ts`.

## Conventions

- JSON in, JSON out. Timestamps are ISO strings.
- **Every non-GET request must send `X-Relay-Client: 1`** (CSRF defence). Cross-origin `Origin` headers are rejected.
- Auth is an HttpOnly `relay_session` cookie set by signup/login.
- Errors: `{ "error": { "code": string, "message": string, "fields"?: { [field]: message } } }`.
  Status codes: 400 bad input, 401 signed out (`unauthorized`), 403 forbidden / `suspended` / `csrf`, 404 `not_found`,
  409 conflict (`handle_taken`, …), 413 too large, 415 bad media type, 422 `validation_failed` (with `fields`),
  429 `rate_limited` (with `Retry-After`), 503 `ai_unavailable`.
- Pagination: list endpoints return `Page<T> = { items, nextCursor }`. Pass `?cursor=<nextCursor>` for the next page.
  `nextCursor` is `null` at the end. Cursors are opaque strings. Page size 25 unless noted.
- Content from blocked users (either direction) and from private accounts the viewer is not approved to follow is
  never returned. In threads such posts appear as `unavailable: true` placeholders. Suspended users' content is hidden
  from lists; their profile returns with `suspended: true` and no posts.
- Muted users are excluded from feeds, search, explore and notifications, but still visible on their own profile and in
  threads. Muted words (settings) filter feed/explore/search items server-side.

## Auth & account — `server/routes/auth.ts` (done)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | /auth/signup | `{handle, displayName, password}` | 201 `{user: Me}` |
| POST | /auth/login | `{handle, password}` | `{user: Me}` |
| POST | /auth/logout | – | `{ok}` |
| GET | /auth/me | – | `{user: Me \| null}` |
| GET | /me/unread | – | `Unread` (poll every ~30s) |
| POST | /auth/password | `{currentPassword, newPassword}` | `{ok}` (other sessions revoked) |
| GET | /auth/sessions | – | `{items: SessionInfo[]}` |
| DELETE | /auth/sessions/:id | – | `{ok}` |
| POST | /auth/delete-account | `{password}` | `{ok}` |

## Profiles & graph — `server/routes/users.ts`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | /users/:handle | – | `Profile` (404 if missing/deleted; blocked-by-them → 404) |
| PATCH | /me/profile | `{displayName?, bio?, isPrivate?}` | `{user: Me}`. Switching private→public auto-accepts pending requests. |
| POST | /me/avatar | raw image body (`Content-Type: image/png\|jpeg\|webp\|gif`, ≤ 1 MB) | `{avatarUrl}` |
| DELETE | /me/avatar | – | `{ok}` |
| GET | /media/:key | – | image bytes, `Cache-Control: public, max-age=31536000, immutable` |
| GET | /users/:handle/followers | – | `Page<UserSummary>` (private account: only owner/approved followers, else 403) |
| GET | /users/:handle/following | – | `Page<UserSummary>` (same rule) |
| POST | /users/:handle/follow | – | `{state: 'active' \| 'pending'}` (pending when target is private). Notifies `follow` or `follow_request`. Blocked → 403. |
| DELETE | /users/:handle/follow | – | `{state: 'none'}` (also cancels a pending request) |
| GET | /me/follow-requests | – | `Page<UserSummary>` |
| POST | /me/follow-requests/:userId/accept | – | `{ok}` (notifies requester `follow_accept`) |
| POST | /me/follow-requests/:userId/decline | – | `{ok}` |
| DELETE | /me/followers/:userId | – | `{ok}` remove a follower |
| POST / DELETE | /users/:handle/block | – | `{blocking: boolean}`. Blocking removes follows both ways. |
| POST / DELETE | /users/:handle/mute | – | `{muting: boolean}` |
| GET | /me/blocks | – | `Page<UserSummary>` |
| GET | /me/mutes | – | `Page<UserSummary>` |

## Posts — `server/routes/posts.ts`

| Method | Path | Body | Response |
|---|---|---|---|
| POST | /posts | `{body, replyToId?}` | 201 `Post`. Body 1–500 graphemes after trim. Replying to a deleted/unavailable post → 404/403. Creates `mentions` rows (only for existing, non-blocked users) and notifications (`reply` to parent author, `mention` to mentioned users — no double notify). Rate limit 30 / 10 min. |
| GET | /posts/:id | – | `Post` |
| GET | /posts/:id/thread | `?cursor` (replies) | `Thread` – ancestors root-first, direct replies oldest-first, replies from muted users excluded |
| GET | /posts/:id/reader | – | `ReaderView` – the root of `:id`'s conversation plus the root author's own consecutive self-reply chain |
| PATCH | /posts/:id | `{body}` | `Post` (author only, sets `editedAt`, mentions re-parsed but no new notifications) |
| DELETE | /posts/:id | – | `{ok}` author or moderator. Soft delete: body cleared, `deleted_at` set (moderator sets `removed_by_mod`, logs `moderation_actions`). Replies keep pointing at the placeholder. |
| POST / DELETE | /posts/:id/like | – | `{liked, likes}` (notify `like`) |
| POST / DELETE | /posts/:id/repost | – | `{reposted, reposts}` (notify `repost`). Cannot repost private-account posts. |
| GET | /posts/:id/likes | – | `Page<UserSummary>` |

## Feeds — `server/routes/feed.ts`

Feeds are **chronological**. There is no engagement ranking.

| Method | Path | Query | Response |
|---|---|---|---|
| GET | /feed/home | `cursor`, `replies=0\|1`, `reposts=0\|1` (default from settings `feedReplies`/`feedReposts`) | `Page<FeedItem>` – own + followed users' posts, plus reposts by followed users. When replies=1, replies are included only when the parent's author is the viewer or someone the viewer follows. |
| GET | /feed/explore | `cursor` | `Page<FeedItem>` – recent public top-level posts from everyone (minus blocked/muted/muted words) |
| GET | /feed/conversations | `cursor` | `Page<{root: Post, replyCount: number, participants: UserSummary[], lastReplyAt: string}>` – roots with replies in the last 7 days, ordered by most recent reply |
| GET | /users/:handle/posts | `cursor`, `tab=posts\|replies` | `Page<FeedItem>` – posts tab: top-level posts + reposts; replies tab: replies only. 403 for private profile the viewer can't see. |

## Search — `server/routes/search.ts`

`GET /search?q=&type=users|posts&cursor` → `Page<UserSummary>` or `Page<Post>`. `q` 2–64 chars (422 otherwise).
Users: handle prefix or display-name substring. Posts: substring match over public, visible, non-deleted posts, newest
first. LIKE wildcards are escaped. Rate limit 60/min per user or IP. A leading `@` searches handles only.

## Notifications — `server/routes/notifications.ts`

| Method | Path | Response |
|---|---|---|
| GET | /notifications?cursor | `Page<NotificationGroup>` newest first. `like`/`repost` on the same post and `follow`s are grouped when adjacent in time order; others are not grouped. Notifications from muted/blocked actors and about deleted posts are skipped. |
| POST | /notifications/read | `{ok}` marks all read |

## Direct messages — `server/routes/messages.ts`

1:1 only in this release. Only members can read or write a conversation (404 otherwise, never 403, to avoid leaking existence).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | /conversations?cursor | – | `Page<ConversationSummary>` ordered by `updatedAt` desc |
| POST | /conversations | `{handle}` | `ConversationSummary` (find or create). 403 `dm_not_allowed` if blocked either way, or the recipient's `dmPolicy` is `nobody`, or `following` and the recipient does not follow the sender. Cannot message yourself (400). |
| GET | /conversations/:id | – | `ConversationSummary` |
| GET | /conversations/:id/messages | `?cursor` (older) or `?after=<messageId>` (newer, for polling, max 100, oldest-first) | `Page<Message>` newest first when paging back |
| POST | /conversations/:id/messages | `{body}` (1–2000) | 201 `Message`. Same permission checks as creation. Rate limit 60 / 10 min. |
| POST | /conversations/:id/read | – | `{ok}` |

Real-time: the client polls `?after=` every 4 s while a conversation is open and `/me/unread` every 30 s. (D1 has no push; Durable Objects + WebSockets are the upgrade path.)

## Moderation — `server/routes/moderation.ts`

| Method | Path | Body | Response |
|---|---|---|---|
| POST | /reports | `{targetType: 'post'\|'user', targetId, reason: ReportReason, details?}` | 201 `{ok}`; duplicate open report → 200 `{ok}`; rate limit 20/hour |
| GET | /mod/reports?status=open\|actioned\|dismissed&cursor | – | `Page<Report>` (moderator/admin only) |
| POST | /mod/reports/:id/resolve | `{action: 'dismiss'\|'remove_post'\|'suspend_user', note?}` | `{ok}`; logs `moderation_actions`; resolves all open reports on the same target |
| POST | /mod/users/:id/suspend, /unsuspend | `{note?}` | `{ok}`. Suspension deletes sessions. Admins can't be suspended by moderators. |
| POST | /mod/users/:id/role | `{role}` | admin only |
| GET | /mod/actions?cursor | – | `Page<{id, moderator: UserSummary, action, note, targetUser: UserSummary\|null, targetPostId, createdAt}>` |

## Collections — `server/routes/collections.ts`

Curated, optionally public shelves of posts with a personal note per item.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | /users/:handle/collections | – | `{items: Collection[]}` (public ones, or all for owner) |
| GET | /me/collections?postId= | – | `{items: Collection[]}` with `containsPost` when postId given |
| POST | /collections | `{title, description?, isPublic?}` | 201 `Collection` (max 100 per user) |
| GET | /collections/:id?cursor | – | `{collection: Collection, items: Page<CollectionItem>}` (private → 404 for others). Items whose post is unavailable to the viewer are omitted; deleted posts show as deleted placeholders. |
| PATCH | /collections/:id | `{title?, description?, isPublic?}` | `Collection` (owner only) |
| DELETE | /collections/:id | – | `{ok}` |
| POST | /collections/:id/items | `{postId, note?}` | `{ok}` (owner only; post must be visible to owner; max 500 items) |
| PATCH | /collections/:id/items/:postId | `{note}` | `{ok}` |
| DELETE | /collections/:id/items/:postId | – | `{ok}` |

## Settings — `server/routes/settings.ts`

`GET /me/settings` → `Settings`. `PATCH /me/settings` with any subset of `Settings` (deep-merge `notify`) → `Settings`.
Muted words are lowercased, trimmed, de-duplicated, each ≤ 40 chars, max 50.

## AI (optional) — `server/routes/ai.ts`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | /ai/status | – | `AiStatus` – `available` is false when `ANTHROPIC_API_KEY` is unset |
| POST | /ai/assist | `{mode: AiMode, text?, postId?}` | `{suggestion: string, model: string}`. Requires sign-in and `settings.aiEnabled`. `improve`/`shorten`/`clarify` take `text` (≤ 500 graphemes); `summarize_thread` takes `postId` and uses only posts visible to the viewer. 503 `ai_unavailable` when unconfigured, 422 `ai_declined` when the model refuses, 502 `ai_failed` on provider errors. Rate limit 20/hour. Nothing is ever posted automatically. Uses the official Anthropic SDK, default model `claude-opus-5-5` at low effort, with server-side refusal fallbacks. |
