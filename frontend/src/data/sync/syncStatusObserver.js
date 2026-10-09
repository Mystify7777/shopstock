// Sync status observer -- READ-ONLY view of the sync queue (Phase 7G).
//
// This file owns:
//   - counting what is waiting to sync and what was permanently rejected,
//     so the UI can say so truthfully
//   - a live subscription to those counts (Dexie liveQuery; no polling,
//     no new dependency)
//
// This file does NOT own, and never changes:
//   - queue rows, statuses, retries, ordering or draining -- it only reads
//   - the syncQueue schema as seen by the UI: callers get two numbers and
//     never a row, a status string or a lastError
//
// Semantics (locked, Phase 7G):
//   pendingCount  rows 'pending' PLUS 'processing'. A transient failure
//                 leaves the claimed row 'processing' until the next
//                 drain's recovery pass resets it, so counting only
//                 'pending' would under-report work that still has to sync.
//   failedCount   rows 'failed' (permanently rejected, retained).

import { liveQuery } from 'dexie';

/**
 * @param {import('dexie').Dexie} db A database instance from createDatabase().
 * @returns {{
 *   getSyncStatus: () => Promise<{ pendingCount: number, failedCount: number }>,
 *   observeSyncStatus: (
 *     onChange: (status: { pendingCount: number, failedCount: number }) => void,
 *     onError?: (error: Error) => void
 *   ) => () => void,
 * }}
 */
export function createSyncStatusObserver(db) {
  if (!db) {
    throw new TypeError('createSyncStatusObserver requires a database.');
  }

  async function getSyncStatus() {
    const [pendingCount, failedCount] = await Promise.all([
      db.syncQueue.where('status').anyOf('pending', 'processing').count(),
      db.syncQueue.where('status').equals('failed').count()
    ]);
    return { pendingCount, failedCount };
  }

  /**
   * Call `onChange` with the current status, then again whenever the queue
   * changes. Returns an unsubscribe function.
   */
  function observeSyncStatus(onChange, onError) {
    const subscription = liveQuery(getSyncStatus).subscribe({
      next: onChange,
      error: (error) => {
        if (onError) onError(error);
      }
    });
    return () => subscription.unsubscribe();
  }

  return { getSyncStatus, observeSyncStatus };
}
