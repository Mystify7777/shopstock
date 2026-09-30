import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from '../contexts/AppContext.jsx';
import { AUTH_STATUS } from '../auth/authManager.js';
import { AuthApiError, AuthNetworkError } from '../auth/authClient.js';

// Presentation-layer view of authentication (Phase 7B).
//
// This hook OBSERVES authManager and translates its state into the four
// screens the UI needs. It contains no auth mechanics: it never touches
// tokens, sessionStore, authClient or the network itself -- it only calls
// authManager.restoreSession() / logout() / subscribe() / getStatus().
//
// Phases:
//   restoring      startup restoration in progress -> loading screen
//   authenticated  signed in                       -> app shell
//   limited        local data usable, server auth unavailable -> app shell
//                  + a notice. Reasons:
//                    offline        device is trusted (a persisted session
//                                   exists) but the server can't be reached
//                    session-ended  the session was lost during use (the
//                                   backend rejected the refresh)
//   login          no usable session                -> login screen.
//                  Reasons: null (nothing persisted / logged out),
//                    expired (backend rejected the persisted session),
//                    restore-failed (unexpected local failure)
//
// Local Dexie data is never touched by any of these transitions: logout
// and session loss clear credentials only.

export const AUTH_PHASE = Object.freeze({
  RESTORING: 'restoring',
  AUTHENTICATED: 'authenticated',
  LIMITED: 'limited',
  LOGIN: 'login',
});

export const AUTH_REASON = Object.freeze({
  OFFLINE: 'offline',
  SESSION_ENDED: 'session-ended',
  EXPIRED: 'expired',
  RESTORE_FAILED: 'restore-failed',
});

const AUTHENTICATED_STATE = { phase: AUTH_PHASE.AUTHENTICATED, reason: null };

/**
 * @returns {{
 *   phase: string,
 *   reason: string|null,
 *   loginOpen: boolean,
 *   openLogin: () => void,
 *   closeLogin: () => void,
 *   logout: () => Promise<void>,
 * }}
 */
export function useAuthSession() {
  const { authManager } = useAppContext();

  const [state, setState] = useState(() =>
    authManager.getStatus() === AUTH_STATUS.AUTHENTICATED
      ? AUTHENTICATED_STATE
      : { phase: AUTH_PHASE.RESTORING, reason: null }
  );
  // Whether the login screen is shown on top of a `limited` session
  // (the user chose to sign in). Meaningless in other phases.
  const [loginOpen, setLoginOpen] = useState(false);

  // True only while WE are performing an intentional logout, so the
  // resulting UNAUTHENTICATED notification is not mistaken for a
  // mid-use session loss.
  const loggingOutRef = useRef(false);

  useEffect(() => {
    let active = true;

    const unsubscribe = authManager.subscribe((status) => {
      if (!active) return;

      if (status === AUTH_STATUS.AUTHENTICATED) {
        setState(AUTHENTICATED_STATE);
        setLoginOpen(false);
        return;
      }

      // Became unauthenticated.
      if (loggingOutRef.current) return;
      setState((previous) =>
        previous.phase === AUTH_PHASE.AUTHENTICATED || previous.phase === AUTH_PHASE.LIMITED
          ? { phase: AUTH_PHASE.LIMITED, reason: AUTH_REASON.SESSION_ENDED }
          : previous // restoring / login: the restore outcome below decides
      );
    });

    if (authManager.getStatus() !== AUTH_STATUS.AUTHENTICATED) {
      // startup trigger in main.jsx has usually already started a
      // restore; authManager.refresh() is single-flight, so this joins
      // that attempt rather than starting a second one.
      authManager.restoreSession().then(
        () => {
          if (!active) return;
          setState(
            authManager.getStatus() === AUTH_STATUS.AUTHENTICATED
              ? AUTHENTICATED_STATE
              : { phase: AUTH_PHASE.LOGIN, reason: null }
          );
        },
        (error) => {
          if (!active) return;
          if (error instanceof AuthNetworkError) {
            // Offline != logged out: a persisted session exists.
            setState({ phase: AUTH_PHASE.LIMITED, reason: AUTH_REASON.OFFLINE });
          } else if (error instanceof AuthApiError) {
            setState({ phase: AUTH_PHASE.LOGIN, reason: AUTH_REASON.EXPIRED });
          } else {
            console.error('Session restoration failed unexpectedly:', error);
            setState({ phase: AUTH_PHASE.LOGIN, reason: AUTH_REASON.RESTORE_FAILED });
          }
        }
      );
    }

    return () => {
      active = false;
      unsubscribe();
    };
  }, [authManager]);

  const openLogin = useCallback(() => setLoginOpen(true), []);
  const closeLogin = useCallback(() => setLoginOpen(false), []);

  const logout = useCallback(async () => {
    loggingOutRef.current = true;
    try {
      await authManager.logout();
    } finally {
      loggingOutRef.current = false;
    }
    setLoginOpen(false);
    setState({ phase: AUTH_PHASE.LOGIN, reason: null });
  }, [authManager]);

  return { phase: state.phase, reason: state.reason, loginOpen, openLogin, closeLogin, logout };
}
