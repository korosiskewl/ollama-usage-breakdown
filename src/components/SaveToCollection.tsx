import type { Post } from '../../shared/types';
import { Dialog } from './Dialog';

// STUB — replaced by the collections workstream.
export function SaveToCollectionDialog({ post, onClose }: { post: Post; onClose: () => void }) {
  return (
    <Dialog title="Save to collection" onClose={onClose}>
      <p>Collections for post {post.id} are coming.</p>
    </Dialog>
  );
}
