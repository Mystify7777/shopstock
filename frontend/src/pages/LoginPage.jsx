import { useState } from 'react';
import { useAppContext } from '../contexts/AppContext.jsx';
import { AuthApiError, AuthNetworkError } from '../auth/authClient.js';
import { AUTH_REASON } from '../hooks/useAuthSession.js';

// Presentation only (Phase 7B). All credential handling stays in
// authManager.login(); this page collects two fields, calls it, and turns
// its failures into plain-language messages. On success authManager's
// status notification moves AuthGate on to the app -- this page does not
// navigate.

const REASON_NOTICES = {
  [AUTH_REASON.EXPIRED]: 'Your session expired. Sign in again.',
  [AUTH_REASON.RESTORE_FAILED]: "We couldn't restore your session. Sign in to continue.",
};

function describeLoginFailure(error) {
  if (error instanceof AuthNetworkError) {
    return "Can't reach the server. Check your connection and try again.";
  }
  if (error instanceof AuthApiError) {
    if (error.code === 'RATE_LIMITED') {
      return 'Too many attempts. Wait a moment, then try again.';
    }
    if (error.code === 'UNAUTHORIZED' || error.code === 'VALIDATION_ERROR') {
      return 'Incorrect username or password.';
    }
    return "The server couldn't sign you in. Try again in a moment.";
  }
  console.error('Unexpected login failure:', error);
  return 'Something went wrong signing in. Try again.';
}

/**
 * @param {{
 *   reason?: string|null,   why the login screen is showing (AUTH_REASON)
 *   onCancel?: () => void,  when provided, the user can go back to the app
 *                           (local data is usable; only server sync needs login)
 * }} props
 */
export default function LoginPage({ reason = null, onCancel }) {
  const { authManager, syncDrainer } = useAppContext();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    if (username.trim() === '' || password === '') {
      setError('Enter your username and password.');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await authManager.login(username.trim(), password);
    } catch (err) {
      setError(describeLoginFailure(err));
      setSubmitting(false);
      return;
    }
    // Success: drain anything queued while signed out -- the seam
    // documented in main.jsx (Phase 6D-4). Fire-and-forget, same as the
    // other sync triggers. AuthGate switches to the app on its own.
    void syncDrainer.drain();
  }

  const notice = REASON_NOTICES[reason] ?? null;

  return (
    <div className="login">
      <div className="login__card">
        <h1>Sign in to ShopStock</h1>

        {notice && <p role="status">{notice}</p>}
        {onCancel && (
          <p>Sign in to resume syncing. The data on this device stays exactly as it is.</p>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="login__field">
            <label htmlFor="login-username">Username</label>
            <input
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={error && username.trim() === '' ? 'true' : undefined}
            />
          </div>
          <div className="login__field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error && password === '' ? 'true' : undefined}
            />
          </div>

          {error && (
            <p role="alert" className="login__error">
              {error}
            </p>
          )}

          <div className="login__actions">
            <button type="submit" className="login__submit" disabled={submitting}>
              {submitting ? 'Signing in\u2026' : 'Sign in'}
            </button>
            {onCancel && (
              <button type="button" onClick={onCancel} disabled={submitting}>
                Continue without signing in
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
