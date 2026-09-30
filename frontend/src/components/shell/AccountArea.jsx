import { useAuthSessionContext } from '../AuthSessionContext.jsx';
import { AUTH_PHASE, AUTH_REASON } from '../../hooks/useAuthSession.js';

/**
 * Account controls in the header. Shows "Sign out" whenever a session
 * exists (signed in, or trusted-but-offline). Renders nothing once the
 * session has ended -- SessionNotice offers "Sign in" in that state, and
 * duplicating the action would give two same-named buttons on screen.
 */
export default function AccountArea() {
  const { phase, reason, logout } = useAuthSessionContext();

  const hasSession =
    phase === AUTH_PHASE.AUTHENTICATED ||
    (phase === AUTH_PHASE.LIMITED && reason === AUTH_REASON.OFFLINE);

  if (!hasSession) return null;

  return (
    <div className="account-area">
      <button type="button" onClick={logout}>
        Sign out
      </button>
    </div>
  );
}
