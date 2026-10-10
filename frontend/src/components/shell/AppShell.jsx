import { useRef } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useRouteChange } from '../../hooks/useRouteChange.js';
import PrimaryNav from './PrimaryNav.jsx';
import AccountArea from './AccountArea.jsx';
import SessionNotice from './SessionNotice.jsx';
import NotificationRegion from './NotificationRegion.jsx';
import SyncStatusSlot from './SyncStatusSlot.jsx';
import SyncStatusIndicator from './SyncStatusIndicator.jsx';
import { NAV_ITEMS, MOBILE_BAR_MIN_ITEMS } from './navItems.js';

/**
 * The application frame (Phase 7B): header (identity, primary
 * navigation, account), session notice, the notification and sync mount
 * points, and the <main> content region where every routed page renders.
 *
 * Used as a react-router layout route: pages render through <Outlet />.
 *
 * Navigation semantics (Phase 7H): a skip link to <main>, a polite live
 * region that announces each route change, document titles, and focus
 * rescue -- see useRouteChange. <main> is a programmatic focus target
 * (tabIndex -1) and is not in the tab order.
 * The shell owns page width and gutters; pages own their own <h1> and
 * body (page-level migration is 7D-7F).
 *
 * @param {{ navItems?: Array<{label: string, to: string, end?: boolean}> }} props
 */
export default function AppShell({ navItems = NAV_ITEMS }) {
  const hasBottomBar = navItems.length >= MOBILE_BAR_MIN_ITEMS;
  const mainRef = useRef(null);
  const announcement = useRouteChange(mainRef);

  // Move focus to <main> directly instead of following the #hash: it works
  // the same under any router and does not add a history entry.
  function handleSkip(event) {
    event.preventDefault();
    mainRef.current?.focus();
  }

  return (
    <div className="app-shell" data-has-bottom-bar={hasBottomBar ? 'true' : 'false'}>
      <a href="#main-content" className="skip-link" onClick={handleSkip}>
        Skip to main content
      </a>
      <header className="app-shell__header">
        <div className="app-shell__header-inner">
          <Link to="/" className="app-shell__brand">
            ShopStock
          </Link>
          <PrimaryNav items={navItems} />
          <AccountArea />
        </div>
      </header>
      <SessionNotice />
      <NotificationRegion />
      <SyncStatusSlot>
        <SyncStatusIndicator />
      </SyncStatusSlot>
      <div
        className="visually-hidden"
        data-shell-slot="route-announcer"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement && <span key={announcement.key}>{announcement.text}</span>}
      </div>
      <main id="main-content" tabIndex={-1} ref={mainRef} className="app-shell__main">
        <Outlet />
      </main>
    </div>
  );
}
