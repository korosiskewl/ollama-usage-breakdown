// Global composer controller. Any component can open the compose dialog; ComposerDialog subscribes.
import { useSyncExternalStore } from 'react';
import type { Post } from '../../shared/types';

export interface ComposerRequest {
  replyTo?: Post;
  edit?: Post;
  /** Prefill text for a new post (e.g. "@handle "). */
  initialText?: string;
  onDone?: (post: Post) => void;
}

let state: ComposerRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openComposer(req: ComposerRequest = {}) {
  state = req;
  emit();
}

export function closeComposer() {
  state = null;
  emit();
}

export function useComposerRequest(): ComposerRequest | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

/** Lightweight pub/sub so lists can react to posts created/edited/deleted elsewhere. */
type PostEvent = { type: 'created' | 'updated' | 'deleted'; post: Post };
const postListeners = new Set<(e: PostEvent) => void>();
export function emitPostEvent(e: PostEvent) {
  postListeners.forEach((l) => l(e));
}
export function onPostEvent(l: (e: PostEvent) => void) {
  postListeners.add(l);
  return () => {
    postListeners.delete(l);
  };
}
