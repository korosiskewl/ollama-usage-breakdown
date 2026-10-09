import { useState, type InputHTMLAttributes } from 'react';

/** Password input with a show/hide toggle. Pass id, value, onChange, autoComplete and aria props as usual. */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password">
      <input {...props} type={shown ? 'text' : 'password'} className={'input ' + (props.className ?? '')} spellCheck={false} autoCapitalize="none" />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setShown((s) => !s)}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-controls={props.id}
      >
        {shown ? 'hide' : 'show'}
      </button>
    </div>
  );
}

/** Only allow in-app paths as post-auth redirects. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.startsWith('/login') || raw.startsWith('/signup')) return '/';
  return raw;
}
