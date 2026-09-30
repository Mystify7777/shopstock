import { Link, Outlet } from 'react-router-dom';
import PrimaryNav from './PrimaryNav.jsx';
import AccountArea from './AccountArea.jsx';
import SessionNotice from './SessionNotice.jsx';
import NotificationRegion from './NotificationRegion.jsx';
import SyncStatusSlot from './SyncStatusSlot.jsx';
import { NAV_ITEMS, MOBILE_BAR_MIN_ITEMS } from './navItems.js';

/**
 * The application frame (Phase 7B): header (identity, primary
 * navigation, account), session notice, the notification and sync mount
 * points, and the <main> content region where every routed page renders.
 *
 * Used as a react-router layout route: pages render through <Outlet />.
 * The shell owns page width and gutters; pages own their own <h1> and
 * body (page-level migration is 7D-7F).
 *
 * @param {{ navItems?: Array<{label: string, to: string, end?: boolean}> }} props
 */
export default function AppShell({ navItems = NAV_ITEMS }) {
  const hasBottomBar = navItems.length >= MOBILE_BAR_MIN_ITEMS;

  return (
    <div className="app-shell" data-has-bottom-bar={hasBottomBar ? 'true' : 'false'}>
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
      <SyncStatusSlot />
      <main className="app-shell__main">
        <Outlet />
      </main>
    </div>
  );
}
