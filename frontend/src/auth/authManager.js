// Auth manager — the single runtime authority for authentication state.
//
// This file owns:
//   - the in-memory access token (never persisted anywhere -- per the
//     locked 6B2 contract, the access token must not touch IndexedDB,
//     localStorage, or any other durable store)
//   - authenticated/unauthenticated runtime status
//   - login (calls authClient, then atomically installs both returned
//     credentials)
//   - startup session restoration (reads the persisted refresh token via
//     sessionStore, validates its shape -- sessionStore intentionally
//     does NOT do this validation, see sessionStore.js's own header --
//     then refreshes it)
//   - single-flight refresh coordination: at most one refresh request in
//     flight at a time, with every concurrent caller sharing its result
//   - logout (best-effort server call, unconditional local clear)
//
// This file does NOT own:
//   - any generic HTTP request construction beyond the four auth calls
//     it delegates to authClient.js (no fetch() calls live here directly)
//   - Dexie access (delegates entirely to sessionStore.js)
//   - deciding when to attempt a request, retrying a non-auth request, or
//     attaching the access token to arbitrary API calls -- that's
//     apiClient.js, which will be built ON TOP of this module in a later
//     chunk, not merged into it
//   - network connectivity listeners, sync queue processing, or any
//     sync-engine behavior

// ---------------------------------------------------------------------------
// Status constants
// ---------------------------------------------------------------------------

