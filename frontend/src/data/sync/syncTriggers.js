// Sync triggers — application-level events that call syncDrainer.drain().
//
// This file owns:
//   - the authenticated-startup trigger (6D-2): after session
//     restoration, drain ONLY if that restoration actually establishes
//     an authenticated session -- restoreSession() resolving without
//     throwing does NOT by itself mean authenticated (it resolves
//     normally when there was simply no persisted refresh token to
//     restore from, per authManager.js's own contract)
//   - the connectivity-restoration trigger (6D-3): a single 'online'
//     listener that calls drain() directly, unconditionally
//
// This file does NOT own:
//   - queue internals, API serialization, or failure classification --
//     it only ever calls syncDrainer.drain(), never touches
//     syncQueueLifecycle/syncEntryExecutor/syncFailureClassifier
//     directly
//   - auth token mechanics -- it only ever calls
//     authManager.restoreSession()/getStatus(), never touches
//     sessionStore/authClient or token values directly
//   - reinterpreting sync outcomes -- success, permanent failure,
//     transient failure, and auth failure are already fully handled
//     inside syncDrainer/syncFailureClassifier (Phase 6C); this module
//     never inspects a DrainResult's contents to make a further
//     decision
//   - retry/backoff, timers, polling, or an auth-readiness state
//     machine -- the existing single-flight guard in syncDrainer and
//     the existing 401-recovery path in apiClient already make it safe
//     for multiple trigger sources to call drain() independently and
//     concurrently, confirmed during Phase 6D-0's investigation
//
// Deferred, explicitly not implemented here (Phase 6D-0/6D corrections):
// a successful INTERACTIVE LOGIN should also trigger a drain, using the
// exact same call:
//
//     authManager.login(username, password)
//       -> success
//       -> syncDrainer.drain()
//
// This is not wired anywhere yet because no login UI/call site exists
// in the application (confirmed by source inspection -- authManager.login()
// is currently only ever called from tests). When a real login flow is
// built, its success path should call syncDrainer.drain() directly,
// exactly as this module's startup trigger does after a successful
// restoration -- no new sync-triggering mechanism should be invented for
// it.

import { AUTH_STATUS } from '../../auth/authManager.js';

/**
 * Attempt to restore a persisted session on application startup, and
 * drain the sync queue ONLY if that restoration actually establishes an
 * authenticated session.
 *
 * Three distinct outcomes from authManager.restoreSession(), handled
 * deliberately differently:
 *
 *   1. Resolves, status becomes AUTHENTICATED (a valid persisted
 *      refresh token existed and was successfully exchanged) -> drain.
 *   2. Resolves, status remains UNAUTHENTICATED (no persisted refresh
 *      token existed -- a normal, non-error outcome for a fresh/
 *      anonymous session) -> do NOT drain, nothing to sync against.
 *   3. Throws AuthApiError (a persisted refresh token existed but was
 *      rejected -- expired/revoked; authManager has already cleared
 *      local session state) -> do NOT drain, nothing authenticated to
 *      sync against.
 *   4. Throws AuthNetworkError (a persisted refresh token existed but
 *      the restore attempt couldn't reach the backend -- authManager
 *      deliberately leaves local session state untouched in this case,
 *      per the locked offline-!=-logged-out contract) -> do NOT drain
 *      now, but this is NOT a logout -- a later connectivity-restoration
 *      trigger will get another chance once the network returns.
 *
 * Never throws -- a failed restoration attempt (of either kind) is a
 * normal startup outcome, not a caller-facing error.
 *
 * @param {{
 *   authManager: ReturnType<import('../../auth/authManager.js').createAuthManager>,
 *   syncDrainer: ReturnType<import('./syncDrainer.js').createSyncDrainer>,
 * }} deps
 */
export async function triggerStartupSync({ authManager, syncDrainer }) {
  try {
    await authManager.restoreSession();
  } catch {
    // AuthApiError or AuthNetworkError -- either way, restoration did
    // not establish an authenticated session right now. Nothing further
    // to do here; a later trigger (connectivity restoration, or a
    // future login) gets its own chance.
    return;
  }

  if (authManager.getStatus() === AUTH_STATUS.AUTHENTICATED) {
    await syncDrainer.drain();
  }
}

/**
 * Register a single 'online' listener that calls syncDrainer.drain()
 * directly, unconditionally, with no auth-readiness gating.
 *
 * Why no gating is needed (confirmed during Phase 6D-0's investigation,
 * traced through actual source rather than assumed): if drain() is
 * called while unauthenticated, apiClient.request() sends with no
 * Authorization header, the backend returns 401, and the EXISTING
 * 401-recovery path in apiClient.js already attempts a refresh using
 * whatever persisted refresh token exists -- succeeding (session
 * established, drain continues) or failing cleanly as AUTH_ERROR/
 * AUTH_NETWORK_ERROR, which syncFailureClassifier.js already maps to
 * stopDrain. No new coordination is required; building an auth-readiness
 * check here would duplicate a decision the existing layers already
 * make correctly.
 *
 * Multiple concurrent trigger sources (this listener firing while the
 * startup trigger's own drain is still in flight, for example) are
 * already safe: syncDrainer's own single-flight guard (Phase 6C-4)
 * ensures every concurrent drain() call shares one actual execution.
 *
 * @param {{
 *   syncDrainer: ReturnType<import('./syncDrainer.js').createSyncDrainer>,
 * }} deps
 * @returns {() => void} An unsubscribe function, for callers that need
 *   to tear the listener down (e.g. tests).
 */
export function registerConnectivitySyncTrigger({ syncDrainer }) {
  function handleOnline() {
    // drain() itself never throws for any of the outcomes it already
    // owns (success, permanent failure, transient/auth failure -- all
    // resolve normally with a DrainResult). A rejection here would only
    // ever be a genuine unexpected programming error (per syncDrainer.js's
    // own contract, Phase 6C-4) -- this module does not reinterpret that,
    // it simply does not swallow it silently either. There is currently
    // no application-level error-reporting mechanism to route it to; if
    // one is added later, this is the seam it would plug into.
    void syncDrainer.drain();
  }

  window.addEventListener('online', handleOnline);
  return () => window.removeEventListener('online', handleOnline);
}
