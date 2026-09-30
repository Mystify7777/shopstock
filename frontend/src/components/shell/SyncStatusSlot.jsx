/**
 * Mount point for the sync / offline status indicator. Empty in 7B by
 * design: the indicator itself is 7G. Hidden by CSS while empty.
 */
export default function SyncStatusSlot({ children = null }) {
  return (
    <div className="sync-status-slot" data-shell-slot="sync-status">
      {children}
    </div>
  );
}
