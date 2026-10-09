import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Me } from '../../shared/types';
import { LIMITS } from '../../shared/limits';
import { PasswordInput, safeNext } from '../components/PasswordInput';
import { Wordmark } from '../components/Shell';
import { ApiRequestError, PREVIEW, api, errorMessage } from '../lib/api';
import { Link, navigate, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';

export default function Login(_props: { params: Record<string, string> }) {
  const { me, setMe } = useSession();
  const { query } = useLocation();
  const next = safeNext(query.get('next'));
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ handle?: string; password?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const handleRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (me && !done.current) navigate(next, { replace: true });
  }, [me, next]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const h = handle.trim().replace(/^@/, '');
    const errs: typeof errors = {};
    if (!h) errs.handle = 'Enter your handle.';
    if (!password) errs.password = 'Enter your password.';
    else if (password.length > LIMITS.password.max) errs.password = 'That password is too long.';
    setErrors(errs);
    if (errs.handle || errs.password) {
      (errs.handle ? handleRef.current : document.getElementById('login-password'))?.focus();
      return;
    }
    setBusy(true);
    try {
      const { user } = await api.post<{ user: Me }>('/auth/login', { handle: h, password });
      done.current = true;
      setMe(user);
      navigate(next, { replace: true });
      toast(`Welcome back, ${user.displayName}.`);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.status === 429) setErrors({ form: 'Too many attempts. Wait a few minutes, then try again.' });
        else setErrors({ handle: err.fields.handle, password: err.fields.password, form: err.message });
      } else setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-inner">
        <Link to="/" className="auth-brand" aria-label="Relay home">
          <Wordmark size="lg" />
        </Link>
        <h1 className="auth-title">Sign in</h1>
        <p className="auth-lede">Welcome back. Your feed is where you left it — newest first.</p>

        {PREVIEW && (
          <p className="notice notice-signal auth-notice">
            <strong>Preview build:</strong> every demo account (it says so in the bio) uses the password <code>relay-preview-demo</code>.
            Or <Link to="/signup">create your own</Link> — it stays in this browser.
          </p>
        )}

        <form className="auth-form" onSubmit={submit} noValidate>
          {errors.form && (
            <p className="notice notice-danger" role="alert">
              {errors.form}
            </p>
          )}
          <div className="field">
            <label htmlFor="login-handle">Handle</label>
            <div className="input-prefixed">
              <span aria-hidden="true">@</span>
              <input
                ref={handleRef}
                id="login-handle"
                className="input"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                aria-invalid={!!errors.handle || undefined}
                aria-describedby={errors.handle ? 'login-handle-err' : undefined}
                autoFocus
              />
            </div>
            {errors.handle && (
              <p className="field-error" id="login-handle-err">
                {errors.handle}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <PasswordInput
              id="login-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              aria-invalid={!!errors.password || undefined}
              aria-describedby={errors.password ? 'login-password-err' : undefined}
            />
            {errors.password && (
              <p className="field-error" id="login-password-err">
                {errors.password}
              </p>
            )}
          </div>
          <button type="submit" className="btn btn-primary btn-block auth-submit" disabled={busy}>
            {busy && <span className="spinner" />}
            Sign in
          </button>
        </form>

        <p className="auth-switch">
          New to Relay? <Link to={next !== '/' ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}>Create an account</Link>
        </p>
      </div>
    </div>
  );
}
