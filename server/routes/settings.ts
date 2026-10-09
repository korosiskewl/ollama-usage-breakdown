import { Hono } from 'hono';
import { z } from 'zod';
import type { Settings } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import type { AppEnv } from '../env';
import { body, cleanText, requireUser } from '../http';
import { getSettings } from '../social';

export const settingsRoutes = new Hono<AppEnv>();

const mutedWordsSchema = z
  .array(z.string().max(200))
  .max(LIMITS.mutedWord.count * 4)
  // Lowercase, trim, collapse inner whitespace, drop empties and duplicates.
  .transform((words) => [...new Set(words.map((w) => cleanText(w).replace(/\s+/g, ' ').toLowerCase()).filter(Boolean))])
  .refine((ws) => ws.every((w) => charCount(w) <= LIMITS.mutedWord.max), `Muted words are at most ${LIMITS.mutedWord.max} characters.`)
  .refine((ws) => ws.length <= LIMITS.mutedWord.count, `You can mute at most ${LIMITS.mutedWord.count} words.`);

const settingsPatch = z.object({
  notify: z
    .object({ likes: z.boolean(), reposts: z.boolean(), follows: z.boolean(), mentions: z.boolean(), replies: z.boolean() })
    .partial()
    .optional(),
  dmPolicy: z.enum(['everyone', 'following', 'nobody']).optional(),
  mutedWords: mutedWordsSchema.optional(),
  hideCounts: z.boolean().optional(),
  feedReplies: z.boolean().optional(),
  feedReposts: z.boolean().optional(),
  aiEnabled: z.boolean().optional(),
});

settingsRoutes.get('/me/settings', async (c) => {
  const me = requireUser(c);
  return c.json(await getSettings(c.env.DB, me.id));
});

settingsRoutes.patch('/me/settings', async (c) => {
  const me = requireUser(c);
  const input = await body(c, settingsPatch);
  const db = c.env.DB;
  const cur = await getSettings(db, me.id);
  const next: Settings = {
    notify: { ...cur.notify, ...input.notify },
    dmPolicy: input.dmPolicy ?? cur.dmPolicy,
    mutedWords: input.mutedWords ?? cur.mutedWords,
    hideCounts: input.hideCounts ?? cur.hideCounts,
    feedReplies: input.feedReplies ?? cur.feedReplies,
    feedReposts: input.feedReposts ?? cur.feedReposts,
    aiEnabled: input.aiEnabled ?? cur.aiEnabled,
  };
  const b = (v: boolean) => (v ? 1 : 0);
  await db
    .prepare(
      `INSERT INTO user_settings (user_id, notify_likes, notify_reposts, notify_follows, notify_mentions, notify_replies,
                                  dm_policy, muted_words, hide_counts, feed_replies, feed_reposts, ai_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         notify_likes = excluded.notify_likes, notify_reposts = excluded.notify_reposts, notify_follows = excluded.notify_follows,
         notify_mentions = excluded.notify_mentions, notify_replies = excluded.notify_replies, dm_policy = excluded.dm_policy,
         muted_words = excluded.muted_words, hide_counts = excluded.hide_counts, feed_replies = excluded.feed_replies,
         feed_reposts = excluded.feed_reposts, ai_enabled = excluded.ai_enabled`,
    )
    .bind(
      me.id,
      b(next.notify.likes), b(next.notify.reposts), b(next.notify.follows), b(next.notify.mentions), b(next.notify.replies),
      next.dmPolicy, JSON.stringify(next.mutedWords), b(next.hideCounts), b(next.feedReplies), b(next.feedReposts), b(next.aiEnabled),
    )
    .run();
  return c.json(next);
});