export const AUTH_STATUS = Object.freeze({
  UNAUTHENTICATED: 'unauthenticated',
  AUTHENTICATED: 'authenticated',
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate the shape of a value read back from sessionStore.getRefreshToken().
 * sessionStore itself deliberately does NOT perform this validation (see
 * its own header comment) -- it persists/returns whatever was written.
 * This manager is the layer responsible for deciding whether a persisted
 * value is actually usable as a refresh token before attempting to use it.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isValidRefreshTokenShape(value) {
  return typeof value === 'string' && value.length > 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   sessionStore: ReturnType<import('./sessionStore.js').createSessionStore>,
 *   authClient: ReturnType<import('./authClient.js').createAuthClient>,
 * }} deps
 */
export function createAuthManager({ sessionStore, authClient }) {
  if (!sessionStore || !authClient) {
    throw new TypeError('createAuthManager requires { sessionStore, authClient }.');
  }

  // In-memory only -- never written to sessionStore or anywhere durable.
  let accessToken = null;
  let status = AUTH_STATUS.UNAUTHENTICATED;

  // Single-flight refresh coordination: while a refresh is in progress,
  // every caller (this module's own restoreSession()/future retry logic,
  // and later apiClient.js) awaits the SAME promise rather than each
  // independently calling authClient.refresh() with the same
  // about-to-be-consumed refresh token.
  let inFlightRefresh = null;

  function getStatus() {
    return status;
  }

  function getAccessToken() {
    return accessToken;
  }

  /**
   * Atomically install a fresh credential pair as the current session.
   * "Atomic" here means: persistence of the new refresh token is
   * awaited and confirmed BEFORE the in-memory access token/status are
   * updated. If persistence fails, this function does not partially
   * apply the transition -- see the doc comment on each caller for the
   * specific failure behavior required at that call site.
   */
  async function installCredentials({ accessToken: newAccessToken, refreshToken: newRefreshToken }) {
    await sessionStore.setRefreshToken(newRefreshToken);
    accessToken = newAccessToken;
    status = AUTH_STATUS.AUTHENTICATED;
  }

  /**
   * Fully clear local session state -- in-memory access token, runtime
   * status, and the persisted refresh token. Used on logout and on any
   * failure path that must not leave a stale/invalid session installed.
   */
  async function clearLocalSession() {
    accessToken = null;
    status = AUTH_STATUS.UNAUTHENTICATED;
    await sessionStore.clearRefreshToken();
  }

  // ---------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------

  /**
   * Log in with credentials. On success, replaces any existing session
   * (login is always allowed to supersede a currently-authenticated
   * session -- e.g. switching accounts is not this app's concern in V1,
   * but a second successful login legitimately replaces the first).
   *
   * On FAILURE, the existing session (if any) is left completely
   * untouched -- a failed login attempt must never destroy a working
   * session. This is why credentials are validated by authClient.login()
   * (which throws before this function does anything else) prior to any
   * local state mutation.
   *
   * @param {string} username
   * @param {string} password
   * @throws {import('./authClient.js').AuthApiError} on invalid
   *   credentials or a validation failure -- existing session untouched.
   * @throws {import('./authClient.js').AuthNetworkError} on a transport
   *   failure -- existing session untouched.
   */
  async function login(username, password) {
    const { accessToken: newAccessToken, refreshToken: newRefreshToken } =
      await authClient.login(username, password);
    // Only reached on success -- a thrown error above leaves the
    // existing accessToken/status/persisted refresh token exactly as
    // they were.
    await installCredentials({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  }

  // ---------------------------------------------------------------------
  // Refresh (single-flight)
  // ---------------------------------------------------------------------

  /**
   * Perform the actual refresh call and install the result. This is the
   * function wrapped by the single-flight guard below -- never call this
   * directly from outside refresh().
   */
  async function performRefresh() {
    const persistedToken = await sessionStore.getRefreshToken();
    if (!isValidRefreshTokenShape(persistedToken)) {
      // No usable refresh token to attempt with -- clear whatever
      // malformed/absent state exists and report unauthenticated. This
      // is not an error condition for the caller to catch; it's the
      // normal "nothing to restore" case.
      await clearLocalSession();
      return null;
    }

    let result;
    try {
      result = await authClient.refresh(persistedToken);
    } catch (err) {
      // Distinguish network failure (offline right now -- must NOT be
      // treated as "session invalid") from an actual backend rejection
      // (expired/revoked token -- IS a real auth failure).
      if (err.name === 'AuthNetworkError') {
        // Do not clear the local session merely because the network is
        // unavailable -- per the locked contract, offline != logged out.
        throw err;
      }
      // AuthApiError (e.g. UNAUTHORIZED on an expired/revoked refresh
      // token) -- this genuinely is an authentication failure. Clear
      // local session state and surface the error to the caller.
      await clearLocalSession();
      throw err;
    }

    // installCredentials() awaits persistence of the NEW refresh token
    // before updating in-memory state. If that persistence write itself
    // throws, this function must not report success -- the promise
    // rejects and the caller (below) sees a refresh failure, not a
    // silently-incomplete rotation. We deliberately do NOT clear the
    // local session in this specific failure path: the old refresh
    // token has already been consumed server-side (rotation happened),
    // so clearing local state would be correct too, but the more
    // important invariant is simply: never claim success while
    // IndexedDB still points at a now-dead token. Callers that see this
    // rejection should treat it as a failed refresh.
    await installCredentials(result);
    return result.accessToken;
  }

  /**
   * Refresh the current session. Single-flight: if a refresh is already
   * in progress, this call joins it rather than starting a second one --
   * the backend guarantees concurrent refreshes with the same old token
   * cannot both succeed, so a second independent attempt would be
   * redundant at best and would race against the first at worst.
   *
   * @returns {Promise<string|null>} The new access token, or null if
   *   there was no persisted refresh token to restore from (a normal,
   *   non-error outcome).
   * @throws {import('./authClient.js').AuthApiError} if the persisted
   *   refresh token was rejected by the backend (expired/revoked) --
   *   local session is cleared before this throws.
   * @throws {import('./authClient.js').AuthNetworkError} if the refresh
   *   request could not reach the backend -- local session is NOT
   *   cleared; the caller should treat this as "try again later," not
   *   "log out."
   */
  function refresh() {
    if (!inFlightRefresh) {
      inFlightRefresh = performRefresh().finally(() => {
        inFlightRefresh = null;
      });
    }
    return inFlightRefresh;
  }

  // ---------------------------------------------------------------------
  // Startup session restoration
  // ---------------------------------------------------------------------

  /**
   * Attempt to restore an authenticated session from the persisted
   * refresh token, on application startup. This is a thin wrapper around
   * refresh() -- restoration IS a refresh, there is no separate
   * mechanism. Does not throw for the normal "nothing to restore" case;
   * DOES propagate AuthApiError/AuthNetworkError for genuine failures,
   * matching refresh()'s own contract, so callers can distinguish "no
   * session existed" from "a real error occurred while restoring one."
   *
   * Deliberately does not touch domain data or the sync queue -- pure
   * authentication bootstrapping only.
   */
  async function restoreSession() {
    await refresh();
  }

  // ---------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------

  /**
   * Log out. Attempts a best-effort server-side logout (only if a
   * refresh token is currently persisted -- matches the locked contract:
   * "if a refresh token exists, attempt POST /api/auth/logout"), but
   * ALWAYS clears local session state regardless of whether that server
   * call succeeds, fails, or the network is unavailable. A failed
   * logout request must never leave the user locally authenticated.
   *
   * Never throws -- logout is not retried, and a network/server failure
   * during the best-effort server call is swallowed after the local
   * state has already been cleared, since there is nothing further for
   * the caller to meaningfully do about it (matches "the frontend must
   * not retry logout indefinitely").
   */
  async function logout() {
    const persistedToken = await sessionStore.getRefreshToken();
    if (isValidRefreshTokenShape(persistedToken)) {
      try {
        await authClient.logout(persistedToken);
      } catch {
        // Best-effort only -- per the locked contract, a failed logout
        // request must not leave the user locally authenticated, and
        // logout must not be retried. Local clear below runs regardless.
      }
    }
    await clearLocalSession();
  }

  return {
    getStatus,
    getAccessToken,
    login,
    restoreSession,
    refresh,
    logout,
  };
}
