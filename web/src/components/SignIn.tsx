import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';

/**
 * The sign-in prompt, raised when something was refused.
 *
 * A prompt rather than a gate across the whole app: browsing, the map and the
 * calendar stay open, and the password is only ever asked for at the moment
 * somebody tries to change something. Anything that hits a 401 sets
 * `authPrompt` in the store, so every action in the app raises this same box
 * without knowing anything about authentication.
 */
export default function SignIn() {
  const { authPrompt, dismissAuthPrompt, signIn } = useStore();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (authPrompt) {
      setPassword('');
      setError('');
      field.current?.focus();
    }
  }, [authPrompt]);

  useEffect(() => {
    if (!authPrompt) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismissAuthPrompt();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [authPrompt, dismissAuthPrompt]);

  if (!authPrompt) return null;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signIn(password);
    } catch (err) {
      setError((err as Error).message);
      field.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="topbar__scrim" onClick={dismissAuthPrompt} aria-hidden="true" />
      <div className="signin" role="dialog" aria-modal="true" aria-label="Sign in">
        <h2 style={{ margin: '0 0 4px' }}>Sign in</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          {authPrompt} Browsing stays open either way.
        </p>
        <form onSubmit={(e) => void submit(e)}>
          <input
            ref={field}
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%' }}
          />
          {error && (
            <p className="hint" style={{ color: 'var(--red)', marginBottom: 0 }}>
              {error}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="primary" type="submit" disabled={busy || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button type="button" onClick={dismissAuthPrompt}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
