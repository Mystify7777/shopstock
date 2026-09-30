/**
 * Mount point for global notifications (toasts, banners). Empty in 7B by
 * design: the notification system is 7G. It is a polite live region so
 * anything mounted here is announced without stealing focus.
 */
export default function NotificationRegion({ children = null }) {
  return (
    <div className="notification-region" data-shell-slot="notifications" aria-live="polite">
      {children}
    </div>
  );
}
