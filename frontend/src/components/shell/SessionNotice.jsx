import { useAuthSessionContext } from '../AuthSessionContext.jsx';
import { AUTH_PHASE, AUTH_REASON } from '../../hooks/useAuthSession.js';

/**
 * Explains, in plain words, why the server is not fully available while
 * making clear the local data still is. Rendered only in the `limited`
 * auth phase. This is auth-status messaging, distinct from the general
 * sync/offline indicators that 7G will mount in SyncStatusSlot.
 */
export default function SessionNotice() {
  const { phase, reason, openLogin } = useAuthSessionContext();

  if (phase !== AUTH_PHASE.LIMITED) return null;

  if (reason === AUTH_REASON.OFFLINE) {
    return (
      <div className="session-notice session-notice--offline" role="status">
        <p>
          Can&rsquo;t reach the server. You&rsquo;re working with the data saved on this device, and
          your changes will sync when you&rsquo;re back online.
        </p>
      </div>
    );
  }

  return (
    <div className="session-notice session-notice--warning" role="status">
      <p>
        You&rsquo;re signed out of the server. Your data on this device is safe and you can keep
        working, but syncing needs you to sign in again.
      </p>
      <button type="button" onClick={openLogin}>
        Sign in
      </button>
    </div>
  );
}
