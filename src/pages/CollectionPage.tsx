import { useId, useState } from 'react';
import type { Collection, CollectionItem, Page } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { Link, navigate, profilePath } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { usePaged } from '../lib/usePaged';
import { Avatar } from '../components/Avatar';
import { ConfirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { InfiniteList } from '../components/InfiniteList';
import { Menu } from '../components/Menu';
import { PostItem } from '../components/PostItem';
import { CollectionFormDialog, type CollectionDraft } from '../components/ProfileCollections';
import { EmptyState, ErrorState, PostSkeleton } from '../components/States';
import { Time } from '../components/Time';

type Resp = { collection: Collection; items: Page<CollectionItem> };

export default function CollectionPage({ params }: { params: Record<string, string> }) {
  const id = params.id;
  const { me } = useSession();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [dialog, setDialog] = useState<null | 'edit' | 'delete'>(null);
  const [deleting, setDeleting] = useState(false);

  const list = usePaged<CollectionItem>(`collection:${id}`, async (cursor) => {
    try {
      const r = await api.get<Resp>(`/collections/${encodeURIComponent(id)}`, { cursor });
      setCollection(r.collection);
      return r.items;
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 404) setNotFound(true);
      throw e;
    }
  });

  const isOwner = !!me && !!collection && collection.owner.id === me.id;

  async function saveMeta(d: CollectionDraft) {
    const c = await api.patch<Collection>(`/collections/${id}`, d);
    setCollection(c);
    setDialog(null);
    toast('Collection updated.');
  }

  async function doDelete() {
    if (!collection) return;
    setDeleting(true);
    try {
      await api.del(`/collections/${id}`);
      toast(`Deleted “${collection.title}”.`);
      navigate(`${profilePath(collection.owner.handle)}/collections`, { replace: true });
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
      setDeleting(false);
      setDialog(null);
    }
  }

  function updateItem(postId: string, fn: (it: CollectionItem) => CollectionItem | null) {
    list.setItems((items) => items.flatMap((it) => (it.post.id === postId ? (fn(it) ?? []) : [it])));
  }

  async function removeItem(item: CollectionItem) {
    const index = list.items.findIndex((it) => it.post.id === item.post.id);
    updateItem(item.post.id, () => null);
    setCollection((c) => (c ? { ...c, itemCount: Math.max(0, c.itemCount - 1) } : c));
    const restore = () => {
      list.setItems((items) => (items.some((x) => x.post.id === item.post.id) ? items : [...items.slice(0, index), item, ...items.slice(index)]));
      setCollection((c) => (c ? { ...c, itemCount: c.itemCount + 1 } : c));
    };
    try {
      await api.del(`/collections/${id}/items/${item.post.id}`);
      toast('Removed from the collection.', {
        action: {
          label: 'Undo',
          run: () => {
            restore();
            api.post(`/collections/${id}/items`, { postId: item.post.id, note: item.note || undefined }).catch((e) => {
              updateItem(item.post.id, () => null);
              setCollection((c) => (c ? { ...c, itemCount: Math.max(0, c.itemCount - 1) } : c));
              toast(errorMessage(e), { kind: 'error' });
            });
          },
        },
      });
    } catch (e) {
      restore();
      toast(errorMessage(e), { kind: 'error' });
    }
  }

  if (notFound) {
    return (
      <div className="sc-page">
        <EmptyState
          title="This collection isn’t available."
          action={
            <Link to="/" className="btn">
              Back to Home
            </Link>
          }
        >
          It may have been deleted, or its owner keeps it private.
        </EmptyState>
      </div>
    );
  }

  if (!collection) {
    return (
      <div className="sc-page">
        {list.error ? (
          <ErrorState message={list.error} onRetry={() => void list.reload()} />
        ) : (
          <>
            <div className="coll-head" aria-hidden="true">
              <div className="skeleton" style={{ width: 90, height: 12 }} />
              <div className="skeleton" style={{ width: '60%', height: 30, marginTop: 14 }} />
              <div className="skeleton" style={{ width: '85%', height: 14, marginTop: 14 }} />
            </div>
            <PostSkeleton count={3} />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="sc-page">
      <header className="coll-head">
        <div className="coll-kicker-row">
          <span className="kicker">Collection</span>
          {collection.isPublic ? (
            <span className="tag">public</span>
          ) : (
            <span className="tag tag-amber">
              <Icon name="lock" size={11} /> private
            </span>
          )}
          {isOwner && (
            <span className="coll-menu">
              <Menu
                label="Collection options"
                items={[
                  { label: 'Edit details', icon: 'edit', onSelect: () => setDialog('edit') },
                  { label: 'Delete collection', icon: 'trash', danger: true, onSelect: () => setDialog('delete') },
                ]}
              />
            </span>
          )}
        </div>
        <h1 className="coll-title">{collection.title}</h1>
        {collection.description && <p className="coll-desc">{collection.description}</p>}
        <div className="coll-byline">
          <Link to={profilePath(collection.owner.handle)} className="coll-owner">
            <Avatar user={collection.owner} size={24} />
            <span>
              Curated by <strong>{collection.owner.displayName}</strong>
            </span>
          </Link>
          <span className="meta">
            {plural(collection.itemCount, 'post')} · updated <Time iso={collection.updatedAt} className="" />
          </span>
        </div>
        {isOwner && (
          <div className="coll-owner-actions">
            <button className="btn btn-sm" onClick={() => setDialog('edit')}>
              <Icon name="edit" size={15} />
              Edit details
            </button>
          </div>
        )}
      </header>

      <InfiniteList
        hasMore={list.hasMore}
        loading={list.loading}
        loaded={list.loaded}
        error={list.error}
        onMore={list.loadMore}
        skeleton={<PostSkeleton count={3} />}
        empty={
          <EmptyState title={isOwner ? 'Nothing on this shelf yet.' : 'This collection is empty.'}>
            {isOwner ? (
              <>
                Use <span className="meta">save</span> on any post to add it here, with a note on why it matters.
              </>
            ) : (
              'Posts added to it will appear here.'
            )}
          </EmptyState>
        }
      >
        {list.items.map((item) => (
          <CollectionEntry
            key={item.post.id}
            item={item}
            collectionId={id}
            isOwner={isOwner}
            onNote={(note) => updateItem(item.post.id, (it) => ({ ...it, note }))}
            onRemove={() => void removeItem(item)}
          />
        ))}
      </InfiniteList>

      {dialog === 'edit' && (
        <CollectionFormDialog
          title="Edit collection"
          submitLabel="Save"
          initial={{ title: collection.title, description: collection.description, isPublic: collection.isPublic }}
          onSubmit={saveMeta}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          title={`Delete “${collection.title}”?`}
          body="The collection and your notes are deleted. The posts themselves aren’t affected. This can’t be undone."
          confirmLabel="Delete collection"
          danger
          busy={deleting}
          onConfirm={() => void doDelete()}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function CollectionEntry({
  item,
  collectionId,
  isOwner,
  onNote,
  onRemove,
}: {
  item: CollectionItem;
  collectionId: string;
  isOwner: boolean;
  onNote: (note: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const len = charCount(draft);
  const over = len > LIMITS.collectionNote.max;

  async function save() {
    if (over || busy) return;
    const note = draft.trim();
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/collections/${collectionId}/items/${item.post.id}`, { note });
      onNote(note);
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="coll-entry" aria-label={`Saved post by @${item.post.author.handle}`}>
      {editing ? (
        <form
          className="coll-note-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="sr-only" htmlFor={`${uid}-note`}>
            Curator’s note
          </label>
          <textarea
            id={`${uid}-note`}
            className="textarea coll-note-input"
            rows={2}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
                setDraft(item.note);
              }
            }}
            placeholder="Why this post belongs here…"
            aria-invalid={over || undefined}
          />
          <div className="coll-note-edit-foot">
            <span className={over ? 'meta counter-over' : 'meta'}>
              {len} / {LIMITS.collectionNote.max}
            </span>
            <span className="coll-note-edit-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setEditing(false);
                  setDraft(item.note);
                  setError(null);
                }}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={over || busy}>
                {busy && <span className="spinner" />}
                Save note
              </button>
            </span>
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        item.note && (
          <blockquote className="coll-note">
            <p>{item.note}</p>
          </blockquote>
        )
      )}
      <PostItem post={item.post} />
      {isOwner && !editing && (
        <div className="coll-entry-tools">
          <span className="meta">
            added <Time iso={item.addedAt} className="" />
          </span>
          <button
            className="act"
            onClick={() => {
              setDraft(item.note);
              setEditing(true);
            }}
          >
            {item.note ? 'edit note' : 'add note'}
          </button>
          <button className="act act-danger" onClick={onRemove}>
            remove
          </button>
        </div>
      )}
    </section>
  );
}
