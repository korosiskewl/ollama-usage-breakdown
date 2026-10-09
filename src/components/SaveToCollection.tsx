import { useEffect, useId, useState } from 'react';
import type { Collection, Post } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { api, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { toast } from '../lib/toast';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { ErrorState, Loading } from './States';

/** Checklist of the viewer's collections; ticking one adds the post (with the optional note), unticking removes it. */
export function SaveToCollectionDialog({ post, onClose }: { post: Post; onClose: () => void }) {
  const [items, setItems] = useState<Collection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newPrivate, setNewPrivate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const uid = useId();

  const load = () => {
    setError(null);
    setItems(null);
    api.get<{ items: Collection[] }>('/me/collections', { postId: post.id }).then(
      (r) => setItems(r.items),
      (e) => setError(errorMessage(e)),
    );
  };
  useEffect(load, [post.id]);

  const noteLen = charCount(note);
  const noteOver = noteLen > LIMITS.collectionNote.max;
  const titleLen = charCount(newTitle.trim());

  const patch = (id: string, fn: (c: Collection) => Collection) => setItems((list) => list?.map((c) => (c.id === id ? fn(c) : c)) ?? list);
  const setBusy = (id: string, on: boolean) =>
    setPending((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  async function toggle(c: Collection) {
    if (pending.has(c.id)) return;
    const adding = !c.containsPost;
    if (adding && noteOver) {
      toast(`Notes are at most ${LIMITS.collectionNote.max} characters.`, { kind: 'error' });
      return;
    }
    setBusy(c.id, true);
    patch(c.id, (x) => ({ ...x, containsPost: adding, itemCount: Math.max(0, x.itemCount + (adding ? 1 : -1)) }));
    try {
      if (adding) await api.post(`/collections/${c.id}/items`, { postId: post.id, note: note.trim() || undefined });
      else await api.del(`/collections/${c.id}/items/${post.id}`);
    } catch (e) {
      patch(c.id, (x) => ({ ...x, containsPost: !adding, itemCount: Math.max(0, x.itemCount + (adding ? -1 : 1)) }));
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(c.id, false);
    }
  }

  async function create() {
    const title = newTitle.trim();
    if (!title || titleLen > LIMITS.collectionTitle.max || creating || noteOver) return;
    setCreating(true);
    setCreateError(null);
    try {
      const col = await api.post<Collection>('/collections', { title, isPublic: !newPrivate });
      setItems((list) => [{ ...col, containsPost: false }, ...(list ?? [])]);
      setNewTitle('');
      setNewPrivate(false);
      await toggle({ ...col, containsPost: false });
    } catch (e) {
      setCreateError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  const saved = items?.filter((c) => c.containsPost).length ?? 0;

  return (
    <Dialog
      title="Save to collection"
      onClose={onClose}
      footer={
        <>
          <span className="meta save-foot-meta" aria-live="polite">
            {items ? (saved ? `In ${plural(saved, 'collection')}` : 'Not saved yet') : ''}
          </span>
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="save">
        <p className="save-excerpt read">
          “{post.body.length > 140 ? post.body.slice(0, 140).trimEnd() + '…' : post.body}”
          <span className="meta"> — @{post.author.handle}</span>
        </p>

        <div className="field">
          <label htmlFor={`${uid}-note`}>
            Your note <span className="report-optional">(optional)</span>
          </label>
          <textarea
            id={`${uid}-note`}
            className="textarea save-note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why it’s worth keeping — shown above the post in the collection."
            aria-invalid={noteOver || undefined}
            aria-describedby={`${uid}-note-hint`}
          />
          <div className="report-hint-row" id={`${uid}-note-hint`}>
            <span className="hint">Added with the post to any collection you tick below.</span>
            <span className={noteOver ? 'meta counter-over' : 'meta'}>
              {noteLen} / {LIMITS.collectionNote.max}
            </span>
          </div>
        </div>

        <div className="save-list-wrap">
          <p className="kicker">Your collections</p>
          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : !items ? (
            <Loading label="Loading your collections" />
          ) : items.length === 0 ? (
            <p className="save-empty">You don’t have any collections yet. Name your first one below — the post goes straight in.</p>
          ) : (
            <ul className="save-list" role="list">
              {items.map((c) => (
                <li key={c.id}>
                  <label className="save-row" data-busy={pending.has(c.id) || undefined}>
                    <input
                      type="checkbox"
                      className="check"
                      checked={!!c.containsPost}
                      onChange={() => void toggle(c)}
                      disabled={pending.has(c.id)}
                    />
                    <span className="save-row-text">
                      <span className="save-row-title">{c.title}</span>
                      <span className="meta">
                        {plural(c.itemCount, 'post')}
                        {!c.isPublic && ' · private'}
                      </span>
                    </span>
                    {!c.isPublic && <Icon name="lock" size={14} title="Private collection" />}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form
          className="save-new"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="label" htmlFor={`${uid}-new`}>
            New collection
          </label>
          <div className="save-new-row">
            <input
              id={`${uid}-new`}
              className="input"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Essays to reread"
              maxLength={LIMITS.collectionTitle.max * 2}
              aria-invalid={titleLen > LIMITS.collectionTitle.max || undefined}
              aria-describedby={createError ? `${uid}-new-err` : undefined}
            />
            <button className="btn" type="submit" disabled={!newTitle.trim() || titleLen > LIMITS.collectionTitle.max || creating}>
              {creating ? <span className="spinner" /> : <Icon name="plus" size={16} />}
              Create &amp; add
            </button>
          </div>
          <label className="save-private">
            <input type="checkbox" className="check" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} />
            Private — only you can see it
          </label>
          {createError && (
            <p className="field-error" id={`${uid}-new-err`} role="alert">
              {createError}
            </p>
          )}
        </form>
      </div>
    </Dialog>
  );
}
