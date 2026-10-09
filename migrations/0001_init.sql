-- Relay 3.0 initial schema. All timestamps are INTEGER milliseconds since epoch.
-- IDs are 26-char time-sortable strings (see server/db.ts newId()).

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar_key    TEXT,
  is_private    INTEGER NOT NULL DEFAULT 0,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,          -- SHA-256 hex of the session token; the raw token only lives in the cookie
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE user_settings (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_likes    INTEGER NOT NULL DEFAULT 1,
  notify_reposts  INTEGER NOT NULL DEFAULT 1,
  notify_follows  INTEGER NOT NULL DEFAULT 1,
  notify_mentions INTEGER NOT NULL DEFAULT 1,
  notify_replies  INTEGER NOT NULL DEFAULT 1,
  dm_policy       TEXT NOT NULL DEFAULT 'following' CHECK (dm_policy IN ('everyone','following','nobody')),
  muted_words     TEXT NOT NULL DEFAULT '[]',   -- JSON array of lowercase strings
  hide_counts     INTEGER NOT NULL DEFAULT 0,
  feed_replies    INTEGER NOT NULL DEFAULT 1,
  feed_reposts    INTEGER NOT NULL DEFAULT 1,
  ai_enabled      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE posts (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  reply_to_id TEXT REFERENCES posts(id),
  root_id     TEXT NOT NULL,              -- = id for top-level posts
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER,
  deleted_at  INTEGER,
  removed_by_mod INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX posts_author ON posts(author_id, id DESC);
CREATE INDEX posts_reply_to ON posts(reply_to_id, id);
CREATE INDEX posts_root ON posts(root_id, id);
CREATE INDEX posts_recent ON posts(id DESC) WHERE deleted_at IS NULL;

CREATE TABLE mentions (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE likes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX likes_post ON likes(post_id);

CREATE TABLE reposts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX reposts_post ON reposts(post_id);
CREATE INDEX reposts_user_time ON reposts(user_id, created_at DESC);

CREATE TABLE follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','pending')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX follows_followee ON follows(followee_id, state);

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX blocks_blocked ON blocks(blocked_id);

CREATE TABLE mutes (
  muter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (muter_id, muted_id)
);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- recipient
  actor_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('like','repost','reply','mention','follow','follow_request','follow_accept')),
  post_id     TEXT REFERENCES posts(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);
CREATE INDEX notifications_user ON notifications(user_id, id DESC);
CREATE INDEX notifications_unread ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  pair_key   TEXT UNIQUE,                 -- "<minUserId>:<maxUserId>" for 1:1 conversations
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user ON conversation_members(user_id);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX messages_conversation ON messages(conversation_id, id DESC);

CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','user')),
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  created_at  INTEGER NOT NULL,
  resolved_by TEXT REFERENCES users(id),
  resolved_at INTEGER,
  resolution  TEXT
);
CREATE INDEX reports_status ON reports(status, id DESC);
CREATE UNIQUE INDEX reports_once ON reports(reporter_id, target_type, target_id) WHERE status = 'open';

CREATE TABLE moderation_actions (
  id           TEXT PRIMARY KEY,
  moderator_id TEXT NOT NULL REFERENCES users(id),
  target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  target_post_id TEXT,
  action       TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

CREATE TABLE collections (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_public   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX collections_owner ON collections(owner_id, updated_at DESC);

CREATE TABLE collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  note          TEXT NOT NULL DEFAULT '',
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (collection_id, post_id)
);

CREATE TABLE media (
  key          TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data         BLOB,                       -- only used when no R2 bucket is bound (local preview)
  created_at   INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
