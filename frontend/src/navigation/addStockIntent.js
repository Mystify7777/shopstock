// Navigation intent: "arrive on this product's page with Add Stock open".
//
// Carried as React Router location STATE, not in the URL. It is a one-shot,
// contextual action ("add stock for this row"), not a bookmarkable workflow, so
// it deliberately leaves no query string or hash behind. The product page reads
// it once, then clears it with a replace-navigation (see ProductDetailPage).
//
// Kept in one place because two pages share this contract: the dashboard sets
// it and the product page consumes it.

export const ADD_STOCK_INTENT = Object.freeze({ openAddStock: true });

/** True only for the exact intent this module defines. */
export function hasAddStockIntent(locationState) {
  return locationState !== null && typeof locationState === 'object' && locationState.openAddStock === true;
}
