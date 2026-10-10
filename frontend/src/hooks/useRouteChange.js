import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { routeName, formatDocumentTitle } from '../components/shell/routeTitle.js';
import { useDocumentTitle } from './useDocumentTitle.js';
import { TITLE_PRIORITY } from './documentTitleRegistry.js';

/**
 * Client-side navigation does not reload the page, so nothing tells a
 * screen-reader user that a new "page" appeared. This hook, used by the app
 * shell (a layout route that stays mounted), does three things when the
 * PATHNAME changes (search-string and hash-only changes are ignored):
 *
 *   1. keeps the document title on the current route's title (also on first
 *      load) -- as a ROUTE-priority claim, so an overlay such as the sign-in
 *      screen keeps the title while it is open (see documentTitleRegistry);
 *   2. returns an announcement for a polite live region -- not on first
 *      load, where the browser already announces the page;
 *   3. if keyboard focus was lost because the control that had it left the
 *      page (a saved form, an activated list row), puts focus on <main> so
 *      the user continues from the new page's content instead of the top of
 *      the document. Focus that is still somewhere real -- for example the
 *      primary navigation link the user just activated -- is left alone.
 *
 * @param {{ current: HTMLElement | null }} mainRef the shell's <main>
 * @returns {{ key: number, text: string } | null}
 */
export function useRouteChange(mainRef) {
  const { pathname } = useLocation();
  useDocumentTitle(formatDocumentTitle(routeName(pathname)), { priority: TITLE_PRIORITY.ROUTE });
  const previousPathname = useRef(null);
  const counter = useRef(0);
  const [announcement, setAnnouncement] = useState(null);

  useEffect(() => {
    const name = routeName(pathname);

    if (previousPathname.current !== null && previousPathname.current !== pathname) {
      // A new key per navigation makes the live region announce even when
      // two consecutive routes share a name (product A -> product B).
      counter.current += 1;
      setAnnouncement({ key: counter.current, text: name });

      const active = document.activeElement;
      if (!active || active === document.body) {
        mainRef.current?.focus();
      }
    }
    previousPathname.current = pathname;
  }, [pathname, mainRef]);

  return announcement;
}
