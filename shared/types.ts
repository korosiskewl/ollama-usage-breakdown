// API contract shared by the server (server/) and the client (src/).
// All timestamps on the wire are ISO-8601 strings.

export type Role = 'user' | 'moderator' | 'admin';

export interface UserSummary {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  isPrivate: boolean;
  role: Role;
  suspended: boolean;
}

export type FollowState = 'none' | 'pending' | 'active';

export interface ProfileViewerState {
  following: FollowState;   // viewer -> profile
  followsYou: boolean;      // profile -> viewer (active)
  blocking: boolean;
  blockedBy: boolean;
  muting: boolean;
}

export interface Profile extends UserSummary {
  bio: string;
  createdAt: string;
  counts: { followers: number; following: number; posts: number };
  /** False when the profile is private and the viewer is not an approved follower. */
  canViewPosts: boolean;
  viewer: ProfileViewerState | null; // null when signed out or viewing yourself
}

export interface Settings {
  notify: { likes: boolean; reposts: boolean; follows: boolean; mentions: boolean; replies: boolean };
  dmPolicy: 'everyone' | 'following' | 'nobody';
  mutedWords: string[];
  hideCounts: boolean;
  feedReplies: boolean;
  feedReposts: boolean;
  aiEnabled: boolean;
}

export interface Me extends UserSummary {
  bio: string;
  createdAt: string;
  settings: Settings;
  unread: Unread;
}

export interface Unread {
  notifications: number;
  messages: number;
  followRequests: number;
}

export interface PostRef {
  id: string;
  author: UserSummary | null; // null when deleted / not visible
  deleted: boolean;
}

export interface Post {
  id: string;
  author: UserSummary;
  /** Empty string when deleted. */
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  /** True when removed by a moderator (body is empty). */
  removed: boolean;
  /** True when the viewer may not see this post (private author, block). Body is empty and author is a stub. */
  unavailable: boolean;
  replyToId: string | null;
  rootId: string;
  replyTo: PostRef | null;
  /** Handles mentioned in the body that resolve to real accounts. */
  mentions: string[];
  counts: { replies: number; likes: number; reposts: number };
  viewer: { liked: boolean; reposted: boolean; isAuthor: boolean } | null;
}

export interface FeedItem {
  /** Unique key for list rendering ("p:<postId>" or "r:<userId>:<postId>"). */
  key: string;
  kind: 'post' | 'repost';
  post: Post;
  repostedBy: UserSummary | null;
  at: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Thread {
  /** Root-first chain of posts above `post`. Deleted ancestors are included as deleted placeholders. */
  ancestors: Post[];
  post: Post;
  /** Direct replies, oldest first. */
  replies: Page<Post>;
}

export interface ReaderView {
  author: UserSummary;
  /** The root post followed by the author's own consecutive self-replies, in order. */
  posts: Post[];
  /** Number of replies from other people across the whole conversation. */
  otherReplies: number;
}

export type NotificationType = 'like' | 'repost' | 'reply' | 'mention' | 'follow' | 'follow_request' | 'follow_accept';

export interface NotificationGroup {
  /** Id of the newest notification in the group. */
  id: string;
  type: NotificationType;
  /** Newest first, at most 5. */
  actors: UserSummary[];
  actorCount: number;
  post: Post | null;
  createdAt: string;
  read: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  other: UserSummary;
  lastMessage: Message | null;
  unread: number;
  updatedAt: string;
  /** False when either side blocked the other or the other account is suspended. */
  canSend: boolean;
}

export type ReportReason = 'spam' | 'harassment' | 'hate' | 'violence' | 'sexual' | 'self_harm' | 'impersonation' | 'other';

export interface Report {
  id: string;
  reporter: UserSummary;
  targetType: 'post' | 'user';
  targetId: string;
  targetPost: Post | null;
  targetUser: UserSummary | null;
  reason: ReportReason;
  details: string;
  status: 'open' | 'actioned' | 'dismissed';
  createdAt: string;
  resolution: string | null;
}

export interface Collection {
  id: string;
  owner: UserSummary;
  title: string;
  description: string;
  isPublic: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  /** Only present on GET /api/me/collections?postId=…: whether this collection already contains that post. */
  containsPost?: boolean;
}

export interface CollectionItem {
  post: Post;
  note: string;
  addedAt: string;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
}

export interface AiStatus {
  available: boolean;
  model: string | null;
}

export type AiMode = 'improve' | 'shorten' | 'clarify' | 'summarize_thread';

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}
