import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Me } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { PasswordInput, safeNext } from '../components/PasswordInput';
import { Wordmark } from '../components/Shell';
import { ApiRequestError, PREVIEW, api, errorMessage } from '../lib/api';
import { Link, navigate, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';

type Field = 'handle' | 'displayName' | 'password';
type Errors = Partial<Record<Field | 'form', string>>;

function validate(f: Field, v: string): string | undefined {
  if (f === 'handle') {
    const h = v.trim().replace(/^@/, '');
    if (!h) return 'Choose a handle.';
    if (!LIMITS.handle.pattern.test(h)) return 'Use letters, numbers and underscores only.';
    if (h.length < LIMITS.handle.min) return `Handles are at least ${LIMITS.handle.min} characters.`;
    if (h.length > LIMITS.handle.max) return `Handles are at most ${LIMITS.handle.max} characters.`;
  } else if (f === 'displayName') {
    const n = charCount(v.trim());
    if (n < LIMITS.displayName.min) return 'Add a display name — it can be anything you like.';
    if (n > LIMITS.displayName.max) return `At most ${LIMITS.displayName.max} characters.`;
  } else {
    if (v.length < LIMITS.password.min) return `Use at least ${LIMITS.password.min} characters.`;
    if (v.length > LIMITS.password.max) return 'That password is too long.';
  }
  return undefined;
}

export default function Signup(_props: { params: Record<string, string> }) {
  const { me, setMe } = useSession();
  const { query } = useLocation();
  const next = safeNext(query.get('next'));
  const [values, setValues] = useState<Record<Field, string>>({ handle: '', displayName: '', password: '' });
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [server, setServer] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (me && !done.current) navigate(next, { replace: true });
  }, [me, next]);

  const errs: Errors = {};
  for (const f of ['handle', 'displayName', 'password'] as Field[]) {
    const e = server[f] ?? (touched[f] ? validate(f, values[f]) : undefined);
    if (e) errs[f] = e;
  }

  const set = (f: Field, v: string) => {
    setValues((s) => ({ ...s, [f]: v }));
    if (server[f]) setServer((s) => ({ ...s, [f]: undefined }));
  };
  const blur = (f: Field) => values[f] && setTouched((t) => ({ ...t, [f]: true }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched({ handle: true, displayName: true, password: true });
    const first = (['handle', 'displayName', 'password'] as Field[]).find((f) => validate(f, values[f]));
    if (first) {
      document.getElementById(`signup-${first}`)?.focus();
      return;
    }
    setBusy(true);
    setServer({});
    try {
      const { user } = await api.post<{ user: Me }>('/auth/signup', {
        handle: values.handle.trim().replace(/^@/, ''),
        displayName: values.displayName.trim(),
        password: values.password,
      });
      done.current = true;
      setMe(user);
      navigate(next, { replace: true });
      toast(
        user.role === 'admin' && PREVIEW
          ? `Welcome to Relay, ${user.displayName}. As the first account here, you’re an admin.`
          : `Welcome to Relay, ${user.displayName}.`,
        { kind: 'success', ms: 5000 },
      );
    } catch (err) {
      if (err instanceof ApiRequestError) {
        const f = err.fields;
        const fieldErr = f.handle || f.displayName || f.password;
        setServer({
          handle: f.handle,
          displayName: f.displayName,
          password: f.password,
          form: err.status === 429 ? 'Too many sign-ups from this network. Try again in a while.' : fieldErr ? undefined : err.message,
        });
        const firstBad = (['handle', 'displayName', 'password'] as Field[]).find((k) => f[k]);
        if (firstBad) document.getElementById(`signup-${firstBad}`)?.focus();
      } else setServer({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const handlePreview = values.handle.trim().replace(/^@/, '');
  const pwLen = values.password.length;

  return (
    <div className="auth">
      <div className="auth-inner">
        <Link to="/" className="auth-brand" aria-label="Relay home">
          <Wordmark size="lg" />
        </Link>
        <h1 className="auth-title">Join Relay</h1>
        <p className="auth-lede">No ads, no ranking, no tracking pixels. Just people writing, in order.</p>

        {PREVIEW && (
          <p className="notice notice-signal auth-notice">
            <strong>Preview build:</strong> your account lives only in this browser. The first account created here becomes an admin, so
            you can try moderation too.
          </p>
        )}

        <form className="auth-form" onSubmit={submit} noValidate>
          {server.form && (
            <p className="notice notice-danger" role="alert">
              {server.form}
            </p>
          )}
          <div className="field">
            <label htmlFor="signup-handle">Handle</label>
            <div className="input-prefixed">
              <span aria-hidden="true">@</span>
              <input
                id="signup-handle"
                className="input"
                value={values.handle}
                onChange={(e) => set('handle', e.target.value)}
                onBlur={() => blur('handle')}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={LIMITS.handle.max + 1}
                aria-invalid={!!errs.handle || undefined}
                aria-describedby="signup-handle-hint"
                autoFocus
              />
            </div>
            <p className={errs.handle ? 'field-error' : 'hint'} id="signup-handle-hint">
              {errs.handle ??
                (handlePreview && !validate('handle', handlePreview)
                  ? `You’ll be @${handlePreview}. Handles can’t be changed later.`
                  : `${LIMITS.handle.min}–${LIMITS.handle.max} letters, numbers or underscores. Handles can’t be changed later.`)}
            </p>
          </div>
          <div className="field">
            <label htmlFor="signup-displayName">Display name</label>
            <input
              id="signup-displayName"
              className="input"
              value={values.displayName}
              onChange={(e) => set('displayName', e.target.value)}
              onBlur={() => blur('displayName')}
              autoComplete="name"
              aria-invalid={!!errs.displayName || undefined}
              aria-describedby="signup-displayName-hint"
            />
            <p className={errs.displayName ? 'field-error' : 'hint'} id="signup-displayName-hint">
              {errs.displayName ?? 'Your name, or whatever you’d like to be called. You can change it any time.'}
            </p>
          </div>
          <div className="field">
            <label htmlFor="signup-password">Password</label>
            <PasswordInput
              id="signup-password"
              value={values.password}
              onChange={(e) => set('password', e.target.value)}
              onBlur={() => blur('password')}
              autoComplete="new-password"
              aria-invalid={!!errs.password || undefined}
              aria-describedby="signup-password-hint"
            />
            <p className={errs.password ? 'field-error' : 'hint'} id="signup-password-hint">
              {errs.password ??
                (pwLen > 0 && pwLen < LIMITS.password.min
                  ? `${LIMITS.password.min - pwLen} more character${LIMITS.password.min - pwLen === 1 ? '' : 's'} to go.`
                  : `At least ${LIMITS.password.min} characters. A short sentence is easy to remember and hard to guess.`)}
            </p>
          </div>
          <p className="auth-agree">
            By joining you agree to the <Link to="/rules">community rules</Link>. They’re short and worth reading.
          </p>
          <button type="submit" className="btn btn-signal btn-block auth-submit" disabled={busy}>
            {busy && <span className="spinner" />}
            Create account
          </button>
        </form>

        <p className="auth-switch">
          Already have an account? <Link to={next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'}>Sign in</Link>
        </p>
      </div>
    </div>
  );
}
