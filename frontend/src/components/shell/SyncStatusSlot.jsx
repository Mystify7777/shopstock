/**
 * Mount point for the sync / offline status indicator (Phase 7G fills it:
 * see SyncStatusIndicator). A persistent polite live region, so a change in
 * its content is announced without stealing focus. Hidden by CSS while
 * empty.
 */
export default function SyncStatusSlot({ children = null }) {
  return (
    <div className="sync-status-slot" data-shell-slot="sync-status" aria-live="polite">
      {children}
    </div>
  );
}
