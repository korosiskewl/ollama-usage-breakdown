import { useEffect, useId, useState } from 'react';
import type { Collection } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { Link, navigate } from '../lib/router';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { EmptyState, ErrorState, Loading } from './States';
import { Time } from './Time';

export interface CollectionDraft {
  title: string;
  description: string;
  isPublic: boolean;
}

/** Create / edit form for a collection's title, description and visibility. */
export function CollectionFormDialog({
  title: dialogTitle,
  submitLabel,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initial?: CollectionDraft;
  onSubmit: (draft: CollectionDraft) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CollectionDraft>(initial ?? { title: '', description: '', isPublic: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const uid = useId();

  const tLen = charCount(draft.title.trim());
  const dLen = charCount(draft.description);
  const tOver = tLen > LIMITS.collectionTitle.max;
  const dOver = dLen > LIMITS.collectionDescription.max;
  const valid = tLen > 0 && !tOver && !dOver;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await onSubmit({ ...draft, title: draft.title.trim(), description: draft.description.trim() });
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiRequestError) setFields(e.fields);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={dialogTitle}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form={`${uid}-form`} disabled={!valid || busy}>
            {busy && <span className="spinner" />}
            {submitLabel}
          </button>
        </>
      }
    >
      <form
        id={`${uid}-form`}
        className="stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor={`${uid}-title`}>Title</label>
          <input
            id={`${uid}-title`}
            className="input"
            value={draft.title}
            autoFocus
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            aria-invalid={tOver || !!fields.title || undefined}
            aria-describedby={`${uid}-title-hint`}
            placeholder="e.g. Notes on slow software"
          />
          <div className="report-hint-row" id={`${uid}-title-hint`}>
            <span className="field-error">{fields.title}</span>
            <span className={tOver ? 'meta counter-over' : 'meta'}>
              {tLen} / {LIMITS.collectionTitle.max}
            </span>
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-desc`}>
            Description <span className="report-optional">(optional)</span>
          </label>
          <textarea
            id={`${uid}-desc`}
            className="textarea"
            rows={3}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            aria-invalid={dOver || !!fields.description || undefined}
            aria-describedby={`${uid}-desc-hint`}
            placeholder="What ties these posts together?"
          />
          <div className="report-hint-row" id={`${uid}-desc-hint`}>
            <span className="field-error">{fields.description}</span>
            <span className={dOver ? 'meta counter-over' : 'meta'}>
              {dLen} / {LIMITS.collectionDescription.max}
            </span>
          </div>
        </div>
        <label className="switch">
          <span>
            <span className="label">Public</span>
            <span className="hint switch-hint">
              {draft.isPublic
                ? 'Anyone who can see your profile can read it.'
                : 'Only you can see this collection and what’s in it.'}
            </span>
          </span>
          <input type="checkbox" checked={draft.isPublic} onChange={(e) => setDraft({ ...draft, isPublic: e.target.checked })} />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

export function ProfileCollections({ handle, isOwner }: { handle: string; isOwner: boolean }) {
  const [items, setItems] = useState<Collection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => {
    setError(null);
    setItems(null);
    api.get<{ items: Collection[] }>(`/users/${encodeURIComponent(handle)}/collections`).then(
      (r) => setItems(r.items),
      (e) => setError(errorMessage(e)),
    );
  };
  useEffect(load, [handle]);

  async function create(d: CollectionDraft) {
    const col = await api.post<Collection>('/collections', d);
    setCreating(false);
    navigate(`/collections/${col.id}`);
  }

  return (
    <div className="pcoll">
      {isOwner && items && items.length > 0 && (
        <div className="pcoll-bar">
          <span className="meta">
            {plural(items.length, 'collection')} · {items.filter((c) => !c.isPublic).length} private
          </span>
          <button className="btn btn-sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} />
            New collection
          </button>
        </div>
      )}
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !items ? (
        <Loading label="Loading collections" />
      ) : items.length === 0 ? (
        isOwner ? (
          <EmptyState
            title="Shelves for posts worth keeping."
            action={
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                <Icon name="plus" size={16} />
                New collection
              </button>
            }
          >
            Gather posts into a collection with a note on each — a reading list, a thread of evidence, the best of a debate. Keep it private
            or share it on your profile. Use <span className="meta">save</span> on any post to add it.
          </EmptyState>
        ) : (
          <EmptyState title="No public collections.">@{handle} hasn’t shared any collections yet.</EmptyState>
        )
      ) : (
        <ul className="pcoll-list" role="list">
          {items.map((c) => (
            <li key={c.id}>
              <Link to={`/collections/${c.id}`} className="pcoll-item">
                <span className="pcoll-title">
                  {c.title}
                  {!c.isPublic && (
                    <span className="tag">
                      <Icon name="lock" size={11} /> private
                    </span>
                  )}
                </span>
                {c.description && <span className="pcoll-desc">{c.description}</span>}
                <span className="meta pcoll-meta">
                  {plural(c.itemCount, 'post')} · updated <Time iso={c.updatedAt} className="" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating && <CollectionFormDialog title="New collection" submitLabel="Create" onSubmit={create} onClose={() => setCreating(false)} />}
    </div>
  );
}
