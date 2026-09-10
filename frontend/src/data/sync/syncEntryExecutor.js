// Sync entry executor — one claimed queue entry, one HTTP attempt.
//
// This file owns:
//   - translating an already-claimed syncQueue entry into a backend
//     request (via createSyncRequest) and sending it (via
//     apiClient.request())
//   - normalizing the outcome into a typed result the caller can branch
//     on WITHOUT needing its own try/catch around four different error
//     classes -- this module does that catching once, here, and returns
//     a discriminated object instead
//
// This file does NOT own:
//   - claiming an entry, deleting it on success, or marking it failed
//     (those are syncQueueLifecycle.js's job -- this module is given an
//     already-claimed entry and returns an outcome; it never touches
//     db.syncQueue itself)
//   - deciding WHICH outcomes are retryable vs. permanent (that
//     classification/policy is a later 6C chunk -- this module only
//     identifies WHICH of the four possible failure shapes occurred,
//     it does not decide what should happen as a result)
//   - looping over multiple entries, FIFO ordering, or a concurrent-drain
//     guard (later 6C chunks)
//   - retry/backoff timing
//
// The seam this module is built on, confirmed working end-to-end during
// Phase 6B2-f:
//
//   entry -> createSyncRequest(entry) -> { method, path, body }
//         -> apiClient.request({ method, path, body })
//         -> resolves (success) or throws one of four typed errors

import { createSyncRequest } from './syncRequest.js';
import { ApiRequestError, ApiNetworkError } from '../../auth/apiClient.js';
import { AuthApiError, AuthNetworkError } from '../../auth/authClient.js';

// ---------------------------------------------------------------------------
// Outcome kinds
// ---------------------------------------------------------------------------

export const SYNC_OUTCOME = Object.freeze({
  SUCCESS: 'success',
  API_ERROR: 'apiError',           // ApiRequestError -- backend rejected the request
  API_NETWORK_ERROR: 'apiNetworkError',   // ApiNetworkError -- transport failure on the request itself
  AUTH_ERROR: 'authError',         // AuthApiError -- the 401-triggered refresh failed (invalid/expired refresh token)
  AUTH_NETWORK_ERROR: 'authNetworkError', // AuthNetworkError -- the 401-triggered refresh failed (network)
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {{ apiClient: ReturnType<import('../../auth/apiClient.js').createApiClient> }} deps
 * @returns {{
 *   executeSyncEntry: (entry: object) => Promise<SyncOutcome>,
 * }}
 */
export function createSyncEntryExecutor({ apiClient }) {
  if (!apiClient) {
    throw new TypeError('createSyncEntryExecutor requires { apiClient }.');
  }

  /**
   * Attempt to send one already-claimed queue entry exactly once. Never
   * throws -- every possible failure is caught and returned as a typed
   * outcome instead, so callers can branch on `outcome.kind` without
   * wrapping every call in their own try/catch across four unrelated
   * error classes.
   *
   * Does NOT mutate the queue entry or call any syncQueueLifecycle
   * function -- the caller (a later 6C chunk) is responsible for acting
   * on the returned outcome (delete on SUCCESS, retain+record on a
   * permanent API_ERROR, leave pending and stop on the three transient
   * kinds -- that policy decision is explicitly not this module's job).
   *
   * @param {object} entry A claimed syncQueue row (at minimum
   *   { entityType, entityId, payload } -- the shape createSyncRequest()
   *   itself requires; other queue-transport fields like localId/status
   *   may be present but are not read here).
   * @returns {Promise<
   *   { kind: 'success', response: object } |
   *   { kind: 'apiError', error: ApiRequestError } |
   *   { kind: 'apiNetworkError', error: ApiNetworkError } |
   *   { kind: 'authError', error: AuthApiError } |
   *   { kind: 'authNetworkError', error: AuthNetworkError }
   * >}
   */
  async function executeSyncEntry(entry) {
    const request = createSyncRequest(entry);

    try {
      const response = await apiClient.request(request);
      return { kind: SYNC_OUTCOME.SUCCESS, response };
    } catch (error) {
      return { kind: classify(error), error };
    }
  }

  return { executeSyncEntry };
}

/**
 * Map a thrown error to its outcome kind. Deliberately a plain
 * instanceof chain, not a lookup table keyed by `.name` -- these four
 * classes are imported directly, so instanceof is both more precise
 * (survives minification/renaming, unlike string name comparison) and
 * fails loudly (via the final else) if an unrecognized error type ever
 * reaches here, rather than silently misclassifying it.
 *
 * @param {Error} error
 * @returns {string} one of SYNC_OUTCOME's values (excluding SUCCESS)
 */
function classify(error) {
  if (error instanceof ApiRequestError) return SYNC_OUTCOME.API_ERROR;
  if (error instanceof ApiNetworkError) return SYNC_OUTCOME.API_NETWORK_ERROR;
  if (error instanceof AuthApiError) return SYNC_OUTCOME.AUTH_ERROR;
  if (error instanceof AuthNetworkError) return SYNC_OUTCOME.AUTH_NETWORK_ERROR;
  // An error type outside the four documented possibilities reaching
  // this module would be a genuine bug elsewhere in the chain (e.g. a
  // new error class introduced in apiClient.js/authClient.js without
  // updating this classifier) -- rethrow rather than silently bucket it
  // into an existing kind, so the bug surfaces instead of being masked.
  throw error;
}
