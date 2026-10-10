// Single owner of document.title (Phase 7H).
//
// document.title is one global. Several parts of the app want to set it (the
// app shell for the current route, the sign-in overlay while it is open), and
// letting each write it directly makes the outcome depend on effect timing:
// an overlay that "restores the previous title" can restore a stale one if
// the route changed underneath it.
//
// So nobody writes document.title except this module. Components make
// CLAIMS; the visible title is always the claim with the highest PRIORITY
// (ties: the most recent claim). A claim can change its title while it is
// held, and releasing a claim exposes whatever is now on top -- the CURRENT
// title of the claim underneath, not a snapshot taken when this one opened.
// When the last claim is released the title goes back to what it was before
// the first claim.

export const TITLE_PRIORITY = Object.freeze({
  /** The current route, owned by the app shell. */
  ROUTE: 0,
  /** A screen shown on top of the app (the sign-in overlay). */
  OVERLAY: 1
});

const claims = [];
let originalTitle = null;

function apply() {
  if (claims.length === 0) {
    if (originalTitle !== null) {
      document.title = originalTitle;
      originalTitle = null;
    }
    return;
  }
  // Highest priority wins; among equals the latest claim (later in the array).
  let top = claims[0];
  for (const claim of claims) {
    if (claim.priority >= top.priority) top = claim;
  }
  document.title = top.title;
}

/**
 * @param {string} title
 * @param {number} priority one of TITLE_PRIORITY
 * @returns {{ update: (title: string) => void, release: () => void }}
 */
export function claimTitle(title, priority) {
  if (claims.length === 0) originalTitle = document.title;
  const claim = { title, priority };
  claims.push(claim);
  apply();

  return {
    update(nextTitle) {
      claim.title = nextTitle;
      apply();
    },
    release() {
      const index = claims.indexOf(claim);
      if (index === -1) return;
      claims.splice(index, 1);
      apply();
    }
  };
}
