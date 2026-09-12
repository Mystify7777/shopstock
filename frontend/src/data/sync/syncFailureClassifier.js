// Sync failure classification — pure decision logic, no execution.
//
// This file owns:
//   - mapping a syncEntryExecutor.js SYNC_OUTCOME to the lifecycle
//     action the locked Phase 6C-0 contract specifies (see
//     docs/PROGRESS.md's Phase 6C-0 entry and docs/ARCHITECTURE.md's
//     "Sync model" section for the authoritative table this implements)
//   - formatting a bounded, sanitized lastError STRING (per the locked
//     contract: string, not a structured object) for the one outcome
//     that needs one -- a permanently-rejected ApiRequestError
//
// This file does NOT own:
//   - executing the decision -- it never calls db.syncQueue, never
//     calls syncQueueLifecycle.js's markSucceeded()/markFailed(), and
//     never increments `attempts` itself (the locked table does not
//     specify an attempts-tracking requirement for THIS phase; a caller
//     that wants to track attempts can do so using the returned
//     decision, but this module's job is classification, not counting)
//   - the drain loop, FIFO ordering, or the concurrent-drain guard
//     (6C-4)
//   - deciding when to retry a transient failure or how long to wait --
//     "stop the current drain" is the full extent of this phase's
//     policy; timing/backoff is explicitly out of scope for Phase 6C

import { SYNC_OUTCOME } from './syncEntryExecutor.js';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const SYNC_ACTION = Object.freeze({
  DELETE: 'delete',           // success -- caller should call markSucceeded()
  MARK_FAILED: 'markFailed',  // permanent rejection -- caller should call markFailed(localId, lastError)
  STOP_DRAIN: 'stopDrain',    // transient failure -- entry stays pending; caller should stop this drain pass
});

const TRANSIENT_HTTP_STATUSES = new Set([408, 429]);

function isTransientHttpStatus(status) {
  return TRANSIENT_HTTP_STATUSES.has(status) || (status >= 500 && status < 600);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a syncEntryExecutor.js outcome into the lifecycle action the
 * locked Phase 6C-0 contract specifies. Pure function -- no side
 * effects, no db access; throws only for an unrecognized outcome kind
 * (a programming error, not a normal outcome), rather than silently
 * defaulting to a guessed action.
 *
 * @param {{ kind: string, response?: object, error?: Error }} outcome
 *   The exact shape returned by syncEntryExecutor.js's executeSyncEntry().
 * @returns {
 *   { action: 'delete' } |
 *   { action: 'markFailed', lastError: string } |
 *   { action: 'stopDrain', reason: string }
 * }
 */
export function classifySyncOutcome(outcome) {
  switch (outcome.kind) {
    case SYNC_OUTCOME.SUCCESS:
      return { action: SYNC_ACTION.DELETE };

    case SYNC_OUTCOME.API_NETWORK_ERROR:
      return { action: SYNC_ACTION.STOP_DRAIN, reason: 'apiNetworkError' };

    case SYNC_OUTCOME.AUTH_NETWORK_ERROR:
      return { action: SYNC_ACTION.STOP_DRAIN, reason: 'authNetworkError' };

    case SYNC_OUTCOME.AUTH_ERROR:
      // Refresh itself failed because the refresh token was rejected --
      // the session is genuinely dead (authManager has already cleared
      // it by the time this propagates, per apiClient.js's contract).
      // The queue entry is not at fault; stop and wait for re-auth.
      return { action: SYNC_ACTION.STOP_DRAIN, reason: 'authError' };

    case SYNC_OUTCOME.API_ERROR: {
      const { status } = outcome.error;
      if (isTransientHttpStatus(status)) {
        return { action: SYNC_ACTION.STOP_DRAIN, reason: 'transientApiError' };
      }
      return {
        action: SYNC_ACTION.MARK_FAILED,
        lastError: formatLastError(outcome.error),
      };
    }

    default:
      // An outcome kind outside the five documented possibilities is a
      // genuine bug in the caller or in syncEntryExecutor.js itself --
      // fail loudly rather than silently picking an action.
      throw new TypeError(`classifySyncOutcome: unrecognized outcome kind "${outcome.kind}".`);
  }
}

/**
 * Format a bounded, sanitized lastError string from an ApiRequestError.
 * Per the locked contract, lastError is a plain string (matching the
 * existing documented schema type), not a structured object.
 *
 * Deliberately excludes anything that could leak sensitive data into
 * local storage: no stack traces, no request/response bodies, no
 * headers, no tokens. Only the backend's own error code, message, and
 * HTTP status -- all of which the backend already intends to be
 * user/caller-visible (they're returned directly in the API response).
 *
 * @param {import('../../auth/apiClient.js').ApiRequestError} error
 * @returns {string}
 */
function formatLastError(error) {
  return `${error.code}: ${error.message} (${error.status})`;
}
