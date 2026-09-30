// Primary navigation model (Phase 7B).
//
// Navigation is DATA: adding a destination is one entry here, once the
// destination's route and page actually exist. There are deliberately no
// placeholder entries -- every item must lead somewhere real (Issue #18:
// "Do not add dead links"). 7C adds Dashboard and classification
// management when those screens ship.
//
// Item shape: { label: string, to: string, end?: boolean }
//   end: match `to` exactly instead of as a prefix. Needed for a
//   destination at "/" (which would otherwise be active on every route).

export const NAV_ITEMS = Object.freeze([
  Object.freeze({ label: 'Products', to: '/products' }),
]);

// The mobile bottom bar only exists when there is something to switch
// between. With a single destination the header's ShopStock link is
// enough, and a one-tab bar would just be chrome.
export const MOBILE_BAR_MIN_ITEMS = 2;
