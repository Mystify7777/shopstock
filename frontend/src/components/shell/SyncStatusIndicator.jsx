import { useSyncStatus, SYNC_STATE } from '../../hooks/useSyncStatus.js';

function changes(count) {
  return count === 1 ? '1 change' : `${count} changes`;
}

/**
 * The sync / connectivity indicator (Phase 7G), rendered inside the shell's
 * SyncStatusSlot. Read-only: it reports the truth of the existing queue and
 * offers no action. Nothing is shown when the browser is online and nothing
 * is waiting or rejected.
 *
 * The state is always written in words (a label plus a sentence); colour is
 * only reinforcement. Raw sync and observation errors are never shown.
 * "Sync status unavailable" means the queue could not be read: its state is
 * unknown, which is different from nothing waiting.
 */
export default function SyncStatusIndicator() {
  const { state, pendingCount, failedCount } = useSyncStatus();

  if (state === SYNC_STATE.IDLE) return null;

  let label;
  let detail;
  if (state === SYNC_STATE.OFFLINE) {
    label = 'Offline';
    detail = 'You appear to be offline. Changes are saved on this device and will sync later.';
  } else if (state === SYNC_STATE.UNAVAILABLE) {
    label = 'Sync status unavailable';
    detail = 'Changes are still saved on this device.';
  } else if (state === SYNC_STATE.ATTENTION) {
    label = 'Needs attention';
    detail = `${changes(failedCount)} couldn\u2019t be synced.`;
  } else {
    label = 'Pending';
    detail = `${changes(pendingCount)} waiting to sync.`;
  }

  return (
    <div className={`sync-status sync-status--${state}`}>
      <p>
        <strong>{label}</strong> {detail}
      </p>
    </div>
  );
}
