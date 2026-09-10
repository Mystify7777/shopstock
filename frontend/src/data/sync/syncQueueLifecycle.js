// Sync queue lifecycle — pure Dexie state transitions on syncQueue rows.
//
// This file owns:
//   - claiming the next pending entry for processing (atomic
//     read-then-mark, so two concurrent callers can never both claim the
//     same row)
//   - marking a claimed entry as successfully transmitted (delete)
//   - marking a claimed entry as permanently failed (status: 'failed' +
//     lastError, retained)
//   - crash recovery: resetting stale 'processing' rows back to
//     'pending' on startup, so a browser/tab crash mid-request doesn't
//     strand an entry forever in a state nothing will ever pick up again
//
// This file does NOT own:
//   - any HTTP request (that's apiClient.js / a later 6C chunk that
//     calls it)
//   - deciding WHETHER a given failure is transient or permanent (that
//     classification is the caller's job — this module just records
//     whatever outcome it's told)
//   - FIFO drain looping, or a concurrent-drain guard (later 6C chunks)
//   - retry/backoff timing, connectivity listeners, or any UI concern
//
// Status vocabulary (locked, Phase 6C-0 — see docs/ARCHITECTURE.md's
// "Sync model" section for the full contract this implements):
//   'pending'     eligible for processing
//   'processing'  currently claimed by a processor; persisted so a crash
//                 mid-request leaves a durable, recoverable trace
//   'failed'      permanently rejected, retained with lastError, excluded
//                 from automatic processing until a future explicit
//                 recovery mechanism (not implemented in this phase)
//   (no 'done' or 'syncing' state -- successful entries are deleted
//   outright; see recoverStaleProcessingEntries() for why 'processing'
//   must be resumable rather than a second transient state.)

/**
 * @param {import('dexie').Dexie} db A database instance from createDatabase().
 * @returns {{
 *   claimNextPending: () => Promise<object|null>,
 *   markSucceeded: (localId: number) => Promise<void>,
 *   markFailed: (localId: number, lastError: string) => Promise<void>,
 *   recoverStaleProcessingEntries: () => Promise<number>,
 * }}
 */
export function createSyncQueueLifecycle(db) {
  /**
   * Atomically claim the oldest 'pending' entry: read it, and if one
   * exists, mark it 'processing' in the SAME transaction before
   * returning it. Two concurrent calls (e.g. from two drain loops that
   * shouldn't exist per the locked single-drain-guard contract, but this
   * function must still be correct in isolation) can never both claim
   * the same row -- Dexie serializes 'rw' transactions against the same
   * table, so the second caller's read inside its own transaction will
   * see the first caller's 'processing' write once that transaction
   * commits, not the stale 'pending' value.
   *
   * "Oldest" is by ascending localId (Dexie's auto-increment primary
   * key), which is the FIFO ordering locked for Phase 6C -- see
   * docs/ARCHITECTURE.md.
   *
   * @returns {Promise<object|null>} The claimed entry (now with
   *   status: 'processing' in the database, though the returned object
   *   reflects that too), or null if no pending entry exists.
   */
  async function claimNextPending() {
    return db.transaction('rw', db.syncQueue, async () => {
      const entry = await db.syncQueue
        .where('status')
        .equals('pending')
        .first();

      if (!entry) {
        return null;
      }

      await db.syncQueue.update(entry.localId, { status: 'processing' });
      return { ...entry, status: 'processing' };
    });
  }

  /**
   * Mark a claimed entry as successfully transmitted. Per the locked
   * contract, success deletes the row outright -- there is no 'done'
   * terminal state to transition into. Safe to call on an already-absent
   * localId (no-op) since a crash between a successful send and this
   * call, followed by crash-recovery + a harmless resend, could
   * legitimately race with a delayed duplicate call in edge cases; this
   * function does not need to distinguish "deleted just now" from
   * "already gone."
   *
   * @param {number} localId
   */
  async function markSucceeded(localId) {
    await db.syncQueue.delete(localId);
  }

  /**
   * Mark a claimed entry as permanently failed. The row is retained
   * (never deleted) with status: 'failed' and lastError populated, so
   * the rejected mutation is visible for later diagnosis rather than
   * silently lost. This function does not decide WHETHER a failure is
   * permanent -- the caller has already made that classification (see
   * the locked failure-classification table in docs/PROGRESS.md's
   * Phase 6C-0 entry) before calling this.
   *
   * lastError is a bounded string per the locked contract (not a
   * structured object -- matches the existing documented
   * `lastError: string | null` type, avoiding schema churn). Callers are
   * responsible for constructing a useful, bounded message; this
   * function does not truncate, sanitize, or validate it beyond
   * requiring it to be a non-empty string.
   *
   * @param {number} localId
   * @param {string} lastError
   */
  async function markFailed(localId, lastError) {
    if (typeof lastError !== 'string' || lastError.length === 0) {
      throw new TypeError('markFailed() requires a non-empty string lastError.');
    }
    await db.syncQueue.update(localId, { status: 'failed', lastError });
  }

  /**
   * Crash recovery: reset every entry still marked 'processing' back to
   * 'pending'. Intended to be called once, at processor startup, before
   * normal FIFO processing resumes -- a 'processing' row found at
   * startup can only mean a previous run claimed it and then never
   * reached markSucceeded()/markFailed() (the tab/browser closed or
   * crashed mid-request), since nothing else ever leaves a row in that
   * state between runs.
   *
   * Resetting to 'pending' rather than immediately retrying here is
   * deliberate: recovery is a pure state-repair step, not itself a send
   * attempt -- the actual retry happens through the normal drain that
   * follows, keeping this function simple and side-effect-free beyond
   * the one Dexie write.
   *
   * @returns {Promise<number>} The number of entries reset.
   */
  async function recoverStaleProcessingEntries() {
    const staleEntries = await db.syncQueue
      .where('status')
      .equals('processing')
      .toArray();

    if (staleEntries.length === 0) {
      return 0;
    }

    await db.transaction('rw', db.syncQueue, async () => {
      for (const entry of staleEntries) {
        await db.syncQueue.update(entry.localId, { status: 'pending' });
      }
    });

    return staleEntries.length;
  }

  return {
    claimNextPending,
    markSucceeded,
    markFailed,
    recoverStaleProcessingEntries,
  };
}
