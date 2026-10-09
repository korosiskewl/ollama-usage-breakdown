// Validation limits shared by client and server so the UI can show accurate counters.
export const LIMITS = {
  handle: { min: 3, max: 20, pattern: /^[A-Za-z0-9_]+$/ },
  displayName: { min: 1, max: 50 },
  bio: { max: 300 },
  password: { min: 10, max: 200 },
  post: { max: 500 },
  message: { max: 2000 },
  mutedWord: { max: 40, count: 50 },
  collectionTitle: { max: 60 },
  collectionDescription: { max: 280 },
  collectionNote: { max: 280 },
  reportDetails: { max: 1000 },
  search: { min: 2, max: 64 },
  avatarBytes: 1_000_000,
  pageSize: 25,
} as const;

/** Count user-perceived characters (grapheme clusters) so emoji count as one. */
export function charCount(text: string): number {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) {
    let n = 0;
    for (const _ of new Seg(undefined, { granularity: 'grapheme' }).segment(text)) n++;
    return n;
  }
  return Array.from(text).length;
}

/** Mention syntax: @handle preceded by start-of-text or a non-word character. */
export const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9_]{3,20})\b/g;

export function extractMentions(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) out.add(m[2].toLowerCase());
  return [...out];
}
