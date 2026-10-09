import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Page, Post, UserSummary } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { closeComposer, emitPostEvent, useComposerRequest, type ComposerRequest } from '../lib/composer';
import { navigate, postPath, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { AiAssist } from './AiAssist';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { RichText } from './RichText';
import { Time } from './Time';

// ---------------------------------------------------------------- drafts (per context, this tab only)

const DRAFT_PREFIX = 'relay.draft.';

function readDraft(key: string): string | null {
  try {
    return sessionStorage.getItem(DRAFT_PREFIX + key);
  } catch {
    return null;
  }
}

function writeDraft(key: string, text: string, original = '') {
  try {
    if (text.trim() && text !== original) sessionStorage.setItem(DRAFT_PREFIX + key, text);
    else sessionStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* storage unavailable (private mode): drafts just don't persist */
  }
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

// ---------------------------------------------------------------- mention autocomplete

interface MentionCtx {
  start: number;
  query: string;
}

/** The "@prefix" immediately before the caret, if the caret is at the end of one. */
function mentionAt(text: string, caret: number): MentionCtx | null {
  if (/^[A-Za-z0-9_]/.test(text.slice(caret))) return null;
  const m = /(^|[^\w@])@([A-Za-z0-9_]{1,20})$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

function useMentionSearch(query: string | null) {
  const [results, setResults] = useState<UserSummary[]>([]);
  const [forQuery, setForQuery] = useState<string | null>(null);
  useEffect(() => {
    if (!query) {
      setResults([]);
      setForQuery(null);
      return;
    }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api
        .get<Page<UserSummary>>('/search', { type: 'users', q: '@' + query }, ctl.signal)
        .then((page) => {
          setResults(page.items.filter((u) => !u.suspended).slice(0, 6));
          setForQuery(query);
        })
        .catch((e: unknown) => {
          if ((e as Error)?.name === 'AbortError') return;
          setResults([]);
          setForQuery(query);
        });
    }, 160);
    return () => {
      ctl.abort();
      window.clearTimeout(t);
    };
  }, [query]);
  return forQuery === query ? results : [];
}

// ---------------------------------------------------------------- counter

function Counter({ count, id }: { count: number; id: string }) {
  const max = LIMITS.post.max;
  const left = max - count;
  const state = left < 0 ? 'over' : left <= 40 ? 'warn' : 'ok';
  const r = 8;
  const c = 2 * Math.PI * r;
  const pct = Math.min(count / max, 1);
  return (
    <span className={`counter counter-${state}`} id={id}>
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle cx="10" cy="10" r={r} className="counter-track" />
        <circle cx="10" cy="10" r={r} className="counter-fill" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 10 10)" />
      </svg>
      {state !== 'ok' && (
        <span className="counter-n" aria-hidden="true">
          {left}
        </span>
      )}
      <span className="sr-only">
        {count} of {max} characters used.
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- the editor

interface EditorProps {
  replyTo?: Post;
  edit?: Post;
  initialText?: string;
  draftKey: string;
  autoFocus?: boolean;
  inline?: boolean;
  placeholder?: string;
  onDone: (post: Post) => void;
  onCancel?: () => void;
  /** Report whether there is unsent text (used to keep drafts when the dialog closes). */
  onDirty?: (dirty: boolean) => void;
}

function Editor({ replyTo, edit, initialText, draftKey, autoFocus, inline, placeholder, onDone, onCancel, onDirty }: EditorProps) {
  const { me } = useSession();
  const original = edit?.body ?? '';
  const [text, setTextState] = useState(() => readDraft(draftKey) ?? (edit ? edit.body : (initialText ?? '')));
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const uid = useId();
  const ids = { ta: uid + 'ta', counter: uid + 'c', hint: uid + 'h', err: uid + 'e', list: uid + 'l' };

  const setText = (t: string) => {
    setTextState(t);
    setError(null);
    writeDraft(draftKey, t, original);
    onDirty?.(!!t.trim() && t !== original);
  };

  // Autosize.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 2 + 'px';
  }, [text, focused]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = ta.current;
    if (!el) return;
    el.focus({ preventScroll: inline });
    const end = el.value.length;
    el.setSelectionRange(end, end);
    setCaret(end);
    if (inline) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [autoFocus, inline]);

  const count = charCount(text);
  const over = count > LIMITS.post.max;
  const empty = !text.trim();
  const unchanged = !!edit && text.trim() === original.trim();
  const canSubmit = !empty && !over && !busy && !unchanged;

  const mention = focused ? mentionAt(text, caret) : null;
  const results = useMentionSearch(mention?.query ?? null);
  const open = !!mention && results.length > 0 && dismissedAt !== mention.start;
  const activeIdx = Math.min(active, Math.max(results.length - 1, 0));

  function syncCaret() {
    const el = ta.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  }

  function pick(u: UserSummary) {
    if (!mention) return;
    const insert = '@' + u.handle + ' ';
    const after = text.slice(caret).replace(/^ /, '');
    const next = text.slice(0, mention.start) + insert + after;
    const pos = mention.start + insert.length;
    setText(next);
    setCaret(pos);
    setActive(0);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  async function submit() {
    if (!canSubmit || !me) return;
    setBusy(true);
    setError(null);
    try {
      const post = edit
        ? await api.patch<Post>(`/posts/${edit.id}`, { body: text })
        : await api.post<Post>('/posts', replyTo ? { body: text, replyToId: replyTo.id } : { body: text });
      writeDraft(draftKey, '');
      setTextState('');
      onDirty?.(false);
      toast(edit ? 'Post updated.' : replyTo ? 'Reply posted.' : 'Posted.', {
        kind: 'success',
        action: edit || inline ? undefined : { label: 'View', run: () => navigate(postPath(post.id)) },
      });
      emitPostEvent({ type: edit ? 'updated' : 'created', post });
      onDone(post);
    } catch (e) {
      if (e instanceof ApiRequestError) setError(e.fields.body ?? e.fields.replyToId ?? e.message);
      else setError(errorMessage(e));
      ta.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void submit();
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((activeIdx + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((activeIdx - 1 + results.length) % results.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(results[activeIdx]);
    } else if (e.key === 'Escape') {
      // Close the suggestions only; don't let the dialog treat this Esc as "close".
      e.preventDefault();
      e.stopPropagation();
      setDismissedAt(mention!.start);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const expanded = !inline || focused || !empty || busy;
  const label = edit ? 'Edit your post' : replyTo ? `Reply to @${replyTo.author.handle}` : 'Write a post';
  const submitLabel = edit ? 'Save' : replyTo ? 'Reply' : 'Post';
  const describedBy = [ids.counter, ids.hint, error ? ids.err : ''].filter(Boolean).join(' ');

  if (!me) return null;

  return (
    <form
      ref={formRef}
      className={'composer' + (inline ? ' composer-inline' : ' composer-dialog') + (expanded ? ' is-expanded' : '')}
      onSubmit={onSubmit}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!formRef.current?.contains(e.relatedTarget as Node)) setFocused(false);
      }}
      noValidate
    >
      <div className="composer-gutter">
        <Avatar user={me} size={inline ? 36 : 40} />
      </div>
      <div className="composer-main">
        <label className="sr-only" htmlFor={ids.ta}>
          {label}
        </label>
        <textarea
          ref={ta}
          id={ids.ta}
          className="composer-text"
          value={text}
          rows={inline && !expanded ? 1 : 3}
          placeholder={placeholder ?? (replyTo ? 'Write your reply…' : 'Write something worth reading…')}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setActive(0);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyDown={onKeyDown}
          aria-invalid={over || !!error || undefined}
          aria-describedby={describedBy}
          aria-autocomplete="list"
          aria-controls={open ? ids.list : undefined}
          aria-activedescendant={open ? `${ids.list}-${activeIdx}` : undefined}
          spellCheck
          readOnly={busy}
          aria-busy={busy || undefined}
        />
        <span className="sr-only" aria-live="polite">
          {open ? `${results.length} ${results.length === 1 ? 'person' : 'people'} found. Use up and down arrows to choose, Enter to insert.` : ''}
        </span>
        {open && (
          <ul className="mention-list" id={ids.list} role="listbox" aria-label="People to mention">
            {results.map((u, i) => (
              <li
                key={u.id}
                id={`${ids.list}-${i}`}
                role="option"
                aria-selected={i === activeIdx}
                className="mention-option"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(u)}
              >
                <Avatar user={u} size={28} />
                <span className="mention-text">
                  <span className="mention-name">{u.displayName}</span>
                  <span className="meta">@{u.handle}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="field-error composer-error" id={ids.err} role="alert">
            {error}
          </p>
        )}
        <span className="sr-only" aria-live="polite">
          {over ? `Over the ${LIMITS.post.max} character limit.` : ''}
        </span>
        {expanded && (
          <>
            <AiAssist text={text} onApply={setText} />
            <div className="composer-bar">
              <span className="composer-hint meta" id={ids.hint}>
                {isMac ? '⌘' : 'Ctrl'}+Enter to {submitLabel.toLowerCase()}
              </span>
              <Counter count={count} id={ids.counter} />
              {onCancel && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
                  Cancel
                </button>
              )}
              <button type="submit" className="btn btn-sm btn-signal" disabled={!canSubmit} aria-disabled={!canSubmit}>
                {busy && <span className="spinner" />}
                {submitLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- public components

/** Inline composer for the top of Home and for replies at the bottom of a thread. */
export function InlineComposer({
  replyTo,
  autoFocus,
  placeholder,
  onPosted,
}: {
  replyTo?: Post;
  autoFocus?: boolean;
  placeholder?: string;
  onPosted?: (post: Post) => void;
}) {
  const { me } = useSession();
  const [gen, setGen] = useState(0);
  if (!me) return null;
  return (
    <div className="inline-composer">
      <Editor
        key={gen}
        inline
        replyTo={replyTo}
        autoFocus={autoFocus}
        placeholder={placeholder}
        draftKey={replyTo ? `inline-reply:${replyTo.id}` : 'inline:home'}
        onDone={(p) => {
          setGen((g) => g + 1);
          onPosted?.(p);
        }}
      />
    </div>
  );
}

function ParentPreview({ post }: { post: Post }) {
  return (
    <div className="composer-parent">
      <div className="composer-parent-gutter">
        <Avatar user={post.author} size={32} />
        <span className="post-thread-line" aria-hidden="true" />
      </div>
      <div className="composer-parent-main">
        <p className="composer-parent-head">
          <span className="composer-parent-name">{post.author.displayName}</span>{' '}
          <span className="meta">
            @{post.author.handle} · <Time iso={post.createdAt} />
          </span>
        </p>
        <div className="composer-parent-body read">
          <RichText text={post.body} mentions={post.mentions} />
        </div>
        <p className="meta composer-replying">
          Replying to <span className="composer-replying-to">@{post.author.handle}</span>
        </p>
      </div>
    </div>
  );
}

const reqIds = new WeakMap<ComposerRequest, number>();
let reqSeq = 0;
const reqKey = (r: ComposerRequest) => {
  let k = reqIds.get(r);
  if (!k) reqIds.set(r, (k = ++reqSeq));
  return k;
};

/** The global compose dialog: new post, reply (with the parent shown above) or edit. Opened via openComposer(). */
export function ComposerDialog() {
  const req = useComposerRequest();
  const { me, loading } = useSession();
  const { path } = useLocation();

  useEffect(() => {
    if (req && !me && !loading) {
      closeComposer();
      navigate(`/login?next=${encodeURIComponent(path)}`);
    }
  }, [req, me, loading, path]);

  if (!req || !me) return null;
  return <ComposerModal key={reqKey(req)} req={req} />;
}

function ComposerModal({ req }: { req: ComposerRequest }) {
  const dirty = useRef(false);
  const { edit, replyTo } = req;
  const draftKey = edit ? `edit:${edit.id}` : replyTo ? `reply:${replyTo.id}` : 'new';
  const close = () => {
    if (dirty.current && !edit) toast('Draft kept. It’ll be here when you come back.');
    closeComposer();
  };
  return (
    <Dialog title={edit ? 'Edit post' : replyTo ? 'Reply' : 'New post'} onClose={close} wide>
      {replyTo && !edit && <ParentPreview post={replyTo} />}
      {edit && <p className="hint composer-edit-note">Edited posts show an “edited” label. Mentions you add won’t send new notifications.</p>}
      <Editor
        edit={edit}
        replyTo={edit ? undefined : replyTo}
        initialText={req.initialText}
        draftKey={draftKey}
        autoFocus
        onDirty={(d) => (dirty.current = d)}
        onCancel={close}
        onDone={(post) => {
          req.onDone?.(post);
          closeComposer();
        }}
      />
    </Dialog>
  );
}
