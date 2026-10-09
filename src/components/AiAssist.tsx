// Optional writing assistant. Off by default; only renders when the signed-in user turned it on in Settings AND the
// server has an AI provider configured. Text is sent to the provider only when the user presses a button, and a
// suggestion is never applied without an explicit "Use this".
import { useEffect, useRef, useState } from 'react';
import type { AiMode, AiStatus } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';

let statusPromise: Promise<AiStatus> | null = null;

/** GET /ai/status, cached for the lifetime of the page. A failed request is retried next time. */
export function getAiStatus(): Promise<AiStatus> {
  if (!statusPromise) {
    statusPromise = api.get<AiStatus>('/ai/status').catch((e) => {
      statusPromise = null;
      throw e;
    });
  }
  return statusPromise;
}

/** Server AI availability: undefined while loading, null if it couldn't be determined. */
export function useAiStatus(): AiStatus | null | undefined {
  const [status, setStatus] = useState<AiStatus | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getAiStatus().then(
      (s) => live && setStatus(s),
      () => live && setStatus(null),
    );
    return () => {
      live = false;
    };
  }, []);
  return status;
}

/** True only when the viewer opted in and the server can actually serve requests. */
function useAiReady(): boolean {
  const { me } = useSession();
  const enabled = !!me?.settings.aiEnabled;
  const status = useAiStatus();
  return enabled && !!status?.available;
}

function friendlyAiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.status === 503) return 'The assistant isn’t configured on this server.';
    if (e.status === 429) return 'You’ve reached the assistant’s hourly limit. Your draft is untouched — try again later.';
    if (e.code === 'ai_disabled') return 'AI assist is turned off for your account.';
  }
  return errorMessage(e);
}

const MODES: { mode: Exclude<AiMode, 'summarize_thread'>; label: string; hint: string }[] = [
  { mode: 'improve', label: 'improve', hint: 'Suggest a clearer, tighter version of your draft' },
  { mode: 'shorten', label: 'shorten', hint: 'Suggest a shorter version of your draft' },
  { mode: 'clarify', label: 'clarify', hint: 'Suggest a version that’s easier to understand' },
];

export function AiAssist({ text, onApply }: { text: string; onApply: (text: string) => void }) {
  const ready = useAiReady();
  const [busy, setBusy] = useState<AiMode | null>(null);
  const [suggestion, setSuggestion] = useState<{ text: string; mode: AiMode } | null>(null);
  const [error, setError] = useState<{ message: string; settingsLink: boolean } | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  if (!ready) return null;

  const empty = !text.trim();

  async function run(mode: AiMode) {
    if (empty || busy) return;
    setBusy(mode);
    setError(null);
    setSuggestion(null);
    try {
      const r = await api.post<{ suggestion: string; model: string }>('/ai/assist', { mode, text });
      if (live.current) setSuggestion({ text: r.suggestion, mode });
    } catch (e) {
      if (live.current) setError({ message: friendlyAiError(e), settingsLink: e instanceof ApiRequestError && e.code === 'ai_disabled' });
    } finally {
      if (live.current) setBusy(null);
    }
  }

  const over = suggestion ? charCount(suggestion.text) - LIMITS.post.max : 0;

  return (
    <div className="ai-assist">
      <div className="ai-row" role="group" aria-label="Optional AI assist">
        <span className="ai-label">Optional AI assist</span>
        <span className="ai-modes">
          <span className="ai-glyph" aria-hidden="true">
            ✦
          </span>
          {MODES.map((m, i) => (
            <span key={m.mode} className="ai-mode">
              {i > 0 && (
                <span className="ai-sep" aria-hidden="true">
                  ·
                </span>
              )}
              <button
                type="button"
                className="ai-btn"
                disabled={empty || !!busy}
                title={empty ? 'Write something first' : m.hint}
                aria-busy={busy === m.mode}
                onClick={() => void run(m.mode)}
              >
                {m.label}
                {busy === m.mode && <span className="spinner ai-spin" aria-hidden="true" />}
              </button>
            </span>
          ))}
        </span>
      </div>
      <div aria-live="polite">
        {busy && <p className="ai-status meta">Asking the assistant… your draft stays as it is.</p>}
        {error && (
          <p className="ai-error" role="alert">
            {error.message}
            {error.settingsLink && (
              <>
                {' '}
                <Link to="/settings/ai">Open settings</Link>
              </>
            )}
          </p>
        )}
        {suggestion && (
          <section className="ai-panel rise" aria-label="AI suggestion">
            <p className="ai-panel-label kicker">AI suggestion — review before using</p>
            <div className="ai-panel-text read">{suggestion.text}</div>
            <div className="ai-panel-foot">
              <span className={over > 0 ? 'meta ai-over' : 'meta'}>
                {over > 0 ? `${over} over the ${LIMITS.post.max}-character limit` : `${charCount(suggestion.text)} / ${LIMITS.post.max}`}
              </span>
              <span className="ai-panel-actions">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSuggestion(null)}>
                  Discard
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    onApply(suggestion.text);
                    setSuggestion(null);
                  }}
                >
                  Use this
                </button>
              </span>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** Summarise a thread on demand. Same gating as AiAssist; the summary is clearly labelled as AI-generated. */
export function SummarizeThreadButton({ postId }: { postId: string }) {
  const ready = useAiReady();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{ text: string; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  if (!ready) return null;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ suggestion: string; model: string }>('/ai/assist', { mode: 'summarize_thread', postId });
      if (live.current) setSummary({ text: r.suggestion, model: r.model });
    } catch (e) {
      if (live.current) setError(friendlyAiError(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  return (
    <div className="ai-summary">
      {!summary && (
        <button type="button" className="ai-btn ai-btn-solo" onClick={() => void run()} disabled={busy} aria-busy={busy}>
          <span aria-hidden="true">✦</span> summarize this thread
          {busy && <span className="spinner ai-spin" aria-hidden="true" />}
        </button>
      )}
      <div aria-live="polite">
        {error && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}
        {summary && (
          <section className="ai-panel rise" aria-label="AI-generated summary">
            <p className="ai-panel-label kicker">AI-generated summary — may miss nuance or get things wrong</p>
            <div className="ai-panel-text read">{summary.text}</div>
            <div className="ai-panel-foot">
              <span className="meta">Only posts you can see were used{summary.model ? ` · ${summary.model}` : ''}</span>
              <span className="ai-panel-actions">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSummary(null)}>
                  Close
                </button>
              </span>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
