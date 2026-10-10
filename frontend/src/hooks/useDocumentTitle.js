import { useEffect, useRef } from 'react';
import { claimTitle, TITLE_PRIORITY } from './documentTitleRegistry.js';

/**
 * Show `title` as the document title while the calling component is
 * mounted. Never writes document.title itself: it holds a claim in the
 * title registry, so the visible title is always the highest-priority claim
 * that is currently held (see documentTitleRegistry.js).
 *
 * Defaults to OVERLAY priority, for a screen shown on top of the app.
 *
 * @param {string} title
 * @param {{ priority?: number }} [options]
 */
export function useDocumentTitle(title, { priority = TITLE_PRIORITY.OVERLAY } = {}) {
  const claimRef = useRef(null);

  useEffect(() => {
    const claim = claimTitle(title, priority);
    claimRef.current = claim;
    return () => {
      claim.release();
      claimRef.current = null;
    };
    // `title` is applied by the effect below; re-claiming on every title
    // change would reorder claims of equal priority.
  }, [priority]);

  useEffect(() => {
    claimRef.current?.update(title);
  }, [title]);
}
