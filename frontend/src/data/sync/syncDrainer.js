// Sync drainer — the FIFO drain loop, with a single-flight concurrent-
// drain guard.
//
// This file owns:
//   - the drain loop itself: claim -> execute -> classify -> act,
//     repeated until the queue is exhausted or a transient/auth failure
//     requires stopping
//   - recovery-once-per-actual-drain: recoverStaleProcessingEntries() is
//     called exactly once at the start of each NEW drain execution, not
//     once per drain() call -- a caller joining an in-flight drain does
//     not trigger a second recovery pass
//   - the single-flight concurrent-drain guard: multiple concurrent
//     drain() calls share exactly one actual drain execution and its
//     one resulting Promise, analogous to authManager.js's own
//     single-flight refresh guard but a distinct, processor-level
//     mechanism -- not a reuse of that one
//   - summarizing what happened as a DrainResult
//
// This file does NOT own:
//   - claiming/deleting/marking queue rows (syncQueueLifecycle.js)
//   - sending the HTTP request or classifying the raw error type
//     (syncEntryExecutor.js)
//   - deciding WHAT the classified outcome means as a policy
//     (syncFailureClassifier.js) -- this module only acts on the
//     decision it's handed
//   - retry/backoff timing, connectivity listeners, background sync, or
//     any UI concern -- explicitly out of scope for Phase 6C

import { SYNC_ACTION, classifySyncOutcome } from './syncFailureClassifier.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   syncQueueLifecycle: ReturnType<import('./syncQueueLifecycle.js').createSyncQueueLifecycle>,
 *   syncEntryExecutor: ReturnType<import('./syncEntryExecutor.js').createSyncEntryExecutor>,
 * }} deps
 * @returns {{ drain: () => Promise<DrainResult> }}
 */
export function createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor }) {
  if (!syncQueueLifecycle || !syncEntryExecutor) {
    throw new TypeError('createSyncDrainer requires { syncQueueLifecycle, syncEntryExecutor }.');
  }

  // Single-flight guard: while a drain is actually running, every
  // concurrent drain() caller receives THIS SAME promise rather than
  // starting a second, independent drain execution.
  let inFlightDrain = null;

  /**
   * Run one actual drain execution: recovery once, then the strict
   * claim -> execute -> classify -> act loop until the queue is
   * exhausted or a transient/auth failure requires stopping.
   *
   * Deliberately NOT wrapped in a try/catch around the whole loop -- an
   * unexpected error from executeSyncEntry() (something outside the
   * four documented SYNC_OUTCOME kinds, per its own rethrow contract)
   * or from classifySyncOutcome() (an unrecognized outcome kind) must
   * propagate out of this function and reject the drain promise, not be
   * reinterpreted as a queue-policy outcome. The entry that was being
   * processed when this happens remains in Dexie as 'processing' --
   * left exactly as-is, not modified further -- and a later drain's own
   * recovery pass will return it to 'pending'.
   *
   * @returns {Promise<DrainResult>}
   */
  async function runDrain() {
    await syncQueueLifecycle.recoverStaleProcessingEntries();

    let processed = 0;
    let failed = 0;
    let stopped = false;
    let reason = null;

    for (;;) {
      const entry = await syncQueueLifecycle.claimNextPending();
      if (!entry) {
        // Queue exhausted -- normal termination, not a stop condition.
        break;
      }

      const outcome = await syncEntryExecutor.executeSyncEntry(entry);
      const decision = classifySyncOutcome(outcome);

      if (decision.action === SYNC_ACTION.DELETE) {
        await syncQueueLifecycle.markSucceeded(entry.localId);
        processed += 1;
        continue;
      }

      if (decision.action === SYNC_ACTION.MARK_FAILED) {
        await syncQueueLifecycle.markFailed(entry.localId, decision.lastError);
        failed += 1;
        continue;
      }

      // SYNC_ACTION.STOP_DRAIN -- the entry stays exactly as claimed
      // ('processing' in Dexie); this drain execution stops here. A
      // later drain will reclaim it as 'pending' via its own recovery
      // pass, then retry it.
      stopped = true;
      reason = decision.reason;
      break;
    }

    return { processed, failed, stopped, reason };
  }

  /**
   * Drain the sync queue. If a drain is already in progress, returns
   * the SAME promise -- this call joins the existing execution rather
   * than starting a second one. The next call after the current drain
   * settles (successfully or by rejecting) starts a genuinely fresh
   * drain execution, including its own recovery pass.
   *
   * @returns {Promise<DrainResult>}
   */
  function drain() {
    if (!inFlightDrain) {
      inFlightDrain = runDrain().finally(() => {
        inFlightDrain = null;
      });
    }
    return inFlightDrain;
  }

  return { drain };
}

/**
 * @typedef {{
 *   processed: number,
 *   failed: number,
 *   stopped: boolean,
 *   reason: string | null,
 * }} DrainResult
 */
