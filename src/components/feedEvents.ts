import { useEffect, useRef } from 'react';
import type { FeedItem, Post } from '../../shared/types';
import { onPostEvent } from '../lib/composer';

type SetItems = (fn: (prev: FeedItem[]) => FeedItem[]) => void;

/** Keep a FeedItem list in sync with posts created, edited or deleted elsewhere in the app. */
export function useFeedEvents(setItems: SetItems, accept: (post: Post) => boolean) {
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  useEffect(
    () =>
      onPostEvent((e) => {
        if (e.type === 'created') {
          if (!acceptRef.current(e.post)) return;
          const item: FeedItem = { key: `p:${e.post.id}`, kind: 'post', post: e.post, repostedBy: null, at: e.post.createdAt };
          setItems((prev) => (prev.some((i) => i.key === item.key) ? prev : [item, ...prev]));
        } else if (e.type === 'updated') {
          setItems((prev) => prev.map((i) => (i.post.id === e.post.id ? { ...i, post: e.post } : i)));
        } else {
          setItems((prev) => prev.filter((i) => i.post.id !== e.post.id));
        }
      }),
    [setItems],
  );
}

/** onRemoved handler for PostItem: drop a deleted post, or everything by an author who was muted / blocked. */
export function removeFrom(setItems: SetItems) {
  return (p: Post) =>
    setItems((prev) => (p.deleted ? prev.filter((i) => i.post.id !== p.id) : prev.filter((i) => i.post.author.id !== p.author.id)));
}
