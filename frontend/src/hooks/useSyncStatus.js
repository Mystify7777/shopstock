import { useEffect, useState } from 'react';
import { useAppContext } from '../contexts/AppContext.jsx';

// Presentation-layer view of sync / connectivity (Phase 7G).
//
// OBSERVES only. It reads queue counts through the syncStatus service
// (never Dexie, never the queue schema) and the browser's online/offline
// events. It never drains, retries or changes anything.
//
// "offline" is the BROWSER's connectivity flag (navigator.onLine). It is a
// hint, not proof the backend is unreachable, and the wording says so.

export const SYNC_STATE = Object.freeze({
  OFFLINE: 'offline',
  UNAVAILABLE: 'unavailable',
  ATTENTION: 'attention',
  PENDING: 'pending',
  IDLE: 'idle'
});

/**
 * One deterministic display state. Precedence, highest first:
 *   offline > unavailable > attention (failed > 0)
 *           > pending (pending + processing > 0) > idle
 *
 * `observationFailed` means reading the queue failed, so its state is
 * UNKNOWN. Unknown is not idle, and it must not be shown as stale counts
 * either, so it outranks attention / pending / idle. Offline stays on top:
 * it comes from the browser, not from the queue, and is still known.
 * When observation is healthy the order is exactly offline > attention >
 * pending > idle.
 *
 * @param {{
 *   online: boolean,
 *   pendingCount: number,
 *   failedCount: number,
 *   observationFailed?: boolean,
 * }} input
 * @returns {'offline'|'unavailable'|'attention'|'pending'|'idle'}
 */
export function deriveSyncState({ online, pendingCount, failedCount, observationFailed = false }) {
  if (!online) return SYNC_STATE.OFFLINE;
  if (observationFailed) return SYNC_STATE.UNAVAILABLE;
  if (failedCount > 0) return SYNC_STATE.ATTENTION;
  if (pendingCount > 0) return SYNC_STATE.PENDING;
  return SYNC_STATE.IDLE;
}

function readOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Counts are null while the queue state is unknown (observation failed):
 * unknown is never reported as zero.
 *
 * @returns {{
 *   state: 'offline'|'unavailable'|'attention'|'pending'|'idle',
 *   online: boolean,
 *   pendingCount: number|null,
 *   failedCount: number|null,
 * }}
 */
export function useSyncStatus() {
  const { syncStatus } = useAppContext();
  const [online, setOnline] = useState(readOnline);
  // null until the first successful reading. Before it arrives there is
  // nothing to report yet (not an error).
  const [counts, setCounts] = useState(null);
  // True after an observation error. Set only by an error and cleared only
  // by a real later reading -- never by time or by assumption. (Dexie's
  // liveQuery keeps its subscription after an error and emits again on the
  // next queue change; if it ever did not, this would simply stay true,
  // which is the honest state.)
  const [observationFailed, setObservationFailed] = useState(false);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    return syncStatus.observeSyncStatus(
      (next) => {
        setCounts(next);
        setObservationFailed(false);
      },
      (error) => {
        // Logged, never rendered. Last counts are dropped: after a failed
        // read they can no longer be vouched for.
        console.error('Reading the sync status failed.', error);
        setCounts(null);
        setObservationFailed(true);
      }
    );
  }, [syncStatus]);

  const pendingCount = counts?.pendingCount ?? 0;
  const failedCount = counts?.failedCount ?? 0;

  return {
    state: deriveSyncState({ online, pendingCount, failedCount, observationFailed }),
    online,
    pendingCount: observationFailed ? null : pendingCount,
    failedCount: observationFailed ? null : failedCount
  };
}
